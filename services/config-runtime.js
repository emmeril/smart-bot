const createConfigRuntimeHelpers = ({
    getDb,
    setDb,
    getIsShuttingDown,
    getIsProcessing,
    hasRuntimePositionMutationInFlight,
    getConfigReloadTimer,
    setConfigReloadTimer,
    loadPersistedConfig,
    ensureConfigRow,
    persistConfig,
    ensureConfigSchema,
    applyAutoPresetToConfig,
    hydrateConfig,
    mergeRuntimeConfig,
    applyRuntimeConfigChanges,
    hasAnyActivePosition,
    dashboardEditableFields,
    configAutoReloadIntervalMs
}) => {
    let lastKnownDashboardConfigSignature = "";
    const editableKeys = dashboardEditableFields.map((field) => field.key);

    const buildDashboardConfigSignature = (config) => JSON.stringify(
        dashboardEditableFields.map((field) => [field.key, config && Object.prototype.hasOwnProperty.call(config, field.key) ? config[field.key] : null])
    );

    const syncDashboardConfigSignature = (config = getDb()) => {
        lastKnownDashboardConfigSignature = buildDashboardConfigSignature(config || {});
        return lastKnownDashboardConfigSignature;
    };

    const buildPersistableConfig = async (options = {}) => {
        const db = getDb();
        if (!db) return null;
        const mode = String(options?.mode || "runtime").toLowerCase();
        if (mode === "full") return db;

        const persistedConfig = await loadPersistedConfig();
        if (!persistedConfig || typeof persistedConfig !== "object") return db;

        const mergedConfig = { ...db };
        for (const key of editableKeys) {
            if (Object.prototype.hasOwnProperty.call(persistedConfig, key)) {
                mergedConfig[key] = persistedConfig[key];
            }
        }
        return mergedConfig;
    };

    const saveDB = async (options = {}) => {
        try {
            const configToPersist = await buildPersistableConfig(options);
            if (!configToPersist) return;
            await persistConfig(configToPersist);
            syncDashboardConfigSignature(configToPersist);
        } catch (error) {
            console.error("[ERROR] Failed to save DB:", error.message);
        }
    };

    const initializeDB = async () => {
        try {
            await ensureConfigSchema();
            console.log("[OK] Database synced");
            const configRow = await ensureConfigRow();
            const persisted = configRow.toJSON();
            const { config: hydratedConfig, autoPresetResult } = applyAutoPresetToConfig(hydrateConfig(persisted));
            setDb(hydratedConfig);
            syncDashboardConfigSignature();
            if (autoPresetResult.changed) {
                await saveDB();
                console.log(`[PRESET] Auto-applied ${autoPresetResult.presetName} profile for ${getDb().pair}`);
            }
            console.log("[OK] DB initialized successfully");
            return true;
        } catch (error) {
            console.error("[ERROR] Error initializing DB:", error.message);
            setDb(null);
            return false;
        }
    };

    const reloadConfig = async (previousRuntimeConfig = null) => {
        try {
            const db = getDb();
            if (!db) return false;
            const runtimeSnapshot = previousRuntimeConfig && typeof previousRuntimeConfig === "object"
                ? { ...previousRuntimeConfig }
                : { ...db };
            const persistedConfig = await loadPersistedConfig();
            if (!persistedConfig) return false;
            const { config: normalizedConfig, autoPresetResult } = applyAutoPresetToConfig(persistedConfig);
            mergeRuntimeConfig(normalizedConfig);
            await applyRuntimeConfigChanges(runtimeSnapshot);
            syncDashboardConfigSignature();
            if (autoPresetResult.changed && !hasAnyActivePosition()) {
                await saveDB();
                console.log(`[PRESET] Auto-refreshed ${autoPresetResult.presetName} profile for ${getDb().pair}`);
            }
            return true;
        } catch (error) {
            console.error("[ERROR] Failed to reload config:", error.message);
            return false;
        }
    };

    const reloadConfigIfChanged = async () => {
        if (!getDb() || getIsShuttingDown()) return false;
        try {
            const persistedConfig = await loadPersistedConfig();
            if (!persistedConfig) return false;
            const persistedSignature = buildDashboardConfigSignature(persistedConfig);
            if (persistedSignature === lastKnownDashboardConfigSignature) return false;
            console.log("[CONFIG] Detected dashboard config change. Reloading...");
            const reloaded = await reloadConfig();
            if (reloaded) syncDashboardConfigSignature();
            return reloaded;
        } catch (error) {
            console.error("[ERROR] Auto config reload failed:", error.message);
            return false;
        }
    };

    const startConfigAutoReload = () => {
        if (getConfigReloadTimer()) return;
        const timer = setInterval(async () => {
            if (getIsShuttingDown() || getIsProcessing() || hasRuntimePositionMutationInFlight()) return;
            await reloadConfigIfChanged();
        }, configAutoReloadIntervalMs);
        setConfigReloadTimer(timer);
    };

    return {
        buildDashboardConfigSignature,
        syncDashboardConfigSignature,
        buildPersistableConfig,
        saveDB,
        initializeDB,
        reloadConfig,
        reloadConfigIfChanged,
        startConfigAutoReload
    };
};

module.exports = { createConfigRuntimeHelpers };
