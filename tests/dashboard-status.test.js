const test = require("node:test");
const assert = require("node:assert/strict");

const { createDashboardStatusHelpers } = require("../services/dashboard-status");

test("buildLiveStatusPayload maps managed order fallbacks from order.info", async () => {
    const helpers = createDashboardStatusHelpers({
        getDb: () => ({
            pair: "DOGE/USDT:USDT",
            dailyPnL: 0,
            dailyTrades: 0
        }),
        getDefaultConfig: () => ({ pair: "DOGE/USDT:USDT", strategy: "spot_grid", marginMode: "spot" }),
        getIsShuttingDown: () => false,
        getExchange: () => ({}),
        getExchangeHealth: () => ({ isHealthy: true, needsRecoverySync: false }),
        getExchangeRecoveryReason: () => "",
        getAccountPositionMode: () => ({ label: "ONE_WAY" }),
        getActivePositionsMap: () => ({}),
        getActivePositionEntries: () => [],
        toFiniteNumber: (value, fallback = 0) => {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : fallback;
        },
        defaultConfig: { pair: "DOGE/USDT:USDT", strategy: "spot_grid", marginMode: "spot" },
        dashboardEditableFields: [],
        getExchangeClientOrderId: (order) => order.clientOrderId || order.info?.clientOrderId || null,
        getPrice: async () => 0.2,
        fetchOpenExchangePositions: async () => [],
        fetchManagedOpenOrdersSnapshot: async () => ({
            grid: [],
            tp: [],
            sl: [{
                id: "sl-1",
                side: "sell",
                type: "STOP_MARKET",
                info: {
                    clientOrderId: "smartsl_test",
                    positionSide: "LONG",
                    reduceOnly: true,
                    stopPrice: "0.19"
                },
                amount: "10"
            }]
        }),
        calculatePositionPnL: () => ({ netProfitUSDT: 0, profitPercent: 0 })
    });

    const payload = await helpers.buildLiveStatusPayload();
    const order = payload.openOrders.sl[0];

    assert.equal(order.clientOrderId, "smartsl_test");
    assert.equal(order.positionSide, "LONG");
    assert.equal(order.reduceOnly, true);
    assert.equal(order.triggerPrice, 0.19);
    assert.equal(order.amount, 10);
});

test("buildLiveStatusPayload exposes exchange health fields for the dashboard UI", async () => {
    const helpers = createDashboardStatusHelpers({
        getDb: () => ({
            pair: "DOGE/USDT:USDT",
            dailyPnL: 1.5,
            dailyTrades: 2
        }),
        getDefaultConfig: () => ({ pair: "DOGE/USDT:USDT", strategy: "spot_grid", marginMode: "spot" }),
        getIsShuttingDown: () => false,
        getExchange: () => ({}),
        getExchangeHealth: () => ({ isHealthy: false, needsRecoverySync: true }),
        getExchangeRecoveryReason: () => "Waiting for successful recovery sync",
        getAccountPositionMode: () => ({ label: "ONE_WAY" }),
        getActivePositionsMap: () => ({}),
        getActivePositionEntries: () => [],
        toFiniteNumber: (value, fallback = 0) => {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : fallback;
        },
        defaultConfig: { pair: "DOGE/USDT:USDT", strategy: "spot_grid", marginMode: "spot" },
        dashboardEditableFields: [],
        getExchangeClientOrderId: (order) => order.clientOrderId || order.info?.clientOrderId || null,
        getPrice: async () => 0.2,
        fetchOpenExchangePositions: async () => [],
        fetchManagedOpenOrdersSnapshot: async () => ({
            grid: [],
            tp: [],
            sl: [],
            triggerOrdersFetchFailed: true
        }),
        calculatePositionPnL: () => ({ netProfitUSDT: 0, profitPercent: 0 })
    });

    const payload = await helpers.buildLiveStatusPayload();

    assert.equal(payload.exchangeConnected, true);
    assert.equal(payload.exchangeHealthy, false);
    assert.equal(payload.needsRecoverySync, true);
    assert.equal(payload.exchangeRecoveryReason, "Waiting for successful recovery sync");
    assert.equal(payload.triggerOrdersFetchFailed, true);
});

test("buildLiveStatusPayload prefers the reconciled daily snapshot and display pnl values", async () => {
    const helpers = createDashboardStatusHelpers({
        getDb: () => ({
            pair: "DOGE/USDT:USDT",
            dailyPnL: 1.5,
            dailyTrades: 2,
            dailyPnlSource: "local",
            dailyPnlSyncedAt: 0
        }),
        getDefaultConfig: () => ({ pair: "DOGE/USDT:USDT", strategy: "spot_grid", marginMode: "spot" }),
        getIsShuttingDown: () => false,
        getExchange: () => ({}),
        getExchangeHealth: () => ({ isHealthy: true, needsRecoverySync: false }),
        getExchangeRecoveryReason: () => "",
        getAccountPositionMode: () => ({ label: "ONE_WAY" }),
        getActivePositionsMap: () => ({
            BOTH: {
                side: "buy",
                quantity: 10,
                entryPrice: 0.2
            }
        }),
        getActivePositionEntries: () => [[
            "BOTH",
            {
                side: "buy",
                quantity: 10,
                entryPrice: 0.2,
                targetPrice: 0.22,
                stopLossPrice: 0.19
            }
        ]],
        toFiniteNumber: (value, fallback = 0) => {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : fallback;
        },
        defaultConfig: { pair: "DOGE/USDT:USDT", strategy: "spot_grid", marginMode: "spot" },
        dashboardEditableFields: [],
        getExchangeClientOrderId: (order) => order.clientOrderId || order.info?.clientOrderId || null,
        getPrice: async () => 0.21,
        fetchOpenExchangePositions: async () => [],
        fetchManagedOpenOrdersSnapshot: async () => ({ grid: [], tp: [], sl: [] }),
        calculatePositionPnL: () => ({ netProfitUSDT: 1, displayProfitUSDT: 1.25, profitPercent: 5, displayProfitPercent: 6 }),
        buildDailyPnlSnapshot: () => ({ dailyPnL: 1.5, dailyTrades: 2, dailyPnlSource: "local", dailyPnlSyncedAt: 0 }),
        syncDailyPnlWithExchange: async () => ({ dailyPnL: 3.75, dailyTrades: 2, dailyPnlSource: "exchange", dailyPnlSyncedAt: 12345 })
    });

    const payload = await helpers.buildLiveStatusPayload();

    assert.equal(payload.dailyPnL, 3.75);
    assert.equal(payload.dailyPnlSource, "exchange");
    assert.equal(payload.dailyPnlSyncedAt, 12345);
    assert.equal(payload.activePositions[0].pnlUSDT, 1.25);
    assert.equal(payload.activePositions[0].pnlPercent, 6);
});
