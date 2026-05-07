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
    logTrade,
    syncPositionWithExchange
}) => {
    const isTimestampError = (error) => {
        const code = Number(error?.code);
        const message = String(error?.message || error || "");
        return code === -1021 || /timestamp.*outside of the recvWindow|timestamp for this request was/i.test(message);
    };

    const getErrorStatus = (error) => {
        const candidates = [error?.status, error?.statusCode, error?.httpStatus, error?.response?.status, error?.response?.statusCode];
        for (const candidate of candidates) {
            const parsed = Number(candidate);
            if (Number.isFinite(parsed)) return parsed;
        }
        return NaN;
    };

    const getRetryAfterMs = (error) => {
        const headers = error?.headers || error?.responseHeaders || error?.response?.headers || {};
        const retryAfter = headers["Retry-After"] || headers["retry-after"];
        const parsed = Number(retryAfter);
        return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : NaN;
    };

    const getExchangeErrorCode = (error) => {
        const directCode = Number(error?.code);
        if (Number.isFinite(directCode)) return directCode;
        const payload = String(error?.message || error || "");
        const match = payload.match(/"code"\s*:\s*(-?\d+)/);
        return match ? Number(match[1]) : NaN;
    };

    const isRateLimitError = (error) => {
        const status = getErrorStatus(error);
        const code = getExchangeErrorCode(error);
        const payload = String(error?.message || error || "");
        return status === 429 || status === 418 || code === -1003 || code === -1015 || /too many requests|too much request weight|ip banned|too many new orders/i.test(payload);
    };

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const runPrivateApiWithRecovery = async (operation, label = "private API request") => {
        let refreshedTimestamp = false;
        let delayMs = 1000;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                return await operation();
            } catch (error) {
                const exchange = getExchange();
                if (isTimestampError(error) && !refreshedTimestamp && typeof exchange?.loadTimeDifference === "function") {
                    refreshedTimestamp = true;
                    try {
                        await exchange.loadTimeDifference();
                    } catch (refreshError) {
                        console.warn(`[EXCHANGE][WARN] Failed to refresh time difference after timestamp error: ${String(refreshError?.message || refreshError)}`);
                    }
                    continue;
                }

                if (!isRateLimitError(error) || attempt === 2) throw error;
                const retryAfterMs = getRetryAfterMs(error);
                if (getErrorStatus(error) === 418) {
                    const waitLabel = Number.isFinite(retryAfterMs) ? ` Retry-After=${Math.ceil(retryAfterMs / 1000)}s.` : "";
                    throw new Error(`Binance IP ban response received during ${label}. Stop requests until the ban window expires.${waitLabel}`);
                }
                const waitMs = Number.isFinite(retryAfterMs) ? retryAfterMs : delayMs;
                console.warn(`[EXCHANGE][WARN] Rate limit during ${label}. Retrying in ${waitMs}ms.`);
                await sleep(waitMs);
                delayMs = Math.max(delayMs * 2, waitMs * 2);
            }
        }
    };

    const createOrderWithTimestampRecovery = async (...args) => {
        const exchange = getExchange();
        return await runPrivateApiWithRecovery(() => exchange.createOrder(...args), "order placement");
    };

    const placeOrder = async (side, signalData = {}) => {
        const db = getDb();
        const exchange = getExchange();
        const metrics = getMetrics();
        try {
            if (!db || getIsPlacingOrder() || getIsClosingPosition()) return;
            const targetPositionKey = getOrderPositionSide(side);
            if (getActivePositionByKey(targetPositionKey)) return;
            setIsPlacingOrder(true);
            console.log(`[ORDER][INFO] Attempting to place ${side.toUpperCase()} order...`);
            await setMarginMode();
            const openExchangePositions = await fetchOpenExchangePositions();
            const conflictingExchangePosition = isHedgeModeEnabled()
                ? openExchangePositions.find((position) => matchesTrackedPositionSide(position, { positionSide: targetPositionKey, side }))
                : openExchangePositions[0] || null;
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
            const sizeValidation = validateOrderSize(marketInfo, adjustedQty, tickerPrice, {
                orderType: "MARKET",
                side,
                marketPrice: tickerPrice
            });
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

            const order = await createOrderWithTimestampRecovery(
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
                    await createOrderWithTimestampRecovery(
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
                positionSide: "SPOT",
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
