const createOrderExecutionHelpers = ({
    getExchange,
    getMetrics,
    getDb,
    isHedgeModeEnabled,
    toFiniteNumber,
    formatAmountToMarketPrecision,
    formatPriceToMarketPrecision,
    validateOrderSize,
    buildExchangeOrderParams,
    getOrderPositionSide,
    getClosePositionSide,
    findOpenGridOrderByClientOrderId,
    findOpenOrderByClientOrderId,
    isDuplicateClientOrderIdError,
    cancelOrderByClientOrderId,
    syncPositionWithExchange,
    getExchangeClientOrderId,
    getTpClientOrderId,
    getSlClientOrderId,
    fetchOpenTpOrders,
    fetchOpenSlOrders,
    matchesOrderToTrackedPosition,
    getOrderQuantity,
    getOrderTriggerPrice,
    isManagedOrderPriceMatch,
    getPositionSyncQtyTolerance,
    upsertActivePosition,
    saveDB,
    cancelTpOrders,
    cancelSlOrders,
    buildReplacementClientOrderId
}) => {
    const describeError = (error) => String(error?.message || error || "Unknown error");

    const shouldAdoptExistingManagedOrder = (position, orderIdKey, clientIdKey) => {
        if (!position || typeof position !== "object") return false;
        const hasAttachedManagedOrder = Boolean(position?.[orderIdKey] || position?.[clientIdKey]);
        if (hasAttachedManagedOrder) return false;
        if (String(position?.strategy || "").toUpperCase() === "SYNC_ONLY") return true;
        return String(position?.orderId || "").startsWith("SYNC_");
    };

    const placeGridEntryOrder = async (gridOrder) => {
        const exchange = getExchange();
        const metrics = getMetrics();
        const db = getDb();
        const market = exchange.markets[db.pair];
        const orderSizeUsdt = Math.max(0, toFiniteNumber(gridOrder?.orderSizeUsdt, db.gridOrderSizeUsdt));
        const rawQty = (orderSizeUsdt * db.leverage) / gridOrder.price;
        const quantity = formatAmountToMarketPrecision(db.pair, rawQty);
        const sizeValidation = validateOrderSize(market, quantity, gridOrder.price);
        if (!sizeValidation.valid) {
            console.warn(`[GRID] Skipping ${gridOrder.side.toUpperCase()} ${gridOrder.price}: ${sizeValidation.reason}`);
            return false;
        }

        const params = buildExchangeOrderParams({
            side: gridOrder.side,
            positionSide: getOrderPositionSide(gridOrder.side)
        });
        params.newClientOrderId = gridOrder.clientOrderId;

        const existingOrder = await findOpenGridOrderByClientOrderId(gridOrder.clientOrderId);
        if (existingOrder) {
            console.log(`[GRID] Existing order already on exchange for ${gridOrder.clientOrderId}. Skipping duplicate placement.`);
            return true;
        }

        try {
            await exchange.createOrder(
                db.pair,
                "limit",
                gridOrder.side,
                quantity,
                gridOrder.price,
                params
            );
            metrics.api.orders++;
            console.log(`[GRID] Placed ${gridOrder.side.toUpperCase()} limit @ ${gridOrder.price} size ${orderSizeUsdt.toFixed(4)} USDT -> TP ${gridOrder.targetPrice} | SL ${gridOrder.stopLossPrice}`);
            return true;
        } catch (error) {
            if (isDuplicateClientOrderIdError(error)) {
                console.warn(`[GRID] Duplicate clientOrderId ${gridOrder.clientOrderId}. Attempting to cancel existing order and retry.`);
                const existingDuplicate = await findOpenGridOrderByClientOrderId(gridOrder.clientOrderId);
                if (existingDuplicate) {
                    console.log(`[GRID] Duplicate order already active for ${gridOrder.clientOrderId}. Treating as placed.`);
                    return true;
                }

                const cancelled = await cancelOrderByClientOrderId(gridOrder.clientOrderId, db.pair);
                if (cancelled) {
                    try {
                        await exchange.createOrder(
                            db.pair,
                            "limit",
                            gridOrder.side,
                            quantity,
                            gridOrder.price,
                            params
                        );
                        metrics.api.orders++;
                        console.log(`[GRID] Retry succeeded: placed ${gridOrder.side.toUpperCase()} limit @ ${gridOrder.price}`);
                        return true;
                    } catch (retryError) {
                        console.error(`[GRID] Retry failed for ${gridOrder.clientOrderId}: ${describeError(retryError)}`);
                        const retryExistingOrder = await findOpenGridOrderByClientOrderId(gridOrder.clientOrderId);
                        if (retryExistingOrder) {
                            console.log(`[GRID] Retry duplicate resolved by existing exchange order for ${gridOrder.clientOrderId}.`);
                            return true;
                        }
                        await syncPositionWithExchange();
                        return false;
                    }
                }

                console.warn(`[GRID] Could not cancel order with clientOrderId ${gridOrder.clientOrderId}. Syncing position state instead.`);
                await syncPositionWithExchange();
                return false;
            }

            console.error(`[GRID] Failed to place ${gridOrder.side.toUpperCase()} limit @ ${gridOrder.price}: ${describeError(error)}`);
            return false;
        }
    };

    const placeReduceOnlyTakeProfitOrder = async (position) => {
        const exchange = getExchange();
        const metrics = getMetrics();
        const db = getDb();
        if (!Number.isFinite(position?.targetPrice) || position.targetPrice <= 0) return null;
        if (!Number.isFinite(position?.quantity) || position.quantity <= 0) return null;
        const closeSide = position.side === "buy" ? "sell" : "buy";
        const quantity = formatAmountToMarketPrecision(db.pair, position.quantity);
        const market = exchange.markets[db.pair];
        const sizeValidation = validateOrderSize(market, quantity, position.targetPrice, { allowReduceOnlyClose: true });
        if (!sizeValidation.valid) {
            console.warn(`[TP] Skipping TP placement: ${sizeValidation.reason}`);
            return null;
        }
        if (sizeValidation.warning) console.warn(`[TP] ${sizeValidation.warning}`);

        const params = buildExchangeOrderParams({
            side: closeSide,
            reduceOnly: true,
            positionSide: getClosePositionSide(position)
        });
        const clientOrderId = position?.tpClientOrderId || getTpClientOrderId(position);
        params.newClientOrderId = clientOrderId;

        const existingOrder = await findOpenOrderByClientOrderId(clientOrderId, db.pair);
        if (existingOrder) {
            const nextOrderId = existingOrder.id || position.tpOrderId || null;
            const nextClientOrderId = getExchangeClientOrderId(existingOrder) || clientOrderId;
            if (position.tpOrderId !== nextOrderId || position.tpClientOrderId !== nextClientOrderId) {
                position.tpOrderId = nextOrderId;
                position.tpClientOrderId = nextClientOrderId;
                upsertActivePosition(position);
                await saveDB();
            }
            console.log(`[TP] Existing exchange order already active for ${clientOrderId}. Reusing it.`);
            return existingOrder;
        }

        try {
            const order = await exchange.createOrder(
                db.pair,
                "limit",
                closeSide,
                quantity,
                position.targetPrice,
                params
            );
            metrics.api.orders++;
            console.log(`[TP] Placed reduce-only TP ${closeSide.toUpperCase()} @ ${position.targetPrice} for qty ${quantity}`);
            return order;
        } catch (error) {
            if (isDuplicateClientOrderIdError(error)) {
                console.warn(`[TP] Duplicate clientOrderId ${clientOrderId}. Attempting to cancel existing order and retry.`);
                const duplicateOrder = await findOpenOrderByClientOrderId(clientOrderId, db.pair);
                if (duplicateOrder) {
                    console.log(`[TP] Duplicate resolved by existing exchange TP ${clientOrderId}.`);
                    return duplicateOrder;
                }
                const cancelled = await cancelOrderByClientOrderId(clientOrderId, db.pair);
                if (cancelled) {
                    try {
                        const retryOrder = await exchange.createOrder(
                            db.pair,
                            "limit",
                            closeSide,
                            quantity,
                            position.targetPrice,
                            params
                        );
                        metrics.api.orders++;
                        console.log(`[TP] Retry succeeded: placed reduce-only TP ${closeSide.toUpperCase()} @ ${position.targetPrice} for qty ${quantity}`);
                        return retryOrder;
                    } catch (retryError) {
                        console.error(`[TP] Retry failed for ${clientOrderId}: ${describeError(retryError)}`);
                        await syncPositionWithExchange();
                        return null;
                    }
                }

                const replacementClientOrderId = buildReplacementClientOrderId(clientOrderId);
                console.warn(`[TP] Existing clientOrderId ${clientOrderId} is unusable. Retrying with replacement ${replacementClientOrderId}.`);
                try {
                    const retryOrder = await exchange.createOrder(
                        db.pair,
                        "limit",
                        closeSide,
                        quantity,
                        position.targetPrice,
                        { ...params, newClientOrderId: replacementClientOrderId }
                    );
                    metrics.api.orders++;
                    console.log(`[TP] Replacement succeeded with clientOrderId ${replacementClientOrderId}.`);
                    return retryOrder;
                } catch (replacementError) {
                    console.error(`[TP] Replacement retry failed for ${replacementClientOrderId}: ${describeError(replacementError)}`);
                    await syncPositionWithExchange();
                    return null;
                }
            }
            throw error;
        }
    };

    const placeReduceOnlyStopLossOrder = async (position) => {
        const exchange = getExchange();
        const metrics = getMetrics();
        const db = getDb();
        if (!Number.isFinite(position?.stopLossPrice) || position.stopLossPrice <= 0) return null;
        if (!Number.isFinite(position?.quantity) || position.quantity <= 0) return null;
        const closeSide = position.side === "buy" ? "sell" : "buy";
        const quantity = formatAmountToMarketPrecision(db.pair, position.quantity);
        const market = exchange.markets[db.pair];
        const sizeValidation = validateOrderSize(market, quantity, position.stopLossPrice, { allowReduceOnlyClose: true });
        if (!sizeValidation.valid) {
            console.warn(`[SL] Skipping SL placement: ${sizeValidation.reason}`);
            return null;
        }
        if (sizeValidation.warning) console.warn(`[SL] ${sizeValidation.warning}`);

        const useClosePositionOrder = !isHedgeModeEnabled();
        const params = buildExchangeOrderParams({
            side: closeSide,
            reduceOnly: !useClosePositionOrder,
            positionSide: getClosePositionSide(position),
            closePosition: useClosePositionOrder
        });
        const clientOrderId = position?.slClientOrderId || getSlClientOrderId(position);
        params.newClientOrderId = clientOrderId;
        params.stopPrice = formatPriceToMarketPrecision(db.pair, position.stopLossPrice);
        params.workingType = "MARK_PRICE";

        const existingOrder = await findOpenOrderByClientOrderId(clientOrderId, db.pair);
        if (existingOrder) {
            const nextOrderId = existingOrder.id || position.slOrderId || null;
            const nextClientOrderId = getExchangeClientOrderId(existingOrder) || clientOrderId;
            if (position.slOrderId !== nextOrderId || position.slClientOrderId !== nextClientOrderId) {
                position.slOrderId = nextOrderId;
                position.slClientOrderId = nextClientOrderId;
                upsertActivePosition(position);
                await saveDB();
            }
            console.log(`[SL] Existing exchange order already active for ${clientOrderId}. Reusing it.`);
            return existingOrder;
        }

        try {
            const order = await exchange.createOrder(
                db.pair,
                "STOP_MARKET",
                closeSide,
                useClosePositionOrder ? undefined : quantity,
                undefined,
                params
            );
            metrics.api.orders++;
            const orderModeLabel = useClosePositionOrder ? "close-position STOP_MARKET" : "reduce-only STOP_MARKET";
            console.log(`[SL] Placed ${orderModeLabel} ${closeSide.toUpperCase()} @ stop ${params.stopPrice} for qty ${useClosePositionOrder ? "FULL" : quantity}`);
            return order;
        } catch (error) {
            if (isDuplicateClientOrderIdError(error)) {
                console.warn(`[SL] Duplicate clientOrderId ${clientOrderId}. Attempting to cancel existing order and retry.`);
                const duplicateOrder = await findOpenOrderByClientOrderId(clientOrderId, db.pair);
                if (duplicateOrder) {
                    console.log(`[SL] Duplicate resolved by existing exchange SL ${clientOrderId}.`);
                    return duplicateOrder;
                }
                const cancelled = await cancelOrderByClientOrderId(clientOrderId, db.pair);
                if (cancelled) {
                    try {
                        const retryOrder = await exchange.createOrder(
                            db.pair,
                            "STOP_MARKET",
                            closeSide,
                            useClosePositionOrder ? undefined : quantity,
                            undefined,
                            params
                        );
                        metrics.api.orders++;
                        const retryModeLabel = useClosePositionOrder ? "close-position STOP_MARKET" : "reduce-only STOP_MARKET";
                        console.log(`[SL] Retry succeeded: placed ${retryModeLabel} ${closeSide.toUpperCase()} @ stop ${params.stopPrice}`);
                        return retryOrder;
                    } catch (retryError) {
                        console.error(`[SL] Retry failed for ${clientOrderId}: ${describeError(retryError)}`);
                        await syncPositionWithExchange();
                        return null;
                    }
                }

                const replacementClientOrderId = buildReplacementClientOrderId(clientOrderId);
                console.warn(`[SL] Existing clientOrderId ${clientOrderId} is unusable. Retrying with replacement ${replacementClientOrderId}.`);
                try {
                    const retryOrder = await exchange.createOrder(
                        db.pair,
                        "STOP_MARKET",
                        closeSide,
                        useClosePositionOrder ? undefined : quantity,
                        undefined,
                        { ...params, newClientOrderId: replacementClientOrderId }
                    );
                    metrics.api.orders++;
                    console.log(`[SL] Replacement succeeded with clientOrderId ${replacementClientOrderId}.`);
                    return retryOrder;
                } catch (replacementError) {
                    console.error(`[SL] Replacement retry failed for ${replacementClientOrderId}: ${describeError(replacementError)}`);
                    await syncPositionWithExchange();
                    return null;
                }
            }
            throw error;
        }
    };

    const syncManagedReduceOnlyOrder = async ({
        positionKey,
        position,
        matchingOrders,
        matchingOrder,
        adoptableOrder,
        priceKey,
        orderIdKey,
        clientIdKey,
        label,
        syncPrice,
        placeReplacement,
        buildClientOrderId,
        cancelDuplicates,
        cancelReason,
        syncLogPrefix,
        attachLogPrefix
    }) => {
        if (matchingOrder) {
            if (matchingOrders.length > 1) {
                const duplicateOrders = matchingOrders.filter((order) => order !== matchingOrder);
                if (duplicateOrders.length > 0) await cancelDuplicates(duplicateOrders, cancelReason);
            }

            const nextClientOrderId = getExchangeClientOrderId(matchingOrder) || position[clientIdKey] || buildClientOrderId(position);
            const nextOrderId = matchingOrder.id || position[orderIdKey] || null;
            const nextPrice = syncPrice(matchingOrder);

            if (position[orderIdKey] !== nextOrderId || position[clientIdKey] !== nextClientOrderId || position[priceKey] !== nextPrice) {
                console.log(`${syncLogPrefix} Synced existing ${label} order for ${positionKey} @ ${nextPrice}`);
                position[orderIdKey] = nextOrderId;
                position[clientIdKey] = nextClientOrderId;
                position[priceKey] = nextPrice;
                upsertActivePosition(position);
                await saveDB();
            }
            return;
        }

        if (adoptableOrder && shouldAdoptExistingManagedOrder(position, orderIdKey, clientIdKey)) {
            const nextClientOrderId = getExchangeClientOrderId(adoptableOrder) || position[clientIdKey] || buildClientOrderId(position);
            const nextOrderId = adoptableOrder.id || position[orderIdKey] || null;
            const nextPrice = syncPrice(adoptableOrder);
            console.log(`${syncLogPrefix} Adopted existing ${label} order for ${positionKey} @ ${nextPrice}`);
            position[orderIdKey] = nextOrderId;
            position[clientIdKey] = nextClientOrderId;
            position[priceKey] = nextPrice;
            upsertActivePosition(position);
            await saveDB();
            return;
        }

        if (matchingOrders.length > 0) {
            console.log(`${syncLogPrefix} Existing ${label} order for ${positionKey} no longer matches target. Replacing...`);
            await cancelDuplicates(matchingOrders, cancelReason.replace("_DUPLICATE", "_REPLACE"));
        } else {
            console.log(`${syncLogPrefix} No exchange ${label} found for ${positionKey}. Creating replacement...`);
        }

        const placedOrder = await placeReplacement(position);
        if (!placedOrder) return;
        position[orderIdKey] = placedOrder.id || null;
        position[clientIdKey] = getExchangeClientOrderId(placedOrder) || buildClientOrderId(position);
        upsertActivePosition(position);
        await saveDB();
        console.log(`${attachLogPrefix} Attached exchange ${label} to ${positionKey}`);
    };

    const ensureReduceOnlyTakeProfitOrder = async (positionKey, sourcePosition) => {
        const position = { ...sourcePosition };
        if (!position || !Number.isFinite(position.targetPrice) || position.targetPrice <= 0) return;
        const matchingTpOrders = (await fetchOpenTpOrders()).filter((order) => matchesOrderToTrackedPosition(order, position));
        const adoptableOrder = matchingTpOrders.find((order) => {
            const orderAmount = getOrderQuantity(order);
            return Math.abs(orderAmount - position.quantity) <= getPositionSyncQtyTolerance();
        }) || null;
        const matchingOrder = matchingTpOrders.find((order) => {
            const orderPrice = toFiniteNumber(order.price, NaN);
            const orderAmount = getOrderQuantity(order);
            return isManagedOrderPriceMatch(position.targetPrice, orderPrice) && Math.abs(orderAmount - position.quantity) <= getPositionSyncQtyTolerance();
        });
        return syncManagedReduceOnlyOrder({
            positionKey,
            position,
            matchingOrders: matchingTpOrders,
            matchingOrder,
            adoptableOrder,
            priceKey: "targetPrice",
            orderIdKey: "tpOrderId",
            clientIdKey: "tpClientOrderId",
            label: "TP",
            syncPrice: (order) => toFiniteNumber(order.price, position.targetPrice),
            placeReplacement: placeReduceOnlyTakeProfitOrder,
            buildClientOrderId: getTpClientOrderId,
            cancelDuplicates: cancelTpOrders,
            cancelReason: "TP_DUPLICATE",
            syncLogPrefix: "[TP]",
            attachLogPrefix: "[TP]"
        });
    };

    const ensureReduceOnlyStopLossOrder = async (positionKey, sourcePosition) => {
        const position = { ...sourcePosition };
        if (!position || !Number.isFinite(position.stopLossPrice) || position.stopLossPrice <= 0) return;
        const matchingSlOrders = (await fetchOpenSlOrders()).filter((order) => matchesOrderToTrackedPosition(order, position));
        const adoptableOrder = matchingSlOrders.find((order) => {
            const orderAmount = getOrderQuantity(order);
            const closePositionOrder = Boolean(order?.closePosition || order?.info?.closePosition || !Number.isFinite(orderAmount) || orderAmount <= 0);
            if (closePositionOrder) return true;
            return Math.abs(orderAmount - position.quantity) <= getPositionSyncQtyTolerance();
        }) || null;
        const matchingOrder = matchingSlOrders.find((order) => {
            const orderStopPrice = getOrderTriggerPrice(order);
            const orderAmount = getOrderQuantity(order);
            const closePositionOrder = Boolean(order?.closePosition || order?.info?.closePosition || !Number.isFinite(orderAmount) || orderAmount <= 0);
            if (!isManagedOrderPriceMatch(position.stopLossPrice, orderStopPrice)) return false;
            if (closePositionOrder) return true;
            return Math.abs(orderAmount - position.quantity) <= getPositionSyncQtyTolerance();
        });
        return syncManagedReduceOnlyOrder({
            positionKey,
            position,
            matchingOrders: matchingSlOrders,
            matchingOrder,
            adoptableOrder,
            priceKey: "stopLossPrice",
            orderIdKey: "slOrderId",
            clientIdKey: "slClientOrderId",
            label: "SL",
            syncPrice: getOrderTriggerPrice,
            placeReplacement: placeReduceOnlyStopLossOrder,
            buildClientOrderId: getSlClientOrderId,
            cancelDuplicates: cancelSlOrders,
            cancelReason: "SL_DUPLICATE",
            syncLogPrefix: "[SL]",
            attachLogPrefix: "[SL]"
        });
    };

    return {
        placeGridEntryOrder,
        placeReduceOnlyTakeProfitOrder,
        placeReduceOnlyStopLossOrder,
        ensureReduceOnlyTakeProfitOrder,
        ensureReduceOnlyStopLossOrder
    };
};

module.exports = { createOrderExecutionHelpers };




















