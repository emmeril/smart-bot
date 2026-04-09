require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const ccxt = require("ccxt");
const { createConfigModelHelpers } = require("./services/config-model");
const { createConfigPersistenceHelpers } = require("./services/config-persistence");
const { createConfigRuntimeHelpers } = require("./services/config-runtime");
const { createGridRuntimeHelpers } = require("./services/grid-runtime");
const { createRuntimeUtils } = require("./services/runtime-utils");
const {
    sequelize,
    Config,
    BOOLEAN_CONFIG_KEYS,
    VALID_MARGIN_MODES,
    DEFAULT_CONFIG,
    DASHBOARD_EDITABLE_FIELDS,
    DASHBOARD_EDITABLE_KEYS,
    RUNTIME_PROTECTED_CONFIG_KEYS,
    DASHBOARD_PROTECTED_KEYS,
    DASHBOARD_USERNAME,
    DASHBOARD_PASSWORD,
    DASHBOARD_SESSION_SECRET,
    DASHBOARD_SESSION_COOKIE,
    DASHBOARD_SESSION_TTL_MS,
    CONFIG_AUTO_RELOAD_INTERVAL_MS
} = require("./services/database-config");
const { createDashboardConfigHelpers } = require("./services/dashboard-config");
const { createDashboardStatusHelpers } = require("./services/dashboard-status");
const { createDashboardSessionHelpers } = require("./services/dashboard-session");
const { createExchangePositionHelpers } = require("./services/exchange-position");
const { createManagedOrdersHelpers } = require("./services/managed-orders");
const { createOrderExecutionHelpers } = require("./services/order-execution");
const { createPositionLifecycleHelpers } = require("./services/position-lifecycle");
const { createTradeEntryHelpers } = require("./services/trade-entry");
const { createTradeLogicHelpers } = require("./services/trade-logic");
const { createPositionStateHelpers } = require("./services/position-state");
const { createRuntimeSchedulerHelpers } = require("./services/runtime-scheduler");

// -------------------- GLOBAL VARIABLES --------------------
let isProcessing = false;
let isPlacingOrder = false;
let isClosingPosition = false;
let exchange = null;
let signalCount = 0;
let lastLogTime = Date.now();
let lastPnlLog = Date.now();
let lastPositionRuntimePersistAt = 0;
let lastTradeAt = 0;
let balanceCache = { totalUSDT: 0, availableUSDT: 0, lastUpdate: 0 };
let tickerCache = { price: null, lastUpdate: 0 };
let ohlcvCache = { key: "", data: null, lastUpdate: 0 };
let pnlMonitorTimer = null;
let currentPnLMonitoringInterval = 0;
let isMonitoringPnL = false;
let positionSyncTimer = null;
let currentPositionSyncInterval = 0;
let isSyncingPosition = false;
let isSyncingGridOrders = false;
const closingPositionKeys = new Set();
let mainLoopTimer = null;
let metricsTimer = null;
let lastSignalDetailLogAt = 0;
let lastSyncLogAt = 0;
let lastGridSyncLogAt = 0;
let lastGridExposureLogAt = 0;
let lastGridExposureLogKey = "";
let lastGridSizingSkipLogAt = 0;
let lastGridSizingSkipReason = "";
let hasLoggedTriggerOrderFetchFallback = false;
let lastAppliedLeverageState = { symbol: "", leverage: 0 };
const gridSizingStateLogCache = new Map();
let isShuttingDown = false;
let accountPositionMode = { hedged: false, label: "ONE_WAY" };
let runtimeCommandsRegistered = false;
let webServer = null;
let configReloadTimer = null;
let exchangeHealth = {
    isHealthy: false,
    needsRecoverySync: true,
    consecutiveFailures: 0,
    lastFailureAt: 0,
    lastRecoveryAt: 0,
    lastError: "",
    lastContext: ""
};
let lastRecoveryBlockLogAt = 0;
const logPath = path.join(__dirname, 'trades.csv');
let db = null;
const BALANCE_CACHE_TTL = 15000;
const TICKER_CACHE_TTL = 800;
const OHLCV_CACHE_TTL = 1500;
const SYNC_LOG_TTL = 15000;
const SIGNAL_DETAIL_LOG_TTL = 10000;
const GRID_SYNC_LOG_TTL = 15000;
const GRID_SIZING_SKIP_LOG_TTL = 30000;
const GRID_SIZING_STATE_LOG_TTL = 30000;
const METRICS_LOG_INTERVAL = 60000;
const POSITION_RUNTIME_PERSIST_TTL = 2000;
const POSITION_SYNC_QTY_TOLERANCE = 0.001;
const POSITION_SYNC_ENTRY_TOLERANCE_PCT = 0.05;
const GRID_CLIENT_ORDER_PREFIX = "smartgrid";
const TP_CLIENT_ORDER_PREFIX = "smarttp";
const SL_CLIENT_ORDER_PREFIX = "smartsl";

let metrics = {
    windowStart: Date.now(),
    api: { ticker: 0, ohlcv: 0, balance: 0, positions: 0, orders: 0 },
    signals: { analyzed: 0, crossoverDetected: 0, longConfirmed: 0, shortConfirmed: 0 },
    trades: { opened: 0, closed: 0, wins: 0, losses: 0 }
};

const {
    retry,
    sleep,
    toFiniteNumber,
    clamp,
    formatRuntimeTimestamp,
    getUTCDateKey,
    isSameUTCDate,
    markExchangeUnhealthy,
    markExchangeHealthy,
    getExchangeRecoveryReason,
    canOpenNewPositions,
    logExchangeRecoveryBlock,
    hasRuntimePositionMutationInFlight,
    withSqliteBusyRetry,
    ensureFileExists
} = createRuntimeUtils({
    getExchangeHealth: () => exchangeHealth,
    getLastRecoveryBlockLogAt: () => lastRecoveryBlockLogAt,
    setLastRecoveryBlockLogAt: (value) => { lastRecoveryBlockLogAt = value; },
    getIsPlacingOrder: () => isPlacingOrder,
    getIsClosingPosition: () => isClosingPosition,
    getIsSyncingPosition: () => isSyncingPosition
});

const formatAmountToMarketPrecision = (symbol, amount) => {
    const numericAmount = Number(amount);
    if (!exchange || !symbol || !Number.isFinite(numericAmount)) return NaN;
    try { return Number.parseFloat(exchange.amountToPrecision(symbol, numericAmount)); } catch { return numericAmount; }
};

const formatPriceToMarketPrecision = (symbol, price) => {
    const numericPrice = Number(price);
    if (!exchange || !symbol || !Number.isFinite(numericPrice)) return NaN;
    try { return Number.parseFloat(exchange.priceToPrecision(symbol, numericPrice)); } catch { return numericPrice; }
};

const calcATR = (highs, lows, closes, period) => {
    const out = Array(closes.length).fill(null);
    if (!Array.isArray(highs) || !Array.isArray(lows) || !Array.isArray(closes) || closes.length <= period) return out;

    const tr = Array(closes.length).fill(0);
    for (let i = 1; i < closes.length; i++) {
        const hl = highs[i] - lows[i];
        const hc = Math.abs(highs[i] - closes[i - 1]);
        const lc = Math.abs(lows[i] - closes[i - 1]);
        tr[i] = Math.max(hl, hc, lc);
    }

    let seed = 0;
    for (let i = 1; i <= period; i++) seed += tr[i];
    out[period] = seed / period;
    for (let i = period + 1; i < closes.length; i++) {
        out[i] = ((out[i - 1] * (period - 1)) + tr[i]) / period;
    }
    return out;
};

const resetMetricWindow = () => {
    metrics.windowStart = Date.now();
    metrics.api.ticker = 0; metrics.api.ohlcv = 0; metrics.api.balance = 0; metrics.api.positions = 0; metrics.api.orders = 0;
    metrics.signals.analyzed = 0; metrics.signals.crossoverDetected = 0; metrics.signals.longConfirmed = 0; metrics.signals.shortConfirmed = 0;
};

const resetDailyTradeMetrics = () => {
    metrics.trades.opened = 0; metrics.trades.closed = 0; metrics.trades.wins = 0; metrics.trades.losses = 0;
};

const clearRuntimeTimers = () => {
    const timers = [
        [pnlMonitorTimer, () => { pnlMonitorTimer = null; }],
        [positionSyncTimer, () => { positionSyncTimer = null; }],
        [mainLoopTimer, () => { mainLoopTimer = null; }],
        [metricsTimer, () => { metricsTimer = null; }],
        [configReloadTimer, () => { configReloadTimer = null; }]
    ];
    for (const [timer, resetTimer] of timers) {
        if (!timer) continue;
        clearInterval(timer);
        resetTimer();
    }
};

const printStartupBanner = (totalUSDT) => {
    const gridSummary = getGridRuntimeSummary();
    const formatGridTpSlLabel = (levels, fallbackLabel, unitLabel) => (
        levels <= 0 ? fallbackLabel : `${levels} ${unitLabel}`
    );
    const formatTrailingLabel = () => (
        db.trailingEnabled ? `${db.trailingActivateATR}/${db.trailingOffsetATR}x` : "OFF"
    );

    console.log("\n" + "=".repeat(70));
    console.log("BINANCE-STYLE FUTURES GRID BOT");
    console.log("=".repeat(70));
    console.log(`Balance: $${totalUSDT.toFixed(2)}`);
    console.log(`Pair: ${db.pair}`);
    console.log(`Strategy: ${String(db.strategy || "futures_grid").toUpperCase()} on ${db.gridTimeframe}`);
    console.log(`Preset Profile: ${gridSummary.presetName.toUpperCase()}`);
    console.log(`Position Mode: ${accountPositionMode.label}`);
    console.log(`Grid: ${db.gridLevels} levels | lookback ${db.gridLookbackCandles} candles | range ${db.gridRangePercent}%`);
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
    console.log(`Leverage: ${db.leverage}x`);
    console.log(`Margin Mode: ${String(db.marginMode || "isolated").toUpperCase()}`);
    console.log(`Daily target: $${db.dailyProfitTargetUsdt} (max ${db.maxTradesPerDay} trades)`);
    console.log("=".repeat(70) + "\n");
};

const normalizeSymbol = (symbol) => String(symbol || "").toUpperCase().trim();
const isHedgeModeEnabled = () => accountPositionMode.hedged === true;

const {
    safeParseJSON,
    normalizeActivePositionState,
    normalizeConfig,
    hydrateConfig,
    serializeConfigForSave,
    getConfigRow,
    ensureConfigSchema
} = createConfigModelHelpers({
    sequelize,
    Config,
    booleanConfigKeys: BOOLEAN_CONFIG_KEYS,
    defaultConfig: DEFAULT_CONFIG,
    validMarginModes: VALID_MARGIN_MODES,
    withSqliteBusyRetry,
    getDefaultConfig: () => getDefaultConfig(),
    toFiniteNumber,
    clamp,
    isLegacySinglePosition: (...args) => isLegacySinglePosition(...args),
    toPositionMapKey: (...args) => toPositionMapKey(...args)
});

const {
    loadPersistedConfig,
    ensureConfigRow,
    persistConfig
} = createConfigPersistenceHelpers({
    getConfigRow,
    withSqliteBusyRetry,
    Config,
    getDefaultConfig: () => getDefaultConfig(),
    hydrateConfig,
    serializeConfigForSave,
    logCreated: () => console.log("[INFO] Created new config row")
});

const {
    getSignalParameters,
    resolveEffectiveGridTakeProfitLevels,
    resolveEffectiveGridStopLossSteps,
    findNearestGridLevelIndex,
    buildGridExitPlan,
    buildGridLevels,
    resolveGridOrdersPerSideCap,
    getMinimumGridOrderSizeUsdt,
    getMinimumValidatedGridOrderSizeUsdt,
    resolveEffectiveGridOrderSizeUsdt,
    resolveGridOrderSizeForPrice,
    resolveEffectiveGridOrdersPerSide,
    getGridStateFingerprint,
    sanitizeGridState,
    createLockedGridState,
    hasGridStateChanged,
    resolveActiveGridState,
    getGridClientOrderId,
    getTpClientOrderId,
    getSlClientOrderId,
    buildGridEntryOrders,
    getActiveGridExposureSides,
    filterGridOrdersForActiveExposure,
    resolveAutoPairPresetName,
    getActiveAutoPairPresetName,
    getGridRuntimeSummary,
    applyAutoPairGridPreset
} = createGridRuntimeHelpers({
    getDb: () => db,
    getExchange: () => exchange,
    getBalanceCache: () => balanceCache,
    getTickerCache: () => tickerCache,
    getSaveDB: () => saveDB,
    defaultConfig: DEFAULT_CONFIG,
    validMarginModes: VALID_MARGIN_MODES,
    normalizeConfig,
    normalizeSymbol,
    toFiniteNumber,
    clamp,
    formatPriceToMarketPrecision,
    formatAmountToMarketPrecision,
    validateOrderSize: (...args) => validateOrderSize(...args),
    isDirectionalOrderPlanValid: (...args) => isDirectionalOrderPlanValid(...args),
    getClosePositionSide: (...args) => getClosePositionSide(...args),
    isHedgeModeEnabled,
    getActivePositionsList: (...args) => getActivePositionsList(...args),
    getExchangePositionSide: (...args) => getExchangePositionSide(...args),
    getOrderTriggerPrice: (...args) => getOrderTriggerPrice(...args),
    gridClientOrderPrefix: GRID_CLIENT_ORDER_PREFIX,
    tpClientOrderPrefix: TP_CLIENT_ORDER_PREFIX,
    slClientOrderPrefix: SL_CLIENT_ORDER_PREFIX
});

const buildReplacementClientOrderId = (baseClientOrderId) => {
    const base = String(baseClientOrderId || "smartord").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 28);
    const suffix = Date.now().toString(36).slice(-7);
    return `${base}_${suffix}`.slice(0, 36);
};

const extractExchangeErrorCode = (error) => {
    const directCode = toFiniteNumber(error?.code, NaN);
    if (Number.isFinite(directCode)) return directCode;
    const payload = String(error?.message || error || "");
    const match = payload.match(/"code"\s*:\s*(-?\d+)/);
    return match ? Number(match[1]) : NaN;
};

const isExchangeTimestampError = (error) => {
    const payload = String(error?.message || error || "");
    const code = extractExchangeErrorCode(error);
    return code === -1021 || /timestamp.*ahead of the server's time|timestamp for this request was/i.test(payload);
};

const isDuplicateClientOrderIdError = (error) => {
    const payload = String(error?.message || error || "");
    const code = extractExchangeErrorCode(error);
    return code === -4116 || /clientorderid is duplicated|duplicated/i.test(payload);
};

const getExchangeClientOrderId = (order) => (
    String(order?.clientOrderId || order?.info?.clientOrderId || order?.info?.origClientOrderId || "")
);

const isGridEntryOrder = (order) => getExchangeClientOrderId(order).startsWith(GRID_CLIENT_ORDER_PREFIX);
const isTpReduceOnlyOrder = (order) => getExchangeClientOrderId(order).startsWith(TP_CLIENT_ORDER_PREFIX);
const isSlReduceOnlyOrder = (order) => getExchangeClientOrderId(order).startsWith(SL_CLIENT_ORDER_PREFIX);
const isTriggerManagedOrder = (order, label = "") => label === "SL" || isSlReduceOnlyOrder(order) || String(order?.type || "").toUpperCase().includes("STOP");

const {
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
} = createManagedOrdersHelpers({
    getExchange: () => exchange,
    getMetrics: () => metrics,
    getDb: () => db,
    normalizeSymbol,
    getExchangeClientOrderId,
    getOrderTriggerPrice: (...args) => getOrderTriggerPrice(...args),
    isGridEntryOrder,
    isTpReduceOnlyOrder,
    isSlReduceOnlyOrder,
    isTriggerManagedOrder,
    matchesOrderToTrackedPosition: (...args) => matchesOrderToTrackedPosition(...args),
    getHasLoggedTriggerOrderFetchFallback: () => hasLoggedTriggerOrderFetchFallback,
    setHasLoggedTriggerOrderFetchFallback: (value) => { hasLoggedTriggerOrderFetchFallback = value; }
});

const evaluateGridSignal = (snapshot, params, gridState = null) => {
    const recentClose = snapshot.close.slice(-(params.gridLookbackCandles));
    if (recentClose.length < params.gridLookbackCandles) {
        return {
            canLong: false, canShort: false, setupDetected: false,
            detailTitle: "BINANCE GRID ANALYSIS",
            extraDetailLines: ["   Not enough candle data to build grid range."]
        };
    }

    const resolvedGridState = sanitizeGridState(gridState, params) || createLockedGridState(snapshot, params);
    const referencePrice = toFiniteNumber(resolvedGridState?.referencePrice, NaN);
    const lowerBound = toFiniteNumber(resolvedGridState?.lowerBound, NaN);
    const upperBound = toFiniteNumber(resolvedGridState?.upperBound, NaN);
    const levels = resolvedGridState?.levels || [];
    const step = toFiniteNumber(resolvedGridState?.step, NaN);
    if (!Number.isFinite(step) || step <= 0) {
        return {
            canLong: false, canShort: false, setupDetected: false,
            detailTitle: "BINANCE GRID ANALYSIS",
            extraDetailLines: ["   Grid step is too small to evaluate safely."]
        };
    }
    const rawIndex = (snapshot.currentPrice - lowerBound) / step;
    const clampedIndex = clamp(rawIndex, 0, levels.length - 1);
    const lowerIndex = clamp(Math.floor(clampedIndex), 0, levels.length - 2);
    const upperIndex = clamp(lowerIndex + 1, 1, levels.length - 1);
    const currentLevelLow = levels[lowerIndex];
    const currentLevelHigh = levels[upperIndex];
    const buffer = snapshot.currentPrice * (params.gridEntryBufferPercent / 100);
    const distanceFromMidSteps = (snapshot.currentPrice - referencePrice) / step;
    const volumeOk = snapshot.volumeRatio >= db.minVolumeRatio;
    const sessionOk = db.sessionStartUTC <= db.sessionEndUTC
        ? snapshot.hourUTC >= db.sessionStartUTC && snapshot.hourUTC <= db.sessionEndUTC
        : snapshot.hourUTC >= db.sessionStartUTC || snapshot.hourUTC <= db.sessionEndUTC;
    const insideRange = snapshot.currentPrice >= lowerBound && snapshot.currentPrice <= upperBound;
    const meanReversionLong = db.allowLong && insideRange && distanceFromMidSteps <= -1 && snapshot.currentPrice <= currentLevelLow + buffer;
    const meanReversionShort = db.allowShort && insideRange && distanceFromMidSteps >= 1 && snapshot.currentPrice >= currentLevelHigh - buffer;
    const canLong = meanReversionLong && volumeOk && sessionOk;
    const canShort = meanReversionShort && volumeOk && sessionOk;
    const longExitPlan = buildGridExitPlan({
        side: "buy",
        entryIndex: lowerIndex,
        levels,
        step,
        params,
        gridState: resolvedGridState,
        atr: snapshot.currentATR
    });
    const shortExitPlan = buildGridExitPlan({
        side: "sell",
        entryIndex: upperIndex,
        levels,
        step,
        params,
        gridState: resolvedGridState,
        atr: snapshot.currentATR
    });
    const longTargetPrice = longExitPlan.targetPrice;
    const shortTargetPrice = shortExitPlan.targetPrice;
    const longStopPrice = longExitPlan.stopLossPrice;
    const shortStopPrice = shortExitPlan.stopLossPrice;
    const longPlan = canLong ? { targetPrice: longTargetPrice, stopLossPrice: longStopPrice } : null;
    const shortPlan = canShort ? { targetPrice: shortTargetPrice, stopLossPrice: shortStopPrice } : null;
    const longPlanValid = canLong ? isDirectionalOrderPlanValid("buy", currentLevelLow, longPlan) : false;
    const shortPlanValid = canShort ? isDirectionalOrderPlanValid("sell", currentLevelHigh, shortPlan) : false;
    const safeCanLong = canLong && longPlanValid;
    const safeCanShort = canShort && shortPlanValid;
    if (canLong && !longPlanValid) {
        console.warn(`[GRID] Long setup rejected because TP/SL would be invalid after precision rounding.`);
    }
    if (canShort && !shortPlanValid) {
        console.warn(`[GRID] Short setup rejected because TP/SL would be invalid after precision rounding.`);
    }

    return {
        canLong: safeCanLong,
        canShort: safeCanShort,
        setupDetected: safeCanLong || safeCanShort,
        detailTitle: "BINANCE GRID ANALYSIS",
        strategyName: "FUTURES_GRID",
        longPlan: safeCanLong ? { targetPrice: longTargetPrice, stopLossPrice: longStopPrice, gridIndex: lowerIndex } : null,
        shortPlan: safeCanShort ? { targetPrice: shortTargetPrice, stopLossPrice: shortStopPrice, gridIndex: upperIndex } : null,
        extraDetailLines: [
            `   Reference Price: ${referencePrice.toFixed(6)}`,
            `   Grid Range: ${lowerBound.toFixed(6)} - ${upperBound.toFixed(6)}`,
            `   Grid Levels: ${params.gridLevels} | Step: ${step.toFixed(6)}`,
            `   TP/SL Mode: TP ${params.gridTakeProfitLevels <= 0 ? "AUTO_NEXT_GRID" : `${resolveEffectiveGridTakeProfitLevels(params.gridTakeProfitLevels)} GRID`} | SL ${params.gridStopLossLevels <= 0 ? `AUTO_RANGE ${longExitPlan.stopLossSteps.toFixed(2)} step` : `${resolveEffectiveGridStopLossSteps(params.gridStopLossLevels, step, snapshot.currentATR).toFixed(2)} step`}`,
            `   Current Slot: ${lowerIndex}/${params.gridLevels} (${currentLevelLow.toFixed(6)} - ${currentLevelHigh.toFixed(6)})`,
            `   Distance From Mid: ${distanceFromMidSteps.toFixed(2)} steps`,
            `   Volume Ratio: ${snapshot.volumeRatio.toFixed(2)}x (min ${db.minVolumeRatio}x) -> ${volumeOk ? "[OK]" : "[NO]"}`,
            `   Session Filter: ${sessionOk ? "[OK]" : "[NO]"}`,
            `   Long Grid Re-entry: ${meanReversionLong ? "[OK]" : "[NO]"}`,
            `   Short Grid Re-entry: ${meanReversionShort ? "[OK]" : "[NO]"}`,
            `   Long TP/SL Valid: ${longPlanValid ? "[OK]" : "[NO]"}`,
            `   Short TP/SL Valid: ${shortPlanValid ? "[OK]" : "[NO]"}`
        ]
    };
};

const applySignalGuards = (signalState, snapshot) => {
    const safeSignal = {
        canLong: Boolean(signalState?.canLong),
        canShort: Boolean(signalState?.canShort),
        setupDetected: Boolean(signalState?.setupDetected),
        detailTitle: signalState?.detailTitle || "SIGNAL ANALYSIS",
        strategyName: signalState?.strategyName || "UNKNOWN",
        longPlan: signalState?.longPlan || null,
        shortPlan: signalState?.shortPlan || null,
        extraDetailLines: Array.isArray(signalState?.extraDetailLines) ? signalState.extraDetailLines : []
    };

    const currentPrice = toFiniteNumber(snapshot?.currentPrice, NaN);
    const currentATR = toFiniteNumber(snapshot?.currentATR, NaN);
    if (!Number.isFinite(currentPrice) || currentPrice <= 0 || !Number.isFinite(currentATR) || currentATR <= 0) {
        return {
            ...safeSignal,
            canLong: false,
            canShort: false,
            setupDetected: false,
            extraDetailLines: [...safeSignal.extraDetailLines, "   Signal rejected: invalid price or ATR snapshot."]
        };
    }

    return {
        ...safeSignal,
        setupDetected: safeSignal.canLong || safeSignal.canShort
    };
};

const logSignalDetails = (params, snapshot, signalState) => {
    const printSignalHeader = () => {
        console.log("\n" + "=".repeat(50));
        console.log(`${signalState.detailTitle} (${db.gridTimeframe}):`);
        console.log(`   Current Price: ${snapshot.currentPrice}`);
        console.log(`   Current Volume: ${snapshot.currentVolume.toFixed(2)}`);
        console.log(`   Avg Volume (${params.volumePeriod}): ${snapshot.avgVolume.toFixed(2)}`);
        console.log(`   Volume Ratio: ${snapshot.volumeRatio.toFixed(2)}x`);
        console.log(`   ATR ${params.atrPeriod}: ${snapshot.currentATR.toFixed(6)}`);
    };
    const printSignalSection = (title, lines) => {
        console.log("");
        console.log(title);
        lines.forEach((line) => console.log(line));
    };
    const printFinalSignalLine = (label, confirmed) => (
        console.log(`   ${label} Signal: ${confirmed ? "[OK] CONFIRMED" : "[NO] NOT CONFIRMED"}`)
    );

    printSignalHeader();
    printSignalSection("SETUP CONDITIONS:", signalState.extraDetailLines);
    console.log("");
    console.log("FINAL SIGNAL:");
    printFinalSignalLine("LONG", signalState.canLong);
    printFinalSignalLine("SHORT", signalState.canShort);
    console.log("=".repeat(50));
};

const formatStatusTimestamp = (value) => (value > 0 ? new Date(value).toISOString() : "N/A");

const printStatusLine = (label, value) => {
    console.log(`[STATUS] ${label}=${value}`);
};

const printOrderSample = (orders, typeLabel) => {
    orders.slice(0, 4).forEach((order) => console.log(`   ${formatOrderSummary(order, typeLabel)}`));
};

const printPositionLine = (positionKey, position, currentPrice) => {
    const pnlState = Number.isFinite(currentPrice) ? calculatePositionPnL(position, currentPrice) : null;
    console.log(`   [${positionKey}] side=${String(position.side || "").toUpperCase()} qty=${position.quantity} entry=${position.entryPrice}`);
    console.log(`   [${positionKey}] tp=${position.targetPrice ?? "N/A"} sl=${position.stopLossPrice ?? "N/A"} strategy=${position.strategy || "N/A"}`);
    console.log(`   [${positionKey}] tpOrder=${position.tpClientOrderId ?? "N/A"} slOrder=${position.slClientOrderId ?? "N/A"}`);
    if (pnlState) {
        const displayProfitUSDT = Number.isFinite(pnlState.displayProfitUSDT) ? pnlState.displayProfitUSDT : pnlState.netProfitUSDT;
        const displayProfitPercent = Number.isFinite(pnlState.displayProfitPercent) ? pnlState.displayProfitPercent : pnlState.profitPercent;
        console.log(`   [${positionKey}] pnl=${displayProfitUSDT.toFixed(4)} USDT (${displayProfitPercent.toFixed(2)}%)`);
    }
};

const logGridSyncStatus = (desiredOrders, openGridOrders) => {
    const now = Date.now();
    if (now - lastGridSyncLogAt < GRID_SYNC_LOG_TTL) return;
    console.log(`[GRID] Desired ladder=${desiredOrders.length} | Open grid orders=${openGridOrders.length}`);
    lastGridSyncLogAt = now;
};

const maybeLogGridSizingState = (channel, message, stateKey) => {
    const now = Date.now();
    const cached = gridSizingStateLogCache.get(channel) || { key: "", at: 0 };
    if (stateKey !== cached.key || now - cached.at >= GRID_SIZING_STATE_LOG_TTL) {
        console.log(message);
        gridSizingStateLogCache.set(channel, { key: stateKey, at: now });
    }
};

const buildRiskOverrides = () => ({
    trailingActivateATR: toFiniteNumber(db.trailingActivateATR, 1.2),
    trailingOffsetATR: toFiniteNumber(db.trailingOffsetATR, 0.6)
});

const {
    parseSignalOrderData,
    getOrderFillSnapshot,
    buildOrderPlan,
    isDirectionalOrderPlanValid,
    logOrderPlan,
    evaluatePositionExit,
    maybeLogPositionPnL,
    buildSignalSnapshot
} = createTradeLogicHelpers({
    getDb: () => db,
    toFiniteNumber,
    formatPriceToMarketPrecision,
    matchesOrderToTrackedPosition: (...args) => matchesOrderToTrackedPosition(...args),
    getLastPnlLog: () => lastPnlLog,
    setLastPnlLog: (value) => { lastPnlLog = value; },
    calcATR
});

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
    metrics.api.positions++;
    const positions = await exchange.fetchPositions([db.pair]);
    return positions.filter((position) => (
        normalizeSymbol(position.symbol) === normalizeSymbol(db.pair) &&
        Math.abs(getExchangePositionContracts(position)) > 0
    ));
};

const validateOrderSize = (market, quantity, referencePrice, options = {}) => {
    const { allowReduceOnlyClose = false } = options;
    if (!Number.isFinite(quantity) || quantity <= 0) {
        return { valid: false, reason: "[ERROR] Invalid order quantity after precision adjustment." };
    }
    const minAmount = Number(market?.limits?.amount?.min);
    if (Number.isFinite(minAmount) && quantity < minAmount) {
        return { valid: false, reason: `[ERROR] Quantity ${quantity} is below exchange minimum ${minAmount}. Order skipped.` };
    }
    const notional = quantity * referencePrice;
    const minCost = Number(market?.limits?.cost?.min);
    if (Number.isFinite(minCost) && Number.isFinite(notional) && notional < minCost) {
        if (allowReduceOnlyClose) {
            return {
                valid: true,
                warning: `[WARN] Reduce-only close notional ${notional.toFixed(6)} is below exchange minimum ${minCost}. Allowing placement because the order only closes an existing position.`
            };
        }
        return { valid: false, reason: `[ERROR] Order notional ${notional.toFixed(6)} is below exchange minimum ${minCost}. Order skipped.` };
    }
    return { valid: true };
};

const {
    placeGridEntryOrder,
    ensureReduceOnlyTakeProfitOrder,
    ensureReduceOnlyStopLossOrder
} = createOrderExecutionHelpers({
    getExchange: () => exchange,
    getMetrics: () => metrics,
    getDb: () => db,
    isHedgeModeEnabled: () => isHedgeModeEnabled(),
    toFiniteNumber,
    formatAmountToMarketPrecision,
    formatPriceToMarketPrecision,
    validateOrderSize,
    buildExchangeOrderParams,
    getOrderPositionSide: (...args) => getOrderPositionSide(...args),
    getClosePositionSide: (...args) => getClosePositionSide(...args),
    findOpenGridOrderByClientOrderId,
    findOpenOrderByClientOrderId,
    isDuplicateClientOrderIdError,
    cancelOrderByClientOrderId,
    syncPositionWithExchange: (...args) => syncPositionWithExchange(...args),
    getExchangeClientOrderId,
    getTpClientOrderId,
    getSlClientOrderId,
    fetchOpenTpOrders,
    fetchOpenSlOrders,
    matchesOrderToTrackedPosition: (...args) => matchesOrderToTrackedPosition(...args),
    getOrderQuantity: (...args) => getOrderQuantity(...args),
    getOrderTriggerPrice: (...args) => getOrderTriggerPrice(...args),
    isManagedOrderPriceMatch: (...args) => isManagedOrderPriceMatch(...args),
    getPositionSyncQtyTolerance: () => POSITION_SYNC_QTY_TOLERANCE,
    upsertActivePosition: (...args) => upsertActivePosition(...args),
    saveDB: (...args) => saveDB(...args),
    cancelTpOrders,
    cancelSlOrders,
    buildReplacementClientOrderId
});


const isLegacySinglePosition = (value) => value && typeof value === "object" && !Array.isArray(value) && ("entryPrice" in value || "quantity" in value || "side" in value);

const toPositionMapKey = (positionSide) => {
    const normalized = String(positionSide || "").toUpperCase();
    if (normalized === "LONG" || normalized === "SHORT" || normalized === "BOTH") return normalized;
    return normalized || "BOTH";
};

const {
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
} = createExchangePositionHelpers({
    isHedgeModeEnabled,
    toFiniteNumber,
    normalizeSymbol,
    formatPriceToMarketPrecision,
    getExchangeClientOrderId,
    getDb: () => db,
    getSignalParameters,
    sanitizeGridState,
    findNearestGridLevelIndex,
    buildGridExitPlan,
    getPositionSyncQtyTolerance: () => POSITION_SYNC_QTY_TOLERANCE,
    getPositionSyncEntryTolerancePct: () => POSITION_SYNC_ENTRY_TOLERANCE_PCT
});

const {
    getActivePositionsMap,
    getPositionMapKeys,
    getPositionMapCount,
    getPositionMapSignature,
    getActivePositionEntries,
    getActivePositionsList,
    hasAnyActivePosition,
    getActivePositionByKey,
    getPrimaryActivePosition,
    setActivePositionsMap,
    upsertActivePosition,
    removeActivePositionByKey,
    mergeTrackedPositions
} = createPositionStateHelpers({
    getDb: () => db,
    isLegacySinglePosition,
    toPositionMapKey,
    getTrackedPositionSideLabel,
    isSameTrackedPosition
});

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
    if (now - lastPositionRuntimePersistAt < POSITION_RUNTIME_PERSIST_TTL) return;
    await saveDB();
    lastPositionRuntimePersistAt = now;
};

const updateActivePositionExtremes = (position, currentPrice) => {
    if (!Number.isFinite(position.highestSinceEntry)) position.highestSinceEntry = position.entryPrice;
    if (!Number.isFinite(position.lowestSinceEntry)) position.lowestSinceEntry = position.entryPrice;
    position.highestSinceEntry = Math.max(position.highestSinceEntry ?? position.entryPrice, currentPrice);
    position.lowestSinceEntry = Math.min(position.lowestSinceEntry ?? position.entryPrice, currentPrice);
};

const applyTrailingStopUpdate = (position) => {
    const trailingEnabled = position?.trailingEnabled ?? db.trailingEnabled;
    if (!trailingEnabled || !Number.isFinite(position.atrAtEntry) || position.atrAtEntry <= 0) return;
    const effectiveTrailingActivateATR = toFiniteNumber(position.trailingActivateATR, db.trailingActivateATR);
    const effectiveTrailingOffsetATR = toFiniteNumber(position.trailingOffsetATR, db.trailingOffsetATR);
    const trailActivationMove = effectiveTrailingActivateATR * position.atrAtEntry;
    const trailOffsetMove = effectiveTrailingOffsetATR * position.atrAtEntry;

    if (position.side === "buy") {
        const activated = position.highestSinceEntry >= position.entryPrice + trailActivationMove;
        if (!activated) return;
        const trailedStop = position.highestSinceEntry - trailOffsetMove;
        if (!Number.isFinite(position.stopLossPrice) || trailedStop > position.stopLossPrice) {
            position.stopLossPrice = trailedStop;
            position.stopLossUSDT = -Math.abs(position.stopLossPrice - position.entryPrice) * position.quantity;
        }
        return;
    }

    const activated = position.lowestSinceEntry <= position.entryPrice - trailActivationMove;
    if (!activated) return;
    const trailedStop = position.lowestSinceEntry + trailOffsetMove;
    if (!Number.isFinite(position.stopLossPrice) || trailedStop < position.stopLossPrice) {
        position.stopLossPrice = trailedStop;
        position.stopLossUSDT = -Math.abs(position.stopLossPrice - position.entryPrice) * position.quantity;
    }
};

const calculatePositionPnL = (position, currentPrice, quantityOverride = null) => {
    const quantity = Number.isFinite(quantityOverride) ? quantityOverride : position.quantity;
    const exchangePnlSnapshot = !Number.isFinite(quantityOverride) ? position?.exchangePnlSnapshot : null;
    const hasFreshExchangePnl = exchangePnlSnapshot &&
        exchangePnlSnapshot.source === "exchange" &&
        Number.isFinite(exchangePnlSnapshot.timestamp) &&
        (Date.now() - exchangePnlSnapshot.timestamp) <= 10000 &&
        Number.isFinite(exchangePnlSnapshot.grossProfitUSDT) &&
        Number.isFinite(exchangePnlSnapshot.netProfitUSDT) &&
        Number.isFinite(exchangePnlSnapshot.profitPercent);
    if (hasFreshExchangePnl) {
        return {
            grossProfitUSDT: exchangePnlSnapshot.grossProfitUSDT,
            netProfitUSDT: exchangePnlSnapshot.grossProfitUSDT,
            realizedProfitUSDT: exchangePnlSnapshot.grossProfitUSDT,
            profitPercent: exchangePnlSnapshot.profitPercent,
            displayProfitUSDT: exchangePnlSnapshot.grossProfitUSDT,
            displayProfitPercent: exchangePnlSnapshot.profitPercent,
            currentPrice: Number.isFinite(exchangePnlSnapshot.currentPrice) ? exchangePnlSnapshot.currentPrice : currentPrice,
            source: "exchange"
        };
    }

    const entryValue = position.entryPrice * quantity;
    const leverageAtEntry = Math.max(1, toFiniteNumber(position?.leverageAtEntry, db.leverage));
    const snapshotMarkPrice = toFiniteNumber(exchangePnlSnapshot?.markPrice, NaN);
    const priceSource = Number.isFinite(snapshotMarkPrice) && snapshotMarkPrice > 0
        ? snapshotMarkPrice
        : currentPrice;

    const grossProfitUSDT = position.side === "buy"
        ? (priceSource - position.entryPrice) * quantity
        : (position.entryPrice - priceSource) * quantity;
    const referenceInitialMargin = Math.max(entryValue / leverageAtEntry, 1e-8);
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
    if (!db) return;
    const currentPrice = await getPrice();
    const activeEntries = getActivePositionEntries();
    let openExchangePositions = [];
    let managedOrders = { grid: [], tp: [], sl: [] };

    try {
        openExchangePositions = await fetchOpenExchangePositions();
    } catch (error) {
        console.warn(`[STATUS] Failed to fetch exchange positions: ${error.message}`);
    }

    try {
        managedOrders = await fetchManagedOpenOrdersSnapshot();
    } catch (error) {
        console.warn(`[STATUS] Failed to fetch managed open orders: ${error.message}`);
    }
    const gridSummary = getGridRuntimeSummary(currentPrice, managedOrders);
    const recoveryReason = getExchangeRecoveryReason();

    console.log(`\n[STATUS] Mode=${accountPositionMode.label} | Pair=${db.pair} | Price=${Number.isFinite(currentPrice) ? currentPrice : "N/A"} | LocalActive=${activeEntries.length} | ExchangePos=${openExchangePositions.length}`);
    printStatusLine("Profile", `${gridSummary.presetName.toUpperCase()} | Grid Slot=${gridSummary.slotLabel} | Ladder=${gridSummary.ladderLabel}`);
    printStatusLine("Side Orders", `${gridSummary.ordersMode}=${gridSummary.effectiveOrdersPerSide}/${gridSummary.configuredOrdersPerSideCap} | Size ${gridSummary.sizeMode}=${gridSummary.effectiveOrderSizeUsdt.toFixed(4)} USDT | Min Valid=${gridSummary.minOrderSizeUsdt.toFixed(4)} USDT | Available USDT=${gridSummary.availableUsdtLabel}`);
    printStatusLine("Daily P&L", `${db.dailyPnL.toFixed(2)} USDT | Trades=${db.dailyTrades}`);
    printStatusLine("Runtime", `placing=${isPlacingOrder ? "Y" : "N"} closing=${isClosingPosition ? "Y" : "N"} posSync=${isSyncingPosition ? "Y" : "N"} gridSync=${isSyncingGridOrders ? "Y" : "N"}`);
    printStatusLine("Exchange", `${exchangeHealth.isHealthy ? "HEALTHY" : "DEGRADED"} | RecoverySync=${exchangeHealth.needsRecoverySync ? "Y" : "N"}${recoveryReason ? ` | ${recoveryReason}` : ""}`);
    printStatusLine("Last trade", `${formatStatusTimestamp(lastTradeAt)} | Daily reset=${formatStatusTimestamp(toFiniteNumber(db.lastDailyReset, Date.now()))}`);
    printStatusLine("Open Orders", `Grid=${managedOrders.grid.length} | TP=${managedOrders.tp.length} | SL=${managedOrders.sl.length}`);
    if (gridSummary.hasLockedGrid) printStatusLine("Locked Grid", `${gridSummary.lockedRangeLabel} | Step=${gridSummary.stepLabel}`);
    if (openExchangePositions.length !== activeEntries.length) {
        console.warn(`[STATUS] Position mismatch detected: local=${activeEntries.length} vs exchange=${openExchangePositions.length}`);
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

const {
    clearMissingPositionState,
    finalizeClosedPosition,
    recordPartialClose,
    closePosition
} = createPositionLifecycleHelpers({
    getDb: () => db,
    getExchange: () => exchange,
    getMetrics: () => metrics,
    isHedgeModeEnabled: () => isHedgeModeEnabled(),
    getClosingPositionKeys: () => closingPositionKeys,
    getIsClosingPosition: () => isClosingPosition,
    setIsClosingPosition: (value) => { isClosingPosition = value; },
    toPositionMapKey,
    hasAnyActivePosition,
    getActivePositionEntries,
    getActivePositionByKey,
    cancelManagedOrdersForPosition,
    removeActivePositionByKey,
    saveDB: (...args) => saveDB(...args),
    logTrade: (...args) => logTrade(...args),
    getTrackedPositionSideLabel,
    getPrice: (...args) => getPrice(...args),
    calculatePositionPnL,
    fetchOpenExchangePositions: (...args) => fetchOpenExchangePositions(...args),
    findOpenExchangePosition,
    fetchOpenGridOrders,
    getExchangePositionContracts,
    getExchangePositionEntryPrice,
    buildOrderPlan,
    upsertActivePosition,
    fetchOpenTpOrders,
    fetchOpenSlOrders,
    matchesOrderToTrackedPosition: (...args) => matchesOrderToTrackedPosition(...args),
    cancelGridOrders,
    cancelTpOrders,
    cancelSlOrders,
    buildExchangeOrderParams,
    getClosePositionSide,
    buildSyncedActivePosition,
    ensureReduceOnlyTakeProfitOrder,
    ensureReduceOnlyStopLossOrder,
    getPositionSyncQtyTolerance: () => POSITION_SYNC_QTY_TOLERANCE,
    getOrderFillSnapshot
});

const mergeRuntimeConfig = (nextConfig) => {
    const currentPositionsMap = getActivePositionsMap(db.activePosition);
    const nextPositionsMap = getActivePositionsMap(nextConfig.activePosition);
    const hasActiveTradeState = getPositionMapCount(currentPositionsMap) > 0;
    nextConfig.activePosition = mergeTrackedPositions(currentPositionsMap, nextPositionsMap);

    if (hasActiveTradeState) {
        RUNTIME_PROTECTED_CONFIG_KEYS.forEach((key) => {
            if (nextConfig[key] !== db[key]) {
                console.warn(`[WARN] Preserving runtime ${key}=${db[key]} while positions are active.`);
                nextConfig[key] = db[key];
            }
        });

        const currentPositionKeys = getPositionMapKeys(currentPositionsMap);
        const nextPositionKeys = getPositionMapKeys(nextPositionsMap);
        if (currentPositionKeys.length > 0 && nextPositionKeys.length === 0) {
            nextConfig.activePosition = currentPositionsMap;
        }
    }


    const currentLastDailyReset = toFiniteNumber(db.lastDailyReset, 0);
    const nextLastDailyReset = toFiniteNumber(nextConfig.lastDailyReset, 0);
    const currentDailyTrades = Math.max(0, Math.trunc(toFiniteNumber(db.dailyTrades, 0)));
    const nextDailyTrades = Math.max(0, Math.trunc(toFiniteNumber(nextConfig.dailyTrades, 0)));
    if (
        nextLastDailyReset < currentLastDailyReset ||
        (isSameUTCDate(currentLastDailyReset, nextLastDailyReset) && nextDailyTrades <= currentDailyTrades)
    ) {
        nextConfig.lastDailyReset = currentLastDailyReset;
        nextConfig.dailyPnL = toFiniteNumber(db.dailyPnL, 0);
        nextConfig.dailyTrades = currentDailyTrades;
    }

    Object.keys(nextConfig).forEach((key) => { db[key] = nextConfig[key]; });
};

const CONFIG_KEYS_REQUIRING_GRID_REBUILD = new Set([
    "pair",
    "gridTimeframe",
    "gridLevels",
    "gridLookbackCandles",
    "gridRangePercent",
    "gridTakeProfitLevels",
    "gridStopLossLevels",
    "gridEntryBufferPercent"
]);

const CONFIG_KEYS_REQUIRING_POSITION_REAPPLY = new Set([
    "gridOrderSizeUsdt",
    "gridTargetProfitUsdt",
    "autoTargetProfitEnabled",
    "targetProfitAtrMultiplier",
    "targetProfitMinUsdt",
    "targetProfitMaxUsdt",
    "autoStopLossEnabled",
    "stopLossAtrMultiplier",
    "stopLossMinPercent",
    "stopLossMaxPercent",
    "gridStopLossPercent",
    "gridTakeProfitLevels",
    "gridStopLossLevels",
    "gridLevels",
    "gridLookbackCandles",
    "gridRangePercent",
    "gridTimeframe",
    "trailingEnabled",
    "trailingActivateATR",
    "trailingOffsetATR"
]);

const didConfigFieldChange = (previousConfig, nextConfig, key) => {
    if (!previousConfig || typeof previousConfig !== "object") return false;
    return previousConfig[key] !== nextConfig[key];
};

const applyRuntimeConfigChanges = async (previousConfig = null) => {
    if (!db || !previousConfig || typeof previousConfig !== "object") return false;
    if (hasRuntimePositionMutationInFlight()) return false;

    let runtimeChanged = false;
    const shouldResetGridState = Array.from(CONFIG_KEYS_REQUIRING_GRID_REBUILD).some((key) => didConfigFieldChange(previousConfig, db, key));
    if (shouldResetGridState && db.activeGridState) {
        db.activeGridState = null;
        runtimeChanged = true;
        console.log("[CONFIG] Grid parameters changed. Cleared locked grid state for rebuild.");
    }

    const shouldReapplyPositions = hasAnyActivePosition() && Array.from(CONFIG_KEYS_REQUIRING_POSITION_REAPPLY).some((key) => didConfigFieldChange(previousConfig, db, key));
    if (!shouldReapplyPositions) {
        if (runtimeChanged) await saveDB();
        return runtimeChanged;
    }

    const openExchangePositions = exchange ? await fetchOpenExchangePositions() : [];
    for (const [positionKey, position] of getActivePositionEntries()) {
        const openExchangePosition = openExchangePositions.length > 0
            ? findOpenExchangePosition(openExchangePositions, db.pair, position)
            : null;
        if (!openExchangePosition) continue;

        const syncedEntryPrice = getExchangePositionEntryPrice(openExchangePosition, position.entryPrice);
        const nextPosition = buildSyncedActivePosition(openExchangePosition, syncedEntryPrice, position, syncedEntryPrice, { preserveExitPlan: false });
        const shouldUpdatePosition = [
            "targetPrice",
            "stopLossPrice",
            "targetProfitUSDT",
            "stopLossUSDT",
            "trailingEnabled",
            "trailingActivateATR",
            "trailingOffsetATR"
        ].some((key) => nextPosition[key] !== position[key]);

        if (!shouldUpdatePosition) continue;

        upsertActivePosition(nextPosition);
        runtimeChanged = true;
        console.log(`[CONFIG] Re-applied trading parameters to active position ${positionKey}.`);
    }

    if (runtimeChanged) await saveDB();

    for (const [positionKey, position] of getActivePositionEntries()) {
        await ensureReduceOnlyTakeProfitOrder(positionKey, position);
        await ensureReduceOnlyStopLossOrder(positionKey, position);
    }

    return runtimeChanged;
};

const {
    configureRecurringTask,
    refreshRuntimeSchedulers,
    bootstrapRuntime
} = createRuntimeSchedulerHelpers({
    initializeExchange: (...args) => initializeExchange(...args),
    detectPositionMode: (...args) => detectPositionMode(...args),
    setMarginMode: (...args) => setMarginMode(...args),
    setLeverage: (...args) => setLeverage(...args),
    syncPositionWithExchange: (...args) => syncPositionWithExchange(...args),
    startPnLMonitoring: (...args) => startPnLMonitoring(...args),
    startPositionSync: (...args) => startPositionSync(...args),
    startMetricsReporting: (...args) => startMetricsReporting(...args),
    startConfigAutoReload: (...args) => startConfigAutoReload(...args),
    shutdown: (...args) => shutdown(...args)
});

const isNewTradingDay = (timestamp) => {
    const currentTime = toFiniteNumber(timestamp, NaN);
    if (!Number.isFinite(currentTime)) return false;
    const lastResetTime = toFiniteNumber(db.lastDailyReset, NaN);
    const todayUTC = getUTCDateKey(currentTime);
    const lastResetUTC = getUTCDateKey(lastResetTime);
    return todayUTC !== lastResetUTC;
};

const resetDailyStateIfNeeded = async (now) => {
    if (!isNewTradingDay(now)) return false;
    console.log("[DAILY] Daily reset");
    db.dailyPnL = 0;
    db.dailyTrades = 0;
    db.lastDailyReset = toFiniteNumber(now, Date.now());
    resetDailyTradeMetrics();
    await saveDB();
    return true;
};

const getDailyRiskLimit = async () => {
    const totalUSDT = await getTotalUSDTBalance();
    if (!Number.isFinite(totalUSDT) || totalUSDT <= 0) return null;
    return totalUSDT * db.dailyMaxLossPercent / 100;
};

const getTradingPauseReason = async () => {
    const maxDailyLoss = await getDailyRiskLimit();
    if (db.dailyPnL >= db.dailyProfitTargetUsdt) return `[PAUSE] Daily target reached: $${db.dailyPnL.toFixed(2)}. Trading paused.`;
    if (Number.isFinite(maxDailyLoss) && db.dailyPnL <= -maxDailyLoss) return `[PAUSE] Daily loss limit reached: $${db.dailyPnL.toFixed(2)}. Trading paused.`;
    if (db.dailyTrades >= db.maxTradesPerDay) return `[PAUSE] Max trades per day (${db.maxTradesPerDay}) reached.`;
    return null;
};

const isCoolingDown = () => {
    if (db.dailyTrades <= 0) return false;
    const tradeTimestamp = lastTradeAt || getLastTradeTimestampFromLog();
    return tradeTimestamp > 0 && Date.now() - tradeTimestamp < db.coolingPeriod;
};

const handleRuntimeCommand = async (input) => {
    try {
        const cmd = input.toString().trim().toLowerCase();
        if (!cmd) return;
        if (cmd === "sync") { await syncPositionWithExchange(); return; }
        if (cmd === "status") { await printDetailedStatus(); return; }
        if (cmd === "help") {
            console.log("[INFO] Runtime commands: status | sync | help");
            return;
        }
        console.log(`[INFO] Unknown runtime command: ${cmd}. Available: status | sync | help`);
    } catch (error) {
        console.error("[ERROR] Runtime command failed:", error.message);
    }
};

const unregisterRuntimeCommands = () => {
    if (!runtimeCommandsRegistered || !process.stdin.isTTY) return;
    process.stdin.removeListener("data", handleRuntimeCommand);
    process.stdin.pause();
    runtimeCommandsRegistered = false;
};

const registerRuntimeCommands = () => {
    if (runtimeCommandsRegistered || !process.stdin.isTTY) return;
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", handleRuntimeCommand);
    runtimeCommandsRegistered = true;
};

const runTradingCycle = async () => {
    await reloadConfig();
    refreshRuntimeSchedulers();
    const strategy = String(db?.strategy || "futures_grid").toLowerCase();

    if (hasRuntimePositionMutationInFlight()) return;
    await resetDailyStateIfNeeded(Date.now());
    if (!canOpenNewPositions()) {
        logExchangeRecoveryBlock(strategy === "futures_grid" ? "grid entries" : "new position entries");
        return;
    }

    const pauseReason = await getTradingPauseReason();
    if (pauseReason) {
        console.log(pauseReason);
        if (strategy === "futures_grid") {
            const openGridOrders = await fetchOpenGridOrders();
            if (openGridOrders.length > 0) await cancelGridOrders(openGridOrders, "PAUSED");
        }
        return;
    }

    if (strategy === "futures_grid") {
        await syncGridOrders();
        return;
    }

    const coolingBlocked = isCoolingDown() && (!isHedgeModeEnabled() || !hasAnyActivePosition());
    if ((!isHedgeModeEnabled() && hasAnyActivePosition()) || coolingBlocked) return;

    const signal = await analyzeSignal();
    if (signal.canLong && !getActivePositionByKey(isHedgeModeEnabled() ? "LONG" : "BOTH")) await placeOrder("buy", signal);
    if (signal.canShort && !getActivePositionByKey(isHedgeModeEnabled() ? "SHORT" : "BOTH")) await placeOrder("sell", signal);
};

const startMetricsReporting = () => {
    if (metricsTimer) return;
    metricsTimer = setInterval(() => {
        const elapsedSec = Math.max(1, Math.round((Date.now() - metrics.windowStart) / 1000));
        const apiTotal = metrics.api.ticker + metrics.api.ohlcv + metrics.api.balance + metrics.api.positions + metrics.api.orders;
        const winRate = metrics.trades.closed > 0 ? ((metrics.trades.wins / metrics.trades.closed) * 100).toFixed(1) : "0.0";
        console.log(`[METRICS] ${elapsedSec}s | API=${apiTotal} (ticker:${metrics.api.ticker}, ohlcv:${metrics.api.ohlcv}, bal:${metrics.api.balance}, pos:${metrics.api.positions}, order:${metrics.api.orders}) | Signals=${metrics.signals.analyzed} (setups:${metrics.signals.crossoverDetected}, long:${metrics.signals.longConfirmed}, short:${metrics.signals.shortConfirmed}) | Trades today O/C/W/L=${metrics.trades.opened}/${metrics.trades.closed}/${metrics.trades.wins}/${metrics.trades.losses} (WR ${winRate}%)`);
        resetMetricWindow();
    }, METRICS_LOG_INTERVAL);
};

const getDefaultConfig = () => ({ ...DEFAULT_CONFIG, lastDailyReset: Date.now(), lastUpdated: Date.now() });

const {
    buildDashboardStatus,
    buildLiveStatusPayload,
    buildDashboardPayload
} = createDashboardStatusHelpers({
    getDb: () => db,
    getDefaultConfig: () => getDefaultConfig(),
    getIsShuttingDown: () => isShuttingDown,
    getExchange: () => exchange,
    getExchangeHealth: () => exchangeHealth,
    getExchangeRecoveryReason,
    getAccountPositionMode: () => accountPositionMode,
    getActivePositionsMap,
    getActivePositionEntries,
    toFiniteNumber,
    defaultConfig: DEFAULT_CONFIG,
    dashboardEditableFields: DASHBOARD_EDITABLE_FIELDS,
    getExchangeClientOrderId,
    getPrice: async (...args) => getPrice(...args),
    fetchOpenExchangePositions: async (...args) => fetchOpenExchangePositions(...args),
    fetchManagedOpenOrdersSnapshot: async (...args) => fetchManagedOpenOrdersSnapshot(...args),
    calculatePositionPnL
});

const {
    isDashboardAuthenticated,
    isDashboardLoginValid,
    setDashboardSessionCookie,
    clearDashboardSessionCookie
} = createDashboardSessionHelpers({
    username: DASHBOARD_USERNAME,
    password: DASHBOARD_PASSWORD,
    sessionSecret: DASHBOARD_SESSION_SECRET,
    sessionCookieName: DASHBOARD_SESSION_COOKIE,
    sessionTtlMs: DASHBOARD_SESSION_TTL_MS,
    isProduction: String(process.env.NODE_ENV || "").toLowerCase() === "production"
});

const requireDashboardAuth = (req, res, next) => {
    if (isDashboardAuthenticated(req)) return next();
    if (req.path.startsWith("/api")) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
    }
    res.redirect("/login");
};

const {
    applyDashboardConfigUpdate,
    resetDashboardConfig
} = createDashboardConfigHelpers({
    getDb: () => db,
    hasAnyActivePosition: () => hasAnyActivePosition(),
    protectedKeys: DASHBOARD_PROTECTED_KEYS,
    editableKeys: DASHBOARD_EDITABLE_KEYS,
    applyAutoPresetToConfig: (config) => applyAutoPresetToConfig(config),
    getDefaultConfig: () => getDefaultConfig(),
    saveDB: async () => { await saveDB(); },
    reloadConfig: async (...args) => { await reloadConfig(...args); },
    refreshRuntimeSchedulers: () => { refreshRuntimeSchedulers(); },
    syncExchangeRuntimeSettings: async () => {
        if (!exchange) return;
        await setMarginMode();
        await setLeverage();
    },
    buildDashboardPayload
});

const startWebDashboard = async () => {
    if (webServer) return webServer;

    const app = express();
    app.disable("x-powered-by");
    app.use(express.json({ limit: "1mb" }));
    app.use(express.urlencoded({ extended: false }));

    app.get("/login", (req, res) => {
        if (isDashboardAuthenticated(req)) {
            res.redirect("/dashboard");
            return;
        }
        res.sendFile(path.join(__dirname, "public", "login.html"));
    });

    app.post("/login", (req, res) => {
        const username = String(req.body?.username || "").trim();
        const password = String(req.body?.password || "");
        if (isDashboardLoginValid(username, password)) {
            setDashboardSessionCookie(res, username);
            res.redirect("/dashboard");
            return;
        }
        res.redirect("/login?error=1");
    });

    app.post("/logout", (req, res) => {
        clearDashboardSessionCookie(res);
        res.redirect("/login");
    });

    app.use(requireDashboardAuth);

    app.get("/", (req, res) => {
        res.sendFile(path.join(__dirname, "public", "index.html"));
    });

    app.get("/dashboard", (req, res) => {
        res.sendFile(path.join(__dirname, "public", "index.html"));
    });

    app.use(express.static(path.join(__dirname, "public")));

    app.get("/api/health", (req, res) => {
        res.json({
            ok: true,
            botRunning: !isShuttingDown,
            databaseReady: Boolean(db),
            exchangeReady: Boolean(exchange),
            exchangeHealthy: exchangeHealth.isHealthy,
            needsRecoverySync: exchangeHealth.needsRecoverySync,
            exchangeRecoveryReason: getExchangeRecoveryReason() || null,
            serverTime: Date.now()
        });
    });

    app.get("/api/config", (req, res) => {
        if (!db) {
            res.status(503).json({ ok: false, error: "Config is not ready yet" });
            return;
        }
        res.json({ ok: true, ...buildDashboardPayload() });
    });

    app.get("/api/status", async (req, res) => {
        try {
            const payload = await buildLiveStatusPayload();
            if (!payload.ok) {
                res.status(503).json(payload);
                return;
            }
            res.json(payload);
        } catch (error) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.put("/api/config", async (req, res) => {
        try {
            const incoming = req.body && typeof req.body === "object" && req.body.config && typeof req.body.config === "object"
                ? req.body.config
                : req.body;
            const result = await applyDashboardConfigUpdate(incoming);
            res.json({ ok: true, message: "Konfigurasi berhasil disimpan", ...result });
        } catch (error) {
            res.status(400).json({ ok: false, error: error.message });
        }
    });

    app.post("/api/config/reset", async (req, res) => {
        try {
            const result = await resetDashboardConfig();
            res.json({ ok: true, message: "Konfigurasi dikembalikan ke default", ...result });
        } catch (error) {
            res.status(400).json({ ok: false, error: error.message });
        }
    });

    app.use(express.static(path.join(__dirname, "public")));

    const port = Math.max(1, Math.trunc(toFiniteNumber(process.env.DASHBOARD_PORT || process.env.PORT, 3000)));
    const host = process.env.DASHBOARD_HOST || "0.0.0.0";

    webServer = await new Promise((resolve, reject) => {
        const server = app.listen(port, host, () => {
            console.log(`[WEB] Dashboard available at http://localhost:${port}`);
            resolve(server);
        });
        server.on("error", (error) => {
            reject(error);
        });
    });

    return webServer;
};

const AUTO_PAIR_GRID_PRESETS = {
    binance: {
        strategy: "futures_grid",
        leverage: 10,
        gridTargetProfitUsdt: 0.4,
        autoTargetProfitEnabled: true,
        targetProfitAtrMultiplier: 0.8,
        targetProfitMinUsdt: 0.3,
        targetProfitMaxUsdt: 4,
        gridStopLossPercent: 5,
        autoStopLossEnabled: true,
        stopLossAtrMultiplier: 0.12,
        stopLossMinPercent: 3,
        stopLossMaxPercent: 7,
        gridLevels: 10,
        gridLookbackCandles: 144,
        gridRangePercent: 4.0,
        gridEntryBufferPercent: 0.12,
        gridOrderSizeUsdt: 0,
        gridTakeProfitLevels: 0,
        gridOrdersPerSide: 0,
        gridStopLossLevels: 0,
        gridTimeframe: "5m",
        minVolumeRatio: 1.1,
        volumePeriod: 20,
        atrPeriod: 14,
        trailingEnabled: true,
        trailingActivateATR: 1.2,
        trailingOffsetATR: 0.6,
        allowLong: true,
        allowShort: true
    },
    volatile: {
        strategy: "futures_grid",
        leverage: 8,
        gridTargetProfitUsdt: 0.35,
        autoTargetProfitEnabled: true,
        targetProfitAtrMultiplier: 0.7,
        targetProfitMinUsdt: 0.2,
        targetProfitMaxUsdt: 2,
        gridStopLossPercent: 6,
        autoStopLossEnabled: true,
        stopLossAtrMultiplier: 0.15,
        stopLossMinPercent: 4,
        stopLossMaxPercent: 9,
        gridLevels: 12,
        gridLookbackCandles: 180,
        gridRangePercent: 6.5,
        gridEntryBufferPercent: 0.18,
        gridOrderSizeUsdt: 0,
        gridTakeProfitLevels: 0,
        gridOrdersPerSide: 0,
        gridStopLossLevels: 0,
        gridTimeframe: "5m",
        minVolumeRatio: 1.05,
        volumePeriod: 20,
        atrPeriod: 14,
        trailingEnabled: true,
        trailingActivateATR: 1.4,
        trailingOffsetATR: 0.8,
        allowLong: true,
        allowShort: true
    },
    doge: {
        strategy: "futures_grid",
        leverage: 8,
        gridTargetProfitUsdt: 0.25,
        autoTargetProfitEnabled: true,
        targetProfitAtrMultiplier: 0.6,
        targetProfitMinUsdt: 0.15,
        targetProfitMaxUsdt: 1.25,
        gridStopLossPercent: 4,
        autoStopLossEnabled: true,
        stopLossAtrMultiplier: 0.1,
        stopLossMinPercent: 2.5,
        stopLossMaxPercent: 6,
        gridOrderSizeUsdt: 0,
        gridLevels: 12,
        gridLookbackCandles: 180,
        gridRangePercent: 5.5,
        gridEntryBufferPercent: 0.16,
        gridTakeProfitLevels: 0,
        gridOrdersPerSide: 0,
        gridStopLossLevels: 0,
        gridTimeframe: "5m",
        minVolumeRatio: 1.05,
        volumePeriod: 20,
        atrPeriod: 14,
        trailingEnabled: true,
        trailingActivateATR: 1.3,
        trailingOffsetATR: 0.7,
        allowLong: true,
        allowShort: true
    }
};

const applyAutoPresetToConfig = (config) => {
    const autoPresetResult = applyAutoPairGridPreset(config);
    return {
        config: normalizeConfig(autoPresetResult.config),
        autoPresetResult
    };
};

const {
    syncDashboardConfigSignature,
    initializeDB,
    reloadConfig,
    saveDB,
    startConfigAutoReload
} = createConfigRuntimeHelpers({
    getDb: () => db,
    setDb: (value) => { db = value; },
    getIsShuttingDown: () => isShuttingDown,
    getIsProcessing: () => isProcessing,
    hasRuntimePositionMutationInFlight,
    getConfigReloadTimer: () => configReloadTimer,
    setConfigReloadTimer: (value) => { configReloadTimer = value; },
    loadPersistedConfig,
    ensureConfigRow,
    persistConfig,
    ensureConfigSchema,
    applyAutoPresetToConfig,
    hydrateConfig,
    mergeRuntimeConfig,
    applyRuntimeConfigChanges,
    hasAnyActivePosition,
    dashboardEditableFields: DASHBOARD_EDITABLE_FIELDS,
    configAutoReloadIntervalMs: CONFIG_AUTO_RELOAD_INTERVAL_MS
});

// -------------------- SYNC POSITION WITH EXCHANGE --------------------
const syncPositionWithExchange = async () => {
    if (isSyncingPosition || isClosingPosition || isPlacingOrder) return;
    isSyncingPosition = true;
    try {
        if (!db || !exchange) return;
        const now = Date.now();
        if (now - lastSyncLogAt >= SYNC_LOG_TTL) {
            console.log(`[SYNC] Checking positions for ${db.pair}...`);
            lastSyncLogAt = now;
        }
        const openPositions = await fetchOpenExchangePositions();
        const currentPrice = await getPrice();
        const currentPositionsMap = getActivePositionsMap();
        const nextPositionsMap = {};
        openPositions.forEach((openPosition) => {
            const entryPrice = getExchangePositionEntryPrice(openPosition, currentPrice);
            const existingPosition = currentPositionsMap[toPositionMapKey(getExchangePositionModeSide(openPosition))] || null;
            const syncedPosition = buildSyncedActivePosition(openPosition, entryPrice, existingPosition, currentPrice);
            nextPositionsMap[toPositionMapKey(syncedPosition.positionSide)] = syncedPosition;
        });
        const currentKeys = getPositionMapSignature(currentPositionsMap);
        const nextKeys = getPositionMapSignature(nextPositionsMap);
        let shouldPersist = currentKeys !== nextKeys;

        if (!shouldPersist) {
            shouldPersist = getPositionMapKeys(nextPositionsMap).some((key) => shouldRefreshSyncedPosition(currentPositionsMap[key], nextPositionsMap[key]));
        }

        if (!shouldPersist) {
            getPositionMapKeys(nextPositionsMap).forEach((key) => {
                if (!currentPositionsMap[key]) return;
                currentPositionsMap[key].exchangePnlSnapshot = nextPositionsMap[key].exchangePnlSnapshot;
                if (Number.isFinite(nextPositionsMap[key].leverageAtEntry)) {
                    currentPositionsMap[key].leverageAtEntry = nextPositionsMap[key].leverageAtEntry;
                }
            });
            setActivePositionsMap(currentPositionsMap);
            for (const [positionKey, currentPosition] of Object.entries(currentPositionsMap)) {
                await ensureReduceOnlyTakeProfitOrder(positionKey, currentPosition);
                await ensureReduceOnlyStopLossOrder(positionKey, currentPosition);
            }
            markExchangeHealthy("position sync");
            return;
        }

        const removedPositions = Object.entries(currentPositionsMap)
            .filter(([key]) => !nextPositionsMap[key]);
        for (const [removedKey, removedPosition] of removedPositions) {
            await clearMissingPositionState(removedPosition, "POSITION_SYNC_REMOVED", removedKey);
        }

        setActivePositionsMap(nextPositionsMap);
        await saveDB();
        if (getPositionMapCount(nextPositionsMap) === 0) console.log("[OK] Cleared local active positions from exchange state");
        else console.log(`[OK] Synced active positions: ${getPositionMapKeys(nextPositionsMap).join(", ")}`);

        for (const [positionKey, syncedPosition] of Object.entries(nextPositionsMap)) {
            await ensureReduceOnlyTakeProfitOrder(positionKey, syncedPosition);
            await ensureReduceOnlyStopLossOrder(positionKey, syncedPosition);
        }
        markExchangeHealthy("position sync");
    } catch (error) {
        markExchangeUnhealthy(error, "position sync");
        console.error("[ERROR] Sync position failed:", error.message);
    }
    finally { isSyncingPosition = false; }
};

// -------------------- INIT EXCHANGE --------------------
const initializeExchange = async () => {
    try {
        validateExchangeCredentials();
        exchange = new ccxt.binanceusdm({
            apiKey: process.env.API_KEY,
            secret: process.env.API_SECRET,
            options: { defaultType: "future", adjustForTimeDifference: true },
            enableRateLimit: true,
            timeout: 20000,
            recvWindow: 10000
        });
        exchange.options.adjustForTimeDifference = true;

        const loadExchangeMetadata = async () => {
            await exchange.loadTimeDifference();
            await exchange.loadMarkets();
        };

        try {
            await loadExchangeMetadata();
        } catch (error) {
            if (!isExchangeTimestampError(error)) throw error;
            console.warn("[WARN] Exchange clock skew detected. Refreshing time difference and retrying...");
            await sleep(500);
            await loadExchangeMetadata();
        }

        const timeDifference = toFiniteNumber(exchange.timeDifference, 0);
        console.log(`[OK] Exchange connected${timeDifference ? ` (time difference ${timeDifference}ms)` : ""}`);
        return exchange;
    } catch (error) { 
        markExchangeUnhealthy(error, "exchange initialization");
        console.error("[ERROR] Exchange connection failed:", error.message); 
        throw error; 
    }
};

const detectPositionMode = async () => {
    try {
        const result = await exchange.fetchPositionMode(db?.pair, { subType: "linear" });
        const hedged = result?.hedged === true || result?.dualSidePosition === true;
        accountPositionMode = { hedged, label: hedged ? "HEDGE" : "ONE_WAY" };
        console.log(`[OK] Position mode detected: ${accountPositionMode.label}`);
        return accountPositionMode;
    } catch (error) {
        accountPositionMode = { hedged: false, label: "ONE_WAY" };
        console.warn(`[WARN] Failed to detect position mode. Falling back to ONE_WAY. ${error.message}`);
        return accountPositionMode;
    }
};

// -------------------- SET MARGIN MODE --------------------
const setMarginMode = async () => {
    try {
        if (!db) return false;
        const marginMode = (db.marginMode || "isolated").toLowerCase();
        const openPositions = await fetchOpenExchangePositions();
        if (openPositions.length > 0) {
            console.log(`[INFO] Skipping margin mode update while ${openPositions.length} position(s) are open on ${db.pair}.`);
            return false;
        }
        const managedOrders = await fetchManagedOpenOrdersSnapshot();
        const openOrderCount = managedOrders.grid.length + managedOrders.tp.length + managedOrders.sl.length;
        if (openOrderCount > 0) {
            console.log(`[INFO] Skipping margin mode update while ${openOrderCount} open managed order(s) exist on ${db.pair}.`);
            return false;
        }
        await exchange.setMarginMode(marginMode, db.pair);
        console.log(`[OK] Margin mode set to: ${marginMode.toUpperCase()}`);
        return true;
    } catch (error) {
        const errorCode = extractExchangeErrorCode(error);
        const errorMessage = String(error?.message || error || "");
        if (!errorMessage.includes("No need to change margin mode") && errorCode !== -4067) {
            console.warn("[WARN] Margin mode warning:", errorMessage);
        }
        return false;
    }
};

const setLeverage = async () => {
    try {
        if (!db) return false;
        const symbol = db.pair;
        const leverage = Math.max(1, Math.trunc(toFiniteNumber(db.leverage, 1)));
        if (!symbol) return false;
        if (lastAppliedLeverageState.symbol === symbol && lastAppliedLeverageState.leverage === leverage) return true;

        const openPositions = await fetchOpenExchangePositions();
        if (openPositions.length > 0) {
            console.log(`[INFO] Skipping leverage update while ${openPositions.length} position(s) are open on ${symbol}.`);
            return false;
        }

        const managedOrders = await fetchManagedOpenOrdersSnapshot();
        const openOrderCount = managedOrders.grid.length + managedOrders.tp.length + managedOrders.sl.length;
        if (openOrderCount > 0) {
            console.log(`[INFO] Skipping leverage update while ${openOrderCount} open managed order(s) exist on ${symbol}.`);
            return false;
        }

        await exchange.setLeverage(leverage, symbol);
        lastAppliedLeverageState = { symbol, leverage };
        console.log(`[OK] Leverage set to: ${leverage}x`);
        return true;
    } catch (error) {
        const errorCode = extractExchangeErrorCode(error);
        const errorMessage = String(error?.message || error || "");
        if (!errorMessage.includes("No need to change leverage") && errorCode !== -4028) {
            console.warn("[WARN] Leverage warning:", errorMessage);
        } else {
            lastAppliedLeverageState = {
                symbol: db?.pair || "",
                leverage: Math.max(1, Math.trunc(toFiniteNumber(db?.leverage, 1)))
            };
        }
        return false;
    }
};

// -------------------- SIGNAL DETECTION --------------------
const analyzeSignal = async () => {
    try {
        if (!db) return {};
        signalCount++; metrics.signals.analyzed++;
        const strategy = String(db.strategy || "futures_grid").toLowerCase();
        const now = Date.now();
        if (now - lastLogTime > 5000) {
            console.log(`\n[SIGNAL #${signalCount}] Analyzing ${strategy.toUpperCase()} setup (${db.gridTimeframe})...`);
            lastLogTime = now;
        }

        const params = getSignalParameters();
        const ohlcv = await getOHLCV(params.neededCandles);
        if (ohlcv.length < params.neededCandles) {
            console.log(`[WARN] Not enough OHLCV data: ${ohlcv.length} < ${params.neededCandles}`); return {};
        }

        const snapshot = buildSignalSnapshot(ohlcv, params);
        if (!snapshot || snapshot.invalidAtr) { console.log("[WARN] Invalid data for signal"); return {}; }

        const signalState = strategy === "futures_grid"
            ? evaluateGridSignal(snapshot, params)
            : (typeof evaluateCrossoverSignal === "function"
                ? evaluateCrossoverSignal(snapshot, params)
                : {
                    canLong: false,
                    canShort: false,
                    setupDetected: false,
                    detailTitle: "UNSUPPORTED STRATEGY",
                    strategyName: strategy.toUpperCase(),
                    extraDetailLines: [`   Strategy ${strategy} is not supported by the current build.`]
                });
        const finalState = applySignalGuards(signalState, snapshot);

        if (finalState.setupDetected) metrics.signals.crossoverDetected++;
        if (finalState.canLong) metrics.signals.longConfirmed++;
        if (finalState.canShort) metrics.signals.shortConfirmed++;

        const shouldDetailLog = finalState.setupDetected || (Date.now() - lastSignalDetailLogAt >= SIGNAL_DETAIL_LOG_TTL);
        if (shouldDetailLog) {
            logSignalDetails(params, snapshot, finalState);
            lastSignalDetailLogAt = Date.now();
        }

        return {
            canLong: finalState.canLong, canShort: finalState.canShort, price: snapshot.currentPrice,
            atr: snapshot.currentATR, hasSignal: finalState.setupDetected,
            strategy: signalState.strategyName || strategy.toUpperCase(),
            riskOverrides: buildRiskOverrides(),
            targetPrice: finalState.canLong ? signalState.longPlan?.targetPrice : (finalState.canShort ? signalState.shortPlan?.targetPrice : null),
            stopLossPrice: finalState.canLong ? signalState.longPlan?.stopLossPrice : (finalState.canShort ? signalState.shortPlan?.stopLossPrice : null)
        };
    } catch (error) { console.error("[ERROR] Signal analysis failed:", error.message); return {}; }
};

const syncGridOrders = async () => {
    if (!db || String(db.strategy || "futures_grid").toLowerCase() !== "futures_grid") return;
    if (isSyncingGridOrders || isPlacingOrder || isClosingPosition || isSyncingPosition || isMonitoringPnL) return;
    isSyncingGridOrders = true;

    try {
        const params = getSignalParameters();
        const ohlcv = await getOHLCV(params.neededCandles);
        if (ohlcv.length < params.neededCandles) {
            console.log(`[GRID] Not enough OHLCV data to manage ladder: ${ohlcv.length} < ${params.neededCandles}`);
            return;
        }

        const snapshot = buildSignalSnapshot(ohlcv, params);
        if (!snapshot || snapshot.invalidAtr) {
            console.log("[GRID] Invalid market snapshot. Ladder sync skipped.");
            return;
        }

        const availableUsdt = await getAvailableUSDTBalance();
        const effectiveSizeMeta = resolveEffectiveGridOrderSizeUsdt({
            availableUsdt,
            configuredOrderSizeUsdt: params.gridOrderSizeUsdt,
            configuredOrdersPerSide: params.gridOrdersPerSide,
            referencePrice: snapshot.currentPrice,
            market: exchange?.markets?.[db?.pair],
            gridLevels: params.gridLevels
        });
        params.gridOrderSizeUsdt = effectiveSizeMeta.orderSizeUsdt;
        const effectiveOrdersMeta = resolveEffectiveGridOrdersPerSide({
            availableUsdt,
            configuredOrdersPerSide: params.gridOrdersPerSide,
            perOrderMargin: params.gridOrderSizeUsdt,
            referencePrice: snapshot.currentPrice,
            market: exchange?.markets?.[db?.pair],
            gridLevels: params.gridLevels
        });
        params.gridOrdersPerSide = effectiveOrdersMeta.count;
        let openGridOrders = await fetchOpenGridOrders();
        openGridOrders = await cancelDuplicateManagedOrders(openGridOrders, "GRID_DUPLICATE", "GRID");

        if (effectiveSizeMeta.orderSizeUsdt <= 0 || effectiveOrdersMeta.count <= 0) {
            if (openGridOrders.length > 0) await cancelGridOrders(openGridOrders, "INSUFFICIENT_BALANCE");
            const reasonText = effectiveOrdersMeta.reason ? ` Reason: ${effectiveOrdersMeta.reason}` : "";
            const skipMessage = `[GRID] Auto sizing skipped ladder | size ${effectiveSizeMeta.orderSizeUsdt.toFixed(4)} USDT | side orders ${effectiveOrdersMeta.count}/${effectiveOrdersMeta.maxConfigured} | available ${availableUsdt.toFixed(2)} USDT.${reasonText}`;
            const now = Date.now();
            if (skipMessage !== lastGridSizingSkipReason || now - lastGridSizingSkipLogAt >= GRID_SIZING_SKIP_LOG_TTL) {
                console.log(skipMessage);
                lastGridSizingSkipReason = skipMessage;
                lastGridSizingSkipLogAt = now;
            }
            return;
        }

        lastGridSizingSkipReason = "";

        if (effectiveSizeMeta.mode === "FULL_AUTO") {
            maybeLogGridSizingState(
                "SIZE",
                `[GRID] Auto-sized order amount: ${effectiveSizeMeta.orderSizeUsdt.toFixed(4)} USDT per order | available ${availableUsdt.toFixed(2)} USDT`,
                `SIZE:${effectiveSizeMeta.orderSizeUsdt.toFixed(4)}:${availableUsdt.toFixed(2)}`
            );
        }
        if (effectiveOrdersMeta.count < effectiveOrdersMeta.maxConfigured) {
            maybeLogGridSizingState(
                "COUNT",
                `[GRID] Auto-adjusted side orders: ${effectiveOrdersMeta.count}/${effectiveOrdersMeta.maxConfigured} per side | mode ${effectiveOrdersMeta.mode} | available ${availableUsdt.toFixed(2)} USDT`,
                `COUNT:${effectiveOrdersMeta.count}/${effectiveOrdersMeta.maxConfigured}:${effectiveOrdersMeta.mode}:${availableUsdt.toFixed(2)}`
            );
        }

        const openPositions = await fetchOpenExchangePositions();
        const trackedPositions = getActivePositionsList();

        const lockedGridState = await resolveActiveGridState(snapshot, params);
        if (!lockedGridState) {
            console.log("[GRID] Unable to resolve locked grid state. Ladder sync skipped.");
            return;
        }

        const desiredOrdersRaw = buildGridEntryOrders(snapshot, params, lockedGridState);
        const desiredOrdersForRuntime = filterGridOrdersForActiveExposure(desiredOrdersRaw, openPositions, trackedPositions);
        if (desiredOrdersForRuntime.length !== desiredOrdersRaw.length) {
            const exposureLogKey = `${accountPositionMode.label}:${desiredOrdersForRuntime.length}/${desiredOrdersRaw.length}`;
            const now = Date.now();
            if (exposureLogKey !== lastGridExposureLogKey || now - lastGridExposureLogAt >= GRID_SYNC_LOG_TTL) {
                console.log(`[GRID] Active position detected in ${accountPositionMode.label}. Keeping ${desiredOrdersForRuntime.length}/${desiredOrdersRaw.length} ladder order(s) aligned with the live exposure.`);
                lastGridExposureLogKey = exposureLogKey;
                lastGridExposureLogAt = now;
            }
        }
        const desiredOrderMap = new Map();
        const duplicateDesiredOrders = [];
        for (const order of desiredOrdersForRuntime) {
            if (desiredOrderMap.has(order.clientOrderId)) duplicateDesiredOrders.push(order);
            else desiredOrderMap.set(order.clientOrderId, order);
        }
        if (duplicateDesiredOrders.length > 0) {
            console.warn(`[GRID] Deduped ${duplicateDesiredOrders.length} desired grid order(s) with colliding clientOrderId.`);
        }
        const desiredOrders = [...desiredOrderMap.values()];
        logGridSyncStatus(desiredOrders, openGridOrders);

        const desiredIds = new Set(desiredOrders.map((order) => order.clientOrderId));
        const staleOrders = openGridOrders.filter((order) => !desiredIds.has(getExchangeClientOrderId(order)));
        if (staleOrders.length > 0) await cancelGridOrders(staleOrders, "REBUILD");

        if (staleOrders.length > 0) {
            openGridOrders = await fetchOpenGridOrders();
            openGridOrders = await cancelDuplicateManagedOrders(openGridOrders, "GRID_DUPLICATE", "GRID");
        }

        const openOrderIds = new Set(openGridOrders.map((order) => getExchangeClientOrderId(order)));
        for (const desiredOrder of desiredOrders) {
            if (openOrderIds.has(desiredOrder.clientOrderId)) continue;
            await placeGridEntryOrder(desiredOrder);
        }
    } finally {
        isSyncingGridOrders = false;
    }
};

const formatOrderSummary = (order, typeLabel) => {
    const side = String(order?.side || "").toUpperCase();
    const amount = getOrderQuantity(order);
    const price = typeLabel === "SL" ? getOrderTriggerPrice(order) : toFiniteNumber(order?.price, NaN);
    const clientId = getExchangeClientOrderId(order) || "N/A";
    return `${typeLabel} ${side} qty=${Number.isFinite(amount) ? amount : "N/A"} price=${Number.isFinite(price) ? price : "N/A"} id=${clientId}`;
};

const { placeOrder } = createTradeEntryHelpers({
    getDb: () => db,
    getExchange: () => exchange,
    getMetrics: () => metrics,
    isHedgeModeEnabled: () => isHedgeModeEnabled(),
    getIsPlacingOrder: () => isPlacingOrder,
    setIsPlacingOrder: (value) => { isPlacingOrder = value; },
    getIsClosingPosition: () => isClosingPosition,
    getOrderPositionSide,
    getActivePositionByKey,
    setMarginMode: (...args) => setMarginMode(...args),
    fetchOpenExchangePositions: (...args) => fetchOpenExchangePositions(...args),
    matchesTrackedPositionSide,
    fetchManagedOpenOrdersSnapshot,
    setLeverage: (...args) => setLeverage(...args),
    getPrice: (...args) => getPrice(...args),
    parseSignalOrderData,
    formatAmountToMarketPrecision,
    validateOrderSize,
    buildOrderPlan,
    logOrderPlan,
    isDirectionalOrderPlanValid,
    buildExchangeOrderParams,
    getOrderFillSnapshot,
    upsertActivePosition,
    toFiniteNumber,
    saveDB: (...args) => saveDB(...args),
    ensureReduceOnlyTakeProfitOrder,
    ensureReduceOnlyStopLossOrder,
    logTrade: (...args) => logTrade(...args),
    syncPositionWithExchange: (...args) => syncPositionWithExchange(...args)
});

// -------------------- CLOSE POSITION --------------------
// -------------------- UTILITY FUNCTIONS --------------------
const getPrice = async (forceRefresh = false) => {
    try {
        const now = Date.now();
        if (!forceRefresh && now - tickerCache.lastUpdate < TICKER_CACHE_TTL) return tickerCache.price;
        const ticker = await retry(() => exchange.fetchTicker(db.pair));
        metrics.api.ticker++;
        const latestPrice = toFiniteNumber(ticker?.last, null);
        if (latestPrice) { tickerCache.price = latestPrice; tickerCache.lastUpdate = now; }
        return latestPrice;
    } catch (error) {
        console.error("[ERROR] Failed to get price after retries:", error.message);
        return tickerCache.price;
    }
};

const getOHLCV = async (limit = 100, forceRefresh = false) => {
    const timeframe = db?.gridTimeframe || "5m";
    const cacheKey = `${db?.pair || ""}:${timeframe}:${limit}`;
    const now = Date.now();
    if (!forceRefresh && ohlcvCache.key === cacheKey && now - ohlcvCache.lastUpdate < OHLCV_CACHE_TTL && Array.isArray(ohlcvCache.data)) {
        return ohlcvCache.data;
    }
    try {
        const ohlcv = await retry(() => exchange.fetchOHLCV(db.pair, timeframe, undefined, limit));
        metrics.api.ohlcv++;
        ohlcvCache = { key: cacheKey, data: ohlcv, lastUpdate: now };
        return ohlcv;
    } catch (error) {
        console.error("[ERROR] Failed to fetch OHLCV after retries:", error.message);
        return ohlcvCache.data || [];
    }
};

const escapeCsvField = (value) => {
    const text = String(value ?? "");
    if (!/[",\r\n]/.test(text)) return text;
    return `"${text.replace(/"/g, '""')}"`;
};

const logTrade = (side, entry, exit, status, pnl = 0, strategyOverride = null) => {
    try {
        ensureFileExists(logPath, "timestamp,pair,side,entry,exit,status,pnl,leverage,margin_mode,stop_loss_percent,strategy\n");
        const timestamp = new Date().toISOString();
        const parsedTime = Date.parse(timestamp);
        lastTradeAt = Number.isFinite(parsedTime) ? parsedTime : Date.now();
        const marginMode = (db.marginMode || "isolated").toUpperCase();
        const strategy = strategyOverride || getPrimaryActivePosition()?.strategy || `FUTURES_GRID_${String(db.gridTimeframe || "5m").toUpperCase()}`;
        const line = [
            timestamp,
            escapeCsvField(db.pair),
            escapeCsvField(side),
            escapeCsvField(entry),
            escapeCsvField(exit || ""),
            escapeCsvField(status),
            escapeCsvField(pnl.toFixed(4)),
            escapeCsvField(db.leverage),
            escapeCsvField(marginMode),
            escapeCsvField(db.gridStopLossPercent),
            escapeCsvField(strategy)
        ].join(",") + "\n";
        fs.appendFileSync(logPath, line);
    } catch (error) { console.error("[ERROR] Failed to log trade:", error.message); }
};

const extractUsdtBalanceSnapshot = (balance) => {
    const usdtAccountEntry = Array.isArray(balance?.info)
        ? balance.info.find((entry) => String(entry?.asset || "").toUpperCase() === "USDT")
        : null;
    const totalUSDT = toFiniteNumber(
        balance?.total?.USDT,
        toFiniteNumber(
            usdtAccountEntry?.balance,
            toFiniteNumber(usdtAccountEntry?.walletBalance, 0)
        )
    );
    const availableUSDT = toFiniteNumber(
        balance?.free?.USDT,
        toFiniteNumber(usdtAccountEntry?.availableBalance, totalUSDT)
    );
    return { totalUSDT, availableUSDT };
};

const getTotalUSDTBalance = async (forceRefresh = false) => {
    try {
        const now = Date.now();
        if (!forceRefresh && now - balanceCache.lastUpdate < BALANCE_CACHE_TTL) return balanceCache.totalUSDT;
        const balance = await exchange.fetchBalance();
        metrics.api.balance++;
        const { totalUSDT, availableUSDT } = extractUsdtBalanceSnapshot(balance);
        balanceCache.totalUSDT = totalUSDT;
        balanceCache.availableUSDT = availableUSDT;
        balanceCache.lastUpdate = now;
        return balanceCache.totalUSDT;
    } catch (error) { console.error("[ERROR] Failed to fetch balance:", error.message); return balanceCache.totalUSDT || 0; }
};

const getAvailableUSDTBalance = async (forceRefresh = false) => {
    try {
        const now = Date.now();
        if (!forceRefresh && now - balanceCache.lastUpdate < BALANCE_CACHE_TTL) {
            return Number.isFinite(balanceCache.availableUSDT) ? balanceCache.availableUSDT : balanceCache.totalUSDT;
        }
        await getTotalUSDTBalance(forceRefresh);
        return Number.isFinite(balanceCache.availableUSDT) ? balanceCache.availableUSDT : balanceCache.totalUSDT;
    } catch (error) {
        console.error("[ERROR] Failed to resolve available balance:", error.message);
        return Number.isFinite(balanceCache.availableUSDT) ? balanceCache.availableUSDT : 0;
    }
};

const getLastTradeTimestampFromLog = () => {
    try {
        if (!fs.existsSync(logPath)) return 0;
        const content = fs.readFileSync(logPath, "utf8");
        if (!content) return 0;
        const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (lines.length <= 1) return 0;
        for (let i = lines.length - 1; i >= 1; i--) {
            const timestamp = String(lines[i]).split(",")[0];
            const parsed = Date.parse(timestamp);
            if (Number.isFinite(parsed)) return parsed;
        }
        return 0;
    } catch (error) { console.error("[ERROR] Failed to read last trade timestamp:", error.message); return 0; }
};

const validateExchangeCredentials = () => {
    const apiKey = String(process.env.API_KEY || "").trim();
    const apiSecret = String(process.env.API_SECRET || "").trim();
    if (!apiKey || !apiSecret) {
        throw new Error("Missing API_KEY or API_SECRET in .env");
    }
};

// -------------------- REAL-TIME PNL MONITORING --------------------
const startPnLMonitoring = () => {
    if (!db) return;
    const desiredInterval = Math.max(200, Math.trunc(toFiniteNumber(db.monitoringInterval, 500)));

    const monitorTick = async () => {
        if (isMonitoringPnL) return;
        isMonitoringPnL = true;
        try {
            if (!db || !hasAnyActivePosition() || isClosingPosition || isSyncingPosition || isPlacingOrder) return;
            const currentPrice = await getPrice();
            if (!currentPrice) return;
            let managedOrdersSnapshot = await fetchManagedOpenOrdersSnapshot();

            const activeEntries = getActivePositionEntries();
            for (const [positionKey, sourcePosition] of activeEntries) {
                const position = { ...sourcePosition };
                if (!Number.isFinite(position.entryPrice) || position.entryPrice <= 0 || !Number.isFinite(position.quantity) || position.quantity <= 0) {
                    console.error(`[ERROR] Invalid active position data for P&L monitoring (${positionKey}).`);
                    continue;
                }

                const previousRuntimeState = snapshotPositionRuntimeState(position);
                updateActivePositionExtremes(position, currentPrice);
                applyTrailingStopUpdate(position);
                if (didPositionRuntimeStateChange(previousRuntimeState, position)) {
                    upsertActivePosition(position);
                    await maybePersistActivePositionRuntimeState();
                    await ensureReduceOnlyStopLossOrder(positionKey, position);
                    managedOrdersSnapshot = await fetchManagedOpenOrdersSnapshot();
                }

                const pnlState = calculatePositionPnL(position, currentPrice);
                const exitState = evaluatePositionExit(position, currentPrice, pnlState, managedOrdersSnapshot);

                if (exitState.shouldClose) {
                    console.log(`[${positionKey}] ${exitState.message.trim()}`);
                    await closePosition(positionKey, exitState.reason);
                    continue;
                }

                maybeLogPositionPnL(pnlState, exitState);
            }
        } catch (error) {
            console.error("[ERROR] PnL Monitoring failed:", error.message);
        } finally {
            isMonitoringPnL = false;
        }
    };

    configureRecurringTask(
        pnlMonitorTimer, currentPnLMonitoringInterval, desiredInterval,
        "[MONITOR] Real-time P&L monitoring interval: ", monitorTick,
        (timer) => { pnlMonitorTimer = timer; }, (interval) => { currentPnLMonitoringInterval = interval; }
    );
};

const startPositionSync = () => {
    if (!db) return;
    const desiredInterval = hasAnyActivePosition() ? 5000 : 15000;
    configureRecurringTask(
        positionSyncTimer, currentPositionSyncInterval, desiredInterval,
        "[SYNC] Position sync interval: ", async () => { await syncPositionWithExchange(); },
        (timer) => { positionSyncTimer = timer; }, (interval) => { currentPositionSyncInterval = interval; }
    );
};

const shutdown = async (signal = "EXIT") => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    if (isPlacingOrder || isClosingPosition) {
        console.log("[SHUTDOWN] Waiting for active transaction to complete...");
        await sleep(2000);
    }

    console.log(`\n[SHUTDOWN] Received ${signal}. Stopping bot...`);
    unregisterRuntimeCommands();
    clearRuntimeTimers();
    if (webServer) {
        try { await new Promise((resolve) => webServer.close(() => resolve())); }
        catch (error) { console.error("[ERROR] Failed to close web server:", error.message); }
        webServer = null;
    }
    try { await saveDB(); } catch (error) { console.error("[ERROR] Failed to save DB during shutdown:", error.message); }
    try { await sequelize.close(); } catch (error) { console.error("[ERROR] Failed to close DB connection:", error.message); }
    console.log("[SHUTDOWN] Bot stopped.");
    process.exit(0);
};

// -------------------- MAIN LOOP --------------------
(async () => {
    try {
        if (!(await initializeDB())) process.exit(1);
        await startWebDashboard();
        await bootstrapRuntime();
        const totalUSDT = await getTotalUSDTBalance(true);
        printStartupBanner(totalUSDT);
        lastTradeAt = getLastTradeTimestampFromLog();

        mainLoopTimer = setInterval(async () => {
            if (isProcessing) return;
            isProcessing = true;
            try { await runTradingCycle(); }
            catch (error) { console.error("[ERROR] Loop error:", error.message); }
            finally { isProcessing = false; }
        }, 2000);

        registerRuntimeCommands();
    } catch (error) {
        console.error("[ERROR] Bot startup failed:", error.message);
        process.exit(1);
    }
})();
