const { resolveOptimalExit, buildLiquiditySnapshot } = require("./exit-optimizer");

const createTradeLogicHelpers = ({
    getDb,
    toFiniteNumber,
    formatPriceToMarketPrecision,
    matchesOrderToTrackedPosition,
    getLastPnlLog,
    setLastPnlLog,
    calcATR
}) => {
    const clampNumber = (value, min, max) => Math.min(Math.max(value, min), max);

    const normalizeSignalOrderDefaults = (signalData) => ({
        signalPrice: signalData,
        signalATR: null,
        strategyName: "SPOT_GRID",
        riskOverrides: {},
        signalTargetPrice: null,
        signalStopLossPrice: null,
        exitOptimization: null
    });

    const parseSignalOrderData = (signalData) => {
        if (typeof signalData !== "object" || signalData === null) {
            return normalizeSignalOrderDefaults(signalData);
        }
        return {
            signalPrice: signalData.price,
            signalATR: toFiniteNumber(signalData.atr, null),
            strategyName: signalData.strategy ? String(signalData.strategy) : "SPOT_GRID",
            riskOverrides: signalData.riskOverrides || {},
            signalTargetPrice: toFiniteNumber(signalData.targetPrice, null),
            signalStopLossPrice: toFiniteNumber(signalData.stopLossPrice, null),
            exitOptimization: signalData.exitOptimization || null
        };
    };

    const getResolvedOrderPrice = (order, fallbackPrice, filledQuantity) => {
        const averagePrice = toFiniteNumber(order?.average, 0);
        const orderCost = toFiniteNumber(order?.cost, 0);
        const directPrice = toFiniteNumber(order?.price, 0);
        const infoAveragePrice = toFiniteNumber(order?.info?.avgPrice, 0);
        const infoQuoteQty = toFiniteNumber(order?.info?.cumQuoteQty, 0);

        if (averagePrice > 0) return averagePrice;
        if (infoAveragePrice > 0) return infoAveragePrice;
        if (filledQuantity > 0 && orderCost > 0) return orderCost / filledQuantity;
        if (filledQuantity > 0 && infoQuoteQty > 0) return infoQuoteQty / filledQuantity;
        if (directPrice > 0) return directPrice;
        return fallbackPrice;
    };

    const getOrderFillSnapshot = (order, fallbackPrice, fallbackQuantity) => {
        const resolveNetSpotQuantityAfterFee = (rawQuantity) => {
            if (!Number.isFinite(rawQuantity) || rawQuantity <= 0) return rawQuantity;
            const side = String(order?.side || order?.info?.side || "").toLowerCase();
            if (side !== "buy") return rawQuantity;
            const feeCandidates = [];
            const directFeeCurrency = String(order?.fee?.currency || "").toUpperCase();
            const baseAsset = String(order?.symbol || "").split("/")[0].toUpperCase();
            const directFeeCost = toFiniteNumber(order?.fee?.cost, NaN);
            if (Number.isFinite(directFeeCost) && directFeeCost > 0 && (!directFeeCurrency || !baseAsset || directFeeCurrency === baseAsset)) {
                feeCandidates.push(directFeeCost);
            }
            if (Array.isArray(order?.fees)) {
                for (const fee of order.fees) {
                    const feeCost = toFiniteNumber(fee?.cost, NaN);
                    const feeCurrency = String(fee?.currency || "").toUpperCase();
                    if (Number.isFinite(feeCost) && feeCost > 0 && (!feeCurrency || !baseAsset || feeCurrency === baseAsset)) {
                        feeCandidates.push(feeCost);
                    }
                }
            }
            const infoCommission = toFiniteNumber(order?.info?.commission, NaN);
            const infoCommissionAsset = String(order?.info?.commissionAsset || "").toUpperCase();
            if (Number.isFinite(infoCommission) && infoCommission > 0 && (!infoCommissionAsset || !baseAsset || infoCommissionAsset === baseAsset)) {
                feeCandidates.push(infoCommission);
            }
            if (feeCandidates.length === 0) return rawQuantity;
            const totalFeeInBase = feeCandidates.reduce((sum, value) => sum + value, 0);
            const netQuantity = Math.max(0, rawQuantity - totalFeeInBase);
            return netQuantity > 0 ? netQuantity : rawQuantity;
        };

        const resolvedOrderQuantity = (() => {
            const directFilled = toFiniteNumber(order?.filled, NaN);
            if (Number.isFinite(directFilled) && directFilled > 0) return Math.abs(directFilled);
            const infoExecutedQty = toFiniteNumber(order?.info?.executedQty, NaN);
            if (Number.isFinite(infoExecutedQty) && infoExecutedQty > 0) return Math.abs(infoExecutedQty);
            const directAmount = toFiniteNumber(order?.amount, NaN);
            if (Number.isFinite(directAmount) && directAmount > 0) return Math.abs(directAmount);
            const infoOrigQty = toFiniteNumber(order?.info?.origQty, NaN);
            if (Number.isFinite(infoOrigQty) && infoOrigQty > 0) return Math.abs(infoOrigQty);
            return NaN;
        })();
        const resolvedFallbackQuantity = toFiniteNumber(fallbackQuantity, NaN);
        const grossSnapshotQuantity = Number.isFinite(resolvedOrderQuantity) && resolvedOrderQuantity > 0
            ? resolvedOrderQuantity
            : resolvedFallbackQuantity;
        const snapshotQuantity = resolveNetSpotQuantityAfterFee(grossSnapshotQuantity);
        return {
            price: getResolvedOrderPrice(order, fallbackPrice, snapshotQuantity),
            quantity: snapshotQuantity
        };
    };

    const resolveRoundedPlanPrice = (pair, price) => {
        const roundedPrice = formatPriceToMarketPrecision(pair, price);
        return Number.isFinite(roundedPrice) ? roundedPrice : price;
    };

    const resolvePriceDistanceFromRiskPercent = (entryPrice, riskPercent) => {
        if (!Number.isFinite(entryPrice) || entryPrice <= 0) return NaN;
        return entryPrice * (Math.abs(riskPercent) / 100);
    };

    const resolveRiskPercentFromPriceDistance = (entryPrice, priceDistance) => {
        if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(priceDistance) || priceDistance <= 0) return NaN;
        return (priceDistance / entryPrice) * 100;
    };

    const resolveStopLossPlan = (signalATR, entryPrice, adjustedQty) => {
        const db = getDb();
        const baseStopLossPercent = Math.max(0, toFiniteNumber(db.gridStopLossPercent, 5));
        const atrValue = Math.abs(toFiniteNumber(signalATR, NaN));
        const staticStopLossDistance = resolvePriceDistanceFromRiskPercent(entryPrice, baseStopLossPercent);
        const autoStopLossEnabled = db.autoStopLossEnabled !== false;

        if (!autoStopLossEnabled || !Number.isFinite(atrValue) || atrValue <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0) {
            return {
                stopLossDistance: staticStopLossDistance,
                stopLossPercent: baseStopLossPercent,
                stopLossUSDT: -Math.abs(staticStopLossDistance * Math.abs(toFiniteNumber(adjustedQty, 0))),
                stopLossMode: "STATIC"
            };
        }

        const atrMultiplier = Math.max(0.05, toFiniteNumber(db.stopLossAtrMultiplier, 1.6));
        const minStopLossPercent = Math.max(0.1, toFiniteNumber(db.stopLossMinPercent, Math.min(baseStopLossPercent, 2.5)));
        const maxStopLossPercent = Math.max(
            minStopLossPercent,
            toFiniteNumber(db.stopLossMaxPercent, Math.max(baseStopLossPercent * 1.5, minStopLossPercent))
        );
        const atrStopDistance = atrValue * atrMultiplier;
        const minStopDistance = resolvePriceDistanceFromRiskPercent(entryPrice, minStopLossPercent);
        const maxStopDistance = resolvePriceDistanceFromRiskPercent(entryPrice, maxStopLossPercent);
        const suggestedStopDistance = Math.max(staticStopLossDistance, atrStopDistance);
        const stopLossDistance = clampNumber(suggestedStopDistance, minStopDistance, maxStopDistance);
        const stopLossPercent = resolveRiskPercentFromPriceDistance(entryPrice, stopLossDistance);

        return {
            stopLossDistance,
            stopLossPercent,
            stopLossUSDT: -Math.abs(stopLossDistance * Math.abs(toFiniteNumber(adjustedQty, 0))),
            stopLossMode: "AUTO_ATR"
        };
    };

    const resolveTargetProfitPlan = (signalATR, entryPrice, adjustedQty, stopLossDistance) => {
        const db = getDb();
        const numericQty = Math.abs(toFiniteNumber(adjustedQty, 0));
        const baseTargetProfitUSDT = Math.max(0, toFiniteNumber(db.gridTargetProfitUsdt, 0.5));
        const atrValue = Math.abs(toFiniteNumber(signalATR, NaN));
        const staticTargetDistance = numericQty > 0 ? baseTargetProfitUSDT / numericQty : NaN;
        const autoTargetProfitEnabled = db.autoTargetProfitEnabled !== false;
        if (!autoTargetProfitEnabled || !Number.isFinite(atrValue) || atrValue <= 0 || !Number.isFinite(numericQty) || numericQty <= 0) {
            return {
                targetProfitUSDT: baseTargetProfitUSDT,
                targetProfitDistance: staticTargetDistance,
                targetProfitMode: "STATIC"
            };
        }

        const atrMultiplier = Math.max(0.1, toFiniteNumber(db.targetProfitAtrMultiplier, 2.4));
        const riskRewardRatio = Math.max(0.5, toFiniteNumber(db.riskRewardRatio, 1.6));
        const minTargetProfitUSDT = Math.max(0.01, toFiniteNumber(db.targetProfitMinUsdt, Math.min(baseTargetProfitUSDT, 0.25)));
        const maxTargetProfitUSDT = Math.max(
            minTargetProfitUSDT,
            toFiniteNumber(db.targetProfitMaxUsdt, Math.max(baseTargetProfitUSDT * 3, minTargetProfitUSDT))
        );
        const atrTargetDistance = atrValue * atrMultiplier;
        const rewardRiskDistance = Number.isFinite(stopLossDistance) && stopLossDistance > 0
            ? stopLossDistance * riskRewardRatio
            : NaN;
        const suggestedTargetDistance = Math.max(
            staticTargetDistance,
            Number.isFinite(atrTargetDistance) ? atrTargetDistance : 0,
            Number.isFinite(rewardRiskDistance) ? rewardRiskDistance : 0
        );
        const targetProfitUSDT = clampNumber(suggestedTargetDistance * numericQty, minTargetProfitUSDT, maxTargetProfitUSDT);
        const targetProfitDistance = targetProfitUSDT / numericQty;

        return {
            targetProfitUSDT,
            targetProfitDistance,
            targetProfitMode: Number.isFinite(rewardRiskDistance) && rewardRiskDistance > 0 ? "AUTO_RR_ATR" : "AUTO_ATR"
        };
    };

    const buildOptimizationCandidateFromConfig = () => {
        const db = getDb();
        return {
            tpAtr: Math.max(0.1, toFiniteNumber(db.targetProfitAtrMultiplier, 2.4)),
            slAtr: Math.max(0.05, toFiniteNumber(db.stopLossAtrMultiplier, 1.6)),
            trailingActivateATR: Math.max(0.2, toFiniteNumber(db.trailingActivateATR, 1.5)),
            trailingOffsetATR: Math.max(0.1, toFiniteNumber(db.trailingOffsetATR, 0.75))
        };
    };

    const resolveOptimizedOrderPlan = (side, entryPrice, adjustedQty, signalATR, exitOptimization = null) => {
        const db = getDb();
        const numericQty = Math.abs(toFiniteNumber(adjustedQty, 0));
        const currentATR = Math.abs(toFiniteNumber(signalATR, NaN));
        if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(currentATR) || currentATR <= 0 || !Number.isFinite(numericQty) || numericQty <= 0) {
            return null;
        }

        const optimizationPayload = typeof exitOptimization === "object" && exitOptimization !== null ? exitOptimization : {};
        const rawLiquiditySnapshot = optimizationPayload.liquiditySnapshot || {};
        const liquiditySnapshot = (
            Number.isFinite(rawLiquiditySnapshot?.spreadBps) ||
            Number.isFinite(rawLiquiditySnapshot?.marketImpactBps) ||
            Number.isFinite(rawLiquiditySnapshot?.depthImbalance)
        )
            ? rawLiquiditySnapshot
            : buildLiquiditySnapshot({
                orderBook: rawLiquiditySnapshot.orderBook,
                trades: rawLiquiditySnapshot.trades,
                currentPrice: toFiniteNumber(optimizationPayload.currentPrice, entryPrice)
            });
        const optimizedExit = resolveOptimalExit({
            side,
            entryPrice,
            currentPrice: toFiniteNumber(optimizationPayload.currentPrice, entryPrice),
            currentATR,
            optimizationResult: optimizationPayload.optimizationResult || { candidate: optimizationPayload.candidate || buildOptimizationCandidateFromConfig() },
            regime: optimizationPayload.regime || {},
            liquiditySnapshot,
            orderFlow: optimizationPayload.orderFlow || {}
        });

        const targetPrice = resolveRoundedPlanPrice(db.pair, optimizedExit.targetPrice);
        const stopLossPrice = resolveRoundedPlanPrice(db.pair, optimizedExit.stopPrice);
        if (!Number.isFinite(targetPrice) || !Number.isFinite(stopLossPrice)) return null;

        const targetProfitUSDT = Math.abs(targetPrice - entryPrice) * numericQty;
        const stopLossUSDT = -Math.abs(stopLossPrice - entryPrice) * numericQty;
        const stopLossPercent = resolveRiskPercentFromPriceDistance(
            entryPrice,
            Math.abs(stopLossPrice - entryPrice)
        );

        return {
            trailingActivateATR: toFiniteNumber(optimizedExit?.candidate?.trailingActivateATR, db.trailingActivateATR),
            trailingOffsetATR: toFiniteNumber(optimizedExit?.candidate?.trailingOffsetATR, db.trailingOffsetATR),
            targetProfitUSDT,
            targetProfitMode: "OPTIMIZED_EXIT",
            stopLossPercent,
            stopLossMode: "OPTIMIZED_EXIT",
            stopLossUSDT,
            targetPrice,
            stopLossPrice,
            trailingEnabled: Boolean(db.trailingEnabled),
            optimizationMeta: optimizedExit
        };
    };

    const buildDirectionalTargetPrice = (side, entryPrice, targetProfitUSDT, adjustedQty) => (
        side === "buy"
            ? entryPrice + (targetProfitUSDT / adjustedQty)
            : entryPrice - (targetProfitUSDT / adjustedQty)
    );

    const buildDirectionalStopLossPrice = (side, entryPrice, stopLossUSDT, adjustedQty) => (
        side === "buy"
            ? entryPrice + (stopLossUSDT / adjustedQty)
            : entryPrice - (stopLossUSDT / adjustedQty)
    );

    const applyResolvedStopLossPlan = (side, entryPrice, adjustedQty, signalATR) => {
        const db = getDb();
        const resolvedStopLoss = resolveStopLossPlan(signalATR, entryPrice, adjustedQty);
        let stopLossUSDT = resolvedStopLoss.stopLossUSDT;
        const stopLossPercent = resolvedStopLoss.stopLossPercent;
        const stopLossMode = resolvedStopLoss.stopLossMode;
        let stopLossDistance = resolvedStopLoss.stopLossDistance;
        const rawStopLossPrice = buildDirectionalStopLossPrice(side, entryPrice, stopLossUSDT, adjustedQty);
        const stopLossPrice = resolveRoundedPlanPrice(db.pair, rawStopLossPrice);
        stopLossUSDT = -Math.abs(stopLossPrice - entryPrice) * adjustedQty;
        stopLossDistance = Math.abs(stopLossPrice - entryPrice);
        return { stopLossUSDT, stopLossPercent, stopLossMode, stopLossDistance, stopLossPrice };
    };

    const buildOrderPlan = (side, entryPrice, adjustedQty, signalATR, riskOverrides, explicitTargets = {}) => {
        const db = getDb();
        const numericQty = Math.abs(toFiniteNumber(adjustedQty, 0));
        const trailingActivateATR = toFiniteNumber(riskOverrides.trailingActivateATR, db.trailingActivateATR);
        const trailingOffsetATR = toFiniteNumber(riskOverrides.trailingOffsetATR, db.trailingOffsetATR);
        const explicitTargetPrice = toFiniteNumber(explicitTargets.targetPrice, null);
        const explicitStopLossPrice = toFiniteNumber(explicitTargets.stopLossPrice, null);
        const optimizationPayload = explicitTargets.exitOptimization || riskOverrides.exitOptimization || null;

        let targetProfitUSDT = db.gridTargetProfitUsdt;
        let targetProfitMode = "STATIC";
        let stopLossPercent = db.gridStopLossPercent;
        let stopLossMode = "STATIC";
        let stopLossUSDT = NaN;
        let targetPrice;
        let stopLossPrice;
        let stopLossDistance = NaN;

        if (Number.isFinite(explicitTargetPrice)) {
            targetPrice = resolveRoundedPlanPrice(db.pair, explicitTargetPrice);
            targetProfitUSDT = Math.abs(targetPrice - entryPrice) * adjustedQty;
            targetProfitMode = "EXPLICIT";
        }

        if (Number.isFinite(explicitStopLossPrice)) {
            stopLossPrice = resolveRoundedPlanPrice(db.pair, explicitStopLossPrice);
            stopLossUSDT = -Math.abs(stopLossPrice - entryPrice) * adjustedQty;
            stopLossDistance = Math.abs(stopLossPrice - entryPrice);
            stopLossPercent = resolveRiskPercentFromPriceDistance(entryPrice, stopLossDistance);
            stopLossMode = "EXPLICIT";
        } else if (optimizationPayload && optimizationPayload.enabled !== false) {
            const optimizedPlan = resolveOptimizedOrderPlan(side, entryPrice, numericQty, signalATR, optimizationPayload);
            if (optimizedPlan) return optimizedPlan;
            const resolvedStopLoss = applyResolvedStopLossPlan(side, entryPrice, adjustedQty, signalATR);
            stopLossUSDT = resolvedStopLoss.stopLossUSDT;
            stopLossPercent = resolvedStopLoss.stopLossPercent;
            stopLossMode = resolvedStopLoss.stopLossMode;
            stopLossDistance = resolvedStopLoss.stopLossDistance;
            stopLossPrice = resolvedStopLoss.stopLossPrice;
        } else {
            const resolvedStopLoss = applyResolvedStopLossPlan(side, entryPrice, adjustedQty, signalATR);
            stopLossUSDT = resolvedStopLoss.stopLossUSDT;
            stopLossPercent = resolvedStopLoss.stopLossPercent;
            stopLossMode = resolvedStopLoss.stopLossMode;
            stopLossDistance = resolvedStopLoss.stopLossDistance;
            stopLossPrice = resolvedStopLoss.stopLossPrice;
        }

        if (Number.isFinite(explicitTargetPrice)) {
            targetProfitUSDT = Math.abs(targetPrice - entryPrice) * adjustedQty;
        } else {
            const resolvedTargetProfit = resolveTargetProfitPlan(signalATR, entryPrice, adjustedQty, stopLossDistance);
            targetProfitUSDT = resolvedTargetProfit.targetProfitUSDT;
            targetProfitMode = resolvedTargetProfit.targetProfitMode;
            const rawTargetPrice = buildDirectionalTargetPrice(side, entryPrice, targetProfitUSDT, adjustedQty);
            targetPrice = resolveRoundedPlanPrice(db.pair, rawTargetPrice);
            targetProfitUSDT = Math.abs(targetPrice - entryPrice) * adjustedQty;
        }

        if (Number.isFinite(entryPrice) && Number.isFinite(targetPrice) && targetPrice === entryPrice) {
            console.warn(`[ORDER][WARN] Rounded target price equals entry price for ${side} order. Review precision/minimum profit settings.`);
        }
        if (Number.isFinite(entryPrice) && Number.isFinite(stopLossPrice) && stopLossPrice === entryPrice) {
            console.warn(`[ORDER][WARN] Rounded stop loss price equals entry price for ${side} order. Review precision/minimum stop settings.`);
        }

        return {
            trailingActivateATR,
            trailingOffsetATR,
            targetProfitUSDT,
            targetProfitMode,
            stopLossPercent,
            stopLossMode,
            stopLossUSDT,
            targetPrice,
            stopLossPrice,
            trailingEnabled: Boolean(db.trailingEnabled)
        };
    };
    const isDirectionalOrderPlanValid = (side, entryPrice, orderPlan) => {
        if (!orderPlan) return false;
        const targetPrice = toFiniteNumber(orderPlan.targetPrice, NaN);
        const stopLossPrice = toFiniteNumber(orderPlan.stopLossPrice, NaN);
        if (!Number.isFinite(entryPrice) || !Number.isFinite(targetPrice) || !Number.isFinite(stopLossPrice)) return false;
        if (side === "buy") return targetPrice > entryPrice && stopLossPrice < entryPrice;
        if (side === "sell") return targetPrice < entryPrice && stopLossPrice > entryPrice;
        return false;
    };

    const formatOrderPlanLine = (label, value) => `   - ${label}: ${value}`;

    const formatOrderPlanQuantityLabel = (adjustedQty) => {
        const db = getDb();
        const baseAsset = String(db.pair || "").split("/")[0] || "BASE";
        return `${adjustedQty} ${baseAsset}`;
    };

    const formatTrailingPlanLabel = (orderPlan) => `${orderPlan.trailingActivateATR}/${orderPlan.trailingOffsetATR}x`;

    const logOrderPlan = (strategyName, entryPrice, adjustedQty, orderPlan) => {
        const db = getDb();
        console.log("   Order Details:");
        console.log(formatOrderPlanLine("Amount", `${db.gridOrderSizeUsdt} USDT`));
        console.log(formatOrderPlanLine("Quantity", formatOrderPlanQuantityLabel(adjustedQty)));
        console.log(formatOrderPlanLine("Entry Price", entryPrice));
        console.log(formatOrderPlanLine("Strategy", strategyName));
        const targetProfitLabel = orderPlan.targetProfitMode && orderPlan.targetProfitMode !== "STATIC"
            ? `${orderPlan.targetProfitUSDT.toFixed(4)} USDT (${orderPlan.targetProfitMode})`
            : `${orderPlan.targetProfitUSDT.toFixed(4)} USDT`;
        console.log(formatOrderPlanLine("Target Profit", targetProfitLabel));
        console.log(formatOrderPlanLine("Target Price", orderPlan.targetPrice));
        const stopLossLabel = orderPlan.stopLossMode && orderPlan.stopLossMode !== "STATIC"
            ? `${orderPlan.stopLossUSDT.toFixed(4)} USDT (${orderPlan.stopLossPercent.toFixed(2)}%) (${orderPlan.stopLossMode})`
            : `${orderPlan.stopLossUSDT.toFixed(4)} USDT (${orderPlan.stopLossPercent.toFixed(2)}%)`;
        console.log(formatOrderPlanLine("Stop Loss", stopLossLabel));
        console.log(formatOrderPlanLine("Stop Loss Price", orderPlan.stopLossPrice));
        console.log(formatOrderPlanLine("Trailing ATR", formatTrailingPlanLabel(orderPlan)));
    };

    const shouldUseStoredStopLossPrice = (position) => Number.isFinite(position.stopLossPrice) && position.stopLossPrice > 0;

    const getDerivedStopLossPrice = (position, entryPrice, effectiveStopLossUSDT, quantity) => (
        position.side === "buy"
            ? entryPrice + (effectiveStopLossUSDT / quantity)
            : entryPrice - (effectiveStopLossUSDT / quantity)
    );

    const resolveEffectiveStopLossPrice = (position, effectiveStopLossUSDT) => {
        const db = getDb();
        let effectiveStopLossPrice = toFiniteNumber(position.stopLossPrice, NaN);
        if (!Number.isFinite(effectiveStopLossPrice) || effectiveStopLossPrice <= 0) {
            const entryPrice = toFiniteNumber(position.entryPrice, NaN);
            const quantity = toFiniteNumber(position.quantity, NaN);
            if (Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(quantity) && quantity > 0 && Number.isFinite(effectiveStopLossUSDT)) {
                const derivedStopLossPrice = shouldUseStoredStopLossPrice(position)
                    ? position.stopLossPrice
                    : getDerivedStopLossPrice(position, entryPrice, effectiveStopLossUSDT, quantity);
                effectiveStopLossPrice = formatPriceToMarketPrecision(db.pair, derivedStopLossPrice);
            } else {
                effectiveStopLossPrice = NaN;
            }
        }
        return effectiveStopLossPrice;
    };

    const resolveEffectiveTargetProfitUSDT = (position) => {
        const db = getDb();
        if (Number.isFinite(position.targetProfitUSDT) && position.targetProfitUSDT > 0) {
            return position.targetProfitUSDT;
        }
        const fallbackStopLossDistance = resolveStopLossPlan(position.atrAtEntry, position.entryPrice, position.quantity).stopLossDistance;
        const fallbackResolved = resolveTargetProfitPlan(position.atrAtEntry, position.entryPrice, position.quantity, fallbackStopLossDistance);
        return fallbackResolved.targetProfitMode !== "STATIC"
            ? fallbackResolved.targetProfitUSDT
            : db.gridTargetProfitUsdt;
    };

    const resolveEffectiveStopLossUSDT = (position) => {
        const fallbackStopLossUSDT = resolveStopLossPlan(position.atrAtEntry, position.entryPrice, position.quantity).stopLossUSDT;
        const rawStopLossUSDT = Number.isFinite(position.stopLossUSDT) && position.stopLossUSDT !== 0 ? position.stopLossUSDT : fallbackStopLossUSDT;
        return -Math.abs(rawStopLossUSDT);
    };

    const getPositionExitTargets = (position) => {
        const effectiveTargetProfitUSDT = resolveEffectiveTargetProfitUSDT(position);
        const effectiveStopLossUSDT = resolveEffectiveStopLossUSDT(position);
        const effectiveStopLossPrice = resolveEffectiveStopLossPrice(position, effectiveStopLossUSDT);
        return { effectiveTargetProfitUSDT, effectiveStopLossUSDT, effectiveStopLossPrice };
    };

    const hasTrackedExchangeOrder = (orders, position) => (
        Array.isArray(orders) && orders.some((order) => matchesOrderToTrackedPosition(order, position))
    );

    const getManagedExitOrders = (managedOrdersSnapshot, orderType) => (
        Array.isArray(managedOrdersSnapshot?.[orderType]) ? managedOrdersSnapshot[orderType] : null
    );

    const hasFallbackExitOrderId = (position, orderType) => (
        orderType === "tp"
            ? Boolean(position?.tpOrderId || position?.tpClientOrderId)
            : Boolean(position?.slOrderId || position?.slClientOrderId)
    );

    const hasManagedExitOrder = (managedOrdersSnapshot, position, orderType) => {
        if (managedOrdersSnapshot?.triggerOrdersFetchFailed) return hasFallbackExitOrderId(position, orderType);
        const orders = getManagedExitOrders(managedOrdersSnapshot, orderType);
        if (orders) return hasTrackedExchangeOrder(orders, position);
        return hasFallbackExitOrderId(position, orderType);
    };

    const buildExitDecision = (reason, message, effectiveTargetProfitUSDT, effectiveStopLossUSDT) => ({
        shouldClose: true,
        reason,
        message,
        effectiveTargetProfitUSDT,
        effectiveStopLossUSDT
    });

    const isBuySide = (position) => position.side === "buy";

    const isTargetHit = (position, currentPrice) => (
        Number.isFinite(position.targetPrice) &&
        (isBuySide(position) ? currentPrice >= position.targetPrice : currentPrice <= position.targetPrice)
    );

    const isStopHit = (position, currentPrice, effectiveStopLossPrice) => (
        Number.isFinite(effectiveStopLossPrice) &&
        (isBuySide(position) ? currentPrice <= effectiveStopLossPrice : currentPrice >= effectiveStopLossPrice)
    );

    const shouldCloseForProfitTarget = (hasExchangeTpOrder, position, currentPrice, netPnlUSDT, effectiveTargetProfitUSDT) => (
        !hasExchangeTpOrder && (isTargetHit(position, currentPrice) || netPnlUSDT >= effectiveTargetProfitUSDT)
    );

    const shouldCloseForStopLoss = (hasExchangeSlOrder, position, currentPrice, effectiveStopLossPrice, netPnlUSDT, effectiveStopLossUSDT) => (
        !hasExchangeSlOrder && (isStopHit(position, currentPrice, effectiveStopLossPrice) || netPnlUSDT <= effectiveStopLossUSDT)
    );

    const getNetPnlUSDT = (pnlState) => toFiniteNumber(pnlState?.netProfitUSDT, NaN);

    const buildPositionExitContext = (position, currentPrice, pnlState, managedOrdersSnapshot) => {
        const { effectiveTargetProfitUSDT, effectiveStopLossUSDT, effectiveStopLossPrice } = getPositionExitTargets(position);
        return {
            position,
            currentPrice,
            netPnlUSDT: getNetPnlUSDT(pnlState),
            effectiveTargetProfitUSDT,
            effectiveStopLossUSDT,
            effectiveStopLossPrice,
            hasExchangeTpOrder: hasManagedExitOrder(managedOrdersSnapshot, position, "tp"),
            hasExchangeSlOrder: hasManagedExitOrder(managedOrdersSnapshot, position, "sl")
        };
    };

    const resolvePositionExitDecision = ({ position, currentPrice, netPnlUSDT, effectiveTargetProfitUSDT, effectiveStopLossUSDT, effectiveStopLossPrice, hasExchangeTpOrder, hasExchangeSlOrder }) => {
        if (shouldCloseForProfitTarget(hasExchangeTpOrder, position, currentPrice, netPnlUSDT, effectiveTargetProfitUSDT)) {
            return buildExitDecision(
                "PROFIT_TARGET",
                `\n[PROFIT] Net Target hit (+${netPnlUSDT.toFixed(4)} USDT)! Closing...`,
                effectiveTargetProfitUSDT,
                effectiveStopLossUSDT
            );
        }

        if (shouldCloseForStopLoss(hasExchangeSlOrder, position, currentPrice, effectiveStopLossPrice, netPnlUSDT, effectiveStopLossUSDT)) {
            return buildExitDecision(
                "STOP_LOSS",
                `\n[STOP] Stop loss hit (${netPnlUSDT.toFixed(4)} USDT)! Closing...`,
                effectiveTargetProfitUSDT,
                effectiveStopLossUSDT
            );
        }

        return null;
    };

    const evaluatePositionExit = (position, currentPrice, pnlState, managedOrdersSnapshot = null) => {
        const exitContext = buildPositionExitContext(position, currentPrice, pnlState, managedOrdersSnapshot);
        const exitDecision = resolvePositionExitDecision(exitContext);

        if (exitDecision) return exitDecision;

        return {
            shouldClose: false,
            effectiveTargetProfitUSDT: exitContext.effectiveTargetProfitUSDT,
            effectiveStopLossUSDT: exitContext.effectiveStopLossUSDT
        };
    };

    const isNearExitPnl = (netProfitUSDT, exitState) => (
        netProfitUSDT >= (exitState.effectiveTargetProfitUSDT * 0.7) ||
        netProfitUSDT <= (exitState.effectiveStopLossUSDT * 0.7)
    );

    const getPnlLogInterval = (pnlState, exitState) => {
        const netProfitUSDT = getNetPnlUSDT(pnlState);
        return isNearExitPnl(netProfitUSDT, exitState) ? 2000 : 5000;
    };

    const getDisplayProfitUSDT = (pnlState) => (
        Number.isFinite(pnlState.displayProfitUSDT) ? pnlState.displayProfitUSDT : getNetPnlUSDT(pnlState)
    );

    const getDisplayProfitPercent = (pnlState) => (
        Number.isFinite(pnlState.displayProfitPercent) ? pnlState.displayProfitPercent : pnlState.profitPercent
    );

    const getDisplayPnlValues = (pnlState) => ({
        displayProfitUSDT: getDisplayProfitUSDT(pnlState),
        displayProfitPercent: getDisplayProfitPercent(pnlState)
    });

    const calcSMA = (values, period) => {
        const numericPeriod = Math.max(1, Math.trunc(toFiniteNumber(period, 1)));
        const output = Array(values.length).fill(null);
        let rollingSum = 0;
        for (let index = 0; index < values.length; index += 1) {
            const value = toFiniteNumber(values[index], NaN);
            rollingSum += Number.isFinite(value) ? value : 0;
            if (index >= numericPeriod) {
                const trailingValue = toFiniteNumber(values[index - numericPeriod], NaN);
                rollingSum -= Number.isFinite(trailingValue) ? trailingValue : 0;
            }
            if (index >= numericPeriod - 1) output[index] = rollingSum / numericPeriod;
        }
        return output;
    };

    const calcEMA = (values, period) => {
        const numericPeriod = Math.max(1, Math.trunc(toFiniteNumber(period, 1)));
        const multiplier = 2 / (numericPeriod + 1);
        const output = Array(values.length).fill(null);
        const seed = calcSMA(values, numericPeriod);
        let previous = seed[numericPeriod - 1];
        if (!Number.isFinite(previous)) return output;
        output[numericPeriod - 1] = previous;
        for (let index = numericPeriod; index < values.length; index += 1) {
            const value = toFiniteNumber(values[index], NaN);
            if (!Number.isFinite(value)) continue;
            previous = ((value - previous) * multiplier) + previous;
            output[index] = previous;
        }
        return output;
    };

    const calcRSI = (values, period) => {
        const numericPeriod = Math.max(2, Math.trunc(toFiniteNumber(period, 14)));
        const output = Array(values.length).fill(null);
        if (values.length <= numericPeriod) return output;

        let gains = 0;
        let losses = 0;
        for (let index = 1; index <= numericPeriod; index += 1) {
            const change = toFiniteNumber(values[index], NaN) - toFiniteNumber(values[index - 1], NaN);
            if (!Number.isFinite(change)) return output;
            if (change >= 0) gains += change;
            else losses += Math.abs(change);
        }

        let averageGain = gains / numericPeriod;
        let averageLoss = losses / numericPeriod;
        output[numericPeriod] = averageLoss === 0 ? 100 : 100 - (100 / (1 + (averageGain / averageLoss)));
        for (let index = numericPeriod + 1; index < values.length; index += 1) {
            const change = toFiniteNumber(values[index], NaN) - toFiniteNumber(values[index - 1], NaN);
            if (!Number.isFinite(change)) continue;
            const gain = change > 0 ? change : 0;
            const loss = change < 0 ? Math.abs(change) : 0;
            averageGain = ((averageGain * (numericPeriod - 1)) + gain) / numericPeriod;
            averageLoss = ((averageLoss * (numericPeriod - 1)) + loss) / numericPeriod;
            output[index] = averageLoss === 0 ? 100 : 100 - (100 / (1 + (averageGain / averageLoss)));
        }
        return output;
    };

    const calcStdDev = (values, period) => {
        const numericPeriod = Math.max(2, Math.trunc(toFiniteNumber(period, 20)));
        const output = Array(values.length).fill(null);
        for (let index = numericPeriod - 1; index < values.length; index += 1) {
            const window = values.slice(index - numericPeriod + 1, index + 1).map((value) => toFiniteNumber(value, NaN));
            if (window.some((value) => !Number.isFinite(value))) continue;
            const mean = window.reduce((sum, value) => sum + value, 0) / window.length;
            const variance = window.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / window.length;
            output[index] = Math.sqrt(variance);
        }
        return output;
    };

    const calcBollingerBands = (values, period, stdDevMultiplier) => {
        const basis = calcSMA(values, period);
        const stdDev = calcStdDev(values, period);
        const upper = Array(values.length).fill(null);
        const lower = Array(values.length).fill(null);
        for (let index = 0; index < values.length; index += 1) {
            if (!Number.isFinite(basis[index]) || !Number.isFinite(stdDev[index])) continue;
            upper[index] = basis[index] + (stdDev[index] * stdDevMultiplier);
            lower[index] = basis[index] - (stdDev[index] * stdDevMultiplier);
        }
        return { basis, upper, lower };
    };

    const calcMACD = (values, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) => {
        const fast = calcEMA(values, fastPeriod);
        const slow = calcEMA(values, slowPeriod);
        const macd = values.map((_, index) => (
            Number.isFinite(fast[index]) && Number.isFinite(slow[index]) ? fast[index] - slow[index] : null
        ));
        const signal = calcEMA(macd.map((value) => toFiniteNumber(value, NaN)), signalPeriod);
        const histogram = macd.map((value, index) => (
            Number.isFinite(value) && Number.isFinite(signal[index]) ? value - signal[index] : null
        ));
        return { macd, signal, histogram };
    };

    const calcADX = (high, low, close, period) => {
        const numericPeriod = Math.max(2, Math.trunc(toFiniteNumber(period, 14)));
        const output = Array(close.length).fill(null);
        if (close.length <= numericPeriod * 2) return output;

        const tr = Array(close.length).fill(0);
        const plusDm = Array(close.length).fill(0);
        const minusDm = Array(close.length).fill(0);

        for (let index = 1; index < close.length; index += 1) {
            const upMove = high[index] - high[index - 1];
            const downMove = low[index - 1] - low[index];
            tr[index] = Math.max(
                high[index] - low[index],
                Math.abs(high[index] - close[index - 1]),
                Math.abs(low[index] - close[index - 1])
            );
            plusDm[index] = upMove > downMove && upMove > 0 ? upMove : 0;
            minusDm[index] = downMove > upMove && downMove > 0 ? downMove : 0;
        }

        let smoothedTr = 0;
        let smoothedPlusDm = 0;
        let smoothedMinusDm = 0;
        for (let index = 1; index <= numericPeriod; index += 1) {
            smoothedTr += tr[index];
            smoothedPlusDm += plusDm[index];
            smoothedMinusDm += minusDm[index];
        }

        const dxValues = Array(close.length).fill(null);
        for (let index = numericPeriod; index < close.length; index += 1) {
            if (index > numericPeriod) {
                smoothedTr = smoothedTr - (smoothedTr / numericPeriod) + tr[index];
                smoothedPlusDm = smoothedPlusDm - (smoothedPlusDm / numericPeriod) + plusDm[index];
                smoothedMinusDm = smoothedMinusDm - (smoothedMinusDm / numericPeriod) + minusDm[index];
            }
            if (smoothedTr <= 0) continue;
            const plusDi = (smoothedPlusDm / smoothedTr) * 100;
            const minusDi = (smoothedMinusDm / smoothedTr) * 100;
            const diSum = plusDi + minusDi;
            dxValues[index] = diSum === 0 ? 0 : (Math.abs(plusDi - minusDi) / diSum) * 100;
        }

        let adxSeed = 0;
        let seedCount = 0;
        for (let index = numericPeriod; index < (numericPeriod * 2); index += 1) {
            if (Number.isFinite(dxValues[index])) {
                adxSeed += dxValues[index];
                seedCount += 1;
            }
        }
        if (seedCount !== numericPeriod) return output;

        output[(numericPeriod * 2) - 1] = adxSeed / numericPeriod;
        for (let index = numericPeriod * 2; index < close.length; index += 1) {
            if (!Number.isFinite(dxValues[index]) || !Number.isFinite(output[index - 1])) continue;
            output[index] = ((output[index - 1] * (numericPeriod - 1)) + dxValues[index]) / numericPeriod;
        }
        return output;
    };

    const extractOhlcvSeries = (ohlcv) => ({
        open: ohlcv.map((c) => c[1]),
        high: ohlcv.map((c) => c[2]),
        low: ohlcv.map((c) => c[3]),
        close: ohlcv.map((c) => c[4]),
        volume: ohlcv.map((c) => c[5])
    });

    const getAverageVolume = (volume, lastIndex, volumePeriod) => {
        const recentVolumes = volume.slice(Math.max(0, lastIndex - volumePeriod), lastIndex);
        const denominator = Math.max(recentVolumes.length, 1);
        return recentVolumes.reduce((a, b) => a + b, 0) / denominator;
    };

    const getCurrentAtr = (high, low, close, atrPeriod, lastIndex) => {
        const atrSeries = calcATR(high, low, close, atrPeriod);
        return atrSeries[lastIndex];
    };

    const getSignalSnapshotContext = (ohlcv, params) => {
        const { open, high, low, close, volume } = extractOhlcvSeries(ohlcv);
        const lastIndex = close.length - 2;
        const currentOpen = open[lastIndex];
        const currentPrice = close[lastIndex];
        const currentVolume = volume[lastIndex];
        const avgVolume = getAverageVolume(volume, lastIndex, params.volumePeriod);
        const volumeRatio = currentVolume / (avgVolume || 1);
        const hourUTC = new Date(ohlcv[lastIndex][0]).getUTCHours();
        const currentATR = getCurrentAtr(high, low, close, params.atrPeriod, lastIndex);
        const currentNatrPercent = Number.isFinite(currentATR) && Number.isFinite(currentPrice) && currentPrice > 0
            ? (currentATR / currentPrice) * 100
            : NaN;
        const rsiSeries = calcRSI(close, params.entryRsiPeriod || 14);
        const currentRsi = rsiSeries[lastIndex];
        const adxSeries = calcADX(high, low, close, params.entryAdxPeriod || 14);
        const currentAdx = adxSeries[lastIndex];
        const bollinger = calcBollingerBands(close, params.entryBbPeriod || 20, params.entryBbStdDev || 2);
        const bbBasis = bollinger.basis[lastIndex];
        const bbUpper = bollinger.upper[lastIndex];
        const bbLower = bollinger.lower[lastIndex];
        const stdDevSeries = calcStdDev(close, params.entryBbPeriod || 20);
        const currentStdDev = stdDevSeries[lastIndex];
        const bbWidth = Number.isFinite(bbUpper) && Number.isFinite(bbLower) && Number.isFinite(bbBasis) && bbBasis !== 0
            ? (bbUpper - bbLower) / bbBasis
            : NaN;
        const bbPercentB = Number.isFinite(bbUpper) && Number.isFinite(bbLower) && bbUpper !== bbLower
            ? (currentPrice - bbLower) / (bbUpper - bbLower)
            : NaN;
        const macd = calcMACD(close);
        const macdHistogram = macd.histogram[lastIndex];

        return {
            open,
            high,
            low,
            close,
            volume,
            lastIndex,
            currentOpen,
            currentPrice,
            currentVolume,
            avgVolume,
            volumeRatio,
            hourUTC,
            currentATR,
            currentStdDev,
            currentNatrPercent,
            currentRsi,
            currentAdx,
            bbBasis,
            bbUpper,
            bbLower,
            bbWidth,
            bbPercentB,
            macdHistogram
        };
    };

    const maybeLogPositionPnL = (pnlState, exitState) => {
        const pnlLogInterval = getPnlLogInterval(pnlState, exitState);
        const now = Date.now();

        if (now - getLastPnlLog() > pnlLogInterval) {
            const { displayProfitUSDT, displayProfitPercent } = getDisplayPnlValues(pnlState);
            console.log(`[PNL] ${displayProfitUSDT.toFixed(4)} USDT (${displayProfitPercent.toFixed(2)}%)`);
            setLastPnlLog(now);
        }
    };

    const buildSignalSnapshot = (ohlcv, params) => {
        if (!Array.isArray(ohlcv) || ohlcv.length < 3) return null;

        const snapshotContext = getSignalSnapshotContext(ohlcv, params);
        const {
            open,
            high,
            low,
            close,
            volume,
            lastIndex,
            currentOpen,
            currentPrice,
            currentVolume,
            avgVolume,
            volumeRatio,
            hourUTC,
            currentATR,
            currentStdDev,
            currentNatrPercent,
            currentRsi,
            currentAdx,
            bbBasis,
            bbUpper,
            bbLower,
            bbWidth,
            bbPercentB,
            macdHistogram
        } = snapshotContext;
        if (!Number.isFinite(currentATR) || currentATR <= 0) return { invalidAtr: true };

        return {
            ohlcv,
            open,
            high,
            low,
            close,
            volume,
            lastIndex,
            currentOpen,
            currentPrice,
            currentVolume,
            avgVolume,
            volumeRatio,
            hourUTC,
            currentATR,
            currentStdDev,
            currentNatrPercent,
            currentRsi,
            currentAdx,
            bbBasis,
            bbUpper,
            bbLower,
            bbWidth,
            bbPercentB,
            macdHistogram
        };
    };


    return {
        parseSignalOrderData,
        getOrderFillSnapshot,
        buildOrderPlan,
        isDirectionalOrderPlanValid,
        logOrderPlan,
        evaluatePositionExit,
        maybeLogPositionPnL,
        buildSignalSnapshot
    };
};

module.exports = { createTradeLogicHelpers };
