const test = require("node:test");
const assert = require("node:assert/strict");

const { createTradeEntryHelpers } = require("../services/trade-entry");

test("placeOrder exits early after emergency close when no valid TP/SL plan can be derived", async () => {
    const state = {
        placing: false,
        syncCalls: 0,
        upsertCalls: 0,
        saveCalls: 0,
        ensureTpCalls: 0,
        ensureSlCalls: 0
    };

    let createOrderCalls = 0;
    let planValidationCalls = 0;
    const exchange = {
        markets: {
            "DOGE/USDT:USDT": {}
        },
        createOrder: async () => {
            createOrderCalls += 1;
            return createOrderCalls === 1 ? { id: "open-order" } : { id: "close-order" };
        }
    };

    const helpers = createTradeEntryHelpers({
        getDb: () => ({
            pair: "DOGE/USDT:USDT",
            gridOrderSizeUsdt: 5,
            leverage: 10,
            marginMode: "isolated"
        }),
        getExchange: () => exchange,
        getMetrics: () => ({ api: { orders: 0 }, trades: { opened: 0 } }),
        getIsPlacingOrder: () => state.placing,
        setIsPlacingOrder: (value) => { state.placing = value; },
        getIsClosingPosition: () => false,
        getOrderPositionSide: () => "BOTH",
        getActivePositionByKey: () => null,
        setMarginMode: async () => true,
        fetchOpenExchangePositions: async () => [],
        isHedgeModeEnabled: () => false,
        matchesTrackedPositionSide: () => false,
        fetchManagedOpenOrdersSnapshot: async () => ({ triggerOrdersFetchFailed: false, grid: [], tp: [], sl: [] }),
        setLeverage: async () => true,
        getPrice: async () => 100,
        parseSignalOrderData: () => ({
            signalPrice: 100,
            signalATR: null,
            strategyName: "FUTURES_GRID",
            riskOverrides: {},
            signalTargetPrice: null,
            signalStopLossPrice: null
        }),
        formatAmountToMarketPrecision: (_pair, quantity) => Number(quantity),
        validateOrderSize: () => ({ valid: true }),
        buildOrderPlan: () => ({
            targetPrice: 100,
            stopLossPrice: 100,
            stopLossUSDT: 0,
            targetProfitUSDT: 0,
            trailingEnabled: false,
            trailingActivateATR: 1.2,
            trailingOffsetATR: 0.6
        }),
        logOrderPlan: () => {},
        isDirectionalOrderPlanValid: () => {
            planValidationCalls += 1;
            return planValidationCalls === 1;
        },
        buildExchangeOrderParams: () => ({}),
        getOrderFillSnapshot: () => ({ price: 100, quantity: 0.5 }),
        upsertActivePosition: () => { state.upsertCalls += 1; },
        toFiniteNumber: (value, fallback) => {
            const numericValue = Number(value);
            return Number.isFinite(numericValue) ? numericValue : fallback;
        },
        saveDB: async () => { state.saveCalls += 1; },
        ensureReduceOnlyTakeProfitOrder: async () => { state.ensureTpCalls += 1; },
        ensureReduceOnlyStopLossOrder: async () => { state.ensureSlCalls += 1; },
        logTrade: () => {},
        syncPositionWithExchange: async () => { state.syncCalls += 1; }
    });

    await helpers.placeOrder("buy", {});

    assert.equal(createOrderCalls, 2);
    assert.equal(state.syncCalls, 1);
    assert.equal(state.upsertCalls, 0);
    assert.equal(state.saveCalls, 0);
    assert.equal(state.ensureTpCalls, 0);
    assert.equal(state.ensureSlCalls, 0);
    assert.equal(state.placing, false);
});
