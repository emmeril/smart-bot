const createTradeLogicHelpers = ({
    getDb,
    toFiniteNumber,
    formatPriceToMarketPrecision,
    matchesOrderToTrackedPosition,
    getLastPnlLog,
    setLastPnlLog,
    calcATR
}) => {
    const parseSignalOrderData = (signalData) => {
        if (typeof signalData !== "object" || signalData === null) {
            return {
                signalPrice: signalData,
                signalATR: null,
                strategyName: "FUTURES_GRID",
                riskOverrides: {},
                signalTargetPrice: null,
                signalStopLossPrice: null
            };
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

    const getOrderFillSnapshot = (order, fallbackPrice, fallbackQuantity) => {
        const filledQuantity = toFiniteNumber(order?.filled, 0);
        const averagePrice = toFiniteNumber(order?.average, 0);
        const orderCost = toFiniteNumber(order?.cost, 0);
        const directPrice = toFiniteNumber(order?.price, 0);
        const infoAveragePrice = toFiniteNumber(order?.info?.avgPrice, 0);
        const infoQuoteQty = toFiniteNumber(order?.info?.cumQuoteQty, 0);
        const resolvedQuantity = filledQuantity > 0 ? filledQuantity : fallbackQuantity;
        const resolvedPrice = averagePrice > 0
            ? averagePrice
            : (infoAveragePrice > 0
                ? infoAveragePrice
                : (filledQuantity > 0 && orderCost > 0
                    ? orderCost / filledQuantity
                    : (filledQuantity > 0 && infoQuoteQty > 0 ? infoQuoteQty / filledQuantity : (directPrice > 0 ? directPrice : fallbackPrice))));
        return { price: resolvedPrice, quantity: resolvedQuantity };
    };

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

        if (Number.isFinite(explicitTargetPrice) && Number.isFinite(explicitStopLossPrice)) {
            const roundedTargetPrice = formatPriceToMarketPrecision(db.pair, explicitTargetPrice);
            const roundedStopLossPrice = formatPriceToMarketPrecision(db.pair, explicitStopLossPrice);
            targetPrice = Number.isFinite(roundedTargetPrice) ? roundedTargetPrice : explicitTargetPrice;
            stopLossPrice = Number.isFinite(roundedStopLossPrice) ? roundedStopLossPrice : explicitStopLossPrice;
            targetProfitUSDT = Math.abs(targetPrice - entryPrice) * adjustedQty;
            stopLossUSDT = -Math.abs(stopLossPrice - entryPrice) * adjustedQty;
        } else {
            const rawTargetPrice = side === "buy"
                ? entryPrice + (targetProfitUSDT / adjustedQty)
                : entryPrice - (targetProfitUSDT / adjustedQty);
            const rawStopLossPrice = side === "buy"
                ? entryPrice + (stopLossUSDT / adjustedQty)
                : entryPrice - (stopLossUSDT / adjustedQty);
            const roundedTargetPrice = formatPriceToMarketPrecision(db.pair, rawTargetPrice);
            const roundedStopLossPrice = formatPriceToMarketPrecision(db.pair, rawStopLossPrice);
            targetPrice = Number.isFinite(roundedTargetPrice) ? roundedTargetPrice : rawTargetPrice;
            stopLossPrice = Number.isFinite(roundedStopLossPrice) ? roundedStopLossPrice : rawStopLossPrice;
            targetProfitUSDT = Math.abs(targetPrice - entryPrice) * adjustedQty;
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

    const logOrderPlan = (strategyName, entryPrice, adjustedQty, orderPlan) => {
        const db = getDb();
        console.log("   Order Details:");
        console.log(`   - Amount: ${db.gridOrderSizeUsdt} USDT x ${db.leverage}x = ${(db.gridOrderSizeUsdt * db.leverage).toFixed(2)} USDT`);
        console.log(`   - Quantity: ${adjustedQty} ${db.pair.split('/')[0]}`);
        console.log(`   - Entry Price: ${entryPrice}`);
        console.log(`   - Strategy: ${strategyName}`);
        console.log(`   - Target Profit: ${orderPlan.targetProfitUSDT.toFixed(4)} USDT`);
        console.log(`   - Target Price: ${orderPlan.targetPrice}`);
        console.log(`   - Stop Loss: ${orderPlan.stopLossUSDT.toFixed(4)} USDT`);
        console.log(`   - Stop Loss Price: ${orderPlan.stopLossPrice}`);
        console.log(`   - Trailing ATR: ${orderPlan.trailingActivateATR}/${orderPlan.trailingOffsetATR}x`);
    };

    const getPositionExitTargets = (position) => {
        const db = getDb();
        const effectiveTargetProfitUSDT = Number.isFinite(position.targetProfitUSDT) && position.targetProfitUSDT > 0
            ? position.targetProfitUSDT
            : db.gridTargetProfitUsdt;
        const fallbackStopLossUSDT = -Math.abs(db.gridOrderSizeUsdt * (db.gridStopLossPercent / 100));
        const rawStopLossUSDT = Number.isFinite(position.stopLossUSDT) ? position.stopLossUSDT : fallbackStopLossUSDT;
        const effectiveStopLossUSDT = -Math.abs(rawStopLossUSDT);

        let effectiveStopLossPrice = toFiniteNumber(position.stopLossPrice, NaN);
        if (!Number.isFinite(effectiveStopLossPrice) || effectiveStopLossPrice <= 0) {
            const entryPrice = toFiniteNumber(position.entryPrice, NaN);
            const quantity = toFiniteNumber(position.quantity, NaN);
            if (Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(quantity) && quantity > 0 && Number.isFinite(effectiveStopLossUSDT)) {
                // Optimasi: Selalu prioritaskan stopLossPrice yang sudah ada di state (misal dari Trailing Stop)
                let derivedStopLossPrice;
                if (Number.isFinite(position.stopLossPrice) && position.stopLossPrice > 0) {
                    derivedStopLossPrice = position.stopLossPrice;
                } else {
                    derivedStopLossPrice = position.side === "buy"
                        ? entryPrice + (effectiveStopLossUSDT / quantity)
                        : entryPrice - (effectiveStopLossUSDT / quantity);
                }
                effectiveStopLossPrice = formatPriceToMarketPrecision(db.pair, derivedStopLossPrice);
            } else {
                effectiveStopLossPrice = NaN;
            }
        }
        return { effectiveTargetProfitUSDT, effectiveStopLossUSDT, effectiveStopLossPrice };
    };

    const evaluatePositionExit = (position, currentPrice, pnlState, managedOrdersSnapshot = null) => {
        const { effectiveTargetProfitUSDT, effectiveStopLossUSDT, effectiveStopLossPrice } = getPositionExitTargets(position);
        const tpOrders = Array.isArray(managedOrdersSnapshot?.tp) ? managedOrdersSnapshot.tp : null;
        const slOrders = Array.isArray(managedOrdersSnapshot?.sl) ? managedOrdersSnapshot.sl : null;
        const hasExchangeTpOrder = tpOrders
            ? tpOrders.some((order) => matchesOrderToTrackedPosition(order, position))
            : Boolean(position?.tpOrderId || position?.tpClientOrderId);
        const hasExchangeSlOrder = slOrders
            ? slOrders.some((order) => matchesOrderToTrackedPosition(order, position))
            : Boolean(position?.slOrderId || position?.slClientOrderId);

        const targetHit = Number.isFinite(position.targetPrice) &&
            (position.side === "buy" ? currentPrice >= position.targetPrice : currentPrice <= position.targetPrice);

        const stopHit = Number.isFinite(effectiveStopLossPrice) &&
            (position.side === "buy" ? currentPrice <= effectiveStopLossPrice : currentPrice >= effectiveStopLossPrice);

        if (!hasExchangeTpOrder && (targetHit || pnlState.netProfitUSDT >= effectiveTargetProfitUSDT)) {
            return {
                shouldClose: true,
                reason: "PROFIT_TARGET",
                message: `\n[PROFIT] Net Target hit (+${pnlState.netProfitUSDT.toFixed(4)} USDT)! Closing...`,
                effectiveTargetProfitUSDT,
                effectiveStopLossUSDT
            };
        }

        if (!hasExchangeSlOrder && (stopHit || pnlState.netProfitUSDT <= effectiveStopLossUSDT)) {
            return {
                shouldClose: true,
                reason: "STOP_LOSS",
                message: `\n[STOP] Stop loss hit (${pnlState.netProfitUSDT.toFixed(4)} USDT)! Closing...`,
                effectiveTargetProfitUSDT,
                effectiveStopLossUSDT
            };
        }

        return {
            shouldClose: false,
            effectiveTargetProfitUSDT,
            effectiveStopLossUSDT
        };
    };

    const maybeLogPositionPnL = (pnlState, exitState) => {
        const nearExit =
            pnlState.netProfitUSDT >= (exitState.effectiveTargetProfitUSDT * 0.7) ||
            pnlState.netProfitUSDT <= (exitState.effectiveStopLossUSDT * 0.7);
        const pnlLogInterval = nearExit ? 2000 : 5000;

        if (Date.now() - getLastPnlLog() > pnlLogInterval) {
            const displayProfitUSDT = Number.isFinite(pnlState.displayProfitUSDT) ? pnlState.displayProfitUSDT : pnlState.netProfitUSDT;
            const displayProfitPercent = Number.isFinite(pnlState.displayProfitPercent) ? pnlState.displayProfitPercent : pnlState.profitPercent;
            console.log(`\n[PNL] ${displayProfitUSDT.toFixed(4)} USDT (${displayProfitPercent.toFixed(2)}%)`);
            setLastPnlLog(Date.now());
        }
    };

    const buildSignalSnapshot = (ohlcv, params) => {
        if (!Array.isArray(ohlcv) || ohlcv.length < 3) return null;

        const open = ohlcv.map((c) => c[1]);
        const high = ohlcv.map((c) => c[2]);
        const low = ohlcv.map((c) => c[3]);
        const close = ohlcv.map((c) => c[4]);
        const volume = ohlcv.map((c) => c[5]);
        const lastIndex = close.length - 2;
        const currentOpen = open[lastIndex];
        const currentPrice = close[lastIndex];
        const currentVolume = volume[lastIndex];
        const recentVolumes = volume.slice(Math.max(0, lastIndex - params.volumePeriod), lastIndex);
        const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / Math.max(recentVolumes.length, 1);
        const volumeRatio = currentVolume / (avgVolume || 1);
        const hourUTC = new Date(ohlcv[lastIndex][0]).getUTCHours();
        const atrSeries = calcATR(high, low, close, params.atrPeriod);
        const currentATR = atrSeries[lastIndex];
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
