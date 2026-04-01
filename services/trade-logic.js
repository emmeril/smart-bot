const createTradeLogicHelpers = ({
    getDb,
    toFiniteNumber,
    formatPriceToMarketPrecision,
    matchesOrderToTrackedPosition,
    getLastPnlLog,
    setLastPnlLog,
    calcATR
}) => {
    const normalizeSignalOrderDefaults = (signalData) => ({
        signalPrice: signalData,
        signalATR: null,
        strategyName: "FUTURES_GRID",
        riskOverrides: {},
        signalTargetPrice: null,
        signalStopLossPrice: null
    });

    const parseSignalOrderData = (signalData) => {
        if (typeof signalData !== "object" || signalData === null) {
            return normalizeSignalOrderDefaults(signalData);
        }
        return {
            signalPrice: signalData.price,
            signalATR: toFiniteNumber(signalData.atr, null),
            strategyName: signalData.strategy ? String(signalData.strategy) : "FUTURES_GRID",
            riskOverrides: signalData.riskOverrides || {},
            signalTargetPrice: toFiniteNumber(signalData.targetPrice, null),
            signalStopLossPrice: toFiniteNumber(signalData.stopLossPrice, null)
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
        const filledQuantity = toFiniteNumber(order?.filled, 0);
        return {
            price: getResolvedOrderPrice(order, fallbackPrice, filledQuantity),
            quantity: filledQuantity > 0 ? filledQuantity : fallbackQuantity
        };
    };

    const resolveRoundedPlanPrice = (pair, price) => {
        const roundedPrice = formatPriceToMarketPrecision(pair, price);
        return Number.isFinite(roundedPrice) ? roundedPrice : price;
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

    const buildOrderPlan = (side, entryPrice, adjustedQty, signalATR, riskOverrides, explicitTargets = {}) => {
        const db = getDb();
        const trailingActivateATR = toFiniteNumber(riskOverrides.trailingActivateATR, db.trailingActivateATR);
        const trailingOffsetATR = toFiniteNumber(riskOverrides.trailingOffsetATR, db.trailingOffsetATR);
        const explicitTargetPrice = toFiniteNumber(explicitTargets.targetPrice, null);
        const explicitStopLossPrice = toFiniteNumber(explicitTargets.stopLossPrice, null);

        let targetProfitUSDT = db.gridTargetProfitUsdt;
        let stopLossUSDT = -db.gridOrderSizeUsdt * (db.gridStopLossPercent / 100);
        let targetPrice;
        let stopLossPrice;

        if (Number.isFinite(explicitTargetPrice)) {
            targetPrice = resolveRoundedPlanPrice(db.pair, explicitTargetPrice);
            targetProfitUSDT = Math.abs(targetPrice - entryPrice) * adjustedQty;
        } else {
            const rawTargetPrice = buildDirectionalTargetPrice(side, entryPrice, targetProfitUSDT, adjustedQty);
            targetPrice = resolveRoundedPlanPrice(db.pair, rawTargetPrice);
            targetProfitUSDT = Math.abs(targetPrice - entryPrice) * adjustedQty;
        }

        if (Number.isFinite(explicitStopLossPrice)) {
            stopLossPrice = resolveRoundedPlanPrice(db.pair, explicitStopLossPrice);
            stopLossUSDT = -Math.abs(stopLossPrice - entryPrice) * adjustedQty;
        } else {
            const rawStopLossPrice = buildDirectionalStopLossPrice(side, entryPrice, stopLossUSDT, adjustedQty);
            stopLossPrice = resolveRoundedPlanPrice(db.pair, rawStopLossPrice);
            stopLossUSDT = -Math.abs(stopLossPrice - entryPrice) * adjustedQty;
        }

        if (Number.isFinite(entryPrice) && Number.isFinite(targetPrice) && targetPrice === entryPrice) {
            console.warn(`[WARN] Rounded target price equals entry price for ${side} order. Review precision/minimum profit settings.`);
        }
        if (Number.isFinite(entryPrice) && Number.isFinite(stopLossPrice) && stopLossPrice === entryPrice) {
            console.warn(`[WARN] Rounded stop loss price equals entry price for ${side} order. Review precision/minimum stop settings.`);
        }

        return {
            trailingActivateATR,
            trailingOffsetATR,
            targetProfitUSDT,
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
        console.log(formatOrderPlanLine("Amount", `${db.gridOrderSizeUsdt} USDT x ${db.leverage}x = ${(db.gridOrderSizeUsdt * db.leverage).toFixed(2)} USDT`));
        console.log(formatOrderPlanLine("Quantity", formatOrderPlanQuantityLabel(adjustedQty)));
        console.log(formatOrderPlanLine("Entry Price", entryPrice));
        console.log(formatOrderPlanLine("Strategy", strategyName));
        console.log(formatOrderPlanLine("Target Profit", `${orderPlan.targetProfitUSDT.toFixed(4)} USDT`));
        console.log(formatOrderPlanLine("Target Price", orderPlan.targetPrice));
        console.log(formatOrderPlanLine("Stop Loss", `${orderPlan.stopLossUSDT.toFixed(4)} USDT`));
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
                // Optimasi: Selalu prioritaskan stopLossPrice yang sudah ada di state (misal dari Trailing Stop)
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
        return Number.isFinite(position.targetProfitUSDT) && position.targetProfitUSDT > 0
            ? position.targetProfitUSDT
            : db.gridTargetProfitUsdt;
    };

    const resolveEffectiveStopLossUSDT = (position) => {
        const db = getDb();
        const fallbackStopLossUSDT = -Math.abs(db.gridOrderSizeUsdt * (db.gridStopLossPercent / 100));
        const rawStopLossUSDT = Number.isFinite(position.stopLossUSDT) ? position.stopLossUSDT : fallbackStopLossUSDT;
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
            currentATR
        };
    };

    const maybeLogPositionPnL = (pnlState, exitState) => {
        const pnlLogInterval = getPnlLogInterval(pnlState, exitState);

        if (Date.now() - getLastPnlLog() > pnlLogInterval) {
            const { displayProfitUSDT, displayProfitPercent } = getDisplayPnlValues(pnlState);
            console.log(`\n[PNL] ${displayProfitUSDT.toFixed(4)} USDT (${displayProfitPercent.toFixed(2)}%)`);
            setLastPnlLog(Date.now());
        }
    };

    const buildSignalSnapshot = (ohlcv, params) => {
        if (!Array.isArray(ohlcv) || ohlcv.length < 3) return null;

        const { open, high, low, close, volume, lastIndex, currentOpen, currentPrice, currentVolume, avgVolume, volumeRatio, hourUTC, currentATR } = getSignalSnapshotContext(ohlcv, params);
        if (!Number.isFinite(currentATR) || currentATR <= 0) return { invalidAtr: true };

        return { ohlcv, open, high, low, close, volume, lastIndex, currentOpen, currentPrice, currentVolume, avgVolume, volumeRatio, hourUTC, currentATR };
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


