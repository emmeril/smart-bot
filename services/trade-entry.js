const createTradeEntryHelpers = ({
    getDb,
    getExchange,
    getMetrics,
    getIsPlacingOrder,
    setIsPlacingOrder,
    getIsClosingPosition,
    getOrderPositionSide,
    getActivePositionByKey,
    setMarginMode,
    fetchOpenExchangePositions,
    isHedgeModeEnabled,
    matchesTrackedPositionSide,
    fetchManagedOpenOrdersSnapshot,
    setLeverage,
    getPrice,
    parseSignalOrderData,
    formatAmountToMarketPrecision,
    validateOrderSize,
    buildOrderPlan,
    logOrderPlan,
    isDirectionalOrderPlanValid,
    buildExchangeOrderParams,
    getOrderFillSnapshot,
    upsertActivePosition,
    toFiniteNumber,
    saveDB,
    ensureReduceOnlyTakeProfitOrder,
    ensureReduceOnlyStopLossOrder,
    logTrade,
    syncPositionWithExchange
}) => {
    const placeOrder = async (side, signalData = {}) => {
        const db = getDb();
        const exchange = getExchange();
        const metrics = getMetrics();
        try {
            if (!db || getIsPlacingOrder() || getIsClosingPosition()) return;
            const targetPositionKey = getOrderPositionSide(side);
            if (getActivePositionByKey(targetPositionKey)) return;
            setIsPlacingOrder(true);
            console.log(`\n[ORDER] Attempting to place ${side.toUpperCase()} order...`);
            await setMarginMode();
            const openExchangePositions = await fetchOpenExchangePositions();
            const conflictingExchangePosition = isHedgeModeEnabled()
                ? openExchangePositions.find((position) => matchesTrackedPositionSide(position, { positionSide: targetPositionKey, side }))
                : openExchangePositions[0] || null;
            if (conflictingExchangePosition) {
                console.warn(`[WARN] Skipping ${side.toUpperCase()} order because an exchange position is already open for the same side.`);
                return;
            }
            const managedOrdersSnapshot = await fetchManagedOpenOrdersSnapshot();
            if (managedOrdersSnapshot.triggerOrdersFetchFailed) {
                console.warn(`[WARN] Skipping ${side.toUpperCase()} order because managed trigger-order snapshot could not be verified.`);
                return;
            }
            const managedOrderCount = managedOrdersSnapshot.grid.length + managedOrdersSnapshot.tp.length + managedOrdersSnapshot.sl.length;
            if (managedOrderCount > 0) {
                console.warn(`[WARN] Skipping ${side.toUpperCase()} order because ${managedOrderCount} managed order(s) are still open on the exchange.`);
                return;
            }
            if (!(await setLeverage())) {
                console.warn(`[WARN] Skipping ${side.toUpperCase()} order because leverage ${db.leverage}x could not be confirmed on ${db.pair}.`);
                return;
            }

            const tickerPrice = await getPrice(true);
            if (!Number.isFinite(tickerPrice) || tickerPrice <= 0) {
                console.error("[ERROR] Invalid ticker price. Order skipped.");
                return;
            }

            const { signalPrice, signalATR, strategyName, riskOverrides, signalTargetPrice, signalStopLossPrice } = parseSignalOrderData(signalData);
            const hasSignalPrice = Number(signalPrice) > 0;
            const entryPrice = hasSignalPrice ? Number(signalPrice) : tickerPrice;
            const qty = (db.gridOrderSizeUsdt * db.leverage) / entryPrice;
            const market = exchange.markets[db.pair];
            const adjustedQty = formatAmountToMarketPrecision(db.pair, qty);
            const sizeValidation = validateOrderSize(market, adjustedQty, tickerPrice);
            if (!sizeValidation.valid) {
                console.error(sizeValidation.reason);
                return;
            }

            const orderPlan = buildOrderPlan(
                side,
                entryPrice,
                adjustedQty,
                signalATR,
                riskOverrides,
                { targetPrice: signalTargetPrice, stopLossPrice: signalStopLossPrice }
            );
            logOrderPlan(strategyName, entryPrice, adjustedQty, orderPlan);
            if (!isDirectionalOrderPlanValid(side, entryPrice, orderPlan)) {
                console.warn(`[WARN] Skipping ${side.toUpperCase()} order because TP/SL plan is not directional after rounding.`);
                return;
            }

            const order = await exchange.createOrder(
                db.pair,
                "market",
                side,
                adjustedQty,
                undefined,
                buildExchangeOrderParams({ side, positionSide: getOrderPositionSide(side) })
            );
            metrics.api.orders++;

            const fillSnapshot = getOrderFillSnapshot(order, tickerPrice, adjustedQty);
            const actualEntryPrice = fillSnapshot.price;
            const actualQuantity = fillSnapshot.quantity;
            const actualOrderPlan = buildOrderPlan(
                side,
                actualEntryPrice,
                actualQuantity,
                signalATR,
                riskOverrides,
                { targetPrice: signalTargetPrice, stopLossPrice: signalStopLossPrice }
            );
            const actualPlanValid = isDirectionalOrderPlanValid(side, actualEntryPrice, actualOrderPlan);
            const fallbackPlanValid = isDirectionalOrderPlanValid(side, actualEntryPrice, orderPlan);
            const closeSide = side === "buy" ? "sell" : "buy";
            const resolvedOrderPlan = actualPlanValid ? actualOrderPlan : (fallbackPlanValid ? orderPlan : null);
            if (!resolvedOrderPlan) {
                console.error(`[ERROR] Unable to derive a valid TP/SL plan after fill for ${side.toUpperCase()} order. Closing position to avoid unmanaged exposure.`);
                try {
                    await exchange.createOrder(
                        db.pair,
                        "market",
                        closeSide,
                        actualQuantity,
                        undefined,
                        buildExchangeOrderParams({
                            side: closeSide,
                            reduceOnly: true,
                            positionSide: getOrderPositionSide(side)
                        })
                    );
                    metrics.api.orders++;
                } catch (closeError) {
                    console.error(`[ERROR] Failed to immediately close invalid ${side.toUpperCase()} position: ${closeError.message}`);
                }
                await syncPositionWithExchange();
                return;
            }
            if (!actualPlanValid) {
                console.warn(`[WARN] Actual fill produced an invalid directional TP/SL plan for ${side.toUpperCase()} order. Falling back to the pre-fill plan.`);
            }

            upsertActivePosition({
                side,
                entryPrice: actualEntryPrice,
                targetPrice: resolvedOrderPlan.targetPrice,
                stopLossPrice: resolvedOrderPlan.stopLossPrice,
                stopLossUSDT: resolvedOrderPlan.stopLossUSDT,
                orderId: order.id,
                quantity: actualQuantity,
                entryTime: Date.now(),
                highestSinceEntry: actualEntryPrice,
                lowestSinceEntry: actualEntryPrice,
                marginMode: (db.marginMode || "isolated").toLowerCase(),
                positionSide: getOrderPositionSide(side),
                targetProfitUSDT: resolvedOrderPlan.targetProfitUSDT,
                leverageAtEntry: toFiniteNumber(db.leverage, 1),
                trailingEnabled: resolvedOrderPlan.trailingEnabled,
                atrAtEntry: signalATR,
                strategy: strategyName,
                trailingActivateATR: resolvedOrderPlan.trailingActivateATR,
                trailingOffsetATR: resolvedOrderPlan.trailingOffsetATR,
                tpOrderId: null,
                tpClientOrderId: null,
                slOrderId: null,
                slClientOrderId: null
            });

            await saveDB();
            await ensureReduceOnlyTakeProfitOrder(targetPositionKey, getActivePositionByKey(targetPositionKey));
            await ensureReduceOnlyStopLossOrder(targetPositionKey, getActivePositionByKey(targetPositionKey));
            logTrade(side === "buy" ? "LONG" : "SHORT", actualEntryPrice, null, "OPEN", 0, strategyName);
            metrics.trades.opened++;
            console.log(`\n[OK] ORDER PLACED: ${side.toUpperCase()} at ${actualEntryPrice}`);
        } catch (error) {
            console.error("[ERROR] Order failed:", error.message);
        } finally {
            setIsPlacingOrder(false);
        }
    };

    return { placeOrder };
};

module.exports = { createTradeEntryHelpers };
