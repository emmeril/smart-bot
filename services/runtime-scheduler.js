const createRuntimeSchedulerHelpers = ({ initializeExchange, detectPositionMode, setMarginMode, syncPositionWithExchange, startPnLMonitoring, startPositionSync, startMetricsReporting, startConfigAutoReload, shutdown }) => {
    const recurringTaskState = new WeakMap();

    const configureRecurringTask = (currentTimer, currentInterval, desiredInterval, label, callback, assignTimer, assignInterval) => {
        if (currentTimer && currentInterval === desiredInterval) return currentTimer;
        if (currentTimer) {
            clearInterval(currentTimer);
            recurringTaskState.delete(currentTimer);
            assignTimer(null);
        }
        assignInterval(desiredInterval);
        console.log(`${label}${desiredInterval}ms`);
        const runnerState = { running: false };
        const nextTimer = setInterval(async () => {
            if (runnerState.running) return;
            runnerState.running = true;
            try {
                await callback();
            } catch (error) {
                console.error("[SCHEDULER][ERROR] Recurring task failed:", error?.message || error);
            } finally {
                runnerState.running = false;
            }
        }, desiredInterval);
        recurringTaskState.set(nextTimer, runnerState);
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
        refreshRuntimeSchedulers();
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
