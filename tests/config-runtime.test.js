const test = require("node:test");
const assert = require("node:assert/strict");

const { createConfigRuntimeHelpers } = require("../services/config-runtime");

test("saveDB preserves externally updated editable config during runtime state persistence", async () => {
    const persistedWrites = [];
    const runtimeDb = {
        id: 1,
        pair: "DOGE/USDT:USDT",
        gridLevels: 8,
        dailyPnL: 2.5,
        activePosition: { BOTH: { side: "buy", quantity: 10 } }
    };
    const persistedConfig = {
        id: 1,
        pair: "BTC/USDT:USDT",
        gridLevels: 12,
        dailyPnL: 1.25,
        activePosition: null
    };

    const helpers = createConfigRuntimeHelpers({
        getDb: () => runtimeDb,
        setDb: () => {},
        getIsShuttingDown: () => false,
        getIsProcessing: () => false,
        hasRuntimePositionMutationInFlight: () => false,
        getConfigReloadTimer: () => null,
        setConfigReloadTimer: () => {},
        loadPersistedConfig: async () => ({ ...persistedConfig }),
        ensureConfigRow: async () => null,
        persistConfig: async (config) => { persistedWrites.push({ ...config }); },
        ensureConfigSchema: async () => {},
        applyAutoPresetToConfig: (config) => ({ config, autoPresetResult: { changed: false, presetName: null } }),
        hydrateConfig: (config) => config,
        mergeRuntimeConfig: () => {},
        applyRuntimeConfigChanges: async () => false,
        hasAnyActivePosition: () => false,
        dashboardEditableFields: [
            { key: "pair" },
            { key: "gridLevels" }
        ],
        configAutoReloadIntervalMs: 5000
    });

    await helpers.saveDB();

    assert.equal(persistedWrites.length, 1);
    assert.equal(persistedWrites[0].pair, "BTC/USDT:USDT");
    assert.equal(persistedWrites[0].gridLevels, 12);
    assert.equal(persistedWrites[0].dailyPnL, 2.5);
    assert.deepEqual(persistedWrites[0].activePosition, runtimeDb.activePosition);
    assert.equal(runtimeDb.pair, "DOGE/USDT:USDT");
});

test("saveDB full mode persists in-memory editable config changes", async () => {
    const persistedWrites = [];
    const runtimeDb = {
        id: 1,
        pair: "ETH/USDT:USDT",
        gridLevels: 6,
        dailyPnL: 0.5
    };

    const helpers = createConfigRuntimeHelpers({
        getDb: () => runtimeDb,
        setDb: () => {},
        getIsShuttingDown: () => false,
        getIsProcessing: () => false,
        hasRuntimePositionMutationInFlight: () => false,
        getConfigReloadTimer: () => null,
        setConfigReloadTimer: () => {},
        loadPersistedConfig: async () => ({
            id: 1,
            pair: "DOGE/USDT:USDT",
            gridLevels: 12,
            dailyPnL: 0.1
        }),
        ensureConfigRow: async () => null,
        persistConfig: async (config) => { persistedWrites.push({ ...config }); },
        ensureConfigSchema: async () => {},
        applyAutoPresetToConfig: (config) => ({ config, autoPresetResult: { changed: false, presetName: null } }),
        hydrateConfig: (config) => config,
        mergeRuntimeConfig: () => {},
        applyRuntimeConfigChanges: async () => false,
        hasAnyActivePosition: () => false,
        dashboardEditableFields: [
            { key: "pair" },
            { key: "gridLevels" }
        ],
        configAutoReloadIntervalMs: 5000
    });

    await helpers.saveDB({ mode: "full" });

    assert.equal(persistedWrites.length, 1);
    assert.equal(persistedWrites[0].pair, "ETH/USDT:USDT");
    assert.equal(persistedWrites[0].gridLevels, 6);
    assert.equal(persistedWrites[0].dailyPnL, 0.5);
});
