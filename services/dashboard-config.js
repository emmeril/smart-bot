const createDashboardConfigHelpers = ({
    getDb,
    hasAnyActivePosition,
    protectedKeys,
    editableKeys,
    getDefaultConfig,
    saveDB,
    reloadConfig,
    refreshRuntimeSchedulers,
    syncExchangeRuntimeSettings,
    buildDashboardPayload,
    applyAutoPresetToConfig
}) => {
    const applyDashboardRuntimeState = (nextConfig, currentConfig = getDb()) => {
        nextConfig.activePosition = currentConfig.activePosition;
        nextConfig.dailyPnL = currentConfig.dailyPnL;
        nextConfig.dailyTrades = currentConfig.dailyTrades;
        nextConfig.lastDailyReset = currentConfig.lastDailyReset;
        nextConfig.id = currentConfig.id;
        return nextConfig;
    };

    const pickEditableConfig = (input) => {
        const source = input && typeof input === "object" ? input : {};
        const picked = {};
        for (const [key, value] of Object.entries(source)) {
            if (editableKeys.has(key)) picked[key] = value;
        }
        return picked;
    };

    const persistRuntimeConfigChanges = async () => {
        await saveDB();
        await reloadConfig();
        refreshRuntimeSchedulers();
        await syncExchangeRuntimeSettings();
    };

    const applyDashboardConfigUpdate = async (incoming) => {
        const currentDb = getDb();
        if (!currentDb) throw new Error("Config is not ready yet");

        const current = { ...currentDb };
        const payload = pickEditableConfig(incoming);
        const { config: nextConfig } = applyAutoPresetToConfig({ ...current, ...payload });
        applyDashboardRuntimeState(nextConfig, current);

        if (hasAnyActivePosition()) {
            for (const key of protectedKeys) {
                if (Object.prototype.hasOwnProperty.call(payload, key)) {
                    nextConfig[key] = current[key];
                }
            }
        }

        Object.keys(currentDb).forEach((key) => { delete currentDb[key]; });
        Object.assign(currentDb, nextConfig);
        await persistRuntimeConfigChanges();
        return buildDashboardPayload();
    };

    const resetDashboardConfig = async () => {
        const currentDb = getDb();
        if (!currentDb) throw new Error("Config is not ready yet");
        
        if (hasAnyActivePosition()) {
            throw new Error("Cannot reset configuration while positions are active");
        }

        const { config: nextConfig } = applyAutoPresetToConfig(getDefaultConfig());
        applyDashboardRuntimeState(nextConfig, currentDb);
        Object.keys(currentDb).forEach((key) => { delete currentDb[key]; });
        Object.assign(currentDb, nextConfig);
        await persistRuntimeConfigChanges();
        return buildDashboardPayload();
    };

    return {
        applyDashboardConfigUpdate,
        resetDashboardConfig
    };
};

module.exports = { createDashboardConfigHelpers };
