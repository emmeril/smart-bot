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
        const version = "v1.0.0";
        const timestamp = new Date().toISOString();

        console.log("\n" + "=".repeat(70));
        console.log("  ██████╗ ███████╗███████╗██╗     ██╗███╗   ██╗███████╗");
        console.log("  ██╔══██╗██╔════╝██╔════╝██║     ██║████╗  ██║██╔════╝");
        console.log("  ██║  ██║█████╗  █████╗  ██║     ██║██╔██╗ ██║█████╗  ");
        console.log("  ██║  ██║██╔══╝  ██╔══╝  ██║     ██║██║╚██╗██║██╔══╝  ");
        console.log("  ██████╔╝███████╗███████╗███████╗██║██║ ╚████║███████╗");
        console.log("  ╚═════╝ ╚══════╝╚══════╝╚══════╝╚═╝╚═╝  ╚═══╝╚══════╝");
        console.log("=".repeat(70));
        console.log(`  Automated Futures Grid Trading System ${version}`);
        console.log(`  Started: ${timestamp}`);
        console.log("=".repeat(70));
        console.log("  [CONFIGURATION]");
        console.log(`  ├─ Exchange       : Binance USDT-M Futures`);
        console.log(`  ├─ Symbol         : ${db.pair}`);
        console.log(`  ├─ Strategy       : ${String(db.strategy || "futures_grid").toUpperCase()}`);
        console.log(`  ├─ Timeframe      : ${db.gridTimeframe}`);
        console.log(`  ├─ Leverage       : ${db.leverage}x`);
        console.log(`  ├─ Margin Mode    : ${String(db.marginMode || "isolated").toUpperCase()}`);
        console.log(`  └─ Position Mode  : ${accountPositionMode.label}`);
        console.log("  [GRID PARAMETERS]");
        const gridLevelsLabel = gridSummary.gridLevelsMode === "AUTO"
            ? `AUTO ${gridSummary.effectiveGridLevels} levels`
            : `${gridSummary.effectiveGridLevels} levels`;
        const gridRangeLabel = gridSummary.gridRangeMode === "AUTO"
            ? `AUTO ${gridSummary.effectiveGridRangePercent}%`
            : `${gridSummary.effectiveGridRangePercent}%`;
        const gridBufferLabel = gridSummary.gridEntryBufferMode === "AUTO"
            ? `AUTO ${gridSummary.effectiveGridEntryBufferPercent}%`
            : `${gridSummary.effectiveGridEntryBufferPercent}%`;
        console.log(`  ├─ Levels         : ${gridLevelsLabel}`);
        console.log(`  ├─ Lookback       : ${db.gridLookbackCandles} candles`);
        console.log(`  ├─ Range          : ${gridRangeLabel}`);
        console.log(`  ├─ Entry Buffer   : ${gridBufferLabel}`);
        const tpLabel = formatGridTpSlLabel(db.gridTakeProfitLevels, "AUTO_NEXT_GRID", "level(s)");
        const slLabel = formatGridTpSlLabel(db.gridStopLossLevels, "AUTO_RANGE", "step(s)");
        console.log(`  ├─ Take Profit    : ${tpLabel}`);
        console.log(`  ├─ Stop Loss      : ${slLabel}`);
        console.log(`  ├─ Orders/Side    : ${gridSummary.ordersMode} ${gridSummary.effectiveOrdersPerSide}/${gridSummary.configuredOrdersPerSideCap}`);
        console.log(`  └─ Order Size     : ${gridSummary.sizeMode} ${gridSummary.effectiveOrderSizeUsdt.toFixed(4)} USDT`);
        if (gridSummary.hasLockedGrid) {
            console.log("  [LOCKED GRID]");
            console.log(`  ├─ Range: ${gridSummary.lockedRangeLabel}`);
            console.log(`  └─ Step : ${gridSummary.stepLabel}`);
        }
        console.log("  [RISK MANAGEMENT]");
        console.log(`  ├─ Min Order Size : ${gridSummary.minOrderSizeUsdt.toFixed(4)} USDT`);
        console.log(`  ├─ Available USDT : ${gridSummary.availableUsdtLabel}`);
        console.log(`  ├─ Daily Target   : $${db.dailyProfitTargetUsdt}`);
        console.log(`  ├─ Max Daily Loss : ${db.dailyMaxLossPercent}%`);
        console.log(`  ├─ Max Trades     : ${db.maxTradesPerDay} per day`);
        console.log(`  ├─ Volume Filter  : ${db.minVolumeRatio}x over ${db.volumePeriod} periods`);
        console.log(`  ├─ Trailing ATR   : ${formatTrailingLabel()}`);
        console.log(`  ├─ Session        : ${db.sessionStartUTC}-${db.sessionEndUTC} UTC`);
        console.log(`  └─ Preset Profile : ${gridSummary.presetName.toUpperCase()}`);
        console.log("  [ACCOUNT]");
        console.log(`  └─ Total Balance  : $${totalUSDT.toFixed(2)} USDT`);
        console.log("=".repeat(70));
        console.log("  Bot is initializing... Dashboard available at http://localhost:3000");
        console.log("=".repeat(70) + "\n");
    };

    return {
        resetMetricWindow,
        resetDailyTradeMetrics,
        printStartupBanner
    };
};

module.exports = { createRuntimeReportingHelpers };
