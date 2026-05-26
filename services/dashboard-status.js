const createDashboardStatusHelpers = ({
    getDb,
    getDefaultConfig,
    getIsShuttingDown,
    getExchange,
    getExchangeHealth,
    getExchangeRecoveryReason,
    getMetrics,
    getAccountPositionMode,
    getActivePositionsMap,
    getActivePositionEntries,
    toFiniteNumber,
    defaultConfig,
    dashboardEditableFields,
    getExchangeClientOrderId,
    getPrice,
    fetchOpenExchangePositions,
    fetchManagedOpenOrdersSnapshot,
    calculatePositionPnL,
    buildDailyPnlSnapshot,
    syncDailyPnlWithExchange,
    getTotalUSDTBalance,
    getAvailableUSDTBalance
}) => {
    const resolveSpotPairOptions = () => {
        const exchange = getExchange();
        const markets = exchange?.markets;
        if (!markets || typeof markets !== "object") return [];

        const spotSymbols = Object.values(markets)
            .filter((market) => market && market.active !== false && market.spot === true)
            .map((market) => String(market.symbol || "").trim())
            .filter((symbol) => symbol.includes("/"))
            .sort((a, b) => a.localeCompare(b));

        return Array.from(new Set(spotSymbols));
    };

    const buildDashboardSchema = (config) => {
        const pairOptions = resolveSpotPairOptions();
        return dashboardEditableFields.map((field) => {
            if (field?.key !== "pair") return field;

            const currentPair = String(config?.pair || defaultConfig?.pair || "").trim();
            const options = pairOptions.length > 0
                ? (pairOptions.includes(currentPair) ? pairOptions : [currentPair, ...pairOptions].filter(Boolean))
                : [currentPair || defaultConfig?.pair || "DOGE/USDT"];

            return {
                ...field,
                type: "select",
                options
            };
        });
    };

    const getAccumulatedRealizedPnl = (snapshot) => (
        toFiniteNumber(snapshot?.dailyPnL, 0) + toFiniteNumber(snapshot?.estimatedPnL, 0)
    );

    const buildDashboardStatus = () => {
        const db = getDb();
        const exchangeHealth = getExchangeHealth();
        const activePositionsMap = getActivePositionsMap(db?.activePosition);
        const recovery = getMetrics?.()?.orderRecovery || {};
        const orderRecovery = {
            duplicateDetected: Math.max(0, Math.trunc(toFiniteNumber(recovery.duplicateDetected, 0))),
            duplicateResolved: Math.max(0, Math.trunc(toFiniteNumber(recovery.duplicateResolved, 0))),
            timeoutErrors: Math.max(0, Math.trunc(toFiniteNumber(recovery.timeoutErrors, 0))),
            replacementAttempts: Math.max(0, Math.trunc(toFiniteNumber(recovery.replacementAttempts, 0))),
            replacementSucceeded: Math.max(0, Math.trunc(toFiniteNumber(recovery.replacementSucceeded, 0)))
        };
        const accumulatedRealizedPnL = getAccumulatedRealizedPnl(db);
        return {
            botRunning: !getIsShuttingDown(),
            exchangeConnected: Boolean(getExchange()),
            exchangeHealthy: exchangeHealth.isHealthy,
            needsRecoverySync: exchangeHealth.needsRecoverySync,
            exchangeRecoveryReason: getExchangeRecoveryReason() || null,
            positionMode: "SPOT",
            activePositions: Object.keys(activePositionsMap).length,
            activeGridState: Boolean(db?.activeGridState),
            dailyPnL: toFiniteNumber(db?.dailyPnL, 0),
            dailyTrades: Math.max(0, Math.trunc(toFiniteNumber(db?.dailyTrades, 0))),
            estimatedPnL: toFiniteNumber(db?.estimatedPnL, 0),
            estimatedTrades: Math.max(0, Math.trunc(toFiniteNumber(db?.estimatedTrades, 0))),
            accumulatedRealizedPnL,
            dailyPnlSource: String(db?.dailyPnlSource || "local").toLowerCase(),
            dailyPnlSyncedAt: toFiniteNumber(db?.dailyPnlSyncedAt, 0),
            lastUpdated: toFiniteNumber(db?.lastUpdated, 0),
            lastDailyReset: toFiniteNumber(db?.lastDailyReset, 0),
            pair: db?.pair || defaultConfig.pair,
            pendingPair: db?.pendingPair || null,
            strategy: db?.strategy || defaultConfig.strategy,
            marginMode: db?.marginMode || defaultConfig.marginMode,
            orderRecovery
        };
    };

    const mapManagedOrder = (order) => ({
        id: order.id ?? null,
        clientOrderId: getExchangeClientOrderId(order) || null,
        side: order.side ?? order.info?.side ?? null,
        positionSide: "SPOT",
        type: order.type ?? order.info?.type ?? null,
        reduceOnly: false,
        price: Number.isFinite(Number(order.price ?? order.info?.price)) ? Number(order.price ?? order.info?.price) : null,
        triggerPrice: Number.isFinite(Number(order.triggerPrice ?? order.stopPrice ?? order.info?.triggerPrice ?? order.info?.stopPrice))
            ? Number(order.triggerPrice ?? order.stopPrice ?? order.info?.triggerPrice ?? order.info?.stopPrice)
            : null,
        amount: Number.isFinite(Number(order.amount ?? order.info?.amount ?? order.info?.origQty))
            ? Number(order.amount ?? order.info?.amount ?? order.info?.origQty)
            : null
    });

    const buildLiveStatusPayload = async () => {
        const db = getDb();
        if (!db) {
            return {
                ok: false,
                error: "Config is not ready yet"
            };
        }

        let dailyPnlSnapshot = typeof buildDailyPnlSnapshot === "function"
            ? buildDailyPnlSnapshot(db)
            : {
                dailyPnL: toFiniteNumber(db.dailyPnL, 0),
                dailyTrades: Math.max(0, Math.trunc(toFiniteNumber(db.dailyTrades, 0))),
                dailyPnlSource: String(db.dailyPnlSource || "local").toLowerCase(),
                dailyPnlSyncedAt: toFiniteNumber(db.dailyPnlSyncedAt, 0)
            };

        if (typeof syncDailyPnlWithExchange === "function") {
            try {
                dailyPnlSnapshot = await syncDailyPnlWithExchange();
            } catch (error) {
                console.warn(`[STATUS][WARN] Failed to refresh daily PnL snapshot: ${error.message}`);
            }
        }

        let currentPrice = NaN;
        let totalUSDTBalance = NaN;
        let availableUSDTBalance = NaN;
        let exchangePositions = [];
        let managedOrders = { grid: [], tp: [], sl: [] };

        if (getExchange()) {
            try {
                currentPrice = await getPrice();
            } catch {
                currentPrice = NaN;
            }

            try {
                totalUSDTBalance = typeof getTotalUSDTBalance === "function" ? await getTotalUSDTBalance() : NaN;
            } catch {
                totalUSDTBalance = NaN;
            }

            try {
                availableUSDTBalance = typeof getAvailableUSDTBalance === "function" ? await getAvailableUSDTBalance() : NaN;
            } catch {
                availableUSDTBalance = NaN;
            }

            try {
                exchangePositions = await fetchOpenExchangePositions();
            } catch (error) {
                console.warn(`[STATUS][WARN] Failed to fetch exchange positions: ${error.message}`);
            }

            try {
                managedOrders = await fetchManagedOpenOrdersSnapshot();
            } catch (error) {
                console.warn(`[STATUS][WARN] Failed to fetch managed open orders: ${error.message}`);
            }
        }

        const activePositions = getActivePositionEntries().map(([positionKey, position]) => {
            const pnlState = Number.isFinite(currentPrice) ? calculatePositionPnL(position, currentPrice) : null;
            return {
                key: positionKey,
                side: position.side || null,
                quantity: toFiniteNumber(position.quantity, 0),
                entryPrice: toFiniteNumber(position.entryPrice, 0),
                targetPrice: Number.isFinite(position.targetPrice) ? position.targetPrice : null,
                stopLossPrice: Number.isFinite(position.stopLossPrice) ? position.stopLossPrice : null,
                pnlUSDT: pnlState ? toFiniteNumber(pnlState.displayProfitUSDT ?? pnlState.netProfitUSDT, 0) : null,
                pnlPercent: pnlState ? toFiniteNumber(pnlState.displayProfitPercent ?? pnlState.profitPercent, 0) : null,
                currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
                strategy: position.strategy || null
            };
        });

        // Calculate total unrealized PnL from all active positions
        const unrealizedPnL = activePositions.reduce((sum, pos) => {
            return sum + (Number.isFinite(pos.pnlUSDT) ? pos.pnlUSDT : 0);
        }, 0);

        const openOrders = {
            grid: managedOrders.grid.map(mapManagedOrder),
            tp: managedOrders.tp.map(mapManagedOrder),
            sl: managedOrders.sl.map(mapManagedOrder)
        };

        const accumulatedRealizedPnL = getAccumulatedRealizedPnl(dailyPnlSnapshot);
        return {
            ok: true,
            serverTime: Date.now(),
            pair: db.pair,
            currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
            balance: {
                totalUSDT: Number.isFinite(totalUSDTBalance) ? totalUSDTBalance : null,
                availableUSDT: Number.isFinite(availableUSDTBalance) ? availableUSDTBalance : null
            },
            botRunning: !getIsShuttingDown(),
            exchangeConnected: Boolean(getExchange()),
            exchangeHealthy: Boolean(getExchangeHealth()?.isHealthy),
            needsRecoverySync: Boolean(getExchangeHealth()?.needsRecoverySync),
            exchangeRecoveryReason: getExchangeRecoveryReason() || null,
            positionMode: "SPOT",
            dailyPnL: toFiniteNumber(dailyPnlSnapshot.dailyPnL, 0),
            dailyTrades: Math.max(0, Math.trunc(toFiniteNumber(dailyPnlSnapshot.dailyTrades, 0))),
            estimatedPnL: toFiniteNumber(dailyPnlSnapshot.estimatedPnL, 0),
            estimatedTrades: Math.max(0, Math.trunc(toFiniteNumber(dailyPnlSnapshot.estimatedTrades, 0))),
            dailyPnlSource: String(dailyPnlSnapshot.dailyPnlSource || "local").toLowerCase(),
            dailyPnlSyncedAt: toFiniteNumber(dailyPnlSnapshot.dailyPnlSyncedAt, 0),
            accumulatedRealizedPnL,
            unrealizedPnL,
            totalPnL: accumulatedRealizedPnL + unrealizedPnL,
            pendingPair: db.pendingPair || null,
            activePositions,
            exchangePositionsCount: exchangePositions.length,
            openOrders,
            orderCounts: {
                grid: openOrders.grid.length,
                tp: openOrders.tp.length,
                sl: openOrders.sl.length,
                total: openOrders.grid.length + openOrders.tp.length + openOrders.sl.length
            },
            orderRecovery: (() => {
                const recovery = getMetrics?.()?.orderRecovery || {};
                return {
                    duplicateDetected: Math.max(0, Math.trunc(toFiniteNumber(recovery.duplicateDetected, 0))),
                    duplicateResolved: Math.max(0, Math.trunc(toFiniteNumber(recovery.duplicateResolved, 0))),
                    timeoutErrors: Math.max(0, Math.trunc(toFiniteNumber(recovery.timeoutErrors, 0))),
                    replacementAttempts: Math.max(0, Math.trunc(toFiniteNumber(recovery.replacementAttempts, 0))),
                    replacementSucceeded: Math.max(0, Math.trunc(toFiniteNumber(recovery.replacementSucceeded, 0)))
                };
            })(),
            triggerOrdersFetchFailed: Boolean(managedOrders.triggerOrdersFetchFailed)
        };
    };

    const buildDashboardPayload = () => {
        const db = getDb();
        const config = db ? { ...db } : getDefaultConfig();
        return {
            config,
            defaults: getDefaultConfig(),
            schema: buildDashboardSchema(config),
            status: buildDashboardStatus(),
            serverTime: Date.now()
        };
    };

    return {
        buildDashboardStatus,
        buildLiveStatusPayload,
        buildDashboardPayload
    };
};

module.exports = { createDashboardStatusHelpers };
