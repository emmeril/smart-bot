const createRuntimePositionUtils = ({
    getDb,
    getExchange,
    getMetrics,
    isHedgeModeEnabled,
    getOrderPositionSide,
    normalizeSymbol,
    getExchangePositionContracts,
    toFiniteNumber,
    saveDB,
    getLastPositionRuntimePersistAt,
    setLastPositionRuntimePersistAt,
    positionRuntimePersistTtl,
    getPrice,
    getOHLCV,
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
    formatPriceToMarketPrecision,
    resolveAdaptiveRiskOverrides,
    formatStatusTimestamp,
    printStatusLine,
    printOrderSample,
    printPositionLine
}) => {
    const buildExchangeOrderParams = ({ side, reduceOnly = false, positionSide, closePosition = false } = {}) => {
        const params = {
            newOrderRespType: "RESULT"
        };
        if (isHedgeModeEnabled()) {
            const resolvedPositionSide = positionSide || getOrderPositionSide(side);
            if (resolvedPositionSide && resolvedPositionSide !== "BOTH") params.positionSide = resolvedPositionSide;
        } else if (closePosition) {
            params.closePosition = true;
        } else if (reduceOnly) {
            params.reduceOnly = true;
        }
        return params;
    };

    const fetchOpenExchangePositions = async () => {
        const exchange = getExchange();
        const db = getDb();
        const metrics = getMetrics();
        metrics.api.positions++;
        const positions = await exchange.fetchPositions([db.pair]);
        return positions.filter((position) => (
            normalizeSymbol(position.symbol) === normalizeSymbol(db.pair) &&
            Math.abs(getExchangePositionContracts(position)) > 0
        ));
    };

    const snapshotPositionRuntimeState = (position) => ({
        highestSinceEntry: toFiniteNumber(position?.highestSinceEntry, null),
        lowestSinceEntry: toFiniteNumber(position?.lowestSinceEntry, null),
        stopLossPrice: toFiniteNumber(position?.stopLossPrice, null),
        stopLossUSDT: toFiniteNumber(position?.stopLossUSDT, null),
        trailingActivateATR: toFiniteNumber(position?.trailingActivateATR, null),
        trailingOffsetATR: toFiniteNumber(position?.trailingOffsetATR, null),
        trailingRiskModel: position?.trailingRiskModel || null,
        trailingRiskSource: position?.trailingRiskSource || null
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

    const applyTrailingStopUpdate = async (position, currentPrice = NaN) => {
        const db = getDb();
        const trailingEnabled = position?.trailingEnabled ?? db.trailingEnabled;
        if (!trailingEnabled || !Number.isFinite(position.atrAtEntry) || position.atrAtEntry <= 0) return;
        const ohlcv = await getOHLCV(Math.max(80, Math.trunc(toFiniteNumber(db?.atrPeriod, 14) * 4)));
        const adaptiveRiskOverrides = await resolveAdaptiveRiskOverrides({
            pair: db?.pair,
            timeframe: db?.gridTimeframe,
            atrPeriod: db?.atrPeriod,
            currentPrice,
            localOhlcv: ohlcv,
            baseActivateATR: position.trailingActivateATR ?? db.trailingActivateATR,
            baseOffsetATR: position.trailingOffsetATR ?? db.trailingOffsetATR
        });
        const effectiveTrailingActivateATR = toFiniteNumber(adaptiveRiskOverrides.trailingActivateATR, toFiniteNumber(position.trailingActivateATR, db.trailingActivateATR));
        const effectiveTrailingOffsetATR = toFiniteNumber(adaptiveRiskOverrides.trailingOffsetATR, toFiniteNumber(position.trailingOffsetATR, db.trailingOffsetATR));
        position.trailingActivateATR = effectiveTrailingActivateATR;
        position.trailingOffsetATR = effectiveTrailingOffsetATR;
        position.trailingRiskModel = adaptiveRiskOverrides.trailingRiskModel || position.trailingRiskModel || "STATIC";
        position.trailingRiskSource = adaptiveRiskOverrides.trailingRiskSource || position.trailingRiskSource || "config";
        position.trailingRiskReason = adaptiveRiskOverrides.trailingRiskReason || null;
        position.trailingRiskMeta = adaptiveRiskOverrides.trailingRiskMeta || null;
        const trailActivationMove = effectiveTrailingActivateATR * position.atrAtEntry;
        const trailOffsetMove = effectiveTrailingOffsetATR * position.atrAtEntry;

        if (position.side === "buy") {
            const activated = position.highestSinceEntry >= position.entryPrice + trailActivationMove;
            if (!activated) return;
            const trailedStop = formatPriceToMarketPrecision(db.pair, position.highestSinceEntry - trailOffsetMove);
            if (!Number.isFinite(position.stopLossPrice) || trailedStop > position.stopLossPrice) {
                position.stopLossPrice = trailedStop;
                position.stopLossUSDT = -Math.abs(position.stopLossPrice - position.entryPrice) * position.quantity;
            }
            return;
        }

        const activated = position.lowestSinceEntry <= position.entryPrice - trailActivationMove;
        if (!activated) return;
        const trailedStop = formatPriceToMarketPrecision(db.pair, position.lowestSinceEntry + trailOffsetMove);
        if (!Number.isFinite(position.stopLossPrice) || trailedStop < position.stopLossPrice) {
            position.stopLossPrice = trailedStop;
            position.stopLossUSDT = -Math.abs(position.stopLossPrice - position.entryPrice) * position.quantity;
        }
    };

    const calculatePositionPnL = (position, currentPrice, quantityOverride = null) => {
        const db = getDb();
        const quantity = Number.isFinite(quantityOverride) ? quantityOverride : position.quantity;
        const leverageAtEntry = Math.max(1, toFiniteNumber(position?.leverageAtEntry, db.leverage));
        
        const exchangePnlSnapshot = !Number.isFinite(quantityOverride) ? position?.exchangePnlSnapshot : null;
        const hasFreshExchangePnl = exchangePnlSnapshot &&
            exchangePnlSnapshot.source === "exchange" &&
            Number.isFinite(exchangePnlSnapshot.timestamp) &&
            (Date.now() - exchangePnlSnapshot.timestamp) <= 10000 &&
            Number.isFinite(exchangePnlSnapshot.grossProfitUSDT) &&
            Number.isFinite(exchangePnlSnapshot.netProfitUSDT) &&
            Number.isFinite(exchangePnlSnapshot.profitPercent);
        
        const TAKER_FEE_RATE = 0.0004;
        const MAKER_FEE_RATE = 0.0002;
        const estimatedEntryFee = position.entryPrice * quantity * TAKER_FEE_RATE;
        const estimatedExitFee = currentPrice * quantity * TAKER_FEE_RATE;
        const totalEstimatedFees = estimatedEntryFee + estimatedExitFee;
        const fundingRateEstimate = 0.0001;
        const fundingIntervalHours = 8;
        const hoursSinceEntry = Math.max(1, (Date.now() - (position.entryTime || Date.now())) / 3600000);
        const fundingIntervals = Math.floor(hoursSinceEntry / fundingIntervalHours);
        const estimatedFunding = (position.entryPrice * quantity * fundingRateEstimate) * Math.max(0, fundingIntervals);

        if (hasFreshExchangePnl) {
            const exchangeNetProfit = exchangePnlSnapshot.netProfitUSDT;
            const exchangeFee = Number.isFinite(exchangePnlSnapshot.fee) ? exchangePnlSnapshot.fee : 0;
            const entryValue = position.entryPrice * quantity;
            const referenceInitialMargin = Math.max(entryValue / leverageAtEntry, 1e-8);
            const profitPercent = (exchangePnlSnapshot.grossProfitUSDT / referenceInitialMargin) * 100;
            const displayProfitPercent = (exchangeNetProfit / referenceInitialMargin) * 100;

            return {
                grossProfitUSDT: exchangePnlSnapshot.grossProfitUSDT,
                netProfitUSDT: exchangeNetProfit,
                realizedProfitUSDT: exchangeNetProfit,
                profitPercent: profitPercent,
                displayProfitUSDT: exchangeNetProfit,
                displayProfitPercent: displayProfitPercent,
                fees: exchangeFee,
                funding: exchangePnlSnapshot.funding || 0,
                currentPrice: Number.isFinite(exchangePnlSnapshot.currentPrice) ? exchangePnlSnapshot.currentPrice : currentPrice,
                source: "exchange",
                syncedAt: exchangePnlSnapshot.timestamp
            };
        }

        const entryValue = position.entryPrice * quantity;
        const snapshotMarkPrice = toFiniteNumber(exchangePnlSnapshot?.markPrice, NaN);
        const priceSource = Number.isFinite(snapshotMarkPrice) && snapshotMarkPrice > 0
            ? snapshotMarkPrice
            : currentPrice;

        const grossProfitUSDT = position.side === "buy"
            ? (priceSource - position.entryPrice) * quantity
            : (position.entryPrice - priceSource) * quantity;
        const netProfitUSDT = grossProfitUSDT - totalEstimatedFees - estimatedFunding;
        const referenceInitialMargin = Math.max(entryValue / leverageAtEntry, 1e-8);
        const profitPercent = (grossProfitUSDT / referenceInitialMargin) * 100;
        const displayProfitPercent = (netProfitUSDT / referenceInitialMargin) * 100;

        return {
            grossProfitUSDT: grossProfitUSDT,
            netProfitUSDT: netProfitUSDT,
            realizedProfitUSDT: netProfitUSDT,
            profitPercent: profitPercent,
            displayProfitUSDT: netProfitUSDT,
            displayProfitPercent: displayProfitPercent,
            fees: totalEstimatedFees,
            funding: estimatedFunding,
            currentPrice: priceSource,
            source: "local",
            syncedAt: null
        };
    };

    const printDetailedStatus = async () => {
        const db = getDb();
        if (!db) return;
        const currentPrice = await getPrice();
        const activeEntries = getActivePositionEntries();
        let openExchangePositions = [];
        let managedOrders = { grid: [], tp: [], sl: [] };

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
        const gridSummary = getGridRuntimeSummary(currentPrice, managedOrders);
        const recoveryReason = getExchangeRecoveryReason();
        const accountPositionMode = getAccountPositionMode();
        const exchangeHealth = getExchangeHealth();

        console.log(`[STATUS] Mode=${accountPositionMode.label} | Pair=${db.pair} | Price=${Number.isFinite(currentPrice) ? currentPrice : "N/A"} | LocalActive=${activeEntries.length} | ExchangePos=${openExchangePositions.length}`);
        printStatusLine("Profile", `${gridSummary.presetName.toUpperCase()} | Grid=${gridSummary.gridLevelsMode === "AUTO" ? `AUTO ${gridSummary.effectiveGridLevels}` : gridSummary.effectiveGridLevels} | Range=${gridSummary.gridRangeMode === "AUTO" ? `AUTO ${gridSummary.effectiveGridRangePercent}%` : `${gridSummary.effectiveGridRangePercent}%`} | Buffer=${gridSummary.gridEntryBufferMode === "AUTO" ? `AUTO ${gridSummary.effectiveGridEntryBufferPercent}%` : `${gridSummary.effectiveGridEntryBufferPercent}%`} | Slot=${gridSummary.slotLabel} | Ladder=${gridSummary.ladderLabel}`);
        printStatusLine("Side Orders", `${gridSummary.ordersMode}=${gridSummary.effectiveOrdersPerSide}/${gridSummary.configuredOrdersPerSideCap} | Size ${gridSummary.sizeMode}=${gridSummary.effectiveOrderSizeUsdt.toFixed(4)} USDT | Min Valid=${gridSummary.minOrderSizeUsdt.toFixed(4)} USDT | Available USDT=${gridSummary.availableUsdtLabel}`);
        printStatusLine("Daily P&L", `${db.dailyPnL.toFixed(2)} USDT | Trades=${db.dailyTrades}`);
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
