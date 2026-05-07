const fs = require("fs");

const createRuntimeMarketDataHelpers = ({
    getExchange,
    getDb,
    getMetrics,
    getBalanceCache,
    setBalanceCache,
    getTickerCache,
    setTickerCache,
    getOhlcvCache,
    setOhlcvCache,
    retry,
    toFiniteNumber,
    ensureFileExists,
    logPath,
    getPrimaryActivePosition,
    setLastTradeAt,
    balanceCacheTtl,
    tickerCacheTtl,
    ohlcvCacheTtl,
    getExchangeClientOrderId,
    getOrderQuantity,
    getOrderTriggerPrice
}) => {
    const formatOrderSummary = (order, typeLabel) => {
        const side = String(order?.side || "").toUpperCase();
        const amount = getOrderQuantity(order);
        const price = typeLabel === "SL" ? getOrderTriggerPrice(order) : toFiniteNumber(order?.price, NaN);
        const clientId = getExchangeClientOrderId(order) || "N/A";
        return `${typeLabel} ${side} qty=${Number.isFinite(amount) ? amount : "N/A"} price=${Number.isFinite(price) ? price : "N/A"} id=${clientId}`;
    };

    const getPrice = async (forceRefresh = false) => {
        const exchange = getExchange();
        const db = getDb();
        const metrics = getMetrics();
        const tickerCache = getTickerCache();
        try {
            const now = Date.now();
            if (!forceRefresh && now - tickerCache.lastUpdate < tickerCacheTtl) return tickerCache.price;
            if (!exchange || typeof exchange.fetchTicker !== "function" || !db?.pair) {
                console.warn("[MARKET][WARN] Price fetch skipped because exchange or pair is not ready.");
                return tickerCache.price;
            }
            const ticker = await retry(() => exchange.fetchTicker(db.pair));
            metrics.api.ticker++;
            const latestPrice = toFiniteNumber(ticker?.last, null);
            if (latestPrice) {
                setTickerCache({ ...tickerCache, price: latestPrice, lastUpdate: now });
            }
            return latestPrice;
        } catch (error) {
            console.error("[MARKET][ERROR] Failed to get price after retries:", error.message);
            return getTickerCache().price;
        }
    };

    const getOHLCV = async (limit = 100, forceRefresh = false) => {
        const exchange = getExchange();
        const db = getDb();
        const metrics = getMetrics();
        const ohlcvCache = getOhlcvCache();
        const timeframe = db?.gridTimeframe || "5m";
        const cacheKey = `${db?.pair || ""}:${timeframe}:${limit}`;
        const now = Date.now();
        if (!forceRefresh && ohlcvCache.key === cacheKey && now - ohlcvCache.lastUpdate < ohlcvCacheTtl && Array.isArray(ohlcvCache.data)) {
            return ohlcvCache.data;
        }
        if (!exchange || typeof exchange.fetchOHLCV !== "function" || !db?.pair) {
            console.warn("[MARKET][WARN] OHLCV fetch skipped because exchange or pair is not ready.");
            return getOhlcvCache().data || [];
        }
        try {
            const ohlcv = await retry(() => exchange.fetchOHLCV(db.pair, timeframe, undefined, limit));
            metrics.api.ohlcv++;
            setOhlcvCache({ key: cacheKey, data: ohlcv, lastUpdate: now });
            return ohlcv;
        } catch (error) {
            console.error("[MARKET][ERROR] Failed to fetch OHLCV after retries:", error.message);
            return getOhlcvCache().data || [];
        }
    };

    const getOrderBook = async (limit = 10) => {
        const exchange = getExchange();
        const db = getDb();
        const metrics = getMetrics();
        if (!exchange || typeof exchange.fetchOrderBook !== "function") return null;
        try {
            const orderBook = await retry(() => exchange.fetchOrderBook(db.pair, limit));
            metrics.api.orderBook = (metrics.api.orderBook || 0) + 1;
            return orderBook;
        } catch (error) {
            console.error("[MARKET][WARN] Failed to fetch order book:", error.message);
            return null;
        }
    };

    const getRecentTrades = async (limit = 25) => {
        const exchange = getExchange();
        const db = getDb();
        const metrics = getMetrics();
        if (!exchange || typeof exchange.fetchTrades !== "function") return [];
        try {
            const trades = await retry(() => exchange.fetchTrades(db.pair, undefined, limit));
            metrics.api.trades = (metrics.api.trades || 0) + 1;
            return Array.isArray(trades) ? trades : [];
        } catch (error) {
            console.error("[MARKET][WARN] Failed to fetch recent trades:", error.message);
            return [];
        }
    };

    const escapeCsvField = (value) => {
        const text = String(value ?? "");
        if (!/[",\r\n]/.test(text)) return text;
        return `"${text.replace(/"/g, '""')}"`;
    };

    const logTrade = (side, entry, exit, status, pnl = 0, strategyOverride = null) => {
        const db = getDb();
        try {
            ensureFileExists(logPath, "timestamp,pair,side,entry,exit,status,pnl,trade_mode,stop_loss_percent,strategy\n");
            const timestamp = new Date().toISOString();
            const parsedTime = Date.parse(timestamp);
            setLastTradeAt(Number.isFinite(parsedTime) ? parsedTime : Date.now());
            const tradeMode = (db.marginMode || "spot").toUpperCase();
            const strategy = strategyOverride || getPrimaryActivePosition()?.strategy || `SPOT_GRID_${String(db.gridTimeframe || "5m").toUpperCase()}`;
            const line = [
                timestamp,
                escapeCsvField(db.pair),
                escapeCsvField(side),
                escapeCsvField(entry),
                escapeCsvField(exit || ""),
                escapeCsvField(status),
                escapeCsvField(pnl.toFixed(4)),
                escapeCsvField(tradeMode),
                escapeCsvField(db.gridStopLossPercent),
                escapeCsvField(strategy)
            ].join(",") + "\n";
            fs.appendFileSync(logPath, line);
        } catch (error) {
            console.error("[MARKET][ERROR] Failed to log trade:", error.message);
        }
    };

    const extractUsdtBalanceSnapshot = (balance) => {
        const usdtAccountEntry = Array.isArray(balance?.info)
            ? balance.info.find((entry) => String(entry?.asset || "").toUpperCase() === "USDT")
            : null;
        const totalUSDT = toFiniteNumber(
            balance?.total?.USDT,
            toFiniteNumber(
                usdtAccountEntry?.balance,
                toFiniteNumber(usdtAccountEntry?.walletBalance, 0)
            )
        );
        const availableUSDT = toFiniteNumber(
            balance?.free?.USDT,
            toFiniteNumber(usdtAccountEntry?.availableBalance, totalUSDT)
        );
        return { totalUSDT, availableUSDT };
    };

    const getTotalUSDTBalance = async (forceRefresh = false) => {
        const exchange = getExchange();
        const metrics = getMetrics();
        const balanceCache = getBalanceCache();
        if (!exchange || typeof exchange.fetchBalance !== "function") {
            console.warn("[MARKET][WARN] Balance fetch skipped because exchange is not ready.");
            return balanceCache.totalUSDT || 0;
        }
        if (exchange?.options?.smartBotPrivateAuthFailed) {
            return balanceCache.totalUSDT || 0;
        }
        try {
            const now = Date.now();
            if (!forceRefresh && now - balanceCache.lastUpdate < balanceCacheTtl) return balanceCache.totalUSDT;
            const balance = await exchange.fetchBalance();
            metrics.api.balance++;
            const { totalUSDT, availableUSDT } = extractUsdtBalanceSnapshot(balance);
            setBalanceCache({
                ...balanceCache,
                totalUSDT,
                availableUSDT,
                lastUpdate: now
            });
            return getBalanceCache().totalUSDT;
        } catch (error) {
            console.error("[MARKET][ERROR] Failed to fetch balance:", error.message);
            return getBalanceCache().totalUSDT || 0;
        }
    };

    const getAvailableUSDTBalance = async (forceRefresh = false) => {
        const balanceCache = getBalanceCache();
        try {
            const now = Date.now();
            if (!forceRefresh && now - balanceCache.lastUpdate < balanceCacheTtl) {
                return Number.isFinite(balanceCache.availableUSDT) ? balanceCache.availableUSDT : balanceCache.totalUSDT;
            }
            await getTotalUSDTBalance(forceRefresh);
            const latestBalanceCache = getBalanceCache();
            return Number.isFinite(latestBalanceCache.availableUSDT) ? latestBalanceCache.availableUSDT : latestBalanceCache.totalUSDT;
        } catch (error) {
            console.error("[MARKET][ERROR] Failed to resolve available balance:", error.message);
            const latestBalanceCache = getBalanceCache();
            return Number.isFinite(latestBalanceCache.availableUSDT) ? latestBalanceCache.availableUSDT : 0;
        }
    };

    const getLastTradeTimestampFromLog = () => {
        try {
            if (!fs.existsSync(logPath)) return 0;
            const content = fs.readFileSync(logPath, "utf8");
            if (!content) return 0;
            const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
            if (lines.length <= 1) return 0;
            for (let i = lines.length - 1; i >= 1; i--) {
                const timestamp = String(lines[i]).split(",")[0];
                const parsed = Date.parse(timestamp);
                if (Number.isFinite(parsed)) return parsed;
            }
            return 0;
        } catch (error) {
            console.error("[MARKET][ERROR] Failed to read last trade timestamp:", error.message);
            return 0;
        }
    };

    const formatStatusTimestamp = (value) => (value > 0 ? new Date(value).toISOString() : "N/A");

    return {
        formatOrderSummary,
        getPrice,
        getOHLCV,
        getOrderBook,
        getRecentTrades,
        escapeCsvField,
        logTrade,
        extractUsdtBalanceSnapshot,
        getTotalUSDTBalance,
        getAvailableUSDTBalance,
        getLastTradeTimestampFromLog,
        formatStatusTimestamp
    };
};

module.exports = { createRuntimeMarketDataHelpers };
