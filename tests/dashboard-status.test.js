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
        getDefaultConfig: () => ({ pair: "DOGE/USDT:USDT", strategy: "futures_grid", marginMode: "isolated", leverage: 10 }),
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
        defaultConfig: { pair: "DOGE/USDT:USDT", strategy: "futures_grid", marginMode: "isolated", leverage: 10 },
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
        getDefaultConfig: () => ({ pair: "DOGE/USDT:USDT", strategy: "futures_grid", marginMode: "isolated", leverage: 10 }),
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
        defaultConfig: { pair: "DOGE/USDT:USDT", strategy: "futures_grid", marginMode: "isolated", leverage: 10 },
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
