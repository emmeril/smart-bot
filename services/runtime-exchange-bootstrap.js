const ccxt = require("ccxt");

const createRuntimeExchangeBootstrapHelpers = ({
    getDb,
    getExchange,
    setExchange,
    getAccountPositionMode,
    setAccountPositionMode,
    getLastAppliedLeverageState,
    setLastAppliedLeverageState,
    toFiniteNumber,
    sleep,
    extractExchangeErrorCode,
    isExchangeTimestampError,
    fetchOpenExchangePositions,
    fetchManagedOpenOrdersSnapshot,
    markExchangeUnhealthy
}) => {
    const validateExchangeCredentials = () => {
        const apiKey = String(process.env.API_KEY || "").trim();
        const apiSecret = String(process.env.API_SECRET || "").trim();
        if (!apiKey || !apiSecret) {
            throw new Error("Missing API_KEY or API_SECRET in .env");
        }
    };

    const initializeExchange = async () => {
        try {
            validateExchangeCredentials();
            const nextExchange = new ccxt.binanceusdm({
                apiKey: process.env.API_KEY,
                secret: process.env.API_SECRET,
                options: { defaultType: "future", adjustForTimeDifference: true },
                enableRateLimit: true,
                timeout: 20000,
                recvWindow: 10000
            });
            nextExchange.options.adjustForTimeDifference = true;

            const loadExchangeMetadata = async () => {
                await nextExchange.loadTimeDifference();
                await nextExchange.loadMarkets();
            };

            try {
                await loadExchangeMetadata();
            } catch (error) {
                if (!isExchangeTimestampError(error)) throw error;
                console.warn("[EXCHANGE][WARN] Exchange clock skew detected. Refreshing time difference and retrying...");
                await sleep(500);
                await loadExchangeMetadata();
            }

            setExchange(nextExchange);
            const timeDifference = toFiniteNumber(nextExchange.timeDifference, 0);
            console.log(`[EXCHANGE][INFO] Connected${timeDifference ? ` (time difference ${timeDifference}ms)` : ""}`);
            return nextExchange;
        } catch (error) {
            markExchangeUnhealthy(error, "exchange initialization");
            console.error("[EXCHANGE][ERROR] Connection failed:", error.message);
            throw error;
        }
    };

    const detectPositionMode = async () => {
        const exchange = getExchange();
        const db = getDb();
        try {
            const result = await exchange.fetchPositionMode(db?.pair, { subType: "linear" });
            const hedged = result?.hedged === true || result?.dualSidePosition === true;
            const accountPositionMode = { hedged, label: hedged ? "HEDGE" : "ONE_WAY" };
            setAccountPositionMode(accountPositionMode);
            console.log(`[EXCHANGE][INFO] Position mode detected: ${accountPositionMode.label}`);
            return accountPositionMode;
        } catch (error) {
            const fallbackMode = { hedged: false, label: "ONE_WAY" };
            setAccountPositionMode(fallbackMode);
            console.warn(`[EXCHANGE][WARN] Failed to detect position mode. Falling back to ONE_WAY. ${error.message}`);
            return fallbackMode;
        }
    };

    const setMarginMode = async () => {
        const exchange = getExchange();
        const db = getDb();
        try {
            if (!db) return false;
            const marginMode = (db.marginMode || "isolated").toLowerCase();
            const openPositions = await fetchOpenExchangePositions();
            if (openPositions.length > 0) {
                console.log(`[MARGIN][INFO] Margin mode update deferred: ${openPositions.length} position(s) open on ${db.pair}. Will apply when positions close.`);
                return false;
            }
            const managedOrders = await fetchManagedOpenOrdersSnapshot();
            if (managedOrders.triggerOrdersFetchFailed) {
                console.log(`[MARGIN][INFO] Margin mode update deferred: trigger orders unavailable on ${db.pair}. Will retry.`);
                return false;
            }
            const openOrderCount = managedOrders.grid.length + managedOrders.tp.length + managedOrders.sl.length;
            if (openOrderCount > 0) {
                console.log(`[MARGIN][INFO] Margin mode update deferred: ${openOrderCount} open managed order(s) on ${db.pair}. Will apply when orders clear.`);
                return false;
            }
            await exchange.setMarginMode(marginMode, db.pair);
            console.log(`[MARGIN][INFO] Margin mode set to: ${marginMode.toUpperCase()}`);
            return true;
        } catch (error) {
            const errorCode = extractExchangeErrorCode(error);
            const errorMessage = String(error?.message || error || "");
            if (!errorMessage.includes("No need to change margin mode") && errorCode !== -4067) {
                console.warn("[MARGIN][WARN] Margin mode warning:", errorMessage);
            }
            return false;
        }
    };

    const setLeverage = async () => {
        const exchange = getExchange();
        const db = getDb();
        try {
            if (!db) return false;
            const symbol = db.pair;
            const leverage = Math.max(1, Math.trunc(toFiniteNumber(db.leverage, 1)));
            if (!symbol) return false;

            const lastAppliedLeverageState = getLastAppliedLeverageState();
            if (lastAppliedLeverageState.symbol === symbol && lastAppliedLeverageState.leverage === leverage) return true;

            const openPositions = await fetchOpenExchangePositions();
            if (openPositions.length > 0) {
                console.log(`[LEVERAGE][INFO] Leverage update deferred: ${openPositions.length} position(s) open on ${symbol}. Will apply when positions close.`);
                return false;
            }

            const managedOrders = await fetchManagedOpenOrdersSnapshot();
            if (managedOrders.triggerOrdersFetchFailed) {
                console.log(`[LEVERAGE][INFO] Leverage update deferred: trigger orders unavailable on ${symbol}. Will retry.`);
                return false;
            }
            const openOrderCount = managedOrders.grid.length + managedOrders.tp.length + managedOrders.sl.length;
            if (openOrderCount > 0) {
                console.log(`[LEVERAGE][INFO] Leverage update deferred: ${openOrderCount} open managed order(s) on ${symbol}. Will apply when orders clear.`);
                return false;
            }

            await exchange.setLeverage(leverage, symbol);
            setLastAppliedLeverageState({ symbol, leverage });
            console.log(`[LEVERAGE][INFO] Leverage set to: ${leverage}x`);
            return true;
        } catch (error) {
            const errorCode = extractExchangeErrorCode(error);
            const errorMessage = String(error?.message || error || "");
            if (!errorMessage.includes("No need to change leverage") && errorCode !== -4028) {
                console.warn("[LEVERAGE][WARN] Leverage warning:", errorMessage);
            } else {
                setLastAppliedLeverageState({
                    symbol: db?.pair || "",
                    leverage: Math.max(1, Math.trunc(toFiniteNumber(db?.leverage, 1)))
                });
            }
            return false;
        }
    };

    return {
        validateExchangeCredentials,
        initializeExchange,
        detectPositionMode,
        setMarginMode,
        setLeverage
    };
};

module.exports = { createRuntimeExchangeBootstrapHelpers };
