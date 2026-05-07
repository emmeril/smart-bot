const test = require("node:test");
const assert = require("node:assert/strict");

const { createGridRuntimeHelpers } = require("../services/grid-runtime");

test("filterGridOrdersForActiveExposure keeps only the active side in one-way mode", () => {
    const helpers = createGridRuntimeHelpers({
        getDb: () => ({
            pair: "DOGE/USDT:USDT",
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
    }), 13);

    assert.equal(helpers.resolveEffectiveGridLevels({
        configuredGridLevels: 0,
        pair: "DOGE/USDT:USDT",
        gridTimeframe: "1h",
        gridRangePercent: 2.0,
        gridLookbackCandles: 60
    }), 6);

    assert.equal(helpers.resolveEffectiveGridLevels({
        configuredGridLevels: 0,
        pair: "BTC/USDT:USDT",
        gridTimeframe: "1h",
        gridRangePercent: 6.5,
        gridLookbackCandles: 180
    }), 10);
});

test("resolveEffectiveGridRangePercent and entry buffer use universal normalized scaling", () => {
    const helpers = createGridRuntimeHelpers({
        getDb: () => ({
            pair: "DOGE/USDT:USDT",
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
    }), 4.49);

    assert.equal(helpers.resolveEffectiveGridRangePercent({
        configuredGridRangePercent: 0,
        pair: "BTC/USDT:USDT",
        gridTimeframe: "5m",
        gridLookbackCandles: 120
    }), 4.05);

    assert.equal(helpers.resolveEffectiveGridEntryBufferPercent({
        configuredGridEntryBufferPercent: 0,
        pair: "DOGE/USDT:USDT",
        gridTimeframe: "5m",
        gridRangePercent: 4.49,
        gridLevels: 12
    }), 0.116);
});

test("buildGridEntryOrders honors buy and sell grid toggles", () => {
    const helpers = createGridRuntimeHelpers({
        getDb: () => ({
            pair: "DOGE/USDT",
            gridLevels: 4,
            gridOrdersPerSide: 2,
            gridOrderSizeUsdt: 5,
            allowLong: true,
            allowShort: false
        }),
        getExchange: () => ({ markets: { "DOGE/USDT": {} } }),
        getBalanceCache: () => ({ totalUSDT: 100, availableUSDT: 100 }),
        getTickerCache: () => ({ price: 100 }),
        getSaveDB: () => async () => {},
        defaultConfig: {
            volumePeriod: 20,
            atrPeriod: 14,
            gridLookbackCandles: 20,
            gridLevels: 4,
            gridTakeProfitLevels: 0,
            gridOrdersPerSide: 2,
            gridOrderSizeUsdt: 5,
            gridRangePercent: 4,
            gridEntryBufferPercent: 0.1,
            gridStopLossLevels: 0
        },
        validMarginModes: ["spot"],
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
        gridClientOrderPrefix: "smartgrid",
        tpClientOrderPrefix: "smarttp",
        slClientOrderPrefix: "smartsl"
    });

    const params = {
        configuredGridLevels: 4,
        configuredGridRangePercent: 4,
        configuredGridEntryBufferPercent: 0.1,
        gridLookbackCandles: 20,
        gridRangePercent: 4,
        gridLevels: 4,
        gridEntryBufferPercent: 0.1,
        gridOrderSizeUsdt: 5,
        gridOrdersPerSide: 2,
        gridTakeProfitLevels: 0,
        gridStopLossLevels: 0
    };
    const gridState = {
        lowerBound: 96,
        upperBound: 104,
        referencePrice: 100,
        levels: [96, 98, 100, 102, 104],
        step: 2,
        fingerprint: helpers.getGridStateFingerprint(params)
    };

    const orders = helpers.buildGridEntryOrders(
        { currentPrice: 100, currentATR: 1 },
        params,
        gridState
    );

    assert.ok(orders.length > 0);
    assert.ok(orders.every((order) => order.side === "buy"));
});

test("applyAutoPairGridPreset clears stale activeGridState when fingerprint only matches by substring", () => {
    const helpers = createGridRuntimeHelpers({
        getDb: () => ({
            pair: "DOGE/USDT:USDT",
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
        strategy: "spot_grid",
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
    }, { universal: {} });

    assert.equal(result.config.activeGridState, null);
    assert.equal(result.changed, true);
});
