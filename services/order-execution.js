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
    fetchSpotBalances,
    upsertActivePosition,
    saveDB,
    cancelTpOrders,
    cancelSlOrders,
    buildReplacementClientOrderId
}) => {
    const managedOrderSyncChains = new Map();

    const runManagedOrderSync = async (key, operation) => {
        const chainKey = String(key || "");
        const previousOperation = (managedOrderSyncChains.get(chainKey) || Promise.resolve()).catch(() => {});
        let releaseOperation = () => {};
        const nextOperation = new Promise((resolve) => {
            releaseOperation = resolve;
        });
        managedOrderSyncChains.set(chainKey, nextOperation);
        await previousOperation;
        try {
            return await operation();
        } finally {
            releaseOperation();
            if (managedOrderSyncChains.get(chainKey) === nextOperation) {
                managedOrderSyncChains.delete(chainKey);
            }
        }
    };

    const describeError = (error) => String(error?.message || error || "Unknown error");
    const attachClientOrderIdFallback = (order, clientOrderId) => {
        if (!order || !clientOrderId) return order;
        const nextOrder = typeof order === "object" ? order : { value: order };
        nextOrder.clientOrderId = nextOrder.clientOrderId || clientOrderId;
        nextOrder.info = nextOrder.info && typeof nextOrder.info === "object" ? nextOrder.info : {};
        nextOrder.info.clientOrderId = nextOrder.info.clientOrderId || clientOrderId;
        nextOrder.info.origClientOrderId = nextOrder.info.origClientOrderId || clientOrderId;
        return nextOrder;
    };

    const getSpotPair = (pair) => String(pair || "").split(":")[0];

    const getBinanceSymbolId = (spotPair) => {
        const exchange = getExchange();
        const marketInfo = exchange?.markets?.[spotPair] || exchange?.markets?.[getDb()?.pair] || null;
        if (marketInfo?.id) return marketInfo.id;
        return String(spotPair || "").replace("/", "").replace(":", "");
    };

    const normalizeBinanceOrderReport = (report, symbol, fallbackClientOrderId = "") => {
        if (!report || typeof report !== "object") return null;
        const clientOrderId = String(report.clientOrderId || report.origClientOrderId || fallbackClientOrderId || "");
        return attachClientOrderIdFallback({
            id: String(report.orderId || report.id || ""),
            symbol,
            type: String(report.type || "").toLowerCase(),
            side: String(report.side || "").toLowerCase(),
            amount: toFiniteNumber(report.origQty ?? report.executedQty, NaN),
            price: toFiniteNumber(report.price, NaN),
            stopPrice: toFiniteNumber(report.stopPrice, NaN),
            clientOrderId,
            info: report
        }, clientOrderId);
    };

    const extractOcoLegs = (ocoResponse, symbol, tpClientOrderId, slClientOrderId) => {
        const reports = Array.isArray(ocoResponse?.orderReports)
            ? ocoResponse.orderReports
            : (Array.isArray(ocoResponse?.info?.orderReports) ? ocoResponse.info.orderReports : []);
        const normalizedReports = reports
            .map((report) => normalizeBinanceOrderReport(report, symbol))
            .filter(Boolean);
        const tpOrder = normalizedReports.find((order) => getExchangeClientOrderId(order) === tpClientOrderId)
            || normalizedReports.find((order) => !String(order?.type || "").toUpperCase().includes("STOP"))
            || attachClientOrderIdFallback({ id: null, symbol, info: {} }, tpClientOrderId);
        const slOrder = normalizedReports.find((order) => getExchangeClientOrderId(order) === slClientOrderId)
            || normalizedReports.find((order) => String(order?.type || "").toUpperCase().includes("STOP") || Number.isFinite(getOrderTriggerPrice(order)))
            || attachClientOrderIdFallback({ id: null, symbol, info: {} }, slClientOrderId);
        return {
            orderListId: ocoResponse?.orderListId || ocoResponse?.info?.orderListId || null,
            listClientOrderId: ocoResponse?.listClientOrderId || ocoResponse?.info?.listClientOrderId || null,
            tpOrder: attachClientOrderIdFallback(tpOrder, tpClientOrderId),
            slOrder: attachClientOrderIdFallback(slOrder, slClientOrderId),
            raw: ocoResponse
        };
    };

    const placeBinanceOcoOrder = async ({
        spotPair,
        closeSide,
        quantity,
        targetPrice,
        stopPrice,
        stopLimitPrice,
        listClientOrderId,
        tpClientOrderId,
        slClientOrderId
    }) => {
        const exchange = getExchange();
        const symbolId = getBinanceSymbolId(spotPair);
        const request = {
            symbol: symbolId,
            side: String(closeSide || "").toUpperCase(),
            quantity,
            price: targetPrice,
            stopPrice,
            stopLimitPrice,
            stopLimitTimeInForce: "GTC",
            listClientOrderId,
            limitClientOrderId: tpClientOrderId,
            stopClientOrderId: slClientOrderId,
            newOrderRespType: "RESULT"
        };

        if (typeof exchange.privatePostOrderOco === "function") {
            return await exchange.privatePostOrderOco(request);
        }

        if (typeof exchange.privatePostOrderListOco === "function") {
            return await exchange.privatePostOrderListOco({
                symbol: symbolId,
                side: request.side,
                quantity,
                aboveType: closeSide === "sell" ? "LIMIT_MAKER" : "STOP_LOSS_LIMIT",
                abovePrice: closeSide === "sell" ? targetPrice : stopLimitPrice,
                aboveStopPrice: closeSide === "sell" ? undefined : stopPrice,
                aboveTimeInForce: closeSide === "sell" ? undefined : "GTC",
                aboveClientOrderId: closeSide === "sell" ? tpClientOrderId : slClientOrderId,
                belowType: closeSide === "sell" ? "STOP_LOSS_LIMIT" : "LIMIT_MAKER",
                belowPrice: closeSide === "sell" ? stopLimitPrice : targetPrice,
                belowStopPrice: closeSide === "sell" ? stopPrice : undefined,
                belowTimeInForce: closeSide === "sell" ? "GTC" : undefined,
                belowClientOrderId: closeSide === "sell" ? slClientOrderId : tpClientOrderId,
                listClientOrderId,
                newOrderRespType: "RESULT"
            });
        }

        throw new Error("Binance OCO endpoint is not available in this CCXT exchange instance.");
    };

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
        const spotPair = getSpotPair(db.pair);
        const marketInfo = exchange.markets[spotPair] || exchange.markets[db.pair];
        const orderSizeUsdt = Math.max(0, toFiniteNumber(gridOrder?.orderSizeUsdt, db.gridOrderSizeUsdt));
        const rawQty = orderSizeUsdt / gridOrder.price;
        const quantity = formatAmountToMarketPrecision(db.pair, rawQty);
        const sizeValidation = validateOrderSize(marketInfo, quantity, gridOrder.price, { orderType: "LIMIT" });
        if (!sizeValidation.valid) {
            console.warn(`[GRID][WARN] Skipping ${gridOrder.side.toUpperCase()} ${gridOrder.price}: ${sizeValidation.reason}`);
            return false;
        }

        const balances = typeof fetchSpotBalances === "function" ? await fetchSpotBalances() : null;
        const [baseAssetRaw = "", quoteAssetRaw = ""] = String(db.pair || "").split("/");
        const baseAsset = baseAssetRaw.trim();
        const quoteAsset = quoteAssetRaw.split(":")[0].trim();
        const quoteFree = Number(balances?.[quoteAsset]?.free ?? balances?.[quoteAsset] ?? NaN);
        const baseFree = Number(balances?.[baseAsset]?.free ?? balances?.[baseAsset] ?? NaN);
        const estimatedNotional = quantity * gridOrder.price;
        if (gridOrder.side === "buy" && Number.isFinite(quoteFree) && quoteFree < estimatedNotional) {
            console.warn(`[GRID][WARN] Skipping BUY grid order because ${quoteAsset} balance is insufficient.`);
            return false;
        }
        if (gridOrder.side === "sell" && Number.isFinite(baseFree) && baseFree < quantity) {
            console.warn(`[GRID][WARN] Skipping SELL grid order because ${baseAsset} balance is insufficient. Spot grid sell orders only use owned base balance.`);
            return false;
        }

        const params = buildExchangeOrderParams({
            side: gridOrder.side
        });
        params.newClientOrderId = gridOrder.clientOrderId;

        const existingOrder = await findOpenGridOrderByClientOrderId(gridOrder.clientOrderId);
        if (existingOrder) {
            console.log(`[GRID][INFO] Existing order already on exchange for ${gridOrder.clientOrderId}. Skipping duplicate placement.`);
            return true;
        }

        try {
            await exchange.createOrder(
                spotPair,
                "limit",
                gridOrder.side,
                quantity,
                gridOrder.price,
                params
            );
            metrics.api.orders++;
            console.log(`[GRID][INFO] Placed ${gridOrder.side.toUpperCase()} limit @ ${gridOrder.price} size ${orderSizeUsdt.toFixed(4)} USDT -> TP ${gridOrder.targetPrice} | SL ${gridOrder.stopLossPrice}`);
            return true;
        } catch (error) {
            if (isDuplicateClientOrderIdError(error)) {
                console.warn(`[GRID][WARN] Duplicate clientOrderId ${gridOrder.clientOrderId}. Attempting to cancel existing order and retry.`);
                const existingDuplicate = await findOpenGridOrderByClientOrderId(gridOrder.clientOrderId);
                if (existingDuplicate) {
                    console.log(`[GRID][INFO] Duplicate order already active for ${gridOrder.clientOrderId}. Treating as placed.`);
                    return true;
                }

                const cancelled = await cancelOrderByClientOrderId(gridOrder.clientOrderId, db.pair);
                if (cancelled) {
                    try {
                        await exchange.createOrder(
                            spotPair,
                            "limit",
                            gridOrder.side,
                            quantity,
                            gridOrder.price,
                            params
                        );
                        metrics.api.orders++;
                        console.log(`[GRID][INFO] Retry succeeded: placed ${gridOrder.side.toUpperCase()} limit @ ${gridOrder.price}`);
                        return true;
                    } catch (retryError) {
                        console.error(`[GRID][ERROR] Retry failed for ${gridOrder.clientOrderId}: ${describeError(retryError)}`);
                        const retryExistingOrder = await findOpenGridOrderByClientOrderId(gridOrder.clientOrderId);
                        if (retryExistingOrder) {
                            console.log(`[GRID][INFO] Retry duplicate resolved by existing exchange order for ${gridOrder.clientOrderId}.`);
                            return true;
                        }
                        await syncPositionWithExchange();
                        return false;
                    }
                }

                console.warn(`[GRID][WARN] Could not cancel order with clientOrderId ${gridOrder.clientOrderId}. Syncing position state instead.`);
                await syncPositionWithExchange();
                return false;
            }

            console.error(`[GRID][ERROR] Failed to place ${gridOrder.side.toUpperCase()} limit @ ${gridOrder.price}: ${describeError(error)}`);
            return false;
        }
    };

    const placeReduceOnlyTakeProfitOrder = async (position) => {
        const exchange = getExchange();
        const metrics = getMetrics();
        const db = getDb();
        const spotPair = getSpotPair(db.pair);
        if (!Number.isFinite(position?.targetPrice) || position.targetPrice <= 0) return null;
        if (!Number.isFinite(position?.quantity) || position.quantity <= 0) return null;
        const closeSide = position.side === "buy" ? "sell" : "buy";
        const quantity = formatAmountToMarketPrecision(db.pair, position.quantity);
        const marketInfo = exchange.markets[spotPair] || exchange.markets[db.pair];
        const sizeValidation = validateOrderSize(marketInfo, quantity, position.targetPrice, { orderType: "LIMIT" });
        if (!sizeValidation.valid) {
            console.warn(`[TP][WARN] Skipping TP placement: ${sizeValidation.reason}`);
            return null;
        }
        if (sizeValidation.warning) console.warn(`[TP][WARN] ${sizeValidation.warning}`);

        const params = buildExchangeOrderParams({
            side: closeSide
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
            console.log(`[TP][INFO] Existing exchange order already active for ${clientOrderId}. Reusing it.`);
            return existingOrder;
        }

        try {
            const order = await exchange.createOrder(
                spotPair,
                "limit",
                closeSide,
                quantity,
                position.targetPrice,
                params
            );
            metrics.api.orders++;
            console.log(`[TP][INFO] Placed reduce-only TP ${closeSide.toUpperCase()} @ ${position.targetPrice} for qty ${quantity}`);
            return attachClientOrderIdFallback(order, clientOrderId);
        } catch (error) {
            if (isDuplicateClientOrderIdError(error)) {
                console.warn(`[TP][WARN] Duplicate clientOrderId ${clientOrderId}. Attempting to cancel existing order and retry.`);
                const duplicateOrder = await findOpenOrderByClientOrderId(clientOrderId, db.pair);
                if (duplicateOrder) {
                    console.log(`[TP][INFO] Duplicate resolved by existing exchange TP ${clientOrderId}.`);
                    return attachClientOrderIdFallback(duplicateOrder, clientOrderId);
                }
                const cancelled = await cancelOrderByClientOrderId(clientOrderId, db.pair);
                if (cancelled) {
                    try {
                        const retryOrder = await exchange.createOrder(
                            spotPair,
                            "limit",
                            closeSide,
                            quantity,
                            position.targetPrice,
                            params
                        );
                        metrics.api.orders++;
                        console.log(`[TP][INFO] Retry succeeded: placed reduce-only TP ${closeSide.toUpperCase()} @ ${position.targetPrice} for qty ${quantity}`);
                        return attachClientOrderIdFallback(retryOrder, clientOrderId);
                    } catch (retryError) {
                        console.error(`[TP][ERROR] Retry failed for ${clientOrderId}: ${describeError(retryError)}`);
                        await syncPositionWithExchange();
                        return null;
                    }
                }

                const replacementClientOrderId = buildReplacementClientOrderId(clientOrderId);
                console.warn(`[TP][WARN] Existing clientOrderId ${clientOrderId} is unusable. Retrying with replacement ${replacementClientOrderId}.`);
                try {
                    const retryOrder = await exchange.createOrder(
                        spotPair,
                        "limit",
                        closeSide,
                        quantity,
                        position.targetPrice,
                        { ...params, newClientOrderId: replacementClientOrderId }
                    );
                    metrics.api.orders++;
                    console.log(`[TP][INFO] Replacement succeeded with clientOrderId ${replacementClientOrderId}.`);
                    return attachClientOrderIdFallback(retryOrder, replacementClientOrderId);
                } catch (replacementError) {
                    console.error(`[TP][ERROR] Replacement retry failed for ${replacementClientOrderId}: ${describeError(replacementError)}`);
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
        const spotPair = getSpotPair(db.pair);
        if (!Number.isFinite(position?.stopLossPrice) || position.stopLossPrice <= 0) return null;
        if (!Number.isFinite(position?.quantity) || position.quantity <= 0) return null;
        const closeSide = position.side === "buy" ? "sell" : "buy";
        const quantity = formatAmountToMarketPrecision(db.pair, position.quantity);
        const marketInfo = exchange.markets[spotPair] || exchange.markets[db.pair];
        const sizeValidation = validateOrderSize(marketInfo, quantity, position.stopLossPrice, { orderType: "STOP_LOSS_LIMIT" });
        if (!sizeValidation.valid) {
            console.warn(`[SL][WARN] Skipping SL placement: ${sizeValidation.reason}`);
            return null;
        }
        if (sizeValidation.warning) console.warn(`[SL][WARN] ${sizeValidation.warning}`);

        const params = buildExchangeOrderParams({ side: closeSide });
        const clientOrderId = position?.slClientOrderId || getSlClientOrderId(position);
        params.newClientOrderId = clientOrderId;
        params.stopPrice = formatPriceToMarketPrecision(db.pair, position.stopLossPrice);
        const limitPrice = formatPriceToMarketPrecision(db.pair, position.side === "buy" ? position.stopLossPrice * 0.999 : position.stopLossPrice * 1.001);

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
            console.log(`[SL][INFO] Existing exchange order already active for ${clientOrderId}. Reusing it.`);
            return existingOrder;
        }

        try {
            const order = await exchange.createOrder(
                spotPair,
                "STOP_LOSS_LIMIT",
                closeSide,
                quantity,
                limitPrice,
                params
            );
            metrics.api.orders++;
            console.log(`[SL][INFO] Placed STOP_LOSS_LIMIT ${closeSide.toUpperCase()} @ stop ${params.stopPrice} limit ${limitPrice} qty ${quantity}`);
            return attachClientOrderIdFallback(order, clientOrderId);
        } catch (error) {
            if (isDuplicateClientOrderIdError(error)) {
                console.warn(`[SL][WARN] Duplicate clientOrderId ${clientOrderId}. Attempting to cancel existing order and retry.`);
                const duplicateOrder = await findOpenOrderByClientOrderId(clientOrderId, db.pair);
                if (duplicateOrder) {
                    console.log(`[SL][INFO] Duplicate resolved by existing exchange SL ${clientOrderId}.`);
                    return attachClientOrderIdFallback(duplicateOrder, clientOrderId);
                }
                const cancelled = await cancelOrderByClientOrderId(clientOrderId, db.pair);
                if (cancelled) {
                    try {
                        const retryOrder = await exchange.createOrder(
                            spotPair,
                            "STOP_LOSS_LIMIT",
                            closeSide,
                            quantity,
                            limitPrice,
                            params
                        );
                        metrics.api.orders++;
                        console.log(`[SL][INFO] Retry succeeded: placed STOP_LOSS_LIMIT ${closeSide.toUpperCase()} @ stop ${params.stopPrice} limit ${limitPrice}`);
                        return attachClientOrderIdFallback(retryOrder, clientOrderId);
                    } catch (retryError) {
                        console.error(`[SL][ERROR] Retry failed for ${clientOrderId}: ${describeError(retryError)}`);
                        await syncPositionWithExchange();
                        return null;
                    }
                }

                const replacementClientOrderId = buildReplacementClientOrderId(clientOrderId);
                console.warn(`[SL][WARN] Existing clientOrderId ${clientOrderId} is unusable. Retrying with replacement ${replacementClientOrderId}.`);
                try {
                    const retryOrder = await exchange.createOrder(
                        spotPair,
                        "STOP_LOSS_LIMIT",
                        closeSide,
                        quantity,
                        limitPrice,
                        { ...params, newClientOrderId: replacementClientOrderId }
                    );
                    metrics.api.orders++;
                    console.log(`[SL][INFO] Replacement succeeded with clientOrderId ${replacementClientOrderId}.`);
                    return attachClientOrderIdFallback(retryOrder, replacementClientOrderId);
                } catch (replacementError) {
                    console.error(`[SL][ERROR] Replacement retry failed for ${replacementClientOrderId}: ${describeError(replacementError)}`);
                    await syncPositionWithExchange();
                    return null;
                }
            }
            throw error;
        }
    };

    const placeOcoExitOrder = async (position) => {
        const exchange = getExchange();
        const metrics = getMetrics();
        const db = getDb();
        const spotPair = getSpotPair(db.pair);
        if (!Number.isFinite(position?.targetPrice) || position.targetPrice <= 0) return null;
        if (!Number.isFinite(position?.stopLossPrice) || position.stopLossPrice <= 0) return null;
        if (!Number.isFinite(position?.quantity) || position.quantity <= 0) return null;

        const closeSide = position.side === "buy" ? "sell" : "buy";
        const quantity = formatAmountToMarketPrecision(db.pair, position.quantity);
        const targetPrice = formatPriceToMarketPrecision(db.pair, position.targetPrice);
        const stopPrice = formatPriceToMarketPrecision(db.pair, position.stopLossPrice);
        const stopLimitPrice = formatPriceToMarketPrecision(db.pair, position.side === "buy" ? position.stopLossPrice * 0.999 : position.stopLossPrice * 1.001);
        const marketInfo = exchange.markets[spotPair] || exchange.markets[db.pair];
        const tpValidation = validateOrderSize(marketInfo, quantity, targetPrice, { orderType: "LIMIT" });
        const slValidation = validateOrderSize(marketInfo, quantity, stopPrice, { orderType: "STOP_LOSS_LIMIT" });
        if (!tpValidation.valid) {
            console.warn(`[OCO][WARN] Skipping OCO placement: TP ${tpValidation.reason}`);
            return null;
        }
        if (!slValidation.valid) {
            console.warn(`[OCO][WARN] Skipping OCO placement: SL ${slValidation.reason}`);
            return null;
        }
        if (tpValidation.warning) console.warn(`[OCO][WARN] TP ${tpValidation.warning}`);
        if (slValidation.warning) console.warn(`[OCO][WARN] SL ${slValidation.warning}`);

        const tpClientOrderId = position?.tpClientOrderId || getTpClientOrderId(position);
        const slClientOrderId = position?.slClientOrderId || getSlClientOrderId(position);
        const listClientOrderId = `smartoco_${String(position.positionSide || "SPOT").toLowerCase()}_${String(closeSide).slice(0, 1)}_${String(targetPrice).replace(/[^\d]/g, "")}`.slice(0, 36);

        const existingTpOrder = await findOpenOrderByClientOrderId(tpClientOrderId, db.pair);
        const existingSlOrder = await findOpenOrderByClientOrderId(slClientOrderId, db.pair);
        if (existingTpOrder && existingSlOrder) {
            console.log(`[OCO][INFO] Existing exchange OCO legs already active for ${listClientOrderId}. Reusing them.`);
            return { tpOrder: existingTpOrder, slOrder: existingSlOrder, listClientOrderId };
        }

        try {
            const ocoResponse = await placeBinanceOcoOrder({
                spotPair,
                closeSide,
                quantity,
                targetPrice,
                stopPrice,
                stopLimitPrice,
                listClientOrderId,
                tpClientOrderId,
                slClientOrderId
            });
            metrics.api.orders++;
            console.log(`[OCO][INFO] Placed ${closeSide.toUpperCase()} OCO TP @ ${targetPrice} | SL stop ${stopPrice} limit ${stopLimitPrice} qty ${quantity}`);
            return extractOcoLegs(ocoResponse, spotPair, tpClientOrderId, slClientOrderId);
        } catch (error) {
            if (isDuplicateClientOrderIdError(error)) {
                console.warn(`[OCO][WARN] Duplicate OCO clientOrderId detected. Syncing open orders before retry.`);
                const duplicateTpOrder = await findOpenOrderByClientOrderId(tpClientOrderId, db.pair);
                const duplicateSlOrder = await findOpenOrderByClientOrderId(slClientOrderId, db.pair);
                if (duplicateTpOrder && duplicateSlOrder) return { tpOrder: duplicateTpOrder, slOrder: duplicateSlOrder, listClientOrderId };
                await syncPositionWithExchange();
                return null;
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

    const hasMatchingTpOrder = (order, position) => {
        if (!order) return false;
        const orderPrice = toFiniteNumber(order.price, NaN);
        const orderAmount = getOrderQuantity(order);
        return isManagedOrderPriceMatch(position.targetPrice, orderPrice)
            && Math.abs(orderAmount - position.quantity) <= getPositionSyncQtyTolerance();
    };

    const hasMatchingSlOrder = (order, position) => {
        if (!order) return false;
        const orderStopPrice = getOrderTriggerPrice(order);
        const orderAmount = getOrderQuantity(order);
        const closePositionOrder = Boolean(order?.closePosition || order?.info?.closePosition || !Number.isFinite(orderAmount) || orderAmount <= 0);
        if (!isManagedOrderPriceMatch(position.stopLossPrice, orderStopPrice)) return false;
        if (closePositionOrder) return true;
        return Math.abs(orderAmount - position.quantity) <= getPositionSyncQtyTolerance();
    };

    const syncOcoExitOrder = async (positionKey, sourcePosition) => {
        return await runManagedOrderSync(`OCO:${positionKey}`, async () => {
            const position = { ...sourcePosition };
            if (!position || !Number.isFinite(position.targetPrice) || position.targetPrice <= 0) return;
            if (!Number.isFinite(position.stopLossPrice) || position.stopLossPrice <= 0) return;

            const matchingTpOrders = (await fetchOpenTpOrders()).filter((order) => matchesOrderToTrackedPosition(order, position));
            const matchingSlOrders = (await fetchOpenSlOrders()).filter((order) => matchesOrderToTrackedPosition(order, position));
            const matchingTpOrder = matchingTpOrders.find((order) => hasMatchingTpOrder(order, position)) || null;
            const matchingSlOrder = matchingSlOrders.find((order) => hasMatchingSlOrder(order, position)) || null;

            if (matchingTpOrder && matchingSlOrder) {
                const duplicateTpOrders = matchingTpOrders.filter((order) => order !== matchingTpOrder);
                const duplicateSlOrders = matchingSlOrders.filter((order) => order !== matchingSlOrder);
                if (duplicateTpOrders.length > 0) await cancelTpOrders(duplicateTpOrders, "OCO_TP_DUPLICATE");
                if (duplicateSlOrders.length > 0) await cancelSlOrders(duplicateSlOrders, "OCO_SL_DUPLICATE");

                const nextTpClientOrderId = getExchangeClientOrderId(matchingTpOrder) || position.tpClientOrderId || getTpClientOrderId(position);
                const nextSlClientOrderId = getExchangeClientOrderId(matchingSlOrder) || position.slClientOrderId || getSlClientOrderId(position);
                const nextTpOrderId = matchingTpOrder.id || position.tpOrderId || null;
                const nextSlOrderId = matchingSlOrder.id || position.slOrderId || null;
                const nextTargetPrice = toFiniteNumber(matchingTpOrder.price, position.targetPrice);
                const nextStopLossPrice = getOrderTriggerPrice(matchingSlOrder);

                if (
                    position.tpOrderId !== nextTpOrderId ||
                    position.tpClientOrderId !== nextTpClientOrderId ||
                    position.slOrderId !== nextSlOrderId ||
                    position.slClientOrderId !== nextSlClientOrderId ||
                    position.targetPrice !== nextTargetPrice ||
                    position.stopLossPrice !== nextStopLossPrice
                ) {
                    console.log(`[OCO] Synced existing OCO exit for ${positionKey} TP @ ${nextTargetPrice} | SL @ ${nextStopLossPrice}`);
                    position.tpOrderId = nextTpOrderId;
                    position.tpClientOrderId = nextTpClientOrderId;
                    position.slOrderId = nextSlOrderId;
                    position.slClientOrderId = nextSlClientOrderId;
                    position.targetPrice = nextTargetPrice;
                    position.stopLossPrice = nextStopLossPrice;
                    upsertActivePosition(position);
                    await saveDB();
                }
                return;
            }

            if (matchingTpOrders.length > 0 || matchingSlOrders.length > 0) {
                console.log(`[OCO] Existing exit orders for ${positionKey} no longer match target. Replacing OCO...`);
                if (matchingTpOrders.length > 0) await cancelTpOrders(matchingTpOrders, "OCO_REPLACE");
                if (matchingSlOrders.length > 0) await cancelSlOrders(matchingSlOrders, "OCO_REPLACE");
            } else {
                console.log(`[OCO] No exchange OCO exit found for ${positionKey}. Creating replacement...`);
            }

            const placedOco = await placeOcoExitOrder(position);
            if (!placedOco?.tpOrder || !placedOco?.slOrder) return;
            position.tpOrderId = placedOco.tpOrder.id || null;
            position.tpClientOrderId = getExchangeClientOrderId(placedOco.tpOrder) || getTpClientOrderId(position);
            position.slOrderId = placedOco.slOrder.id || null;
            position.slClientOrderId = getExchangeClientOrderId(placedOco.slOrder) || getSlClientOrderId(position);
            upsertActivePosition(position);
            await saveDB();
            console.log(`[OCO] Attached exchange OCO exit to ${positionKey}`);
        });
    };

    const ensureReduceOnlyTakeProfitOrder = async (positionKey, sourcePosition) => {
        const db = getDb();
        if (String(db?.marginMode || "spot").toLowerCase() === "spot") {
            return syncOcoExitOrder(positionKey, sourcePosition);
        }
        return await runManagedOrderSync(`TP:${positionKey}`, async () => {
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
        });
    };

    const ensureReduceOnlyStopLossOrder = async (positionKey, sourcePosition) => {
        const db = getDb();
        if (String(db?.marginMode || "spot").toLowerCase() === "spot") {
            return syncOcoExitOrder(positionKey, sourcePosition);
        }
        return await runManagedOrderSync(`SL:${positionKey}`, async () => {
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
        });
    };

    return {
        placeGridEntryOrder,
        placeReduceOnlyTakeProfitOrder,
        placeReduceOnlyStopLossOrder,
        placeOcoExitOrder,
        ensureReduceOnlyTakeProfitOrder,
        ensureReduceOnlyStopLossOrder
    };
};

module.exports = { createOrderExecutionHelpers };



















