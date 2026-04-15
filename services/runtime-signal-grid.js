const createRuntimeSignalGridHelpers = ({
    getDb,
    getAccountPositionMode,
    getExchange,
    getIsSyncingGridOrders,
    setIsSyncingGridOrders,
    getLastGridSyncLogAt,
    setLastGridSyncLogAt,
    getLastGridExposureLogAt,
    setLastGridExposureLogAt,
    getLastGridExposureLogKey,
    setLastGridExposureLogKey,
    getLastGridSizingSkipLogAt,
    setLastGridSizingSkipLogAt,
    getLastGridSizingSkipReason,
    setLastGridSizingSkipReason,
    getGridSizingStateLogCache,
    signalDetailLogTtl,
    gridSyncLogTtl,
    gridSizingSkipLogTtl,
    gridSizingStateLogTtl,
    toFiniteNumber,
    clamp,
    resolveEffectiveGridTakeProfitLevels,
    resolveEffectiveGridStopLossSteps,
    sanitizeGridState,
    createLockedGridState,
    buildGridExitPlan,
    isDirectionalOrderPlanValid,
    getSignalParameters,
    getOHLCV,
    buildSignalSnapshot,
    evaluateCrossoverSignal,
    getSignalCount,
    setSignalCount,
    getMetrics,
    getLastLogTime,
    setLastLogTime,
    getLastSignalDetailLogAt,
    setLastSignalDetailLogAt,
    buildRiskOverrides,
    resolveEffectiveGridOrderSizeUsdt,
    resolveEffectiveGridOrdersPerSide,
    fetchOpenGridOrders,
    cancelDuplicateManagedOrders,
    cancelGridOrders,
    getAvailableUSDTBalance,
    maybeLogGridSizingStateExternal,
    fetchOpenExchangePositions,
    getActivePositionsList,
    resolveActiveGridState,
    buildGridEntryOrders,
    filterGridOrdersForActiveExposure,
    getExchangeClientOrderId,
    placeGridEntryOrder,
    isHedgeModeEnabled,
    hasAnyActivePosition,
    getActivePositionByKey,
    placeOrder
}) => {
    const evaluateGridSignal = (snapshot, params, gridState = null) => {
        const db = getDb();
        const recentClose = snapshot.close.slice(-(params.gridLookbackCandles));
        if (recentClose.length < params.gridLookbackCandles) {
            return {
                canLong: false, canShort: false, setupDetected: false,
                detailTitle: "BINANCE GRID ANALYSIS",
                extraDetailLines: ["   Not enough candle data to build grid range."]
            };
        }

        const resolvedGridState = sanitizeGridState(gridState, params) || createLockedGridState(snapshot, params);
        const referencePrice = toFiniteNumber(resolvedGridState?.referencePrice, NaN);
        const lowerBound = toFiniteNumber(resolvedGridState?.lowerBound, NaN);
        const upperBound = toFiniteNumber(resolvedGridState?.upperBound, NaN);
        const levels = resolvedGridState?.levels || [];
        const step = toFiniteNumber(resolvedGridState?.step, NaN);
        if (!Number.isFinite(step) || step <= 0) {
            return {
                canLong: false, canShort: false, setupDetected: false,
                detailTitle: "BINANCE GRID ANALYSIS",
                extraDetailLines: ["   Grid step is too small to evaluate safely."]
            };
        }
        const rawIndex = (snapshot.currentPrice - lowerBound) / step;
        const clampedIndex = clamp(rawIndex, 0, levels.length - 1);
        const lowerIndex = clamp(Math.floor(clampedIndex), 0, levels.length - 2);
        const upperIndex = clamp(lowerIndex + 1, 1, levels.length - 1);
        const currentLevelLow = levels[lowerIndex];
        const currentLevelHigh = levels[upperIndex];
        const buffer = snapshot.currentPrice * (params.gridEntryBufferPercent / 100);
        const distanceFromMidSteps = (snapshot.currentPrice - referencePrice) / step;
        const volumeOk = snapshot.volumeRatio >= db.minVolumeRatio;
        const sessionOk = db.sessionStartUTC <= db.sessionEndUTC
            ? snapshot.hourUTC >= db.sessionStartUTC && snapshot.hourUTC <= db.sessionEndUTC
            : snapshot.hourUTC >= db.sessionStartUTC || snapshot.hourUTC <= db.sessionEndUTC;
        const insideRange = snapshot.currentPrice >= lowerBound && snapshot.currentPrice <= upperBound;
        const meanReversionLong = db.allowLong && insideRange && distanceFromMidSteps <= -1 && snapshot.currentPrice <= currentLevelLow + buffer;
        const meanReversionShort = db.allowShort && insideRange && distanceFromMidSteps >= 1 && snapshot.currentPrice >= currentLevelHigh - buffer;
        const canLong = meanReversionLong && volumeOk && sessionOk;
        const canShort = meanReversionShort && volumeOk && sessionOk;
        const longExitPlan = buildGridExitPlan({
            side: "buy",
            entryIndex: lowerIndex,
            levels,
            step,
            params,
            gridState: resolvedGridState,
            atr: snapshot.currentATR
        });
        const shortExitPlan = buildGridExitPlan({
            side: "sell",
            entryIndex: upperIndex,
            levels,
            step,
            params,
            gridState: resolvedGridState,
            atr: snapshot.currentATR
        });
        const longTargetPrice = longExitPlan.targetPrice;
        const shortTargetPrice = shortExitPlan.targetPrice;
        const longStopPrice = longExitPlan.stopLossPrice;
        const shortStopPrice = shortExitPlan.stopLossPrice;
        const longPlan = canLong ? { targetPrice: longTargetPrice, stopLossPrice: longStopPrice } : null;
        const shortPlan = canShort ? { targetPrice: shortTargetPrice, stopLossPrice: shortStopPrice } : null;
        const longPlanValid = canLong ? isDirectionalOrderPlanValid("buy", currentLevelLow, longPlan) : false;
        const shortPlanValid = canShort ? isDirectionalOrderPlanValid("sell", currentLevelHigh, shortPlan) : false;
        const safeCanLong = canLong && longPlanValid;
        const safeCanShort = canShort && shortPlanValid;
        if (canLong && !longPlanValid) {
            console.warn("[GRID][WARN] Long setup rejected because TP/SL would be invalid after precision rounding.");
        }
        if (canShort && !shortPlanValid) {
            console.warn("[GRID][WARN] Short setup rejected because TP/SL would be invalid after precision rounding.");
        }

        return {
            canLong: safeCanLong,
            canShort: safeCanShort,
            setupDetected: safeCanLong || safeCanShort,
            detailTitle: "BINANCE GRID ANALYSIS",
            strategyName: "FUTURES_GRID",
            longPlan: safeCanLong ? { targetPrice: longTargetPrice, stopLossPrice: longStopPrice, gridIndex: lowerIndex } : null,
            shortPlan: safeCanShort ? { targetPrice: shortTargetPrice, stopLossPrice: shortStopPrice, gridIndex: upperIndex } : null,
            extraDetailLines: [
                `   Reference Price: ${referencePrice.toFixed(6)}`,
                `   Grid Range: ${lowerBound.toFixed(6)} - ${upperBound.toFixed(6)} | Width ${params.configuredGridRangePercent <= 0 ? `AUTO ${params.gridRangePercent}%` : `${params.gridRangePercent}%`}`,
                `   Grid Levels: ${params.configuredGridLevels <= 0 ? `AUTO ${params.gridLevels}` : params.gridLevels} | Step: ${step.toFixed(6)}`,
                `   Entry Buffer: ${params.configuredGridEntryBufferPercent <= 0 ? `AUTO ${params.gridEntryBufferPercent}%` : `${params.gridEntryBufferPercent}%`}`,
                `   TP/SL Mode: TP ${params.gridTakeProfitLevels <= 0 ? "AUTO_NEXT_GRID" : `${resolveEffectiveGridTakeProfitLevels(params.gridTakeProfitLevels)} GRID`} | SL ${params.gridStopLossLevels <= 0 ? `AUTO_RANGE ${longExitPlan.stopLossSteps.toFixed(2)} step` : `${resolveEffectiveGridStopLossSteps(params.gridStopLossLevels, step, snapshot.currentATR).toFixed(2)} step`}`,
                `   Current Slot: ${lowerIndex}/${params.gridLevels} (${currentLevelLow.toFixed(6)} - ${currentLevelHigh.toFixed(6)})`,
                `   Distance From Mid: ${distanceFromMidSteps.toFixed(2)} steps`,
                `   Volume Ratio: ${snapshot.volumeRatio.toFixed(2)}x (min ${db.minVolumeRatio}x) -> ${volumeOk ? "[OK]" : "[NO]"}`,
                `   Session Filter: ${sessionOk ? "[OK]" : "[NO]"}`,
                `   Long Grid Re-entry: ${meanReversionLong ? "[OK]" : "[NO]"}`,
                `   Short Grid Re-entry: ${meanReversionShort ? "[OK]" : "[NO]"}`,
                `   Long TP/SL Valid: ${longPlanValid ? "[OK]" : "[NO]"}`,
                `   Short TP/SL Valid: ${shortPlanValid ? "[OK]" : "[NO]"}`
            ]
        };
    };

    const applySignalGuards = (signalState, snapshot) => {
        const safeSignal = {
            canLong: Boolean(signalState?.canLong),
            canShort: Boolean(signalState?.canShort),
            setupDetected: Boolean(signalState?.setupDetected),
            detailTitle: signalState?.detailTitle || "SIGNAL ANALYSIS",
            strategyName: signalState?.strategyName || "UNKNOWN",
            longPlan: signalState?.longPlan || null,
            shortPlan: signalState?.shortPlan || null,
            extraDetailLines: Array.isArray(signalState?.extraDetailLines) ? signalState.extraDetailLines : []
        };

        const currentPrice = toFiniteNumber(snapshot?.currentPrice, NaN);
        const currentATR = toFiniteNumber(snapshot?.currentATR, NaN);
        if (!Number.isFinite(currentPrice) || currentPrice <= 0 || !Number.isFinite(currentATR) || currentATR <= 0) {
            return {
                ...safeSignal,
                canLong: false,
                canShort: false,
                setupDetected: false,
                extraDetailLines: [...safeSignal.extraDetailLines, "   Signal rejected: invalid price or ATR snapshot."]
            };
        }

        return {
            ...safeSignal,
            setupDetected: safeSignal.canLong || safeSignal.canShort
        };
    };

    const logSignalDetails = (params, snapshot, signalState) => {
        const db = getDb();
        const printSpacer = () => console.log("");
        const printSignalHeader = () => {
            console.log("\n" + "=".repeat(50));
            console.log(`${signalState.detailTitle} (${db.gridTimeframe}):`);
            console.log(`   Current Price: ${snapshot.currentPrice}`);
            console.log(`   Current Volume: ${snapshot.currentVolume.toFixed(2)}`);
            console.log(`   Avg Volume (${params.volumePeriod}): ${snapshot.avgVolume.toFixed(2)}`);
            console.log(`   Volume Ratio: ${snapshot.volumeRatio.toFixed(2)}x`);
            console.log(`   ATR ${params.atrPeriod}: ${snapshot.currentATR.toFixed(6)}`);
        };
        const printSignalSection = (title, lines) => {
            printSpacer();
            console.log(title);
            lines.forEach((line) => console.log(line));
        };
        const printFinalSignalLine = (label, confirmed) => (
            console.log(`   ${label} Signal: ${confirmed ? "[OK] CONFIRMED" : "[NO] NOT CONFIRMED"}`)
        );

        printSignalHeader();
        printSignalSection("SETUP CONDITIONS:", signalState.extraDetailLines);
        printSpacer();
        console.log("FINAL SIGNAL:");
        printFinalSignalLine("LONG", signalState.canLong);
        printFinalSignalLine("SHORT", signalState.canShort);
        console.log("=".repeat(50));
    };

    const logGridSyncStatus = (desiredOrders, openGridOrders) => {
        const now = Date.now();
        if (now - getLastGridSyncLogAt() < gridSyncLogTtl) return;
        console.log(`[GRID][INFO] Desired ladder=${desiredOrders.length} | Open grid orders=${openGridOrders.length}`);
        setLastGridSyncLogAt(now);
    };

    const maybeLogGridSizingState = (channel, message, stateKey) => {
        const now = Date.now();
        const gridSizingStateLogCache = getGridSizingStateLogCache();
        const cached = gridSizingStateLogCache.get(channel) || { key: "", at: 0 };
        if (stateKey !== cached.key || now - cached.at >= gridSizingStateLogTtl) {
            console.log(message);
            gridSizingStateLogCache.set(channel, { key: stateKey, at: now });
        }
    };

    const analyzeSignal = async () => {
        try {
            const db = getDb();
            const metrics = getMetrics();
            if (!db) return {};
            setSignalCount(getSignalCount() + 1);
            metrics.signals.analyzed++;
            const strategy = String(db.strategy || "futures_grid").toLowerCase();
            const now = Date.now();
            if (now - getLastLogTime() > 5000) {
                console.log(`[SIGNAL][INFO] #${getSignalCount()} Analyzing ${strategy.toUpperCase()} setup (${db.gridTimeframe})...`);
                setLastLogTime(now);
            }

            const params = getSignalParameters();
            const ohlcv = await getOHLCV(params.neededCandles);
            if (ohlcv.length < params.neededCandles) {
                console.log(`[SIGNAL][WARN] Not enough OHLCV data: ${ohlcv.length} < ${params.neededCandles}`);
                return {};
            }

            const snapshot = buildSignalSnapshot(ohlcv, params);
            if (!snapshot || snapshot.invalidAtr) {
                console.log("[SIGNAL][WARN] Invalid data for signal");
                return {};
            }

            const signalState = strategy === "futures_grid"
                ? evaluateGridSignal(snapshot, params)
                : (typeof evaluateCrossoverSignal === "function"
                    ? evaluateCrossoverSignal(snapshot, params)
                    : {
                        canLong: false,
                        canShort: false,
                        setupDetected: false,
                        detailTitle: "UNSUPPORTED STRATEGY",
                        strategyName: strategy.toUpperCase(),
                        extraDetailLines: [`   Strategy ${strategy} is not supported by the current build.`]
                    });
            const finalState = applySignalGuards(signalState, snapshot);

            if (finalState.setupDetected) metrics.signals.crossoverDetected++;
            if (finalState.canLong) metrics.signals.longConfirmed++;
            if (finalState.canShort) metrics.signals.shortConfirmed++;

            const shouldDetailLog = finalState.setupDetected || (Date.now() - getLastSignalDetailLogAt() >= signalDetailLogTtl);
            if (shouldDetailLog) {
                logSignalDetails(params, snapshot, finalState);
                setLastSignalDetailLogAt(Date.now());
            }

            return {
                canLong: finalState.canLong,
                canShort: finalState.canShort,
                price: snapshot.currentPrice,
                atr: snapshot.currentATR,
                hasSignal: finalState.setupDetected,
                strategy: signalState.strategyName || strategy.toUpperCase(),
                riskOverrides: buildRiskOverrides(),
                targetPrice: finalState.canLong ? signalState.longPlan?.targetPrice : (finalState.canShort ? signalState.shortPlan?.targetPrice : null),
                stopLossPrice: finalState.canLong ? signalState.longPlan?.stopLossPrice : (finalState.canShort ? signalState.shortPlan?.stopLossPrice : null)
            };
        } catch (error) {
            console.error("[SIGNAL][ERROR] Signal analysis failed:", error.message);
            return {};
        }
    };

    const syncGridOrders = async () => {
        const db = getDb();
        const exchange = getExchange();
        if (!db || String(db.strategy || "futures_grid").toLowerCase() !== "futures_grid") return;
        if (getIsSyncingGridOrders()) return;
        setIsSyncingGridOrders(true);

        try {
            const params = getSignalParameters();
            const ohlcv = await getOHLCV(params.neededCandles);
            if (ohlcv.length < params.neededCandles) {
                console.log(`[GRID][INFO] Not enough OHLCV data to manage ladder: ${ohlcv.length} < ${params.neededCandles}`);
                return;
            }

            const snapshot = buildSignalSnapshot(ohlcv, params);
            if (!snapshot || snapshot.invalidAtr) {
                console.log("[GRID][INFO] Invalid market snapshot. Ladder sync skipped.");
                return;
            }

            const availableUsdt = await getAvailableUSDTBalance();
            const effectiveSizeMeta = resolveEffectiveGridOrderSizeUsdt({
                availableUsdt,
                configuredOrderSizeUsdt: params.gridOrderSizeUsdt,
                configuredOrdersPerSide: params.gridOrdersPerSide,
                referencePrice: snapshot.currentPrice,
                market: exchange?.markets?.[db?.pair],
                gridLevels: params.gridLevels
            });
            params.gridOrderSizeUsdt = effectiveSizeMeta.orderSizeUsdt;
            const effectiveOrdersMeta = resolveEffectiveGridOrdersPerSide({
                availableUsdt,
                configuredOrdersPerSide: params.gridOrdersPerSide,
                perOrderMargin: params.gridOrderSizeUsdt,
                referencePrice: snapshot.currentPrice,
                market: exchange?.markets?.[db?.pair],
                gridLevels: params.gridLevels
            });
            params.gridOrdersPerSide = effectiveOrdersMeta.count;
            let openGridOrders = await fetchOpenGridOrders();
            openGridOrders = await cancelDuplicateManagedOrders(openGridOrders, "GRID_DUPLICATE", "GRID");

            if (effectiveSizeMeta.orderSizeUsdt <= 0 || effectiveOrdersMeta.count <= 0) {
                if (openGridOrders.length > 0) await cancelGridOrders(openGridOrders, "INSUFFICIENT_BALANCE");
                const reasonText = effectiveOrdersMeta.reason ? ` Reason: ${effectiveOrdersMeta.reason}` : "";
                const skipMessage = `[GRID] Auto sizing skipped ladder | size ${effectiveSizeMeta.orderSizeUsdt.toFixed(4)} USDT | side orders ${effectiveOrdersMeta.count}/${effectiveOrdersMeta.maxConfigured} | available ${availableUsdt.toFixed(2)} USDT.${reasonText}`;
                const now = Date.now();
                if (skipMessage !== getLastGridSizingSkipReason() || now - getLastGridSizingSkipLogAt() >= gridSizingSkipLogTtl) {
                    console.log(skipMessage);
                    setLastGridSizingSkipReason(skipMessage);
                    setLastGridSizingSkipLogAt(now);
                }
                return;
            }

            setLastGridSizingSkipReason("");

            if (effectiveSizeMeta.mode === "FULL_AUTO") {
                maybeLogGridSizingStateExternal
                    ? maybeLogGridSizingStateExternal(
                        "SIZE",
                        `[GRID] Auto-sized order amount: ${effectiveSizeMeta.orderSizeUsdt.toFixed(4)} USDT per order | available ${availableUsdt.toFixed(2)} USDT`,
                        `SIZE:${effectiveSizeMeta.orderSizeUsdt.toFixed(4)}:${availableUsdt.toFixed(2)}`
                    )
                    : maybeLogGridSizingState(
                        "SIZE",
                        `[GRID] Auto-sized order amount: ${effectiveSizeMeta.orderSizeUsdt.toFixed(4)} USDT per order | available ${availableUsdt.toFixed(2)} USDT`,
                        `SIZE:${effectiveSizeMeta.orderSizeUsdt.toFixed(4)}:${availableUsdt.toFixed(2)}`
                    );
            }
            if (effectiveOrdersMeta.count < effectiveOrdersMeta.maxConfigured) {
                maybeLogGridSizingStateExternal
                    ? maybeLogGridSizingStateExternal(
                        "COUNT",
                        `[GRID] Auto-adjusted side orders: ${effectiveOrdersMeta.count}/${effectiveOrdersMeta.maxConfigured} per side | mode ${effectiveOrdersMeta.mode} | available ${availableUsdt.toFixed(2)} USDT`,
                        `COUNT:${effectiveOrdersMeta.count}/${effectiveOrdersMeta.maxConfigured}:${effectiveOrdersMeta.mode}:${availableUsdt.toFixed(2)}`
                    )
                    : maybeLogGridSizingState(
                        "COUNT",
                        `[GRID] Auto-adjusted side orders: ${effectiveOrdersMeta.count}/${effectiveOrdersMeta.maxConfigured} per side | mode ${effectiveOrdersMeta.mode} | available ${availableUsdt.toFixed(2)} USDT`,
                        `COUNT:${effectiveOrdersMeta.count}/${effectiveOrdersMeta.maxConfigured}:${effectiveOrdersMeta.mode}:${availableUsdt.toFixed(2)}`
                    );
            }

            const openPositions = await fetchOpenExchangePositions();
            const trackedPositions = getActivePositionsList();

            const lockedGridState = await resolveActiveGridState(snapshot, params);
            if (!lockedGridState) {
                console.log("[GRID][INFO] Unable to resolve locked grid state. Ladder sync skipped.");
                return;
            }

            const desiredOrdersRaw = buildGridEntryOrders(snapshot, params, lockedGridState);
            const desiredOrdersForRuntime = filterGridOrdersForActiveExposure(desiredOrdersRaw, openPositions, trackedPositions);
            if (desiredOrdersForRuntime.length !== desiredOrdersRaw.length) {
                const accountPositionMode = getAccountPositionMode();
                const exposureLogKey = `${accountPositionMode.label}:${desiredOrdersForRuntime.length}/${desiredOrdersRaw.length}`;
                const now = Date.now();
                if (exposureLogKey !== getLastGridExposureLogKey() || now - getLastGridExposureLogAt() >= gridSyncLogTtl) {
                    console.log(`[GRID][INFO] Active position detected in ${accountPositionMode.label}. Keeping ${desiredOrdersForRuntime.length}/${desiredOrdersRaw.length} ladder order(s) aligned with the live exposure.`);
                    setLastGridExposureLogKey(exposureLogKey);
                    setLastGridExposureLogAt(now);
                }
            }
            const desiredOrderMap = new Map();
            const duplicateDesiredOrders = [];
            for (const order of desiredOrdersForRuntime) {
                if (desiredOrderMap.has(order.clientOrderId)) duplicateDesiredOrders.push(order);
                else desiredOrderMap.set(order.clientOrderId, order);
            }
            if (duplicateDesiredOrders.length > 0) {
                console.warn(`[GRID][WARN] Deduped ${duplicateDesiredOrders.length} desired grid order(s) with colliding clientOrderId.`);
            }
            const desiredOrders = [...desiredOrderMap.values()];
            logGridSyncStatus(desiredOrders, openGridOrders);

            const desiredIds = new Set(desiredOrders.map((order) => order.clientOrderId));
            const staleOrders = openGridOrders.filter((order) => !desiredIds.has(getExchangeClientOrderId(order)));
            if (staleOrders.length > 0) await cancelGridOrders(staleOrders, "REBUILD");

            if (staleOrders.length > 0) {
                openGridOrders = await fetchOpenGridOrders();
                openGridOrders = await cancelDuplicateManagedOrders(openGridOrders, "GRID_DUPLICATE", "GRID");
            }

            const openOrderIds = new Set(openGridOrders.map((order) => getExchangeClientOrderId(order)));
            for (const desiredOrder of desiredOrders) {
                if (openOrderIds.has(desiredOrder.clientOrderId)) continue;
                await placeGridEntryOrder(desiredOrder);
            }
        } finally {
            setIsSyncingGridOrders(false);
        }
    };

    return {
        evaluateGridSignal,
        applySignalGuards,
        logSignalDetails,
        logGridSyncStatus,
        maybeLogGridSizingState,
        analyzeSignal,
        syncGridOrders
    };
};

module.exports = { createRuntimeSignalGridHelpers };
