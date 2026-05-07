const test = require("node:test");
const assert = require("node:assert/strict");

const { createRuntimeExchangeUtils } = require("../services/runtime-exchange-utils");

const helpers = createRuntimeExchangeUtils({
    toFiniteNumber: (value, fallback = NaN) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }
});

test("isDuplicateClientOrderIdError recognizes Binance Spot duplicate order response", () => {
    const error = new Error('binance {"code":-2010,"msg":"Duplicate order sent."}');
    assert.equal(helpers.isDuplicateClientOrderIdError(error), true);
});

test("isDuplicateClientOrderIdError preserves existing duplicated-message detection", () => {
    const error = new Error("clientOrderId is duplicated");
    assert.equal(helpers.isDuplicateClientOrderIdError(error), true);
});
