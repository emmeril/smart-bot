const createManagedOrdersHelpers = ({
    getExchange,
    getMetrics,
    getDb,
    normalizeSymbol,
    getExchangeClientOrderId,
    getOrderTriggerPrice,
    isGridEntryOrder,
    isTpReduceOnlyOrder,
    isSlReduceOnlyOrder,
    isTriggerManagedOrder,
    matchesOrderToTrackedPosition,
    getHasLoggedTriggerOrderFetchFallback,
    setHasLoggedTriggerOrderFetchFallback
}) => {
    const describeError = (error) => String(error?.message || error || "Unknown error");
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

    const isTimestampError = (error) => {
        const code = getExchangeErrorCode(error);
        const message = String(error?.message || error || "");
        return code === -1021 || /timestamp.*outside of the recvWindow|timestamp for this request was/i.test(message);
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
                        console.warn(`[EXCHANGE][WARN] Failed to refresh time difference after timestamp error: ${describeError(refreshError)}`);
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

    const getManagedOrderId = (order) => String(order?.id || order?.orderId || order?.info?.orderId || "");

    const dedupeOrdersByIdentity = (orders) => {
        const seen = new Set();
        const uniqueOrders = [];

        for (const order of orders || []) {
            if (!order || typeof order !== "object") continue;
            const id = String(order.id || order.orderId || order?.info?.orderId || "");
            const clientOrderId = getExchangeClientOrderId(order);
            const identity = id || clientOrderId;
            if (!identity) {
                uniqueOrders.push(order);
                continue;
            }
            if (seen.has(identity)) continue;
            seen.add(identity);
            uniqueOrders.push(order);
        }

        return uniqueOrders;
    };

    const isConditionalOpenOrder = (order) => {
        const orderType = String(order?.type || order?.info?.type || order?.info?.origType || "").toUpperCase();
        if (orderType.includes("STOP") || orderType.includes("TAKE_PROFIT") || orderType.includes("TRAILING")) return true;
        return Number.isFinite(getOrderTriggerPrice(order));
    };

    const fetchOpenOrdersSnapshot = async (symbol) => {
        const exchange = getExchange();
        const metrics = getMetrics();
        metrics.api.orders++;
        const fetchedRegularOrders = await runPrivateApiWithRecovery(
            () => exchange.fetchOpenOrders(symbol),
            "open-order snapshot"
        );
        let fetchedTriggerOrders = [];
        let triggerOrdersFetchFailed = false;

        try {
            metrics.api.orders++;
            fetchedTriggerOrders = await runPrivateApiWithRecovery(
                () => exchange.fetchOpenOrders(symbol, undefined, undefined, { trigger: true }),
                "trigger open-order snapshot"
            );
        } catch (error) {
            triggerOrdersFetchFailed = true;
            if (!getHasLoggedTriggerOrderFetchFallback()) {
                console.warn(`[ORDERS][WARN] Failed to fetch trigger open orders separately. Falling back to unified open-order snapshot. ${describeError(error)}`);
                setHasLoggedTriggerOrderFetchFallback(true);
            }
        }

        const mergedOrders = dedupeOrdersByIdentity([...(fetchedRegularOrders || []), ...(fetchedTriggerOrders || [])]);
        const triggerOrders = mergedOrders.filter(isConditionalOpenOrder);
        const regularOrders = mergedOrders.filter((order) => !isConditionalOpenOrder(order));
        return { regularOrders, triggerOrders, triggerOrdersFetchFailed };
    };

    const fetchOpenGridOrders = async () => {
        const currentDb = getDb();
        const { regularOrders } = await fetchOpenOrdersSnapshot(currentDb.pair);
        return regularOrders.filter((order) => normalizeSymbol(order.symbol) === normalizeSymbol(currentDb.pair) && isGridEntryOrder(order));
    };

    const findOpenGridOrderByClientOrderId = async (clientOrderId) => {
        if (!clientOrderId) return null;
        const openGridOrders = await fetchOpenGridOrders();
        return openGridOrders.find((order) => getExchangeClientOrderId(order) === clientOrderId) || null;
    };

    const fetchOpenTpOrders = async () => {
        const currentDb = getDb();
        const { regularOrders } = await fetchOpenOrdersSnapshot(currentDb.pair);
        return regularOrders.filter((order) => normalizeSymbol(order.symbol) === normalizeSymbol(currentDb.pair) && isTpReduceOnlyOrder(order));
    };

    const fetchOpenSlOrders = async () => {
        const currentDb = getDb();
        const { triggerOrders } = await fetchOpenOrdersSnapshot(currentDb.pair);
        return triggerOrders.filter((order) => normalizeSymbol(order.symbol) === normalizeSymbol(currentDb.pair) && isSlReduceOnlyOrder(order));
    };

    const findOpenOrderByClientOrderId = async (clientOrderId, symbol = getDb()?.pair) => {
        if (!clientOrderId || !symbol) return null;
        const { regularOrders, triggerOrders } = await fetchOpenOrdersSnapshot(symbol);
        const regularMatch = regularOrders.find((order) => getExchangeClientOrderId(order) === clientOrderId);
        if (regularMatch) return regularMatch;
        return triggerOrders.find((order) => getExchangeClientOrderId(order) === clientOrderId) || null;
    };

    const fetchManagedOpenOrdersSnapshot = async () => {
        const currentDb = getDb();
        const { regularOrders, triggerOrders, triggerOrdersFetchFailed } = await fetchOpenOrdersSnapshot(currentDb.pair);
        const managedOrders = [...regularOrders, ...triggerOrders].filter((order) => normalizeSymbol(order.symbol) === normalizeSymbol(currentDb.pair));
        return {
            grid: managedOrders.filter(isGridEntryOrder),
            tp: managedOrders.filter(isTpReduceOnlyOrder),
            sl: managedOrders.filter(isSlReduceOnlyOrder),
            triggerOrdersFetchFailed
        };
    };

    const cancelManagedOrders = async (orders, reason, label, cancelOptions = undefined) => {
        if (!Array.isArray(orders) || orders.length === 0) return;
        const exchange = getExchange();
        const metrics = getMetrics();
        const currentDb = getDb();
        console.log(`[${label}][INFO] Cancelling ${orders.length} ${label.toLowerCase()} order(s) (${reason})...`);
        for (const order of orders) {
            try {
                const orderId = getManagedOrderId(order);
                if (!orderId) {
                    console.warn(`[${label}][WARN] Failed to cancel ${label.toLowerCase()} order without exchange id.`);
                    continue;
                }
                await runPrivateApiWithRecovery(
                    () => exchange.cancelOrder(orderId, currentDb.pair, cancelOptions),
                    `${label.toLowerCase()} order cancellation`
                );
                metrics.api.orders++;
            } catch (error) {
                console.warn(`[${label}][WARN] Failed to cancel ${label.toLowerCase()} order ${order.id}: ${describeError(error)}`);
            }
        }
    };

    const cancelGridOrders = async (orders, reason = "SYNC") => cancelManagedOrders(orders, reason, "GRID");
    const cancelTpOrders = async (orders, reason = "TP_SYNC") => cancelManagedOrders(orders, reason, "TP");
    const cancelSlOrders = async (orders, reason = "SL_SYNC") => cancelManagedOrders(orders, reason, "SL", { trigger: true });

    const cancelManagedOrdersForPosition = async (position, reason = "POSITION_CLEANUP") => {
        if (!position) return;
        const tpOrders = await fetchOpenTpOrders();
        const matchingTpOrders = tpOrders.filter((order) => matchesOrderToTrackedPosition(order, position));
        if (matchingTpOrders.length > 0) await cancelTpOrders(matchingTpOrders, reason);

        const slOrders = await fetchOpenSlOrders();
        const matchingSlOrders = slOrders.filter((order) => matchesOrderToTrackedPosition(order, position));
        if (matchingSlOrders.length > 0) await cancelSlOrders(matchingSlOrders, reason);
    };

    const cancelDuplicateManagedOrders = async (orders, cancelReason, label = "ORDER") => {
        if (!Array.isArray(orders) || orders.length <= 1) return orders || [];

        const seen = new Set();
        const uniqueOrders = [];
        const duplicateOrders = [];
        const exchange = getExchange();
        const metrics = getMetrics();
        const currentDb = getDb();

        for (const order of orders) {
            const clientOrderId = getExchangeClientOrderId(order);
            if (!clientOrderId) {
                uniqueOrders.push(order);
                continue;
            }

            if (seen.has(clientOrderId)) duplicateOrders.push(order);
            else {
                seen.add(clientOrderId);
                uniqueOrders.push(order);
            }
        }

        if (duplicateOrders.length > 0) {
            console.warn(`[${label}][WARN] Found ${duplicateOrders.length} duplicate managed order(s) (${cancelReason}). Cancelling extras...`);
            for (const duplicateOrder of duplicateOrders) {
                try {
                    const cancelParams = isTriggerManagedOrder(duplicateOrder, label) ? { trigger: true } : undefined;
                    const duplicateOrderId = getManagedOrderId(duplicateOrder);
                    if (!duplicateOrderId) {
                        console.warn(`[${label}][WARN] Failed to cancel duplicate ${label.toLowerCase()} order without exchange id.`);
                        continue;
                    }
                    await runPrivateApiWithRecovery(
                        () => exchange.cancelOrder(duplicateOrderId, currentDb.pair, cancelParams),
                        `${label.toLowerCase()} duplicate cancellation`
                    );
                    metrics.api.orders++;
                } catch (error) {
                    console.warn(`[${label}][WARN] Failed to cancel duplicate ${label.toLowerCase()} order ${duplicateOrder.id}: ${describeError(error)}`);
                }
            }
        }

        return uniqueOrders;
    };

    const cancelOrderByClientOrderId = async (clientOrderId, symbol) => {
        const exchange = getExchange();
        const metrics = getMetrics();
        const { regularOrders, triggerOrders } = await fetchOpenOrdersSnapshot(symbol);
        const order = regularOrders.find((item) => getExchangeClientOrderId(item) === clientOrderId);
        if (order) {
            const orderId = getManagedOrderId(order);
            if (!orderId) return false;
            await runPrivateApiWithRecovery(
                () => exchange.cancelOrder(orderId, symbol),
                "client-order cancellation"
            );
            metrics.api.orders++;
            console.log(`[CANCEL][INFO] Cancelled order with clientOrderId ${clientOrderId}`);
            return true;
        }

        const triggerOrder = triggerOrders.find((item) => getExchangeClientOrderId(item) === clientOrderId);
        if (triggerOrder) {
            const triggerOrderId = getManagedOrderId(triggerOrder);
            if (!triggerOrderId) return false;
            await runPrivateApiWithRecovery(
                () => exchange.cancelOrder(triggerOrderId, symbol, { trigger: true }),
                "trigger client-order cancellation"
            );
            metrics.api.orders++;
            console.log(`[CANCEL][INFO] Cancelled trigger order with clientOrderId ${clientOrderId}`);
            return true;
        }

        return false;
    };

    return {
        fetchOpenGridOrders,
        findOpenGridOrderByClientOrderId,
        fetchOpenTpOrders,
        fetchOpenSlOrders,
        findOpenOrderByClientOrderId,
        fetchManagedOpenOrdersSnapshot,
        cancelManagedOrdersForPosition,
        cancelDuplicateManagedOrders,
        fetchOpenOrdersSnapshot,
        cancelManagedOrders,
        cancelGridOrders,
        cancelTpOrders,
        cancelSlOrders,
        cancelOrderByClientOrderId
    };
};

module.exports = { createManagedOrdersHelpers };
