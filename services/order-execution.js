const createOrderExecutionHelpers = ({
    getExchange,
    getMetrics,
    getDb,
    isHedgeModeEnabled,
    toFiniteNumber,
    formatAmountToMarketPrecision,
    formatPriceToMarketPrecision,
    validateOrderSize,
    buildOrderPlan,
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
    getActivePositionByKey,
    upsertActivePosition,
    saveDB,
    cancelTpOrders,
    cancelSlOrders,
    buildReplacementClientOrderId,
    notifyTradeUpdate
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

    const notifyProtectionUpdate = async ({
        position,
        positionKey,
        reason,
        tpPrice,
        slPrice
    }) => {
        if (typeof notifyTradeUpdate !== "function") return;
        const db = getDb();
        await notifyTradeUpdate({
            event: "TP_SL_UPDATED",
            position: {
                ...position,
                symbol: db?.pair || position?.symbol
            },
            entryPrice: position?.entryPrice,
            quantity: position?.quantity,
            reason: `${reason} | key=${positionKey} | TP=${Number.isFinite(tpPrice) ? tpPrice : "N/A"} | SL=${Number.isFinite(slPrice) ? slPrice : "N/A"}`,
            occurredAt: Date.now()
        });
    };

    const isUnknownOrderLookupError = (error) => {
        const message = String(error?.message || error || "").toLowerCase();
        return message.includes("order does not exist")
            || message.includes("unknown order")
            || message.includes("order not found")
            || message.includes("-2013");
    };

    const fetchOrderByClientOrderId = async (clientOrderId, symbol) => {
        const exchange = getExchange();
        if (!exchange || typeof exchange.fetchOrder !== "function" || !clientOrderId || !symbol) return null;

        const lookupAttempts = [
            () => exchange.fetchOrder(undefined, symbol, { origClientOrderId: clientOrderId }),
            () => exchange.fetchOrder(null, symbol, { origClientOrderId: clientOrderId }),
            () => exchange.fetchOrder(undefined, symbol, { clientOrderId })
        ];
        if (/^\d{1,20}$/.test(String(clientOrderId))) {
            lookupAttempts.push(() => exchange.fetchOrder(clientOrderId, symbol));
        }

        for (const lookup of lookupAttempts) {
            try {
                const order = await lookup();
                return attachClientOrderIdFallback(order, clientOrderId);
            } catch (error) {
                if (isUnknownOrderLookupError(error)) continue;
                throw error;
            }
        }

        return null;
    };

    const getOrderStatus = (order) => String(order?.status || order?.info?.status || "").toLowerCase();

    const isFilledOrder = (order) => {
        if (!order || typeof order !== "object") return false;
        const filledQuantity = getOrderQuantity(order);
        const status = getOrderStatus(order);
        return filledQuantity > getPositionSyncQtyTolerance()
            && (status === "closed" || status === "filled" || String(order?.info?.status || "").toUpperCase() === "FILLED");
    };

    const resolveFilledOrderPrice = (order, fallbackPrice, filledQuantity) => {
        const averagePrice = toFiniteNumber(order?.average, 0);
        const directPrice = toFiniteNumber(order?.price, 0);
        const orderCost = toFiniteNumber(order?.cost, 0);
        const infoAveragePrice = toFiniteNumber(order?.info?.avgPrice, 0);
        const infoCummulativeQuoteQty = toFiniteNumber(order?.info?.cummulativeQuoteQty, 0);
        const infoCumQuoteQty = toFiniteNumber(order?.info?.cumQuoteQty, 0);
        if (averagePrice > 0) return averagePrice;
        if (infoAveragePrice > 0) return infoAveragePrice;
        if (filledQuantity > 0 && orderCost > 0) return orderCost / filledQuantity;
        if (filledQuantity > 0 && infoCummulativeQuoteQty > 0) return infoCummulativeQuoteQty / filledQuantity;
        if (filledQuantity > 0 && infoCumQuoteQty > 0) return infoCumQuoteQty / filledQuantity;
        if (directPrice > 0) return directPrice;
        return fallbackPrice;
    };

    const buildSpotGridPositionFromFilledOrder = (gridOrder, filledOrder) => {
        const db = getDb();
        const quantity = getOrderQuantity(filledOrder);
        const entryPrice = resolveFilledOrderPrice(filledOrder, gridOrder.price, quantity);
        const side = String(filledOrder?.side || gridOrder.side || "").toLowerCase();
        const targetPrice = toFiniteNumber(gridOrder.targetPrice, NaN);
        const stopLossPrice = toFiniteNumber(gridOrder.stopLossPrice, NaN);
        const targetProfitUSDT = Number.isFinite(targetPrice) && Number.isFinite(entryPrice)
            ? Math.abs(targetPrice - entryPrice) * quantity
            : toFiniteNumber(db.gridTargetProfitUsdt, 0);
        const stopLossUSDT = Number.isFinite(stopLossPrice) && Number.isFinite(entryPrice)
            ? -Math.abs(stopLossPrice - entryPrice) * quantity
            : -Math.abs((quantity * entryPrice) * (Math.max(0, toFiniteNumber(db.gridStopLossPercent, 0)) / 100));

        return {
            side,
            entryPrice,
            targetPrice,
            stopLossPrice,
            stopLossUSDT,
            orderId: filledOrder?.id || filledOrder?.orderId || filledOrder?.info?.orderId || getExchangeClientOrderId(filledOrder),
            quantity,
            entryTime: toFiniteNumber(filledOrder?.timestamp, Date.now()),
            highestSinceEntry: entryPrice,
            lowestSinceEntry: entryPrice,
            settlementMode: "spot",
            positionSide: getOrderPositionSide(side),
            targetProfitUSDT,
            trailingEnabled: Boolean(db.trailingEnabled),
            atrAtEntry: NaN,
            strategy: "SPOT_GRID",
            trailingActivateATR: toFiniteNumber(db.trailingActivateATR, 1.2),
            trailingOffsetATR: toFiniteNumber(db.trailingOffsetATR, 0.6),
            tpOrderId: null,
            tpClientOrderId: null,
            slOrderId: null,
            slClientOrderId: null
        };
    };

    const mergeSpotGridPosition = (currentPosition, filledPosition) => {
        const db = getDb();
        if (!currentPosition || typeof currentPosition !== "object") return { ...filledPosition };

        const currentQty = Math.max(0, toFiniteNumber(currentPosition.quantity, 0));
        const filledQty = Math.max(0, toFiniteNumber(filledPosition.quantity, 0));
        const currentEntry = toFiniteNumber(currentPosition.entryPrice, NaN);
        const filledEntry = toFiniteNumber(filledPosition.entryPrice, NaN);
        const mergedQty = currentQty + filledQty;
        const mergedEntryPrice = mergedQty > 0
            ? (((Number.isFinite(currentEntry) ? currentEntry : 0) * currentQty) + ((Number.isFinite(filledEntry) ? filledEntry : 0) * filledQty)) / mergedQty
            : filledEntry;

        let mergedTargetPrice = Number.isFinite(toFiniteNumber(currentPosition.targetPrice, NaN))
            ? toFiniteNumber(currentPosition.targetPrice, NaN)
            : toFiniteNumber(filledPosition.targetPrice, NaN);
        let mergedStopLossPrice = Number.isFinite(toFiniteNumber(currentPosition.stopLossPrice, NaN))
            ? toFiniteNumber(currentPosition.stopLossPrice, NaN)
            : toFiniteNumber(filledPosition.stopLossPrice, NaN);

        if (db.gridRecalculateExitsOnScaleIn !== false && typeof buildOrderPlan === "function") {
            const recalculatedPlan = buildOrderPlan(
                filledPosition.side || currentPosition.side,
                mergedEntryPrice,
                mergedQty,
                toFiniteNumber(currentPosition.atrAtEntry, NaN),
                {
                    trailingActivateATR: toFiniteNumber(currentPosition.trailingActivateATR, db.trailingActivateATR),
                    trailingOffsetATR: toFiniteNumber(currentPosition.trailingOffsetATR, db.trailingOffsetATR)
                },
                {}
            );
            if (Number.isFinite(recalculatedPlan?.targetPrice) && Number.isFinite(recalculatedPlan?.stopLossPrice)) {
                mergedTargetPrice = recalculatedPlan.targetPrice;
                mergedStopLossPrice = recalculatedPlan.stopLossPrice;
            }
        }

        const targetProfitUSDT = Number.isFinite(mergedTargetPrice) && Number.isFinite(mergedEntryPrice)
            ? Math.abs(mergedTargetPrice - mergedEntryPrice) * mergedQty
            : toFiniteNumber(currentPosition.targetProfitUSDT, toFiniteNumber(db.gridTargetProfitUsdt, 0));
        const stopLossUSDT = Number.isFinite(mergedStopLossPrice) && Number.isFinite(mergedEntryPrice)
            ? -Math.abs(mergedStopLossPrice - mergedEntryPrice) * mergedQty
            : toFiniteNumber(currentPosition.stopLossUSDT, -Math.abs((mergedQty * mergedEntryPrice) * (Math.max(0, toFiniteNumber(db.gridStopLossPercent, 0)) / 100)));

        return {
            ...currentPosition,
            side: filledPosition.side || currentPosition.side,
            entryPrice: mergedEntryPrice,
            quantity: mergedQty,
            targetPrice: mergedTargetPrice,
            stopLossPrice: mergedStopLossPrice,
            targetProfitUSDT,
            stopLossUSDT,
            orderId: filledPosition.orderId || currentPosition.orderId || null,
            entryTime: Math.min(
                toFiniteNumber(currentPosition.entryTime, Date.now()),
                toFiniteNumber(filledPosition.entryTime, Date.now())
            ),
            highestSinceEntry: Math.max(
                toFiniteNumber(currentPosition.highestSinceEntry, mergedEntryPrice),
                toFiniteNumber(filledPosition.entryPrice, mergedEntryPrice)
            ),
            lowestSinceEntry: Math.min(
                toFiniteNumber(currentPosition.lowestSinceEntry, mergedEntryPrice),
                toFiniteNumber(filledPosition.entryPrice, mergedEntryPrice)
            ),
            tpOrderId: currentPosition.tpOrderId || null,
            tpClientOrderId: currentPosition.tpClientOrderId || null,
            slOrderId: currentPosition.slOrderId || null,
            slClientOrderId: currentPosition.slClientOrderId || null
        };
    };

    const hasAdoptedGridClientOrderId = (position, clientOrderId) => {
        if (!position || !clientOrderId) return false;
        const adoptedIds = Array.isArray(position.adoptedGridClientOrderIds)
            ? position.adoptedGridClientOrderIds
            : [];
        return adoptedIds.includes(clientOrderId);
    };

    const recordAdoptedGridClientOrderId = (position, clientOrderId) => {
        const adoptedIds = Array.isArray(position?.adoptedGridClientOrderIds)
            ? position.adoptedGridClientOrderIds
            : [];
        const nextIds = [...adoptedIds, clientOrderId].filter(Boolean);
        // Keep tail only so persisted state remains compact.
        return nextIds.slice(-100);
    };

    const adoptFilledGridEntryOrder = async (gridOrder) => {
        const db = getDb();
        const positionKey = getOrderPositionSide(gridOrder?.side);
        const gridClientOrderId = String(gridOrder?.clientOrderId || "");
        if (!gridClientOrderId) return false;

        const currentPosition = typeof getActivePositionByKey === "function"
            ? getActivePositionByKey(positionKey)
            : null;
        if (hasAdoptedGridClientOrderId(currentPosition, gridClientOrderId)) {
            return true;
        }

        let filledOrder = null;
        try {
            filledOrder = await fetchOrderByClientOrderId(gridClientOrderId, getSpotPair(db.pair));
        } catch (error) {
            console.warn(`[GRID][WARN] Failed to inspect historical grid order ${gridClientOrderId}: ${describeError(error)}`);
            return false;
        }

        if (!isFilledOrder(filledOrder)) return false;

        const filledPosition = buildSpotGridPositionFromFilledOrder(gridOrder, filledOrder);
        if (!filledPosition.side || !Number.isFinite(filledPosition.entryPrice) || filledPosition.entryPrice <= 0 || !Number.isFinite(filledPosition.quantity) || filledPosition.quantity <= 0) {
            console.warn(`[GRID][WARN] Filled grid order ${gridClientOrderId} could not be converted to a valid active position.`);
            return false;
        }

        if (filledPosition.side === "buy" && typeof fetchSpotBalances === "function") {
            const balances = await fetchSpotBalances();
            const [baseAssetRaw = ""] = String(db.pair || "").split("/");
            const baseAsset = baseAssetRaw.trim();
            const baseFree = Number(balances?.[baseAsset]?.free ?? balances?.[baseAsset] ?? NaN);
            const requiredQty = Math.max(0, toFiniteNumber(filledPosition.quantity, 0));
            const adoptionTolerance = getPositionSyncQtyTolerance();
            if (Number.isFinite(baseFree) && baseFree + adoptionTolerance < requiredQty) {
                return false;
            }
        }

        const position = mergeSpotGridPosition(currentPosition, filledPosition);
        position.adoptedGridClientOrderIds = recordAdoptedGridClientOrderId(position, gridClientOrderId);
        if (currentPosition) {
            const previousQty = toFiniteNumber(currentPosition.quantity, 0);
            const previousEntry = toFiniteNumber(currentPosition.entryPrice, NaN);
            const nextQty = toFiniteNumber(position.quantity, 0);
            const nextEntry = toFiniteNumber(position.entryPrice, NaN);
            const filledQty = toFiniteNumber(filledPosition.quantity, 0);
            const filledEntry = toFiniteNumber(filledPosition.entryPrice, NaN);
            console.log(
                `[GRID][AUDIT] ${positionKey} scaled-in via ${gridOrder.clientOrderId} | `
                + `qty ${previousQty} + ${filledQty} => ${nextQty} | `
                + `entry ${Number.isFinite(previousEntry) ? previousEntry : "N/A"} + ${Number.isFinite(filledEntry) ? filledEntry : "N/A"} => ${Number.isFinite(nextEntry) ? nextEntry : "N/A"}`
            );
        }

        upsertActivePosition(position);
        await saveDB();
        await ensureReduceOnlyTakeProfitOrder(positionKey, position);
        await ensureReduceOnlyStopLossOrder(positionKey, position);
        console.log(`[GRID][INFO] Adopted filled ${position.side.toUpperCase()} grid order ${gridClientOrderId} into active spot position @ ${position.entryPrice} qty ${position.quantity}`);
        return true;
    };

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

        if (await adoptFilledGridEntryOrder(gridOrder)) return true;

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
        let quantity = formatAmountToMarketPrecision(db.pair, position.quantity);
        const targetPrice = formatPriceToMarketPrecision(db.pair, position.targetPrice);
        const stopPrice = formatPriceToMarketPrecision(db.pair, position.stopLossPrice);
        const stopLimitPrice = formatPriceToMarketPrecision(db.pair, position.side === "buy" ? position.stopLossPrice * 0.999 : position.stopLossPrice * 1.001);
        const marketInfo = exchange.markets[spotPair] || exchange.markets[db.pair];

        if (closeSide === "sell" && typeof fetchSpotBalances === "function") {
            const balances = await fetchSpotBalances();
            const [baseAssetRaw = ""] = String(db.pair || "").split("/");
            const baseAsset = baseAssetRaw.trim();
            const baseFreeRaw = Number(balances?.[baseAsset]?.free ?? balances?.[baseAsset] ?? NaN);
            if (Number.isFinite(baseFreeRaw) && baseFreeRaw > 0 && quantity > baseFreeRaw) {
                const safeBaseFree = Math.max(0, baseFreeRaw * 0.999);
                const clampedQty = formatAmountToMarketPrecision(db.pair, safeBaseFree);
                if (Number.isFinite(clampedQty) && clampedQty > 0) {
                    console.warn(`[OCO][WARN] Spot balance clamp applied for ${baseAsset}: requested qty ${quantity} > free ${baseFreeRaw}. Using qty ${clampedQty}.`);
                    quantity = clampedQty;
                    position.quantity = clampedQty;
                }
            }
        }

        const tpValidation = validateOrderSize(marketInfo, quantity, targetPrice, { orderType: "LIMIT" });
        const slValidation = validateOrderSize(marketInfo, quantity, stopPrice, { orderType: "STOP_LOSS_LIMIT" });
        if (!tpValidation.valid) {
            console.warn(`[OCO][WARN] Skipping OCO placement: TP ${tpValidation.reason}`);
            return { blocked: true, reason: `TP ${tpValidation.reason}` };
        }
        if (!slValidation.valid) {
            console.warn(`[OCO][WARN] Skipping OCO placement: SL ${slValidation.reason}`);
            return { blocked: true, reason: `SL ${slValidation.reason}` };
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
                await notifyProtectionUpdate({
                    position,
                    positionKey,
                    reason: `${label}_SYNCED`,
                    tpPrice: toFiniteNumber(position.targetPrice, NaN),
                    slPrice: toFiniteNumber(position.stopLossPrice, NaN)
                });
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
            await notifyProtectionUpdate({
                position,
                positionKey,
                reason: `${label}_ADOPTED`,
                tpPrice: toFiniteNumber(position.targetPrice, NaN),
                slPrice: toFiniteNumber(position.stopLossPrice, NaN)
            });
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
        await notifyProtectionUpdate({
            position,
            positionKey,
            reason: `${label}_REPLACED`,
            tpPrice: toFiniteNumber(position.targetPrice, NaN),
            slPrice: toFiniteNumber(position.stopLossPrice, NaN)
        });
    };

    const hasMatchingTpOrder = (order, position) => {
        if (!order) return false;
        const orderPrice = toFiniteNumber(order.price, NaN);
        const orderAmount = getOrderQuantity(order);
        return isManagedOrderPriceMatch(position.targetPrice, orderPrice)
            && Math.abs(orderAmount - position.quantity) <= getPositionSyncQtyTolerance();
    };

    const isClosePositionManagedOrder = (order, orderAmount) => (
        Boolean(order?.closePosition || order?.info?.closePosition || !Number.isFinite(orderAmount) || orderAmount <= 0)
    );

    const hasMatchingSlOrder = (order, position) => {
        if (!order) return false;
        const orderStopPrice = getOrderTriggerPrice(order);
        const orderAmount = getOrderQuantity(order);
        const closePositionOrder = isClosePositionManagedOrder(order, orderAmount);
        if (!isManagedOrderPriceMatch(position.stopLossPrice, orderStopPrice)) return false;
        if (closePositionOrder) return true;
        return Math.abs(orderAmount - position.quantity) <= getPositionSyncQtyTolerance();
    };

    const isSpotMarginMode = () => String(getDb()?.marginMode || "spot").toLowerCase() === "spot";

    const syncOcoExitOrder = async (positionKey, sourcePosition) => {
        return await runManagedOrderSync(`OCO:${positionKey}`, async () => {
            const position = { ...sourcePosition };
            if (!position || !Number.isFinite(position.targetPrice) || position.targetPrice <= 0) return;
            if (!Number.isFinite(position.stopLossPrice) || position.stopLossPrice <= 0) return;
            const protectionFingerprint = [
                formatAmountToMarketPrecision(getDb().pair, Number(position.quantity || 0)),
                formatPriceToMarketPrecision(getDb().pair, Number(position.targetPrice || 0)),
                formatPriceToMarketPrecision(getDb().pair, Number(position.stopLossPrice || 0))
            ].join("|");

            if (position.ocoBlockedReason && position.ocoBlockedFingerprint === protectionFingerprint) {
                return;
            }

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
                    await notifyProtectionUpdate({
                        position,
                        positionKey,
                        reason: "OCO_SYNCED",
                        tpPrice: toFiniteNumber(position.targetPrice, NaN),
                        slPrice: toFiniteNumber(position.stopLossPrice, NaN)
                    });
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
            if (placedOco?.blocked) {
                const nextReason = String(placedOco.reason || "OCO placement blocked by exchange constraints.");
                if (position.ocoBlockedReason !== nextReason || position.ocoBlockedFingerprint !== protectionFingerprint) {
                    console.warn(`[OCO][WARN] OCO replacement paused for ${positionKey}: ${nextReason}`);
                    position.ocoBlockedReason = nextReason;
                    position.ocoBlockedFingerprint = protectionFingerprint;
                    upsertActivePosition(position);
                    await saveDB();
                }
                return;
            }
            if (!placedOco?.tpOrder || !placedOco?.slOrder) return;
            position.tpOrderId = placedOco.tpOrder.id || null;
            position.tpClientOrderId = getExchangeClientOrderId(placedOco.tpOrder) || getTpClientOrderId(position);
            position.slOrderId = placedOco.slOrder.id || null;
            position.slClientOrderId = getExchangeClientOrderId(placedOco.slOrder) || getSlClientOrderId(position);
            position.ocoBlockedReason = null;
            position.ocoBlockedFingerprint = null;
            upsertActivePosition(position);
            await saveDB();
            console.log(`[OCO] Attached exchange OCO exit to ${positionKey}`);
            await notifyProtectionUpdate({
                position,
                positionKey,
                reason: "OCO_REPLACED",
                tpPrice: toFiniteNumber(position.targetPrice, NaN),
                slPrice: toFiniteNumber(position.stopLossPrice, NaN)
            });
        });
    };

    const ensureReduceOnlyTakeProfitOrder = async (positionKey, sourcePosition) => {
        if (isSpotMarginMode()) {
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
        if (isSpotMarginMode()) {
            return syncOcoExitOrder(positionKey, sourcePosition);
        }
        return await runManagedOrderSync(`SL:${positionKey}`, async () => {
            const position = { ...sourcePosition };
            if (!position || !Number.isFinite(position.stopLossPrice) || position.stopLossPrice <= 0) return;
            const matchingSlOrders = (await fetchOpenSlOrders()).filter((order) => matchesOrderToTrackedPosition(order, position));
            const adoptableOrder = matchingSlOrders.find((order) => {
                const orderAmount = getOrderQuantity(order);
                const closePositionOrder = isClosePositionManagedOrder(order, orderAmount);
                if (closePositionOrder) return true;
                return Math.abs(orderAmount - position.quantity) <= getPositionSyncQtyTolerance();
            }) || null;
            const matchingOrder = matchingSlOrders.find((order) => {
                const orderStopPrice = getOrderTriggerPrice(order);
                const orderAmount = getOrderQuantity(order);
                const closePositionOrder = isClosePositionManagedOrder(order, orderAmount);
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






