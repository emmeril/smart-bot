const test = require("node:test");
const assert = require("node:assert/strict");

const { createPositionLifecycleHelpers } = require("../services/position-lifecycle");
const { createPositionStateHelpers } = require("../services/position-state");

test("closePosition keeps remaining position active after a partial close and reapplies exits", async () => {
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

test("mergeMatchedTrackedPositions keeps local runtime fields while adopting synced exchange fields", () => {
    const helpers = createPositionStateHelpers({
        getDb: () => ({ activePosition: null }),
        isLegacySinglePosition: () => false,
        toPositionMapKey: (key) => String(key || "").toUpperCase(),
        getTrackedPositionSideLabel: (position) => position.positionSide,
        isSameTrackedPosition: (currentPosition, nextPosition) => currentPosition.positionSide === nextPosition.positionSide
    });

    const merged = helpers.mergeMatchedTrackedPositions(
        {
            LONG: {
                positionSide: "LONG",
                stopLossPrice: 99,
                highestSinceEntry: 123,
                tpClientOrderId: "tp-local"
            },
            SHORT: {
                positionSide: "SHORT",
                stopLossPrice: 101
            }
        },
        {
            LONG: {
                positionSide: "LONG",
                entryPrice: 100,
                quantity: 2,
                exchangePnlSnapshot: { source: "exchange", netProfitUSDT: 3.5 },
                leverageAtEntry: 5
            }
        }
    );

    assert.deepEqual(merged, {
        LONG: {
            positionSide: "LONG",
            entryPrice: 100,
            quantity: 2,
            exchangePnlSnapshot: { source: "exchange", netProfitUSDT: 3.5 },
            leverageAtEntry: 5,
            stopLossPrice: 99,
            highestSinceEntry: 123,
            tpClientOrderId: "tp-local"
        }
    });
});

test("finalizeClosedPosition rolls daily metrics forward before booking pnl on a new UTC day", async () => {
    const originalDateNow = Date.now;
    Date.now = () => Date.parse("2026-04-20T00:05:00.000Z");

    try {
        const db = {
            pair: "DOGE/USDT:USDT",
            dailyPnL: 42,
            dailyTrades: 7,
            lastDailyReset: Date.parse("2026-04-19T10:00:00.000Z")
        };
        const metrics = {
            trades: { closed: 0, wins: 0, losses: 0 }
        };
        let removedKey = null;
        let saveCalls = 0;

        const helpers = createPositionLifecycleHelpers({
            getDb: () => db,
            getExchange: () => ({ createOrder: async () => ({}) }),
            getMetrics: () => metrics,
            isHedgeModeEnabled: () => false,
            getClosingPositionKeys: () => new Set(),
            getIsClosingPosition: () => false,
            setIsClosingPosition: () => {},
            toPositionMapKey: (key) => String(key || "").toUpperCase(),
            hasAnyActivePosition: () => true,
            getActivePositionEntries: () => [],
            getActivePositionByKey: () => null,
            cancelManagedOrdersForPosition: async () => {},
            removeActivePositionByKey: (key) => { removedKey = key; },
            saveDB: async () => { saveCalls += 1; },
            logTrade: () => {},
            getTrackedPositionSideLabel: () => "BOTH",
            getPrice: async () => 111,
            calculatePositionPnL: () => ({ realizedProfitUSDT: 0, netProfitUSDT: 0, profitPercent: 0 }),
            fetchOpenExchangePositions: async () => [],
            findOpenExchangePosition: () => null,
            getExchangePositionContracts: () => 0,
            getExchangePositionEntryPrice: (_position, fallback) => fallback,
            fetchOpenGridOrders: async () => [],
            buildOrderPlan: () => ({}),
            upsertActivePosition: () => {},
            fetchOpenTpOrders: async () => [],
            fetchOpenSlOrders: async () => [],
            matchesOrderToTrackedPosition: () => false,
            cancelGridOrders: async () => {},
            cancelTpOrders: async () => {},
            cancelSlOrders: async () => {},
            buildExchangeOrderParams: () => ({}),
            getClosePositionSide: () => "BOTH",
            buildSyncedActivePosition: () => ({}),
            ensureReduceOnlyTakeProfitOrder: async () => {},
            ensureReduceOnlyStopLossOrder: async () => {},
            getPositionSyncQtyTolerance: () => 0.001,
            getOrderFillSnapshot: () => ({ price: 111, quantity: 1 })
        });

        await helpers.finalizeClosedPosition(
            { side: "buy", entryPrice: 100, strategy: "FUTURES_GRID", positionSide: "BOTH" },
            5,
            5,
            "TP_HIT",
            105,
            "BOTH"
        );

        assert.equal(db.dailyPnL, 5);
        assert.equal(db.dailyTrades, 1);
        assert.equal(db.lastDailyReset, Date.parse("2026-04-20T00:05:00.000Z"));
        assert.equal(metrics.trades.closed, 1);
        assert.equal(metrics.trades.wins, 1);
        assert.equal(metrics.trades.losses, 0);
        assert.equal(removedKey, "BOTH");
        assert.equal(saveCalls, 1);
    } finally {
        Date.now = originalDateNow;
    }
});
