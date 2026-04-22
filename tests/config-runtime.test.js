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

test("initializeDB persists auto preset changes with full save mode", async () => {
    const persistedWrites = [];
    let runtimeDb = null;

    const helpers = createConfigRuntimeHelpers({
        getDb: () => runtimeDb,
        setDb: (value) => { runtimeDb = value; },
        getIsShuttingDown: () => false,
        getIsProcessing: () => false,
        hasRuntimePositionMutationInFlight: () => false,
        getConfigReloadTimer: () => null,
        setConfigReloadTimer: () => {},
        loadPersistedConfig: async () => null,
        ensureConfigRow: async () => ({
            toJSON: () => ({
                id: 1,
                pair: "DOGE/USDT:USDT",
                gridLevels: 8
            })
        }),
        persistConfig: async (config) => { persistedWrites.push({ ...config }); },
        ensureConfigSchema: async () => {},
        applyAutoPresetToConfig: (config) => ({
            config: { ...config, pair: "BTC/USDT:USDT", gridLevels: 12 },
            autoPresetResult: { changed: true, presetName: "binance" }
        }),
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

    const initialized = await helpers.initializeDB();

    assert.equal(initialized, true);
    assert.equal(persistedWrites.length, 1);
    assert.equal(persistedWrites[0].pair, "BTC/USDT:USDT");
    assert.equal(persistedWrites[0].gridLevels, 12);
});

test("reloadConfig persists auto preset changes with full save mode when runtime is idle", async () => {
    const persistedWrites = [];
    const runtimeDb = {
        id: 1,
        pair: "DOGE/USDT:USDT",
        gridLevels: 8,
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
            gridLevels: 8,
            dailyPnL: 0.1
        }),
        ensureConfigRow: async () => null,
        persistConfig: async (config) => { persistedWrites.push({ ...config }); },
        ensureConfigSchema: async () => {},
        applyAutoPresetToConfig: (config) => ({
            config: { ...config, pair: "BTC/USDT:USDT", gridLevels: 14, dailyPnL: 0.1 },
            autoPresetResult: { changed: true, presetName: "binance" }
        }),
        hydrateConfig: (config) => config,
        mergeRuntimeConfig: (nextConfig) => { Object.assign(runtimeDb, nextConfig); },
        applyRuntimeConfigChanges: async () => false,
        hasAnyActivePosition: () => false,
        dashboardEditableFields: [
            { key: "pair" },
            { key: "gridLevels" }
        ],
        configAutoReloadIntervalMs: 5000
    });

    const reloaded = await helpers.reloadConfig({ ...runtimeDb });

    assert.equal(reloaded, true);
    assert.equal(persistedWrites.length, 1);
    assert.equal(persistedWrites[0].pair, "BTC/USDT:USDT");
    assert.equal(persistedWrites[0].gridLevels, 14);
});

test("startConfigAutoReload watches the config store and hot-reloads changes immediately", async () => {
    const persistedWrites = [];
    const runtimeDb = {
        id: 1,
        pair: "DOGE/USDT:USDT",
        gridLevels: 8,
        dailyPnL: 0.5
    };
    let configReloadTimer = null;
    let configReloadRetryTimer = null;
    let configReloadWatcher = null;
    let watchCallback = null;
    let hotReloadApplied = 0;

    const helpers = createConfigRuntimeHelpers({
        getDb: () => runtimeDb,
        setDb: () => {},
        getIsShuttingDown: () => false,
        getIsProcessing: () => false,
        hasRuntimePositionMutationInFlight: () => false,
        getConfigReloadTimer: () => configReloadTimer,
        setConfigReloadTimer: (value) => { configReloadTimer = value; },
        getConfigReloadRetryTimer: () => configReloadRetryTimer,
        setConfigReloadRetryTimer: (value) => { configReloadRetryTimer = value; },
        getConfigReloadWatcher: () => configReloadWatcher,
        setConfigReloadWatcher: (value) => { configReloadWatcher = value; },
        loadPersistedConfig: async () => ({
            id: 1,
            pair: "BTC/USDT:USDT",
            gridLevels: 12,
            dailyPnL: 0.5
        }),
        ensureConfigRow: async () => null,
        persistConfig: async (config) => { persistedWrites.push({ ...config }); },
        ensureConfigSchema: async () => {},
        applyAutoPresetToConfig: (config) => ({ config, autoPresetResult: { changed: false, presetName: null } }),
        hydrateConfig: (config) => config,
        mergeRuntimeConfig: (nextConfig) => { Object.assign(runtimeDb, nextConfig); },
        applyRuntimeConfigChanges: async () => false,
        hasAnyActivePosition: () => false,
        dashboardEditableFields: [
            { key: "pair" },
            { key: "gridLevels" }
        ],
        configAutoReloadIntervalMs: 5000,
        configAutoReloadFilePath: "database.sqlite",
        onHotReloadApplied: async () => { hotReloadApplied += 1; },
        watchConfigFile: (_filePath, _options, callback) => {
            watchCallback = callback;
            return { close: () => {} };
        }
    });

    helpers.syncDashboardConfigSignature(runtimeDb);
    helpers.startConfigAutoReload();
    watchCallback("change", "database.sqlite");
    await new Promise((resolve) => setTimeout(resolve, 20));

    clearInterval(configReloadTimer);
    if (configReloadRetryTimer) clearTimeout(configReloadRetryTimer);

    assert.ok(configReloadWatcher);
    assert.equal(runtimeDb.pair, "BTC/USDT:USDT");
    assert.equal(runtimeDb.gridLevels, 12);
    assert.equal(hotReloadApplied, 1);
    assert.equal(persistedWrites.length, 0);
});

test("scheduleConfigReloadCheck retries while runtime position mutation is busy", async () => {
    const runtimeDb = {
        id: 1,
        pair: "DOGE/USDT:USDT",
        gridLevels: 8
    };
    let mutationInFlight = true;
    let configReloadRetryTimer = null;
    let hotReloadApplied = 0;

    const helpers = createConfigRuntimeHelpers({
        getDb: () => runtimeDb,
        setDb: () => {},
        getIsShuttingDown: () => false,
        getIsProcessing: () => true,
        hasRuntimePositionMutationInFlight: () => mutationInFlight,
        getConfigReloadTimer: () => null,
        setConfigReloadTimer: () => {},
        getConfigReloadRetryTimer: () => configReloadRetryTimer,
        setConfigReloadRetryTimer: (value) => { configReloadRetryTimer = value; },
        getConfigReloadWatcher: () => null,
        setConfigReloadWatcher: () => {},
        loadPersistedConfig: async () => ({
            id: 1,
            pair: "ETH/USDT:USDT",
            gridLevels: 10
        }),
        ensureConfigRow: async () => null,
        persistConfig: async () => {},
        ensureConfigSchema: async () => {},
        applyAutoPresetToConfig: (config) => ({ config, autoPresetResult: { changed: false, presetName: null } }),
        hydrateConfig: (config) => config,
        mergeRuntimeConfig: (nextConfig) => { Object.assign(runtimeDb, nextConfig); },
        applyRuntimeConfigChanges: async () => false,
        hasAnyActivePosition: () => false,
        dashboardEditableFields: [
            { key: "pair" },
            { key: "gridLevels" }
        ],
        configAutoReloadIntervalMs: 5000,
        onHotReloadApplied: async () => { hotReloadApplied += 1; }
    });

    helpers.syncDashboardConfigSignature(runtimeDb);
    helpers.scheduleConfigReloadCheck("test");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runtimeDb.pair, "DOGE/USDT:USDT");

    mutationInFlight = false;
    await new Promise((resolve) => setTimeout(resolve, 140));

    if (configReloadRetryTimer) clearTimeout(configReloadRetryTimer);

    assert.equal(runtimeDb.pair, "ETH/USDT:USDT");
    assert.equal(runtimeDb.gridLevels, 10);
    assert.equal(hotReloadApplied, 1);
});

test("scheduleConfigReloadCheck does not wait for generic processing when no mutation is active", async () => {
    const runtimeDb = {
        id: 1,
        pair: "DOGE/USDT:USDT",
        gridLevels: 8
    };
    let configReloadRetryTimer = null;
    let hotReloadApplied = 0;

    const helpers = createConfigRuntimeHelpers({
        getDb: () => runtimeDb,
        setDb: () => {},
        getIsShuttingDown: () => false,
        getIsProcessing: () => true,
        hasRuntimePositionMutationInFlight: () => false,
        getConfigReloadTimer: () => null,
        setConfigReloadTimer: () => {},
        getConfigReloadRetryTimer: () => configReloadRetryTimer,
        setConfigReloadRetryTimer: (value) => { configReloadRetryTimer = value; },
        getConfigReloadWatcher: () => null,
        setConfigReloadWatcher: () => {},
        loadPersistedConfig: async () => ({
            id: 1,
            pair: "SOL/USDT:USDT",
            gridLevels: 16
        }),
        ensureConfigRow: async () => null,
        persistConfig: async () => {},
        ensureConfigSchema: async () => {},
        applyAutoPresetToConfig: (config) => ({ config, autoPresetResult: { changed: false, presetName: null } }),
        hydrateConfig: (config) => config,
        mergeRuntimeConfig: (nextConfig) => { Object.assign(runtimeDb, nextConfig); },
        applyRuntimeConfigChanges: async () => false,
        hasAnyActivePosition: () => false,
        dashboardEditableFields: [
            { key: "pair" },
            { key: "gridLevels" }
        ],
        configAutoReloadIntervalMs: 5000,
        onHotReloadApplied: async () => { hotReloadApplied += 1; }
    });

    helpers.syncDashboardConfigSignature(runtimeDb);
    helpers.scheduleConfigReloadCheck("test");
    await new Promise((resolve) => setTimeout(resolve, 20));

    if (configReloadRetryTimer) clearTimeout(configReloadRetryTimer);

    assert.equal(runtimeDb.pair, "SOL/USDT:USDT");
    assert.equal(runtimeDb.gridLevels, 16);
    assert.equal(hotReloadApplied, 1);
});
