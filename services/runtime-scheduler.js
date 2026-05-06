const createRuntimeSchedulerHelpers = ({ initializeExchange, detectPositionMode, setMarginMode, syncPositionWithExchange, startPnLMonitoring, startPositionSync, startMetricsReporting, startConfigAutoReload, shutdown }) => {
    const configureRecurringTask = (currentTimer, currentInterval, desiredInterval, label, callback, assignTimer, assignInterval) => {
        if (currentTimer && currentInterval === desiredInterval) return currentTimer;
        if (currentTimer) {
            clearInterval(currentTimer);
            assignTimer(null);
        }
        assignInterval(desiredInterval);
        console.log(`${label}${desiredInterval}ms`);
        const nextTimer = setInterval(callback, desiredInterval);
        assignTimer(nextTimer);
        return nextTimer;
    };

    const refreshRuntimeSchedulers = () => {
        startPnLMonitoring();
        startPositionSync();
    };

    const bootstrapRuntime = async () => {
        await initializeExchange();
        await detectPositionMode();
        await setMarginMode();
        await syncPositionWithExchange();
        startPnLMonitoring();
        startPositionSync();
        startMetricsReporting();
        startConfigAutoReload();
        process.once("SIGINT", () => { shutdown("SIGINT"); });
        process.once("SIGTERM", () => { shutdown("SIGTERM"); });
    };

    return {
        configureRecurringTask,
        refreshRuntimeSchedulers,
        bootstrapRuntime
    };
};

module.exports = { createRuntimeSchedulerHelpers };
