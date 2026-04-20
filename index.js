require("dotenv").config();
const path = require("path");
const { createConfigModelHelpers } = require("./services/config-model");
const { createConfigPersistenceHelpers } = require("./services/config-persistence");
const { createConfigRuntimeHelpers } = require("./services/config-runtime");
const { createGridRuntimeHelpers } = require("./services/grid-runtime");
const { createRuntimeUtils } = require("./services/runtime-utils");
const { createRuntimeExchangeUtils } = require("./services/runtime-exchange-utils");
const { createRuntimeConfigHelpers } = require("./services/runtime-config");
const { createRuntimeReportingHelpers } = require("./services/runtime-reporting");
const { createRuntimeDashboardHelpers } = require("./services/runtime-dashboard");
const { createRuntimeExchangeBootstrapHelpers } = require("./services/runtime-exchange-bootstrap");
const { createRuntimeCycleHelpers } = require("./services/runtime-cycle");
const { createRuntimeMonitoringHelpers } = require("./services/runtime-monitoring");
const { createRuntimeMarketDataHelpers } = require("./services/runtime-market-data");
const { createRuntimePositionUtils } = require("./services/runtime-position-utils");
const { createRuntimeSignalGridHelpers } = require("./services/runtime-signal-grid");
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

const { getDefaultConfig } = createRuntimeConfigHelpers({
    defaultConfig: DEFAULT_CONFIG
});

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
    logCreated: () => console.log("[CONFIG][INFO] Created new config row")
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
    gridClientOrderPrefix: GRID_CLIENT_ORDER_PREFIX,
    tpClientOrderPrefix: TP_CLIENT_ORDER_PREFIX,
    slClientOrderPrefix: SL_CLIENT_ORDER_PREFIX
});

const {
    resetMetricWindow,
    resetDailyTradeMetrics,
    printStartupBanner
} = createRuntimeReportingHelpers({
    getMetrics: () => metrics,
    getDb: () => db,
    getGridRuntimeSummary: (...args) => getGridRuntimeSummary(...args),
    getAccountPositionMode: () => accountPositionMode
});

const {
    buildReplacementClientOrderId,
    extractExchangeErrorCode,
    isExchangeTimestampError,
    isDuplicateClientOrderIdError,
    getExchangeClientOrderId
} = createRuntimeExchangeUtils({
    toFiniteNumber
});

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

const {
    formatOrderSummary,
    getPrice,
    getOHLCV,
    logTrade,
    getTotalUSDTBalance,
    getAvailableUSDTBalance,
    getLastTradeTimestampFromLog,
    formatStatusTimestamp
} = createRuntimeMarketDataHelpers({
    getExchange: () => exchange,
    getDb: () => db,
    getMetrics: () => metrics,
    getBalanceCache: () => balanceCache,
    setBalanceCache: (value) => { balanceCache = value; },
    getTickerCache: () => tickerCache,
    setTickerCache: (value) => { tickerCache = value; },
    getOhlcvCache: () => ohlcvCache,
    setOhlcvCache: (value) => { ohlcvCache = value; },
    retry,
    toFiniteNumber,
    ensureFileExists,
    logPath,
    getPrimaryActivePosition: (...args) => getPrimaryActivePosition(...args),
    setLastTradeAt: (value) => { lastTradeAt = value; },
    balanceCacheTtl: BALANCE_CACHE_TTL,
    tickerCacheTtl: TICKER_CACHE_TTL,
    ohlcvCacheTtl: OHLCV_CACHE_TTL,
    getExchangeClientOrderId,
    getOrderQuantity: (...args) => getOrderQuantity(...args),
    getOrderTriggerPrice: (...args) => getOrderTriggerPrice(...args)
});

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

const validateOrderSize = (market, quantity, referencePrice, options = {}) => {
    const { allowReduceOnlyClose = false } = options;
    if (!Number.isFinite(quantity) || quantity <= 0) {
        return { valid: false, reason: "[ORDER][ERROR] Invalid order quantity after precision adjustment." };
    }
    const minAmount = Number(market?.limits?.amount?.min);
    if (Number.isFinite(minAmount) && quantity < minAmount) {
        return { valid: false, reason: `[ORDER][ERROR] Quantity ${quantity} is below exchange minimum ${minAmount}. Order skipped.` };
    }
    const notional = quantity * referencePrice;
    const minCost = Number(market?.limits?.cost?.min);
    if (Number.isFinite(minCost) && Number.isFinite(notional) && notional < minCost) {
        if (allowReduceOnlyClose) {
            return {
                valid: true,
                warning: `[ORDER][WARN] Reduce-only close notional ${notional.toFixed(6)} is below exchange minimum ${minCost}. Allowing placement because the order only closes an existing position.`
            };
        }
        return { valid: false, reason: `[ORDER][ERROR] Order notional ${notional.toFixed(6)} is below exchange minimum ${minCost}. Order skipped.` };
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
    buildExchangeOrderParams: (...args) => buildExchangeOrderParams(...args),
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

const {
    buildExchangeOrderParams,
    fetchOpenExchangePositions,
    snapshotPositionRuntimeState,
    didPositionRuntimeStateChange,
    maybePersistActivePositionRuntimeState,
    updateActivePositionExtremes,
    applyTrailingStopUpdate,
    calculatePositionPnL,
    printDetailedStatus
} = createRuntimePositionUtils({
    getDb: () => db,
    getExchange: () => exchange,
    getMetrics: () => metrics,
    isHedgeModeEnabled: () => isHedgeModeEnabled(),
    getOrderPositionSide: (...args) => getOrderPositionSide(...args),
    normalizeSymbol,
    getExchangePositionContracts: (...args) => getExchangePositionContracts(...args),
    toFiniteNumber,
    saveDB: (...args) => saveDB(...args),
    getLastPositionRuntimePersistAt: () => lastPositionRuntimePersistAt,
    setLastPositionRuntimePersistAt: (value) => { lastPositionRuntimePersistAt = value; },
    positionRuntimePersistTtl: POSITION_RUNTIME_PERSIST_TTL,
    getPrice: (...args) => getPrice(...args),
    getActivePositionEntries: (...args) => getActivePositionEntries(...args),
    fetchManagedOpenOrdersSnapshot: (...args) => fetchManagedOpenOrdersSnapshot(...args),
    getGridRuntimeSummary: (...args) => getGridRuntimeSummary(...args),
    getExchangeRecoveryReason,
    getAccountPositionMode: () => accountPositionMode,
    getIsPlacingOrder: () => isPlacingOrder,
    getIsClosingPosition: () => isClosingPosition,
    getIsSyncingPosition: () => isSyncingPosition,
    getIsSyncingGridOrders: () => isSyncingGridOrders,
    getExchangeHealth: () => exchangeHealth,
    getLastTradeAt: () => lastTradeAt,
    formatStatusTimestamp: (...args) => formatStatusTimestamp(...args),
    printStatusLine: (...args) => printStatusLine(...args),
    printOrderSample: (...args) => printOrderSample(...args),
    printPositionLine: (...args) => printPositionLine(...args)
});

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
                console.warn(`[CONFIG][WARN] Preserving runtime ${key}=${db[key]} while positions are active.`);
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
        console.log("[CONFIG][INFO] Grid parameters changed. Cleared locked grid state for rebuild.");
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
        console.log(`[CONFIG][INFO] Re-applied trading parameters to active position ${positionKey}.`);
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
    startMetricsReporting: () => startMetricsReporting(() => metricsTimer, (value) => { metricsTimer = value; }),
    startConfigAutoReload: (...args) => startConfigAutoReload(...args),
    shutdown: (...args) => shutdown(...args)
});

const {
    unregisterRuntimeCommands,
    registerRuntimeCommands,
    runTradingCycle,
    startMetricsReporting
} = createRuntimeCycleHelpers({
    getDb: () => db,
    getLastTradeAt: () => lastTradeAt,
    setRuntimeCommandsRegistered: (value) => { runtimeCommandsRegistered = value; },
    getRuntimeCommandsRegistered: () => runtimeCommandsRegistered,
    toFiniteNumber,
    getUTCDateKey,
    resetDailyTradeMetrics,
    saveDB: (...args) => saveDB(...args),
    getTotalUSDTBalance: (...args) => getTotalUSDTBalance(...args),
    reloadConfig: (...args) => reloadConfig(...args),
    refreshRuntimeSchedulers: () => refreshRuntimeSchedulers(),
    hasRuntimePositionMutationInFlight,
    canOpenNewPositions,
    logExchangeRecoveryBlock,
    fetchOpenGridOrders: (...args) => fetchOpenGridOrders(...args),
    cancelGridOrders: (...args) => cancelGridOrders(...args),
    syncGridOrders: (...args) => syncGridOrders(...args),
    isHedgeModeEnabled: () => isHedgeModeEnabled(),
    hasAnyActivePosition: () => hasAnyActivePosition(),
    getLastTradeTimestampFromLog: (...args) => getLastTradeTimestampFromLog(...args),
    analyzeSignal: (...args) => analyzeSignal(...args),
    getActivePositionByKey: (...args) => getActivePositionByKey(...args),
    placeOrder: (...args) => placeOrder(...args),
    syncPositionWithExchange: (...args) => syncPositionWithExchange(...args),
    printDetailedStatus: (...args) => printDetailedStatus(...args),
    getMetrics: () => metrics,
    resetMetricWindow,
    metricsLogInterval: METRICS_LOG_INTERVAL
});

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
    saveDB: async (...args) => { await saveDB(...args); },
    reloadConfig: async (...args) => { await reloadConfig(...args); },
    refreshRuntimeSchedulers: () => { refreshRuntimeSchedulers(); },
    syncExchangeRuntimeSettings: async () => {
        if (!exchange) return;
        await setMarginMode();
        await setLeverage();
    },
    buildDashboardPayload
});

const { startWebDashboard } = createRuntimeDashboardHelpers({
    publicDir: path.join(__dirname, "public"),
    toFiniteNumber,
    isDashboardAuthenticated,
    isDashboardLoginValid,
    setDashboardSessionCookie,
    clearDashboardSessionCookie,
    getIsShuttingDown: () => isShuttingDown,
    getDb: () => db,
    getExchange: () => exchange,
    getExchangeHealth: () => exchangeHealth,
    getExchangeRecoveryReason,
    buildDashboardPayload,
    buildLiveStatusPayload,
    applyDashboardConfigUpdate,
    resetDashboardConfig
});

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
    const autoPresetResult = applyAutoPairGridPreset(config, AUTO_PAIR_GRID_PRESETS);
    return {
        config: normalizeConfig(autoPresetResult.config),
        autoPresetResult
    };
};

const {
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

const syncPositionWithExchange = async () => {
    if (isSyncingPosition || isClosingPosition || isPlacingOrder) return;
    isSyncingPosition = true;
    try {
        if (!db || !exchange) return;
        const now = Date.now();
        if (now - lastSyncLogAt >= SYNC_LOG_TTL) {
            console.log(`[SYNC][INFO] Checking positions for ${db.pair}...`);
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
        if (getPositionMapCount(nextPositionsMap) === 0) console.log("[SYNC][INFO] Cleared local active positions from exchange state");
        else console.log(`[SYNC][INFO] Synced active positions: ${getPositionMapKeys(nextPositionsMap).join(", ")}`);

        for (const [positionKey, syncedPosition] of Object.entries(nextPositionsMap)) {
            await ensureReduceOnlyTakeProfitOrder(positionKey, syncedPosition);
            await ensureReduceOnlyStopLossOrder(positionKey, syncedPosition);
        }
        markExchangeHealthy("position sync");
    } catch (error) {
        markExchangeUnhealthy(error, "position sync");
        console.error("[SYNC][ERROR] Position sync failed:", error.message);
    }
    finally { isSyncingPosition = false; }
};

const {
    initializeExchange,
    detectPositionMode,
    setMarginMode,
    setLeverage
} = createRuntimeExchangeBootstrapHelpers({
    getDb: () => db,
    getExchange: () => exchange,
    setExchange: (value) => { exchange = value; },
    getAccountPositionMode: () => accountPositionMode,
    setAccountPositionMode: (value) => { accountPositionMode = value; },
    getLastAppliedLeverageState: () => lastAppliedLeverageState,
    setLastAppliedLeverageState: (value) => { lastAppliedLeverageState = value; },
    toFiniteNumber,
    sleep,
    extractExchangeErrorCode,
    isExchangeTimestampError,
    fetchOpenExchangePositions: async (...args) => fetchOpenExchangePositions(...args),
    fetchManagedOpenOrdersSnapshot: async (...args) => fetchManagedOpenOrdersSnapshot(...args),
    markExchangeUnhealthy
});

const {
    analyzeSignal,
    syncGridOrders
} = createRuntimeSignalGridHelpers({
    getDb: () => db,
    getAccountPositionMode: () => accountPositionMode,
    getExchange: () => exchange,
    getIsSyncingGridOrders: () => isSyncingGridOrders || isPlacingOrder || isClosingPosition || isSyncingPosition || isMonitoringPnL,
    setIsSyncingGridOrders: (value) => { isSyncingGridOrders = value; },
    getLastGridSyncLogAt: () => lastGridSyncLogAt,
    setLastGridSyncLogAt: (value) => { lastGridSyncLogAt = value; },
    getLastGridExposureLogAt: () => lastGridExposureLogAt,
    setLastGridExposureLogAt: (value) => { lastGridExposureLogAt = value; },
    getLastGridExposureLogKey: () => lastGridExposureLogKey,
    setLastGridExposureLogKey: (value) => { lastGridExposureLogKey = value; },
    getLastGridSizingSkipLogAt: () => lastGridSizingSkipLogAt,
    setLastGridSizingSkipLogAt: (value) => { lastGridSizingSkipLogAt = value; },
    getLastGridSizingSkipReason: () => lastGridSizingSkipReason,
    setLastGridSizingSkipReason: (value) => { lastGridSizingSkipReason = value; },
    getGridSizingStateLogCache: () => gridSizingStateLogCache,
    signalDetailLogTtl: SIGNAL_DETAIL_LOG_TTL,
    gridSyncLogTtl: GRID_SYNC_LOG_TTL,
    gridSizingSkipLogTtl: GRID_SIZING_SKIP_LOG_TTL,
    gridSizingStateLogTtl: GRID_SIZING_STATE_LOG_TTL,
    toFiniteNumber,
    clamp,
    resolveEffectiveGridTakeProfitLevels,
    resolveEffectiveGridStopLossSteps,
    sanitizeGridState,
    createLockedGridState,
    buildGridExitPlan,
    isDirectionalOrderPlanValid: (...args) => isDirectionalOrderPlanValid(...args),
    getSignalParameters: (...args) => getSignalParameters(...args),
    getOHLCV: (...args) => getOHLCV(...args),
    buildSignalSnapshot: (...args) => buildSignalSnapshot(...args),
    evaluateCrossoverSignal: null,
    getSignalCount: () => signalCount,
    setSignalCount: (value) => { signalCount = value; },
    getMetrics: () => metrics,
    getLastLogTime: () => lastLogTime,
    setLastLogTime: (value) => { lastLogTime = value; },
    getLastSignalDetailLogAt: () => lastSignalDetailLogAt,
    setLastSignalDetailLogAt: (value) => { lastSignalDetailLogAt = value; },
    buildRiskOverrides: () => buildRiskOverrides(),
    resolveEffectiveGridOrderSizeUsdt: (...args) => resolveEffectiveGridOrderSizeUsdt(...args),
    resolveEffectiveGridOrdersPerSide: (...args) => resolveEffectiveGridOrdersPerSide(...args),
    fetchOpenGridOrders: (...args) => fetchOpenGridOrders(...args),
    cancelDuplicateManagedOrders: (...args) => cancelDuplicateManagedOrders(...args),
    cancelGridOrders: (...args) => cancelGridOrders(...args),
    getAvailableUSDTBalance: (...args) => getAvailableUSDTBalance(...args),
    maybeLogGridSizingStateExternal: null,
    fetchOpenExchangePositions: (...args) => fetchOpenExchangePositions(...args),
    getActivePositionsList: (...args) => getActivePositionsList(...args),
    resolveActiveGridState: (...args) => resolveActiveGridState(...args),
    buildGridEntryOrders: (...args) => buildGridEntryOrders(...args),
    filterGridOrdersForActiveExposure: (...args) => filterGridOrdersForActiveExposure(...args),
    getExchangeClientOrderId,
    placeGridEntryOrder: (...args) => placeGridEntryOrder(...args),
    isHedgeModeEnabled: () => isHedgeModeEnabled(),
    hasAnyActivePosition: () => hasAnyActivePosition(),
    getActivePositionByKey: (...args) => getActivePositionByKey(...args),
    placeOrder: (...args) => placeOrder(...args)
});

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

const {
    startPnLMonitoring,
    startPositionSync,
    shutdown
} = createRuntimeMonitoringHelpers({
    getDb: () => db,
    toFiniteNumber,
    configureRecurringTask: (...args) => configureRecurringTask(...args),
    getPnLMonitorTimer: () => pnlMonitorTimer,
    setPnLMonitorTimer: (value) => { pnlMonitorTimer = value; },
    getCurrentPnLMonitoringInterval: () => currentPnLMonitoringInterval,
    setCurrentPnLMonitoringInterval: (value) => { currentPnLMonitoringInterval = value; },
    getIsMonitoringPnL: () => isMonitoringPnL,
    setIsMonitoringPnL: (value) => { isMonitoringPnL = value; },
    hasAnyActivePosition: () => hasAnyActivePosition(),
    getIsClosingPosition: () => isClosingPosition,
    getIsSyncingPosition: () => isSyncingPosition,
    getIsPlacingOrder: () => isPlacingOrder,
    getPrice: (...args) => getPrice(...args),
    fetchManagedOpenOrdersSnapshot: (...args) => fetchManagedOpenOrdersSnapshot(...args),
    getActivePositionEntries: (...args) => getActivePositionEntries(...args),
    snapshotPositionRuntimeState: (...args) => snapshotPositionRuntimeState(...args),
    updateActivePositionExtremes: (...args) => updateActivePositionExtremes(...args),
    applyTrailingStopUpdate: (...args) => applyTrailingStopUpdate(...args),
    didPositionRuntimeStateChange: (...args) => didPositionRuntimeStateChange(...args),
    upsertActivePosition: (...args) => upsertActivePosition(...args),
    maybePersistActivePositionRuntimeState: (...args) => maybePersistActivePositionRuntimeState(...args),
    ensureReduceOnlyStopLossOrder: (...args) => ensureReduceOnlyStopLossOrder(...args),
    calculatePositionPnL: (...args) => calculatePositionPnL(...args),
    evaluatePositionExit: (...args) => evaluatePositionExit(...args),
    closePosition: (...args) => closePosition(...args),
    maybeLogPositionPnL: (...args) => maybeLogPositionPnL(...args),
    getPositionSyncTimer: () => positionSyncTimer,
    setPositionSyncTimer: (value) => { positionSyncTimer = value; },
    getCurrentPositionSyncInterval: () => currentPositionSyncInterval,
    setCurrentPositionSyncInterval: (value) => { currentPositionSyncInterval = value; },
    syncPositionWithExchange: (...args) => syncPositionWithExchange(...args),
    saveDB: (...args) => saveDB(...args),
    sleep,
    clearRuntimeTimers: () => clearRuntimeTimers(),
    closeWebServer: async () => await new Promise((resolve) => webServer.close(() => resolve())),
    clearWebServer: () => { webServer = null; },
    closeSequelize: async () => await sequelize.close(),
    getWebServer: () => webServer,
    getIsShuttingDown: () => isShuttingDown,
    setIsShuttingDown: (value) => { isShuttingDown = value; },
    getIsPlacingOrderState: () => isPlacingOrder,
    getIsClosingPositionState: () => isClosingPosition,
    unregisterRuntimeCommands: () => unregisterRuntimeCommands(),
    exitProcess: (code) => process.exit(code)
});

(async () => {
    try {
        if (!(await initializeDB())) process.exit(1);
        webServer = await startWebDashboard(webServer);
        await bootstrapRuntime();
        const totalUSDT = await getTotalUSDTBalance(true);
        printStartupBanner(totalUSDT);
        lastTradeAt = getLastTradeTimestampFromLog();

        mainLoopTimer = setInterval(async () => {
            if (isProcessing) return;
            isProcessing = true;
            try { await runTradingCycle(); }
            catch (error) { console.error("[APP][ERROR] Main loop failed:", error.message); }
            finally { isProcessing = false; }
        }, 2000);

        registerRuntimeCommands();
    } catch (error) {
        console.error("[APP][ERROR] Bot startup failed:", error.message);
        process.exit(1);
    }
})();
