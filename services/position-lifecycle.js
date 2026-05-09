const createPositionLifecycleHelpers = ({
    getDb,
    getExchange,
    getMetrics,
    isHedgeModeEnabled,
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
    fetchOpenExchangePositions,
    findOpenExchangePosition,
    getExchangePositionContracts,
    getExchangePositionEntryPrice,
    fetchOpenGridOrders,
    buildOrderPlan,
    upsertActivePosition,
    fetchOpenTpOrders,
    fetchOpenSlOrders,
    matchesOrderToTrackedPosition,
    cancelGridOrders,
    cancelTpOrders,
    cancelSlOrders,
    buildExchangeOrderParams,
    getClosePositionSide,
    buildSyncedActivePosition,
    ensureReduceOnlyTakeProfitOrder,
    ensureReduceOnlyStopLossOrder,
    getPositionSyncQtyTolerance,
    getOrderFillSnapshot,
    notifyPositionClosed,
    notifyTradeUpdate
}) => {
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

    const shouldCancelGridOrdersForPositionCleanup = () => {
        if (!isHedgeModeEnabled()) return true;
        const activeEntries = typeof getActivePositionEntries === "function" ? getActivePositionEntries() : [];
        return !Array.isArray(activeEntries) || activeEntries.length <= 1;
    };

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
                db.dailyPnL += estimatedPnL.realizedProfitUSDT;
                db.dailyTrades++;
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
        console.log(`   Daily Total Realized P&L: ${db.dailyPnL.toFixed(4)} USDT / ${db.dailyTrades} trades`);

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
                closedAt: Number.isFinite(exitMeta.closedAt) ? exitMeta.closedAt : Date.now(),
                order: exitMeta.order || null,
                closeFillSnapshot: exitMeta.closeFillSnapshot || null,
                positionKey: trackedKey
            });
        }
        return true;
    };

    const recordPartialClose = async (position, exitPrice, closedQuantity, reason) => {
        const db = getDb();
        if (!Number.isFinite(exitPrice) || exitPrice <= 0) return;
        if (!Number.isFinite(closedQuantity) || closedQuantity <= 0) return;
        const partialPnl = calculatePositionPnL(position, exitPrice, closedQuantity);
        if (typeof applyDailyPnlDelta === "function") await applyDailyPnlDelta({
            pnlDelta: partialPnl.realizedProfitUSDT,
            tradeDelta: 0,
            source: "local"
        });
        else {
            db.dailyPnL += partialPnl.realizedProfitUSDT;
        }
        logTrade(
            position.side === "buy" ? "LONG" : "SHORT",
            position.entryPrice,
            exitPrice,
            `PARTIAL_CLOSE:${reason}`,
            partialPnl.realizedProfitUSDT,
            position.strategy || null
        );
        if (typeof notifyTradeUpdate === "function") {
            await notifyTradeUpdate({
                event: "PARTIAL_CLOSE",
                position: {
                    ...position,
                    symbol: db?.pair || position?.symbol
                },
                entryPrice: position.entryPrice,
                exitPrice,
                quantity: closedQuantity,
                realizedPnlUSDT: partialPnl.realizedProfitUSDT,
                realizedPnlPercent: partialPnl.profitPercent,
                reason,
                occurredAt: Date.now()
            });
        }
        console.log(`[POSITION][INFO] Recorded partial close of ${closedQuantity} contracts: ${partialPnl.realizedProfitUSDT.toFixed(4)} USDT`);
        if (typeof applyDailyPnlDelta !== "function") await saveDB();
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

            const isSpotRuntime = String(db?.marginMode || "").toLowerCase() === "spot"
                || String(exchange?.options?.defaultType || "").toLowerCase() === "spot";
            if (!isSpotRuntime) {
                const currentPos = findOpenExchangePosition(await fetchOpenExchangePositions(), db.pair, position);
                if (!currentPos) {
                    console.log("[POSITION][INFO] No matching open position on exchange. Removing local active position.");
                    await clearMissingPositionState(position, "POSITION_MISSING", closeLockKey);
                    return;
                }
                const actualQuantity = Math.abs(getExchangePositionContracts(currentPos));
                if (Math.abs(actualQuantity - quantity) > getPositionSyncQtyTolerance()) {
                    console.log("[POSITION][INFO] Position size changed on exchange. Updating local record.");
                    position.quantity = actualQuantity;
                    position.entryPrice = getExchangePositionEntryPrice(currentPos, position.entryPrice);
                    const recalculatedPlan = buildOrderPlan(
                        side,
                        position.entryPrice,
                        position.quantity,
                        position.atrAtEntry,
                        {
                            trailingActivateATR: position.trailingActivateATR,
                            trailingOffsetATR: position.trailingOffsetATR
                        }
                    );
                    position.targetPrice = recalculatedPlan.targetPrice;
                    position.stopLossPrice = recalculatedPlan.stopLossPrice;
                    position.targetProfitUSDT = recalculatedPlan.targetProfitUSDT;
                    position.stopLossUSDT = recalculatedPlan.stopLossUSDT;
                    position.tpOrderId = null;
                    position.tpClientOrderId = null;
                    position.slOrderId = null;
                    position.slClientOrderId = null;
                    upsertActivePosition(position);
                    await saveDB();
                }
            }

            const closeSide = side === "buy" ? "sell" : "buy";
            const closeSymbol = isSpotRuntime ? String(db.pair || "").split(":")[0] : db.pair;
            console.log(`[POSITION][INFO] Closing position ${positionKey}...`);
            const matchingTpOrders = (await fetchOpenTpOrders()).filter((order) => matchesOrderToTrackedPosition(order, position));
            const matchingSlOrders = (await fetchOpenSlOrders()).filter((order) => matchesOrderToTrackedPosition(order, position));
            const hasAttachedSpotExit = Boolean(position.tpOrderId || position.tpClientOrderId || position.slOrderId || position.slClientOrderId);
            const reasonLooksExchangeFilled = reason === "PROFIT_TARGET" || reason === "STOP_LOSS";
            if (isSpotRuntime && reasonLooksExchangeFilled && hasAttachedSpotExit && matchingTpOrders.length === 0 && matchingSlOrders.length === 0) {
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
                    console.warn("[POSITION][WARN] Reduce-only order rejected. Syncing position with exchange...");
                    const openPosition = findOpenExchangePosition(await fetchOpenExchangePositions(), db.pair, position);
                    if (!openPosition) {
                        console.log("[POSITION][INFO] No matching open position on exchange. Removing local active position.");
                        await clearMissingPositionState(position, "POSITION_MISSING", closeLockKey);
                        return;
                    }

                    const entryPrice = getExchangePositionEntryPrice(openPosition, await getPrice());
                    const syncedPosition = buildSyncedActivePosition(openPosition, entryPrice, position, entryPrice);
                    if (shouldCancelGridOrdersForPositionCleanup()) {
                        const openGridOrders = await fetchOpenGridOrders();
                        if (openGridOrders.length > 0) await cancelGridOrders(openGridOrders, "POSITION_RESYNC");
                    }
                    await cancelManagedOrdersForPosition(position, "POSITION_RESYNC");
                    upsertActivePosition(syncedPosition);
                    await saveDB();
                    await ensureReduceOnlyTakeProfitOrder(closeLockKey, syncedPosition);
                    await ensureReduceOnlyStopLossOrder(closeLockKey, syncedPosition);
                    console.log("[POSITION][INFO] Updated active position from exchange data. Will retry close on next cycle.");
                    return;
                }
                throw error;
            }

            const closeFillSnapshot = getOrderFillSnapshot(closeOrder, await getPrice(true), position.quantity);
            const closedAt = Number.isFinite(Number(closeOrder?.timestamp))
                ? Number(closeOrder.timestamp)
                : Number.isFinite(Number(closeOrder?.lastTradeTimestamp))
                    ? Number(closeOrder.lastTradeTimestamp)
                    : Date.now();
            const remainingPosition = isSpotRuntime ? null : findOpenExchangePosition(await fetchOpenExchangePositions(), db.pair, position);
            if (remainingPosition) {
                const remainingContracts = Math.abs(getExchangePositionContracts(remainingPosition));
                if (remainingContracts > getPositionSyncQtyTolerance()) {
                    const closedQuantity = Math.max(0, position.quantity - remainingContracts);
                    if (closedQuantity > getPositionSyncQtyTolerance()) {
                        await recordPartialClose(position, closeFillSnapshot.price, closedQuantity, reason);
                    }
                    const remainingEntryPrice = getExchangePositionEntryPrice(remainingPosition, position.entryPrice);
                    const syncedRemainingPosition = buildSyncedActivePosition(remainingPosition, remainingEntryPrice, position, remainingEntryPrice);
                    const recalculatedRemainingPlan = buildOrderPlan(
                        syncedRemainingPosition.side,
                        syncedRemainingPosition.entryPrice,
                        syncedRemainingPosition.quantity,
                        syncedRemainingPosition.atrAtEntry,
                        {
                            trailingActivateATR: syncedRemainingPosition.trailingActivateATR,
                            trailingOffsetATR: syncedRemainingPosition.trailingOffsetATR
                        }
                    );
                    syncedRemainingPosition.targetPrice = recalculatedRemainingPlan.targetPrice;
                    syncedRemainingPosition.stopLossPrice = recalculatedRemainingPlan.stopLossPrice;
                    syncedRemainingPosition.targetProfitUSDT = recalculatedRemainingPlan.targetProfitUSDT;
                    syncedRemainingPosition.stopLossUSDT = recalculatedRemainingPlan.stopLossUSDT;
                    upsertActivePosition(syncedRemainingPosition);
                    await saveDB();
                    await ensureReduceOnlyTakeProfitOrder(closeLockKey, syncedRemainingPosition);
                    await ensureReduceOnlyStopLossOrder(closeLockKey, syncedRemainingPosition);
                    console.warn(`[POSITION][WARN] Close order partially filled. Remaining quantity on exchange: ${remainingContracts}`);
                    return;
                }
            }
            const realizedPnL = calculatePositionPnL(position, closeFillSnapshot.price);
            await finalizeClosedPosition(
                position,
                realizedPnL.netProfitUSDT,
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
        recordPartialClose,
        closePosition
    };
};

module.exports = { createPositionLifecycleHelpers };
