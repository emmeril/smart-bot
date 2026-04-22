const test = require("node:test");
const assert = require("node:assert/strict");

const { createPositionLifecycleHelpers } = require("../services/position-lifecycle");

test("closePosition keeps remaining position active after a partial close and reapplies exits", async () => {
    const db = {
        pair: "DOGE/USDT",
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
        tpEnsures: 0,
        slEnsures: 0,
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
        strategy: "FUTURES_GRID"
    };

    let fetchPositionsCall = 0;
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
        removeActivePositionByKey: () => {
            throw new Error("removeActivePositionByKey should not be called for partial close");
        },
        saveDB: async () => { state.saveCalls += 1; },
        logTrade: (...args) => { state.tradeLogs.push(args); },
        getTrackedPositionSideLabel: () => "BOTH",
        getPrice: async () => 110,
        calculatePositionPnL: (_position, exitPrice, quantityOverride = null) => ({
            realizedProfitUSDT: (exitPrice - 100) * (quantityOverride ?? 2),
            netProfitUSDT: (exitPrice - 100) * (quantityOverride ?? 2),
            profitPercent: 10
        }),
        fetchOpenExchangePositions: async () => {
            fetchPositionsCall += 1;
            if (fetchPositionsCall === 1) {
                return [{ symbol: db.pair, contracts: 2, entryPrice: 100 }];
            }
            return [{ symbol: db.pair, contracts: 1, entryPrice: 100 }];
        },
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
        ensureReduceOnlyTakeProfitOrder: async () => { state.tpEnsures += 1; },
        ensureReduceOnlyStopLossOrder: async () => { state.slEnsures += 1; },
        getPositionSyncQtyTolerance: () => 0.001,
        getOrderFillSnapshot: () => ({ price: 110, quantity: 2 })
    });

    await helpers.closePosition("BOTH", "MANUAL_CLOSE");

    assert.equal(state.upserts.length, 1);
    assert.equal(state.upserts[0].quantity, 1);
    assert.equal(state.upserts[0].targetPrice, 105);
    assert.equal(state.upserts[0].stopLossPrice, 98);
    assert.equal(state.upserts[0].targetProfitUSDT, 5);
    assert.equal(state.upserts[0].stopLossUSDT, -2);
    assert.equal(db.dailyPnL, 10);
    assert.equal(state.tpEnsures, 1);
    assert.equal(state.slEnsures, 1);
    assert.equal(state.tradeLogs.length, 1);
    assert.equal(state.tradeLogs[0][3], "PARTIAL_CLOSE:MANUAL_CLOSE");
    assert.equal(state.isClosing, false);
});

test("clearMissingPositionState skips stale cleanup when tracked position has changed", async () => {
    const db = {
        pair: "DOGE/USDT",
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
        pair: "DOGE/USDT",
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
