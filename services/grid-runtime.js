const createGridRuntimeHelpers = ({
    getDb,
    getExchange,
    getBalanceCache,
    getTickerCache,
    getSaveDB,
    defaultConfig,
    validMarginModes,
    normalizeSymbol,
    toFiniteNumber,
    clamp,
    formatPriceToMarketPrecision,
    formatAmountToMarketPrecision,
    validateOrderSize,
    isDirectionalOrderPlanValid,
    getClosePositionSide,
    isHedgeModeEnabled,
    getActivePositionsList,
    getExchangePositionSide,
    gridClientOrderPrefix,
    tpClientOrderPrefix,
    slClientOrderPrefix
}) => {
    const AUTO_GRID_LEVELS_MIN = 6;
    const AUTO_GRID_LEVELS_MAX = 18;
    const GRID_LEVELS_PROFILE_FACTORS = {
        binance: 1.0,
        doge: 1.1,
        volatile: 1.15
    };
    const GRID_LEVELS_PROFILE_LIMITS = {
        binance: { min: 6, max: 18 },
        doge: { min: 8, max: 16 },
        volatile: { min: 8, max: 18 }
    };
    const GRID_LEVELS_TIMEFRAME_FACTORS = {
        "1m": 1.2,
        "3m": 1.1,
        "5m": 1.0,
        "15m": 0.92,
        "30m": 0.85,
        "1h": 0.78,
        "4h": 0.68,
        "1d": 0.55
    };
    const GRID_RANGE_PROFILE_BASELINES = {
        binance: 4.0,
        doge: 5.4,
        volatile: 6.5
    };
    const GRID_RANGE_TIMEFRAME_FACTORS = {
        "1m": 0.85,
        "3m": 0.92,
        "5m": 1.0,
        "15m": 1.08,
        "30m": 1.16,
        "1h": 1.28,
        "4h": 1.42,
        "1d": 1.65
    };
    const GRID_BUFFER_PROFILE_BASELINES = {
        binance: 0.12,
        doge: 0.16,
        volatile: 0.18
    };
    const GRID_BUFFER_TIMEFRAME_FACTORS = {
        "1m": 0.9,
        "3m": 0.95,
        "5m": 1.0,
        "15m": 1.04,
        "30m": 1.08,
        "1h": 1.12,
        "4h": 1.18,
        "1d": 1.25
    };
    const ADAPTIVE_RANGE_LIMITS = { min: 2.5, max: 12.5 };
    const ADAPTIVE_LEVEL_LIMITS = { min: 6, max: 18 };

    const computeLogReturnStdDev = (closes = []) => {
        if (!Array.isArray(closes) || closes.length < 3) return NaN;
        const returns = [];
        for (let index = 1; index < closes.length; index += 1) {
            const previous = toFiniteNumber(closes[index - 1], NaN);
            const current = toFiniteNumber(closes[index], NaN);
            if (!Number.isFinite(previous) || previous <= 0 || !Number.isFinite(current) || current <= 0) continue;
            returns.push(Math.log(current / previous));
        }
        if (returns.length < 2) return NaN;
        const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
        const variance = returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / returns.length;
        return Math.sqrt(variance);
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
        return clamp(directionalMove / pathLength, 0, 1);
    };

    const buildAdaptiveVolatilityMetrics = (snapshot, lookbackCandles = defaultConfig.gridLookbackCandles) => {
        const safeLookback = Math.max(24, Math.trunc(toFiniteNumber(lookbackCandles, defaultConfig.gridLookbackCandles)));
        const closes = Array.isArray(snapshot?.close) ? snapshot.close.slice(-Math.max(safeLookback, 24)) : [];
        const highs = Array.isArray(snapshot?.high) ? snapshot.high.slice(-Math.max(safeLookback, 24)) : [];
        const lows = Array.isArray(snapshot?.low) ? snapshot.low.slice(-Math.max(safeLookback, 24)) : [];
        const currentPrice = toFiniteNumber(snapshot?.currentPrice, NaN);
        const currentATR = toFiniteNumber(snapshot?.currentATR, NaN);
        if (!Number.isFinite(currentPrice) || currentPrice <= 0 || !Number.isFinite(currentATR) || currentATR <= 0 || closes.length < 12) {
            return null;
        }

        const recentHigh = Math.max(...highs.filter((value) => Number.isFinite(value)));
        const recentLow = Math.min(...lows.filter((value) => Number.isFinite(value)));
        const normalizedAtrPercent = (currentATR / currentPrice) * 100;
        const realizedVolPercent = computeLogReturnStdDev(closes) * Math.sqrt(Math.min(closes.length, 24)) * 100;
        const swingPercent = Number.isFinite(recentHigh) && Number.isFinite(recentLow) && recentLow > 0
            ? ((recentHigh - recentLow) / ((recentHigh + recentLow) / 2)) * 100
            : normalizedAtrPercent * 4;
        const efficiencyRatio = computeEfficiencyRatio(closes, Math.min(20, closes.length - 1));
        const normalizedVolatilityScore = clamp(
            (
                clamp(normalizedAtrPercent / 2.2, 0, 1.8) * 0.45
            ) + (
                clamp(realizedVolPercent / 2.8, 0, 1.8) * 0.35
            ) + (
                clamp(swingPercent / 8.5, 0, 1.8) * 0.2
            ),
            0.2,
            1.8
        );

        return {
            normalizedAtrPercent,
            realizedVolPercent,
            swingPercent,
            efficiencyRatio: Number.isFinite(efficiencyRatio) ? efficiencyRatio : 0.35,
            normalizedVolatilityScore
        };
    };

    const resolveAdaptiveGridParameters = ({
        params = {},
        snapshot = null,
        availableUsdt = null
    } = {}) => {
        const db = getDb();
        const exchange = getExchange();
        const pair = db?.pair;
        const presetName = resolveAutoPairPresetName(pair);
        const currentPrice = toFiniteNumber(snapshot?.currentPrice, NaN);
        const market = exchange?.markets?.[pair];
        const lookbackCandles = Math.max(20, Math.trunc(toFiniteNumber(params.gridLookbackCandles, db?.gridLookbackCandles || defaultConfig.gridLookbackCandles)));
        const fallbackRangePercent = resolveEffectiveGridRangePercent({
            configuredGridRangePercent: params.configuredGridRangePercent ?? db?.gridRangePercent,
            pair,
            gridTimeframe: db?.gridTimeframe,
            gridLookbackCandles: lookbackCandles
        });
        const fallbackLevels = resolveEffectiveGridLevels({
            configuredGridLevels: params.configuredGridLevels ?? db?.gridLevels,
            pair,
            gridTimeframe: db?.gridTimeframe,
            gridRangePercent: fallbackRangePercent,
            gridLookbackCandles: lookbackCandles
        });
        const fallbackEntryBufferPercent = resolveEffectiveGridEntryBufferPercent({
            configuredGridEntryBufferPercent: params.configuredGridEntryBufferPercent ?? db?.gridEntryBufferPercent,
            pair,
            gridTimeframe: db?.gridTimeframe,
            gridRangePercent: fallbackRangePercent,
            gridLevels: fallbackLevels
        });
        const configuredOrderSizeUsdt = Math.max(0.1, toFiniteNumber(params.gridOrderSizeUsdt ?? db?.gridOrderSizeUsdt, defaultConfig.gridOrderSizeUsdt));
        const minimumOrderSizeUsdt = Number.isFinite(currentPrice) && currentPrice > 0
            ? getMinimumValidatedGridOrderSizeUsdt(market, currentPrice)
            : 0;
        const effectiveOrderSizeUsdt = Math.max(configuredOrderSizeUsdt, minimumOrderSizeUsdt);
        const volatility = buildAdaptiveVolatilityMetrics(snapshot, lookbackCandles);
        if (!volatility) {
            return {
                ...params,
                gridLevels: fallbackLevels,
                gridRangePercent: fallbackRangePercent,
                gridEntryBufferPercent: fallbackEntryBufferPercent,
                gridTakeProfitLevels: resolveEffectiveGridTakeProfitLevels(params.gridTakeProfitLevels),
                gridStopLossLevels: resolveEffectiveGridStopLossSteps(params.gridStopLossLevels, 1, null),
                gridStopLossPercent: Math.max(2, toFiniteNumber(db?.gridStopLossPercent, defaultConfig.gridStopLossPercent)),
                gridOrdersPerSide: resolveGridOrdersPerSideCap(params.gridOrdersPerSide, fallbackLevels),
                gridOrderSizeUsdt: effectiveOrderSizeUsdt,
                orderSizeUsdt: effectiveOrderSizeUsdt,
                autoGrid: {
                    mode: "FALLBACK",
                    presetName,
                    minimumOrderSizeUsdt,
                    volatilityScore: null
                }
            };
        }

        const availableCapital = toFiniteNumber(availableUsdt, getBalanceCache()?.availableUSDT);
        const capitalShare = Number.isFinite(availableCapital) && availableCapital > 0
            ? clamp(effectiveOrderSizeUsdt / availableCapital, 0, 1)
            : 0.12;
        const sizeMultiple = effectiveOrderSizeUsdt / Math.max(minimumOrderSizeUsdt, 1);
        const sizePressure = clamp(Math.log10(Math.max(1, sizeMultiple)), 0, 2.5);
        const pairRangeFactor = presetName === "volatile" ? 1.18 : (presetName === "doge" ? 1.1 : 1);
        const pairLevelBias = presetName === "volatile" ? 1 : (presetName === "doge" ? 0.5 : 0);

        const rangePercentRaw = Math.max(
            volatility.normalizedAtrPercent * 3.4,
            volatility.realizedVolPercent * 2.2,
            volatility.swingPercent * 0.72,
            2.4 + (volatility.normalizedVolatilityScore * 3.9) + (capitalShare * 12)
        ) * pairRangeFactor;
        const gridRangePercent = Number(clamp(rangePercentRaw, ADAPTIVE_RANGE_LIMITS.min, ADAPTIVE_RANGE_LIMITS.max).toFixed(2));

        const gridLevelsRaw = 7
            + (volatility.normalizedVolatilityScore * 6.8)
            + ((1 - volatility.efficiencyRatio) * 1.8)
            + pairLevelBias
            - (sizePressure * 1.1)
            - (capitalShare * 10);
        const gridLevels = clamp(Math.round(gridLevelsRaw), ADAPTIVE_LEVEL_LIMITS.min, ADAPTIVE_LEVEL_LIMITS.max);
        const gridStepPercent = gridRangePercent / Math.max(gridLevels, 1);
        const gridEntryBufferPercent = Number(clamp(
            Math.max(gridStepPercent * 0.28, volatility.normalizedAtrPercent * 0.16),
            0.05,
            0.45
        ).toFixed(3));
        const gridTakeProfitLevels = 1;
        const gridStopLossLevels = Number(clamp(
            1.3 + (volatility.normalizedVolatilityScore * 1.45) + (capitalShare * 4.5) + ((1 - volatility.efficiencyRatio) * 0.6),
            1.25,
            4.5
        ).toFixed(2));
        const gridStopLossPercent = Number(clamp(
            Math.max(
                gridRangePercent * 0.92,
                gridStepPercent * (gridStopLossLevels + 1),
                volatility.normalizedAtrPercent * 5.1
            ),
            Math.max(2.5, gridRangePercent * 0.65),
            gridRangePercent + 6
        ).toFixed(2));
        const maxOrdersPerSide = Math.max(1, gridLevels - 1);
        const affordableOrdersPerSide = Number.isFinite(availableCapital) && availableCapital > 0
            ? Math.floor((availableCapital * 0.9) / Math.max(effectiveOrderSizeUsdt * 2, 1e-8))
            : maxOrdersPerSide;
        const gridOrdersPerSide = clamp(affordableOrdersPerSide, 1, maxOrdersPerSide);

        return {
            ...params,
            gridLevels,
            gridRangePercent,
            gridEntryBufferPercent,
            gridTakeProfitLevels,
            gridStopLossLevels,
            gridStopLossPercent,
            gridOrdersPerSide,
            gridOrderSizeUsdt: effectiveOrderSizeUsdt,
            orderSizeUsdt: effectiveOrderSizeUsdt,
            autoGrid: {
                mode: "ADAPTIVE_OFFICIAL",
                presetName,
                minimumOrderSizeUsdt,
                volatilityScore: Number(volatility.normalizedVolatilityScore.toFixed(3)),
                normalizedAtrPercent: Number(volatility.normalizedAtrPercent.toFixed(3)),
                realizedVolPercent: Number(volatility.realizedVolPercent.toFixed(3)),
                swingPercent: Number(volatility.swingPercent.toFixed(3)),
                efficiencyRatio: Number(volatility.efficiencyRatio.toFixed(3)),
                capitalShare: Number(capitalShare.toFixed(3)),
                sizePressure: Number(sizePressure.toFixed(3)),
                gridStepPercent: Number(gridStepPercent.toFixed(3))
            }
        };
    };

    const resolveEffectiveGridRangePercent = ({
        configuredGridRangePercent,
        pair,
        gridTimeframe,
        gridLookbackCandles
    } = {}) => {
        const configured = toFiniteNumber(configuredGridRangePercent, defaultConfig.gridRangePercent);
        if (configured > 0) return Math.max(0.5, configured);

        const presetName = resolveAutoPairPresetName(pair || getDb()?.pair);
        const normalizedTimeframe = String(gridTimeframe || getDb()?.gridTimeframe || defaultConfig.gridTimeframe).trim();
        const safeLookbackCandles = Math.max(20, Math.trunc(toFiniteNumber(gridLookbackCandles, defaultConfig.gridLookbackCandles)));
        const baseline = GRID_RANGE_PROFILE_BASELINES[presetName] || defaultConfig.gridRangePercent;
        const timeframeFactor = GRID_RANGE_TIMEFRAME_FACTORS[normalizedTimeframe] || 1.0;
        const lookbackFactor = clamp(0.92 + ((safeLookbackCandles - 120) / 600), 0.85, 1.2);
        const derivedRange = baseline * timeframeFactor * lookbackFactor;
        return Number(clamp(derivedRange, 2.5, 9.5).toFixed(2));
    };

    const resolveEffectiveGridEntryBufferPercent = ({
        configuredGridEntryBufferPercent,
        pair,
        gridTimeframe,
        gridRangePercent,
        gridLevels
    } = {}) => {
        const configured = toFiniteNumber(configuredGridEntryBufferPercent, defaultConfig.gridEntryBufferPercent);
        if (configured > 0) return Math.max(0.02, configured);

        const presetName = resolveAutoPairPresetName(pair || getDb()?.pair);
        const normalizedTimeframe = String(gridTimeframe || getDb()?.gridTimeframe || defaultConfig.gridTimeframe).trim();
        const safeRangePercent = Math.max(0.5, toFiniteNumber(gridRangePercent, defaultConfig.gridRangePercent));
        const safeGridLevels = Math.max(4, Math.trunc(toFiniteNumber(gridLevels, defaultConfig.gridLevels)));
        const baseline = GRID_BUFFER_PROFILE_BASELINES[presetName] || defaultConfig.gridEntryBufferPercent;
        const timeframeFactor = GRID_BUFFER_TIMEFRAME_FACTORS[normalizedTimeframe] || 1.0;
        const rangeFactor = clamp(safeRangePercent / 4.5, 0.85, 1.25);
        const levelsFactor = clamp(10 / safeGridLevels, 0.8, 1.15);
        const derivedBuffer = baseline * timeframeFactor * rangeFactor * levelsFactor;
        return Number(clamp(derivedBuffer, 0.08, 0.3).toFixed(3));
    };

    const resolveEffectiveGridLevels = ({
        configuredGridLevels,
        pair,
        gridTimeframe,
        gridRangePercent,
        gridLookbackCandles
    } = {}) => {
        const configured = Math.trunc(toFiniteNumber(configuredGridLevels, defaultConfig.gridLevels));
        if (configured > 0) return Math.max(4, configured);

        const presetName = resolveAutoPairPresetName(pair || getDb()?.pair);
        const safeRangePercent = Math.max(0.5, toFiniteNumber(gridRangePercent, defaultConfig.gridRangePercent));
        const safeLookbackCandles = Math.max(20, Math.trunc(toFiniteNumber(gridLookbackCandles, defaultConfig.gridLookbackCandles)));
        const normalizedTimeframe = String(gridTimeframe || getDb()?.gridTimeframe || defaultConfig.gridTimeframe).trim();
        const profileFactor = GRID_LEVELS_PROFILE_FACTORS[presetName] || 1.0;
        const profileLimits = GRID_LEVELS_PROFILE_LIMITS[presetName] || { min: AUTO_GRID_LEVELS_MIN, max: AUTO_GRID_LEVELS_MAX };
        const timeframeFactor = GRID_LEVELS_TIMEFRAME_FACTORS[normalizedTimeframe] || 1.0;
        const lookbackComponent = Math.sqrt(safeLookbackCandles / 30) * 1.4;
        const rangeComponent = safeRangePercent / 0.72;
        const derivedLevels = Math.round((lookbackComponent + rangeComponent) * profileFactor * timeframeFactor);
        return clamp(derivedLevels, profileLimits.min, profileLimits.max);
    };

    const getSignalParameters = () => {
        const db = getDb();
        const volumePeriod = Math.max(2, Math.trunc(toFiniteNumber(db.volumePeriod, defaultConfig.volumePeriod)));
        const atrPeriod = Math.max(2, Math.trunc(toFiniteNumber(db.atrPeriod, defaultConfig.atrPeriod)));
        const gridLookbackCandles = Math.max(20, Math.trunc(toFiniteNumber(db.gridLookbackCandles, defaultConfig.gridLookbackCandles)));
        const gridRangePercent = resolveEffectiveGridRangePercent({
            configuredGridRangePercent: db.gridRangePercent,
            pair: db.pair,
            gridTimeframe: db.gridTimeframe,
            gridLookbackCandles
        });
        const gridLevels = resolveEffectiveGridLevels({
            configuredGridLevels: db.gridLevels,
            pair: db.pair,
            gridTimeframe: db.gridTimeframe,
            gridRangePercent,
            gridLookbackCandles
        });
        const gridEntryBufferPercent = resolveEffectiveGridEntryBufferPercent({
            configuredGridEntryBufferPercent: db.gridEntryBufferPercent,
            pair: db.pair,
            gridTimeframe: db.gridTimeframe,
            gridRangePercent,
            gridLevels
        });
        const gridTakeProfitLevels = Math.max(0, Math.trunc(toFiniteNumber(db.gridTakeProfitLevels, defaultConfig.gridTakeProfitLevels)));
        const neededCandles = Math.max(gridLookbackCandles + 5, volumePeriod + 10, atrPeriod + 10, 150);
        return {
            strategy: "futures_grid",
            volumePeriod,
            atrPeriod,
            neededCandles,
            gridLookbackCandles,
            configuredGridLevels: Math.max(0, Math.trunc(toFiniteNumber(db.gridLevels, defaultConfig.gridLevels))),
            configuredGridRangePercent: Math.max(0, toFiniteNumber(db.gridRangePercent, defaultConfig.gridRangePercent)),
            configuredGridEntryBufferPercent: Math.max(0, toFiniteNumber(db.gridEntryBufferPercent, defaultConfig.gridEntryBufferPercent)),
            gridLevels,
            gridTakeProfitLevels,
            gridOrdersPerSide: Math.max(0, Math.trunc(toFiniteNumber(db.gridOrdersPerSide, defaultConfig.gridOrdersPerSide))),
            gridOrderSizeUsdt: Math.max(0, toFiniteNumber(db.gridOrderSizeUsdt, defaultConfig.gridOrderSizeUsdt)),
            gridRangePercent,
            gridEntryBufferPercent,
            gridStopLossLevels: Math.max(0, toFiniteNumber(db.gridStopLossLevels, defaultConfig.gridStopLossLevels))
        };
    };

    const resolveEffectiveGridTakeProfitLevels = (configuredTakeProfitLevels) => {
        const configured = Math.trunc(toFiniteNumber(configuredTakeProfitLevels, 0));
        return configured <= 0 ? 1 : Math.max(1, configured);
    };

    const resolveEffectiveGridStopLossSteps = (configuredStopLossLevels, step, atr = null) => {
        const configured = toFiniteNumber(configuredStopLossLevels, 0);
        if (configured > 0) return Math.max(0.5, configured);
        const atrSteps = Number.isFinite(atr) && Number.isFinite(step) && step > 0 ? atr / step : 1.2;
        return clamp(Math.max(1.2, atrSteps), 1.2, 3.0);
    };

    const findNearestGridLevelIndex = (levels, entryPrice) => {
        if (!Array.isArray(levels) || levels.length === 0 || !Number.isFinite(entryPrice)) return 0;
        let bestIndex = 0;
        let bestDistance = Infinity;
        for (let i = 0; i < levels.length; i++) {
            const distance = Math.abs(toFiniteNumber(levels[i], NaN) - entryPrice);
            if (distance < bestDistance) {
                bestDistance = distance;
                bestIndex = i;
            }
        }
        return bestIndex;
    };

    const buildGridExitPlan = ({
        side,
        entryIndex,
        levels,
        step,
        params,
        gridState = null,
        atr = null
    } = {}) => {
        const db = getDb();
        const normalizedSide = String(side || "").toLowerCase();
        const safeLevels = Array.isArray(levels) ? levels : [];
        const safeStep = toFiniteNumber(step, NaN);
        if ((normalizedSide !== "buy" && normalizedSide !== "sell") || safeLevels.length < 2 || !Number.isFinite(safeStep) || safeStep <= 0) {
            return { targetPrice: NaN, stopLossPrice: NaN, takeProfitLevels: 0, stopLossSteps: 0, mode: "INVALID" };
        }

        const takeProfitLevels = resolveEffectiveGridTakeProfitLevels(params?.gridTakeProfitLevels);
        const stopLossSteps = resolveEffectiveGridStopLossSteps(params?.gridStopLossLevels, safeStep, atr);
        const safeEntryIndex = clamp(Math.trunc(toFiniteNumber(entryIndex, 0)), 0, safeLevels.length - 1);
        const lowerBound = toFiniteNumber(gridState?.lowerBound, safeLevels[0]);
        const upperBound = toFiniteNumber(gridState?.upperBound, safeLevels[safeLevels.length - 1]);
        const autoStopMode = !(toFiniteNumber(params?.gridStopLossLevels, 0) > 0);

        if (normalizedSide === "buy") {
            const targetIndex = clamp(safeEntryIndex + takeProfitLevels, 1, safeLevels.length - 1);
            const rawStop = autoStopMode
                ? lowerBound - (safeStep * stopLossSteps)
                : toFiniteNumber(safeLevels[safeEntryIndex], lowerBound) - (safeStep * stopLossSteps);
            return {
                targetPrice: formatPriceToMarketPrecision(db.pair, safeLevels[targetIndex]),
                stopLossPrice: formatPriceToMarketPrecision(db.pair, rawStop),
                takeProfitLevels,
                stopLossSteps,
                mode: autoStopMode ? "AUTO_RANGE_SL" : "FIXED_STEP_SL"
            };
        }

        const targetIndex = clamp(safeEntryIndex - takeProfitLevels, 0, Math.max(0, safeLevels.length - 2));
        const rawStop = autoStopMode
            ? upperBound + (safeStep * stopLossSteps)
            : toFiniteNumber(safeLevels[safeEntryIndex], upperBound) + (safeStep * stopLossSteps);
        return {
            targetPrice: formatPriceToMarketPrecision(db.pair, safeLevels[targetIndex]),
            stopLossPrice: formatPriceToMarketPrecision(db.pair, rawStop),
            takeProfitLevels,
            stopLossSteps,
            mode: autoStopMode ? "AUTO_RANGE_SL" : "FIXED_STEP_SL"
        };
    };

    const buildGridLevels = (lowerBound, upperBound, gridLevels) => {
        const safeLevels = Math.max(2, Math.trunc(gridLevels));
        const step = (upperBound - lowerBound) / safeLevels;
        const levels = [];
        for (let i = 0; i <= safeLevels; i++) levels.push(lowerBound + (step * i));
        return { levels, step };
    };

    const resolveGridOrdersPerSideCap = (configuredOrdersPerSide, gridLevels = getDb()?.gridLevels) => {
        const safeGridLevels = Math.max(2, Math.trunc(toFiniteNumber(gridLevels, 2)));
        const configured = Math.trunc(toFiniteNumber(configuredOrdersPerSide, 0));
        return configured <= 0 ? Math.max(1, safeGridLevels - 1) : Math.max(1, configured);
    };

    const getMinimumGridOrderSizeUsdt = (market, referencePrice) => {
        const db = getDb();
        const safeReferencePrice = toFiniteNumber(referencePrice, NaN);
        if (!Number.isFinite(safeReferencePrice) || safeReferencePrice <= 0) return 0;
        const leverage = Math.max(1, toFiniteNumber(db.leverage, 1));
        const minAmount = toFiniteNumber(market?.limits?.amount?.min, 0);
        const minCost = toFiniteNumber(market?.limits?.cost?.min, 0);
        const amountFloorUsdt = Number.isFinite(minAmount) && minAmount > 0 ? (minAmount * safeReferencePrice) / leverage : 0;
        const costFloorUsdt = Number.isFinite(minCost) && minCost > 0 ? minCost / leverage : 0;
        return Math.max(costFloorUsdt, amountFloorUsdt, 0);
    };

    const getMinimumValidatedGridOrderSizeUsdt = (market, referencePrice) => {
        const db = getDb();
        const safeReferencePrice = toFiniteNumber(referencePrice, NaN);
        const baseMinimum = getMinimumGridOrderSizeUsdt(market, safeReferencePrice);
        if (!Number.isFinite(baseMinimum) || baseMinimum <= 0 || !market || !Number.isFinite(safeReferencePrice) || safeReferencePrice <= 0) {
            return Math.max(0, baseMinimum);
        }

        const leverage = Math.max(1, toFiniteNumber(db.leverage, 1));
        let candidate = baseMinimum;
        const increment = Math.max(baseMinimum * 0.01, 0.01);

        for (let attempt = 0; attempt < 25; attempt++) {
            const rawQty = (candidate * leverage) / safeReferencePrice;
            const quantity = formatAmountToMarketPrecision(db.pair, rawQty);
            const sizeValidation = validateOrderSize(market, quantity, safeReferencePrice);
            if (sizeValidation.valid) return candidate;
            candidate += increment;
        }

        return candidate;
    };

    const resolveEffectiveGridOrderSizeUsdt = ({
        availableUsdt,
        configuredOrderSizeUsdt,
        configuredOrdersPerSide,
        referencePrice,
        market,
        gridLevels
    } = {}) => {
        const maxConfiguredOrders = resolveGridOrdersPerSideCap(configuredOrdersPerSide, gridLevels);
        const safeAvailableUsdt = toFiniteNumber(availableUsdt, 0);
        const usableUsdt = safeAvailableUsdt * 0.9;
        const minOrderSizeUsdt = getMinimumValidatedGridOrderSizeUsdt(market, referencePrice);
        const configuredSize = toFiniteNumber(configuredOrderSizeUsdt, 0);
        const isFullAutoSize = configuredSize <= 0;
        const derivedAutoSize = maxConfiguredOrders > 0 ? usableUsdt / Math.max(maxConfiguredOrders * 2, 1) : 0;
        const orderSizeUsdt = isFullAutoSize ? Math.max(derivedAutoSize, minOrderSizeUsdt) : configuredSize;
        return {
            orderSizeUsdt: Math.max(0, orderSizeUsdt),
            minOrderSizeUsdt,
            mode: isFullAutoSize ? "FULL_AUTO" : "CAPPED",
            maxConfiguredOrders
        };
    };

    const resolveGridOrderSizeForPrice = (baseOrderSizeUsdt, price, market) => {
        const configuredBaseSize = Math.max(0, toFiniteNumber(baseOrderSizeUsdt, 0));
        const minimumValidatedSize = getMinimumValidatedGridOrderSizeUsdt(market, price);
        return Math.max(configuredBaseSize, minimumValidatedSize);
    };

    const resolveEffectiveGridOrdersPerSide = ({
        availableUsdt,
        configuredOrdersPerSide,
        perOrderMargin,
        referencePrice,
        market,
        gridLevels
    } = {}) => {
        const db = getDb();
        const maxConfigured = resolveGridOrdersPerSideCap(configuredOrdersPerSide, gridLevels);
        const safeAvailableUsdt = toFiniteNumber(availableUsdt, 0);
        const safePerOrderMargin = Math.max(0, toFiniteNumber(perOrderMargin, db.gridOrderSizeUsdt));
        const safeReferencePrice = toFiniteNumber(referencePrice, NaN);
        if (maxConfigured <= 0 || safePerOrderMargin <= 0 || safeAvailableUsdt <= 0 || !Number.isFinite(safeReferencePrice) || safeReferencePrice <= 0) {
            return { count: 0, maxConfigured, mode: configuredOrdersPerSide <= 0 ? "FULL_AUTO" : "CAPPED", reason: "INVALID_INPUT" };
        }

        const rawQty = (safePerOrderMargin * Math.max(1, toFiniteNumber(db.leverage, 1))) / safeReferencePrice;
        const quantity = formatAmountToMarketPrecision(db.pair, rawQty);
        const sizeValidation = validateOrderSize(market, quantity, safeReferencePrice);
        if (!sizeValidation.valid) {
            return { count: 0, maxConfigured, mode: configuredOrdersPerSide <= 0 ? "FULL_AUTO" : "CAPPED", reason: sizeValidation.reason };
        }

        const usableUsdt = safeAvailableUsdt * 0.9;
        const affordablePerSide = Math.floor(usableUsdt / Math.max(safePerOrderMargin * 2, 1e-8));
        return {
            count: clamp(affordablePerSide, 0, maxConfigured),
            maxConfigured,
            mode: configuredOrdersPerSide <= 0 ? "FULL_AUTO" : "CAPPED",
            reason: null
        };
    };

    const getGridStateFingerprint = (params) => {
        const db = getDb();
        return [
            normalizeSymbol(db?.pair),
            params?.gridTimeframe || db?.gridTimeframe || "",
            params?.configuredGridLevels,
            params?.gridLevels,
            params?.configuredGridRangePercent,
            params?.gridLookbackCandles,
            params?.gridRangePercent,
            params?.configuredGridEntryBufferPercent,
            params?.gridTakeProfitLevels,
            params?.gridStopLossLevels
        ].join("|");
    };

    const sanitizeGridState = (state, params) => {
        if (!state || typeof state !== "object") return null;
        const lowerBound = toFiniteNumber(state.lowerBound, NaN);
        const upperBound = toFiniteNumber(state.upperBound, NaN);
        const step = toFiniteNumber(state.step, NaN);
        const levels = Array.isArray(state.levels) ? state.levels.map((level) => toFiniteNumber(level, NaN)) : [];
        const expectedLevels = Math.max(2, Math.trunc(toFiniteNumber(params?.gridLevels, NaN)));
        if (!Number.isFinite(lowerBound) || !Number.isFinite(upperBound) || !Number.isFinite(step)) return null;
        if (!(upperBound > lowerBound) || step <= 0) return null;
        if (levels.length !== expectedLevels + 1 || levels.some((level) => !Number.isFinite(level))) return null;
        if (String(state.fingerprint || "") !== getGridStateFingerprint(params)) return null;
        return {
            lowerBound,
            upperBound,
            step,
            levels,
            referencePrice: toFiniteNumber(state.referencePrice, (lowerBound + upperBound) / 2),
            createdAt: toFiniteNumber(state.createdAt, Date.now()),
            fingerprint: state.fingerprint
        };
    };

    const createLockedGridState = (snapshot, params) => {
        const recentHigh = Math.max(...snapshot.high.slice(-(params.gridLookbackCandles)));
        const recentLow = Math.min(...snapshot.low.slice(-(params.gridLookbackCandles)));
        const referencePrice = (recentHigh + recentLow) / 2;
        const lowerBound = Math.min(referencePrice * (1 - (params.gridRangePercent / 100)), recentLow);
        const upperBound = Math.max(referencePrice * (1 + (params.gridRangePercent / 100)), recentHigh);
        const { levels, step } = buildGridLevels(lowerBound, upperBound, params.gridLevels);
        if (!Number.isFinite(step) || step <= 0) return null;
        return {
            fingerprint: getGridStateFingerprint(params),
            referencePrice,
            lowerBound,
            upperBound,
            step,
            levels,
            createdAt: Date.now()
        };
    };

    const hasGridStateChanged = (currentState, nextState) => {
        if (!currentState || !nextState) return true;
        return currentState.fingerprint !== nextState.fingerprint ||
            currentState.lowerBound !== nextState.lowerBound ||
            currentState.upperBound !== nextState.upperBound ||
            currentState.step !== nextState.step;
    };

    const resolveActiveGridState = async (snapshot, params) => {
        const db = getDb();
        const persistedState = sanitizeGridState(db?.activeGridState, params);
        const price = toFiniteNumber(snapshot?.currentPrice, NaN);
        const priceInsideLockedRange = persistedState
            ? Number.isFinite(price) && price >= persistedState.lowerBound && price <= persistedState.upperBound
            : false;
        if (persistedState && priceInsideLockedRange) return persistedState;

        const nextState = createLockedGridState(snapshot, params);
        if (!nextState) return null;

        const rebuildReason = !persistedState ? "INIT" : (!priceInsideLockedRange ? "PRICE_OUT_OF_RANGE" : "PARAM_CHANGE");
        console.log(`[GRID][INFO] ${rebuildReason}: locking range ${nextState.lowerBound.toFixed(6)} - ${nextState.upperBound.toFixed(6)} | step ${nextState.step.toFixed(6)}`);

        if (hasGridStateChanged(persistedState, nextState)) {
            db.activeGridState = nextState;
            await getSaveDB()();
        }
        return nextState;
    };

    const getGridClientOrderId = (side, levelIndex, price) => {
        const db = getDb();
        const safePrice = String(formatPriceToMarketPrecision(db?.pair, price) ?? price).replace(/[^\d]/g, "");
        return `${gridClientOrderPrefix}_${side}_${levelIndex}_${safePrice}`.slice(0, 36);
    };

    const getTpClientOrderId = (position) => {
        const db = getDb();
        const positionSide = getClosePositionSide(position);
        const side = position?.side === "buy" ? "sell" : "buy";
        const safeTarget = String(formatPriceToMarketPrecision(db?.pair, position?.targetPrice) ?? position?.targetPrice ?? "").replace(/[^\d]/g, "");
        return `${tpClientOrderPrefix}_${positionSide}_${side}_${safeTarget}`.slice(0, 36);
    };

    const getSlClientOrderId = (position) => {
        const db = getDb();
        const positionSide = getClosePositionSide(position);
        const side = position?.side === "buy" ? "sell" : "buy";
        const safeStop = String(formatPriceToMarketPrecision(db?.pair, position?.stopLossPrice) ?? position?.stopLossPrice ?? "").replace(/[^\d]/g, "");
        return `${slClientOrderPrefix}_${positionSide}_${side}_${safeStop}`.slice(0, 36);
    };

    const buildGridEntryOrders = (snapshot, params, gridState = null) => {
        const db = getDb();
        const exchange = getExchange();
        const resolvedGridState = sanitizeGridState(gridState, params) || createLockedGridState(snapshot, params);
        const levels = resolvedGridState?.levels || [];
        const step = toFiniteNumber(resolvedGridState?.step, NaN);
        if (!Number.isFinite(step) || step <= 0) return [];
        const market = exchange?.markets?.[db?.pair];
        const minBuyPrice = snapshot.currentPrice * (1 - (params.gridEntryBufferPercent / 100));
        const maxSellPrice = snapshot.currentPrice * (1 + (params.gridEntryBufferPercent / 100));
        const buyOrders = [];
        const sellOrders = [];

        for (let i = levels.length - 2; i >= 0; i--) {
            const price = formatPriceToMarketPrecision(db.pair, levels[i]);
            const exitPlan = buildGridExitPlan({ side: "buy", entryIndex: i, levels, step, params, gridState: resolvedGridState, atr: snapshot?.currentATR });
            const targetPrice = exitPlan.targetPrice;
            const stopLossPrice = exitPlan.stopLossPrice;
            const orderSizeUsdt = resolveGridOrderSizeForPrice(params.gridOrderSizeUsdt, price, market);
            const orderPlan = { targetPrice, stopLossPrice };
            if (Number.isFinite(price) && price > 0 && price < minBuyPrice) {
                if (!isDirectionalOrderPlanValid("buy", price, orderPlan)) {
                    console.warn(`[GRID][WARN] Skipping BUY level ${i} @ ${price} because TP/SL would be invalid after precision rounding.`);
                    continue;
                }
                buyOrders.push({ side: "buy", price, orderSizeUsdt, targetPrice, stopLossPrice, levelIndex: i, clientOrderId: getGridClientOrderId("buy", i, price) });
            }
        }

        for (let i = 1; i < levels.length; i++) {
            const price = formatPriceToMarketPrecision(db.pair, levels[i]);
            const exitPlan = buildGridExitPlan({ side: "sell", entryIndex: i, levels, step, params, gridState: resolvedGridState, atr: snapshot?.currentATR });
            const targetPrice = exitPlan.targetPrice;
            const stopLossPrice = exitPlan.stopLossPrice;
            const orderSizeUsdt = resolveGridOrderSizeForPrice(params.gridOrderSizeUsdt, price, market);
            const orderPlan = { targetPrice, stopLossPrice };
            if (Number.isFinite(price) && price > 0 && price > maxSellPrice) {
                if (!isDirectionalOrderPlanValid("sell", price, orderPlan)) {
                    console.warn(`[GRID][WARN] Skipping SELL level ${i} @ ${price} because TP/SL would be invalid after precision rounding.`);
                    continue;
                }
                sellOrders.push({ side: "sell", price, orderSizeUsdt, targetPrice, stopLossPrice, levelIndex: i, clientOrderId: getGridClientOrderId("sell", i, price) });
            }
        }

        const seen = new Set();
        const deduped = [];
        let duplicateCount = 0;
        const effectiveOrdersPerSide = Math.max(0, Math.trunc(toFiniteNumber(params.gridOrdersPerSide, 0)));
        const selectedOrders = [...buyOrders.slice(0, effectiveOrdersPerSide), ...sellOrders.slice(0, effectiveOrdersPerSide)];
        for (const order of selectedOrders) {
            const key = `${order.side}:${order.price}`;
            if (seen.has(key)) {
                duplicateCount += 1;
                continue;
            }
            seen.add(key);
            deduped.push(order);
        }
        if (duplicateCount > 0) {
            console.warn(`[GRID][WARN] Deduped ${duplicateCount} grid order(s) that collapsed to the same rounded price.`);
        }
        return deduped;
    };

    const getActiveGridExposureSides = (openPositions = [], trackedPositions = getActivePositionsList()) => {
        const exposureSides = new Set();
        for (const position of openPositions || []) {
            const side = String(getExchangePositionSide(position) || "").toLowerCase();
            if (side === "buy" || side === "sell") exposureSides.add(side);
        }
        for (const position of trackedPositions || []) {
            const side = String(position?.side || "").toLowerCase();
            if (side === "buy" || side === "sell") exposureSides.add(side);
        }
        return exposureSides;
    };

    const filterGridOrdersForActiveExposure = (orders, openPositions = [], trackedPositions = getActivePositionsList()) => {
        if (!Array.isArray(orders) || orders.length === 0) return [];
        const exposureSides = getActiveGridExposureSides(openPositions, trackedPositions);
        if (exposureSides.size === 0 || isHedgeModeEnabled()) return orders;
        return orders.filter((order) => exposureSides.has(String(order?.side || "").toLowerCase()));
    };

    const resolveAutoPairPresetName = (pair) => {
        const normalizedPair = String(pair || "").trim().toUpperCase();
        if (!normalizedPair) return "binance";
        if (normalizedPair.includes("DOGE")) return "doge";
        if (/(PEPE|BONK|FLOKI|SHIB|MEME|1000)/i.test(normalizedPair)) return "volatile";
        return "binance";
    };

    const getActiveAutoPairPresetName = () => resolveAutoPairPresetName(getDb()?.pair);

    const getGridRuntimeSummary = (currentPrice = NaN, managedOrders = null) => {
        const db = getDb();
        const exchange = getExchange();
        const balanceCache = getBalanceCache();
        const tickerCache = getTickerCache();
        const presetName = getActiveAutoPairPresetName();
        const gridState = db?.activeGridState;
        const effectiveGridLevels = resolveEffectiveGridLevels({
            configuredGridLevels: db?.gridLevels,
            pair: db?.pair,
            gridTimeframe: db?.gridTimeframe,
            gridRangePercent: resolveEffectiveGridRangePercent({
                configuredGridRangePercent: db?.gridRangePercent,
                pair: db?.pair,
                gridTimeframe: db?.gridTimeframe,
                gridLookbackCandles: db?.gridLookbackCandles
            }),
            gridLookbackCandles: db?.gridLookbackCandles
        });
        const effectiveGridRangePercent = resolveEffectiveGridRangePercent({
            configuredGridRangePercent: db?.gridRangePercent,
            pair: db?.pair,
            gridTimeframe: db?.gridTimeframe,
            gridLookbackCandles: db?.gridLookbackCandles
        });
        const effectiveGridEntryBufferPercent = resolveEffectiveGridEntryBufferPercent({
            configuredGridEntryBufferPercent: db?.gridEntryBufferPercent,
            pair: db?.pair,
            gridTimeframe: db?.gridTimeframe,
            gridRangePercent: effectiveGridRangePercent,
            gridLevels: effectiveGridLevels
        });
        const lowerBound = toFiniteNumber(gridState?.lowerBound, NaN);
        const upperBound = toFiniteNumber(gridState?.upperBound, NaN);
        const step = toFiniteNumber(gridState?.step, NaN);
        const levels = Array.isArray(gridState?.levels) ? gridState.levels : [];
        const hasLockedGrid = Number.isFinite(lowerBound) && Number.isFinite(upperBound) && upperBound > lowerBound && Number.isFinite(step) && step > 0;
        const insideRange = hasLockedGrid && Number.isFinite(currentPrice) ? currentPrice >= lowerBound && currentPrice <= upperBound : false;

        let slotLabel = "N/A";
        if (hasLockedGrid && Number.isFinite(currentPrice)) {
            const rawIndex = (currentPrice - lowerBound) / step;
            const clampedIndex = clamp(rawIndex, 0, Math.max(0, levels.length - 1));
            const lowerIndex = clamp(Math.floor(clampedIndex), 0, Math.max(0, levels.length - 2));
            const upperIndex = clamp(lowerIndex + 1, 1, Math.max(1, levels.length - 1));
            slotLabel = `${lowerIndex}/${Math.max(1, effectiveGridLevels)}${insideRange ? "" : " OUT"}`;
            if (Number.isFinite(levels[lowerIndex]) && Number.isFinite(levels[upperIndex])) {
                slotLabel += ` (${levels[lowerIndex].toFixed(6)} - ${levels[upperIndex].toFixed(6)})`;
            }
        }

        const gridOrders = Array.isArray(managedOrders?.grid) ? managedOrders.grid : [];
        const buyOrders = gridOrders.filter((order) => String(order?.side || "").toLowerCase() === "buy").length;
        const sellOrders = gridOrders.filter((order) => String(order?.side || "").toLowerCase() === "sell").length;
        const availableUsdt = Number.isFinite(balanceCache.availableUSDT) ? balanceCache.availableUSDT : balanceCache.totalUSDT;
        const referencePrice = Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : (hasLockedGrid ? (lowerBound + upperBound) / 2 : tickerCache.price);
        const effectiveSizeMeta = resolveEffectiveGridOrderSizeUsdt({
            availableUsdt,
            configuredOrderSizeUsdt: db.gridOrderSizeUsdt,
            configuredOrdersPerSide: db.gridOrdersPerSide,
            referencePrice,
            market: exchange?.markets?.[db?.pair],
            gridLevels: effectiveGridLevels
        });
        const effectiveOrdersMeta = resolveEffectiveGridOrdersPerSide({
            availableUsdt,
            configuredOrdersPerSide: db.gridOrdersPerSide,
            perOrderMargin: effectiveSizeMeta.orderSizeUsdt,
            referencePrice,
            market: exchange?.markets?.[db?.pair],
            gridLevels: effectiveGridLevels
        });

        return {
            presetName,
            configuredGridLevels: Math.max(0, Math.trunc(toFiniteNumber(db?.gridLevels, defaultConfig.gridLevels))),
            effectiveGridLevels,
            gridLevelsMode: Math.trunc(toFiniteNumber(db?.gridLevels, defaultConfig.gridLevels)) <= 0 ? "AUTO" : "MANUAL",
            configuredGridRangePercent: Math.max(0, toFiniteNumber(db?.gridRangePercent, defaultConfig.gridRangePercent)),
            effectiveGridRangePercent,
            gridRangeMode: toFiniteNumber(db?.gridRangePercent, defaultConfig.gridRangePercent) <= 0 ? "AUTO" : "MANUAL",
            configuredGridEntryBufferPercent: Math.max(0, toFiniteNumber(db?.gridEntryBufferPercent, defaultConfig.gridEntryBufferPercent)),
            effectiveGridEntryBufferPercent,
            gridEntryBufferMode: toFiniteNumber(db?.gridEntryBufferPercent, defaultConfig.gridEntryBufferPercent) <= 0 ? "AUTO" : "MANUAL",
            hasLockedGrid,
            lockedRangeLabel: hasLockedGrid ? `${lowerBound.toFixed(6)} - ${upperBound.toFixed(6)}` : "N/A",
            stepLabel: hasLockedGrid ? step.toFixed(6) : "N/A",
            slotLabel,
            ladderLabel: `${buyOrders} buy / ${sellOrders} sell`,
            effectiveOrdersPerSide: effectiveOrdersMeta.count,
            configuredOrdersPerSideCap: effectiveOrdersMeta.maxConfigured,
            ordersMode: effectiveOrdersMeta.mode,
            effectiveOrderSizeUsdt: effectiveSizeMeta.orderSizeUsdt,
            minOrderSizeUsdt: effectiveSizeMeta.minOrderSizeUsdt,
            sizeMode: effectiveSizeMeta.mode,
            availableUsdtLabel: Number.isFinite(availableUsdt) ? availableUsdt.toFixed(2) : "N/A"
        };
    };

    const buildGridStateFingerprintForConfig = (config) => [
        normalizeSymbol(config?.pair),
        config?.gridTimeframe || "",
        Math.max(0, Math.trunc(toFiniteNumber(config?.gridLevels, defaultConfig.gridLevels))),
        resolveEffectiveGridLevels({
            configuredGridLevels: config?.gridLevels,
            pair: config?.pair,
            gridTimeframe: config?.gridTimeframe,
            gridRangePercent: resolveEffectiveGridRangePercent({
                configuredGridRangePercent: config?.gridRangePercent,
                pair: config?.pair,
                gridTimeframe: config?.gridTimeframe,
                gridLookbackCandles: config?.gridLookbackCandles
            }),
            gridLookbackCandles: config?.gridLookbackCandles
        }),
        Math.max(0, toFiniteNumber(config?.gridRangePercent, defaultConfig.gridRangePercent)),
        Math.max(20, Math.trunc(toFiniteNumber(config?.gridLookbackCandles, defaultConfig.gridLookbackCandles))),
        resolveEffectiveGridRangePercent({
            configuredGridRangePercent: config?.gridRangePercent,
            pair: config?.pair,
            gridTimeframe: config?.gridTimeframe,
            gridLookbackCandles: config?.gridLookbackCandles
        }),
        Math.max(0, toFiniteNumber(config?.gridEntryBufferPercent, defaultConfig.gridEntryBufferPercent)),
        Math.max(0, Math.trunc(toFiniteNumber(config?.gridTakeProfitLevels, defaultConfig.gridTakeProfitLevels))),
        Math.max(0, toFiniteNumber(config?.gridStopLossLevels, defaultConfig.gridStopLossLevels))
    ].join("|");

    const applyAutoPairGridPreset = (config, autoPairGridPresets) => {
        if (!config || typeof config !== "object") return { config, changed: false, presetName: null };
        const strategy = String(config.strategy || "").toLowerCase();
        if (strategy && strategy !== "futures_grid") return { config, changed: false, presetName: null };
        const presets = autoPairGridPresets && typeof autoPairGridPresets === "object" ? autoPairGridPresets : {};

        const presetName = resolveAutoPairPresetName(config.pair);
        const preset = presets[presetName];
        if (!preset) return { config, changed: false, presetName: null };

        const gridKeys = Object.keys(preset);
        let changed = false;
        const nextConfig = { ...config };
        for (const key of gridKeys) {
            if (nextConfig[key] !== preset[key]) {
                nextConfig[key] = preset[key];
                changed = true;
            }
        }

        const rawMarginMode = typeof config.marginMode === "string" ? config.marginMode.trim().toLowerCase() : "";
        if (validMarginModes.includes(rawMarginMode)) nextConfig.marginMode = rawMarginMode;

        const activeGridFingerprint = String(nextConfig.activeGridState?.fingerprint || "");
        const expectedGridFingerprint = buildGridStateFingerprintForConfig(nextConfig);
        if (activeGridFingerprint !== expectedGridFingerprint || changed) {
            if (nextConfig.activeGridState !== null) changed = true;
            nextConfig.activeGridState = null;
        }

        nextConfig.strategy = "futures_grid";
        return { config: nextConfig, changed, presetName };
    };

    return {
        getSignalParameters,
        resolveAdaptiveGridParameters,
        resolveEffectiveGridTakeProfitLevels,
        resolveEffectiveGridStopLossSteps,
        findNearestGridLevelIndex,
        buildGridExitPlan,
        buildGridLevels,
        resolveEffectiveGridLevels,
        resolveEffectiveGridRangePercent,
        resolveEffectiveGridEntryBufferPercent,
        resolveGridOrdersPerSideCap,
        getMinimumGridOrderSizeUsdt,
        getMinimumValidatedGridOrderSizeUsdt,
        resolveEffectiveGridOrderSizeUsdt,
        resolveGridOrderSizeForPrice,
        resolveEffectiveGridOrdersPerSide,
        getGridStateFingerprint,
        sanitizeGridState,
        createLockedGridState,
        hasGridStateChanged,
        resolveActiveGridState,
        getGridClientOrderId,
        getTpClientOrderId,
        getSlClientOrderId,
        buildGridEntryOrders,
        getActiveGridExposureSides,
        filterGridOrdersForActiveExposure,
        resolveAutoPairPresetName,
        getActiveAutoPairPresetName,
        getGridRuntimeSummary,
        buildGridStateFingerprintForConfig,
        applyAutoPairGridPreset
    };
};

module.exports = { createGridRuntimeHelpers };
