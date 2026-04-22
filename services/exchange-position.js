const createExchangePositionHelpers = ({
    isHedgeModeEnabled,
    toFiniteNumber,
    normalizeSymbol,
    formatPriceToMarketPrecision,
    getExchangeClientOrderId,
    getDb,
    getSignalParameters,
    sanitizeGridState,
    findNearestGridLevelIndex,
    buildGridExitPlan,
    getPositionSyncQtyTolerance,
    getPositionSyncEntryTolerancePct
}) => {
    const getTrackedPositionSideLabel = (position) => {
        const rawPositionSide = String(position?.positionSide || position?.info?.positionSide || "").toUpperCase();
        if (rawPositionSide === "LONG" || rawPositionSide === "SHORT" || rawPositionSide === "BOTH") return rawPositionSide;
        const side = String(position?.side || "").toLowerCase();
        if (side === "buy") return isHedgeModeEnabled() ? "LONG" : "BOTH";
        if (side === "sell") return isHedgeModeEnabled() ? "SHORT" : "BOTH";
        return isHedgeModeEnabled() ? null : "BOTH";
    };

    const getOrderPositionSide = (side) => {
        if (!isHedgeModeEnabled()) return "BOTH";
        return String(side || "").toLowerCase() === "buy" ? "LONG" : "SHORT";
    };

    const getClosePositionSide = (position) => {
        if (!isHedgeModeEnabled()) return "BOTH";
        const tracked = getTrackedPositionSideLabel(position);
        if (tracked === "LONG" || tracked === "SHORT") return tracked;
        return String(position?.side || "").toLowerCase() === "buy" ? "LONG" : "SHORT";
    };

    const matchesOrderToTrackedPosition = (order, position) => {
        const positionSide = String(position?.side || "").toLowerCase();
        const trackedSide = getTrackedPositionSideLabel(position);
        const expectedCloseSide = positionSide === "buy" || trackedSide === "LONG"
            ? "sell"
            : (positionSide === "sell" || trackedSide === "SHORT" ? "buy" : null);
        if (!expectedCloseSide) return false;
        if (String(order?.side || "").toLowerCase() !== expectedCloseSide) return false;
        if (!isHedgeModeEnabled()) return true;
        const orderPositionSide = String(order?.info?.positionSide || order?.positionSide || "").toUpperCase();
        return !orderPositionSide || orderPositionSide === getClosePositionSide(position);
    };

    const getOrderQuantity = (order) => {
        const directAmount = toFiniteNumber(order?.amount, NaN);
        if (Number.isFinite(directAmount) && directAmount > 0) return Math.abs(directAmount);
        const directRemaining = toFiniteNumber(order?.remaining, NaN);
        const directFilled = toFiniteNumber(order?.filled, NaN);
        if (Number.isFinite(directRemaining) && directRemaining > 0) return Math.abs(directRemaining);
        if (Number.isFinite(directFilled) && directFilled > 0) return Math.abs(directFilled);
        const infoOrigQty = toFiniteNumber(order?.info?.origQty, NaN);
        if (Number.isFinite(infoOrigQty) && infoOrigQty > 0) return Math.abs(infoOrigQty);
        const infoQty = toFiniteNumber(order?.info?.qty, NaN);
        if (Number.isFinite(infoQty) && infoQty > 0) return Math.abs(infoQty);
        const infoExecutedQty = toFiniteNumber(order?.info?.executedQty, NaN);
        if (Number.isFinite(infoExecutedQty) && infoExecutedQty > 0) return Math.abs(infoExecutedQty);
        return NaN;
    };

    const getOrderTriggerPrice = (order) => {
        const directStopPrice = toFiniteNumber(order?.stopPrice, NaN);
        if (Number.isFinite(directStopPrice) && directStopPrice > 0) return directStopPrice;
        const infoStopPrice = toFiniteNumber(order?.info?.stopPrice, NaN);
        if (Number.isFinite(infoStopPrice) && infoStopPrice > 0) return infoStopPrice;
        const directActivationPrice = toFiniteNumber(order?.activationPrice, NaN);
        if (Number.isFinite(directActivationPrice) && directActivationPrice > 0) return directActivationPrice;
        const infoActivatePrice = toFiniteNumber(order?.info?.activatePrice, NaN);
        if (Number.isFinite(infoActivatePrice) && infoActivatePrice > 0) return infoActivatePrice;
        const triggerPrice = toFiniteNumber(order?.triggerPrice, NaN);
        return Number.isFinite(triggerPrice) && triggerPrice > 0 ? triggerPrice : NaN;
    };

    const isManagedOrderPriceMatch = (expectedPrice, actualPrice) => {
        const currentDb = getDb();
        const normalizedExpected = formatPriceToMarketPrecision(currentDb?.pair, expectedPrice);
        const normalizedActual = formatPriceToMarketPrecision(currentDb?.pair, actualPrice);
        if (Number.isFinite(normalizedExpected) && Number.isFinite(normalizedActual)) {
            return normalizedExpected === normalizedActual;
        }
        if (!Number.isFinite(expectedPrice) || !Number.isFinite(actualPrice)) return false;
        const tolerance = Math.max(1e-8, Math.abs(expectedPrice) * 0.000001);
        return Math.abs(expectedPrice - actualPrice) <= tolerance;
    };

    const getExchangePositionContracts = (position) => {
        const rawContracts = toFiniteNumber(position?.contracts, NaN);
        if (Number.isFinite(rawContracts) && rawContracts !== 0) return rawContracts;
        const rawPositionAmt = toFiniteNumber(position?.info?.positionAmt, NaN);
        if (Number.isFinite(rawPositionAmt) && rawPositionAmt !== 0) return rawPositionAmt;
        return 0;
    };

    const getExchangePositionSide = (position) => {
        const side = String(position?.side || "").toLowerCase();
        if (side === "long") return "buy";
        if (side === "short") return "sell";
        const contracts = getExchangePositionContracts(position);
        if (contracts > 0) return "buy";
        if (contracts < 0) return "sell";
        return null;
    };

    const getExchangePositionModeSide = (position) => {
        if (!isHedgeModeEnabled()) return "BOTH";
        const rawPositionSide = String(position?.positionSide || position?.info?.positionSide || "").toUpperCase();
        if (rawPositionSide === "LONG" || rawPositionSide === "SHORT" || rawPositionSide === "BOTH") return rawPositionSide;
        const side = String(position?.side || "").toLowerCase();
        if (side === "long") return "LONG";
        if (side === "short") return "SHORT";
        return getExchangePositionSide(position) === "buy" ? "LONG" : (getExchangePositionSide(position) === "sell" ? "SHORT" : "BOTH");
    };

    const getExchangePositionEntryPrice = (position, fallbackPrice = 0) => {
        const directEntry = toFiniteNumber(position?.entryPrice, NaN);
        if (Number.isFinite(directEntry) && directEntry > 0) return directEntry;
        const infoEntry = toFiniteNumber(position?.info?.entryPrice, NaN);
        if (Number.isFinite(infoEntry) && infoEntry > 0) return infoEntry;
        return fallbackPrice;
    };

    const getExchangePositionMarkPrice = (position, fallbackPrice = NaN) => {
        const directMarkPrice = toFiniteNumber(position?.markPrice, NaN);
        if (Number.isFinite(directMarkPrice) && directMarkPrice > 0) return directMarkPrice;
        const infoMarkPrice = toFiniteNumber(position?.info?.markPrice, NaN);
        if (Number.isFinite(infoMarkPrice) && infoMarkPrice > 0) return infoMarkPrice;
        return fallbackPrice;
    };

    const buildExchangePnlSnapshot = (exchangePosition, fallbackPrice = NaN) => {
        const currentDb = getDb();
        if (!exchangePosition) return null;
        const normalizedMarkPrice = getExchangePositionMarkPrice(exchangePosition, fallbackPrice);
        const exchangeUnrealizedPnl = toFiniteNumber(
            exchangePosition?.unrealizedPnl,
            toFiniteNumber(exchangePosition?.info?.unrealizedProfit, toFiniteNumber(exchangePosition?.info?.unRealizedProfit, NaN))
        );
        const exchangePercentage = toFiniteNumber(exchangePosition?.percentage, NaN);
        const initialMargin = Math.abs(toFiniteNumber(exchangePosition?.initialMargin, toFiniteNumber(exchangePosition?.collateral, NaN)));
        const leverageAtEntry = Math.max(1, Math.abs(toFiniteNumber(exchangePosition?.leverage, currentDb.leverage)));
        const fee = toFiniteNumber(exchangePosition?.fee, toFiniteNumber(exchangePosition?.info?.fee, 0));
        const exitReferencePrice = Number.isFinite(normalizedMarkPrice) && normalizedMarkPrice > 0 ? normalizedMarkPrice : fallbackPrice;
        let profitPercent = exchangePercentage;
        if (!Number.isFinite(profitPercent) && Number.isFinite(initialMargin) && initialMargin > 0 && Number.isFinite(exchangeUnrealizedPnl)) {
            profitPercent = (exchangeUnrealizedPnl / initialMargin) * 100;
        }
        const netProfitUSDT = exchangeUnrealizedPnl - fee;
        return {
            grossProfitUSDT: exchangeUnrealizedPnl,
            netProfitUSDT: netProfitUSDT,
            realizedProfitUSDT: netProfitUSDT,
            profitPercent,
            displayProfitUSDT: netProfitUSDT,
            displayProfitPercent: profitPercent,
            currentPrice: exitReferencePrice,
            markPrice: normalizedMarkPrice,
            initialMargin,
            leverageAtEntry,
            fee: fee,
            funding: 0,
            timestamp: Date.now(),
            source: "exchange"
        };
    };

    const matchesTrackedPositionSide = (position, trackedPosition) => {
        if (!isHedgeModeEnabled()) return true;
        const targetSide = getTrackedPositionSideLabel(trackedPosition);
        const candidateSide = getTrackedPositionSideLabel(position);
        if (!targetSide || targetSide === "BOTH") return true;
        return candidateSide === targetSide;
    };

    const findOpenExchangePosition = (positions, pair, trackedPosition = null) => {
        const normalizedPair = normalizeSymbol(pair);
        const openPositions = positions.filter((position) => (
            normalizeSymbol(position.symbol) === normalizedPair &&
            Math.abs(getExchangePositionContracts(position)) > 0
        ));
        if (openPositions.length === 0) return null;
        if (trackedPosition) return openPositions.find((position) => matchesTrackedPositionSide(position, trackedPosition)) || null;
        if (isHedgeModeEnabled() && openPositions.length > 1) {
            console.warn("[POSITION][WARN] Multiple hedge positions detected on the same symbol. Bot will track the first open side only.");
        }
        return openPositions[0];
    };

    const resolveAutoTargetProfitUSDT = (entryPrice, quantity, atrAtEntry = NaN) => {
        const currentDb = getDb();
        const baseTargetProfitUSDT = Math.max(0, toFiniteNumber(currentDb.gridTargetProfitUsdt, 0.5));
        const atrValue = Math.abs(toFiniteNumber(atrAtEntry, NaN));
        const autoTargetProfitEnabled = currentDb.autoTargetProfitEnabled !== false;
        if (!autoTargetProfitEnabled || !Number.isFinite(atrValue) || atrValue <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
            return baseTargetProfitUSDT;
        }

        const atrMultiplier = Math.max(0.1, toFiniteNumber(currentDb.targetProfitAtrMultiplier, 0.75));
        const minTargetProfitUSDT = Math.max(0.01, toFiniteNumber(currentDb.targetProfitMinUsdt, Math.min(baseTargetProfitUSDT, 0.25)));
        const maxTargetProfitUSDT = Math.max(
            minTargetProfitUSDT,
            toFiniteNumber(currentDb.targetProfitMaxUsdt, Math.max(baseTargetProfitUSDT * 3, minTargetProfitUSDT))
        );
        const atrTargetProfitUSDT = atrValue * quantity * atrMultiplier;
        const suggestedTargetProfitUSDT = Math.max(baseTargetProfitUSDT, atrTargetProfitUSDT);
        return Math.min(maxTargetProfitUSDT, Math.max(minTargetProfitUSDT, suggestedTargetProfitUSDT));
    };

    const resolveAutoStopLossPercent = (atrAtEntry, entryPrice) => {
        const currentDb = getDb();
        const baseStopLossPercent = Math.max(0, toFiniteNumber(currentDb.gridStopLossPercent, 5));
        const atrValue = Math.abs(toFiniteNumber(atrAtEntry, NaN));
        const autoStopLossEnabled = currentDb.autoStopLossEnabled !== false;
        if (!autoStopLossEnabled || !Number.isFinite(atrValue) || atrValue <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0) {
            return baseStopLossPercent;
        }

        const leverage = Math.max(1, toFiniteNumber(currentDb.leverage, 1));
        const atrMultiplier = Math.max(0.05, toFiniteNumber(currentDb.stopLossAtrMultiplier, 0.12));
        const minStopLossPercent = Math.max(0.1, toFiniteNumber(currentDb.stopLossMinPercent, Math.min(baseStopLossPercent, 3)));
        const maxStopLossPercent = Math.max(
            minStopLossPercent,
            toFiniteNumber(currentDb.stopLossMaxPercent, Math.max(baseStopLossPercent * 1.5, minStopLossPercent))
        );
        const atrBasedPercent = (atrValue / entryPrice) * leverage * atrMultiplier * 100;
        const suggestedStopLossPercent = Math.max(baseStopLossPercent, atrBasedPercent);
        return Math.min(maxStopLossPercent, Math.max(minStopLossPercent, suggestedStopLossPercent));
    };

    const buildSyncedActivePosition = (openPosition, entryPrice, existingPosition = null, currentPrice = NaN, options = {}) => {
        const currentDb = getDb();
        const preserveExitPlan = options.preserveExitPlan !== false;
        const contracts = Math.abs(getExchangePositionContracts(openPosition));
        const side = getExchangePositionSide(openPosition) || "buy";
        const positionSide = getExchangePositionModeSide(openPosition);
        const exchangePnlSnapshot = buildExchangePnlSnapshot(openPosition, currentPrice);
        const preservedStrategy = existingPosition?.strategy || "SYNC_ONLY";
        const preservedTrailingEnabled = existingPosition?.trailingEnabled ?? Boolean(currentDb.trailingEnabled);
        const preservedTrailingActivateATR = existingPosition?.trailingActivateATR ?? toFiniteNumber(currentDb.trailingActivateATR, 1.2);
        const preservedTrailingOffsetATR = existingPosition?.trailingOffsetATR ?? toFiniteNumber(currentDb.trailingOffsetATR, 0.6);
        const preservedTrailingRiskModel = existingPosition?.trailingRiskModel || "STATIC";
        const preservedTrailingRiskSource = existingPosition?.trailingRiskSource || "config";
        const preservedTrailingRiskReason = existingPosition?.trailingRiskReason || null;
        const preservedTrailingRiskMeta = existingPosition?.trailingRiskMeta || null;
        const preservedEntryTime = Number.isFinite(existingPosition?.entryTime) ? existingPosition.entryTime : Date.now() - 300000;
        const preservedHighestSinceEntry = Number.isFinite(existingPosition?.highestSinceEntry) ? existingPosition.highestSinceEntry : entryPrice;
        const preservedLowestSinceEntry = Number.isFinite(existingPosition?.lowestSinceEntry) ? existingPosition.lowestSinceEntry : entryPrice;
        const preservedAtrAtEntry = Number.isFinite(existingPosition?.atrAtEntry) ? existingPosition.atrAtEntry : NaN;
        const signalParams = getSignalParameters();
        const gridState = sanitizeGridState(currentDb?.activeGridState, signalParams);
        const levels = Array.isArray(gridState?.levels) ? gridState.levels : [];
        const step = toFiniteNumber(gridState?.step, NaN);
        const derivedGridIndex = findNearestGridLevelIndex(levels, entryPrice);
        const gridExitPlan = buildGridExitPlan({ side, entryIndex: derivedGridIndex, levels, step, params: signalParams, gridState });
        const fallbackTargetProfitUSDT = resolveAutoTargetProfitUSDT(entryPrice, contracts, preservedAtrAtEntry);
        const fallbackStopLossPercent = resolveAutoStopLossPercent(preservedAtrAtEntry, entryPrice);
        const fallbackLeverage = Math.max(1, toFiniteNumber(existingPosition?.leverageAtEntry, currentDb.leverage));
        const fallbackStopLossUSDT = -Math.abs((contracts * entryPrice / fallbackLeverage) * (fallbackStopLossPercent / 100));
        const targetPrice = Number.isFinite(gridExitPlan.targetPrice)
            ? gridExitPlan.targetPrice
            : (side === "buy"
                ? formatPriceToMarketPrecision(currentDb.pair, entryPrice + (fallbackTargetProfitUSDT / Math.max(contracts, 1e-8)))
                : formatPriceToMarketPrecision(currentDb.pair, entryPrice - (fallbackTargetProfitUSDT / Math.max(contracts, 1e-8))));
        const stopLossPrice = Number.isFinite(gridExitPlan.stopLossPrice)
            ? gridExitPlan.stopLossPrice
            : (side === "buy"
                ? formatPriceToMarketPrecision(currentDb.pair, entryPrice + (fallbackStopLossUSDT / Math.max(contracts, 1e-8)))
                : formatPriceToMarketPrecision(currentDb.pair, entryPrice - (fallbackStopLossUSDT / Math.max(contracts, 1e-8))));
        const existingQuantity = toFiniteNumber(existingPosition?.quantity, 0);
        const quantityChanged = Math.abs(existingQuantity - contracts) > getPositionSyncQtyTolerance();
        const existingEntryPrice = toFiniteNumber(existingPosition?.entryPrice, 0);
        const entryDeltaPercent = existingEntryPrice > 0 ? Math.abs((existingEntryPrice - entryPrice) / existingEntryPrice) * 100 : 100;
        const entryChanged = entryDeltaPercent > getPositionSyncEntryTolerancePct();
        const existingSide = String(existingPosition?.side || "").toLowerCase();
        const existingPositionSide = getTrackedPositionSideLabel(existingPosition);
        const canPreserveExitPlan = preserveExitPlan && existingPosition && existingSide === side && existingPositionSide === positionSide && !quantityChanged && !entryChanged;
        const preservedTargetPrice = canPreserveExitPlan && Number.isFinite(existingPosition?.targetPrice) ? existingPosition.targetPrice : targetPrice;
        const preservedStopLossPrice = canPreserveExitPlan && Number.isFinite(existingPosition?.stopLossPrice) ? existingPosition.stopLossPrice : stopLossPrice;
        const fallbackTargetProfitUsdt = Math.abs(preservedTargetPrice - entryPrice) * contracts;
        const fallbackStopLossUsdt = fallbackStopLossUSDT;
        const preservedTargetProfitUSDT = canPreserveExitPlan && Number.isFinite(existingPosition?.targetProfitUSDT)
            ? existingPosition.targetProfitUSDT
            : resolveAutoTargetProfitUSDT(entryPrice, contracts, preservedAtrAtEntry);
        const preservedStopLossUSDT = canPreserveExitPlan && Number.isFinite(existingPosition?.stopLossUSDT) ? existingPosition.stopLossUSDT : fallbackStopLossUsdt;
        return {
            side,
            entryPrice,
            targetPrice: preservedTargetPrice,
            stopLossPrice: preservedStopLossPrice,
            stopLossUSDT: preservedStopLossUSDT,
            orderId: `SYNC_${Date.now()}`,
            quantity: contracts,
            entryTime: preservedEntryTime,
            highestSinceEntry: preservedHighestSinceEntry,
            lowestSinceEntry: preservedLowestSinceEntry,
            atrAtEntry: preservedAtrAtEntry,
            marginMode: (currentDb.marginMode || "isolated").toLowerCase(),
            positionSide,
            targetProfitUSDT: preservedTargetProfitUSDT,
            leverageAtEntry: toFiniteNumber(exchangePnlSnapshot?.leverageAtEntry, toFiniteNumber(currentDb.leverage, 1)),
            trailingEnabled: preserveExitPlan ? preservedTrailingEnabled : Boolean(currentDb.trailingEnabled),
            trailingActivateATR: preserveExitPlan ? preservedTrailingActivateATR : toFiniteNumber(currentDb.trailingActivateATR, 1.2),
            trailingOffsetATR: preserveExitPlan ? preservedTrailingOffsetATR : toFiniteNumber(currentDb.trailingOffsetATR, 0.6),
            trailingRiskModel: preserveExitPlan ? preservedTrailingRiskModel : "STATIC",
            trailingRiskSource: preserveExitPlan ? preservedTrailingRiskSource : "config",
            trailingRiskReason: preserveExitPlan ? preservedTrailingRiskReason : null,
            trailingRiskMeta: preserveExitPlan ? preservedTrailingRiskMeta : null,
            strategy: preservedStrategy,
            exchangePnlSnapshot,
            tpOrderId: null,
            tpClientOrderId: null,
            slOrderId: null,
            slClientOrderId: null
        };
    };

    const shouldRefreshSyncedPosition = (activePosition, nextPosition) => {
        if (!activePosition) return true;
        const currentQuantity = toFiniteNumber(activePosition.quantity, 0);
        const nextQuantity = toFiniteNumber(nextPosition.quantity, 0);
        const currentEntry = toFiniteNumber(activePosition.entryPrice, 0);
        const nextEntry = toFiniteNumber(nextPosition.entryPrice, 0);
        const currentSide = String(activePosition.side || "").toLowerCase();
        const nextSide = String(nextPosition.side || "").toLowerCase();
        const quantityChanged = Math.abs(currentQuantity - nextQuantity) > getPositionSyncQtyTolerance();
        const entryDeltaPercent = currentEntry > 0 ? Math.abs((currentEntry - nextEntry) / currentEntry) * 100 : 100;
        const entryChanged = entryDeltaPercent > getPositionSyncEntryTolerancePct();
        const currentPositionSide = getTrackedPositionSideLabel(activePosition);
        const nextPositionSide = getTrackedPositionSideLabel(nextPosition);
        return currentSide !== nextSide || currentPositionSide !== nextPositionSide || quantityChanged || entryChanged;
    };

    const isSameTrackedPosition = (currentPosition, nextPosition) => {
        if (!currentPosition || !nextPosition) return false;
        const currentQuantity = toFiniteNumber(currentPosition.quantity, 0);
        const nextQuantity = toFiniteNumber(nextPosition.quantity, 0);
        const currentEntry = toFiniteNumber(currentPosition.entryPrice, 0);
        const nextEntry = toFiniteNumber(nextPosition.entryPrice, 0);
        const currentSide = String(currentPosition.side || "").toLowerCase();
        const nextSide = String(nextPosition.side || "").toLowerCase();
        const quantityChanged = Math.abs(currentQuantity - nextQuantity) > getPositionSyncQtyTolerance();
        const entryDeltaPercent = currentEntry > 0 ? Math.abs((currentEntry - nextEntry) / currentEntry) * 100 : 100;
        return currentSide === nextSide && getTrackedPositionSideLabel(currentPosition) === getTrackedPositionSideLabel(nextPosition) && !quantityChanged && entryDeltaPercent <= getPositionSyncEntryTolerancePct();
    };

    return {
        getTrackedPositionSideLabel,
        getOrderPositionSide,
        getClosePositionSide,
        matchesOrderToTrackedPosition,
        getOrderQuantity,
        getOrderTriggerPrice,
        isManagedOrderPriceMatch,
        getExchangePositionContracts,
        getExchangePositionSide,
        getExchangePositionModeSide,
        getExchangePositionEntryPrice,
        getExchangePositionMarkPrice,
        buildExchangePnlSnapshot,
        matchesTrackedPositionSide,
        findOpenExchangePosition,
        buildSyncedActivePosition,
        shouldRefreshSyncedPosition,
        isSameTrackedPosition
    };
};

module.exports = { createExchangePositionHelpers };









