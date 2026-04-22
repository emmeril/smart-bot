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

test("applyAutoPairGridPreset clears stale activeGridState when fingerprint only matches by substring", () => {
    const helpers = createGridRuntimeHelpers({
        getDb: () => ({
            pair: "DOGE/USDT:USDT",
            leverage: 10,
            gridLevels: 2,
            gridOrdersPerSide: 2,
            gridOrderSizeUsdt: 5,
            gridRangePercent: 0,
            gridEntryBufferPercent: 0,
            gridLookbackCandles: 180,
            gridTakeProfitLevels: 0,
            gridStopLossLevels: 0,
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

    const result = helpers.applyAutoPairGridPreset({
        strategy: "futures_grid",
        pair: "DOGE/USDT:USDT",
        marginMode: "isolated",
        gridLevels: 2,
        gridLookbackCandles: 180,
        gridRangePercent: 0,
        gridEntryBufferPercent: 0,
        gridTakeProfitLevels: 0,
        gridStopLossLevels: 0,
        gridTimeframe: "5m",
        activeGridState: {
            fingerprint: "DOGE/USDT:USDT|5m|1|12|0|180|5.51|0|0|0",
            lowerBound: 0.1,
            upperBound: 0.2
        }
    }, { doge: {} });

    assert.equal(result.config.activeGridState, null);
    assert.equal(result.changed, true);
});

test("resolveAdaptiveGridParameters expands range and reduces ladder density for larger order sizes", () => {
    const helpers = createGridRuntimeHelpers({
        getDb: () => ({
            pair: "BTC/USDT:USDT",
            leverage: 10,
            gridLevels: 0,
            gridOrdersPerSide: 0,
            gridOrderSizeUsdt: 25,
            gridRangePercent: 0,
            gridEntryBufferPercent: 0,
            gridLookbackCandles: 144,
            gridTakeProfitLevels: 0,
            gridStopLossLevels: 0,
            gridTimeframe: "5m",
            gridStopLossPercent: 6
        }),
        getExchange: () => ({ markets: { "BTC/USDT:USDT": { limits: { amount: { min: 0.001 }, cost: { min: 5 } } } } }),
        getBalanceCache: () => ({ totalUSDT: 1000, availableUSDT: 1000 }),
        getTickerCache: () => ({ price: 60000 }),
        getSaveDB: () => async () => {},
        defaultConfig: {
            volumePeriod: 20,
            atrPeriod: 14,
            gridLookbackCandles: 120,
            gridLevels: 8,
            gridTakeProfitLevels: 0,
            gridOrdersPerSide: 0,
            gridOrderSizeUsdt: 25,
            gridRangePercent: 3.5,
            gridEntryBufferPercent: 0.15,
            gridStopLossLevels: 0,
            gridStopLossPercent: 6,
            gridTimeframe: "5m"
        },
        validMarginModes: ["isolated", "cross"],
        normalizeSymbol: (symbol) => String(symbol || "").toUpperCase(),
        toFiniteNumber: (value, fallback) => {
            const numericValue = Number(value);
            return Number.isFinite(numericValue) ? numericValue : fallback;
        },
        clamp: (value, min, max) => Math.min(Math.max(value, min), max),
        formatPriceToMarketPrecision: (_pair, price) => Number(Number(price).toFixed(2)),
        formatAmountToMarketPrecision: (_pair, amount) => Number(Number(amount).toFixed(6)),
        validateOrderSize: () => ({ valid: true }),
        isDirectionalOrderPlanValid: () => true,
        getClosePositionSide: () => "BOTH",
        isHedgeModeEnabled: () => false,
        getActivePositionsList: () => [],
        getExchangePositionSide: (position) => position.side,
        gridClientOrderPrefix: "smartgrid",
        tpClientOrderPrefix: "smarttp",
        slClientOrderPrefix: "smartsl"
    });

    const snapshot = {
        currentPrice: 60000,
        currentATR: 900,
        close: [58200, 58700, 59000, 59400, 59800, 60200, 60100, 60600, 61100, 60800, 61200, 61800, 62100, 61700, 62300, 62800],
        high: [58400, 58900, 59200, 59600, 60000, 60400, 60300, 60800, 61300, 61000, 61400, 62000, 62300, 61900, 62500, 63000],
        low: [58000, 58500, 58800, 59200, 59600, 60000, 59900, 60400, 60900, 60600, 61000, 61600, 61900, 61500, 62100, 62600]
    };
    const baseParams = {
        gridLookbackCandles: 144,
        configuredGridLevels: 0,
        configuredGridRangePercent: 0,
        configuredGridEntryBufferPercent: 0,
        gridOrderSizeUsdt: 25,
        gridOrdersPerSide: 0,
        gridTakeProfitLevels: 0,
        gridStopLossLevels: 0
    };

    const smallOrder = helpers.resolveAdaptiveGridParameters({
        params: { ...baseParams, gridOrderSizeUsdt: 10 },
        snapshot,
        availableUsdt: 1000
    });
    const largeOrder = helpers.resolveAdaptiveGridParameters({
        params: { ...baseParams, gridOrderSizeUsdt: 120 },
        snapshot,
        availableUsdt: 1000
    });

    assert.equal(smallOrder.gridTakeProfitLevels, 1);
    assert.ok(smallOrder.gridRangePercent >= 2.5);
    assert.ok(smallOrder.gridLevels >= 6);
    assert.ok(largeOrder.gridRangePercent >= smallOrder.gridRangePercent);
    assert.ok(largeOrder.gridLevels <= smallOrder.gridLevels);
    assert.ok(largeOrder.gridOrdersPerSide <= smallOrder.gridOrdersPerSide);
});
