const createRuntimePositionUtils = ({
    getDb,
    getExchange,
    getMetrics,
    normalizeSymbol,
    toFiniteNumber,
    formatPriceToMarketPrecision,
    saveDB,
    getLastPositionRuntimePersistAt,
    setLastPositionRuntimePersistAt,
    positionRuntimePersistTtl,
    getPrice,
    getActivePositionEntries,
    fetchManagedOpenOrdersSnapshot,
    getGridRuntimeSummary,
    getExchangeRecoveryReason,
    getAccountPositionMode,
    getIsPlacingOrder,
    getIsClosingPosition,
    getIsSyncingPosition,
    getIsSyncingGridOrders,
    getExchangeHealth,
    getLastTradeAt,
    formatStatusTimestamp,
    printStatusLine,
    printOrderSample,
    printPositionLine
}) => {
    const buildExchangeOrderParams = () => ({
        newOrderRespType: "RESULT"
    });

    const fetchOpenExchangePositions = async () => {
        // Spot-only runtime: no futures position sync.
        return [];
    };

    const snapshotPositionRuntimeState = (position) => ({
        highestSinceEntry: toFiniteNumber(position?.highestSinceEntry, null),
        lowestSinceEntry: toFiniteNumber(position?.lowestSinceEntry, null),
        stopLossPrice: toFiniteNumber(position?.stopLossPrice, null),
        stopLossUSDT: toFiniteNumber(position?.stopLossUSDT, null)
    });

    const didPositionRuntimeStateChange = (beforeState, position) => {
        const afterState = snapshotPositionRuntimeState(position);
        return Object.keys(afterState).some((key) => afterState[key] !== beforeState[key]);
    };

    const maybePersistActivePositionRuntimeState = async () => {
        const now = Date.now();
        if (now - getLastPositionRuntimePersistAt() < positionRuntimePersistTtl) return;
        await saveDB();
        setLastPositionRuntimePersistAt(now);
    };

    const updateActivePositionExtremes = (position, currentPrice) => {
        if (!Number.isFinite(position.highestSinceEntry)) position.highestSinceEntry = position.entryPrice;
        if (!Number.isFinite(position.lowestSinceEntry)) position.lowestSinceEntry = position.entryPrice;
        position.highestSinceEntry = Math.max(position.highestSinceEntry ?? position.entryPrice, currentPrice);
        position.lowestSinceEntry = Math.min(position.lowestSinceEntry ?? position.entryPrice, currentPrice);
    };

    const resolveGridNoSlZone = () => {
        const db = getDb();
        const levels = Array.isArray(db?.activeGridState?.levels)
            ? db.activeGridState.levels.map((level) => toFiniteNumber(level, NaN)).filter((level) => Number.isFinite(level) && level > 0)
            : [];
        if (levels.length < 2) return null;
        const minPrice = Math.min(...levels);
        const maxPrice = Math.max(...levels);
        const step = Math.abs(toFiniteNumber(db?.activeGridState?.step, NaN));
        const fallbackStep = (maxPrice - minPrice) / Math.max(levels.length - 1, 1);
        const buffer = Math.max(1e-8, Number.isFinite(step) && step > 0 ? step : fallbackStep);
        if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice) || minPrice <= 0 || maxPrice <= 0 || maxPrice <= minPrice) return null;
        return { minPrice, maxPrice, buffer };
    };

    const applyNoSlZoneClamp = (position, stopPrice) => {
        const db = getDb();
        if (String(db?.strategy || "").toLowerCase() !== "spot_grid") return stopPrice;
        if (!Number.isFinite(stopPrice) || stopPrice <= 0) return stopPrice;
        const zone = resolveGridNoSlZone();
        if (!zone) return stopPrice;
        if (stopPrice < zone.minPrice || stopPrice > zone.maxPrice) return stopPrice;
        const clampedPrice = position.side === "buy"
            ? (zone.minPrice - zone.buffer)
            : (zone.maxPrice + zone.buffer);
        const normalizedClampedPrice = formatPriceToMarketPrecision(db?.pair, clampedPrice);
        if (Number.isFinite(normalizedClampedPrice) && normalizedClampedPrice !== stopPrice) {
            console.log(
                `[SL][CLAMP] side=${String(position?.side || "").toUpperCase()} ` +
                `rawSL=${stopPrice} -> clampedSL=${normalizedClampedPrice} ` +
                `zone=[${zone.minPrice}, ${zone.maxPrice}] buffer=${zone.buffer}`
            );
        }
        return normalizedClampedPrice;
    };

    const hasRelevantGridOrdersForPosition = (position, managedOrdersSnapshot = null) => {
        const gridOrders = Array.isArray(managedOrdersSnapshot?.grid) ? managedOrdersSnapshot.grid : [];
        if (gridOrders.length === 0) return false;
        const expectedGridSide = String(position?.side || "").toLowerCase();
        return gridOrders.some((order) => String(order?.side || "").toLowerCase() === expectedGridSide);
    };

    const applyTrailingStopUpdate = (position, managedOrdersSnapshot = null) => {
        const db = getDb();
        const trailingEnabled = position?.trailingEnabled ?? db.trailingEnabled;
        if (!trailingEnabled || !Number.isFinite(position.atrAtEntry) || position.atrAtEntry <= 0) return;
        const allowGridClamp = hasRelevantGridOrdersForPosition(position, managedOrdersSnapshot);
        const effectiveTrailingActivateATR = toFiniteNumber(position.trailingActivateATR, db.trailingActivateATR);
        const effectiveTrailingOffsetATR = toFiniteNumber(position.trailingOffsetATR, db.trailingOffsetATR);
        const trailActivationMove = effectiveTrailingActivateATR * position.atrAtEntry;
        const trailOffsetMove = effectiveTrailingOffsetATR * position.atrAtEntry;

        if (position.side === "buy") {
            const activated = position.highestSinceEntry >= position.entryPrice + trailActivationMove;
            if (!activated) return;
            const rawTrailedStop = position.highestSinceEntry - trailOffsetMove;
            const trailedStop = allowGridClamp ? applyNoSlZoneClamp(position, rawTrailedStop) : rawTrailedStop;
            if (!Number.isFinite(position.stopLossPrice) || trailedStop > position.stopLossPrice) {
                position.stopLossPrice = trailedStop;
                position.stopLossUSDT = -Math.abs(position.stopLossPrice - position.entryPrice) * position.quantity;
            }
            return;
        }

        const activated = position.lowestSinceEntry <= position.entryPrice - trailActivationMove;
        if (!activated) return;
        const rawTrailedStop = position.lowestSinceEntry + trailOffsetMove;
        const trailedStop = allowGridClamp ? applyNoSlZoneClamp(position, rawTrailedStop) : rawTrailedStop;
        if (!Number.isFinite(position.stopLossPrice) || trailedStop < position.stopLossPrice) {
            position.stopLossPrice = trailedStop;
            position.stopLossUSDT = -Math.abs(position.stopLossPrice - position.entryPrice) * position.quantity;
        }
    };

    const calculatePositionPnL = (position, currentPrice, quantityOverride = null) => {
        const quantity = Number.isFinite(quantityOverride) ? quantityOverride : position.quantity;
        const exchangePnlSnapshot = !Number.isFinite(quantityOverride) ? position?.exchangePnlSnapshot : null;

        const entryValue = Math.max(1e-8, position.entryPrice * quantity);
        const snapshotMarkPrice = toFiniteNumber(exchangePnlSnapshot?.markPrice, NaN);
        const priceSource = Number.isFinite(snapshotMarkPrice) && snapshotMarkPrice > 0
            ? snapshotMarkPrice
            : currentPrice;

        const grossProfitUSDT = position.side === "buy"
            ? (priceSource - position.entryPrice) * quantity
            : (position.entryPrice - priceSource) * quantity;
        const referenceInitialMargin = entryValue;
        const profitPercent = (grossProfitUSDT / referenceInitialMargin) * 100;
        const displayProfitPercent = (grossProfitUSDT / referenceInitialMargin) * 100;

        return {
            grossProfitUSDT,
            netProfitUSDT: grossProfitUSDT,
            realizedProfitUSDT: grossProfitUSDT,
            profitPercent,
            displayProfitUSDT: grossProfitUSDT,
            displayProfitPercent,
            currentPrice: priceSource,
            source: "local"
        };
    };

    const printDetailedStatus = async () => {
        const db = getDb();
        if (!db) return;
        const exchange = getExchange();
        const currentPrice = exchange ? await getPrice() : NaN;
        const activeEntries = getActivePositionEntries();
        let openExchangePositions = [];
        let managedOrders = { grid: [], tp: [], sl: [] };

        if (exchange) {
            try {
                openExchangePositions = await fetchOpenExchangePositions();
            } catch (error) {
                console.warn(`[STATUS][WARN] Failed to fetch exchange positions: ${error.message}`);
            }

            try {
                managedOrders = await fetchManagedOpenOrdersSnapshot();
            } catch (error) {
                console.warn(`[STATUS][WARN] Failed to fetch managed open orders: ${error.message}`);
            }
        }
        const gridSummary = getGridRuntimeSummary(currentPrice, managedOrders);
        const recoveryReason = getExchangeRecoveryReason();
        const accountPositionMode = getAccountPositionMode();
        const exchangeHealth = getExchangeHealth();

        console.log(`[STATUS] Mode=${accountPositionMode.label} | Pair=${db.pair} | Price=${Number.isFinite(currentPrice) ? currentPrice : "N/A"} | LocalActive=${activeEntries.length} | ExchangePos=${openExchangePositions.length}`);
        printStatusLine("Profile", `${gridSummary.presetName.toUpperCase()} | Grid=${gridSummary.gridLevelsMode === "AUTO" ? `AUTO ${gridSummary.effectiveGridLevels}` : gridSummary.effectiveGridLevels} | Range=${gridSummary.gridRangeMode === "AUTO" ? `AUTO ${gridSummary.effectiveGridRangePercent}%` : `${gridSummary.effectiveGridRangePercent}%`} | Buffer=${gridSummary.gridEntryBufferMode === "AUTO" ? `AUTO ${gridSummary.effectiveGridEntryBufferPercent}%` : `${gridSummary.effectiveGridEntryBufferPercent}%`} | Slot=${gridSummary.slotLabel} | Ladder=${gridSummary.ladderLabel}`);
        printStatusLine("Side Orders", `${gridSummary.ordersMode}=${gridSummary.effectiveOrdersPerSide}/${gridSummary.configuredOrdersPerSideCap} | Size ${gridSummary.sizeMode}=${gridSummary.effectiveOrderSizeUsdt.toFixed(4)} USDT | Min Valid=${gridSummary.minOrderSizeUsdt.toFixed(4)} USDT | Available USDT=${gridSummary.availableUsdtLabel}`);
        printStatusLine("Realized P&L (Cumulative)", `${db.dailyPnL.toFixed(2)} USDT | Daily Trades=${db.dailyTrades}`);
        printStatusLine("Runtime", `placing=${getIsPlacingOrder() ? "Y" : "N"} closing=${getIsClosingPosition() ? "Y" : "N"} posSync=${getIsSyncingPosition() ? "Y" : "N"} gridSync=${getIsSyncingGridOrders() ? "Y" : "N"}`);
        printStatusLine("Exchange", `${exchangeHealth.isHealthy ? "HEALTHY" : "DEGRADED"} | RecoverySync=${exchangeHealth.needsRecoverySync ? "Y" : "N"}${recoveryReason ? ` | ${recoveryReason}` : ""}`);
        printStatusLine("Last trade", `${formatStatusTimestamp(getLastTradeAt())} | Daily reset=${formatStatusTimestamp(toFiniteNumber(db.lastDailyReset, Date.now()))}`);
        printStatusLine("Open Orders", `Grid=${managedOrders.grid.length} | TP=${managedOrders.tp.length} | SL=${managedOrders.sl.length}`);
        if (gridSummary.hasLockedGrid) printStatusLine("Locked Grid", `${gridSummary.lockedRangeLabel} | Step=${gridSummary.stepLabel}`);
        if (openExchangePositions.length !== activeEntries.length) {
            console.warn(`[STATUS][WARN] Position mismatch detected: local=${activeEntries.length} vs exchange=${openExchangePositions.length}`);
        }
        printOrderSample(managedOrders.grid, "GRID");
        printOrderSample(managedOrders.tp, "TP");
        printOrderSample(managedOrders.sl, "SL");
        if (activeEntries.length === 0) {
            console.log("[STATUS] No active positions.");
            return;
        }
        activeEntries.forEach(([positionKey, position]) => printPositionLine(positionKey, position, currentPrice));
    };

    return {
        buildExchangeOrderParams,
        fetchOpenExchangePositions,
        snapshotPositionRuntimeState,
        didPositionRuntimeStateChange,
        maybePersistActivePositionRuntimeState,
        updateActivePositionExtremes,
        applyTrailingStopUpdate,
        calculatePositionPnL,
        printDetailedStatus
    };
};

module.exports = { createRuntimePositionUtils };
