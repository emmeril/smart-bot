const test = require("node:test");
const assert = require("node:assert/strict");

const { createRuntimeUtils } = require("../services/runtime-utils");

const createHelpers = () => createRuntimeUtils({
    getExchangeHealth: () => ({
        isHealthy: true,
        needsRecoverySync: false,
        consecutiveFailures: 0,
        lastFailureAt: 0,
        lastRecoveryAt: 0,
        lastError: "",
        lastContext: ""
    }),
    getLastRecoveryBlockLogAt: () => 0,
    setLastRecoveryBlockLogAt: () => {},
    getIsPlacingOrder: () => false,
    getIsClosingPosition: () => false,
    getIsSyncingPosition: () => false
});

test("retry retries Binance 429 responses without ignoring rate-limit classification", async () => {
    const helpers = createHelpers();
    let calls = 0;
    const result = await helpers.retry(async () => {
        calls += 1;
        if (calls === 1) {
            const error = new Error('binance {"code":-1003,"msg":"Too much request weight used"}');
            error.status = 429;
            throw error;
        }
        return "ok";
    }, 2, 1);

    assert.equal(result, "ok");
    assert.equal(calls, 2);
});

test("retry stops immediately on Binance 418 IP ban responses", async () => {
    const helpers = createHelpers();
    let calls = 0;
    await assert.rejects(
        helpers.retry(async () => {
            calls += 1;
            const error = new Error("IP banned");
            error.status = 418;
            error.headers = { "Retry-After": "120" };
            throw error;
        }, 3, 1),
        /Binance IP ban response/
    );
    assert.equal(calls, 1);
});
