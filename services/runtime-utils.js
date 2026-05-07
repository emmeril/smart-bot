const fs = require("fs");
const path = require("path");

const createRuntimeUtils = ({
    getExchangeHealth,
    getLastRecoveryBlockLogAt,
    setLastRecoveryBlockLogAt,
    getIsPlacingOrder,
    getIsClosingPosition,
    getIsSyncingPosition
}) => {
    const getErrorStatus = (error) => {
        const candidates = [
            error?.status,
            error?.statusCode,
            error?.httpStatus,
            error?.response?.status,
            error?.response?.statusCode
        ];
        for (const candidate of candidates) {
            const parsed = Number(candidate);
            if (Number.isFinite(parsed)) return parsed;
        }
        return NaN;
    };

    const getRetryAfterMs = (error) => {
        const headers = error?.headers || error?.responseHeaders || error?.response?.headers || {};
        const retryAfter = headers["Retry-After"] || headers["retry-after"];
        const parsed = Number(retryAfter);
        return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : NaN;
    };

    const getExchangeErrorCode = (error) => {
        const directCode = Number(error?.code);
        if (Number.isFinite(directCode)) return directCode;
        const payload = String(error?.message || error || "");
        const match = payload.match(/"code"\s*:\s*(-?\d+)/);
        return match ? Number(match[1]) : NaN;
    };

    const isBinanceRateLimitError = (error) => {
        const status = getErrorStatus(error);
        const code = getExchangeErrorCode(error);
        const payload = String(error?.message || error || "");
        return status === 429 || status === 418 || code === -1003 || code === -1015 || /too many requests|too much request weight|ip banned|too many new orders/i.test(payload);
    };

    const retry = async (fn, retries = 3, delay = 1000) => {
        for (let i = 0; i < retries; i++) {
            try {
                return await fn();
            } catch (error) {
                if (i === retries - 1) throw error;
                const status = getErrorStatus(error);
                const rateLimited = isBinanceRateLimitError(error);
                const retryAfterMs = getRetryAfterMs(error);
                if (status === 418) {
                    const waitLabel = Number.isFinite(retryAfterMs) ? ` Retry-After=${Math.ceil(retryAfterMs / 1000)}s.` : "";
                    throw new Error(`Binance IP ban response received. Stop requests until the ban window expires.${waitLabel}`);
                }
                const nextDelay = rateLimited && Number.isFinite(retryAfterMs) ? retryAfterMs : delay;
                console.log(`[RETRY][INFO] Attempt ${i + 1} failed, retrying in ${nextDelay}ms${rateLimited ? " after Binance rate-limit response" : ""}...`);
                await new Promise((resolve) => setTimeout(resolve, nextDelay));
                delay = rateLimited ? Math.max(delay * 2, nextDelay) : delay * 2;
            }
        }
    };

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const toFiniteNumber = (value, fallback = 0) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    };

    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

    const getUTCDateKey = (timestamp) => {
        const parsed = toFiniteNumber(timestamp, NaN);
        return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "";
    };

    const isSameUTCDate = (leftTimestamp, rightTimestamp) => {
        const leftDateKey = getUTCDateKey(leftTimestamp);
        const rightDateKey = getUTCDateKey(rightTimestamp);
        return Boolean(leftDateKey) && leftDateKey === rightDateKey;
    };

    const markExchangeUnhealthy = (error, context = "exchange", options = {}) => {
        const exchangeHealth = getExchangeHealth();
        const { requireRecoverySync = true } = options;
        const errorMessage = String(error?.message || error || "Unknown error");
        const now = Date.now();
        exchangeHealth.isHealthy = false;
        exchangeHealth.lastFailureAt = now;
        exchangeHealth.lastError = errorMessage;
        exchangeHealth.lastContext = context;
        exchangeHealth.consecutiveFailures += 1;
        if (requireRecoverySync) exchangeHealth.needsRecoverySync = true;
        console.warn(`[RECOVERY][WARN] Exchange degraded during ${context}: ${errorMessage}`);
    };

    const markExchangeHealthy = (context = "exchange sync") => {
        const exchangeHealth = getExchangeHealth();
        const shouldLogRecovery = !exchangeHealth.isHealthy || exchangeHealth.needsRecoverySync || exchangeHealth.consecutiveFailures > 0;
        exchangeHealth.isHealthy = true;
        exchangeHealth.needsRecoverySync = false;
        exchangeHealth.consecutiveFailures = 0;
        exchangeHealth.lastRecoveryAt = Date.now();
        exchangeHealth.lastError = "";
        exchangeHealth.lastContext = context;
        if (shouldLogRecovery) {
            console.log(`[RECOVERY][INFO] Exchange healthy again after ${context}. Trading entries resumed.`);
        }
    };

    const getExchangeRecoveryReason = () => {
        const exchangeHealth = getExchangeHealth();
        if (!exchangeHealth.isHealthy && exchangeHealth.lastError) return exchangeHealth.lastError;
        if (exchangeHealth.needsRecoverySync) return "Waiting for successful recovery sync";
        if (!exchangeHealth.isHealthy) return "Exchange connection is degraded";
        return "";
    };

    const canOpenNewPositions = () => {
        const exchangeHealth = getExchangeHealth();
        return exchangeHealth.isHealthy && !exchangeHealth.needsRecoverySync;
    };

    const logExchangeRecoveryBlock = (context = "trading") => {
        const now = Date.now();
        if (now - getLastRecoveryBlockLogAt() < 10000) return;
        const reason = getExchangeRecoveryReason();
        console.warn(`[RECOVERY][WARN] Pausing ${context}. ${reason || "Exchange recovery is still in progress."}`);
        setLastRecoveryBlockLogAt(now);
    };

    const hasRuntimePositionMutationInFlight = () => (
        getIsPlacingOrder() ||
        getIsClosingPosition() ||
        getIsSyncingPosition()
    );

    const withSqliteBusyRetry = async (fn, { attempts = 5, delayMs = 150 } = {}) => {
        let lastError = null;
        for (let attempt = 0; attempt < attempts; attempt++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                const message = String(error?.message || error);
                const isBusy = message.includes("SQLITE_BUSY") || message.includes("database is locked");
                if (!isBusy || attempt === attempts - 1) throw error;
                await sleep(delayMs);
            }
        }
        throw lastError;
    };

    const ensureFileExists = (filePath, defaultContent = "{}") => {
        try {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            if (!fs.existsSync(filePath)) {
                fs.writeFileSync(filePath, defaultContent, "utf8");
                console.log(`[FILE][INFO] Created ${path.basename(filePath)} file`);
            }
            return true;
        } catch (error) {
            console.error(`[FILE][ERROR] Failed to create ${path.basename(filePath)}:`, error.message);
            return false;
        }
    };

    return {
        retry,
        sleep,
        toFiniteNumber,
        clamp,
        getUTCDateKey,
        isSameUTCDate,
        markExchangeUnhealthy,
        markExchangeHealthy,
        getExchangeRecoveryReason,
        canOpenNewPositions,
        logExchangeRecoveryBlock,
        hasRuntimePositionMutationInFlight,
        withSqliteBusyRetry,
        ensureFileExists
    };
};

module.exports = { createRuntimeUtils };
