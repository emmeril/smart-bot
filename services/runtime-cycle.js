const createRuntimeCycleHelpers = ({
    getDb,
    getLastTradeAt,
    setRuntimeCommandsRegistered,
    getRuntimeCommandsRegistered,
    toFiniteNumber,
    getUTCDateKey,
    resetDailyTradeMetrics,
    saveDB,
    resetDailyPnlState,
    syncDailyPnlWithExchange,
    reloadConfig,
    refreshRuntimeSchedulers,
    hasRuntimePositionMutationInFlight,
    canOpenNewPositions,
    logExchangeRecoveryBlock,
    fetchOpenGridOrders,
    cancelGridOrders,
    syncGridOrders,
    hasAnyActivePosition,
    getLastTradeTimestampFromLog,
    analyzeSignal,
    getActivePositionByKey,
    placeOrder,
    syncPositionWithExchange,
    printDetailedStatus,
    getMetrics,
    resetMetricWindow,
    metricsLogInterval
}) => {
    const isNewTradingDay = (timestamp) => {
        const db = getDb();
        const currentTime = toFiniteNumber(timestamp, NaN);
        if (!Number.isFinite(currentTime)) return false;
        const lastResetTime = toFiniteNumber(db.lastDailyReset, NaN);
        const todayUTC = getUTCDateKey(currentTime);
        const lastResetUTC = getUTCDateKey(lastResetTime);
        return todayUTC !== lastResetUTC;
    };

    const resetDailyStateIfNeeded = async (now) => {
        const db = getDb();
        if (!isNewTradingDay(now)) return false;
        console.log("[DAILY][INFO] Daily reset");
        resetDailyTradeMetrics();
        if (typeof resetDailyPnlState === "function") await resetDailyPnlState(now);
        else {
            // Keep realized PnL cumulative across days; only reset daily trade counters.
            db.dailyTrades = 0;
            db.lastDailyReset = toFiniteNumber(now, Date.now());
            await saveDB();
        }
        return true;
    };

    const getTradingPauseReason = async () => {
        const db = getDb();
        if (db.dailyTrades >= db.maxTradesPerDay) return `[PAUSE] Max trades per day (${db.maxTradesPerDay}) reached.`;
        return null;
    };

    const isCoolingDown = () => {
        const db = getDb();
        if (db.dailyTrades <= 0) return false;
        const tradeTimestamp = getLastTradeAt() || getLastTradeTimestampFromLog();
        return tradeTimestamp > 0 && Date.now() - tradeTimestamp < db.coolingPeriod;
    };

    const handleRuntimeCommand = async (input) => {
        try {
            const cmd = input.toString().trim().toLowerCase();
            if (!cmd) return;
            if (cmd === "sync") { await syncPositionWithExchange(); return; }
            if (cmd === "status") { await printDetailedStatus(); return; }
            if (cmd === "help") {
                console.log("[RUNTIME][INFO] Runtime commands: status | sync | help");
                return;
            }
            console.log(`[RUNTIME][INFO] Unknown runtime command: ${cmd}. Available: status | sync | help`);
        } catch (error) {
            console.error("[RUNTIME][ERROR] Runtime command failed:", error.message);
        }
    };

    const unregisterRuntimeCommands = () => {
        if (!getRuntimeCommandsRegistered() || !process.stdin.isTTY) return;
        process.stdin.removeListener("data", handleRuntimeCommand);
        process.stdin.pause();
        setRuntimeCommandsRegistered(false);
    };

    const registerRuntimeCommands = () => {
        if (getRuntimeCommandsRegistered() || !process.stdin.isTTY) return;
        process.stdin.setEncoding("utf8");
        process.stdin.resume();
        process.stdin.on("data", handleRuntimeCommand);
        setRuntimeCommandsRegistered(true);
    };

    const runTradingCycle = async () => {
        const db = getDb();
        if (hasRuntimePositionMutationInFlight()) return;
        await reloadConfig();
        refreshRuntimeSchedulers();
        const strategy = String(db?.strategy || "spot_grid").toLowerCase();

        await resetDailyStateIfNeeded(Date.now());
        if (typeof syncDailyPnlWithExchange === "function") await syncDailyPnlWithExchange();
        if (!canOpenNewPositions()) {
            logExchangeRecoveryBlock(strategy === "spot_grid" ? "grid entries" : "new position entries");
            return;
        }

        const pauseReason = await getTradingPauseReason();
        if (pauseReason) {
            console.log(pauseReason);
            if (strategy === "spot_grid") {
                const openGridOrders = await fetchOpenGridOrders();
                if (openGridOrders.length > 0) await cancelGridOrders(openGridOrders, "PAUSED");
            }
            return;
        }

        if (strategy === "spot_grid") {
            await syncGridOrders();
            return;
        }

        const coolingBlocked = isCoolingDown() && !hasAnyActivePosition();
        if (hasAnyActivePosition() || coolingBlocked) return;

        const signal = await analyzeSignal();
        if (signal.canLong && !getActivePositionByKey("BOTH")) await placeOrder("buy", signal);
    };

    const startMetricsReporting = (currentTimer, setMetricsTimer) => {
        if (currentTimer()) return;
        const timer = setInterval(() => {
            const metrics = getMetrics();
            const elapsedSec = Math.max(1, Math.round((Date.now() - metrics.windowStart) / 1000));
            const apiTotal = metrics.api.ticker + metrics.api.ohlcv + metrics.api.balance + metrics.api.positions + metrics.api.orders;
            const winRate = metrics.trades.closed > 0 ? ((metrics.trades.wins / metrics.trades.closed) * 100).toFixed(1) : "0.0";
            console.log(`[METRICS][INFO] ${elapsedSec}s | API=${apiTotal} (ticker:${metrics.api.ticker}, ohlcv:${metrics.api.ohlcv}, bal:${metrics.api.balance}, pos:${metrics.api.positions}, order:${metrics.api.orders}) | Signals=${metrics.signals.analyzed} (setups:${metrics.signals.crossoverDetected}, long:${metrics.signals.longConfirmed}, short:${metrics.signals.shortConfirmed}) | Trades today O/C/W/L=${metrics.trades.opened}/${metrics.trades.closed}/${metrics.trades.wins}/${metrics.trades.losses} (WR ${winRate}%)`);
            resetMetricWindow();
        }, metricsLogInterval);
        setMetricsTimer(timer);
    };

    return {
        isNewTradingDay,
        resetDailyStateIfNeeded,
        getTradingPauseReason,
        isCoolingDown,
        handleRuntimeCommand,
        unregisterRuntimeCommands,
        registerRuntimeCommands,
        runTradingCycle,
        startMetricsReporting
    };
};

module.exports = { createRuntimeCycleHelpers };
