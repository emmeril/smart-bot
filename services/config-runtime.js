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
    let configOperationChain = Promise.resolve();

    const runConfigOperation = async (operation) => {
        const previousOperation = configOperationChain.catch(() => {});
        let releaseOperation = () => {};
        configOperationChain = new Promise((resolve) => {
            releaseOperation = resolve;
        });
        await previousOperation;
        try {
            return await operation();
        } finally {
            releaseOperation();
        }
    };

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
        if (mode === "full") return { ...db };

        const persistedConfig = await loadPersistedConfig();
        if (!persistedConfig || typeof persistedConfig !== "object") return { ...db };

        const nextConfig = { ...persistedConfig };
        for (const [key, value] of Object.entries(db)) {
            if (!Object.prototype.hasOwnProperty.call(persistedConfig, key)) {
                nextConfig[key] = value;
                continue;
            }

            const isDashboardEditable = dashboardEditableFields.some((field) => field.key === key);
            if (!isDashboardEditable) nextConfig[key] = value;
        }
        return nextConfig;
    };

    const saveDBInternal = async (options = {}) => {
        try {
            const configToPersist = await buildPersistableConfig(options);
            if (!configToPersist) return;
            await persistConfig(configToPersist);
            syncDashboardConfigSignature(configToPersist);
        } catch (error) {
            console.error("[CONFIG][ERROR] Failed to save DB:", error.message);
        }
    };

    const saveDB = (options = {}) => runConfigOperation(() => saveDBInternal(options));

    const initializeDB = () => runConfigOperation(async () => {
        try {
            await ensureConfigSchema();
            console.log("[DB][INFO] Database synced");
            const configRow = await ensureConfigRow();
            const persisted = configRow.toJSON();
            const { config: hydratedConfig, autoPresetResult } = applyAutoPresetToConfig(hydrateConfig(persisted));
            setDb(hydratedConfig);
            syncDashboardConfigSignature();
            if (autoPresetResult.changed) {
                await saveDBInternal({ mode: "full" });
                console.log(`[PRESET][INFO] Auto-applied ${autoPresetResult.presetName} profile for ${getDb().pair}`);
            }
            console.log("[DB][INFO] Runtime DB initialized successfully");
            return true;
        } catch (error) {
            console.error("[DB][ERROR] Failed to initialize DB:", error.message);
            setDb(null);
            return false;
        }
    });

    const reloadConfigInternal = async (previousRuntimeConfig = null) => {
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
                await saveDBInternal({ mode: "full" });
                console.log(`[PRESET][INFO] Auto-refreshed ${autoPresetResult.presetName} profile for ${getDb().pair}`);
            }
            return true;
        } catch (error) {
            console.error("[CONFIG][ERROR] Failed to reload config:", error.message);
            return false;
        }
    };

    const reloadConfig = (previousRuntimeConfig = null) => runConfigOperation(() => reloadConfigInternal(previousRuntimeConfig));

    const reloadConfigIfChanged = () => runConfigOperation(async () => {
        if (!getDb() || getIsShuttingDown()) return false;
        try {
            const persistedConfig = await loadPersistedConfig();
            if (!persistedConfig) return false;
            const persistedSignature = buildDashboardConfigSignature(persistedConfig);
            if (persistedSignature === lastKnownDashboardConfigSignature) return false;
            console.log("[CONFIG][INFO] Detected dashboard config change. Reloading...");
            const reloaded = await reloadConfigInternal();
            if (reloaded) syncDashboardConfigSignature();
            return reloaded;
        } catch (error) {
            console.error("[CONFIG][ERROR] Auto config reload failed:", error.message);
            return false;
        }
    });

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
