const createDashboardStatusHelpers = ({
    getDb,
    getDefaultConfig,
    getIsShuttingDown,
    getExchange,
    getExchangeHealth,
    getExchangeRecoveryReason,
    getAccountPositionMode,
    getActivePositionsMap,
    getActivePositionEntries,
    toFiniteNumber,
    defaultConfig,
    dashboardEditableFields,
    getExchangeClientOrderId,
    getPrice,
    buildAutoGridPreview,
    fetchOpenExchangePositions,
    fetchManagedOpenOrdersSnapshot,
    calculatePositionPnL,
    buildDailyPnlSnapshot,
    syncDailyPnlWithExchange
}) => {
    const buildDashboardStatus = () => {
        const db = getDb();
        const exchangeHealth = getExchangeHealth();
        const activePositionsMap = getActivePositionsMap(db?.activePosition);
        return {
            botRunning: !getIsShuttingDown(),
            exchangeConnected: Boolean(getExchange()),
            exchangeHealthy: exchangeHealth.isHealthy,
            needsRecoverySync: exchangeHealth.needsRecoverySync,
            exchangeRecoveryReason: getExchangeRecoveryReason() || null,
            positionMode: getAccountPositionMode()?.label || "UNKNOWN",
            activePositions: Object.keys(activePositionsMap).length,
            activeGridState: Boolean(db?.activeGridState),
            dailyPnL: toFiniteNumber(db?.dailyPnL, 0),
            dailyTrades: Math.max(0, Math.trunc(toFiniteNumber(db?.dailyTrades, 0))),
            dailyPnlSource: String(db?.dailyPnlSource || "local").toLowerCase(),
            dailyPnlSyncedAt: toFiniteNumber(db?.dailyPnlSyncedAt, 0),
            lastUpdated: toFiniteNumber(db?.lastUpdated, 0),
            lastDailyReset: toFiniteNumber(db?.lastDailyReset, 0),
            pair: db?.pair || defaultConfig.pair,
            strategy: db?.strategy || defaultConfig.strategy,
            marginMode: db?.marginMode || defaultConfig.marginMode,
            leverage: Math.max(1, Math.trunc(toFiniteNumber(db?.leverage, defaultConfig.leverage)))
        };
    };

    const mapManagedOrder = (order) => ({
        id: order.id ?? null,
        clientOrderId: getExchangeClientOrderId(order) || null,
        side: order.side ?? order.info?.side ?? null,
        positionSide: order.positionSide ?? order.info?.positionSide ?? null,
        type: order.type ?? order.info?.type ?? null,
        reduceOnly: Boolean(order.reduceOnly ?? order.info?.reduceOnly),
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
        let exchangePositions = [];
        let managedOrders = { grid: [], tp: [], sl: [] };
        let autoGrid = null;

        try {
            currentPrice = await getPrice();
        } catch {
            currentPrice = NaN;
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

        if (typeof buildAutoGridPreview === "function") {
            try {
                autoGrid = await buildAutoGridPreview();
            } catch (error) {
                console.warn(`[STATUS][WARN] Failed to build adaptive grid preview: ${error.message}`);
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

        const openOrders = {
            grid: managedOrders.grid.map(mapManagedOrder),
            tp: managedOrders.tp.map(mapManagedOrder),
            sl: managedOrders.sl.map(mapManagedOrder)
        };

        return {
            ok: true,
            serverTime: Date.now(),
            pair: db.pair,
            currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
            botRunning: !getIsShuttingDown(),
            exchangeConnected: Boolean(getExchange()),
            exchangeHealthy: Boolean(getExchangeHealth()?.isHealthy),
            needsRecoverySync: Boolean(getExchangeHealth()?.needsRecoverySync),
            exchangeRecoveryReason: getExchangeRecoveryReason() || null,
            positionMode: getAccountPositionMode()?.label || "UNKNOWN",
            dailyPnL: toFiniteNumber(dailyPnlSnapshot.dailyPnL, 0),
            dailyTrades: Math.max(0, Math.trunc(toFiniteNumber(dailyPnlSnapshot.dailyTrades, 0))),
            dailyPnlSource: String(dailyPnlSnapshot.dailyPnlSource || "local").toLowerCase(),
            dailyPnlSyncedAt: toFiniteNumber(dailyPnlSnapshot.dailyPnlSyncedAt, 0),
            activePositions,
            exchangePositionsCount: exchangePositions.length,
            autoGrid,
            openOrders,
            orderCounts: {
                grid: openOrders.grid.length,
                tp: openOrders.tp.length,
                sl: openOrders.sl.length,
                total: openOrders.grid.length + openOrders.tp.length + openOrders.sl.length
            },
            triggerOrdersFetchFailed: Boolean(managedOrders.triggerOrdersFetchFailed)
        };
    };

    const buildDashboardPayload = () => ({
        config: getDb() ? { ...getDb() } : getDefaultConfig(),
        defaults: getDefaultConfig(),
        schema: dashboardEditableFields,
        status: buildDashboardStatus(),
        serverTime: Date.now()
    });

    return {
        buildDashboardStatus,
        buildLiveStatusPayload,
        buildDashboardPayload
    };
};

module.exports = { createDashboardStatusHelpers };
