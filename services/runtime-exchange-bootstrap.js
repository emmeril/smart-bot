const ccxt = require("ccxt");

const createRuntimeExchangeBootstrapHelpers = ({
    getDb,
    getExchange,
    setExchange,
    getAccountPositionMode,
    setAccountPositionMode,
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
                apiKey: String(process.env.API_KEY || "").trim(),
                secret: String(process.env.API_SECRET || "").trim(),
                options: {
                    defaultType: "spot",
                    adjustForTimeDifference: true,
                    fetchCurrencies: false,
                    recvWindow: 10000
                },
                enableRateLimit: true,
                timeout: 20000
            });
            nextExchange.options.adjustForTimeDifference = true;
            nextExchange.options.fetchCurrencies = false;
            nextExchange.options.recvWindow = 10000;

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

            try {
                await nextExchange.fetchBalance();
                nextExchange.options.smartBotPrivateAuthFailed = false;
            } catch (error) {
                nextExchange.options.smartBotPrivateAuthFailed = true;
                markExchangeUnhealthy(error, "private API authentication");
                console.error("[EXCHANGE][ERROR] Private API authentication failed. Verify API_KEY/API_SECRET belong to the same Binance account, are for the correct environment, and have spot trading/API permissions enabled.");
            }

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

    return {
        validateExchangeCredentials,
        initializeExchange,
        detectPositionMode,
        setMarginMode
    };
};

module.exports = { createRuntimeExchangeBootstrapHelpers };
