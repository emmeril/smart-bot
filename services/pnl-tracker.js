const createPnlTrackerHelpers = ({
    getDb,
    toFiniteNumber,
    saveDB
}) => {
    const buildDailyPnlSnapshot = (input = getDb()) => {
        const state = input && typeof input === "object" ? input : {};
        return {
            dailyPnL: toFiniteNumber(state.dailyPnL, 0),
            dailyTrades: Math.max(0, Math.trunc(toFiniteNumber(state.dailyTrades, 0))),
            estimatedPnL: toFiniteNumber(state.estimatedPnL, 0),
            estimatedTrades: Math.max(0, Math.trunc(toFiniteNumber(state.estimatedTrades, 0))),
            lastDailyReset: toFiniteNumber(state.lastDailyReset, 0),
            dailyPnlSource: String(state.dailyPnlSource || "local").toLowerCase(),
            dailyPnlSyncedAt: toFiniteNumber(state.dailyPnlSyncedAt, 0)
        };
    };

    const updateDailyPnlState = async ({
        pnl = null,
        tradeDelta = 0,
        estimatedPnl = null,
        estimatedTradeDelta = 0,
        source = "local",
        syncedAt = Date.now()
    } = {}) => {
        const db = getDb();
        if (!db) return buildDailyPnlSnapshot();
        const current = buildDailyPnlSnapshot(db);
        const nextPnl = Number.isFinite(pnl) ? pnl : current.dailyPnL;
        const nextTrades = Math.max(0, current.dailyTrades + Math.trunc(toFiniteNumber(tradeDelta, 0)));
        const nextEstimatedPnl = Number.isFinite(estimatedPnl) ? estimatedPnl : current.estimatedPnL;
        const nextEstimatedTrades = Math.max(0, current.estimatedTrades + Math.trunc(toFiniteNumber(estimatedTradeDelta, 0)));
        const requestedSource = String(source || current.dailyPnlSource || "local").toLowerCase();
        const nextSource = requestedSource === "estimated" ? "estimated" : "local";
        const nextSyncedAt = toFiniteNumber(syncedAt, current.dailyPnlSyncedAt);
        const changed = nextPnl !== current.dailyPnL ||
            nextTrades !== current.dailyTrades ||
            nextEstimatedPnl !== current.estimatedPnL ||
            nextEstimatedTrades !== current.estimatedTrades ||
            nextSource !== current.dailyPnlSource ||
            nextSyncedAt !== current.dailyPnlSyncedAt;

        if (!changed) return buildDailyPnlSnapshot(db);

        db.dailyPnL = nextPnl;
        db.dailyTrades = nextTrades;
        db.estimatedPnL = nextEstimatedPnl;
        db.estimatedTrades = nextEstimatedTrades;
        db.dailyPnlSource = nextSource;
        db.dailyPnlSyncedAt = nextSyncedAt;
        await saveDB();
        return buildDailyPnlSnapshot(db);
    };

    const applyDailyPnlDelta = async ({ pnlDelta = 0, tradeDelta = 0, source = "local", syncedAt = Date.now() } = {}) => {
        const db = getDb();
        const current = buildDailyPnlSnapshot(db);
        const normalizedSource = String(source || "local").toLowerCase();
        if (normalizedSource === "estimated") {
            const nextEstimatedPnl = current.estimatedPnL + toFiniteNumber(pnlDelta, 0);
            return await updateDailyPnlState({
                estimatedPnl: nextEstimatedPnl,
                estimatedTradeDelta: Math.max(0, Math.trunc(toFiniteNumber(tradeDelta, 0))),
                source: normalizedSource,
                syncedAt
            });
        }
        const nextPnl = current.dailyPnL + toFiniteNumber(pnlDelta, 0);
        return await updateDailyPnlState({
            pnl: nextPnl,
            tradeDelta,
            source: normalizedSource,
            syncedAt
        });
    };

    const resetDailyPnlState = async (timestamp = Date.now()) => {
        const db = getDb();
        if (!db) return buildDailyPnlSnapshot();
        // Keep realized PnL cumulative across days; only reset daily trade counters.
        db.dailyTrades = 0;
        db.lastDailyReset = toFiniteNumber(timestamp, Date.now());
        db.dailyPnlSource = String(db.dailyPnlSource || "local").toLowerCase();
        db.dailyPnlSyncedAt = toFiniteNumber(timestamp, Date.now());
        await saveDB();
        return buildDailyPnlSnapshot(db);
    };

    const syncDailyPnlWithExchange = async () => {
        // Keep daily realized PnL fully bot-driven.
        // Exchange reconciliation is intentionally disabled so trade/PnL authority stays local.
        // Trade/position sync still happens in runtime sync modules; this function only reports local PnL state.
        return buildDailyPnlSnapshot(getDb());
    };

    return {
        buildDailyPnlSnapshot,
        updateDailyPnlState,
        applyDailyPnlDelta,
        resetDailyPnlState,
        syncDailyPnlWithExchange
    };
};

module.exports = { createPnlTrackerHelpers };
