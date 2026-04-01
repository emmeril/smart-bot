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
    getOrderFillSnapshot
}) => {
    const shouldCancelGridOrdersForPositionCleanup = () => {
        if (!isHedgeModeEnabled()) return true;
        const activeEntries = typeof getActivePositionEntries === "function" ? getActivePositionEntries() : [];
        return !Array.isArray(activeEntries) || activeEntries.length <= 1;
    };

    const clearMissingPositionState = async (position, reason, positionKey = null) => {
        const db = getDb();
        const metrics = getMetrics();
        if (shouldCancelGridOrdersForPositionCleanup()) {
            const openGridOrders = await fetchOpenGridOrders();
            if (openGridOrders.length > 0) await cancelGridOrders(openGridOrders, reason);
        }
        await cancelManagedOrdersForPosition(position, reason);
        removeActivePositionByKey(positionKey || position?.positionSide || getTrackedPositionSideLabel(position));
        const estimatedExitPrice = await getPrice(true);
        if (Number.isFinite(estimatedExitPrice) && estimatedExitPrice > 0) {
            const estimatedPnL = calculatePositionPnL(position, estimatedExitPrice);
            db.dailyPnL += estimatedPnL.realizedProfitUSDT;
            db.dailyTrades++;
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
            await saveDB();
            console.warn(`[WARN] Removed local position using estimated exit price because no confirmed exchange exit price was available (${reason}).`);
            return;
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
        console.warn(`[WARN] Removed local position without realizing P&L because no confirmed exchange exit price was available (${reason}).`);
    };

    const finalizeClosedPosition = async (position, netProfitUSDT, profitPercent, reason, exitPrice = null, positionKey = null) => {
        const db = getDb();
        const metrics = getMetrics();
        if (shouldCancelGridOrdersForPositionCleanup()) {
            const openGridOrders = await fetchOpenGridOrders();
            if (openGridOrders.length > 0) await cancelGridOrders(openGridOrders, "POSITION_CLOSED");
        }
        await cancelManagedOrdersForPosition(position, "POSITION_CLOSED");
        db.dailyPnL += netProfitUSDT;
        db.dailyTrades++;

        const resolvedExitPrice = Number.isFinite(exitPrice) && exitPrice > 0 ? exitPrice : await getPrice(true);
        logTrade(
            position.side === "buy" ? "LONG" : "SHORT",
            position.entryPrice,
            resolvedExitPrice,
            `CLOSE:${reason}`,
            netProfitUSDT,
            position.strategy || null
        );

        console.log(`\n[OK] POSITION CLOSED: ${reason}`);
        console.log(`   Realized P&L: ${netProfitUSDT.toFixed(4)} USDT (${profitPercent.toFixed(2)}%)`);
        console.log(`   Daily Total Realized P&L: ${db.dailyPnL.toFixed(4)} USDT / ${db.dailyTrades} trades`);

        removeActivePositionByKey(positionKey || position?.positionSide || getTrackedPositionSideLabel(position));
        await saveDB();
        metrics.trades.closed++;
        if (netProfitUSDT > 0) metrics.trades.wins++;
        else if (netProfitUSDT < 0) metrics.trades.losses++;
    };

    const recordPartialClose = async (position, exitPrice, closedQuantity, reason) => {
        const db = getDb();
        if (!Number.isFinite(exitPrice) || exitPrice <= 0) return;
        if (!Number.isFinite(closedQuantity) || closedQuantity <= 0) return;
        const partialPnl = calculatePositionPnL(position, exitPrice, closedQuantity);
        db.dailyPnL += partialPnl.realizedProfitUSDT;
        logTrade(
            position.side === "buy" ? "LONG" : "SHORT",
            position.entryPrice,
            exitPrice,
            `PARTIAL_CLOSE:${reason}`,
            partialPnl.realizedProfitUSDT,
            position.strategy || null
        );
        console.log(`[INFO] Recorded partial close of ${closedQuantity} contracts: ${partialPnl.realizedProfitUSDT.toFixed(4)} USDT`);
        await saveDB();
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
            const trackedPosition = getActivePositionByKey(positionKey);
            if (!trackedPosition) return;
            const position = { ...trackedPosition };
            const { side, quantity } = position;
            if (!Number.isFinite(quantity) || quantity <= 0) {
                console.error("[ERROR] Invalid position quantity. Removing local active position.");
                if (shouldCancelGridOrdersForPositionCleanup()) {
                    const openGridOrders = await fetchOpenGridOrders();
                    if (openGridOrders.length > 0) await cancelGridOrders(openGridOrders, "INVALID_POSITION_QTY");
                }
                await cancelManagedOrdersForPosition(position, "INVALID_POSITION_QTY");
                removeActivePositionByKey(positionKey);
                await saveDB();
                return;
            }

            const currentPos = findOpenExchangePosition(await fetchOpenExchangePositions(), db.pair, position);
            if (!currentPos) {
                console.log("[INFO] No matching open position on exchange. Removing local active position.");
                await clearMissingPositionState(position, "POSITION_MISSING", positionKey);
                return;
            }
            const actualQuantity = Math.abs(getExchangePositionContracts(currentPos));
            if (Math.abs(actualQuantity - quantity) > getPositionSyncQtyTolerance()) {
                console.log("[INFO] Position size changed on exchange. Updating local record.");
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

            const closeSide = side === "buy" ? "sell" : "buy";
            console.log(`\n[CLOSE] Closing position ${positionKey}...`);
            const matchingTpOrders = (await fetchOpenTpOrders()).filter((order) => matchesOrderToTrackedPosition(order, position));
            if (matchingTpOrders.length > 0) await cancelTpOrders(matchingTpOrders, "MANUAL_CLOSE");
            const matchingSlOrders = (await fetchOpenSlOrders()).filter((order) => matchesOrderToTrackedPosition(order, position));
            if (matchingSlOrders.length > 0) await cancelSlOrders(matchingSlOrders, "MANUAL_CLOSE");

            let closeOrder;
            try {
                closeOrder = await exchange.createOrder(
                    db.pair,
                    "market",
                    closeSide,
                    position.quantity,
                    undefined,
                    buildExchangeOrderParams({
                        side: closeSide,
                        reduceOnly: true,
                        positionSide: getClosePositionSide(position)
                    })
                );
                metrics.api.orders++;
            } catch (error) {
                const errorMessage = String(error?.message || "");
                if (error.code === -2022 || errorMessage.includes("ReduceOnly Order is rejected")) {
                    console.warn("[WARN] Reduce-only order rejected. Syncing position with exchange...");
                    const openPosition = findOpenExchangePosition(await fetchOpenExchangePositions(), db.pair, position);
                    if (!openPosition) {
                        console.log("[INFO] No matching open position on exchange. Removing local active position.");
                        await clearMissingPositionState(position, "POSITION_MISSING", positionKey);
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
                    await ensureReduceOnlyTakeProfitOrder(positionKey, syncedPosition);
                    await ensureReduceOnlyStopLossOrder(positionKey, syncedPosition);
                    console.log("[INFO] Updated activePosition from exchange data. Will retry close on next cycle.");
                    return;
                }
                throw error;
            }

            const closeFillSnapshot = getOrderFillSnapshot(closeOrder, await getPrice(true), position.quantity);
            const remainingPosition = findOpenExchangePosition(await fetchOpenExchangePositions(), db.pair, position);
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
                    await ensureReduceOnlyTakeProfitOrder(positionKey, syncedRemainingPosition);
                    await ensureReduceOnlyStopLossOrder(positionKey, syncedRemainingPosition);
                    console.warn(`[WARN] Close order partially filled. Remaining quantity on exchange: ${remainingContracts}`);
                    return;
                }
            }
            const realizedPnL = calculatePositionPnL(position, closeFillSnapshot.price);
            await finalizeClosedPosition(position, realizedPnL.netProfitUSDT, realizedPnL.profitPercent, reason, closeFillSnapshot.price, positionKey);
        } catch (error) {
            console.error("[ERROR] Close position failed:", String(error?.message || error));
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




