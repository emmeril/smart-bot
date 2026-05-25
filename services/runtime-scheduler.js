const createRuntimeSchedulerHelpers = ({
    initializeExchange,
    detectPositionMode,
    setMarginMode,
    syncPositionWithExchange,
    startPnLMonitoring,
    startPositionSync,
    startMetricsReporting,
    startConfigAutoReload,
    shutdown
}) => {
    const normalizeRecurringTaskArgs = (
        labelOrCallback,
        callbackOrAssignTimer,
        assignTimerOrAssignInterval,
        maybeAssignInterval
    ) => {
        if (typeof labelOrCallback === "function") {
            return {
                label: "",
                callback: labelOrCallback,
                assignTimer: callbackOrAssignTimer,
                assignInterval: assignTimerOrAssignInterval
            };
        }

        return {
            label: String(labelOrCallback || ""),
            callback: callbackOrAssignTimer,
            assignTimer: assignTimerOrAssignInterval,
            assignInterval: maybeAssignInterval
        };
    };

    const configureRecurringTask = (
        currentTimer,
        currentInterval,
        desiredInterval,
        labelOrCallback,
        callbackOrAssignTimer,
        assignTimerOrAssignInterval,
        maybeAssignInterval
    ) => {
        const { label, callback, assignTimer, assignInterval } = normalizeRecurringTaskArgs(
            labelOrCallback,
            callbackOrAssignTimer,
            assignTimerOrAssignInterval,
            maybeAssignInterval
        );

        if (currentTimer && currentInterval === desiredInterval) return currentTimer;
        if (currentTimer) {
            clearInterval(currentTimer);
            assignTimer(null);
        }
        assignInterval(desiredInterval);
        if (label) console.log(`${label}${desiredInterval}ms`);
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
        process.once("SIGINT", () => {
            shutdown("SIGINT").catch((error) => {
                console.error("[SHUTDOWN][ERROR] SIGINT shutdown failed:", error?.message || error);
            });
        });
        process.once("SIGTERM", () => {
            shutdown("SIGTERM").catch((error) => {
                console.error("[SHUTDOWN][ERROR] SIGTERM shutdown failed:", error?.message || error);
            });
        });
    };

    return {
        configureRecurringTask,
        refreshRuntimeSchedulers,
        bootstrapRuntime
    };
};

module.exports = { createRuntimeSchedulerHelpers };
