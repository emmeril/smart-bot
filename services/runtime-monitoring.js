const createRuntimeMonitoringHelpers = ({
    getDb,
    toFiniteNumber,
    configureRecurringTask,
    getPnLMonitorTimer,
    setPnLMonitorTimer,
    getCurrentPnLMonitoringInterval,
    setCurrentPnLMonitoringInterval,
    getIsMonitoringPnL,
    setIsMonitoringPnL,
    hasAnyActivePosition,
    getIsClosingPosition,
    getIsSyncingPosition,
    getIsPlacingOrder,
    getPrice,
    fetchManagedOpenOrdersSnapshot,
    getActivePositionEntries,
    snapshotPositionRuntimeState,
    updateActivePositionExtremes,
    applyTrailingStopUpdate,
    didPositionRuntimeStateChange,
    upsertActivePosition,
    maybePersistActivePositionRuntimeState,
    ensureReduceOnlyStopLossOrder,
    calculatePositionPnL,
    evaluatePositionExit,
    closePosition,
    maybeLogPositionPnL,
    getPositionSyncTimer,
    setPositionSyncTimer,
    getCurrentPositionSyncInterval,
    setCurrentPositionSyncInterval,
    syncPositionWithExchange,
    saveDB,
    sleep,
    clearRuntimeTimers,
    closeWebServer,
    clearWebServer,
    closeSequelize,
    getWebServer,
    getIsShuttingDown,
    setIsShuttingDown,
    getIsPlacingOrderState,
    getIsClosingPositionState,
    unregisterRuntimeCommands,
    exitProcess
}) => {
    const startPnLMonitoring = () => {
        const db = getDb();
        if (!db) return;
        const desiredInterval = Math.max(200, Math.trunc(toFiniteNumber(db.monitoringInterval, 500)));

        const monitorTick = async () => {
            if (getIsMonitoringPnL()) return;
            setIsMonitoringPnL(true);
            try {
                if (!getDb() || !hasAnyActivePosition() || getIsClosingPosition() || getIsSyncingPosition() || getIsPlacingOrder()) return;
                const currentPrice = await getPrice();
                if (!currentPrice) return;
                let managedOrdersSnapshot = await fetchManagedOpenOrdersSnapshot();

                const activeEntries = getActivePositionEntries();
                for (const [positionKey, sourcePosition] of activeEntries) {
                    const position = { ...sourcePosition };
                    if (!Number.isFinite(position.entryPrice) || position.entryPrice <= 0 || !Number.isFinite(position.quantity) || position.quantity <= 0) {
                        console.error(`[MONITOR][ERROR] Invalid active position data for P&L monitoring (${positionKey}).`);
                        continue;
                    }

                    const previousRuntimeState = snapshotPositionRuntimeState(position);
                    updateActivePositionExtremes(position, currentPrice);
                    applyTrailingStopUpdate(position);
                    if (didPositionRuntimeStateChange(previousRuntimeState, position)) {
                        upsertActivePosition(position);
                        await maybePersistActivePositionRuntimeState();
                        await ensureReduceOnlyStopLossOrder(positionKey, position);
                        managedOrdersSnapshot = await fetchManagedOpenOrdersSnapshot();
                    }

                    const pnlState = calculatePositionPnL(position, currentPrice);
                    const exitState = evaluatePositionExit(position, currentPrice, pnlState, managedOrdersSnapshot);

                    if (exitState.shouldClose) {
                        console.log(`[${positionKey}] ${exitState.message.trim()}`);
                        await closePosition(positionKey, exitState.reason);
                        continue;
                    }

                    maybeLogPositionPnL(pnlState, exitState);
                }
            } catch (error) {
                console.error("[MONITOR][ERROR] PnL monitoring failed:", error.message);
            } finally {
                setIsMonitoringPnL(false);
            }
        };

        configureRecurringTask(
            getPnLMonitorTimer(),
            getCurrentPnLMonitoringInterval(),
            desiredInterval,
            "[MONITOR] Real-time P&L monitoring interval: ",
            monitorTick,
            setPnLMonitorTimer,
            setCurrentPnLMonitoringInterval
        );
    };

    const startPositionSync = () => {
        if (!getDb()) return;
        const desiredInterval = hasAnyActivePosition() ? 5000 : 15000;
        configureRecurringTask(
            getPositionSyncTimer(),
            getCurrentPositionSyncInterval(),
            desiredInterval,
            "[SYNC] Position sync interval: ",
            async () => { await syncPositionWithExchange(); },
            setPositionSyncTimer,
            setCurrentPositionSyncInterval
        );
    };

    const shutdown = async (signal = "EXIT") => {
        if (getIsShuttingDown()) return;
        setIsShuttingDown(true);

        if (getIsPlacingOrderState() || getIsClosingPositionState()) {
            console.log("[SHUTDOWN][INFO] Waiting for active transaction to complete...");
            await sleep(2000);
        }

        console.log(`[SHUTDOWN][INFO] Received ${signal}. Stopping bot...`);
        unregisterRuntimeCommands();
        clearRuntimeTimers();

        if (getWebServer()) {
            try {
                await closeWebServer();
            } catch (error) {
                console.error("[SHUTDOWN][ERROR] Failed to close web server:", error.message);
            }
            clearWebServer();
        }

        try { await saveDB(); } catch (error) { console.error("[SHUTDOWN][ERROR] Failed to save DB during shutdown:", error.message); }
        try { await closeSequelize(); } catch (error) { console.error("[SHUTDOWN][ERROR] Failed to close DB connection:", error.message); }
        console.log("[SHUTDOWN][INFO] Bot stopped.");
        exitProcess(0);
    };

    return {
        startPnLMonitoring,
        startPositionSync,
        shutdown
    };
};

module.exports = { createRuntimeMonitoringHelpers };
