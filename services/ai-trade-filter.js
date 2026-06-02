const DEFAULT_GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_AI_PROVIDER = "gemini";
const AI_CACHE_SCHEMA_VERSION = 2;
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_CACHE_TTL_MS = 60000;
const DEFAULT_MAX_OUTPUT_TOKENS = 2000;
const DEFAULT_GRID_REVIEW_MIN_INTERVAL_MS = 15000;
const DEFAULT_GRID_REJECT_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_MIN_INTERVAL_MS = 1200;
const DEFAULT_RETRY_BASE_DELAY_MS = 3000;
const DEFAULT_RETRY_MAX_DELAY_MS = 60000;

const truthy = (value) => ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());

const withTimeout = async (promiseFactory, timeoutMs) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await promiseFactory(controller.signal);
    } finally {
        clearTimeout(timeout);
    }
};

const sleepWithAbort = async (delayMs, signal) => {
    const safeDelayMs = Math.max(0, Math.trunc(safeNumber(delayMs, 0)));
    if (safeDelayMs <= 0) return;
    if (signal?.aborted) throw new Error("AI request aborted");
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, safeDelayMs);
        const abort = () => {
            clearTimeout(timeout);
            reject(new Error("AI request aborted"));
        };
        if (signal) signal.addEventListener("abort", abort, { once: true });
    });
};

const safeNumber = (value, fallback = null) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const parseRetryAfterMs = (value, now = Date.now()) => {
    const rawValue = String(value || "").trim();
    if (!rawValue) return NaN;
    const seconds = Number(rawValue);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const retryDate = Date.parse(rawValue);
    return Number.isFinite(retryDate) ? Math.max(0, retryDate - now) : NaN;
};

const normalizeForSignature = (value, precision = 5) => {
    const numeric = safeNumber(value, null);
    if (!Number.isFinite(numeric)) return null;
    return Number(numeric.toFixed(precision));
};

const compactOrder = (order) => ({
    clientOrderId: String(order?.clientOrderId || ""),
    side: String(order?.side || ""),
    price: safeNumber(order?.price),
    orderSizeUsdt: safeNumber(order?.orderSizeUsdt),
    targetPrice: safeNumber(order?.targetPrice),
    stopLossPrice: safeNumber(order?.stopLossPrice),
    levelIndex: safeNumber(order?.levelIndex)
});

const compactSnapshot = (snapshot) => ({
    currentPrice: safeNumber(snapshot?.currentPrice),
    currentOpen: safeNumber(snapshot?.currentOpen),
    currentVolume: safeNumber(snapshot?.currentVolume),
    avgVolume: safeNumber(snapshot?.avgVolume),
    currentATR: safeNumber(snapshot?.currentATR),
    currentNatrPercent: safeNumber(snapshot?.currentNatrPercent),
    volumeRatio: safeNumber(snapshot?.volumeRatio),
    currentStdDev: safeNumber(snapshot?.currentStdDev),
    currentRsi: safeNumber(snapshot?.currentRsi),
    currentAdx: safeNumber(snapshot?.currentAdx),
    bbBasis: safeNumber(snapshot?.bbBasis),
    bbUpper: safeNumber(snapshot?.bbUpper),
    bbLower: safeNumber(snapshot?.bbLower),
    bbWidth: safeNumber(snapshot?.bbWidth),
    bbPercentB: safeNumber(snapshot?.bbPercentB),
    macdHistogram: safeNumber(snapshot?.macdHistogram),
    hourUTC: safeNumber(snapshot?.hourUTC)
});

const compactSignalDecision = (signal = {}) => ({
    canLong: Boolean(signal?.canLong),
    canShort: Boolean(signal?.canShort),
    hasSignal: Boolean(signal?.hasSignal),
    strategy: String(signal?.strategy || signal?.strategyName || ""),
    price: safeNumber(signal?.price),
    atr: safeNumber(signal?.atr),
    targetPrice: safeNumber(signal?.targetPrice),
    stopLossPrice: safeNumber(signal?.stopLossPrice),
    exitOptimization: signal?.exitOptimization ? {
        enabled: Boolean(signal.exitOptimization.enabled),
        currentPrice: safeNumber(signal.exitOptimization.currentPrice),
        candidate: {
            tpAtr: safeNumber(signal.exitOptimization?.candidate?.tpAtr),
            slAtr: safeNumber(signal.exitOptimization?.candidate?.slAtr),
            trailingActivateATR: safeNumber(signal.exitOptimization?.candidate?.trailingActivateATR),
            trailingOffsetATR: safeNumber(signal.exitOptimization?.candidate?.trailingOffsetATR)
        },
        regime: {
            zScore: safeNumber(signal.exitOptimization?.regime?.zScore),
            volatilityPercentile: safeNumber(signal.exitOptimization?.regime?.volatilityPercentile)
        }
    } : null,
    riskOverrides: signal?.riskOverrides ? {
        coolingPeriod: safeNumber(signal.riskOverrides?.coolingPeriod),
        gridStopLossPercent: safeNumber(signal.riskOverrides?.gridStopLossPercent)
    } : null
});

const compactOrderBookSnapshot = (orderBook = {}) => {
    const bestBidPrice = safeNumber(orderBook?.bids?.[0]?.[0]);
    const bestBidSize = safeNumber(orderBook?.bids?.[0]?.[1]);
    const bestAskPrice = safeNumber(orderBook?.asks?.[0]?.[0]);
    const bestAskSize = safeNumber(orderBook?.asks?.[0]?.[1]);
    const spread = Number.isFinite(bestBidPrice) && Number.isFinite(bestAskPrice)
        ? bestAskPrice - bestBidPrice
        : null;
    return {
        bestBidPrice,
        bestBidSize,
        bestAskPrice,
        bestAskSize,
        spread
    };
};

const compactLiquiditySnapshot = (liquiditySnapshot = {}) => {
    const orderBook = compactOrderBookSnapshot(liquiditySnapshot?.orderBook);
    const trades = Array.isArray(liquiditySnapshot?.trades) ? liquiditySnapshot.trades : [];
    const buyTrades = trades.filter((trade) => String(trade?.side || "").toLowerCase() === "buy");
    const sellTrades = trades.filter((trade) => String(trade?.side || "").toLowerCase() === "sell");
    const summarizeTradeVolume = (items) => items.reduce((sum, trade) => sum + Math.abs(safeNumber(trade?.amount ?? trade?.size, 0)), 0);
    return {
        orderBook,
        trades: {
            sampleCount: trades.length,
            buyCount: buyTrades.length,
            sellCount: sellTrades.length,
            buyVolume: summarizeTradeVolume(buyTrades),
            sellVolume: summarizeTradeVolume(sellTrades)
        }
    };
};

const normalizeOrderSide = (side) => String(side || "").trim().toLowerCase();

const createPrefilterResult = (reason) => ({
    approved: false,
    skipped: true,
    prefiltered: true,
    confidence: 1,
    reason: String(reason || "Prefilter rejected setup")
});

const isFinitePositive = (value) => Number.isFinite(value) && value > 0;

const isSessionOpen = (hourUTC, startUTC, endUTC) => {
    if (!Number.isFinite(hourUTC) || !Number.isFinite(startUTC) || !Number.isFinite(endUTC)) return true;
    return startUTC <= endUTC
        ? hourUTC >= startUTC && hourUTC <= endUTC
        : hourUTC >= startUTC || hourUTC <= endUTC;
};

const evaluateSignalPrefilter = ({ db, side, signal }) => {
    const normalizedSide = normalizeOrderSide(side);
    if (!["buy", "sell"].includes(normalizedSide)) {
        return createPrefilterResult(`Unsupported signal side: ${String(side || "N/A")}`);
    }

    const market = signal?.marketContext || signal || {};
    const price = safeNumber(market?.currentPrice, safeNumber(signal?.price, NaN));
    const atr = safeNumber(market?.currentATR, safeNumber(signal?.atr, NaN));
    const targetPrice = safeNumber(signal?.targetPrice, NaN);
    const stopLossPrice = safeNumber(signal?.stopLossPrice, NaN);
    if (!isFinitePositive(price) || !isFinitePositive(atr)) {
        return createPrefilterResult("Invalid signal price or ATR");
    }
    if (!isFinitePositive(targetPrice) || !isFinitePositive(stopLossPrice)) {
        return createPrefilterResult("Invalid target or stop loss");
    }

    const longDirectionOk = targetPrice > price && stopLossPrice < price;
    const shortDirectionOk = targetPrice < price && stopLossPrice > price;
    if (normalizedSide === "buy" && !longDirectionOk) {
        return createPrefilterResult("Buy TP/SL is not directional");
    }
    if (normalizedSide === "sell" && !shortDirectionOk) {
        return createPrefilterResult("Sell TP/SL is not directional");
    }
    if (signal?.hasSignal === false) {
        return createPrefilterResult("Signal setup was not confirmed");
    }
    if (normalizedSide === "buy" && signal?.canLong === false) {
        return createPrefilterResult("Long signal is not available");
    }
    if (normalizedSide === "sell" && signal?.canShort === false) {
        return createPrefilterResult("Short signal is not available");
    }

    const volumeRatio = safeNumber(market?.volumeRatio, NaN);
    const minVolumeRatio = safeNumber(db?.minVolumeRatio, NaN);
    if (Number.isFinite(volumeRatio) && Number.isFinite(minVolumeRatio) && volumeRatio < minVolumeRatio) {
        return createPrefilterResult(`Volume ratio below minimum (${volumeRatio.toFixed(2)}x < ${minVolumeRatio.toFixed(2)}x)`);
    }

    const currentAdx = safeNumber(market?.currentAdx, NaN);
    const entryAdxMax = safeNumber(db?.entryAdxMax, NaN);
    if (Number.isFinite(currentAdx) && Number.isFinite(entryAdxMax) && currentAdx > entryAdxMax) {
        return createPrefilterResult(`ADX too strong (${currentAdx.toFixed(2)} > ${entryAdxMax.toFixed(2)})`);
    }

    const currentRsi = safeNumber(market?.currentRsi, NaN);
    const entryRsiLongThreshold = safeNumber(db?.entryRsiLongThreshold, NaN);
    const entryRsiShortThreshold = safeNumber(db?.entryRsiShortThreshold, NaN);
    if (normalizedSide === "buy" && Number.isFinite(currentRsi) && Number.isFinite(entryRsiLongThreshold) && currentRsi > entryRsiLongThreshold) {
        return createPrefilterResult(`RSI too hot for long (${currentRsi.toFixed(2)} > ${entryRsiLongThreshold.toFixed(2)})`);
    }
    if (normalizedSide === "sell" && Number.isFinite(currentRsi) && Number.isFinite(entryRsiShortThreshold) && currentRsi < entryRsiShortThreshold) {
        return createPrefilterResult(`RSI too weak for short (${currentRsi.toFixed(2)} < ${entryRsiShortThreshold.toFixed(2)})`);
    }

    const bbPercentB = safeNumber(market?.bbPercentB, NaN);
    const entryBbLongThreshold = safeNumber(db?.entryBbLongThreshold, NaN);
    const entryBbShortThreshold = safeNumber(db?.entryBbShortThreshold, NaN);
    if (normalizedSide === "buy" && Number.isFinite(bbPercentB) && Number.isFinite(entryBbLongThreshold) && bbPercentB > entryBbLongThreshold) {
        return createPrefilterResult(`Bollinger %B too high for long (${bbPercentB.toFixed(3)} > ${entryBbLongThreshold.toFixed(3)})`);
    }
    if (normalizedSide === "sell" && Number.isFinite(bbPercentB) && Number.isFinite(entryBbShortThreshold) && bbPercentB < entryBbShortThreshold) {
        return createPrefilterResult(`Bollinger %B too low for short (${bbPercentB.toFixed(3)} < ${entryBbShortThreshold.toFixed(3)})`);
    }

    const currentHourUTC = safeNumber(market?.hourUTC, NaN);
    const sessionStartUTC = safeNumber(db?.sessionStartUTC, NaN);
    const sessionEndUTC = safeNumber(db?.sessionEndUTC, NaN);
    if (!isSessionOpen(currentHourUTC, sessionStartUTC, sessionEndUTC)) {
        return createPrefilterResult(`Session closed at UTC hour ${Number.isFinite(currentHourUTC) ? currentHourUTC : "N/A"}`);
    }

    const macdHistogram = safeNumber(market?.macdHistogram, NaN);
    if (normalizedSide === "buy" && Number.isFinite(macdHistogram) && macdHistogram < 0) {
        return createPrefilterResult("MACD histogram is bearish for long");
    }
    if (normalizedSide === "sell" && Number.isFinite(macdHistogram) && macdHistogram > 0) {
        return createPrefilterResult("MACD histogram is bullish for short");
    }

    return null;
};

const evaluateGridOrderPrefilter = ({ snapshot, gridState, desiredOrders }) => {
    const currentPrice = safeNumber(snapshot?.currentPrice, NaN);
    const lowerBound = safeNumber(gridState?.lowerBound, NaN);
    const upperBound = safeNumber(gridState?.upperBound, NaN);
    const acceptedOrders = [];
    const rejectedOrders = [];

    for (const order of Array.isArray(desiredOrders) ? desiredOrders : []) {
        const clientOrderId = String(order?.clientOrderId || "").trim();
        const side = normalizeOrderSide(order?.side);
        const price = safeNumber(order?.price, NaN);
        const targetPrice = safeNumber(order?.targetPrice, NaN);
        const stopLossPrice = safeNumber(order?.stopLossPrice, NaN);
        const orderSizeUsdt = safeNumber(order?.orderSizeUsdt, NaN);
        let rejectionReason = "";

        if (!clientOrderId) rejectionReason = "Missing client order id";
        else if (!["buy", "sell"].includes(side)) rejectionReason = `Unsupported grid side: ${String(order?.side || "N/A")}`;
        else if (!isFinitePositive(price)) rejectionReason = "Invalid grid entry price";
        else if (!isFinitePositive(orderSizeUsdt)) rejectionReason = "Invalid grid order size";
        else if (!isFinitePositive(targetPrice) || !isFinitePositive(stopLossPrice)) rejectionReason = "Invalid grid TP/SL";
        else if (side === "buy" && !(targetPrice > price && stopLossPrice < price)) rejectionReason = "Buy grid TP/SL is not directional";
        else if (side === "sell" && !(targetPrice < price && stopLossPrice > price)) rejectionReason = "Sell grid TP/SL is not directional";
        else if (Number.isFinite(currentPrice) && side === "buy" && price >= currentPrice) rejectionReason = "Buy grid entry is not below market";
        else if (Number.isFinite(currentPrice) && side === "sell" && price <= currentPrice) rejectionReason = "Sell grid entry is not above market";
        else if (Number.isFinite(lowerBound) && price < lowerBound) rejectionReason = "Grid entry is below the range";
        else if (Number.isFinite(upperBound) && price > upperBound) rejectionReason = "Grid entry is above the range";

        if (rejectionReason) {
            rejectedOrders.push({ order, reason: rejectionReason });
            continue;
        }

        acceptedOrders.push(order);
    }

    return {
        acceptedOrders,
        rejectedOrders
    };
};

const isNonEmptyReason = (reason) => {
    const text = String(reason || "").trim();
    return text.length > 0;
};

const validateSignalReviewResult = (result) => {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new Error("AI response must be a JSON object");
    }
    const confidence = safeNumber(result?.confidence, NaN);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw new Error("AI response confidence is invalid");
    }
    if (typeof result?.approved !== "boolean") {
        throw new Error("AI response approved flag is invalid");
    }
    if (!isNonEmptyReason(result?.reason)) {
        throw new Error("AI response reason is missing");
    }
    return {
        approved: Boolean(result.approved),
        confidence,
        reason: String(result.reason).trim()
    };
};

const validateGridReviewResult = (result, reviewableOrders = []) => {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new Error("AI grid response must be a JSON object");
    }
    const orderDecisions = Array.isArray(result?.orderDecisions) ? result.orderDecisions : null;
    if (!orderDecisions) {
        throw new Error("AI grid response is missing orderDecisions");
    }
    if (orderDecisions.length !== reviewableOrders.length) {
        throw new Error("AI grid response decision count does not match reviewable orders");
    }
    const reviewableIds = new Set(reviewableOrders.map((order) => String(order?.clientOrderId || "")));
    const seenIds = new Set();
    const normalizedDecisions = [];
    for (const decision of orderDecisions) {
        if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
            throw new Error("AI grid decision must be an object");
        }
        const clientOrderId = String(decision?.clientOrderId || "").trim();
        if (!clientOrderId || !reviewableIds.has(clientOrderId)) {
            throw new Error(`AI grid decision references unknown order ${clientOrderId || "N/A"}`);
        }
        if (seenIds.has(clientOrderId)) {
            throw new Error(`AI grid decision duplicated order ${clientOrderId}`);
        }
        const confidence = safeNumber(decision?.confidence, NaN);
        if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
            throw new Error(`AI grid decision confidence is invalid for ${clientOrderId}`);
        }
        if (typeof decision?.approved !== "boolean") {
            throw new Error(`AI grid decision approved flag is invalid for ${clientOrderId}`);
        }
        if (!isNonEmptyReason(decision?.reason)) {
            throw new Error(`AI grid decision reason is missing for ${clientOrderId}`);
        }
        seenIds.add(clientOrderId);
        normalizedDecisions.push({
            clientOrderId,
            approved: Boolean(decision.approved),
            confidence,
            reason: String(decision.reason).trim()
        });
    }
    if (seenIds.size !== reviewableOrders.length) {
        throw new Error("AI grid response does not cover every reviewable order");
    }
    return normalizedDecisions;
};

const splitKeyList = (value) => String(value || "")
    .split(/[\n,;]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

const uniqueStrings = (values) => {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        const normalized = String(value || "").trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
};

const collectGeminiApiKeys = ({ apiKey } = {}) => {
    const envIndexedKeys = Object.entries(process.env)
        .filter(([key]) => /^GEMINI_API_KEY_\d+$/.test(key))
        .sort(([leftKey], [rightKey]) => {
            const leftIndex = Number.parseInt(leftKey.split("_").pop(), 10);
            const rightIndex = Number.parseInt(rightKey.split("_").pop(), 10);
            return leftIndex - rightIndex;
        })
        .flatMap(([, value]) => splitKeyList(value));

    return uniqueStrings([
        ...splitKeyList(apiKey),
        ...splitKeyList(process.env.GEMINI_API_KEYS),
        ...splitKeyList(process.env.GEMINI_API_KEY),
        ...envIndexedKeys
    ]);
};

const extractGeminiResponseText = (payload) => {
    const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
    for (const candidate of candidates) {
        const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
        for (const part of parts) {
            if (typeof part?.text === "string") return part.text;
        }
    }
    return "";
};

const parseJsonObject = (text) => {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        const match = String(text).match(/\{[\s\S]*\}/);
        return match ? JSON.parse(match[0]) : null;
    }
};

const normalizeProviderName = (value) => {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) return DEFAULT_AI_PROVIDER;
    if (["gemini", "google", "google-gemini", "google_ai", "google-ai"].includes(normalized)) return "gemini";
    return normalized;
};

const createGeminiProvider = ({
    apiKeys,
    endpoint,
    model,
    fetchFn,
    outputTokenLimit,
    instructions,
    requestMinIntervalMs,
    retryBaseDelayMs,
    retryMaxDelayMs
}) => {
    const keyBackoffs = new Map();
    let nextRequestAt = 0;
    let requestQueue = Promise.resolve();

    const buildUrl = () => {
        const base = String(endpoint || DEFAULT_GEMINI_ENDPOINT).replace(/\/$/, "");
        if (base.includes(":generateContent")) return base;
        return `${base}/${model}:generateContent`;
    };

    const isRetryableError = (error) => {
        const status = Number(error?.status);
        if (!Number.isFinite(status)) return true;
        return [401, 403, 408, 429, 500, 502, 503, 504].includes(status);
    };

    const getRetryAfterMs = (response) => {
        const retryAfter = typeof response?.headers?.get === "function" ? response.headers.get("retry-after") : "";
        return parseRetryAfterMs(retryAfter);
    };

    const getKeyBackoff = (apiKey, now = Date.now()) => {
        const backoff = keyBackoffs.get(apiKey);
        if (!backoff) return null;
        if (!Number.isFinite(backoff.until) || backoff.until <= now) {
            keyBackoffs.delete(apiKey);
            return null;
        }
        return backoff;
    };

    const markKeyBackoff = (apiKey, error, now = Date.now()) => {
        if (!apiKey || !isRetryableError(error)) return null;
        const previous = keyBackoffs.get(apiKey);
        const failures = Math.max(1, Math.trunc(safeNumber(previous?.failures, 0)) + 1);
        const exponentialDelay = Math.min(
            Math.max(0, retryMaxDelayMs),
            Math.max(0, retryBaseDelayMs) * (2 ** Math.min(failures - 1, 5))
        );
        const retryAfterDelay = safeNumber(error?.retryAfterMs, NaN);
        const delayMs = Number.isFinite(retryAfterDelay)
            ? Math.min(Math.max(0, retryMaxDelayMs), Math.max(exponentialDelay, retryAfterDelay))
            : exponentialDelay;
        const record = {
            until: now + delayMs,
            failures,
            status: safeNumber(error?.status, null)
        };
        if (delayMs > 0) keyBackoffs.set(apiKey, record);
        return record;
    };

    const clearKeyBackoff = (apiKey) => {
        if (apiKey) keyBackoffs.delete(apiKey);
    };

    const waitForGlobalPacing = async (signal) => {
        const now = Date.now();
        const waitMs = Math.max(0, nextRequestAt - now);
        if (waitMs > 0) await sleepWithAbort(waitMs, signal);
        nextRequestAt = Date.now() + requestMinIntervalMs;
    };

    const runQueued = async (task) => {
        const previous = requestQueue.catch(() => {});
        let releaseQueue = null;
        requestQueue = new Promise((resolve) => { releaseQueue = resolve; });
        await previous;
        try {
            return await task();
        } finally {
            releaseQueue();
        }
    };

    const callGemini = async ({ schema, payload, signal, apiKey }) => {
        await waitForGlobalPacing(signal);
        const response = await fetchFn(buildUrl(), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": apiKey
            },
            signal,
            body: JSON.stringify({
                systemInstruction: {
                    parts: [{ text: instructions }]
                },
                contents: [{
                    role: "user",
                    parts: [{ text: JSON.stringify(payload) }]
                }],
                generationConfig: {
                    responseMimeType: "application/json",
                    responseJsonSchema: schema.schema,
                    maxOutputTokens: outputTokenLimit
                }
            })
        });

        if (!response.ok) {
            const body = await response.text().catch(() => "");
            const error = new Error(`Gemini ${response.status}: ${body.slice(0, 200)}`);
            error.status = response.status;
            error.retryAfterMs = getRetryAfterMs(response);
            throw error;
        }

        const parsedResponse = await response.json();
        return parseJsonObject(extractGeminiResponseText(parsedResponse));
    };

    const callStructuredJson = async ({ schema, payload, signal }) => {
        return await runQueued(async () => {
            const keys = apiKeys.length > 0 ? apiKeys : [""];
            let lastError = null;
            let skippedBackoffCount = 0;
            for (let i = 0; i < keys.length; i++) {
                const apiKey = keys[i];
                const keyBackoff = getKeyBackoff(apiKey);
                if (keyBackoff) {
                    skippedBackoffCount += 1;
                    continue;
                }
                try {
                    const result = await callGemini({ schema, payload, signal, apiKey });
                    clearKeyBackoff(apiKey);
                    return result;
                } catch (error) {
                    lastError = error;
                    const backoffRecord = markKeyBackoff(apiKey, error);
                    const hasMoreKeys = i < keys.length - 1;
                    if (!hasMoreKeys || !isRetryableError(error)) break;
                    const backoffText = backoffRecord
                        ? ` Backing off key for ${Math.ceil((backoffRecord.until - Date.now()) / 1000)}s.`
                        : "";
                    console.warn(`[AI][WARN] Gemini key ${i + 1} failed: ${error.message}.${backoffText} Trying backup key.`);
                }
            }
            if (skippedBackoffCount > 0) {
                console.warn(`[AI][WARN] Skipped ${skippedBackoffCount} Gemini key(s) still in backoff.`);
            }
            throw lastError || new Error("Gemini request failed; every key is cooling down");
        });
    };

    return {
        name: "gemini",
        isReady: () => Boolean(apiKeys.length > 0 && typeof fetchFn === "function"),
        callStructuredJson
    };
};

const createAiTradeFilter = ({
    provider,
    apiKey,
    endpoint,
    model,
    apiProvider = process.env.AI_PROVIDER,
    enabled = process.env.AI_SIGNAL_FILTER_ENABLED,
    failOpen = process.env.AI_SIGNAL_FILTER_FAIL_OPEN,
    minConfidence = process.env.AI_SIGNAL_MIN_CONFIDENCE,
    timeoutMs = process.env.AI_SIGNAL_TIMEOUT_MS,
    cacheTtlMs = process.env.AI_SIGNAL_CACHE_TTL_MS,
    maxOutputTokens = process.env.AI_SIGNAL_MAX_OUTPUT_TOKENS,
    gridReviewMinIntervalMs = process.env.AI_GRID_REVIEW_MIN_INTERVAL_MS,
    gridRejectCooldownMs = process.env.AI_GRID_REJECT_COOLDOWN_MS,
    requestMinIntervalMs = process.env.AI_REQUEST_MIN_INTERVAL_MS,
    retryBaseDelayMs = process.env.AI_RETRY_BASE_DELAY_MS,
    retryMaxDelayMs = process.env.AI_RETRY_MAX_DELAY_MS,
    fetchFn = globalThis.fetch
} = {}) => {
    const resolvedProviderName = normalizeProviderName(provider || apiProvider);
    const resolvedApiKeys = collectGeminiApiKeys({ apiKey });
    const resolvedEndpoint = endpoint || (process.env.GEMINI_API_ENDPOINT || DEFAULT_GEMINI_ENDPOINT);
    const resolvedModel = model || (process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL);
    const shouldUseAi = truthy(enabled);
    const failOpenOnError = truthy(failOpen);
    const confidenceFloor = Math.min(Math.max(safeNumber(minConfidence, 0.65), 0), 1);
    const requestTimeoutMs = Math.max(1000, Math.trunc(safeNumber(timeoutMs, DEFAULT_TIMEOUT_MS)));
    const cacheWindowMs = Math.max(0, Math.trunc(safeNumber(cacheTtlMs, DEFAULT_CACHE_TTL_MS)));
    const outputTokenLimit = Math.max(500, Math.trunc(safeNumber(maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS)));
    const gridReviewCooldownMs = Math.max(0, Math.trunc(safeNumber(gridReviewMinIntervalMs, DEFAULT_GRID_REVIEW_MIN_INTERVAL_MS)));
    const gridRejectCooldownWindowMs = Math.max(0, Math.trunc(safeNumber(gridRejectCooldownMs, DEFAULT_GRID_REJECT_COOLDOWN_MS)));
    const aiRequestMinIntervalMs = Math.max(0, Math.trunc(safeNumber(requestMinIntervalMs, DEFAULT_REQUEST_MIN_INTERVAL_MS)));
    const aiRetryBaseDelayMs = Math.max(0, Math.trunc(safeNumber(retryBaseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS)));
    const aiRetryMaxDelayMs = Math.max(aiRetryBaseDelayMs, Math.trunc(safeNumber(retryMaxDelayMs, DEFAULT_RETRY_MAX_DELAY_MS)));
    const cache = new Map();
    const gridRejectedOrderCooldowns = new Map();
    const cacheScope = JSON.stringify({
        version: AI_CACHE_SCHEMA_VERSION,
        provider: resolvedProviderName,
        model: resolvedModel,
        endpoint: resolvedEndpoint,
        confidenceFloor,
        outputTokenLimit,
        aiRequestMinIntervalMs
    });
    let lastGridReviewAt = 0;
    let lastGridReviewSignature = "";
    let lastGridReviewResult = null;
    const instructions = [
        "You are a conservative trading risk filter for an automated spot crypto bot.",
        "Use only the supplied quantitative data. Do not browse, predict news, or invent missing data.",
        "Approve only when the proposed trade is coherent with the indicators and TP/SL plan.",
        "If the setup is unclear, risky, contradictory, or malformed, reject it.",
        "Keep every reason short, ideally under 12 words."
    ].join(" ");
    const providerRegistry = {
        gemini: createGeminiProvider({
            apiKeys: resolvedApiKeys,
            endpoint: resolvedEndpoint,
            model: resolvedModel,
            fetchFn,
            outputTokenLimit,
            instructions,
            requestMinIntervalMs: aiRequestMinIntervalMs,
            retryBaseDelayMs: aiRetryBaseDelayMs,
            retryMaxDelayMs: aiRetryMaxDelayMs
        })
    };
    const providerClient = providerRegistry[resolvedProviderName] || null;

    if (!providerClient) {
        console.warn(`[AI][WARN] Unsupported AI provider "${resolvedProviderName}". AI filter disabled.`);
    }

    const isEnabled = () => Boolean(shouldUseAi && providerClient && providerClient.isReady());
    const logAiTrace = (tag, message) => {
        console.log(`[AI][${tag}] ${message}`);
    };

    const pruneExpiredGridOrderCooldowns = (now = Date.now()) => {
        for (const [clientOrderId, record] of gridRejectedOrderCooldowns.entries()) {
            if (!record || !Number.isFinite(record.until) || record.until <= now) {
                gridRejectedOrderCooldowns.delete(clientOrderId);
            }
        }
    };

    const getGridOrderCooldownRecord = (clientOrderId, now = Date.now()) => {
        if (!clientOrderId) return null;
        const record = gridRejectedOrderCooldowns.get(clientOrderId);
        if (!record) return null;
        if (!Number.isFinite(record.until) || record.until <= now) {
            gridRejectedOrderCooldowns.delete(clientOrderId);
            return null;
        }
        return record;
    };

    const markRejectedGridOrderCooldown = (order, reason, now = Date.now()) => {
        const clientOrderId = String(order?.clientOrderId || "");
        if (!clientOrderId || gridRejectCooldownWindowMs <= 0) return null;
        const previousRecord = gridRejectedOrderCooldowns.get(clientOrderId);
        const rejectCount = Math.max(1, Math.trunc(safeNumber(previousRecord?.rejectCount, 0)) + 1);
        const backoffMultiplier = Math.min(3, Math.max(1, rejectCount));
        const cooldownMs = Math.min(gridRejectCooldownWindowMs * backoffMultiplier, gridRejectCooldownWindowMs * 3);
        const nextRecord = {
            until: now + cooldownMs,
            rejectCount,
            lastRejectedAt: now,
            reason: String(reason || "rejected")
        };
        gridRejectedOrderCooldowns.set(clientOrderId, nextRecord);
        return nextRecord;
    };

    const callModel = async ({ schema, payload, cacheKey }) => {
        if (!isEnabled()) {
            logAiTrace("SKIP", `${schema?.name || "unknown"} AI disabled`);
            return null;
        }
        const now = Date.now();
        const scopedCacheKey = `${cacheScope}:${cacheKey}`;
        const cached = cache.get(scopedCacheKey);
        if (cached && now - cached.at <= cacheWindowMs) {
            logAiTrace("CACHE", `${schema?.name || "unknown"} cache hit (${now - cached.at}ms old)`);
            return cached.value;
        }

        logAiTrace("CALL", `${schema?.name || "unknown"} request -> ${resolvedProviderName}/${resolvedModel}`);
        const parsedJson = await withTimeout(async (signal) => {
            return await providerClient.callStructuredJson({ schema, payload, signal });
        }, requestTimeoutMs);
        cache.set(scopedCacheKey, { at: now, value: parsedJson });
        logAiTrace("CALL", `${schema?.name || "unknown"} response cached`);
        return parsedJson;
    };

    const reviewSignal = async ({ db, side, signal }) => {
        if (!isEnabled()) return { approved: true, skipped: true, reason: "AI filter disabled" };
        const prefilter = evaluateSignalPrefilter({ db, side, signal });
        if (prefilter) {
            logAiTrace("SKIP", `signal prefilter rejected: ${prefilter.reason}`);
            return prefilter;
        }
        const payload = {
            type: "market_signal_review",
            pair: db?.pair,
            strategy: signal?.strategy,
            side,
            market: compactSnapshot(signal?.marketContext || signal),
            liquidity: signal?.liquiditySnapshot ? compactLiquiditySnapshot(signal.liquiditySnapshot) : null,
            orderFlow: signal?.orderFlow ? {
                orderFlowImbalance: safeNumber(signal.orderFlow?.orderFlowImbalance),
                absorptionScore: safeNumber(signal.orderFlow?.absorptionScore),
                shortHorizonATR: safeNumber(signal.orderFlow?.shortHorizonATR),
                mediumHorizonATR: safeNumber(signal.orderFlow?.mediumHorizonATR)
            } : null,
            signal: compactSignalDecision(signal),
            risk: {
                orderSizeUsdt: safeNumber(db?.gridOrderSizeUsdt),
                dailyTrades: safeNumber(db?.dailyTrades),
                marginMode: db?.marginMode
            }
        };

        try {
            const result = validateSignalReviewResult(await callModel({
                cacheKey: `signal:${JSON.stringify(payload)}`,
                payload,
                schema: {
                    name: "trade_signal_review",
                    schema: {
                        type: "object",
                        additionalProperties: false,
                        required: ["approved", "confidence", "reason"],
                        properties: {
                            approved: { type: "boolean" },
                            confidence: { type: "number", minimum: 0, maximum: 1 },
                            reason: { type: "string" }
                        }
                    }
                }
            }));
            const approved = Boolean(result?.approved) && result.confidence >= confidenceFloor;
            return { approved, confidence: result.confidence, reason: result.reason };
        } catch (error) {
            console.warn(`[AI][WARN] Signal review failed: ${error.message}`);
            return { approved: failOpenOnError, confidence: 0, reason: "AI review failed" };
        }
    };

    const filterGridOrders = async ({ db, snapshot, params, gridState, desiredOrders }) => {
        if (!isEnabled() || !Array.isArray(desiredOrders) || desiredOrders.length === 0) return desiredOrders || [];
        const prefilter = evaluateGridOrderPrefilter({ snapshot, gridState, desiredOrders });
        if (prefilter.rejectedOrders.length > 0) {
            const rejectedSummary = prefilter.rejectedOrders
                .map(({ order, reason }) => `${String(order?.clientOrderId || "N/A")}=${reason}`)
                .join(" | ");
            logAiTrace("SKIP", `grid prefilter rejected ${prefilter.rejectedOrders.length}/${desiredOrders.length}: ${rejectedSummary}`);
        }
        if (prefilter.acceptedOrders.length === 0) {
            return [];
        }
        const now = Date.now();
        pruneExpiredGridOrderCooldowns(now);
        const skippedByCooldown = [];
        const reviewableOrders = prefilter.acceptedOrders.filter((order) => {
            const clientOrderId = String(order?.clientOrderId || "");
            const cooldownRecord = getGridOrderCooldownRecord(clientOrderId, now);
            if (!cooldownRecord) return true;
            skippedByCooldown.push({ order, cooldownRecord });
            if (now - safeNumber(cooldownRecord.lastSkippedLogAt, 0) >= Math.max(gridReviewCooldownMs, 30000)) {
                const waitSeconds = Math.max(1, Math.ceil((cooldownRecord.until - now) / 1000));
                logAiTrace("SKIP", `grid order ${clientOrderId} cooling down ${waitSeconds}s after reject: ${cooldownRecord.reason}`);
                cooldownRecord.lastSkippedLogAt = now;
            }
            return false;
        });
        if (reviewableOrders.length === 0) {
            if (skippedByCooldown.length > 0) {
                const skippedIds = skippedByCooldown.map(({ order }) => String(order?.clientOrderId || "N/A")).join(", ");
                logAiTrace("SKIP", `grid review skipped ${skippedByCooldown.length}/${prefilter.acceptedOrders.length} order(s) due to cooldown: ${skippedIds}`);
            }
            lastGridReviewAt = now;
            lastGridReviewSignature = "";
            lastGridReviewResult = [];
            return [];
        }
        if (skippedByCooldown.length > 0) {
            const skippedIds = skippedByCooldown.map(({ order }) => String(order?.clientOrderId || "N/A")).join(", ");
            logAiTrace("SKIP", `grid review bypassed ${skippedByCooldown.length}/${prefilter.acceptedOrders.length} cooldown order(s): ${skippedIds}`);
        }
        const gridReviewSignature = JSON.stringify({
            version: AI_CACHE_SCHEMA_VERSION,
            pair: db?.pair,
            timeframe: db?.gridTimeframe,
            levels: safeNumber(params?.gridLevels),
            rangePercent: safeNumber(params?.gridRangePercent),
            entryBufferPercent: safeNumber(params?.gridEntryBufferPercent),
            risk: {
                minVolumeRatio: safeNumber(db?.minVolumeRatio),
                entryAdxMax: safeNumber(db?.entryAdxMax),
                entryRsiLongThreshold: safeNumber(db?.entryRsiLongThreshold),
                entryRsiShortThreshold: safeNumber(db?.entryRsiShortThreshold),
                entryBbLongThreshold: safeNumber(db?.entryBbLongThreshold),
                entryBbShortThreshold: safeNumber(db?.entryBbShortThreshold),
                sessionStartUTC: safeNumber(db?.sessionStartUTC),
                sessionEndUTC: safeNumber(db?.sessionEndUTC),
                dailyTrades: safeNumber(db?.dailyTrades)
            },
            market: {
                currentPrice: normalizeForSignature(snapshot?.currentPrice, 4),
                currentATR: normalizeForSignature(snapshot?.currentATR, 6),
                currentNatrPercent: normalizeForSignature(snapshot?.currentNatrPercent, 3),
                volumeRatio: normalizeForSignature(snapshot?.volumeRatio, 3),
                currentRsi: normalizeForSignature(snapshot?.currentRsi, 2),
                currentAdx: normalizeForSignature(snapshot?.currentAdx, 2),
                bbPercentB: normalizeForSignature(snapshot?.bbPercentB, 3),
                macdHistogram: normalizeForSignature(snapshot?.macdHistogram, 6),
                hourUTC: normalizeForSignature(snapshot?.hourUTC, 0)
            },
            priceContext: {
                currentPrice: normalizeForSignature(snapshot?.currentPrice, 4),
                currentRsi: normalizeForSignature(snapshot?.currentRsi, 2),
                currentAdx: normalizeForSignature(snapshot?.currentAdx, 2),
                bbPercentB: normalizeForSignature(snapshot?.bbPercentB, 3)
            },
            orders: reviewableOrders.map((order) => ({
                clientOrderId: String(order?.clientOrderId || ""),
                side: String(order?.side || ""),
                levelIndex: safeNumber(order?.levelIndex),
                price: normalizeForSignature(order?.price, 6),
                targetPrice: normalizeForSignature(order?.targetPrice, 6),
                stopLossPrice: normalizeForSignature(order?.stopLossPrice, 6),
                orderSizeUsdt: normalizeForSignature(order?.orderSizeUsdt, 4)
            }))
        });
        if (
            lastGridReviewResult &&
            gridReviewCooldownMs > 0 &&
            gridReviewSignature === lastGridReviewSignature &&
            now - lastGridReviewAt < gridReviewCooldownMs
        ) {
            return lastGridReviewResult;
        }
        const compactOrders = reviewableOrders.map(compactOrder);
        logAiTrace("CALL", `grid review request ${reviewableOrders.length} order(s) -> ${resolvedProviderName}/${resolvedModel}`);
        const payload = {
            type: "grid_order_review",
            pair: db?.pair,
            strategy: "spot_grid",
            timeframe: db?.gridTimeframe,
            market: compactSnapshot(snapshot),
            grid: {
                referencePrice: safeNumber(gridState?.referencePrice),
                lowerBound: safeNumber(gridState?.lowerBound),
                upperBound: safeNumber(gridState?.upperBound),
                step: safeNumber(gridState?.step),
                levels: safeNumber(params?.gridLevels),
                rangePercent: safeNumber(params?.gridRangePercent),
                entryBufferPercent: safeNumber(params?.gridEntryBufferPercent),
                state: {
                    currentPrice: safeNumber(gridState?.currentPrice),
                    currentLevelIndex: safeNumber(gridState?.currentLevelIndex),
                    currentLevelLow: safeNumber(gridState?.currentLevelLow),
                    currentLevelHigh: safeNumber(gridState?.currentLevelHigh)
                }
            },
            risk: {
                orderSizeUsdt: safeNumber(params?.gridOrderSizeUsdt),
                ordersPerSide: safeNumber(params?.gridOrdersPerSide),
                dailyTrades: safeNumber(db?.dailyTrades)
            },
            marketRegime: {
                currentNatrPercent: safeNumber(snapshot?.currentNatrPercent),
                volumeRatio: safeNumber(snapshot?.volumeRatio),
                currentRsi: safeNumber(snapshot?.currentRsi),
                currentAdx: safeNumber(snapshot?.currentAdx),
                bbPercentB: safeNumber(snapshot?.bbPercentB),
                macdHistogram: safeNumber(snapshot?.macdHistogram),
                hourUTC: safeNumber(snapshot?.hourUTC)
            },
            orders: compactOrders
        };

        try {
            const normalizedDecisions = validateGridReviewResult(await callModel({
                cacheKey: `grid:${JSON.stringify(payload)}`,
                payload,
                schema: {
                    name: "grid_order_review",
                    schema: {
                        type: "object",
                        additionalProperties: false,
                        required: ["orderDecisions"],
                        properties: {
                            orderDecisions: {
                                type: "array",
                                items: {
                                    type: "object",
                                    additionalProperties: false,
                                    required: ["clientOrderId", "approved", "confidence", "reason"],
                                    properties: {
                                        clientOrderId: { type: "string" },
                                        approved: { type: "boolean" },
                                        confidence: { type: "number", minimum: 0, maximum: 1 },
                                        reason: { type: "string" }
                                    }
                                }
                            }
                        }
                    }
                }
            }), reviewableOrders);
            const decisions = new Map(normalizedDecisions.map((decision) => [decision.clientOrderId, decision]));
            const approvedOrders = [];
            const rejectedOrders = [];
            reviewableOrders.forEach((order) => {
                const decision = decisions.get(String(order?.clientOrderId || ""));
                const confidence = safeNumber(decision?.confidence, 0);
                const approved = Boolean(decision?.approved) && confidence >= confidenceFloor;
                if (!approved) {
                    logAiTrace("INFO", `rejected grid order ${order.clientOrderId}: ${decision?.reason || "low confidence"}`);
                    markRejectedGridOrderCooldown(order, decision?.reason || "low confidence", now);
                    rejectedOrders.push(order);
                    return;
                }
                approvedOrders.push(order);
            });
            const approvedIds = approvedOrders.map((order) => order.clientOrderId).join(", ") || "-";
            const rejectedIds = rejectedOrders.map((order) => order.clientOrderId).join(", ") || "-";
            logAiTrace("INFO", `grid review result: approved=${approvedOrders.length}/${reviewableOrders.length} [${approvedIds}] | rejected=${rejectedOrders.length} [${rejectedIds}]`);
            lastGridReviewAt = now;
            lastGridReviewSignature = gridReviewSignature;
            lastGridReviewResult = approvedOrders;
            return approvedOrders;
        } catch (error) {
            console.warn(`[AI][WARN] Grid review failed: ${error.message}`);
            const fallback = failOpenOnError ? reviewableOrders : [];
            lastGridReviewAt = now;
            lastGridReviewSignature = gridReviewSignature;
            lastGridReviewResult = fallback;
            return fallback;
        }
    };

    return {
        isEnabled,
        getProvider: () => resolvedProviderName,
        getProviderConfig: () => ({
            provider: resolvedProviderName,
            model: resolvedModel,
            endpoint: resolvedEndpoint,
            requestMinIntervalMs: aiRequestMinIntervalMs,
            retryBaseDelayMs: aiRetryBaseDelayMs,
            retryMaxDelayMs: aiRetryMaxDelayMs
        }),
        invalidateCache: () => {
            cache.clear();
            gridRejectedOrderCooldowns.clear();
            lastGridReviewAt = 0;
            lastGridReviewSignature = "";
            lastGridReviewResult = null;
        },
        reviewSignal,
        filterGridOrders
    };
};

module.exports = { createAiTradeFilter };
