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
    resolveProtectedRuntimeConfigEligibility,
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

    const sanitizePendingRuntimeConfig = (value) => {
        if (!value || typeof value !== "object") return null;
        const entries = Object.entries(value).filter(([key]) => protectedKeys.has(key));
        return entries.length > 0 ? Object.fromEntries(entries) : null;
    };

    const buildDeferredProtectedConfig = (currentConfig, payload, preserveRuntimeKeys) => {
        const currentPending = sanitizePendingRuntimeConfig(currentConfig?.pendingRuntimeConfig) || {};
        const nextPending = { ...currentPending };
        for (const key of preserveRuntimeKeys) {
            if (Object.prototype.hasOwnProperty.call(payload, key)) nextPending[key] = payload[key];
        }
        return sanitizePendingRuntimeConfig(nextPending);
    };

    const clearAppliedPendingProtectedConfig = (currentConfig, appliedKeys) => {
        const currentPending = sanitizePendingRuntimeConfig(currentConfig?.pendingRuntimeConfig);
        if (!currentPending) return null;
        const nextPending = { ...currentPending };
        for (const key of appliedKeys) delete nextPending[key];
        return sanitizePendingRuntimeConfig(nextPending);
    };

    const persistRuntimeConfigChanges = async (previousConfig = null) => {
        await saveDB({ mode: "full" });
        await reloadConfig(previousConfig);
        refreshRuntimeSchedulers();
        await syncExchangeRuntimeSettings();
    };

    const applyDashboardConfigUpdate = async (incoming) => await runDashboardConfigOperation(async () => {
        const currentDb = getDb();
        if (!currentDb) throw new Error("Config is not ready yet");

        const current = { ...currentDb };
        const payload = pickEditableConfig(incoming);
        const merged = { ...current, ...payload };
        const protectedPayloadKeys = [...protectedKeys].filter((key) => Object.prototype.hasOwnProperty.call(payload, key));
        let protectedKeysToDefer = [];
        let protectedEligibility = null;

        if (protectedPayloadKeys.length > 0) {
            const localPositionActive = hasAnyActivePosition();
            protectedEligibility = typeof resolveProtectedRuntimeConfigEligibility === "function"
                ? await resolveProtectedRuntimeConfigEligibility({ waitMs: localPositionActive ? 2500 : 0, payloadKeys: protectedPayloadKeys })
                : { canApply: !localPositionActive, reasons: localPositionActive ? ["ACTIVE_POSITION"] : [] };

            if (!protectedEligibility?.canApply) {
                protectedKeysToDefer = protectedPayloadKeys;
            }
        }

        const { config: nextConfig } = applyAutoPresetToConfig(merged);
        if (protectedKeysToDefer.length > 0) {
            for (const key of protectedKeysToDefer) nextConfig[key] = current[key];
        }
        nextConfig.pendingRuntimeConfig = protectedKeysToDefer.length > 0
            ? buildDeferredProtectedConfig(current, payload, protectedKeysToDefer)
            : clearAppliedPendingProtectedConfig(current, protectedPayloadKeys);
        applyDashboardRuntimeState(nextConfig, current);

        Object.keys(currentDb).forEach((key) => { delete currentDb[key]; });
        Object.assign(currentDb, nextConfig);
        await persistRuntimeConfigChanges(current);
        return {
            ...buildDashboardPayload(),
            deferredProtectedKeys: protectedKeysToDefer,
            protectedConfigEligibility: protectedEligibility || { canApply: true, reasons: [] },
            message: protectedKeysToDefer.length > 0
                ? `Saved pending protected config (${protectedKeysToDefer.join(", ")}) and will apply it after Binance positions/orders are clear.`
                : "Configuration updated successfully."
        };
    });

    const resetDashboardConfig = async () => await runDashboardConfigOperation(async () => {
        const currentDb = getDb();
        if (!currentDb) throw new Error("Config is not ready yet");
        
        if (hasAnyActivePosition()) {
            throw new Error("Cannot reset configuration while positions are active");
        }

        const current = { ...currentDb };
        const { config: nextConfig } = applyAutoPresetToConfig(getDefaultConfig());
        applyDashboardRuntimeState(nextConfig, currentDb);
        Object.keys(currentDb).forEach((key) => { delete currentDb[key]; });
        Object.assign(currentDb, nextConfig);
        await persistRuntimeConfigChanges(current);
        return buildDashboardPayload();
    });

    return {
        applyDashboardConfigUpdate,
        resetDashboardConfig
    };
};

module.exports = { createDashboardConfigHelpers };
