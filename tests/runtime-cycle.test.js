const test = require("node:test");
const assert = require("node:assert/strict");

const { createRuntimeCycleHelpers } = require("../services/runtime-cycle");

test("runTradingCycle skips config reload while runtime position mutation is in flight", async () => {
    let reloadCalls = 0;
    let schedulerRefreshCalls = 0;

    const helpers = createRuntimeCycleHelpers({
        getDb: () => ({ strategy: "spot_grid" }),
        getLastTradeAt: () => 0,
        setRuntimeCommandsRegistered: () => {},
        getRuntimeCommandsRegistered: () => false,
        toFiniteNumber: (value, fallback = 0) => {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : fallback;
        },
        getUTCDateKey: () => "2026-04-20",
        resetDailyTradeMetrics: () => {},
        saveDB: async () => {},
        getTotalUSDTBalance: async () => 100,
        reloadConfig: async () => { reloadCalls += 1; },
        refreshRuntimeSchedulers: () => { schedulerRefreshCalls += 1; },
        hasRuntimePositionMutationInFlight: () => true,
        canOpenNewPositions: () => true,
        logExchangeRecoveryBlock: () => {},
        fetchOpenGridOrders: async () => [],
        cancelGridOrders: async () => {},
        syncGridOrders: async () => {
            throw new Error("syncGridOrders should not run while mutation is in flight");
        },
        isHedgeModeEnabled: () => false,
        hasAnyActivePosition: () => false,
        getLastTradeTimestampFromLog: () => 0,
        analyzeSignal: async () => ({ canLong: false, canShort: false }),
        getActivePositionByKey: () => null,
        placeOrder: async () => {
            throw new Error("placeOrder should not run while mutation is in flight");
        },
        syncPositionWithExchange: async () => {},
        printDetailedStatus: async () => {},
        getMetrics: () => ({
            windowStart: Date.now(),
            api: { ticker: 0, ohlcv: 0, balance: 0, positions: 0, orders: 0 },
            signals: { analyzed: 0, crossoverDetected: 0, longConfirmed: 0, shortConfirmed: 0 },
            trades: { opened: 0, closed: 0, wins: 0, losses: 0 }
        }),
        resetMetricWindow: () => {},
        metricsLogInterval: 60000
    });

    await helpers.runTradingCycle();

    assert.equal(reloadCalls, 0);
    assert.equal(schedulerRefreshCalls, 0);
});
