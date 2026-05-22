const createSmartAutoPreflightHelpers = ({ toFiniteNumber, clamp }) => {
    const DEFAULT_MAX_DAILY_LOSS_MULTIPLIER = 3;
    const DEFAULT_MIN_DAILY_LOSS_USDT = 2;
    const MAX_NATR_PERCENT = 1.8;
    const MIN_NATR_PERCENT = 0.03;
    const MAX_ADX_FOR_GRID = 38;
    const MIN_GRID_STEP_PERCENT = 0.08;

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
        const minVolumeRatio = Math.max(1, toFiniteNumber(params?.minVolumeRatio, db?.minVolumeRatio || 1.05));
        const gridRangePercent = toFiniteNumber(params?.gridRangePercent, NaN);
        const gridLevels = Math.max(0, Math.trunc(toFiniteNumber(params?.gridLevels, 0)));
        const gridStepPercent = gridLevels > 0 && Number.isFinite(gridRangePercent)
            ? gridRangePercent / gridLevels
            : NaN;
        const dailyPnl = toFiniteNumber(db?.dailyPnL, 0) + toFiniteNumber(db?.estimatedPnL, 0);
        const dailyTrades = Math.max(0, Math.trunc(toFiniteNumber(db?.dailyTrades, 0)));
        const maxTradesPerDay = Math.max(1, Math.trunc(toFiniteNumber(db?.maxTradesPerDay, 1)));
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
            if (natrPercent > MAX_NATR_PERCENT) {
                reasons.push(`Volatility too extreme (${natrPercent.toFixed(3)}% NATR)`);
                score -= 35;
            } else if (natrPercent < MIN_NATR_PERCENT) {
                reasons.push(`Volatility too low for grid (${natrPercent.toFixed(3)}% NATR)`);
                score -= 20;
            }
        }
        if (Number.isFinite(adx) && adx > MAX_ADX_FOR_GRID) {
            reasons.push(`Trend too strong for grid (ADX ${adx.toFixed(2)})`);
            score -= 30;
        } else if (Number.isFinite(adx) && adx > toFiniteNumber(params?.entryAdxMax, MAX_ADX_FOR_GRID)) {
            warnings.push(`Trend is elevated (ADX ${adx.toFixed(2)})`);
            score -= 10;
        }
        if (!Number.isFinite(volumeRatio) || volumeRatio < minVolumeRatio) {
            reasons.push(`Volume ratio below requirement (${Number.isFinite(volumeRatio) ? volumeRatio.toFixed(2) : "N/A"}x < ${minVolumeRatio}x)`);
            score -= 25;
        }
        if (!Number.isFinite(gridStepPercent) || gridStepPercent < MIN_GRID_STEP_PERCENT) {
            reasons.push(`Grid step too tight (${Number.isFinite(gridStepPercent) ? gridStepPercent.toFixed(3) : "N/A"}%)`);
            score -= 25;
        }
        if (dailyTrades >= maxTradesPerDay) {
            reasons.push(`Daily trade limit reached (${dailyTrades}/${maxTradesPerDay})`);
            score -= 40;
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
                minVolumeRatio,
                gridStepPercent,
                dailyPnl,
                dailyLossLimitUsdt,
                dailyTrades,
                maxTradesPerDay,
                orderSize,
                ordersPerSide,
                plannedExposureUsdt,
                availableUsdt: available
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
        resolveDailyLossLimitUsdt
    };
};

module.exports = { createSmartAutoPreflightHelpers };
