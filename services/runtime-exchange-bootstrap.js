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
            const nextExchange = new ccxt.binance({
                apiKey: process.env.API_KEY,
                secret: process.env.API_SECRET,
                options: { defaultType: "spot", adjustForTimeDifference: true },
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
        const spotMode = { hedged: false, label: "SPOT" };
        setAccountPositionMode(spotMode);
        console.log("[EXCHANGE][INFO] Spot mode enabled (no hedge/position side state).");
        return spotMode;
    };

    const setMarginMode = async () => {
        console.log("[MARGIN][INFO] Spot trading mode: margin configuration skipped.");
        return true;
    };

    const setLeverage = async () => {
        const db = getDb();
        if (db?.pair) setLastAppliedLeverageState({ symbol: db.pair, leverage: 1 });
        console.log("[LEVERAGE][INFO] Spot trading mode: leverage fixed at 1x.");
        return true;
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
