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
    fetchOpenTpOrders,
    fetchOpenSlOrders,
    fetchManagedOpenOrdersSnapshot,
    fetchSpotBalances,
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
    clearMissingPositionState,
    logTrade,
    syncPositionWithExchange,
    notifyTradeUpdate
}) => {
    const placeOrder = async (side, signalData = {}) => {
        const db = getDb();
        const exchange = getExchange();
        const metrics = getMetrics();
        try {
            if (!db || getIsPlacingOrder() || getIsClosingPosition()) return;
            const targetPositionKey = getOrderPositionSide(side);
            const existingLocalPosition = getActivePositionByKey(targetPositionKey);
            if (existingLocalPosition) {
                await syncPositionWithExchange();
                const refreshedLocalPosition = getActivePositionByKey(targetPositionKey);
                if (refreshedLocalPosition) {
                    const isSpotRuntime = String(db?.marginMode || "spot").toLowerCase() === "spot";
                    const isBuyTrackedPosition = String(refreshedLocalPosition?.side || "").toLowerCase() === "buy";
                    if (isSpotRuntime && isBuyTrackedPosition && typeof clearMissingPositionState === "function") {
                        const balances = typeof fetchSpotBalances === "function" ? await fetchSpotBalances() : null;
                        const [baseAssetRaw = ""] = String(db.pair || "").split("/");
                        const baseAsset = baseAssetRaw.trim();
                        const baseBalanceRaw = balances?.[baseAsset];
                        const baseBalance = toFiniteNumber(baseBalanceRaw?.total ?? baseBalanceRaw?.free ?? baseBalanceRaw, NaN);
                        const trackedQty = toFiniteNumber(refreshedLocalPosition?.quantity, NaN);
                        const fetchedTpOrders = typeof fetchOpenTpOrders === "function" ? await fetchOpenTpOrders() : [];
                        const fetchedSlOrders = typeof fetchOpenSlOrders === "function" ? await fetchOpenSlOrders() : [];
                        const openTpOrders = Array.isArray(fetchedTpOrders) ? fetchedTpOrders : [];
                        const openSlOrders = Array.isArray(fetchedSlOrders) ? fetchedSlOrders : [];
                        const hasAnyAttachedExitOrder = openTpOrders.length > 0 || openSlOrders.length > 0;
                        const spotPair = String(db.pair || "").split(":")[0];
                        const exchangeInstance = getExchange();
                        const market = exchangeInstance?.markets?.[spotPair] || exchangeInstance?.markets?.[db.pair];
                        const marketFilters = Array.isArray(market?.info?.filters) ? market.info.filters : [];
                        const lotSizeFilter = marketFilters.find((filter) => String(filter?.filterType || "").toUpperCase() === "LOT_SIZE");
                        const minQty = toFiniteNumber(
                            lotSizeFilter?.minQty,
                            toFiniteNumber(market?.limits?.amount?.min, NaN)
                        );
                        if (
                            Number.isFinite(baseBalance)
                            && Number.isFinite(minQty)
                            && minQty > 0
                            && baseBalance < minQty
                            && !hasAnyAttachedExitOrder
                        ) {
                            console.warn(`[ORDER][WARN] Local BUY position ${targetPositionKey} cannot be sold (base balance ${baseBalance} < minQty ${minQty}) and has no TP/SL orders. Clearing local state.`);
                            await clearMissingPositionState(refreshedLocalPosition, "ENTRY_GUARD_STALE_POSITION", targetPositionKey);
                        }
                    }
                    if (getActivePositionByKey(targetPositionKey)) {
                        console.warn(`[ORDER][WARN] Skipping ${side.toUpperCase()} order because local active position ${targetPositionKey} still exists.`);
                        return;
                    }
                }
            }
            setIsPlacingOrder(true);
            console.log(`[ORDER][INFO] Attempting to place ${side.toUpperCase()} order...`);
            await setMarginMode();
            const openExchangePositions = await fetchOpenExchangePositions();
            const conflictingExchangePosition = openExchangePositions[0] || null;
            if (conflictingExchangePosition) {
                console.warn(`[ORDER][WARN] Skipping ${side.toUpperCase()} order because an exchange position is already open for the same side.`);
                return;
            }
            const managedOrdersSnapshot = await fetchManagedOpenOrdersSnapshot();
            if (managedOrdersSnapshot.triggerOrdersFetchFailed) {
                console.warn(`[ORDER][WARN] Skipping ${side.toUpperCase()} order because managed trigger-order snapshot could not be verified.`);
                return;
            }
            const managedOrderCount = managedOrdersSnapshot.grid.length + managedOrdersSnapshot.tp.length + managedOrdersSnapshot.sl.length;
            if (managedOrderCount > 0) {
                console.warn(`[ORDER][WARN] Skipping ${side.toUpperCase()} order because ${managedOrderCount} managed order(s) are still open on the exchange.`);
                return;
            }

            const spotPair = String(db.pair || "").split(":")[0];
            const tickerPrice = await getPrice(true);
            if (!Number.isFinite(tickerPrice) || tickerPrice <= 0) {
                console.error("[ORDER][ERROR] Invalid ticker price. Order skipped.");
                return;
            }

            const { signalPrice, signalATR, strategyName, riskOverrides, signalTargetPrice, signalStopLossPrice, exitOptimization } = parseSignalOrderData(signalData);
            const hasSignalPrice = Number(signalPrice) > 0;
            const entryPrice = hasSignalPrice ? Number(signalPrice) : tickerPrice;
            const qty = db.gridOrderSizeUsdt / entryPrice;
            const marketInfo = exchange.markets[spotPair] || exchange.markets[db.pair];
            const adjustedQty = formatAmountToMarketPrecision(db.pair, qty);
            const sizeValidation = validateOrderSize(marketInfo, adjustedQty, tickerPrice, { orderType: "MARKET" });
            if (!sizeValidation.valid) {
                console.error(sizeValidation.reason);
                return;
            }

            const balances = typeof fetchSpotBalances === "function" ? await fetchSpotBalances() : null;
            const [baseAssetRaw = "", quoteAssetRaw = ""] = String(db.pair || "").split("/");
            const baseAsset = baseAssetRaw.trim();
            const quoteAsset = quoteAssetRaw.split(":")[0].trim();
            const quoteFree = Number(balances?.[quoteAsset]?.free ?? balances?.[quoteAsset] ?? NaN);
            const baseFree = Number(balances?.[baseAsset]?.free ?? balances?.[baseAsset] ?? NaN);
            const estimatedNotional = adjustedQty * tickerPrice;
            if (side === "buy" && Number.isFinite(quoteFree) && quoteFree < estimatedNotional) {
                console.warn(`[INVENTORY][WARN] Insufficient ${quoteAsset} balance for BUY. Required ${estimatedNotional}, available ${quoteFree}.`);
                return;
            }
            if (side === "sell" && Number.isFinite(baseFree) && baseFree < adjustedQty) {
                console.warn(`[INVENTORY][WARN] Insufficient ${baseAsset} balance for SELL. Required ${adjustedQty}, available ${baseFree}.`);
                return;
            }

            const orderPlan = buildOrderPlan(
                side,
                entryPrice,
                adjustedQty,
                signalATR,
                riskOverrides,
                { targetPrice: signalTargetPrice, stopLossPrice: signalStopLossPrice, exitOptimization }
            );
            logOrderPlan(strategyName, entryPrice, adjustedQty, orderPlan);
            if (!isDirectionalOrderPlanValid(side, entryPrice, orderPlan)) {
                console.warn(`[ORDER][WARN] Skipping ${side.toUpperCase()} order because TP/SL plan is not directional after rounding.`);
                return;
            }

            const order = await exchange.createOrder(
                spotPair,
                "market",
                side,
                adjustedQty,
                undefined,
                buildExchangeOrderParams({ side })
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
                { targetPrice: signalTargetPrice, stopLossPrice: signalStopLossPrice, exitOptimization }
            );
            const actualPlanValid = isDirectionalOrderPlanValid(side, actualEntryPrice, actualOrderPlan);
            const fallbackPlanValid = isDirectionalOrderPlanValid(side, actualEntryPrice, orderPlan);
            const closeSide = side === "buy" ? "sell" : "buy";
            const resolvedOrderPlan = actualPlanValid ? actualOrderPlan : (fallbackPlanValid ? orderPlan : null);
            if (!resolvedOrderPlan) {
                console.error(`[ORDER][ERROR] Unable to derive a valid TP/SL plan after fill for ${side.toUpperCase()} order. Closing position to avoid unmanaged exposure.`);
                try {
                    await exchange.createOrder(
                        spotPair,
                        "market",
                        closeSide,
                        actualQuantity,
                        undefined,
                        buildExchangeOrderParams({ side: closeSide })
                    );
                    metrics.api.orders++;
                } catch (closeError) {
                    console.error(`[ORDER][ERROR] Failed to immediately close invalid ${side.toUpperCase()} position: ${closeError.message}`);
                }
                await syncPositionWithExchange();
                return;
            }
            if (!actualPlanValid) {
                console.warn(`[ORDER][WARN] Actual fill produced an invalid directional TP/SL plan for ${side.toUpperCase()} order. Falling back to the pre-fill plan.`);
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
                settlementMode: "spot",
                positionSide: targetPositionKey,
                targetProfitUSDT: resolvedOrderPlan.targetProfitUSDT,
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
            logTrade(side.toUpperCase(), actualEntryPrice, null, "OPEN", 0, strategyName);
            if (typeof notifyTradeUpdate === "function") {
                await notifyTradeUpdate({
                    event: "OPEN",
                    position: {
                        ...getActivePositionByKey(targetPositionKey),
                        symbol: db.pair
                    },
                    entryPrice: actualEntryPrice,
                    quantity: actualQuantity,
                    reason: `Signal ${side.toUpperCase()}`,
                    occurredAt: Date.now()
                });
            }
            metrics.trades.opened++;
            console.log(`[ORDER][INFO] Placed ${side.toUpperCase()} order at ${actualEntryPrice}`);
        } catch (error) {
            console.error("[ORDER][ERROR] Order failed:", error.message);
        } finally {
            setIsPlacingOrder(false);
        }
    };

    return { placeOrder };
};

module.exports = { createTradeEntryHelpers };
