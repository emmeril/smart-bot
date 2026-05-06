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
    const UNIVERSAL_PROFILE_NAME = "universal";
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
    const GRID_LEVELS_BASE_FACTOR = 1.02;
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
    const GRID_RANGE_BASELINE = 4.4;
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
    const GRID_BUFFER_BASELINE = 0.14;
    const LEGACY_AUTO_PRESET_VALUES = {
        gridTargetProfitUsdt: [0.5, 0.4, 0.35, 0.25],
        targetProfitAtrMultiplier: [0.75, 0.8, 0.7, 0.6],
        targetProfitMinUsdt: [0.25, 0.3, 0.2, 0.15],
        targetProfitMaxUsdt: [3, 4, 2, 1.25],
        gridStopLossPercent: [5, 6, 4],
        stopLossAtrMultiplier: [0.12, 0.15, 0.1],
        stopLossMinPercent: [3, 4, 2.5],
        stopLossMaxPercent: [7, 9, 6],
        gridLevels: [8, 10, 12],
        gridLookbackCandles: [120, 144, 180],
        gridRangePercent: [3.5, 4, 5.5, 6.5],
        gridEntryBufferPercent: [0.15, 0.12, 0.16, 0.18],
        minVolumeRatio: [1.3, 1.1, 1.05],
        trailingActivateATR: [1.2, 1.3, 1.4],
        trailingOffsetATR: [0.6, 0.7, 0.8]
    };

    const resolveEffectiveGridRangePercent = ({
        configuredGridRangePercent,
        pair,
        gridTimeframe,
        gridLookbackCandles
    } = {}) => {
        const configured = toFiniteNumber(configuredGridRangePercent, defaultConfig.gridRangePercent);
        if (configured > 0) return Math.max(0.5, configured);

        const normalizedTimeframe = String(gridTimeframe || getDb()?.gridTimeframe || defaultConfig.gridTimeframe).trim();
        const safeLookbackCandles = Math.max(20, Math.trunc(toFiniteNumber(gridLookbackCandles, defaultConfig.gridLookbackCandles)));
        const timeframeFactor = GRID_RANGE_TIMEFRAME_FACTORS[normalizedTimeframe] || 1.0;
        const lookbackFactor = clamp(0.92 + ((safeLookbackCandles - 120) / 600), 0.85, 1.2);
        const derivedRange = GRID_RANGE_BASELINE * timeframeFactor * lookbackFactor;
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

        const normalizedTimeframe = String(gridTimeframe || getDb()?.gridTimeframe || defaultConfig.gridTimeframe).trim();
        const safeRangePercent = Math.max(0.5, toFiniteNumber(gridRangePercent, defaultConfig.gridRangePercent));
        const safeGridLevels = Math.max(4, Math.trunc(toFiniteNumber(gridLevels, defaultConfig.gridLevels)));
        const timeframeFactor = GRID_BUFFER_TIMEFRAME_FACTORS[normalizedTimeframe] || 1.0;
        const rangeFactor = clamp(safeRangePercent / 4.5, 0.85, 1.25);
        const levelsFactor = clamp(10 / safeGridLevels, 0.8, 1.15);
        const derivedBuffer = GRID_BUFFER_BASELINE * timeframeFactor * rangeFactor * levelsFactor;
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

        const safeRangePercent = Math.max(0.5, toFiniteNumber(gridRangePercent, defaultConfig.gridRangePercent));
        const safeLookbackCandles = Math.max(20, Math.trunc(toFiniteNumber(gridLookbackCandles, defaultConfig.gridLookbackCandles)));
        const normalizedTimeframe = String(gridTimeframe || getDb()?.gridTimeframe || defaultConfig.gridTimeframe).trim();
        const timeframeFactor = GRID_LEVELS_TIMEFRAME_FACTORS[normalizedTimeframe] || 1.0;
        const lookbackComponent = Math.sqrt(safeLookbackCandles / 30) * 1.4;
        const rangeComponent = safeRangePercent / 0.72;
        const derivedLevels = Math.round((lookbackComponent + rangeComponent) * GRID_LEVELS_BASE_FACTOR * timeframeFactor);
        return clamp(derivedLevels, AUTO_GRID_LEVELS_MIN, AUTO_GRID_LEVELS_MAX);
    };

    const getSignalParameters = () => {
        const db = getDb();
        const volumePeriod = Math.max(2, Math.trunc(toFiniteNumber(db.volumePeriod, defaultConfig.volumePeriod)));
        const atrPeriod = Math.max(2, Math.trunc(toFiniteNumber(db.atrPeriod, defaultConfig.atrPeriod)));
        const entryRsiPeriod = Math.max(2, Math.trunc(toFiniteNumber(db.entryRsiPeriod, defaultConfig.entryRsiPeriod || 14)));
        const entryAdxPeriod = Math.max(2, Math.trunc(toFiniteNumber(db.entryAdxPeriod, defaultConfig.entryAdxPeriod || 14)));
        const entryBbPeriod = Math.max(5, Math.trunc(toFiniteNumber(db.entryBbPeriod, defaultConfig.entryBbPeriod || 20)));
        const entryBbStdDev = Math.max(1, toFiniteNumber(db.entryBbStdDev, defaultConfig.entryBbStdDev || 2));
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
        const neededCandles = Math.max(gridLookbackCandles + 5, volumePeriod + 10, atrPeriod + 30, entryBbPeriod + 30, entryAdxPeriod + 40, 180);
        return {
            strategy: "spot_grid",
            volumePeriod,
            atrPeriod,
            entryRsiPeriod,
            entryRsiLongThreshold: clamp(toFiniteNumber(db.entryRsiLongThreshold, defaultConfig.entryRsiLongThreshold || 40), 1, 49),
            entryRsiShortThreshold: clamp(toFiniteNumber(db.entryRsiShortThreshold, defaultConfig.entryRsiShortThreshold || 60), 51, 99),
            entryAdxPeriod,
            entryAdxMax: clamp(toFiniteNumber(db.entryAdxMax, defaultConfig.entryAdxMax || 32), 5, 80),
            entryBbPeriod,
            entryBbStdDev,
            entryBbLongThreshold: clamp(toFiniteNumber(db.entryBbLongThreshold, defaultConfig.entryBbLongThreshold || 0.2), 0, 0.49),
            entryBbShortThreshold: clamp(toFiniteNumber(db.entryBbShortThreshold, defaultConfig.entryBbShortThreshold || 0.8), 0.51, 1),
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
        const safeReferencePrice = toFiniteNumber(referencePrice, NaN);
        if (!Number.isFinite(safeReferencePrice) || safeReferencePrice <= 0) return 0;

        const minAmount = toFiniteNumber(market?.limits?.amount?.min, NaN);
        const minCost = toFiniteNumber(market?.limits?.cost?.min, NaN);
        const filters = Array.isArray(market?.info?.filters) ? market.info.filters : [];
        const minNotionalFilter = filters.find((filter) => String(filter?.filterType || '').toUpperCase() === 'MIN_NOTIONAL');
        const notionalFilter = filters.find((filter) => String(filter?.filterType || '').toUpperCase() === 'NOTIONAL');
        const minNotional = toFiniteNumber(
            minCost,
            toFiniteNumber(notionalFilter?.minNotional, toFiniteNumber(minNotionalFilter?.minNotional, NaN))
        );

        const amountFloorUsdt = Number.isFinite(minAmount) && minAmount > 0 ? (minAmount * safeReferencePrice) : 0;
        const notionalFloorUsdt = Number.isFinite(minNotional) && minNotional > 0 ? minNotional : 0;
        return Math.max(amountFloorUsdt, notionalFloorUsdt, 0);
    };

    const getMinimumValidatedGridOrderSizeUsdt = (market, referencePrice) => {
        const safeReferencePrice = toFiniteNumber(referencePrice, NaN);
        const baseMinimum = getMinimumGridOrderSizeUsdt(market, safeReferencePrice);
        if (!Number.isFinite(baseMinimum) || baseMinimum <= 0 || !market || !Number.isFinite(safeReferencePrice) || safeReferencePrice <= 0) {
            return Math.max(0, baseMinimum);
        }

        let candidate = baseMinimum;
        const increment = Math.max(baseMinimum * 0.01, 0.01);
        const pair = market?.symbol || getDb()?.pair || null;

        for (let attempt = 0; attempt < 25; attempt++) {
            const rawQty = candidate / safeReferencePrice;
            const quantity = pair ? formatAmountToMarketPrecision(pair, rawQty) : rawQty;
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

        const rawQty = safePerOrderMargin / safeReferencePrice;
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

    const resolveAutoPairPresetName = () => UNIVERSAL_PROFILE_NAME;

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
        if (strategy && strategy !== "spot_grid") return { config, changed: false, presetName: null };
        const presets = autoPairGridPresets && typeof autoPairGridPresets === "object" ? autoPairGridPresets : {};

        const presetName = resolveAutoPairPresetName(config.pair);
        const preset = presets[presetName];
        if (!preset) return { config, changed: false, presetName: null };

        const gridKeys = Object.keys(preset);
        let changed = false;
        const nextConfig = { ...config };
        const shouldApplyPresetValue = (key, currentValue) => (
            currentValue === undefined ||
            currentValue === null ||
            currentValue === "" ||
            currentValue === defaultConfig[key] ||
            (Array.isArray(LEGACY_AUTO_PRESET_VALUES[key]) && LEGACY_AUTO_PRESET_VALUES[key].includes(currentValue))
        );
        for (const key of gridKeys) {
            if (!shouldApplyPresetValue(key, nextConfig[key])) continue;
            if (nextConfig[key] !== preset[key]) {
                nextConfig[key] = preset[key];
                changed = true;
            }
        }

        nextConfig.marginMode = "spot";

        const activeGridFingerprint = String(nextConfig.activeGridState?.fingerprint || "");
        const expectedGridFingerprint = buildGridStateFingerprintForConfig(nextConfig);
        if (activeGridFingerprint !== expectedGridFingerprint || changed) {
            if (nextConfig.activeGridState !== null) changed = true;
            nextConfig.activeGridState = null;
        }

        nextConfig.strategy = "spot_grid";
        return { config: nextConfig, changed, presetName };
    };

    return {
        getSignalParameters,
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
