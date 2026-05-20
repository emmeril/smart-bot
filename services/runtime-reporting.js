const createRuntimeReportingHelpers = ({
    getMetrics,
    getDb,
    getGridRuntimeSummary,
    getAccountPositionMode
}) => {
    const resetMetricWindow = () => {
        const metrics = getMetrics();
        metrics.windowStart = Date.now();
        metrics.api.ticker = 0;
        metrics.api.ohlcv = 0;
        metrics.api.balance = 0;
        metrics.api.positions = 0;
        metrics.api.orders = 0;
        metrics.signals.analyzed = 0;
        metrics.signals.crossoverDetected = 0;
        metrics.signals.longConfirmed = 0;
        metrics.signals.shortConfirmed = 0;
    };

    const resetDailyTradeMetrics = () => {
        const metrics = getMetrics();
        metrics.trades.opened = 0;
        metrics.trades.closed = 0;
        metrics.trades.wins = 0;
        metrics.trades.losses = 0;
        if (metrics.orderRecovery && typeof metrics.orderRecovery === "object") {
            metrics.orderRecovery.duplicateDetected = 0;
            metrics.orderRecovery.duplicateResolved = 0;
            metrics.orderRecovery.timeoutErrors = 0;
            metrics.orderRecovery.replacementAttempts = 0;
            metrics.orderRecovery.replacementSucceeded = 0;
        }
    };

    const printStartupBanner = (totalUSDT) => {
        const db = getDb();
        const gridSummary = getGridRuntimeSummary();
        const accountPositionMode = getAccountPositionMode();
        const formatGridTpSlLabel = (levels, fallbackLabel, unitLabel) => (
            levels <= 0 ? fallbackLabel : `${levels} ${unitLabel}`
        );
        const formatTrailingLabel = () => (
            db.trailingEnabled ? `${db.trailingActivateATR}/${db.trailingOffsetATR}x` : "OFF"
        );

        console.log("\n" + "=".repeat(70));
        console.log("BINANCE-STYLE SPOT GRID BOT");
        console.log("=".repeat(70));
        console.log(`Balance: $${totalUSDT.toFixed(2)}`);
        console.log(`Pair: ${db.pair}`);
        console.log(`Strategy: ${String(db.strategy || "spot_grid").toUpperCase()} on ${db.gridTimeframe}`);
        console.log(`Preset Profile: ${gridSummary.presetName.toUpperCase()}`);
        console.log(`Position Mode: ${accountPositionMode.label}`);
        const gridLevelsLabel = gridSummary.gridLevelsMode === "AUTO"
            ? `AUTO ${gridSummary.effectiveGridLevels} levels`
            : `${gridSummary.effectiveGridLevels} levels`;
        const gridRangeLabel = gridSummary.gridRangeMode === "AUTO"
            ? `AUTO ${gridSummary.effectiveGridRangePercent}%`
            : `${gridSummary.effectiveGridRangePercent}%`;
        const gridBufferLabel = gridSummary.gridEntryBufferMode === "AUTO"
            ? `AUTO ${gridSummary.effectiveGridEntryBufferPercent}%`
            : `${gridSummary.effectiveGridEntryBufferPercent}%`;
        console.log(`Grid: ${gridLevelsLabel} | lookback ${db.gridLookbackCandles} candles | range ${gridRangeLabel} | buffer ${gridBufferLabel}`);
        const tpLabel = formatGridTpSlLabel(db.gridTakeProfitLevels, "AUTO_NEXT_GRID", "level(s)");
        const slLabel = formatGridTpSlLabel(db.gridStopLossLevels, "AUTO_RANGE", "step(s)");
        console.log(`Grid TP/SL: ${tpLabel} / ${slLabel} | mode ${gridSummary.ordersMode} ${gridSummary.effectiveOrdersPerSide}/${gridSummary.configuredOrdersPerSideCap} order(s) per side`);
        console.log(`Grid Order Size: mode ${gridSummary.sizeMode} ${gridSummary.effectiveOrderSizeUsdt.toFixed(4)} USDT`);
        console.log(`Min Valid Order Size: ${gridSummary.minOrderSizeUsdt.toFixed(4)} USDT`);
        console.log(`Available USDT: ${gridSummary.availableUsdtLabel}`);
        if (gridSummary.hasLockedGrid) {
            console.log(`Locked Grid Range: ${gridSummary.lockedRangeLabel}`);
            console.log(`Grid Step: ${gridSummary.stepLabel}`);
        }
        console.log(`Volume filter: ${db.minVolumeRatio}x over ${db.volumePeriod} periods`);
        console.log(`Session: ${db.sessionStartUTC}-${db.sessionEndUTC} UTC`);
        console.log(`Trailing ATR: ${formatTrailingLabel()}`);
        console.log("Mode: SPOT");
        console.log("=".repeat(70) + "\n");
    };

    return {
        resetMetricWindow,
        resetDailyTradeMetrics,
        printStartupBanner
    };
};

module.exports = { createRuntimeReportingHelpers };
