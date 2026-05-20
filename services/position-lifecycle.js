const createPositionLifecycleHelpers = ({
    getDb,
    getExchange,
    getMetrics,
    toFiniteNumber,
    getClosingPositionKeys,
    getIsClosingPosition,
    setIsClosingPosition,
    toPositionMapKey,
    hasAnyActivePosition,
    getActivePositionEntries,
    getActivePositionByKey,
    cancelManagedOrdersForPosition,
    removeActivePositionByKey,
    saveDB,
    applyDailyPnlDelta,
    logTrade,
    getTrackedPositionSideLabel,
    getPrice,
    calculatePositionPnL,
    fetchOpenGridOrders,
    fetchOpenTpOrders,
    fetchOpenSlOrders,
    matchesOrderToTrackedPosition,
    cancelGridOrders,
    cancelTpOrders,
    cancelSlOrders,
    buildExchangeOrderParams,
    getOrderFillSnapshot,
    notifyPositionClosed,
    notifyTradeUpdate
}) => {
    const getOrderFeeCost = (order) => {
        const feeCost = toFiniteNumber(order?.fee?.cost, NaN);
        if (Number.isFinite(feeCost)) return Math.abs(feeCost);
        const infoCommission = toFiniteNumber(order?.info?.commission, NaN);
        if (Number.isFinite(infoCommission)) return Math.abs(infoCommission);
        return 0;
    };

    const getOrderRealizedPnl = (order) => toFiniteNumber(
        order?.realizedPnl,
        toFiniteNumber(
            order?.info?.realizedPnl,
            toFiniteNumber(order?.info?.realizedProfit, NaN)
        )
    );

    const getLifecyclePositionKey = (positionKey = null, position = null) => (
        toPositionMapKey(positionKey || position?.positionSide || getTrackedPositionSideLabel(position))
    );

    const getLifecycleIdentity = (position) => JSON.stringify([
        String(position?.positionSide || getTrackedPositionSideLabel(position) || ""),
        String(position?.side || ""),
        Number.isFinite(Number(position?.entryTime)) ? Number(position.entryTime) : null,
        String(position?.orderId || ""),
        Number.isFinite(Number(position?.entryPrice)) ? Number(position.entryPrice) : null,
        Number.isFinite(Number(position?.quantity)) ? Number(position.quantity) : null
    ]);

    const isSameLifecyclePosition = (leftPosition, rightPosition) => (
        getLifecycleIdentity(leftPosition) === getLifecycleIdentity(rightPosition)
    );

    const canMutateTrackedPosition = (position, positionKey = null) => {
        const trackedKey = getLifecyclePositionKey(positionKey, position);
        const currentTrackedPosition = getActivePositionByKey(trackedKey);
        if (!currentTrackedPosition) return false;
        return isSameLifecyclePosition(currentTrackedPosition, position);
    };

    const shouldCancelGridOrdersForPositionCleanup = () => true;
    const getAccumulatedPnlForNotification = (state) => (
        toFiniteNumber(state?.dailyPnL, 0) + toFiniteNumber(state?.estimatedPnL, 0)
    );

    const clearMissingPositionState = async (position, reason, positionKey = null) => {
        const db = getDb();
        const metrics = getMetrics();
        const trackedKey = getLifecyclePositionKey(positionKey, position);
        if (!canMutateTrackedPosition(position, trackedKey)) {
            console.log(`[POSITION][INFO] Skipping stale missing-position cleanup for ${trackedKey}.`);
            return false;
        }
        if (shouldCancelGridOrdersForPositionCleanup()) {
            const openGridOrders = await fetchOpenGridOrders();
            if (openGridOrders.length > 0) await cancelGridOrders(openGridOrders, reason);
        }
        await cancelManagedOrdersForPosition(position, reason);
        if (!canMutateTrackedPosition(position, trackedKey)) {
            console.log(`[POSITION][INFO] Missing-position cleanup for ${trackedKey} became stale before local removal. Skipping.`);
            return false;
        }
        removeActivePositionByKey(trackedKey);
        const estimatedExitPrice = await getPrice(true);
        if (Number.isFinite(estimatedExitPrice) && estimatedExitPrice > 0) {
            const estimatedPnL = calculatePositionPnL(position, estimatedExitPrice);
            if (typeof applyDailyPnlDelta === "function") await applyDailyPnlDelta({
                pnlDelta: estimatedPnL.realizedProfitUSDT,
                tradeDelta: 1,
                source: "estimated"
            });
            else {
                db.estimatedPnL = toFiniteNumber(db.estimatedPnL, 0) + estimatedPnL.realizedProfitUSDT;
                db.estimatedTrades = Math.max(0, Math.trunc(toFiniteNumber(db.estimatedTrades, 0))) + 1;
            }
            metrics.trades.closed++;
            if (estimatedPnL.realizedProfitUSDT > 0) metrics.trades.wins++;
            else if (estimatedPnL.realizedProfitUSDT < 0) metrics.trades.losses++;
            logTrade(
                position.side === "buy" ? "LONG" : "SHORT",
                position.entryPrice,
                estimatedExitPrice,
                `CLOSE_UNCONFIRMED:${reason}`,
                estimatedPnL.realizedProfitUSDT,
                position.strategy || null
            );
            if (typeof notifyPositionClosed === "function") {
                await notifyPositionClosed({
                    position: {
                        ...position,
                        symbol: db.pair
                    },
                    reason,
                    exitPrice: estimatedExitPrice,
                    netProfitUSDT: estimatedPnL.realizedProfitUSDT,
                    profitPercent: estimatedPnL.profitPercent,
                    totalAccumulatedPnlUSDT: getAccumulatedPnlForNotification(db),
                    closedAt: Date.now(),
                    estimatedExitPrice: true,
                    positionKey: trackedKey
                });
            }
            console.warn(`[POSITION][WARN] Removed local position using estimated exit price because no confirmed exchange exit price was available (${reason}).`);
            return true;
        }

        await saveDB();
        logTrade(
            position.side === "buy" ? "LONG" : "SHORT",
            position.entryPrice,
            "",
            `CLOSE_UNCONFIRMED:${reason}`,
            0,
            position.strategy || null
        );
        if (typeof notifyPositionClosed === "function") {
            await notifyPositionClosed({
                position: {
                    ...position,
                    symbol: db.pair
                },
                reason,
                exitPrice: null,
                netProfitUSDT: 0,
                profitPercent: 0,
                totalAccumulatedPnlUSDT: getAccumulatedPnlForNotification(db),
                closedAt: Date.now(),
                estimatedExitPrice: true,
                positionKey: trackedKey
            });
        }
        console.warn(`[POSITION][WARN] Removed local position without realizing P&L because no confirmed exchange exit price was available (${reason}).`);
        return true;
    };

    const finalizeClosedPosition = async (position, netProfitUSDT, profitPercent, reason, exitPrice = null, positionKey = null, exitMeta = {}) => {
        const db = getDb();
        const metrics = getMetrics();
        const trackedKey = getLifecyclePositionKey(positionKey, position);
        if (!canMutateTrackedPosition(position, trackedKey)) {
            console.log(`[POSITION][INFO] Skipping stale finalize-close for ${trackedKey}.`);
            return false;
        }
        if (shouldCancelGridOrdersForPositionCleanup()) {
            const openGridOrders = await fetchOpenGridOrders();
            if (openGridOrders.length > 0) await cancelGridOrders(openGridOrders, "POSITION_CLOSED");
        }
        await cancelManagedOrdersForPosition(position, "POSITION_CLOSED");
        if (!canMutateTrackedPosition(position, trackedKey)) {
            console.log(`[POSITION][INFO] Finalize-close for ${trackedKey} became stale before bookkeeping. Skipping.`);
            return false;
        }
        if (typeof applyDailyPnlDelta === "function") await applyDailyPnlDelta({
            pnlDelta: netProfitUSDT,
            tradeDelta: 1,
            source: "local"
        });
        else {
            db.dailyPnL += netProfitUSDT;
            db.dailyTrades++;
        }

        const resolvedExitPrice = Number.isFinite(exitPrice) && exitPrice > 0 ? exitPrice : await getPrice(true);
        logTrade(
            position.side === "buy" ? "LONG" : "SHORT",
            position.entryPrice,
            resolvedExitPrice,
            `CLOSE:${reason}`,
            netProfitUSDT,
            position.strategy || null
        );

        console.log(`[POSITION][INFO] Closed position: ${reason}`);
        console.log(`   Realized P&L: ${netProfitUSDT.toFixed(4)} USDT (${profitPercent.toFixed(2)}%)`);
        console.log(`   Total Realized P&L (Cumulative): ${db.dailyPnL.toFixed(4)} USDT | Daily trades: ${db.dailyTrades}`);

        removeActivePositionByKey(trackedKey);
        await saveDB();
        metrics.trades.closed++;
        if (netProfitUSDT > 0) metrics.trades.wins++;
        else if (netProfitUSDT < 0) metrics.trades.losses++;

        if (typeof notifyPositionClosed === "function") {
            await notifyPositionClosed({
                position: {
                    ...position,
                    symbol: db.pair
                },
                reason,
                exitPrice: Number.isFinite(exitPrice) ? exitPrice : null,
                netProfitUSDT,
                profitPercent,
                totalAccumulatedPnlUSDT: getAccumulatedPnlForNotification(db),
                closedAt: Number.isFinite(exitMeta.closedAt) ? exitMeta.closedAt : Date.now(),
                order: exitMeta.order || null,
                closeFillSnapshot: exitMeta.closeFillSnapshot || null,
                positionKey: trackedKey
            });
        }
        return true;
    };

    const closePosition = async (positionKey, reason) => {
        const exchange = getExchange();
        const metrics = getMetrics();
        const db = getDb();
        const closingPositionKeys = getClosingPositionKeys();
        const closeLockKey = toPositionMapKey(positionKey);
        if (closingPositionKeys.has(closeLockKey)) return;
        closingPositionKeys.add(closeLockKey);
        try {
            if (!db || !hasAnyActivePosition() || getIsClosingPosition()) return;
            setIsClosingPosition(true);
            const trackedPosition = getActivePositionByKey(closeLockKey);
            if (!trackedPosition) return;
            const position = { ...trackedPosition };
            const runningPnlPrice = await getPrice(true);
            const runningPnlState = Number.isFinite(runningPnlPrice) && runningPnlPrice > 0
                ? calculatePositionPnL(position, runningPnlPrice)
                : null;
            const { side, quantity } = position;
            if (!Number.isFinite(quantity) || quantity <= 0) {
                console.error("[POSITION][ERROR] Invalid position quantity. Removing local active position.");
                if (shouldCancelGridOrdersForPositionCleanup()) {
                    const openGridOrders = await fetchOpenGridOrders();
                    if (openGridOrders.length > 0) await cancelGridOrders(openGridOrders, "INVALID_POSITION_QTY");
                }
                await cancelManagedOrdersForPosition(position, "INVALID_POSITION_QTY");
                removeActivePositionByKey(closeLockKey);
                await saveDB();
                return;
            }

            const closeSide = side === "buy" ? "sell" : "buy";
            const closeSymbol = String(db.pair || "").split(":")[0];
            console.log(`[POSITION][INFO] Closing position ${positionKey}...`);
            const matchingTpOrders = (await fetchOpenTpOrders()).filter((order) => matchesOrderToTrackedPosition(order, position));
            const matchingSlOrders = (await fetchOpenSlOrders()).filter((order) => matchesOrderToTrackedPosition(order, position));
            const hasAttachedSpotExit = Boolean(position.tpOrderId || position.tpClientOrderId || position.slOrderId || position.slClientOrderId);
            const reasonLooksExchangeFilled = reason === "PROFIT_TARGET" || reason === "STOP_LOSS";
            if (reasonLooksExchangeFilled && hasAttachedSpotExit && matchingTpOrders.length === 0 && matchingSlOrders.length === 0) {
                console.log("[POSITION][INFO] Spot OCO exit is no longer open. Removing local active position using estimated fill state.");
                await clearMissingPositionState(position, `SPOT_OCO_${reason}`, closeLockKey);
                return;
            }
            if (matchingTpOrders.length > 0) await cancelTpOrders(matchingTpOrders, "MANUAL_CLOSE");
            if (matchingSlOrders.length > 0) await cancelSlOrders(matchingSlOrders, "MANUAL_CLOSE");

            let closeOrder;
            try {
                closeOrder = await exchange.createOrder(
                    closeSymbol,
                    "market",
                    closeSide,
                    position.quantity,
                    undefined,
                    buildExchangeOrderParams({
                        side: closeSide
                    })
                );
                metrics.api.orders++;
            } catch (error) {
                const errorMessage = String(error?.message || "");
                if (error.code === -2022 || errorMessage.includes("ReduceOnly Order is rejected")) {
                    console.warn("[POSITION][WARN] Close order rejected; clearing stale local state if exchange exposure is already gone.");
                    const fallbackReason = reasonLooksExchangeFilled
                        ? `EXCHANGE_FILLED_${reason}`
                        : "POSITION_MISSING";
                    await clearMissingPositionState(position, fallbackReason, closeLockKey);
                    return;
                }
                throw error;
            }

            const closeFillSnapshot = getOrderFillSnapshot(closeOrder, await getPrice(true), position.quantity);
            const closeOrderFilledQty = toFiniteNumber(
                closeOrder?.filled,
                toFiniteNumber(closeOrder?.info?.executedQty, toFiniteNumber(closeOrder?.amount, NaN))
            );
            console.log(
                `[POSITION][DEBUG] Close qty trace ${closeLockKey}: tracked=${toFiniteNumber(position.quantity, NaN)} `
                + `snapshot=${toFiniteNumber(closeFillSnapshot?.quantity, NaN)} orderFilled=${closeOrderFilledQty}`
            );
            const closedAt = Number.isFinite(Number(closeOrder?.timestamp))
                ? Number(closeOrder.timestamp)
                : Number.isFinite(Number(closeOrder?.lastTradeTimestamp))
                    ? Number(closeOrder.lastTradeTimestamp)
                    : Date.now();
            const realizedPnL = calculatePositionPnL(position, closeFillSnapshot.price);
            const exchangeRealizedPnl = getOrderRealizedPnl(closeOrder);
            const closeFeeCost = getOrderFeeCost(closeOrder);
            const runningNetPnl = toFiniteNumber(runningPnlState?.netProfitUSDT, NaN);
            const netRealizedPnl = Number.isFinite(runningNetPnl)
                ? runningNetPnl
                : Number.isFinite(exchangeRealizedPnl)
                    ? exchangeRealizedPnl - closeFeeCost
                    : realizedPnL.netProfitUSDT - closeFeeCost;
            await finalizeClosedPosition(
                position,
                netRealizedPnl,
                realizedPnL.profitPercent,
                reason,
                closeFillSnapshot.price,
                closeLockKey,
                {
                    closedAt,
                    order: closeOrder,
                    closeFillSnapshot
                }
            );
        } catch (error) {
            console.error("[POSITION][ERROR] Close position failed:", String(error?.message || error));
        } finally {
            closingPositionKeys.delete(closeLockKey);
            setIsClosingPosition(closingPositionKeys.size > 0);
        }
    };

    return {
        clearMissingPositionState,
        finalizeClosedPosition,
        closePosition
    };
};

module.exports = { createPositionLifecycleHelpers };
