const test = require("node:test");
const assert = require("node:assert/strict");

const { createDashboardConfigHelpers } = require("../services/dashboard-config");

test("applyDashboardConfigUpdate persists full config changes before reloading runtime", async () => {
    const saveCalls = [];
    const reloadCalls = [];
    const runtimeDb = {
        id: 1,
        pair: "DOGE/USDT:USDT",
        gridLevels: 8,
        dailyPnL: 1.25,
        activePosition: null
    };

    const helpers = createDashboardConfigHelpers({
        getDb: () => runtimeDb,
        hasAnyActivePosition: () => false,
        protectedKeys: new Set(["pair"]),
        editableKeys: new Set(["pair", "gridLevels"]),
        getDefaultConfig: () => ({ pair: "DOGE/USDT:USDT", gridLevels: 8 }),
        saveDB: async (options) => { saveCalls.push(options || null); },
        reloadConfig: async (previousConfig) => { reloadCalls.push(previousConfig); },
        refreshRuntimeSchedulers: () => {},
        syncExchangeRuntimeSettings: async () => {},
        buildDashboardPayload: () => ({ pair: runtimeDb.pair, gridLevels: runtimeDb.gridLevels }),
        applyAutoPresetToConfig: (config) => ({ config })
    });

    const result = await helpers.applyDashboardConfigUpdate({
        pair: "BTC/USDT:USDT",
        gridLevels: 12
    });

    assert.deepEqual(saveCalls, [{ mode: "full" }]);
    assert.equal(reloadCalls.length, 1);
    assert.equal(reloadCalls[0].pair, "DOGE/USDT:USDT");
    assert.equal(runtimeDb.pair, "BTC/USDT:USDT");
    assert.equal(runtimeDb.gridLevels, 12);
    assert.deepEqual(result, { pair: "BTC/USDT:USDT", gridLevels: 12 });
});

test("applyDashboardConfigUpdate preserves activeGridState until runtime decides whether to rebuild it", async () => {
    const runtimeDb = {
        id: 1,
        pair: "DOGE/USDT:USDT",
        gridLevels: 8,
        trailingEnabled: true,
        dailyPnL: 1.25,
        activePosition: null,
        activeGridState: {
            fingerprint: "DOGE/USDT:USDT|5m|8|120|3.5|0|0",
            lowerBound: 0.1,
            upperBound: 0.2
        }
    };

    const helpers = createDashboardConfigHelpers({
        getDb: () => runtimeDb,
        hasAnyActivePosition: () => false,
        protectedKeys: new Set(["pair"]),
        editableKeys: new Set(["pair", "gridLevels", "trailingEnabled"]),
        getDefaultConfig: () => ({ pair: "DOGE/USDT:USDT", gridLevels: 8, trailingEnabled: true }),
        saveDB: async () => {},
        reloadConfig: async () => {},
        refreshRuntimeSchedulers: () => {},
        syncExchangeRuntimeSettings: async () => {},
        buildDashboardPayload: () => ({ activeGridState: runtimeDb.activeGridState }),
        applyAutoPresetToConfig: (config) => ({ config })
    });

    const result = await helpers.applyDashboardConfigUpdate({
        trailingEnabled: false
    });

    assert.deepEqual(runtimeDb.activeGridState, {
        fingerprint: "DOGE/USDT:USDT|5m|8|120|3.5|0|0",
        lowerBound: 0.1,
        upperBound: 0.2
    });
    assert.deepEqual(result, {
        activeGridState: {
            fingerprint: "DOGE/USDT:USDT|5m|8|120|3.5|0|0",
            lowerBound: 0.1,
            upperBound: 0.2
        }
    });
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
        getDefaultConfig: () => ({ pair: "DOGE/USDT:USDT", gridLevels: 8 }),
        saveDB: async (options) => { saveCalls.push(options || null); },
        reloadConfig: async (previousConfig) => { reloadCalls.push(previousConfig); },
        refreshRuntimeSchedulers: () => {},
        syncExchangeRuntimeSettings: async () => {},
        buildDashboardPayload: () => ({ pair: runtimeDb.pair, gridLevels: runtimeDb.gridLevels }),
        applyAutoPresetToConfig: (config) => ({ config })
    });

    const result = await helpers.resetDashboardConfig();

    assert.deepEqual(saveCalls, [{ mode: "full" }]);
    assert.equal(reloadCalls.length, 1);
    assert.equal(reloadCalls[0].pair, "BTC/USDT:USDT");
    assert.equal(runtimeDb.pair, "DOGE/USDT:USDT");
    assert.equal(runtimeDb.gridLevels, 8);
    assert.deepEqual(result, { pair: "DOGE/USDT:USDT", gridLevels: 8 });
});
