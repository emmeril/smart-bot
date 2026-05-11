const test = require("node:test");
const assert = require("node:assert/strict");

const { createPositionLifecycleHelpers } = require("../services/position-lifecycle");

test("closePosition finalizes a spot close without futures partial-position resync", async () => {
    const db = {
        pair: "DOGE/USDT:USDT",
        dailyPnL: 0,
        dailyTrades: 0
    };
    const metrics = {
        api: { orders: 0 },
        trades: { closed: 0, wins: 0, losses: 0 }
    };
    const closingKeys = new Set();
    const state = {
        isClosing: false,
        upserts: [],
        saveCalls: 0,
        removeCalls: 0,
        tradeLogs: []
    };

    const trackedPosition = {
        side: "buy",
        positionSide: "BOTH",
        quantity: 2,
        entryPrice: 100,
        atrAtEntry: 1,
        trailingActivateATR: 1.2,
        trailingOffsetATR: 0.6,
        targetPrice: 110,
        stopLossPrice: 95,
        targetProfitUSDT: 20,
        stopLossUSDT: -10,
        strategy: "SPOT_GRID"
    };

    const exchange = {
        createOrder: async () => ({ id: "close-order" })
    };

    const helpers = createPositionLifecycleHelpers({
        getDb: () => db,
        getExchange: () => exchange,
        getMetrics: () => metrics,
        isHedgeModeEnabled: () => false,
        getClosingPositionKeys: () => closingKeys,
        getIsClosingPosition: () => state.isClosing,
        setIsClosingPosition: (value) => { state.isClosing = value; },
        toPositionMapKey: (key) => String(key || "").toUpperCase(),
        hasAnyActivePosition: () => true,
        getActivePositionEntries: () => [["BOTH", trackedPosition]],
        getActivePositionByKey: () => trackedPosition,
        cancelManagedOrdersForPosition: async () => {},
        removeActivePositionByKey: () => { state.removeCalls += 1; },
        saveDB: async () => { state.saveCalls += 1; },
        logTrade: (...args) => { state.tradeLogs.push(args); },
        getTrackedPositionSideLabel: () => "BOTH",
        getPrice: async () => 110,
        calculatePositionPnL: (_position, exitPrice, quantityOverride = null) => ({
            realizedProfitUSDT: (exitPrice - 100) * (quantityOverride ?? 2),
            netProfitUSDT: (exitPrice - 100) * (quantityOverride ?? 2),
            profitPercent: 10
        }),
        fetchOpenExchangePositions: async () => [],
        findOpenExchangePosition: (positions) => positions[0] || null,
        getExchangePositionContracts: (position) => Number(position.contracts),
        getExchangePositionEntryPrice: (position, fallback) => Number(position.entryPrice ?? fallback),
        fetchOpenGridOrders: async () => [],
        buildOrderPlan: (_side, entryPrice, quantity) => ({
            targetPrice: entryPrice + (5 * quantity),
            stopLossPrice: entryPrice - (2 * quantity),
            targetProfitUSDT: 5 * quantity,
            stopLossUSDT: -2 * quantity
        }),
        upsertActivePosition: (position) => { state.upserts.push(position); },
        fetchOpenTpOrders: async () => [],
        fetchOpenSlOrders: async () => [],
        matchesOrderToTrackedPosition: () => false,
        cancelGridOrders: async () => {},
        cancelTpOrders: async () => {},
        cancelSlOrders: async () => {},
        buildExchangeOrderParams: () => ({}),
        getClosePositionSide: () => "BOTH",
        buildSyncedActivePosition: (_remainingPosition, remainingEntryPrice, position) => ({
            ...position,
            quantity: 1,
            entryPrice: remainingEntryPrice,
            targetPrice: 999,
            stopLossPrice: 999,
            targetProfitUSDT: 999,
            stopLossUSDT: -999
        }),
        ensureReduceOnlyTakeProfitOrder: async () => {},
        ensureReduceOnlyStopLossOrder: async () => {},
        getPositionSyncQtyTolerance: () => 0.001,
        getOrderFillSnapshot: () => ({ price: 110, quantity: 2 })
    });

    await helpers.closePosition("BOTH", "MANUAL_CLOSE");

    assert.equal(state.upserts.length, 0);
    assert.equal(state.removeCalls, 1);
    assert.equal(db.dailyPnL, 20);
    assert.equal(state.tradeLogs.length, 1);
    assert.equal(state.tradeLogs[0][3], "CLOSE:MANUAL_CLOSE");
    assert.equal(state.isClosing, false);
});

test("clearMissingPositionState skips stale cleanup when tracked position has changed", async () => {
    const db = {
        pair: "DOGE/USDT:USDT",
        dailyPnL: 0,
        dailyTrades: 0
    };
    const metrics = {
        api: { orders: 0 },
        trades: { closed: 0, wins: 0, losses: 0 }
    };
    const state = {
        saveCalls: 0,
        removeCalls: 0,
        tradeLogs: []
    };

    const stalePosition = {
        side: "buy",
        positionSide: "BOTH",
        quantity: 2,
        entryPrice: 100,
        entryTime: 1000,
        orderId: "old-order"
    };
    const currentTrackedPosition = {
        ...stalePosition,
        quantity: 1,
        entryTime: 2000,
        orderId: "new-order"
    };

    const helpers = createPositionLifecycleHelpers({
        getDb: () => db,
        getExchange: () => ({ createOrder: async () => ({ id: "unused" }) }),
        getMetrics: () => metrics,
        isHedgeModeEnabled: () => false,
        getClosingPositionKeys: () => new Set(),
        getIsClosingPosition: () => false,
        setIsClosingPosition: () => {},
        toPositionMapKey: (key) => String(key || "").toUpperCase(),
        hasAnyActivePosition: () => true,
        getActivePositionEntries: () => [["BOTH", currentTrackedPosition]],
        getActivePositionByKey: () => currentTrackedPosition,
        cancelManagedOrdersForPosition: async () => {},
        removeActivePositionByKey: () => { state.removeCalls += 1; },
        saveDB: async () => { state.saveCalls += 1; },
        logTrade: (...args) => { state.tradeLogs.push(args); },
        getTrackedPositionSideLabel: () => "BOTH",
        getPrice: async () => 110,
        calculatePositionPnL: () => ({ realizedProfitUSDT: 20, netProfitUSDT: 20, profitPercent: 10 }),
        fetchOpenExchangePositions: async () => [],
        findOpenExchangePosition: () => null,
        getExchangePositionContracts: () => 0,
        getExchangePositionEntryPrice: (_position, fallback) => fallback,
        fetchOpenGridOrders: async () => [],
        buildOrderPlan: () => ({
            targetPrice: 105,
            stopLossPrice: 98,
            targetProfitUSDT: 5,
            stopLossUSDT: -2
        }),
        upsertActivePosition: () => {},
        fetchOpenTpOrders: async () => [],
        fetchOpenSlOrders: async () => [],
        matchesOrderToTrackedPosition: () => false,
        cancelGridOrders: async () => {},
        cancelTpOrders: async () => {},
        cancelSlOrders: async () => {},
        buildExchangeOrderParams: () => ({}),
        getClosePositionSide: () => "BOTH",
        buildSyncedActivePosition: () => currentTrackedPosition,
        ensureReduceOnlyTakeProfitOrder: async () => {},
        ensureReduceOnlyStopLossOrder: async () => {},
        getPositionSyncQtyTolerance: () => 0.001,
        getOrderFillSnapshot: () => ({ price: 110, quantity: 2 })
    });

    const result = await helpers.clearMissingPositionState(stalePosition, "POSITION_SYNC_REMOVED", "BOTH");

    assert.equal(result, false);
    assert.equal(state.removeCalls, 0);
    assert.equal(state.saveCalls, 0);
    assert.equal(db.dailyPnL, 0);
    assert.equal(db.dailyTrades, 0);
    assert.equal(metrics.trades.closed, 0);
    assert.equal(state.tradeLogs.length, 0);
});

test("finalizeClosedPosition skips stale finalize when tracked position has changed", async () => {
    const db = {
        pair: "DOGE/USDT:USDT",
        dailyPnL: 0,
        dailyTrades: 0
    };
    const metrics = {
        api: { orders: 0 },
        trades: { closed: 0, wins: 0, losses: 0 }
    };
    const state = {
        saveCalls: 0,
        removeCalls: 0,
        tradeLogs: []
    };

    const stalePosition = {
        side: "buy",
        positionSide: "BOTH",
        quantity: 2,
        entryPrice: 100,
        entryTime: 1000,
        orderId: "old-order"
    };
    const currentTrackedPosition = {
        ...stalePosition,
        quantity: 1,
        entryTime: 2000,
        orderId: "new-order"
    };

    const helpers = createPositionLifecycleHelpers({
        getDb: () => db,
        getExchange: () => ({ createOrder: async () => ({ id: "unused" }) }),
        getMetrics: () => metrics,
        isHedgeModeEnabled: () => false,
        getClosingPositionKeys: () => new Set(),
        getIsClosingPosition: () => false,
        setIsClosingPosition: () => {},
        toPositionMapKey: (key) => String(key || "").toUpperCase(),
        hasAnyActivePosition: () => true,
        getActivePositionEntries: () => [["BOTH", currentTrackedPosition]],
        getActivePositionByKey: () => currentTrackedPosition,
        cancelManagedOrdersForPosition: async () => {},
        removeActivePositionByKey: () => { state.removeCalls += 1; },
        saveDB: async () => { state.saveCalls += 1; },
        logTrade: (...args) => { state.tradeLogs.push(args); },
        getTrackedPositionSideLabel: () => "BOTH",
        getPrice: async () => 110,
        calculatePositionPnL: () => ({ realizedProfitUSDT: 20, netProfitUSDT: 20, profitPercent: 10 }),
        fetchOpenExchangePositions: async () => [],
        findOpenExchangePosition: () => null,
        getExchangePositionContracts: () => 0,
        getExchangePositionEntryPrice: (_position, fallback) => fallback,
        fetchOpenGridOrders: async () => [],
        buildOrderPlan: () => ({
            targetPrice: 105,
            stopLossPrice: 98,
            targetProfitUSDT: 5,
            stopLossUSDT: -2
        }),
        upsertActivePosition: () => {},
        fetchOpenTpOrders: async () => [],
        fetchOpenSlOrders: async () => [],
        matchesOrderToTrackedPosition: () => false,
        cancelGridOrders: async () => {},
        cancelTpOrders: async () => {},
        cancelSlOrders: async () => {},
        buildExchangeOrderParams: () => ({}),
        getClosePositionSide: () => "BOTH",
        buildSyncedActivePosition: () => currentTrackedPosition,
        ensureReduceOnlyTakeProfitOrder: async () => {},
        ensureReduceOnlyStopLossOrder: async () => {},
        getPositionSyncQtyTolerance: () => 0.001,
        getOrderFillSnapshot: () => ({ price: 110, quantity: 2 })
    });

    const result = await helpers.finalizeClosedPosition(stalePosition, 25, 12.5, "MANUAL_CLOSE", 112, "BOTH");

    assert.equal(result, false);
    assert.equal(state.removeCalls, 0);
    assert.equal(state.saveCalls, 0);
    assert.equal(db.dailyPnL, 0);
    assert.equal(db.dailyTrades, 0);
    assert.equal(metrics.trades.closed, 0);
    assert.equal(state.tradeLogs.length, 0);
});

test("finalizeClosedPosition sends a TP notification after a successful close", async () => {
    const db = {
        pair: "DOGE/USDT:USDT",
        dailyPnL: 0,
        dailyTrades: 0
    };
    const metrics = {
        api: { orders: 0 },
        trades: { closed: 0, wins: 0, losses: 0 }
    };
    const state = {
        notifications: [],
        saveCalls: 0,
        tradeLogs: []
    };
    const position = {
        side: "buy",
        positionSide: "BOTH",
        quantity: 2,
        entryPrice: 100,
        entryTime: 1000,
        orderId: "open-order",
        strategy: "SPOT_GRID"
    };

    const helpers = createPositionLifecycleHelpers({
        getDb: () => db,
        getExchange: () => ({ createOrder: async () => ({ id: "unused" }) }),
        getMetrics: () => metrics,
        isHedgeModeEnabled: () => false,
        getClosingPositionKeys: () => new Set(),
        getIsClosingPosition: () => false,
        setIsClosingPosition: () => {},
        toPositionMapKey: (key) => String(key || "").toUpperCase(),
        hasAnyActivePosition: () => true,
        getActivePositionEntries: () => [["BOTH", position]],
        getActivePositionByKey: () => position,
        cancelManagedOrdersForPosition: async () => {},
        removeActivePositionByKey: () => {},
        saveDB: async () => { state.saveCalls += 1; },
        applyDailyPnlDelta: async ({ pnlDelta, tradeDelta }) => {
            db.dailyPnL += pnlDelta;
            db.dailyTrades += tradeDelta;
        },
        logTrade: (...args) => { state.tradeLogs.push(args); },
        getTrackedPositionSideLabel: () => "BOTH",
        getPrice: async () => 110,
        calculatePositionPnL: () => ({ realizedProfitUSDT: 20, netProfitUSDT: 20, profitPercent: 10 }),
        fetchOpenExchangePositions: async () => [],
        findOpenExchangePosition: () => null,
        getExchangePositionContracts: () => 0,
        getExchangePositionEntryPrice: (_position, fallback) => fallback,
        fetchOpenGridOrders: async () => [],
        buildOrderPlan: () => ({
            targetPrice: 105,
            stopLossPrice: 98,
            targetProfitUSDT: 5,
            stopLossUSDT: -2
        }),
        upsertActivePosition: () => {},
        fetchOpenTpOrders: async () => [],
        fetchOpenSlOrders: async () => [],
        matchesOrderToTrackedPosition: () => false,
        cancelGridOrders: async () => {},
        cancelTpOrders: async () => {},
        cancelSlOrders: async () => {},
        buildExchangeOrderParams: () => ({}),
        getClosePositionSide: () => "BOTH",
        buildSyncedActivePosition: () => position,
        ensureReduceOnlyTakeProfitOrder: async () => {},
        ensureReduceOnlyStopLossOrder: async () => {},
        getPositionSyncQtyTolerance: () => 0.001,
        getOrderFillSnapshot: () => ({ price: 110, quantity: 2 }),
        notifyPositionClosed: async (payload) => {
            state.notifications.push(payload);
        }
    });

    const result = await helpers.finalizeClosedPosition(position, 20, 10, "PROFIT_TARGET", 110, "BOTH", {
        closedAt: 1700000000000
    });

    assert.equal(result, true);
    assert.equal(state.notifications.length, 1);
    assert.equal(state.notifications[0].reason, "PROFIT_TARGET");
    assert.equal(state.notifications[0].exitPrice, 110);
    assert.equal(state.notifications[0].position.symbol, "DOGE/USDT:USDT");
    assert.equal(db.dailyPnL, 20);
    assert.equal(db.dailyTrades, 1);
});

test("finalizeClosedPosition sends a manual close notification after a successful close", async () => {
    const db = {
        pair: "DOGE/USDT:USDT",
        dailyPnL: 0,
        dailyTrades: 0
    };
    const metrics = {
        api: { orders: 0 },
        trades: { closed: 0, wins: 0, losses: 0 }
    };
    const state = {
        notifications: []
    };
    const position = {
        side: "sell",
        positionSide: "BOTH",
        quantity: 1,
        entryPrice: 100,
        entryTime: 1000,
        orderId: "open-order",
        strategy: "SPOT_GRID"
    };

    const helpers = createPositionLifecycleHelpers({
        getDb: () => db,
        getExchange: () => ({ createOrder: async () => ({ id: "unused" }) }),
        getMetrics: () => metrics,
        isHedgeModeEnabled: () => false,
        getClosingPositionKeys: () => new Set(),
        getIsClosingPosition: () => false,
        setIsClosingPosition: () => {},
        toPositionMapKey: (key) => String(key || "").toUpperCase(),
        hasAnyActivePosition: () => true,
        getActivePositionEntries: () => [["BOTH", position]],
        getActivePositionByKey: () => position,
        cancelManagedOrdersForPosition: async () => {},
        removeActivePositionByKey: () => {},
        saveDB: async () => {},
        applyDailyPnlDelta: async ({ pnlDelta, tradeDelta }) => {
            db.dailyPnL += pnlDelta;
            db.dailyTrades += tradeDelta;
        },
        logTrade: () => {},
        getTrackedPositionSideLabel: () => "BOTH",
        getPrice: async () => 99,
        calculatePositionPnL: () => ({ realizedProfitUSDT: 1, netProfitUSDT: 1, profitPercent: 1 }),
        fetchOpenExchangePositions: async () => [],
        findOpenExchangePosition: () => null,
        getExchangePositionContracts: () => 0,
        getExchangePositionEntryPrice: (_position, fallback) => fallback,
        fetchOpenGridOrders: async () => [],
        buildOrderPlan: () => ({
            targetPrice: 95,
            stopLossPrice: 105,
            targetProfitUSDT: 5,
            stopLossUSDT: -5
        }),
        upsertActivePosition: () => {},
        fetchOpenTpOrders: async () => [],
        fetchOpenSlOrders: async () => [],
        matchesOrderToTrackedPosition: () => false,
        cancelGridOrders: async () => {},
        cancelTpOrders: async () => {},
        cancelSlOrders: async () => {},
        buildExchangeOrderParams: () => ({}),
        getClosePositionSide: () => "BOTH",
        buildSyncedActivePosition: () => position,
        ensureReduceOnlyTakeProfitOrder: async () => {},
        ensureReduceOnlyStopLossOrder: async () => {},
        getPositionSyncQtyTolerance: () => 0.001,
        getOrderFillSnapshot: () => ({ price: 99, quantity: 1 }),
        notifyPositionClosed: async (payload) => {
            state.notifications.push(payload);
        }
    });

    const result = await helpers.finalizeClosedPosition(position, 1, 1, "MANUAL_CLOSE", 99, "BOTH", {
        closedAt: 1700000000000
    });

    assert.equal(result, true);
    assert.equal(state.notifications.length, 1);
    assert.equal(state.notifications[0].reason, "MANUAL_CLOSE");
    assert.equal(state.notifications[0].position.symbol, "DOGE/USDT:USDT");
});

test("clearMissingPositionState sends a sync notification when a tracked position disappears", async () => {
    const db = {
        pair: "DOGE/USDT:USDT",
        dailyPnL: 0,
        dailyTrades: 0
    };
    const metrics = {
        api: { orders: 0 },
        trades: { closed: 0, wins: 0, losses: 0 }
    };
    const state = {
        notifications: [],
        removeCalls: 0,
        tradeLogs: []
    };
    const position = {
        side: "buy",
        positionSide: "BOTH",
        quantity: 2,
        entryPrice: 100,
        entryTime: 1000,
        orderId: "open-order",
        strategy: "SPOT_GRID"
    };

    const helpers = createPositionLifecycleHelpers({
        getDb: () => db,
        getExchange: () => ({ createOrder: async () => ({ id: "unused" }) }),
        getMetrics: () => metrics,
        isHedgeModeEnabled: () => false,
        getClosingPositionKeys: () => new Set(),
        getIsClosingPosition: () => false,
        setIsClosingPosition: () => {},
        toPositionMapKey: (key) => String(key || "").toUpperCase(),
        hasAnyActivePosition: () => true,
        getActivePositionEntries: () => [["BOTH", position]],
        getActivePositionByKey: () => position,
        cancelManagedOrdersForPosition: async () => {},
        removeActivePositionByKey: () => { state.removeCalls += 1; },
        saveDB: async () => {},
        applyDailyPnlDelta: async ({ pnlDelta, tradeDelta }) => {
            db.dailyPnL += pnlDelta;
            db.dailyTrades += tradeDelta;
        },
        logTrade: (...args) => { state.tradeLogs.push(args); },
        getTrackedPositionSideLabel: () => "BOTH",
        getPrice: async () => 111,
        calculatePositionPnL: () => ({ realizedProfitUSDT: 22, netProfitUSDT: 22, profitPercent: 11 }),
        fetchOpenExchangePositions: async () => [],
        findOpenExchangePosition: () => null,
        getExchangePositionContracts: () => 0,
        getExchangePositionEntryPrice: (_position, fallback) => fallback,
        fetchOpenGridOrders: async () => [],
        buildOrderPlan: () => ({
            targetPrice: 105,
            stopLossPrice: 98,
            targetProfitUSDT: 5,
            stopLossUSDT: -2
        }),
        upsertActivePosition: () => {},
        fetchOpenTpOrders: async () => [],
        fetchOpenSlOrders: async () => [],
        matchesOrderToTrackedPosition: () => false,
        cancelGridOrders: async () => {},
        cancelTpOrders: async () => {},
        cancelSlOrders: async () => {},
        buildExchangeOrderParams: () => ({}),
        getClosePositionSide: () => "BOTH",
        buildSyncedActivePosition: () => position,
        ensureReduceOnlyTakeProfitOrder: async () => {},
        ensureReduceOnlyStopLossOrder: async () => {},
        getPositionSyncQtyTolerance: () => 0.001,
        getOrderFillSnapshot: () => ({ price: 111, quantity: 2 }),
        notifyPositionClosed: async (payload) => {
            state.notifications.push(payload);
        }
    });

    const result = await helpers.clearMissingPositionState(position, "POSITION_SYNC_REMOVED", "BOTH");

    assert.equal(result, true);
    assert.equal(state.removeCalls, 1);
    assert.equal(state.notifications.length, 1);
    assert.equal(state.notifications[0].reason, "POSITION_SYNC_REMOVED");
    assert.equal(state.notifications[0].estimatedExitPrice, true);
    assert.equal(state.notifications[0].position.symbol, "DOGE/USDT:USDT");
    assert.equal(db.dailyPnL, 22);
    assert.equal(db.dailyTrades, 1);
    assert.equal(state.tradeLogs[0][3], "CLOSE_UNCONFIRMED:POSITION_SYNC_REMOVED");
});
