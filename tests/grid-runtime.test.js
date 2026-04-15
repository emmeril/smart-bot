const test = require("node:test");
const assert = require("node:assert/strict");

const { createGridRuntimeHelpers } = require("../services/grid-runtime");

test("filterGridOrdersForActiveExposure keeps only the active side in one-way mode", () => {
    const helpers = createGridRuntimeHelpers({
        getDb: () => ({
            pair: "DOGE/USDT:USDT",
            leverage: 10,
            gridLevels: 8,
            gridOrdersPerSide: 2,
            gridOrderSizeUsdt: 5
        }),
        getExchange: () => ({ markets: {} }),
        getBalanceCache: () => ({ totalUSDT: 100, availableUSDT: 100 }),
        getTickerCache: () => ({ price: 100 }),
        getSaveDB: () => async () => {},
        defaultConfig: {
            volumePeriod: 20,
            atrPeriod: 14,
            gridLookbackCandles: 120,
            gridLevels: 8,
            gridTakeProfitLevels: 0,
            gridOrdersPerSide: 2,
            gridOrderSizeUsdt: 5,
            gridRangePercent: 3.5,
            gridEntryBufferPercent: 0.15,
            gridStopLossLevels: 0
        },
        validMarginModes: ["isolated", "cross"],
        normalizeConfig: (config) => config,
        normalizeSymbol: (symbol) => String(symbol || "").toUpperCase(),
        toFiniteNumber: (value, fallback) => {
            const numericValue = Number(value);
            return Number.isFinite(numericValue) ? numericValue : fallback;
        },
        clamp: (value, min, max) => Math.min(Math.max(value, min), max),
        formatPriceToMarketPrecision: (_pair, price) => Number(Number(price).toFixed(4)),
        formatAmountToMarketPrecision: (_pair, amount) => Number(Number(amount).toFixed(8)),
        validateOrderSize: () => ({ valid: true }),
        isDirectionalOrderPlanValid: () => true,
        getClosePositionSide: () => "BOTH",
        isHedgeModeEnabled: () => false,
        getActivePositionsList: () => [{ side: "buy" }],
        getExchangePositionSide: (position) => position.side,
        getOrderTriggerPrice: () => NaN,
        gridClientOrderPrefix: "smartgrid",
        tpClientOrderPrefix: "smarttp",
        slClientOrderPrefix: "smartsl"
    });

    const orders = [
        { side: "buy", clientOrderId: "smartgrid_buy_1_100" },
        { side: "sell", clientOrderId: "smartgrid_sell_1_101" }
    ];

    const filtered = helpers.filterGridOrdersForActiveExposure(orders, [], [{ side: "buy" }]);

    assert.deepEqual(filtered, [orders[0]]);
});

test("filterGridOrdersForActiveExposure keeps both sides in hedge mode", () => {
    const helpers = createGridRuntimeHelpers({
        getDb: () => ({
            pair: "DOGE/USDT:USDT",
            leverage: 10,
            gridLevels: 8,
            gridOrdersPerSide: 2,
            gridOrderSizeUsdt: 5
        }),
        getExchange: () => ({ markets: {} }),
        getBalanceCache: () => ({ totalUSDT: 100, availableUSDT: 100 }),
        getTickerCache: () => ({ price: 100 }),
        getSaveDB: () => async () => {},
        defaultConfig: {
            volumePeriod: 20,
            atrPeriod: 14,
            gridLookbackCandles: 120,
            gridLevels: 8,
            gridTakeProfitLevels: 0,
            gridOrdersPerSide: 2,
            gridOrderSizeUsdt: 5,
            gridRangePercent: 3.5,
            gridEntryBufferPercent: 0.15,
            gridStopLossLevels: 0
        },
        validMarginModes: ["isolated", "cross"],
        normalizeConfig: (config) => config,
        normalizeSymbol: (symbol) => String(symbol || "").toUpperCase(),
        toFiniteNumber: (value, fallback) => {
            const numericValue = Number(value);
            return Number.isFinite(numericValue) ? numericValue : fallback;
        },
        clamp: (value, min, max) => Math.min(Math.max(value, min), max),
        formatPriceToMarketPrecision: (_pair, price) => Number(Number(price).toFixed(4)),
        formatAmountToMarketPrecision: (_pair, amount) => Number(Number(amount).toFixed(8)),
        validateOrderSize: () => ({ valid: true }),
        isDirectionalOrderPlanValid: () => true,
        getClosePositionSide: () => "BOTH",
        isHedgeModeEnabled: () => true,
        getActivePositionsList: () => [{ side: "buy" }],
        getExchangePositionSide: (position) => position.side,
        getOrderTriggerPrice: () => NaN,
        gridClientOrderPrefix: "smartgrid",
        tpClientOrderPrefix: "smarttp",
        slClientOrderPrefix: "smartsl"
    });

    const orders = [
        { side: "buy", clientOrderId: "smartgrid_buy_1_100" },
        { side: "sell", clientOrderId: "smartgrid_sell_1_101" }
    ];

    const filtered = helpers.filterGridOrdersForActiveExposure(orders, [], [{ side: "buy" }]);

    assert.deepEqual(filtered, orders);
});

test("resolveEffectiveGridLevels keeps manual values and derives sane automatic levels", () => {
    const helpers = createGridRuntimeHelpers({
        getDb: () => ({
            pair: "DOGE/USDT:USDT",
            leverage: 10,
            gridLevels: 0,
            gridOrdersPerSide: 2,
            gridOrderSizeUsdt: 5,
            gridRangePercent: 3.5,
            gridLookbackCandles: 120
        }),
        getExchange: () => ({ markets: {} }),
        getBalanceCache: () => ({ totalUSDT: 100, availableUSDT: 100 }),
        getTickerCache: () => ({ price: 100 }),
        getSaveDB: () => async () => {},
        defaultConfig: {
            volumePeriod: 20,
            atrPeriod: 14,
            gridLookbackCandles: 120,
            gridLevels: 8,
            gridTakeProfitLevels: 0,
            gridOrdersPerSide: 2,
            gridOrderSizeUsdt: 5,
            gridRangePercent: 3.5,
            gridEntryBufferPercent: 0.15,
            gridStopLossLevels: 0
        },
        validMarginModes: ["isolated", "cross"],
        normalizeConfig: (config) => config,
        normalizeSymbol: (symbol) => String(symbol || "").toUpperCase(),
        toFiniteNumber: (value, fallback) => {
            const numericValue = Number(value);
            return Number.isFinite(numericValue) ? numericValue : fallback;
        },
        clamp: (value, min, max) => Math.min(Math.max(value, min), max),
        formatPriceToMarketPrecision: (_pair, price) => Number(Number(price).toFixed(4)),
        formatAmountToMarketPrecision: (_pair, amount) => Number(Number(amount).toFixed(8)),
        validateOrderSize: () => ({ valid: true }),
        isDirectionalOrderPlanValid: () => true,
        getClosePositionSide: () => "BOTH",
        isHedgeModeEnabled: () => false,
        getActivePositionsList: () => [],
        getExchangePositionSide: (position) => position.side,
        getOrderTriggerPrice: () => NaN,
        gridClientOrderPrefix: "smartgrid",
        tpClientOrderPrefix: "smarttp",
        slClientOrderPrefix: "smartsl"
    });

    assert.equal(helpers.resolveEffectiveGridLevels({
        configuredGridLevels: 10,
        pair: "BTC/USDT:USDT",
        gridTimeframe: "5m",
        gridRangePercent: 3.5,
        gridLookbackCandles: 120
    }), 10);

    assert.equal(helpers.resolveEffectiveGridLevels({
        configuredGridLevels: 0,
        pair: "BTC/USDT:USDT",
        gridTimeframe: "5m",
        gridRangePercent: 3.5,
        gridLookbackCandles: 120
    }), 8);

    assert.equal(helpers.resolveEffectiveGridLevels({
        configuredGridLevels: 0,
        pair: "DOGE/USDT:USDT",
        gridTimeframe: "5m",
        gridRangePercent: 6.5,
        gridLookbackCandles: 180
    }), 14);

    assert.equal(helpers.resolveEffectiveGridLevels({
        configuredGridLevels: 0,
        pair: "DOGE/USDT:USDT",
        gridTimeframe: "1h",
        gridRangePercent: 2.0,
        gridLookbackCandles: 60
    }), 8);

    assert.equal(helpers.resolveEffectiveGridLevels({
        configuredGridLevels: 0,
        pair: "BTC/USDT:USDT",
        gridTimeframe: "1h",
        gridRangePercent: 6.5,
        gridLookbackCandles: 180
    }), 10);
});

test("resolveEffectiveGridRangePercent and entry buffer adapt for DOGE", () => {
    const helpers = createGridRuntimeHelpers({
        getDb: () => ({
            pair: "DOGE/USDT:USDT",
            leverage: 10,
            gridLevels: 0,
            gridOrdersPerSide: 2,
            gridOrderSizeUsdt: 5,
            gridRangePercent: 0,
            gridEntryBufferPercent: 0,
            gridLookbackCandles: 180,
            gridTimeframe: "5m"
        }),
        getExchange: () => ({ markets: {} }),
        getBalanceCache: () => ({ totalUSDT: 100, availableUSDT: 100 }),
        getTickerCache: () => ({ price: 100 }),
        getSaveDB: () => async () => {},
        defaultConfig: {
            volumePeriod: 20,
            atrPeriod: 14,
            gridLookbackCandles: 120,
            gridLevels: 8,
            gridTakeProfitLevels: 0,
            gridOrdersPerSide: 2,
            gridOrderSizeUsdt: 5,
            gridRangePercent: 3.5,
            gridEntryBufferPercent: 0.15,
            gridStopLossLevels: 0,
            gridTimeframe: "5m"
        },
        validMarginModes: ["isolated", "cross"],
        normalizeConfig: (config) => config,
        normalizeSymbol: (symbol) => String(symbol || "").toUpperCase(),
        toFiniteNumber: (value, fallback) => {
            const numericValue = Number(value);
            return Number.isFinite(numericValue) ? numericValue : fallback;
        },
        clamp: (value, min, max) => Math.min(Math.max(value, min), max),
        formatPriceToMarketPrecision: (_pair, price) => Number(Number(price).toFixed(4)),
        formatAmountToMarketPrecision: (_pair, amount) => Number(Number(amount).toFixed(8)),
        validateOrderSize: () => ({ valid: true }),
        isDirectionalOrderPlanValid: () => true,
        getClosePositionSide: () => "BOTH",
        isHedgeModeEnabled: () => false,
        getActivePositionsList: () => [],
        getExchangePositionSide: (position) => position.side,
        getOrderTriggerPrice: () => NaN,
        gridClientOrderPrefix: "smartgrid",
        tpClientOrderPrefix: "smarttp",
        slClientOrderPrefix: "smartsl"
    });

    assert.equal(helpers.resolveEffectiveGridRangePercent({
        configuredGridRangePercent: 0,
        pair: "DOGE/USDT:USDT",
        gridTimeframe: "5m",
        gridLookbackCandles: 180
    }), 5.51);

    assert.equal(helpers.resolveEffectiveGridRangePercent({
        configuredGridRangePercent: 0,
        pair: "BTC/USDT:USDT",
        gridTimeframe: "5m",
        gridLookbackCandles: 120
    }), 3.68);

    assert.equal(helpers.resolveEffectiveGridEntryBufferPercent({
        configuredGridEntryBufferPercent: 0,
        pair: "DOGE/USDT:USDT",
        gridTimeframe: "5m",
        gridRangePercent: 5.51,
        gridLevels: 12
    }), 0.163);
});
