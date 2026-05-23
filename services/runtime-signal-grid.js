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
    getOrderBook,
    getRecentTrades,
    resolveEffectiveGridOrderSizeUsdt,
    resolveEffectiveGridOrdersPerSide,
    applySmartAutoParameters,
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
    hasAnyActivePosition,
    getActivePositionByKey,
    placeOrder
}) => {
    const buildGridExposureSignature = (openPositions = [], trackedPositions = getActivePositionsList()) => JSON.stringify({
        mode: getAccountPositionMode()?.label || "UNKNOWN",
        exchange: (openPositions || []).map((position) => ({
            side: String(position?.side || position?.positionSide || ""),
            contracts: Number(position?.contracts ?? position?.amount ?? position?.info?.positionAmt ?? 0)
        })),
        tracked: (trackedPositions || []).map((position) => ({
            side: String(position?.side || position?.positionSide || ""),
            quantity: Number(position?.quantity ?? 0),
            entryTime: Number(position?.entryTime ?? 0)
        }))
    });

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
        const minVolumeRatio = toFiniteNumber(params.minVolumeRatio, db.minVolumeRatio);
        const volumeOk = snapshot.volumeRatio >= minVolumeRatio;
        const adxOk = !Number.isFinite(snapshot.currentAdx) || snapshot.currentAdx <= params.entryAdxMax;
        const rsiLongOk = !Number.isFinite(snapshot.currentRsi) || snapshot.currentRsi <= params.entryRsiLongThreshold;
        const rsiShortOk = !Number.isFinite(snapshot.currentRsi) || snapshot.currentRsi >= params.entryRsiShortThreshold;
        const bbLongOk = !Number.isFinite(snapshot.bbPercentB) || snapshot.bbPercentB <= params.entryBbLongThreshold;
        const bbShortOk = !Number.isFinite(snapshot.bbPercentB) || snapshot.bbPercentB >= params.entryBbShortThreshold;
        const sessionOk = db.sessionStartUTC <= db.sessionEndUTC
            ? snapshot.hourUTC >= db.sessionStartUTC && snapshot.hourUTC <= db.sessionEndUTC
            : snapshot.hourUTC >= db.sessionStartUTC || snapshot.hourUTC <= db.sessionEndUTC;
        const insideRange = snapshot.currentPrice >= lowerBound && snapshot.currentPrice <= upperBound;
        const meanReversionLong = insideRange && distanceFromMidSteps <= -1 && snapshot.currentPrice <= currentLevelLow + buffer;
        const meanReversionShort = false;
        const momentumLongOk = !Number.isFinite(snapshot.macdHistogram) || snapshot.macdHistogram >= 0;
        const momentumShortOk = !Number.isFinite(snapshot.macdHistogram) || snapshot.macdHistogram <= 0;
        const canLong = meanReversionLong && volumeOk && sessionOk && adxOk && rsiLongOk && bbLongOk && momentumLongOk;
        const canShort = meanReversionShort && volumeOk && sessionOk && adxOk && rsiShortOk && bbShortOk && momentumShortOk;
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
        const smartAutoLines = params.smartAuto?.enabled ? [
            `   Smart Auto Regime: ${params.smartAuto.regime.volatilityLabel}/${params.smartAuto.regime.trendLabel}/${params.smartAuto.regime.liquidityLabel}`,
            `   Smart Auto TP/SL: TP ${params.smartAuto.targetProfitAtrMultiplier}x ATR | SL ${params.smartAuto.stopLossAtrMultiplier}x ATR | RR ${params.smartAuto.riskRewardRatio} | Trail ${params.smartAuto.trailingActivateATR}/${params.smartAuto.trailingOffsetATR}x ATR`
        ] : [];

        return {
            canLong: safeCanLong,
            canShort: safeCanShort,
            setupDetected: safeCanLong || safeCanShort,
            detailTitle: "BINANCE GRID ANALYSIS",
            strategyName: "SPOT_GRID",
            longPlan: safeCanLong ? { targetPrice: longTargetPrice, stopLossPrice: longStopPrice, gridIndex: lowerIndex } : null,
            shortPlan: safeCanShort ? { targetPrice: shortTargetPrice, stopLossPrice: shortStopPrice, gridIndex: upperIndex } : null,
            extraDetailLines: [
                ...smartAutoLines,
                `   Reference Price: ${referencePrice.toFixed(6)}`,
                `   Grid Range: ${lowerBound.toFixed(6)} - ${upperBound.toFixed(6)} | Width ${params.configuredGridRangePercent <= 0 ? `AUTO ${params.gridRangePercent}%` : `${params.gridRangePercent}%`}`,
                `   Grid Levels: ${params.configuredGridLevels <= 0 ? `AUTO ${params.gridLevels}` : params.gridLevels} | Step: ${step.toFixed(6)}`,
                `   Entry Buffer: ${params.configuredGridEntryBufferPercent <= 0 ? `AUTO ${params.gridEntryBufferPercent}%` : `${params.gridEntryBufferPercent}%`}`,
                `   TP/SL Mode: TP ${params.gridTakeProfitLevels <= 0 ? "AUTO_NEXT_GRID" : `${resolveEffectiveGridTakeProfitLevels(params.gridTakeProfitLevels)} GRID`} | SL ${params.gridStopLossLevels <= 0 ? `AUTO_RANGE ${longExitPlan.stopLossSteps.toFixed(2)} step` : `${resolveEffectiveGridStopLossSteps(params.gridStopLossLevels, step, snapshot.currentATR).toFixed(2)} step`}`,
                `   Current Slot: ${lowerIndex}/${params.gridLevels} (${currentLevelLow.toFixed(6)} - ${currentLevelHigh.toFixed(6)})`,
                `   Distance From Mid: ${distanceFromMidSteps.toFixed(2)} steps`,
                `   NATR: ${Number.isFinite(snapshot.currentNatrPercent) ? `${snapshot.currentNatrPercent.toFixed(3)}%` : "N/A"} | ADX ${params.entryAdxPeriod}: ${Number.isFinite(snapshot.currentAdx) ? snapshot.currentAdx.toFixed(2) : "N/A"} (max ${params.entryAdxMax}) -> ${adxOk ? "[OK]" : "[NO]"}`,
                `   RSI ${params.entryRsiPeriod}: ${Number.isFinite(snapshot.currentRsi) ? snapshot.currentRsi.toFixed(2) : "N/A"} | Long <= ${params.entryRsiLongThreshold} -> ${rsiLongOk ? "[OK]" : "[NO]"} | Short >= ${params.entryRsiShortThreshold} -> ${rsiShortOk ? "[OK]" : "[NO]"}`,
                `   Bollinger %B ${params.entryBbPeriod},${params.entryBbStdDev}: ${Number.isFinite(snapshot.bbPercentB) ? snapshot.bbPercentB.toFixed(3) : "N/A"} | Long <= ${params.entryBbLongThreshold} -> ${bbLongOk ? "[OK]" : "[NO]"} | Short >= ${params.entryBbShortThreshold} -> ${bbShortOk ? "[OK]" : "[NO]"}`,
                `   MACD Histogram: ${Number.isFinite(snapshot.macdHistogram) ? snapshot.macdHistogram.toFixed(6) : "N/A"} | Long ${momentumLongOk ? "[OK]" : "[NO]"} | Short ${momentumShortOk ? "[OK]" : "[NO]"}`,
                `   Volume Ratio: ${snapshot.volumeRatio.toFixed(2)}x (min ${minVolumeRatio}x) -> ${volumeOk ? "[OK]" : "[NO]"}`,
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
            const strategy = String(db.strategy || "spot_grid").toLowerCase();
            const now = Date.now();
            if (now - getLastLogTime() > 5000) {
                console.log(`[SIGNAL][INFO] #${getSignalCount()} Analyzing ${strategy.toUpperCase()} setup (${db.gridTimeframe})...`);
                setLastLogTime(now);
            }

            let params = getSignalParameters();
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
            if (typeof applySmartAutoParameters === "function") {
                params = applySmartAutoParameters(params, snapshot);
            }

            const [orderBook, recentTrades] = await Promise.all([
                typeof getOrderBook === "function" ? getOrderBook(10) : Promise.resolve(null),
                typeof getRecentTrades === "function" ? getRecentTrades(25) : Promise.resolve([])
            ]);

            const signalState = strategy === "spot_grid"
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
                exitOptimization: {
                    enabled: true,
                    currentPrice: snapshot.currentPrice,
                    candidate: {
                        tpAtr: Math.max(0.1, toFiniteNumber(params.smartAuto?.targetProfitAtrMultiplier, db.targetProfitAtrMultiplier)),
                        slAtr: Math.max(0.05, toFiniteNumber(params.smartAuto?.stopLossAtrMultiplier, db.stopLossAtrMultiplier)),
                        trailingActivateATR: Math.max(0.2, toFiniteNumber(params.smartAuto?.trailingActivateATR, db.trailingActivateATR)),
                        trailingOffsetATR: Math.max(0.1, toFiniteNumber(params.smartAuto?.trailingOffsetATR, db.trailingOffsetATR))
                    },
                    regime: {
                        zScore: !Number.isFinite(snapshot.bbBasis) || !Number.isFinite(snapshot.currentPrice) || !Number.isFinite(snapshot.currentStdDev) || snapshot.currentStdDev <= 0
                            ? 0
                            : (snapshot.currentPrice - snapshot.bbBasis) / snapshot.currentStdDev,
                        volatilityPercentile: clamp(
                            Number.isFinite(snapshot.currentNatrPercent)
                                ? snapshot.currentNatrPercent / Math.max(params.gridRangePercent || snapshot.currentNatrPercent || 1, 0.0001)
                                : 0.5,
                            0,
                            1
                        )
                    },
                    liquiditySnapshot: {
                        orderBook,
                        trades: recentTrades
                    },
                    orderFlow: {
                        orderFlowImbalance: (() => {
                            const buyVolume = recentTrades.reduce((sum, trade) => sum + (String(trade?.side || "").toLowerCase() === "buy" ? Math.abs(toFiniteNumber(trade?.amount ?? trade?.size, 0)) : 0), 0);
                            const sellVolume = recentTrades.reduce((sum, trade) => sum + (String(trade?.side || "").toLowerCase() === "sell" ? Math.abs(toFiniteNumber(trade?.amount ?? trade?.size, 0)) : 0), 0);
                            const totalVolume = buyVolume + sellVolume;
                            return totalVolume > 0 ? (buyVolume - sellVolume) / totalVolume : 0;
                        })(),
                        absorptionScore: (() => {
                            const bestBidSize = Math.abs(toFiniteNumber(orderBook?.bids?.[0]?.[1], 0));
                            const bestAskSize = Math.abs(toFiniteNumber(orderBook?.asks?.[0]?.[1], 0));
                            const spread = Math.abs(toFiniteNumber(orderBook?.asks?.[0]?.[0], snapshot.currentPrice) - toFiniteNumber(orderBook?.bids?.[0]?.[0], snapshot.currentPrice));
                            if (bestBidSize <= 0 && bestAskSize <= 0) return 0;
                            return clamp((Math.max(bestBidSize, bestAskSize) / Math.max(bestBidSize + bestAskSize, 1)) - (spread / Math.max(snapshot.currentPrice, 1)), 0, 1);
                        })(),
                        shortHorizonATR: snapshot.currentATR,
                        mediumHorizonATR: Math.max(snapshot.currentATR / Math.max(snapshot.volumeRatio || 1, 0.5), 0.0000001)
                    }
                },
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
        if (!db || String(db.strategy || "spot_grid").toLowerCase() !== "spot_grid") return;
        if (getIsSyncingGridOrders()) return;
        setIsSyncingGridOrders(true);

        try {
            let params = getSignalParameters();
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
            if (typeof applySmartAutoParameters === "function") {
                params = applySmartAutoParameters(params, snapshot);
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
            if (toFiniteNumber(params.configuredGridLevels, 0) <= 0 && effectiveOrdersMeta.count > params.gridLevels) {
                params.gridLevels = Math.max(2, Math.trunc(effectiveOrdersMeta.count));
            }
            const adjustedOrdersMeta = resolveEffectiveGridOrdersPerSide({
                availableUsdt,
                configuredOrdersPerSide: params.gridOrdersPerSide,
                perOrderMargin: params.gridOrderSizeUsdt,
                referencePrice: snapshot.currentPrice,
                market: exchange?.markets?.[db?.pair],
                gridLevels: params.gridLevels
            });
            params.gridOrdersPerSide = adjustedOrdersMeta.count;
            let openGridOrders = await fetchOpenGridOrders();
            openGridOrders = await cancelDuplicateManagedOrders(openGridOrders, "GRID_DUPLICATE", "GRID");

            if (effectiveSizeMeta.orderSizeUsdt <= 0 || adjustedOrdersMeta.count <= 0) {
                if (openGridOrders.length > 0) await cancelGridOrders(openGridOrders, "INSUFFICIENT_BALANCE");
                const reasonText = adjustedOrdersMeta.reason ? ` Reason: ${adjustedOrdersMeta.reason}` : "";
                const skipMessage = `[GRID] Auto sizing skipped ladder | size ${effectiveSizeMeta.orderSizeUsdt.toFixed(4)} USDT | side orders ${adjustedOrdersMeta.count}/${adjustedOrdersMeta.maxConfigured} | available ${availableUsdt.toFixed(2)} USDT.${reasonText}`;
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
            if (adjustedOrdersMeta.count < adjustedOrdersMeta.maxConfigured) {
                maybeLogGridSizingStateExternal
                    ? maybeLogGridSizingStateExternal(
                        "COUNT",
                        `[GRID] Auto-adjusted side orders: ${adjustedOrdersMeta.count}/${adjustedOrdersMeta.maxConfigured} per side | mode ${adjustedOrdersMeta.mode} | available ${availableUsdt.toFixed(2)} USDT`,
                        `COUNT:${adjustedOrdersMeta.count}/${adjustedOrdersMeta.maxConfigured}:${adjustedOrdersMeta.mode}:${availableUsdt.toFixed(2)}`
                    )
                    : maybeLogGridSizingState(
                        "COUNT",
                        `[GRID] Auto-adjusted side orders: ${adjustedOrdersMeta.count}/${adjustedOrdersMeta.maxConfigured} per side | mode ${adjustedOrdersMeta.mode} | available ${availableUsdt.toFixed(2)} USDT`,
                        `COUNT:${adjustedOrdersMeta.count}/${adjustedOrdersMeta.maxConfigured}:${adjustedOrdersMeta.mode}:${availableUsdt.toFixed(2)}`
                    );
            }

            const openPositions = await fetchOpenExchangePositions();
            const trackedPositions = getActivePositionsList();
            const plannedExposureSignature = buildGridExposureSignature(openPositions, trackedPositions);

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

            const latestOpenPositions = await fetchOpenExchangePositions();
            const latestTrackedPositions = getActivePositionsList();
            const latestExposureSignature = buildGridExposureSignature(latestOpenPositions, latestTrackedPositions);
            if (latestExposureSignature !== plannedExposureSignature) {
                console.log("[GRID][INFO] Exposure changed during ladder planning. Grid sync aborted and will retry next cycle.");
                return;
            }

            const desiredIds = new Set(desiredOrders.map((order) => order.clientOrderId));
            const staleOrders = openGridOrders.filter((order) => !desiredIds.has(getExchangeClientOrderId(order)));
            if (staleOrders.length > 0) await cancelGridOrders(staleOrders, "REBUILD");

            if (staleOrders.length > 0) {
                openGridOrders = await fetchOpenGridOrders();
                openGridOrders = await cancelDuplicateManagedOrders(openGridOrders, "GRID_DUPLICATE", "GRID");
            }

            const placementOpenPositions = await fetchOpenExchangePositions();
            const placementTrackedPositions = getActivePositionsList();
            const placementExposureSignature = buildGridExposureSignature(placementOpenPositions, placementTrackedPositions);
            if (placementExposureSignature !== plannedExposureSignature) {
                console.log("[GRID][INFO] Exposure changed before ladder placement. Grid sync aborted and will retry next cycle.");
                return;
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
