const createPnlTrackerHelpers = ({
    getDb,
    getExchange,
    toFiniteNumber,
    saveDB
}) => {
    const EXCHANGE_PNL_SYNC_TTL_MS = 15000;
    const EXCHANGE_PNL_FETCH_PAGE_LIMIT = 250;
    const EXCHANGE_PNL_FETCH_MAX_PAGES = 12;

    let lastExchangePnlSyncAt = 0;
    let exchangePnlSyncPromise = null;

    const buildDailyPnlSnapshot = (input = getDb()) => {
        const state = input && typeof input === "object" ? input : {};
        return {
            dailyPnL: toFiniteNumber(state.dailyPnL, 0),
            dailyTrades: Math.max(0, Math.trunc(toFiniteNumber(state.dailyTrades, 0))),
            lastDailyReset: toFiniteNumber(state.lastDailyReset, 0),
            dailyPnlSource: String(state.dailyPnlSource || "local").toLowerCase(),
            dailyPnlSyncedAt: toFiniteNumber(state.dailyPnlSyncedAt, 0)
        };
    };

    const updateDailyPnlState = async ({ pnl = null, tradeDelta = 0, source = "local", syncedAt = Date.now() } = {}) => {
        const db = getDb();
        if (!db) return buildDailyPnlSnapshot();
        const current = buildDailyPnlSnapshot(db);
        const nextPnl = Number.isFinite(pnl) ? pnl : current.dailyPnL;
        const nextTrades = Math.max(0, current.dailyTrades + Math.trunc(toFiniteNumber(tradeDelta, 0)));
        const nextSource = String(source || current.dailyPnlSource || "local").toLowerCase();
        const nextSyncedAt = toFiniteNumber(syncedAt, current.dailyPnlSyncedAt);
        const changed = nextPnl !== current.dailyPnL ||
            nextTrades !== current.dailyTrades ||
            nextSource !== current.dailyPnlSource ||
            nextSyncedAt !== current.dailyPnlSyncedAt;

        if (!changed) return buildDailyPnlSnapshot(db);

        db.dailyPnL = nextPnl;
        db.dailyTrades = nextTrades;
        db.dailyPnlSource = nextSource;
        db.dailyPnlSyncedAt = nextSyncedAt;
        await saveDB();
        return buildDailyPnlSnapshot(db);
    };

    const applyDailyPnlDelta = async ({ pnlDelta = 0, tradeDelta = 0, source = "local", syncedAt = Date.now() } = {}) => {
        const db = getDb();
        const current = buildDailyPnlSnapshot(db);
        const nextPnl = current.dailyPnL + toFiniteNumber(pnlDelta, 0);
        return await updateDailyPnlState({
            pnl: nextPnl,
            tradeDelta,
            source,
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
        lastExchangePnlSyncAt = 0;
        await saveDB();
        return buildDailyPnlSnapshot(db);
    };

    const supportsExchangeTradeSync = () => {
        const exchange = getExchange();
        if (!exchange || typeof exchange.fetchMyTrades !== "function") return false;
        if (exchange.options?.smartBotPrivateAuthFailed) return false;
        if (exchange.has && exchange.has.fetchMyTrades === false) return false;
        return true;
    };

    const getTradeCommissionCost = (trade) => {
        const directFeeCost = toFiniteNumber(trade?.fee?.cost, NaN);
        if (Number.isFinite(directFeeCost)) return Math.abs(directFeeCost);
        const infoCommission = toFiniteNumber(trade?.info?.commission, NaN);
        if (Number.isFinite(infoCommission)) return Math.abs(infoCommission);
        return 0;
    };

    const getTradeRealizedPnl = (trade) => toFiniteNumber(
        trade?.realizedPnl,
        toFiniteNumber(
            trade?.info?.realizedPnl,
            toFiniteNumber(trade?.info?.realizedProfit, NaN)
        )
    );

    const getTradeNetPnl = (trade) => {
        const realizedPnl = getTradeRealizedPnl(trade);
        const commissionCost = getTradeCommissionCost(trade);
        if (!Number.isFinite(realizedPnl) && !Number.isFinite(commissionCost)) return null;
        return {
            realizedPnl: Number.isFinite(realizedPnl) ? realizedPnl : 0,
            commissionCost: Number.isFinite(commissionCost) ? commissionCost : 0,
            netPnl: (Number.isFinite(realizedPnl) ? realizedPnl : 0) - (Number.isFinite(commissionCost) ? commissionCost : 0)
        };
    };

    const fetchDailyTradesFromExchange = async (symbol, since) => {
        const exchange = getExchange();
        const allTrades = [];
        let cursor = since;

        for (let page = 0; page < EXCHANGE_PNL_FETCH_MAX_PAGES; page += 1) {
            const batch = await exchange.fetchMyTrades(symbol, cursor, EXCHANGE_PNL_FETCH_PAGE_LIMIT);
            if (!Array.isArray(batch) || batch.length === 0) break;
            allTrades.push(...batch);
            if (batch.length < EXCHANGE_PNL_FETCH_PAGE_LIMIT) break;
            const lastTrade = batch[batch.length - 1];
            const lastTimestamp = toFiniteNumber(lastTrade?.timestamp, NaN);
            if (!Number.isFinite(lastTimestamp)) break;
            cursor = lastTimestamp + 1;
        }

        return allTrades;
    };

    const syncDailyPnlWithExchange = async () => {
        // Keep daily realized PnL fully bot-driven.
        // Exchange reconciliation is intentionally disabled to prevent overwriting local realized PnL bookkeeping.
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
