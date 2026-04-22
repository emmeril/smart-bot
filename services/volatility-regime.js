const DEFAULT_EXTERNAL_DATA_TTL_MS = 10 * 60 * 1000;
const DEFAULT_PROVIDER = String(process.env.EXTERNAL_MARKET_DATA_PROVIDER || "auto").trim().toLowerCase();

const createVolatilityRiskHelpers = ({
    toFiniteNumber,
    calcATR,
    fetchImpl = globalThis.fetch
}) => {
    const externalHistoryCache = new Map();

    const clampNumber = (value, min, max) => Math.min(Math.max(value, min), max);

    const median = (values) => {
        const filtered = (values || []).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
        if (filtered.length === 0) return NaN;
        const middle = Math.floor(filtered.length / 2);
        return filtered.length % 2 === 0
            ? (filtered[middle - 1] + filtered[middle]) / 2
            : filtered[middle];
    };

    const percentileRank = (values, target) => {
        const filtered = (values || []).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
        if (filtered.length === 0 || !Number.isFinite(target)) return NaN;
        let lessOrEqual = 0;
        for (const value of filtered) {
            if (value <= target) lessOrEqual += 1;
        }
        return lessOrEqual / filtered.length;
    };

    const rollingStdDev = (values, windowSize) => {
        const numericWindow = Math.max(2, Math.trunc(toFiniteNumber(windowSize, 20)));
        const output = Array.isArray(values) ? Array(values.length).fill(null) : [];
        if (!Array.isArray(values) || values.length < numericWindow) return output;

        for (let index = numericWindow - 1; index < values.length; index += 1) {
            const window = values.slice(index - numericWindow + 1, index + 1).filter((value) => Number.isFinite(value));
            if (window.length < numericWindow) continue;
            const mean = window.reduce((sum, value) => sum + value, 0) / window.length;
            const variance = window.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / window.length;
            output[index] = Math.sqrt(variance);
        }

        return output;
    };

    const buildLogReturns = (closes = []) => {
        const returns = [];
        for (let index = 1; index < closes.length; index += 1) {
            const previous = toFiniteNumber(closes[index - 1], NaN);
            const current = toFiniteNumber(closes[index], NaN);
            if (!Number.isFinite(previous) || previous <= 0 || !Number.isFinite(current) || current <= 0) {
                returns.push(null);
                continue;
            }
            returns.push(Math.log(current / previous));
        }
        return returns;
    };

    const computeEfficiencyRatio = (closes = [], lookback = 20) => {
        const numericLookback = Math.max(2, Math.trunc(toFiniteNumber(lookback, 20)));
        if (!Array.isArray(closes) || closes.length <= numericLookback) return NaN;
        const window = closes.slice(-(numericLookback + 1)).map((value) => toFiniteNumber(value, NaN));
        if (window.some((value) => !Number.isFinite(value) || value <= 0)) return NaN;

        const directionalMove = Math.abs(window[window.length - 1] - window[0]);
        let pathLength = 0;
        for (let index = 1; index < window.length; index += 1) {
            pathLength += Math.abs(window[index] - window[index - 1]);
        }

        if (!Number.isFinite(pathLength) || pathLength <= 0) return NaN;
        return clampNumber(directionalMove / pathLength, 0, 1);
    };

    const extractOhlcvSeries = (candles = []) => ({
        high: candles.map((candle) => toFiniteNumber(candle?.[2], NaN)),
        low: candles.map((candle) => toFiniteNumber(candle?.[3], NaN)),
        close: candles.map((candle) => toFiniteNumber(candle?.[4], NaN))
    });

    const buildNormalizedAtrSeries = (candles = [], atrPeriod = 14) => {
        const { high, low, close } = extractOhlcvSeries(candles);
        const atrSeries = calcATR(high, low, close, atrPeriod);
        return atrSeries.map((atrValue, index) => {
            const closeValue = close[index];
            if (!Number.isFinite(atrValue) || atrValue <= 0 || !Number.isFinite(closeValue) || closeValue <= 0) return null;
            return atrValue / closeValue;
        });
    };

    const buildRealizedVolSeries = (candles = [], windowSize = 20) => {
        const { close } = extractOhlcvSeries(candles);
        const logReturns = buildLogReturns(close);
        return rollingStdDev(logReturns, windowSize).map((value) => (
            Number.isFinite(value) ? value * Math.sqrt(Math.max(1, Math.trunc(windowSize))) : null
        ));
    };

    const resolveProviderSymbol = (pair) => {
        const rawPair = String(pair || "").trim();
        if (!rawPair) return { base: "", quote: "", yahooSymbol: "", alphaSymbol: "", alphaMarket: "USD" };

        const normalized = rawPair.split(":")[0];
        const [baseRaw, quoteRaw] = normalized.split("/");
        const base = String(baseRaw || "").trim().toUpperCase();
        const quote = String(quoteRaw || "").trim().toUpperCase();
        const stableQuote = ["USDT", "USDC", "BUSD", "FDUSD", "TUSD", "USDP"].includes(quote) ? "USD" : quote;

        return {
            base,
            quote,
            yahooSymbol: `${base}-${stableQuote}`,
            alphaSymbol: base,
            alphaMarket: stableQuote || "USD"
        };
    };

    const normalizeExternalCandles = (candles = []) => (
        candles
            .filter((candle) => Array.isArray(candle) && candle.length >= 5)
            .map((candle) => [
                Number(candle[0]),
                toFiniteNumber(candle[1], NaN),
                toFiniteNumber(candle[2], NaN),
                toFiniteNumber(candle[3], NaN),
                toFiniteNumber(candle[4], NaN),
                toFiniteNumber(candle[5], 0)
            ])
            .filter((candle) => Number.isFinite(candle[0]) && Number.isFinite(candle[2]) && Number.isFinite(candle[3]) && Number.isFinite(candle[4]))
            .sort((left, right) => left[0] - right[0])
    );

    const fetchYahooHistory = async (pair, range = "1y") => {
        if (typeof fetchImpl !== "function") throw new Error("Fetch API is unavailable");
        const { yahooSymbol } = resolveProviderSymbol(pair);
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=${encodeURIComponent(range)}&includePrePost=false&events=div%2Csplits`;
        const response = await fetchImpl(url, {
            headers: {
                "user-agent": "smart-bot/1.0",
                accept: "application/json"
            }
        });
        if (!response.ok) throw new Error(`Yahoo Finance HTTP ${response.status}`);
        const payload = await response.json();
        const result = payload?.chart?.result?.[0];
        const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
        const quote = result?.indicators?.quote?.[0] || {};
        const candles = timestamps.map((timestamp, index) => ([
            Number(timestamp) * 1000,
            toFiniteNumber(quote.open?.[index], NaN),
            toFiniteNumber(quote.high?.[index], NaN),
            toFiniteNumber(quote.low?.[index], NaN),
            toFiniteNumber(quote.close?.[index], NaN),
            toFiniteNumber(quote.volume?.[index], 0)
        ]));
        return normalizeExternalCandles(candles);
    };

    const fetchAlphaVantageHistory = async (pair) => {
        if (typeof fetchImpl !== "function") throw new Error("Fetch API is unavailable");
        const apiKey = String(process.env.ALPHA_VANTAGE_API_KEY || "").trim();
        if (!apiKey) throw new Error("Missing ALPHA_VANTAGE_API_KEY");
        const { alphaSymbol, alphaMarket } = resolveProviderSymbol(pair);
        const url = `https://www.alphavantage.co/query?function=DIGITAL_CURRENCY_DAILY&symbol=${encodeURIComponent(alphaSymbol)}&market=${encodeURIComponent(alphaMarket)}&apikey=${encodeURIComponent(apiKey)}`;
        const response = await fetchImpl(url, {
            headers: {
                "user-agent": "smart-bot/1.0",
                accept: "application/json"
            }
        });
        if (!response.ok) throw new Error(`Alpha Vantage HTTP ${response.status}`);
        const payload = await response.json();
        const series = payload?.["Time Series (Digital Currency Daily)"];
        if (!series || typeof series !== "object") {
            throw new Error(payload?.Note || payload?.Information || "Alpha Vantage returned no daily series");
        }
        const candles = Object.entries(series).map(([date, value]) => ([
            Date.parse(`${date}T00:00:00Z`),
            toFiniteNumber(value?.["1a. open (USD)"] ?? value?.["1b. open (USD)"], NaN),
            toFiniteNumber(value?.["2a. high (USD)"] ?? value?.["2b. high (USD)"], NaN),
            toFiniteNumber(value?.["3a. low (USD)"] ?? value?.["3b. low (USD)"], NaN),
            toFiniteNumber(value?.["4a. close (USD)"] ?? value?.["4b. close (USD)"], NaN),
            toFiniteNumber(value?.["5. volume"], 0)
        ]));
        return normalizeExternalCandles(candles);
    };

    const fetchExternalHistory = async (pair, provider = DEFAULT_PROVIDER) => {
        const cacheKey = `${String(provider || "auto").toLowerCase()}:${String(pair || "").toUpperCase()}`;
        const cached = externalHistoryCache.get(cacheKey);
        const now = Date.now();
        if (cached && now - cached.cachedAt < DEFAULT_EXTERNAL_DATA_TTL_MS) return cached.value;

        const candidateProviders = provider === "auto"
            ? ["yahoo", "alpha_vantage"]
            : [String(provider || "").toLowerCase()];
        let lastError = null;
        for (const candidate of candidateProviders) {
            try {
                const candles = candidate === "alpha_vantage"
                    ? await fetchAlphaVantageHistory(pair)
                    : await fetchYahooHistory(pair);
                if (candles.length > 0) {
                    const value = { provider: candidate, candles, fetchedAt: now };
                    externalHistoryCache.set(cacheKey, { value, cachedAt: now });
                    return value;
                }
            } catch (error) {
                lastError = error;
            }
        }
        if (lastError) throw lastError;
        throw new Error("No external market data provider returned historical candles");
    };

    const pickLatestFinite = (values = []) => {
        for (let index = values.length - 1; index >= 0; index -= 1) {
            if (Number.isFinite(values[index])) return values[index];
        }
        return NaN;
    };

    const deriveCurrentAtr = (candles = [], atrPeriod = 14) => {
        const { high, low, close } = extractOhlcvSeries(candles);
        return pickLatestFinite(calcATR(high, low, close, atrPeriod));
    };

    const buildStaticRiskProfile = ({ baseActivateATR, baseOffsetATR, source, reason = null, metadata = {} }) => ({
        trailingActivateATR: baseActivateATR,
        trailingOffsetATR: Math.min(baseOffsetATR, Math.max(0.1, baseActivateATR - 0.1)),
        trailingRiskModel: "STATIC_FALLBACK",
        trailingRiskSource: source,
        trailingRiskReason: reason,
        trailingRiskMeta: {
            regimeMultiplier: 1,
            atrPercentile: null,
            realizedVolPercentile: null,
            trendEfficiency: null,
            ...metadata
        }
    });

    const resolveAdaptiveRiskOverrides = async ({
        pair,
        timeframe,
        atrPeriod = 14,
        currentPrice = NaN,
        currentATR = NaN,
        localOhlcv = [],
        baseActivateATR = 1.2,
        baseOffsetATR = 0.6
    } = {}) => {
        const numericActivate = Math.max(0.2, toFiniteNumber(baseActivateATR, 1.2));
        const numericOffset = Math.max(0.1, toFiniteNumber(baseOffsetATR, 0.6));
        const localCandles = Array.isArray(localOhlcv) ? localOhlcv : [];
        const fallbackAtr = Number.isFinite(currentATR) && currentATR > 0
            ? currentATR
            : deriveCurrentAtr(localCandles, atrPeriod);
        const fallbackPrice = Number.isFinite(currentPrice) && currentPrice > 0
            ? currentPrice
            : toFiniteNumber(localCandles.at(-1)?.[4], NaN);

        if (!Number.isFinite(fallbackAtr) || fallbackAtr <= 0 || !Number.isFinite(fallbackPrice) || fallbackPrice <= 0) {
            return buildStaticRiskProfile({
                baseActivateATR: numericActivate,
                baseOffsetATR: numericOffset,
                source: "local",
                reason: "INSUFFICIENT_LOCAL_VOLATILITY_DATA"
            });
        }

        const localNormAtrSeries = buildNormalizedAtrSeries(localCandles, atrPeriod).filter((value) => Number.isFinite(value));
        const localRealizedVolSeries = buildRealizedVolSeries(localCandles, Math.max(10, atrPeriod)).filter((value) => Number.isFinite(value));
        const currentNormalizedAtr = fallbackAtr / fallbackPrice;
        const localTrendEfficiency = computeEfficiencyRatio(extractOhlcvSeries(localCandles).close, Math.max(10, atrPeriod));

        let externalData = null;
        try {
            externalData = await fetchExternalHistory(pair);
        } catch {
            externalData = null;
        }

        const benchmarkCandles = externalData?.candles?.length >= Math.max(atrPeriod + 10, 40)
            ? externalData.candles
            : localCandles;
        const benchmarkSource = externalData?.provider || "local";
        const benchmarkNormAtrSeries = buildNormalizedAtrSeries(benchmarkCandles, atrPeriod).filter((value) => Number.isFinite(value));
        const benchmarkRealizedVolSeries = buildRealizedVolSeries(benchmarkCandles, Math.max(10, atrPeriod)).filter((value) => Number.isFinite(value));

        if (benchmarkNormAtrSeries.length === 0) {
            return buildStaticRiskProfile({
                baseActivateATR: numericActivate,
                baseOffsetATR: numericOffset,
                source: benchmarkSource,
                reason: "INSUFFICIENT_BENCHMARK_DATA",
                metadata: { timeframe: timeframe || null }
            });
        }

        const currentRealizedVol = pickLatestFinite(localRealizedVolSeries);
        const medianBenchmarkAtr = Math.max(median(benchmarkNormAtrSeries), 1e-8);
        const medianBenchmarkRealizedVol = Math.max(median(benchmarkRealizedVolSeries), 1e-8);
        const atrRatio = clampNumber(currentNormalizedAtr / medianBenchmarkAtr, 0.6, 3.2);
        const realizedVolRatio = Number.isFinite(currentRealizedVol)
            ? clampNumber(currentRealizedVol / medianBenchmarkRealizedVol, 0.6, 3.2)
            : 1;
        const atrPercentile = percentileRank(benchmarkNormAtrSeries, currentNormalizedAtr);
        const realizedVolPercentile = Number.isFinite(currentRealizedVol)
            ? percentileRank(benchmarkRealizedVolSeries, currentRealizedVol)
            : NaN;
        const trendEfficiency = Number.isFinite(localTrendEfficiency) ? localTrendEfficiency : 0.35;
        const percentileRegime = clampNumber(
            (
                (Number.isFinite(atrPercentile) ? atrPercentile : 0.5) +
                (Number.isFinite(realizedVolPercentile) ? realizedVolPercentile : 0.5)
            ) / 2,
            0,
            1
        );

        const regimeMultiplier = clampNumber(
            (atrRatio * 0.5) +
            (realizedVolRatio * 0.3) +
            ((0.75 + percentileRegime) * 0.2),
            0.75,
            2.6
        );
        const noiseMultiplier = clampNumber(1 + ((1 - trendEfficiency) * 0.35), 1, 1.35);
        const trendTighteningFactor = clampNumber(1 - (trendEfficiency * 0.18), 0.82, 1);

        const trailingActivateATR = clampNumber(
            numericActivate * regimeMultiplier * noiseMultiplier,
            Math.max(0.8, numericOffset + 0.25),
            4.8
        );
        const trailingOffsetATR = clampNumber(
            numericOffset * regimeMultiplier * noiseMultiplier * trendTighteningFactor,
            0.25,
            trailingActivateATR * 0.88
        );

        return {
            trailingActivateATR,
            trailingOffsetATR,
            trailingRiskModel: externalData ? "ADAPTIVE_VOLATILITY" : "LOCAL_ADAPTIVE_VOLATILITY",
            trailingRiskSource: benchmarkSource,
            trailingRiskReason: externalData ? null : "EXTERNAL_DATA_UNAVAILABLE_USING_LOCAL_HISTORY",
            trailingRiskMeta: {
                timeframe: timeframe || null,
                atrPeriod: Math.max(2, Math.trunc(toFiniteNumber(atrPeriod, 14))),
                benchmarkBars: benchmarkCandles.length,
                currentNormalizedAtr,
                currentRealizedVol: Number.isFinite(currentRealizedVol) ? currentRealizedVol : null,
                atrRatio,
                realizedVolRatio,
                atrPercentile: Number.isFinite(atrPercentile) ? atrPercentile : null,
                realizedVolPercentile: Number.isFinite(realizedVolPercentile) ? realizedVolPercentile : null,
                trendEfficiency,
                regimeMultiplier,
                noiseMultiplier
            }
        };
    };

    return {
        rollingStdDev,
        computeEfficiencyRatio,
        buildNormalizedAtrSeries,
        buildRealizedVolSeries,
        resolveProviderSymbol,
        fetchExternalHistory,
        resolveAdaptiveRiskOverrides
    };
};

module.exports = { createVolatilityRiskHelpers };
