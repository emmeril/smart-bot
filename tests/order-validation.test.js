const test = require("node:test");
const assert = require("node:assert/strict");

const { createOrderValidationHelpers } = require("../services/order-validation");

const helpers = createOrderValidationHelpers({
    toFiniteNumber: (value, fallback = NaN) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }
});

const createMarket = () => ({
    limits: {
        amount: { min: 1, max: 100 },
        price: { min: 0.1, max: 10 },
        cost: { min: 5, max: 500 }
    },
    info: {
        filters: [
            { filterType: "PRICE_FILTER", minPrice: "0.10000000", maxPrice: "10.00000000", tickSize: "0.10000000" },
            { filterType: "LOT_SIZE", minQty: "1.00000000", maxQty: "100.00000000", stepSize: "0.50000000" },
            { filterType: "MIN_NOTIONAL", minNotional: "5.00000000", applyToMarket: true, avgPriceMins: 5 },
            { filterType: "NOTIONAL", minNotional: "5.00000000", maxNotional: "500.00000000" },
            { filterType: "MARKET_LOT_SIZE", minQty: "2.00000000", maxQty: "50.00000000", stepSize: "1.00000000" }
        ]
    }
});

test("validateOrderSize accepts Binance filter-aligned limit orders", () => {
    const result = helpers.validateOrderSize(createMarket(), 2.5, 2.0, { orderType: "LIMIT" });
    assert.equal(result.valid, true);
});

test("validateOrderSize rejects PRICE_FILTER tick violations", () => {
    const result = helpers.validateOrderSize(createMarket(), 2.5, 2.05, { orderType: "LIMIT" });
    assert.equal(result.valid, false);
    assert.match(result.reason, /PRICE_FILTER tickSize/);
});

test("validateOrderSize rejects LOT_SIZE step and max violations", () => {
    const stepResult = helpers.validateOrderSize(createMarket(), 2.25, 2.0, { orderType: "LIMIT" });
    assert.equal(stepResult.valid, false);
    assert.match(stepResult.reason, /LOT_SIZE stepSize/);

    const maxResult = helpers.validateOrderSize(createMarket(), 101, 5.0, { orderType: "LIMIT" });
    assert.equal(maxResult.valid, false);
    assert.match(maxResult.reason, /above exchange maximum/);
});

test("validateOrderSize rejects MIN_NOTIONAL and NOTIONAL max violations", () => {
    const minResult = helpers.validateOrderSize(createMarket(), 1, 2.0, { orderType: "LIMIT" });
    assert.equal(minResult.valid, false);
    assert.match(minResult.reason, /below exchange minimum 5/);

    const maxResult = helpers.validateOrderSize(createMarket(), 60, 9.0, { orderType: "LIMIT" });
    assert.equal(maxResult.valid, false);
    assert.match(maxResult.reason, /above exchange maximum 500/);
});

test("validateOrderSize applies MARKET_LOT_SIZE only to market orders", () => {
    const limitResult = helpers.validateOrderSize(createMarket(), 1.5, 4.0, { orderType: "LIMIT" });
    assert.equal(limitResult.valid, true);

    const marketResult = helpers.validateOrderSize(createMarket(), 1.5, 4.0, { orderType: "MARKET" });
    assert.equal(marketResult.valid, false);
    assert.match(marketResult.reason, /MARKET_LOT_SIZE/);
});
