const createSmartAutoPreflightHelpers = ({ toFiniteNumber, clamp }) => {
    const DEFAULT_MAX_DAILY_LOSS_MULTIPLIER = 3;
    const DEFAULT_MIN_DAILY_LOSS_USDT = 2;
    const MAX_NATR_PERCENT = 1.8;
    const MIN_NATR_PERCENT = 0.03;
    const MAX_ADX_FOR_GRID = 38;
    const MIN_GRID_STEP_PERCENT = 0.08;

    const percentile = (values, pct) => {
        const numericValues = (values || []).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
        if (numericValues.length === 0) return NaN;
        const index = clamp((numericValues.length - 1) * pct, 0, numericValues.length - 1);
        const lower = Math.floor(index);
        const upper = Math.ceil(index);
        if (lower === upper) return numericValues[lower];
        return numericValues[lower] + ((numericValues[upper] - numericValues[lower]) * (index - lower));
    };

    const extractOhlcvSeries = (snapshot = {}) => {
        if (Array.isArray(snapshot.ohlcv) && snapshot.ohlcv.length > 0) {
            return {
                high: snapshot.ohlcv.map((candle) => toFiniteNumber(candle?.[2], NaN)),
                low: snapshot.ohlcv.map((candle) => toFiniteNumber(candle?.[3], NaN)),
                close: snapshot.ohlcv.map((candle) => toFiniteNumber(candle?.[4], NaN)),
                volume: snapshot.ohlcv.map((candle) => toFiniteNumber(candle?.[5], NaN))
            };
        }
        return {
            high: Array.isArray(snapshot.high) ? snapshot.high.map((value) => toFiniteNumber(value, NaN)) : [],
            low: Array.isArray(snapshot.low) ? snapshot.low.map((value) => toFiniteNumber(value, NaN)) : [],
            close: Array.isArray(snapshot.close) ? snapshot.close.map((value) => toFiniteNumber(value, NaN)) : [],
            volume: Array.isArray(snapshot.volume) ? snapshot.volume.map((value) => toFiniteNumber(value, NaN)) : []
        };
    };

    const buildAtrSeries = (high, low, close, period) => {
        if (!Array.isArray(high) || high.length <= period || low.length !== high.length || close.length !== high.length) return [];
        const trueRanges = Array(high.length).fill(NaN);
        for (let index = 1; index < high.length; index += 1) {
            if (!Number.isFinite(high[index]) || !Number.isFinite(low[index]) || !Number.isFinite(close[index - 1])) continue;
            trueRanges[index] = Math.max(
                high[index] - low[index],
                Math.abs(high[index] - close[index - 1]),
                Math.abs(low[index] - close[index - 1])
            );
        }

        const output = Array(high.length).fill(NaN);
        const seed = trueRanges.slice(1, period + 1).filter((value) => Number.isFinite(value));
        if (seed.length !== period) return [];
        output[period] = seed.reduce((sum, value) => sum + value, 0) / period;
        for (let index = period + 1; index < high.length; index += 1) {
            if (!Number.isFinite(trueRanges[index]) || !Number.isFinite(output[index - 1])) continue;
            output[index] = ((output[index - 1] * (period - 1)) + trueRanges[index]) / period;
        }
        return output;
    };

    const buildNatrSeries = (snapshot = {}, period = 14) => {
        const { high, low, close } = extractOhlcvSeries(snapshot);
        const atrSeries = buildAtrSeries(high, low, close, Math.max(2, Math.trunc(toFiniteNumber(period, 14))));
        return atrSeries
            .map((atr, index) => {
                const price = close[index];
                return Number.isFinite(atr) && Number.isFinite(price) && price > 0 ? (atr / price) * 100 : NaN;
            })
            .filter((value) => Number.isFinite(value));
    };

    const buildVolumeRatioSeries = (snapshot = {}, period = 20) => {
        const { volume } = extractOhlcvSeries(snapshot);
        const safePeriod = Math.max(2, Math.trunc(toFiniteNumber(period, 20)));
        const output = [];
        for (let index = safePeriod; index < volume.length; index += 1) {
            const currentVolume = volume[index];
            const recent = volume.slice(index - safePeriod, index).filter((value) => Number.isFinite(value));
            if (!Number.isFinite(currentVolume) || recent.length === 0) continue;
            const average = recent.reduce((sum, value) => sum + value, 0) / recent.length;
            if (average > 0) output.push(currentVolume / average);
        }
        return output;
    };

    const buildAdxSeries = (snapshot = {}, period = 14) => {
        const { high, low, close } = extractOhlcvSeries(snapshot);
        const safePeriod = Math.max(2, Math.trunc(toFiniteNumber(period, 14)));
        if (high.length <= safePeriod * 2 || low.length !== high.length || close.length !== high.length) return [];
        const plusDm = Array(high.length).fill(0);
        const minusDm = Array(high.length).fill(0);
        const tr = Array(high.length).fill(NaN);
        for (let index = 1; index < high.length; index += 1) {
            const upMove = high[index] - high[index - 1];
            const downMove = low[index - 1] - low[index];
            plusDm[index] = upMove > downMove && upMove > 0 ? upMove : 0;
            minusDm[index] = downMove > upMove && downMove > 0 ? downMove : 0;
            tr[index] = Math.max(
                high[index] - low[index],
                Math.abs(high[index] - close[index - 1]),
                Math.abs(low[index] - close[index - 1])
            );
        }

        const dx = Array(high.length).fill(NaN);
        let trSmooth = tr.slice(1, safePeriod + 1).reduce((sum, value) => sum + toFiniteNumber(value, 0), 0);
        let plusSmooth = plusDm.slice(1, safePeriod + 1).reduce((sum, value) => sum + value, 0);
        let minusSmooth = minusDm.slice(1, safePeriod + 1).reduce((sum, value) => sum + value, 0);
        for (let index = safePeriod; index < high.length; index += 1) {
            if (index > safePeriod) {
                trSmooth = trSmooth - (trSmooth / safePeriod) + toFiniteNumber(tr[index], 0);
                plusSmooth = plusSmooth - (plusSmooth / safePeriod) + plusDm[index];
                minusSmooth = minusSmooth - (minusSmooth / safePeriod) + minusDm[index];
            }
            if (trSmooth <= 0) continue;
            const plusDi = (plusSmooth / trSmooth) * 100;
            const minusDi = (minusSmooth / trSmooth) * 100;
            const denominator = plusDi + minusDi;
            if (denominator > 0) dx[index] = (Math.abs(plusDi - minusDi) / denominator) * 100;
        }

        const adx = Array(high.length).fill(NaN);
        const seed = dx.slice(safePeriod, safePeriod * 2).filter((value) => Number.isFinite(value));
        if (seed.length !== safePeriod) return [];
        adx[(safePeriod * 2) - 1] = seed.reduce((sum, value) => sum + value, 0) / safePeriod;
        for (let index = safePeriod * 2; index < high.length; index += 1) {
            if (!Number.isFinite(dx[index]) || !Number.isFinite(adx[index - 1])) continue;
            adx[index] = ((adx[index - 1] * (safePeriod - 1)) + dx[index]) / safePeriod;
        }
        return adx.filter((value) => Number.isFinite(value));
    };

    const buildAdaptiveMarketProfile = ({ db, params, snapshot } = {}) => {
        const natrSeries = buildNatrSeries(snapshot, params?.atrPeriod || db?.atrPeriod || 14);
        const volumeRatioSeries = buildVolumeRatioSeries(snapshot, params?.volumePeriod || db?.volumePeriod || 20);
        const adxSeries = buildAdxSeries(snapshot, params?.entryAdxPeriod || db?.entryAdxPeriod || 14);
        const natrP50 = percentile(natrSeries, 0.5);
        const natrP95 = percentile(natrSeries, 0.95);
        const natrLow = Math.max(0.015, toFiniteNumber(percentile(natrSeries, 0.1), MIN_NATR_PERCENT) * 0.65);
        const natrExtreme = Math.max(
            MAX_NATR_PERCENT,
            toFiniteNumber(natrP95, MAX_NATR_PERCENT) * 1.35,
            toFiniteNumber(natrP50, 0.35) * 3.2
        );
        const adxBlock = clamp(
            Math.max(34, toFiniteNumber(percentile(adxSeries, 0.85), MAX_ADX_FOR_GRID) * 1.15),
            34,
            48
        );
        const volumeMin = Math.max(1, toFiniteNumber(percentile(volumeRatioSeries, 0.35), params?.minVolumeRatio || db?.minVolumeRatio || 1.05));
        return {
            natrLow,
            natrExtreme,
            adxBlock,
            volumeMin,
            natrP50,
            natrP95,
            adxP85: percentile(adxSeries, 0.85),
            sampleSize: natrSeries.length,
            adxSampleSize: adxSeries.length,
            volumeSampleSize: volumeRatioSeries.length
        };
    };

    const resolveDailyLossLimitUsdt = (db) => {
        const explicitLimit = toFiniteNumber(process.env.SMART_AUTO_MAX_DAILY_LOSS_USDT, NaN);
        if (Number.isFinite(explicitLimit) && explicitLimit > 0) return explicitLimit;
        const orderSize = Math.max(0, toFiniteNumber(db?.gridOrderSizeUsdt, 0));
        return Math.max(DEFAULT_MIN_DAILY_LOSS_USDT, orderSize * DEFAULT_MAX_DAILY_LOSS_MULTIPLIER);
    };

    const buildResult = ({ ok, score, status, reasons, warnings = [], metrics = {} }) => ({
        ok,
        score: clamp(Math.round(score), 0, 100),
        status,
        reasons,
        warnings,
        metrics
    });

    const evaluateSmartAutoPreflight = ({
        db,
        params,
        snapshot,
        availableUsdt = NaN,
        effectiveOrderSizeUsdt = NaN,
        effectiveOrdersPerSide = NaN,
        minOrderSizeUsdt = NaN
    } = {}) => {
        const reasons = [];
        const warnings = [];
        let score = 100;

        const currentPrice = toFiniteNumber(snapshot?.currentPrice, NaN);
        const atr = toFiniteNumber(snapshot?.currentATR, NaN);
        const natrPercent = toFiniteNumber(snapshot?.currentNatrPercent, NaN);
        const adx = toFiniteNumber(snapshot?.currentAdx, NaN);
        const volumeRatio = toFiniteNumber(snapshot?.volumeRatio, NaN);
        const adaptiveProfile = buildAdaptiveMarketProfile({ db, params, snapshot });
        const minVolumeRatio = Math.max(1, toFiniteNumber(params?.minVolumeRatio, adaptiveProfile.volumeMin));
        const adaptiveMinVolumeRatio = Math.max(minVolumeRatio, adaptiveProfile.volumeMin);
        const maxNatrPercent = adaptiveProfile.natrExtreme;
        const minNatrPercent = adaptiveProfile.natrLow;
        const maxAdxForGrid = adaptiveProfile.adxBlock;
        const gridRangePercent = toFiniteNumber(params?.gridRangePercent, NaN);
        const gridLevels = Math.max(0, Math.trunc(toFiniteNumber(params?.gridLevels, 0)));
        const gridStepPercent = gridLevels > 0 && Number.isFinite(gridRangePercent)
            ? gridRangePercent / gridLevels
            : NaN;
        const dailyPnl = toFiniteNumber(db?.dailyPnL, 0) + toFiniteNumber(db?.estimatedPnL, 0);
        const dailyTrades = Math.max(0, Math.trunc(toFiniteNumber(db?.dailyTrades, 0)));
        const dailyLossLimitUsdt = resolveDailyLossLimitUsdt(db);
        const orderSize = toFiniteNumber(effectiveOrderSizeUsdt, toFiniteNumber(params?.gridOrderSizeUsdt, db?.gridOrderSizeUsdt));
        const ordersPerSide = Math.max(0, Math.trunc(toFiniteNumber(effectiveOrdersPerSide, params?.gridOrdersPerSide)));
        const available = toFiniteNumber(availableUsdt, NaN);
        const plannedExposureUsdt = Number.isFinite(orderSize) && Number.isFinite(ordersPerSide)
            ? orderSize * ordersPerSide
            : NaN;

        if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
            reasons.push("Invalid current price");
            score -= 40;
        }
        if (!Number.isFinite(atr) || atr <= 0) {
            reasons.push("Invalid ATR snapshot");
            score -= 40;
        }
        if (Number.isFinite(natrPercent)) {
            if (natrPercent > maxNatrPercent) {
                reasons.push(`Volatility too extreme (${natrPercent.toFixed(3)}% NATR > adaptive ${maxNatrPercent.toFixed(3)}%)`);
                score -= 35;
            } else if (natrPercent < minNatrPercent) {
                reasons.push(`Volatility too low for grid (${natrPercent.toFixed(3)}% NATR < adaptive ${minNatrPercent.toFixed(3)}%)`);
                score -= 20;
            }
        }
        if (Number.isFinite(adx) && adx > maxAdxForGrid) {
            reasons.push(`Trend too strong for grid (ADX ${adx.toFixed(2)} > adaptive ${maxAdxForGrid.toFixed(2)})`);
            score -= 30;
        } else if (Number.isFinite(adx) && adx > toFiniteNumber(params?.entryAdxMax, maxAdxForGrid)) {
            warnings.push(`Trend is elevated (ADX ${adx.toFixed(2)})`);
            score -= 10;
        }
        if (!Number.isFinite(volumeRatio) || volumeRatio < adaptiveMinVolumeRatio) {
            reasons.push(`Volume ratio below requirement (${Number.isFinite(volumeRatio) ? volumeRatio.toFixed(2) : "N/A"}x < adaptive ${adaptiveMinVolumeRatio.toFixed(2)}x)`);
            score -= 25;
        }
        if (!Number.isFinite(gridStepPercent) || gridStepPercent < MIN_GRID_STEP_PERCENT) {
            reasons.push(`Grid step too tight (${Number.isFinite(gridStepPercent) ? gridStepPercent.toFixed(3) : "N/A"}%)`);
            score -= 25;
        }
        if (dailyPnl <= -dailyLossLimitUsdt) {
            reasons.push(`Daily loss limit reached (${dailyPnl.toFixed(2)} <= -${dailyLossLimitUsdt.toFixed(2)} USDT)`);
            score -= 50;
        }
        if (Number.isFinite(orderSize) && Number.isFinite(minOrderSizeUsdt) && minOrderSizeUsdt > 0 && orderSize < minOrderSizeUsdt) {
            reasons.push(`Order size below exchange minimum (${orderSize.toFixed(4)} < ${minOrderSizeUsdt.toFixed(4)} USDT)`);
            score -= 35;
        }
        if (Number.isFinite(available) && Number.isFinite(plannedExposureUsdt)) {
            const maxUsable = available * 0.9;
            if (plannedExposureUsdt > maxUsable) {
                reasons.push(`Planned exposure exceeds usable balance (${plannedExposureUsdt.toFixed(2)} > ${maxUsable.toFixed(2)} USDT)`);
                score -= 35;
            }
        }

        const ok = reasons.length === 0 && score >= 70;
        return buildResult({
            ok,
            score,
            status: ok ? "PASS" : "BLOCKED",
            reasons,
            warnings,
            metrics: {
                currentPrice,
                natrPercent,
                adx,
                volumeRatio,
                minVolumeRatio: adaptiveMinVolumeRatio,
                maxNatrPercent,
                minNatrPercent,
                maxAdxForGrid,
                gridStepPercent,
                dailyPnl,
                dailyLossLimitUsdt,
                dailyTrades,
                orderSize,
                ordersPerSide,
                plannedExposureUsdt,
                availableUsdt: available,
                adaptiveProfile
            }
        });
    };

    const formatSmartAutoPreflightLines = (preflight) => {
        if (!preflight) return [];
        const lines = [
            `   Smart Auto Preflight: ${preflight.status} score=${preflight.score}/100`
        ];
        if (preflight.reasons?.length) lines.push(`   Block Reasons: ${preflight.reasons.join(" | ")}`);
        if (preflight.warnings?.length) lines.push(`   Warnings: ${preflight.warnings.join(" | ")}`);
        return lines;
    };

    return {
        evaluateSmartAutoPreflight,
        formatSmartAutoPreflightLines,
        buildAdaptiveMarketProfile,
        resolveDailyLossLimitUsdt
    };
};

module.exports = { createSmartAutoPreflightHelpers };
