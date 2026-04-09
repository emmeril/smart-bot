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
    getPrice,
    fetchOpenExchangePositions,
    fetchManagedOpenOrdersSnapshot,
    calculatePositionPnL
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
        clientOrderId: order.clientOrderId ?? null,
        side: order.side ?? null,
        positionSide: order.positionSide ?? null,
        type: order.type ?? null,
        reduceOnly: Boolean(order.reduceOnly),
        price: Number.isFinite(Number(order.price)) ? Number(order.price) : null,
        triggerPrice: Number.isFinite(Number(order.triggerPrice)) ? Number(order.triggerPrice) : null,
        amount: Number.isFinite(Number(order.amount)) ? Number(order.amount) : null
    });

    const buildLiveStatusPayload = async () => {
        const db = getDb();
        if (!db) {
            return {
                ok: false,
                error: "Config is not ready yet"
            };
        }

        let currentPrice = NaN;
        let exchangePositions = [];
        let managedOrders = { grid: [], tp: [], sl: [] };

        try {
            currentPrice = await getPrice();
        } catch {
            currentPrice = NaN;
        }

        try {
            exchangePositions = await fetchOpenExchangePositions();
        } catch (error) {
            console.warn(`[STATUS] Failed to fetch exchange positions: ${error.message}`);
        }

        try {
            managedOrders = await fetchManagedOpenOrdersSnapshot();
        } catch (error) {
            console.warn(`[STATUS] Failed to fetch managed open orders: ${error.message}`);
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
                pnlUSDT: pnlState ? toFiniteNumber(pnlState.netProfitUSDT, 0) : null,
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
            positionMode: getAccountPositionMode()?.label || "UNKNOWN",
            dailyPnL: toFiniteNumber(db.dailyPnL, 0),
            dailyTrades: Math.max(0, Math.trunc(toFiniteNumber(db.dailyTrades, 0))),
            activePositions,
            exchangePositionsCount: exchangePositions.length,
            openOrders,
            orderCounts: {
                grid: openOrders.grid.length,
                tp: openOrders.tp.length,
                sl: openOrders.sl.length,
                total: openOrders.grid.length + openOrders.tp.length + openOrders.sl.length
            }
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
