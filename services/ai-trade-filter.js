const DEFAULT_ENDPOINT = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_PROVIDER = "openai";
const DEFAULT_GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_CACHE_TTL_MS = 60000;
const DEFAULT_MAX_OUTPUT_TOKENS = 2000;
const DEFAULT_GRID_REVIEW_MIN_INTERVAL_MS = 15000;

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

const safeNumber = (value, fallback = null) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
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
    currentATR: safeNumber(snapshot?.currentATR),
    currentNatrPercent: safeNumber(snapshot?.currentNatrPercent),
    volumeRatio: safeNumber(snapshot?.volumeRatio),
    currentRsi: safeNumber(snapshot?.currentRsi),
    currentAdx: safeNumber(snapshot?.currentAdx),
    bbPercentB: safeNumber(snapshot?.bbPercentB),
    macdHistogram: safeNumber(snapshot?.macdHistogram),
    hourUTC: safeNumber(snapshot?.hourUTC)
});

const extractResponseText = (payload) => {
    if (typeof payload?.output_text === "string") return payload.output_text;
    const output = Array.isArray(payload?.output) ? payload.output : [];
    for (const item of output) {
        const content = Array.isArray(item?.content) ? item.content : [];
        for (const part of content) {
            if (typeof part?.text === "string") return part.text;
        }
    }
    return "";
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

const createAiTradeFilter = ({
    provider = process.env.AI_PROVIDER || DEFAULT_PROVIDER,
    apiKey,
    endpoint,
    model,
    enabled = process.env.AI_SIGNAL_FILTER_ENABLED,
    failOpen = process.env.AI_SIGNAL_FILTER_FAIL_OPEN,
    minConfidence = process.env.AI_SIGNAL_MIN_CONFIDENCE,
    timeoutMs = process.env.AI_SIGNAL_TIMEOUT_MS,
    cacheTtlMs = process.env.AI_SIGNAL_CACHE_TTL_MS,
    maxOutputTokens = process.env.AI_SIGNAL_MAX_OUTPUT_TOKENS,
    gridReviewMinIntervalMs = process.env.AI_GRID_REVIEW_MIN_INTERVAL_MS,
    fetchFn = globalThis.fetch
} = {}) => {
    const normalizedProvider = String(provider || DEFAULT_PROVIDER).toLowerCase().trim();
    const resolvedApiKey = apiKey || (normalizedProvider === "gemini" ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY);
    const resolvedEndpoint = endpoint || (
        normalizedProvider === "gemini"
            ? (process.env.GEMINI_API_ENDPOINT || DEFAULT_GEMINI_ENDPOINT)
            : (process.env.OPENAI_API_ENDPOINT || DEFAULT_ENDPOINT)
    );
    const resolvedModel = model || (
        normalizedProvider === "gemini"
            ? (process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL)
            : (process.env.OPENAI_MODEL || DEFAULT_MODEL)
    );
    const shouldUseAi = truthy(enabled);
    const failOpenOnError = truthy(failOpen);
    const confidenceFloor = Math.min(Math.max(safeNumber(minConfidence, 0.65), 0), 1);
    const requestTimeoutMs = Math.max(1000, Math.trunc(safeNumber(timeoutMs, DEFAULT_TIMEOUT_MS)));
    const cacheWindowMs = Math.max(0, Math.trunc(safeNumber(cacheTtlMs, DEFAULT_CACHE_TTL_MS)));
    const outputTokenLimit = Math.max(500, Math.trunc(safeNumber(maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS)));
    const gridReviewCooldownMs = Math.max(0, Math.trunc(safeNumber(gridReviewMinIntervalMs, DEFAULT_GRID_REVIEW_MIN_INTERVAL_MS)));
    const cache = new Map();
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

    const isEnabled = () => Boolean(shouldUseAi && resolvedApiKey && typeof fetchFn === "function");

    const buildGeminiUrl = () => {
        const base = String(resolvedEndpoint || DEFAULT_GEMINI_ENDPOINT).replace(/\/$/, "");
        if (base.includes(":generateContent")) return base;
        return `${base}/${resolvedModel}:generateContent`;
    };

    const callOpenAi = async ({ schema, payload, signal }) => {
        const response = await fetchFn(resolvedEndpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${resolvedApiKey}`
            },
            signal,
            body: JSON.stringify({
                model: resolvedModel,
                instructions,
                input: JSON.stringify(payload),
                max_output_tokens: outputTokenLimit,
                text: {
                    format: {
                        type: "json_schema",
                        name: schema.name,
                        strict: true,
                        schema: schema.schema
                    }
                }
            })
        });

        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(`OpenAI ${response.status}: ${body.slice(0, 200)}`);
        }

        const parsedResponse = await response.json();
        return parseJsonObject(extractResponseText(parsedResponse));
    };

    const callGemini = async ({ schema, payload, signal }) => {
        const response = await fetchFn(buildGeminiUrl(), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": resolvedApiKey
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
            throw new Error(`Gemini ${response.status}: ${body.slice(0, 200)}`);
        }

        const parsedResponse = await response.json();
        return parseJsonObject(extractGeminiResponseText(parsedResponse));
    };

    const callModel = async ({ schema, payload, cacheKey }) => {
        if (!isEnabled()) return null;
        const now = Date.now();
        const cached = cache.get(cacheKey);
        if (cached && now - cached.at <= cacheWindowMs) return cached.value;

        const parsedJson = await withTimeout(async (signal) => {
            if (normalizedProvider === "gemini") return await callGemini({ schema, payload, signal });
            return await callOpenAi({ schema, payload, signal });
        }, requestTimeoutMs);
        cache.set(cacheKey, { at: now, value: parsedJson });
        return parsedJson;
    };

    const reviewSignal = async ({ db, side, signal }) => {
        if (!isEnabled()) return { approved: true, skipped: true, reason: "AI filter disabled" };
        const payload = {
            type: "market_signal_review",
            pair: db?.pair,
            strategy: signal?.strategy,
            side,
            signal: {
                canLong: Boolean(signal?.canLong),
                canShort: Boolean(signal?.canShort),
                price: safeNumber(signal?.price),
                atr: safeNumber(signal?.atr),
                targetPrice: safeNumber(signal?.targetPrice),
                stopLossPrice: safeNumber(signal?.stopLossPrice)
            },
            risk: {
                orderSizeUsdt: safeNumber(db?.gridOrderSizeUsdt),
                maxTradesPerDay: safeNumber(db?.maxTradesPerDay),
                dailyTrades: safeNumber(db?.dailyTrades),
                marginMode: db?.marginMode
            }
        };

        try {
            const result = await callModel({
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
            });
            const confidence = safeNumber(result?.confidence, 0);
            const approved = Boolean(result?.approved) && confidence >= confidenceFloor;
            return { approved, confidence, reason: String(result?.reason || "No AI reason returned") };
        } catch (error) {
            console.warn(`[AI][WARN] Signal review failed: ${error.message}`);
            return { approved: failOpenOnError, confidence: 0, reason: "AI review failed" };
        }
    };

    const filterGridOrders = async ({ db, snapshot, params, gridState, desiredOrders }) => {
        if (!isEnabled() || !Array.isArray(desiredOrders) || desiredOrders.length === 0) return desiredOrders || [];
        const gridReviewSignature = JSON.stringify({
            pair: db?.pair,
            timeframe: db?.gridTimeframe,
            levels: safeNumber(params?.gridLevels),
            rangePercent: safeNumber(params?.gridRangePercent),
            entryBufferPercent: safeNumber(params?.gridEntryBufferPercent),
            priceContext: {
                currentPrice: normalizeForSignature(snapshot?.currentPrice, 4),
                currentRsi: normalizeForSignature(snapshot?.currentRsi, 2),
                currentAdx: normalizeForSignature(snapshot?.currentAdx, 2),
                bbPercentB: normalizeForSignature(snapshot?.bbPercentB, 3)
            },
            orders: desiredOrders.map((order) => ({
                clientOrderId: String(order?.clientOrderId || ""),
                side: String(order?.side || ""),
                levelIndex: safeNumber(order?.levelIndex),
                price: normalizeForSignature(order?.price, 6),
                targetPrice: normalizeForSignature(order?.targetPrice, 6),
                stopLossPrice: normalizeForSignature(order?.stopLossPrice, 6),
                orderSizeUsdt: normalizeForSignature(order?.orderSizeUsdt, 4)
            }))
        });
        const now = Date.now();
        if (
            lastGridReviewResult &&
            gridReviewCooldownMs > 0 &&
            gridReviewSignature === lastGridReviewSignature &&
            now - lastGridReviewAt < gridReviewCooldownMs
        ) {
            return lastGridReviewResult;
        }
        const compactOrders = desiredOrders.map(compactOrder);
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
                entryBufferPercent: safeNumber(params?.gridEntryBufferPercent)
            },
            risk: {
                orderSizeUsdt: safeNumber(params?.gridOrderSizeUsdt),
                ordersPerSide: safeNumber(params?.gridOrdersPerSide),
                dailyTrades: safeNumber(db?.dailyTrades),
                maxTradesPerDay: safeNumber(db?.maxTradesPerDay)
            },
            orders: compactOrders
        };

        try {
            const result = await callModel({
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
            });
            const decisions = new Map((Array.isArray(result?.orderDecisions) ? result.orderDecisions : [])
                .map((decision) => [String(decision?.clientOrderId || ""), decision]));
            const approvedOrders = [];
            const rejectedOrders = [];
            desiredOrders.forEach((order) => {
                const decision = decisions.get(String(order?.clientOrderId || ""));
                const confidence = safeNumber(decision?.confidence, 0);
                const approved = Boolean(decision?.approved) && confidence >= confidenceFloor;
                if (!approved) {
                    console.log(`[AI][INFO] Rejected grid order ${order.clientOrderId}: ${decision?.reason || "low confidence"}`);
                    rejectedOrders.push(order);
                    return;
                }
                approvedOrders.push(order);
            });
            const approvedIds = approvedOrders.map((order) => order.clientOrderId).join(", ") || "-";
            const rejectedIds = rejectedOrders.map((order) => order.clientOrderId).join(", ") || "-";
            console.log(`[AI][INFO] Grid review result: approved=${approvedOrders.length}/${desiredOrders.length} [${approvedIds}] | rejected=${rejectedOrders.length} [${rejectedIds}]`);
            lastGridReviewAt = now;
            lastGridReviewSignature = gridReviewSignature;
            lastGridReviewResult = approvedOrders;
            return approvedOrders;
        } catch (error) {
            console.warn(`[AI][WARN] Grid review failed: ${error.message}`);
            const fallback = failOpenOnError ? desiredOrders : [];
            lastGridReviewAt = now;
            lastGridReviewSignature = gridReviewSignature;
            lastGridReviewResult = fallback;
            return fallback;
        }
    };

    return {
        isEnabled,
        getProvider: () => normalizedProvider,
        reviewSignal,
        filterGridOrders
    };
};

module.exports = { createAiTradeFilter };
