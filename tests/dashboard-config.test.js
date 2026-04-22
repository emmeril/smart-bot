const test = require("node:test");
const assert = require("node:assert/strict");

const { createDashboardConfigHelpers } = require("../services/dashboard-config");

test("applyDashboardConfigUpdate persists full config changes before reloading runtime", async () => {
    const saveCalls = [];
    const reloadCalls = [];
    const runtimeDb = {
        id: 1,
        pair: "DOGE/USDT",
        gridLevels: 8,
        dailyPnL: 1.25,
        activePosition: null
    };

    const helpers = createDashboardConfigHelpers({
        getDb: () => runtimeDb,
        hasAnyActivePosition: () => false,
        protectedKeys: new Set(["pair"]),
        editableKeys: new Set(["pair", "gridLevels"]),
        getDefaultConfig: () => ({ pair: "DOGE/USDT", gridLevels: 8 }),
        saveDB: async (options) => { saveCalls.push(options || null); },
        reloadConfig: async (previousConfig) => { reloadCalls.push(previousConfig); },
        refreshRuntimeSchedulers: () => {},
        syncExchangeRuntimeSettings: async () => {},
        resolveProtectedRuntimeConfigEligibility: async () => ({ canApply: true, reasons: [] }),
        buildDashboardPayload: () => ({ pair: runtimeDb.pair, gridLevels: runtimeDb.gridLevels }),
        applyAutoPresetToConfig: (config) => ({ config })
    });

    const result = await helpers.applyDashboardConfigUpdate({
        pair: "BTC/USDT:USDT",
        gridLevels: 12
    });

    assert.deepEqual(saveCalls, [{ mode: "full" }]);
    assert.equal(reloadCalls.length, 1);
    assert.equal(reloadCalls[0].pair, "DOGE/USDT");
    assert.equal(runtimeDb.pair, "BTC/USDT:USDT");
    assert.equal(runtimeDb.gridLevels, 12);
    assert.equal(result.pair, "BTC/USDT:USDT");
    assert.equal(result.gridLevels, 12);
    assert.deepEqual(result.deferredProtectedKeys, []);
});

test("applyDashboardConfigUpdate preserves activeGridState until runtime decides whether to rebuild it", async () => {
    const runtimeDb = {
        id: 1,
        pair: "DOGE/USDT",
        gridLevels: 8,
        trailingEnabled: true,
        dailyPnL: 1.25,
        activePosition: null,
        activeGridState: {
            fingerprint: "DOGE/USDT|5m|8|120|3.5|0|0",
            lowerBound: 0.1,
            upperBound: 0.2
        }
    };

    const helpers = createDashboardConfigHelpers({
        getDb: () => runtimeDb,
        hasAnyActivePosition: () => false,
        protectedKeys: new Set(["pair"]),
        editableKeys: new Set(["pair", "gridLevels", "trailingEnabled"]),
        getDefaultConfig: () => ({ pair: "DOGE/USDT", gridLevels: 8, trailingEnabled: true }),
        saveDB: async () => {},
        reloadConfig: async () => {},
        refreshRuntimeSchedulers: () => {},
        syncExchangeRuntimeSettings: async () => {},
        resolveProtectedRuntimeConfigEligibility: async () => ({ canApply: true, reasons: [] }),
        buildDashboardPayload: () => ({ activeGridState: runtimeDb.activeGridState }),
        applyAutoPresetToConfig: (config) => ({ config })
    });

    const result = await helpers.applyDashboardConfigUpdate({
        trailingEnabled: false
    });

    assert.deepEqual(runtimeDb.activeGridState, {
        fingerprint: "DOGE/USDT|5m|8|120|3.5|0|0",
        lowerBound: 0.1,
        upperBound: 0.2
    });
    assert.deepEqual(result.activeGridState, {
        fingerprint: "DOGE/USDT|5m|8|120|3.5|0|0",
        lowerBound: 0.1,
        upperBound: 0.2
    });
    assert.deepEqual(result.deferredProtectedKeys, []);
});

test("resetDashboardConfig persists full config changes before reloading runtime", async () => {
    const saveCalls = [];
    const reloadCalls = [];
    const runtimeDb = {
        id: 1,
        pair: "BTC/USDT:USDT",
        gridLevels: 12,
        dailyPnL: 4,
        activePosition: null
    };

    const helpers = createDashboardConfigHelpers({
        getDb: () => runtimeDb,
        hasAnyActivePosition: () => false,
        protectedKeys: new Set(["pair"]),
        editableKeys: new Set(["pair", "gridLevels"]),
        getDefaultConfig: () => ({ pair: "DOGE/USDT", gridLevels: 8 }),
        saveDB: async (options) => { saveCalls.push(options || null); },
        reloadConfig: async (previousConfig) => { reloadCalls.push(previousConfig); },
        refreshRuntimeSchedulers: () => {},
        syncExchangeRuntimeSettings: async () => {},
        resolveProtectedRuntimeConfigEligibility: async () => ({ canApply: true, reasons: [] }),
        buildDashboardPayload: () => ({ pair: runtimeDb.pair, gridLevels: runtimeDb.gridLevels }),
        applyAutoPresetToConfig: (config) => ({ config })
    });

    const result = await helpers.resetDashboardConfig();

    assert.deepEqual(saveCalls, [{ mode: "full" }]);
    assert.equal(reloadCalls.length, 1);
    assert.equal(reloadCalls[0].pair, "BTC/USDT:USDT");
    assert.equal(runtimeDb.pair, "DOGE/USDT");
    assert.equal(runtimeDb.gridLevels, 8);
    assert.deepEqual(result, { pair: "DOGE/USDT", gridLevels: 8 });
});

test("applyDashboardConfigUpdate serializes concurrent updates", async () => {
    const runtimeDb = {
        id: 1,
        pair: "DOGE/USDT",
        gridLevels: 8,
        dailyPnL: 0,
        activePosition: null
    };
    const saveCalls = [];
    let releaseFirstSave;
    let firstSavePending = true;

    const helpers = createDashboardConfigHelpers({
        getDb: () => runtimeDb,
        hasAnyActivePosition: () => false,
        protectedKeys: new Set(["pair"]),
        editableKeys: new Set(["pair", "gridLevels"]),
        getDefaultConfig: () => ({ pair: "DOGE/USDT", gridLevels: 8 }),
        saveDB: async (options) => {
            saveCalls.push({ options, snapshot: { ...runtimeDb } });
            if (!firstSavePending) return;
            firstSavePending = false;
            await new Promise((resolve) => { releaseFirstSave = resolve; });
        },
        reloadConfig: async () => {},
        refreshRuntimeSchedulers: () => {},
        syncExchangeRuntimeSettings: async () => {},
        resolveProtectedRuntimeConfigEligibility: async () => ({ canApply: true, reasons: [] }),
        buildDashboardPayload: () => ({ pair: runtimeDb.pair, gridLevels: runtimeDb.gridLevels }),
        applyAutoPresetToConfig: (config) => ({ config })
    });

    const firstUpdate = helpers.applyDashboardConfigUpdate({ pair: "BTC/USDT:USDT" });
    await new Promise((resolve) => setImmediate(resolve));
    const secondUpdate = helpers.applyDashboardConfigUpdate({ gridLevels: 12 });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(saveCalls.length, 1);
    assert.equal(saveCalls[0].snapshot.pair, "BTC/USDT:USDT");
    assert.equal(saveCalls[0].snapshot.gridLevels, 8);

    releaseFirstSave();
    const firstResult = await firstUpdate;
    const secondResult = await secondUpdate;

    assert.equal(saveCalls.length, 2);
    assert.equal(saveCalls[1].snapshot.pair, "BTC/USDT:USDT");
    assert.equal(saveCalls[1].snapshot.gridLevels, 12);
    assert.equal(firstResult.pair, "BTC/USDT:USDT");
    assert.equal(firstResult.gridLevels, 8);
    assert.deepEqual(firstResult.deferredProtectedKeys, []);
    assert.equal(secondResult.pair, "BTC/USDT:USDT");
    assert.equal(secondResult.gridLevels, 12);
    assert.deepEqual(secondResult.deferredProtectedKeys, []);
    assert.equal(runtimeDb.pair, "BTC/USDT:USDT");
    assert.equal(runtimeDb.gridLevels, 12);
});

test("applyDashboardConfigUpdate defers protected runtime keys while positions are active", async () => {
    const runtimeDb = {
        id: 1,
        pair: "DOGE/USDT",
        leverage: 8,
        gridLevels: 8,
        pendingRuntimeConfig: null,
        dailyPnL: 0,
        activePosition: { BOTH: { side: "buy", quantity: 10 } }
    };

    const helpers = createDashboardConfigHelpers({
        getDb: () => runtimeDb,
        hasAnyActivePosition: () => true,
        protectedKeys: new Set(["pair", "leverage"]),
        editableKeys: new Set(["pair", "leverage", "gridLevels"]),
        getDefaultConfig: () => ({ pair: "DOGE/USDT", leverage: 8, gridLevels: 8 }),
        saveDB: async () => {},
        reloadConfig: async () => {},
        refreshRuntimeSchedulers: () => {},
        syncExchangeRuntimeSettings: async () => {},
        resolveProtectedRuntimeConfigEligibility: async () => ({ canApply: false, reasons: ["EXCHANGE_ACTIVE_POSITION"] }),
        buildDashboardPayload: () => ({
            config: runtimeDb.pendingRuntimeConfig ? { ...runtimeDb, ...runtimeDb.pendingRuntimeConfig } : { ...runtimeDb },
            status: { pendingRuntimeConfig: runtimeDb.pendingRuntimeConfig }
        }),
        applyAutoPresetToConfig: (config) => ({ config })
    });

    const result = await helpers.applyDashboardConfigUpdate({
        pair: "BTC/USDT:USDT",
        leverage: 12,
        gridLevels: 10
    });

    assert.equal(runtimeDb.pair, "DOGE/USDT");
    assert.equal(runtimeDb.leverage, 8);
    assert.equal(runtimeDb.gridLevels, 10);
    assert.deepEqual(runtimeDb.pendingRuntimeConfig, { pair: "BTC/USDT:USDT", leverage: 12 });
    assert.deepEqual(result.deferredProtectedKeys, ["pair", "leverage"]);
    assert.deepEqual(result.status.pendingRuntimeConfig, { pair: "BTC/USDT:USDT", leverage: 12 });
});
