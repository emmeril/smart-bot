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
    let dashboardConfigOperationChain = Promise.resolve();

    const runDashboardConfigOperation = async (operation) => {
        const previousOperation = dashboardConfigOperationChain.catch(() => {});
        let releaseOperation = () => {};
        dashboardConfigOperationChain = new Promise((resolve) => {
            releaseOperation = resolve;
        });
        await previousOperation;
        try {
            return await operation();
        } finally {
            releaseOperation();
        }
    };

    const applyDashboardRuntimeState = (nextConfig, currentConfig = getDb()) => {
        nextConfig.activePosition = currentConfig.activePosition;
        nextConfig.dailyPnL = currentConfig.dailyPnL;
        nextConfig.dailyTrades = currentConfig.dailyTrades;
        nextConfig.dailyPnlSource = currentConfig.dailyPnlSource;
        nextConfig.dailyPnlSyncedAt = currentConfig.dailyPnlSyncedAt;
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

    const persistRuntimeConfigChanges = async (previousConfig = null) => {
        await saveDB({ mode: "full" });
        await reloadConfig(previousConfig);
        refreshRuntimeSchedulers();
        await syncExchangeRuntimeSettings();
    };

    const replaceConfigObject = (targetConfig, nextConfig) => {
        Object.keys(targetConfig).forEach((key) => { delete targetConfig[key]; });
        Object.assign(targetConfig, nextConfig);
    };

    const applyDashboardConfigUpdate = (incoming) => runDashboardConfigOperation(async () => {
        const currentDb = getDb();
        if (!currentDb) throw new Error("Config is not ready yet");

        const current = { ...currentDb };
        const payload = pickEditableConfig(incoming);
        const merged = { ...current, ...payload };
        const requestedPair = typeof payload.pair === "string" ? payload.pair.trim() : "";
        const currentPair = typeof currentDb.pair === "string" ? currentDb.pair.trim() : "";

        const { config: nextConfig } = applyAutoPresetToConfig(merged);
        if (hasAnyActivePosition() && requestedPair && requestedPair !== currentPair) {
            nextConfig.pair = currentPair;
            nextConfig.pendingPair = requestedPair;
        } else if (requestedPair && requestedPair !== currentPair) {
            nextConfig.pair = requestedPair;
            nextConfig.pendingPair = null;
        }
        applyDashboardRuntimeState(nextConfig, current);
        replaceConfigObject(currentDb, nextConfig);
        await persistRuntimeConfigChanges(current);
        return buildDashboardPayload();
    });

    const resetDashboardConfig = () => runDashboardConfigOperation(async () => {
        const currentDb = getDb();
        if (!currentDb) throw new Error("Config is not ready yet");
        
        if (hasAnyActivePosition()) {
            throw new Error("Cannot reset configuration while positions are active");
        }

        const current = { ...currentDb };
        const { config: nextConfig } = applyAutoPresetToConfig(getDefaultConfig());
        applyDashboardRuntimeState(nextConfig, currentDb);
        replaceConfigObject(currentDb, nextConfig);
        await persistRuntimeConfigChanges(current);
        return buildDashboardPayload();
    });

    return {
        applyDashboardConfigUpdate,
        resetDashboardConfig
    };
};

module.exports = { createDashboardConfigHelpers };
