require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const ccxt = require("ccxt");
const { Sequelize, DataTypes } = require('sequelize');
const { createConfigPersistenceHelpers } = require("./services/config-persistence");
const { createDashboardConfigHelpers } = require("./services/dashboard-config");
const { createDashboardSessionHelpers } = require("./services/dashboard-session");
const { createExchangePositionHelpers } = require("./services/exchange-position");
const { createManagedOrdersHelpers } = require("./services/managed-orders");
const { createOrderExecutionHelpers } = require("./services/order-execution");
const { createPositionLifecycleHelpers } = require("./services/position-lifecycle");
const { createTradeEntryHelpers } = require("./services/trade-entry");
const { createTradeLogicHelpers } = require("./services/trade-logic");
const { createPositionStateHelpers } = require("./services/position-state");
const { createRuntimeSchedulerHelpers } = require("./services/runtime-scheduler");

// -------------------- DATABASE SETUP --------------------
const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: path.join(__dirname, 'database.sqlite'),
    logging: false
});

const Config = sequelize.define('Config', {
    strategy: { type: DataTypes.STRING, defaultValue: "futures_grid" },
    pair: { type: DataTypes.STRING, defaultValue: "DOGE/USDT:USDT" },
    gridOrderSizeUsdt: { type: DataTypes.FLOAT, defaultValue: 0 },
    leverage: { type: DataTypes.INTEGER, defaultValue: 10 },
    gridTargetProfitUsdt: { type: DataTypes.FLOAT, defaultValue: 0.5 },
    dailyProfitTargetUsdt: { type: DataTypes.FLOAT, defaultValue: 1.0 },
    dailyMaxLossPercent: { type: DataTypes.FLOAT, defaultValue: 10 },
    maxTradesPerDay: { type: DataTypes.INTEGER, defaultValue: 20 },
    coolingPeriod: { type: DataTypes.INTEGER, defaultValue: 3000 },
    activePosition: { type: DataTypes.TEXT, defaultValue: null },
    activeGridState: { type: DataTypes.TEXT, defaultValue: null },
    dailyPnL: { type: DataTypes.FLOAT, defaultValue: 0 },
    dailyTrades: { type: DataTypes.INTEGER, defaultValue: 0 },
    marginMode: { type: DataTypes.STRING, defaultValue: "isolated" },
    monitoringInterval: { type: DataTypes.INTEGER, defaultValue: 500 },
    gridStopLossPercent: { type: DataTypes.FLOAT, defaultValue: 5 },

    // Binance-style futures grid parameters
    gridLevels: { type: DataTypes.INTEGER, defaultValue: 8 },
    gridLookbackCandles: { type: DataTypes.INTEGER, defaultValue: 120 },
    gridRangePercent: { type: DataTypes.FLOAT, defaultValue: 3.5 },
    gridEntryBufferPercent: { type: DataTypes.FLOAT, defaultValue: 0.15 },
    gridTakeProfitLevels: { type: DataTypes.INTEGER, defaultValue: 0 },
    gridOrdersPerSide: { type: DataTypes.INTEGER, defaultValue: 0 },
    gridStopLossLevels: { type: DataTypes.FLOAT, defaultValue: 0 },

    // Additional parameters
    gridTimeframe: { type: DataTypes.STRING, defaultValue: "5m" },
    sessionStartUTC: { type: DataTypes.INTEGER, defaultValue: 0 },
    sessionEndUTC: { type: DataTypes.INTEGER, defaultValue: 23 },
    volumePeriod: { type: DataTypes.INTEGER, defaultValue: 20 },
    minVolumeRatio: { type: DataTypes.FLOAT, defaultValue: 1.3 },
    atrPeriod: { type: DataTypes.INTEGER, defaultValue: 14 },
    trailingEnabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    trailingActivateATR: { type: DataTypes.FLOAT, defaultValue: 1.2 },
    trailingOffsetATR: { type: DataTypes.FLOAT, defaultValue: 0.6 },
    allowLong: { type: DataTypes.BOOLEAN, defaultValue: true },
    allowShort: { type: DataTypes.BOOLEAN, defaultValue: true },

    lastDailyReset: { type: DataTypes.BIGINT, defaultValue: () => Date.now() },
    lastUpdated: { type: DataTypes.BIGINT, defaultValue: () => Date.now() }
}, { timestamps: false });

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
const BOOLEAN_CONFIG_KEYS = ["trailingEnabled", "allowLong", "allowShort"];
const VALID_MARGIN_MODES = ["cross", "isolated"];
const DEFAULT_CONFIG = {
    strategy: "futures_grid",
    pair: "DOGE/USDT:USDT",
    gridOrderSizeUsdt: 0,
    leverage: 10,
    gridTargetProfitUsdt: 0.5,
    dailyProfitTargetUsdt: 1.0,
    dailyMaxLossPercent: 10,
    maxTradesPerDay: 20,
    coolingPeriod: 3000,
    activePosition: null,
    activeGridState: null,
    dailyPnL: 0,
    dailyTrades: 0,
    marginMode: "isolated",
    monitoringInterval: 500,
    gridStopLossPercent: 5,
    gridLevels: 8,
    gridLookbackCandles: 120,
    gridRangePercent: 3.5,
    gridEntryBufferPercent: 0.15,
    gridTakeProfitLevels: 0,
    gridOrdersPerSide: 0,
    gridStopLossLevels: 0,
    gridTimeframe: "5m",
    sessionStartUTC: 0,
    sessionEndUTC: 23,
    volumePeriod: 20,
    minVolumeRatio: 1.3,
    atrPeriod: 14,
    trailingEnabled: true,
    trailingActivateATR: 1.2,
    trailingOffsetATR: 0.6,
    allowLong: true,
    allowShort: true
};
const GRID_CLIENT_ORDER_PREFIX = "smartgrid";
const TP_CLIENT_ORDER_PREFIX = "smarttp";
const SL_CLIENT_ORDER_PREFIX = "smartsl";

const DASHBOARD_EDITABLE_FIELDS = [
    { key: "strategy", label: "Strategy", section: "General", type: "select", options: ["futures_grid"], description: "Main strategy used by the bot." },
    { key: "pair", label: "Pair", section: "General", type: "text", placeholder: "DOGE/USDT:USDT", description: "Futures symbol to trade." },
    { key: "marginMode", label: "Margin Mode", section: "General", type: "select", options: ["isolated", "cross"], description: "Margin mode used on the exchange." },
    { key: "leverage", label: "Leverage", section: "General", type: "number", min: 1, step: 1, description: "Futures leverage." },
    { key: "monitoringInterval", label: "Monitoring Interval", section: "General", type: "number", min: 200, step: 100, description: "PnL monitoring interval in milliseconds." },
    { key: "coolingPeriod", label: "Cooling Period", section: "General", type: "number", min: 0, step: 500, description: "Cooldown after a trade in milliseconds." },

    { key: "gridOrderSizeUsdt", label: "Grid Order Size (USDT)", section: "Risk", type: "number", min: 0, step: 0.1, description: "Order size per grid entry in USDT." },
    { key: "gridTargetProfitUsdt", label: "Target Profit (USDT)", section: "Risk", type: "number", min: 0, step: 0.1, description: "Take-profit target in USDT." },
    { key: "gridStopLossPercent", label: "Stop Loss (%)", section: "Risk", type: "number", min: 0, step: 0.1, description: "Stop loss percentage used by the grid engine." },
    { key: "dailyProfitTargetUsdt", label: "Daily Profit Target (USDT)", section: "Risk", type: "number", min: 0, step: 0.1, description: "Pause trading after this realized profit is reached." },
    { key: "dailyMaxLossPercent", label: "Daily Max Loss (%)", section: "Risk", type: "number", min: 0, step: 0.1, description: "Pause trading after this loss percentage is reached." },
    { key: "maxTradesPerDay", label: "Max Trades Per Day", section: "Risk", type: "number", min: 0, step: 1, description: "Daily trade cap." },
    { key: "minVolumeRatio", label: "Min Volume Ratio", section: "Risk", type: "number", min: 1, step: 0.1, description: "Minimum volume filter." },

    { key: "gridLevels", label: "Grid Levels", section: "Grid", type: "number", min: 4, step: 1, description: "Number of levels in the grid." },
    { key: "gridLookbackCandles", label: "Lookback Candles", section: "Grid", type: "number", min: 20, step: 1, description: "Candles used to calculate the grid range." },
    { key: "gridRangePercent", label: "Range (%)", section: "Grid", type: "number", min: 0.5, step: 0.1, description: "Grid range width in percent." },
    { key: "gridEntryBufferPercent", label: "Entry Buffer (%)", section: "Grid", type: "number", min: 0.02, step: 0.01, description: "Buffer around grid levels for entries." },
    { key: "gridTakeProfitLevels", label: "Take Profit Levels", section: "Grid", type: "number", min: 0, step: 1, description: "TP level offset from the entry level." },
    { key: "gridOrdersPerSide", label: "Orders Per Side", section: "Grid", type: "number", min: 0, step: 1, description: "Number of ladder orders per side." },
    { key: "gridStopLossLevels", label: "Stop Loss Levels", section: "Grid", type: "number", min: 0, step: 0.1, description: "Stop loss offset in grid steps." },
    { key: "gridTimeframe", label: "Grid Timeframe", section: "Grid", type: "select", options: ["1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d"], description: "Timeframe used to build the grid." },

    { key: "sessionStartUTC", label: "Session Start UTC", section: "Session", type: "number", min: 0, max: 23, step: 1, description: "Trading session start hour in UTC." },
    { key: "sessionEndUTC", label: "Session End UTC", section: "Session", type: "number", min: 0, max: 23, step: 1, description: "Trading session end hour in UTC." },
    { key: "volumePeriod", label: "Volume Period", section: "Session", type: "number", min: 2, step: 1, description: "Volume lookback period." },
    { key: "atrPeriod", label: "ATR Period", section: "Session", type: "number", min: 2, step: 1, description: "ATR calculation period." },

    { key: "trailingEnabled", label: "Trailing Enabled", section: "Trailing", type: "boolean", description: "Enable trailing stop logic." },
    { key: "trailingActivateATR", label: "Trail Activate ATR", section: "Trailing", type: "number", min: 0.2, step: 0.1, description: "ATR multiple needed before trailing starts." },
    { key: "trailingOffsetATR", label: "Trail Offset ATR", section: "Trailing", type: "number", min: 0.1, step: 0.1, description: "ATR offset used by the trailing stop." },
    { key: "allowLong", label: "Allow Long", section: "Direction", type: "boolean", description: "Allow long entries." },
    { key: "allowShort", label: "Allow Short", section: "Direction", type: "boolean", description: "Allow short entries." }
];

const DASHBOARD_EDITABLE_KEYS = new Set(DASHBOARD_EDITABLE_FIELDS.map((field) => field.key));
const RUNTIME_PROTECTED_CONFIG_KEYS = ["strategy", "pair", "leverage", "marginMode", "gridTimeframe"];
const DASHBOARD_PROTECTED_KEYS = new Set(RUNTIME_PROTECTED_CONFIG_KEYS);
const DASHBOARD_USERNAME = String(process.env.DASHBOARD_USERNAME || "admin");
const DASHBOARD_PASSWORD = String(process.env.DASHBOARD_PASSWORD || "admin123");
const DASHBOARD_SESSION_SECRET = String(process.env.DASHBOARD_SESSION_SECRET || process.env.API_SECRET || "smart-bot-dashboard-secret");
const DASHBOARD_SESSION_COOKIE = "smartbot_dashboard_session";
const DASHBOARD_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const CONFIG_AUTO_RELOAD_INTERVAL_MS = Math.max(3000, Math.trunc(Number(process.env.CONFIG_AUTO_RELOAD_INTERVAL_MS || 5000) || 5000));
let lastKnownDashboardConfigSignature = "";

let metrics = {
    windowStart: Date.now(),
    api: { ticker: 0, ohlcv: 0, balance: 0, positions: 0, orders: 0 },
    signals: { analyzed: 0, crossoverDetected: 0, longConfirmed: 0, shortConfirmed: 0 },
    trades: { opened: 0, closed: 0, wins: 0, losses: 0 }
};

// -------------------- RETRY HELPER --------------------
const retry = async (fn, retries = 3, delay = 1000) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === retries - 1) throw error;
            console.log(`[RETRY] Attempt ${i + 1} failed, retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2;
        }
    }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withSqliteBusyRetry = async (fn, { attempts = 5, delayMs = 150 } = {}) => {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            const message = String(error?.message || error);
            const isBusy = message.includes("SQLITE_BUSY") || message.includes("database is locked");
            if (!isBusy || attempt === attempts - 1) throw error;
            await sleep(delayMs);
        }
    }
    throw lastError;
};

// -------------------- ENSURE LOG FILE EXISTS --------------------
const ensureFileExists = (filePath, defaultContent = "{}") => {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, defaultContent, 'utf8');
            console.log(`[OK] Created ${path.basename(filePath)} file`);
        }
        return true;
    } catch (error) {
        console.error(`[ERROR] Failed to create ${path.basename(filePath)}:`, error.message);
        return false;
    }
};

const safeParseJSON = (value, fallback = null) => {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "object") return value;
    if (typeof value !== "string") return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
};

const toFiniteNumber = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

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

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const getUTCDateKey = (timestamp) => {
    const parsed = toFiniteNumber(timestamp, NaN);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "";
};

const isSameUTCDate = (leftTimestamp, rightTimestamp) => {
    const leftDateKey = getUTCDateKey(leftTimestamp);
    const rightDateKey = getUTCDateKey(rightTimestamp);
    return Boolean(leftDateKey) && leftDateKey === rightDateKey;
};

const normalizeActivePositionState = (activePosition) => {
    const parsed = safeParseJSON(activePosition, null);
    if (!parsed || typeof parsed !== "object") return null;
    if (isLegacySinglePosition(parsed)) {
        const legacyPositionSide = String(parsed.positionSide || "").toUpperCase();
        const legacySideValue = String(parsed.side || "").toLowerCase();
        const legacySide = legacyPositionSide || (legacySideValue === "buy" ? "LONG" : (legacySideValue === "sell" ? "SHORT" : "BOTH"));
        const legacyKey = toPositionMapKey(legacySide);
        return { [legacyKey]: parsed };
    }

    const normalizedEntries = Object.entries(parsed)
        .filter(([, value]) => value && typeof value === "object")
        .map(([key, value]) => [toPositionMapKey(key), value]);
    return normalizedEntries.length > 0 ? Object.fromEntries(normalizedEntries) : null;
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

const hydrateConfig = (config) => {
    const hydrated = { ...config };
    if (hydrated.gridOrderSizeUsdt === undefined && hydrated.usdtPerTrade !== undefined) {
        hydrated.gridOrderSizeUsdt = hydrated.usdtPerTrade;
    }
    delete hydrated.usdtPerTrade;
    if (hydrated.gridTargetProfitUsdt === undefined && hydrated.targetProfitUSDT !== undefined) {
        hydrated.gridTargetProfitUsdt = hydrated.targetProfitUSDT;
    }
    delete hydrated.targetProfitUSDT;
    if (hydrated.gridStopLossPercent === undefined && hydrated.stopLossPercent !== undefined) {
        hydrated.gridStopLossPercent = hydrated.stopLossPercent;
    }
    delete hydrated.stopLossPercent;
    if (hydrated.gridTimeframe === undefined && typeof hydrated.breakoutTimeframe === "string") {
        hydrated.gridTimeframe = hydrated.breakoutTimeframe;
    }
    delete hydrated.breakoutTimeframe;
    if (hydrated.dailyProfitTargetUsdt === undefined && hydrated.targetDailyProfit !== undefined) {
        hydrated.dailyProfitTargetUsdt = hydrated.targetDailyProfit;
    }
    delete hydrated.targetDailyProfit;
    if (hydrated.dailyMaxLossPercent === undefined && hydrated.maxDailyLossPercent !== undefined) {
        hydrated.dailyMaxLossPercent = hydrated.maxDailyLossPercent;
    }
    delete hydrated.maxDailyLossPercent;
    hydrated.activePosition = normalizeActivePositionState(hydrated.activePosition);
    hydrated.activeGridState = safeParseJSON(hydrated.activeGridState, null);
    return normalizeConfig(hydrated);
};

const serializeConfigForSave = (config) => ({
    ...config,
    activePosition: config.activePosition ? JSON.stringify(config.activePosition) : null,
    activeGridState: config.activeGridState ? JSON.stringify(config.activeGridState) : null,
    lastUpdated: Date.now()
});

const getConfigRow = async () => withSqliteBusyRetry(() => Config.findOne());
const OBSOLETE_CONFIG_COLUMNS = ["autoRiskEnabled", "atrTargetMult", "atrStopMult"];

const ensureConfigSchema = async () => {
    await withSqliteBusyRetry(() => sequelize.sync());
    const tableInfo = await withSqliteBusyRetry(() => sequelize.query("PRAGMA table_info('Configs');", { type: sequelize.QueryTypes.SELECT }));
    const columnNames = new Set(tableInfo.map((column) => String(column.name)));
    if (!columnNames.has("gridOrderSizeUsdt")) {
        await withSqliteBusyRetry(() => sequelize.query("ALTER TABLE Configs ADD COLUMN gridOrderSizeUsdt FLOAT DEFAULT 1.5;"));
        if (columnNames.has("usdtPerTrade")) {
            await withSqliteBusyRetry(() => sequelize.query("UPDATE Configs SET gridOrderSizeUsdt = COALESCE(usdtPerTrade, 1.5) WHERE gridOrderSizeUsdt IS NULL OR gridOrderSizeUsdt = '';"));
        }
        console.log("[INFO] Added config column: gridOrderSizeUsdt");
    }
    if (!columnNames.has("gridTargetProfitUsdt")) {
        await withSqliteBusyRetry(() => sequelize.query("ALTER TABLE Configs ADD COLUMN gridTargetProfitUsdt FLOAT DEFAULT 0.5;"));
        if (columnNames.has("targetProfitUSDT")) {
            await withSqliteBusyRetry(() => sequelize.query("UPDATE Configs SET gridTargetProfitUsdt = COALESCE(targetProfitUSDT, 0.5) WHERE gridTargetProfitUsdt IS NULL OR gridTargetProfitUsdt = '';"));
        }
        console.log("[INFO] Added config column: gridTargetProfitUsdt");
    }
    if (!columnNames.has("gridStopLossPercent")) {
        await withSqliteBusyRetry(() => sequelize.query("ALTER TABLE Configs ADD COLUMN gridStopLossPercent FLOAT DEFAULT 5;"));
        if (columnNames.has("stopLossPercent")) {
            await withSqliteBusyRetry(() => sequelize.query("UPDATE Configs SET gridStopLossPercent = COALESCE(stopLossPercent, 5) WHERE gridStopLossPercent IS NULL OR gridStopLossPercent = '';"));
        }
        console.log("[INFO] Added config column: gridStopLossPercent");
    }
    if (!columnNames.has("gridTimeframe")) {
        await withSqliteBusyRetry(() => sequelize.query("ALTER TABLE Configs ADD COLUMN gridTimeframe VARCHAR(255) DEFAULT '5m';"));
        if (columnNames.has("breakoutTimeframe")) {
            await withSqliteBusyRetry(() => sequelize.query("UPDATE Configs SET gridTimeframe = COALESCE(breakoutTimeframe, '5m') WHERE gridTimeframe IS NULL OR gridTimeframe = '';"));
        }
        console.log("[INFO] Added config column: gridTimeframe");
    }
    if (!columnNames.has("activeGridState")) {
        await withSqliteBusyRetry(() => sequelize.query("ALTER TABLE Configs ADD COLUMN activeGridState TEXT DEFAULT NULL;"));
        console.log("[INFO] Added config column: activeGridState");
    }
    if (!columnNames.has("dailyProfitTargetUsdt")) {
        await withSqliteBusyRetry(() => sequelize.query("ALTER TABLE Configs ADD COLUMN dailyProfitTargetUsdt FLOAT DEFAULT 1;"));
        if (columnNames.has("targetDailyProfit")) {
            await withSqliteBusyRetry(() => sequelize.query("UPDATE Configs SET dailyProfitTargetUsdt = COALESCE(targetDailyProfit, 1) WHERE dailyProfitTargetUsdt IS NULL OR dailyProfitTargetUsdt = '';"));
        }
        console.log("[INFO] Added config column: dailyProfitTargetUsdt");
    }
    if (!columnNames.has("dailyMaxLossPercent")) {
        await withSqliteBusyRetry(() => sequelize.query("ALTER TABLE Configs ADD COLUMN dailyMaxLossPercent FLOAT DEFAULT 10;"));
        if (columnNames.has("maxDailyLossPercent")) {
            await withSqliteBusyRetry(() => sequelize.query("UPDATE Configs SET dailyMaxLossPercent = COALESCE(maxDailyLossPercent, 10) WHERE dailyMaxLossPercent IS NULL OR dailyMaxLossPercent = '';"));
        }
        console.log("[INFO] Added config column: dailyMaxLossPercent");
    }
    if (!columnNames.has("strategy")) {
        await withSqliteBusyRetry(() => sequelize.query("ALTER TABLE Configs ADD COLUMN strategy VARCHAR(255) DEFAULT 'futures_grid';"));
        console.log("[INFO] Added config column: strategy");
    }
    if (!columnNames.has("sessionStartUTC")) {
        await withSqliteBusyRetry(() => sequelize.query("ALTER TABLE Configs ADD COLUMN sessionStartUTC INTEGER DEFAULT 0;"));
        console.log("[INFO] Added config column: sessionStartUTC");
    }
    if (!columnNames.has("sessionEndUTC")) {
        await withSqliteBusyRetry(() => sequelize.query("ALTER TABLE Configs ADD COLUMN sessionEndUTC INTEGER DEFAULT 23;"));
        console.log("[INFO] Added config column: sessionEndUTC");
    }
    if (!columnNames.has("volumePeriod")) {
        await withSqliteBusyRetry(() => sequelize.query("ALTER TABLE Configs ADD COLUMN volumePeriod INTEGER DEFAULT 20;"));
        console.log("[INFO] Added config column: volumePeriod");
    }
    if (!columnNames.has("minVolumeRatio")) {
        await withSqliteBusyRetry(() => sequelize.query("ALTER TABLE Configs ADD COLUMN minVolumeRatio FLOAT DEFAULT 1.3;"));
        console.log("[INFO] Added config column: minVolumeRatio");
    }
    if (!columnNames.has("atrPeriod")) {
        await withSqliteBusyRetry(() => sequelize.query("ALTER TABLE Configs ADD COLUMN atrPeriod INTEGER DEFAULT 14;"));
        console.log("[INFO] Added config column: atrPeriod");
    }
    if (!columnNames.has("trailingEnabled")) {
        await withSqliteBusyRetry(() => sequelize.query("ALTER TABLE Configs ADD COLUMN trailingEnabled BOOLEAN DEFAULT 1;"));
        console.log("[INFO] Added config column: trailingEnabled");
    }
    if (!columnNames.has("trailingActivateATR")) {
        await withSqliteBusyRetry(() => sequelize.query("ALTER TABLE Configs ADD COLUMN trailingActivateATR FLOAT DEFAULT 1.2;"));
        console.log("[INFO] Added config column: trailingActivateATR");
    }
    if (!columnNames.has("trailingOffsetATR")) {
        await withSqliteBusyRetry(() => sequelize.query("ALTER TABLE Configs ADD COLUMN trailingOffsetATR FLOAT DEFAULT 0.6;"));
        console.log("[INFO] Added config column: trailingOffsetATR");
    }
    if (!columnNames.has("allowLong")) {
        await withSqliteBusyRetry(() => sequelize.query("ALTER TABLE Configs ADD COLUMN allowLong BOOLEAN DEFAULT 1;"));
        console.log("[INFO] Added config column: allowLong");
    }
    if (!columnNames.has("allowShort")) {
        await withSqliteBusyRetry(() => sequelize.query("ALTER TABLE Configs ADD COLUMN allowShort BOOLEAN DEFAULT 1;"));
        console.log("[INFO] Added config column: allowShort");
    }

    for (const obsoleteColumn of OBSOLETE_CONFIG_COLUMNS) {
        if (!columnNames.has(obsoleteColumn)) continue;
        try {
            await withSqliteBusyRetry(() => sequelize.query(`ALTER TABLE Configs DROP COLUMN ${obsoleteColumn};`));
            console.log(`[INFO] Dropped obsolete config column: ${obsoleteColumn}`);
        } catch (error) {
            console.warn(`[WARN] Could not drop obsolete config column ${obsoleteColumn}: ${error.message}`);
        }
    }
};


const normalizeSymbol = (symbol) => String(symbol || "").toUpperCase().trim();
const isHedgeModeEnabled = () => accountPositionMode.hedged === true;

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

const getSignalParameters = () => {
    const volumePeriod = Math.max(2, Math.trunc(toFiniteNumber(db.volumePeriod, DEFAULT_CONFIG.volumePeriod)));
    const atrPeriod = Math.max(2, Math.trunc(toFiniteNumber(db.atrPeriod, DEFAULT_CONFIG.atrPeriod)));
    const gridLookbackCandles = Math.max(20, Math.trunc(toFiniteNumber(db.gridLookbackCandles, DEFAULT_CONFIG.gridLookbackCandles)));
    const gridLevels = Math.max(4, Math.trunc(toFiniteNumber(db.gridLevels, DEFAULT_CONFIG.gridLevels)));
    const gridTakeProfitLevels = Math.max(0, Math.trunc(toFiniteNumber(db.gridTakeProfitLevels, DEFAULT_CONFIG.gridTakeProfitLevels)));
    const neededCandles = Math.max(gridLookbackCandles + 5, volumePeriod + 10, atrPeriod + 10, 150);
    return {
        strategy: "futures_grid",
        volumePeriod,
        atrPeriod,
        neededCandles,
        gridLookbackCandles,
        gridLevels,
        gridTakeProfitLevels,
        gridOrdersPerSide: Math.max(0, Math.trunc(toFiniteNumber(db.gridOrdersPerSide, DEFAULT_CONFIG.gridOrdersPerSide))),
        gridOrderSizeUsdt: Math.max(0, toFiniteNumber(db.gridOrderSizeUsdt, DEFAULT_CONFIG.gridOrderSizeUsdt)),
        gridRangePercent: Math.max(0.5, toFiniteNumber(db.gridRangePercent, DEFAULT_CONFIG.gridRangePercent)),
        gridEntryBufferPercent: Math.max(0.02, toFiniteNumber(db.gridEntryBufferPercent, DEFAULT_CONFIG.gridEntryBufferPercent)),
        gridStopLossLevels: Math.max(0, toFiniteNumber(db.gridStopLossLevels, DEFAULT_CONFIG.gridStopLossLevels))
    };
};

const resolveEffectiveGridTakeProfitLevels = (configuredTakeProfitLevels) => {
    const configured = Math.trunc(toFiniteNumber(configuredTakeProfitLevels, 0));
    return configured <= 0 ? 1 : Math.max(1, configured);
};

const resolveEffectiveGridStopLossSteps = (configuredStopLossLevels, step, atr = null) => {
    const configured = toFiniteNumber(configuredStopLossLevels, 0);
    if (configured > 0) return Math.max(0.5, configured);
    const atrSteps = Number.isFinite(atr) && Number.isFinite(step) && step > 0 ? atr / step : 1.2;
    return clamp(Math.max(1.2, atrSteps), 1.2, 3.0);
};

const findNearestGridLevelIndex = (levels, entryPrice) => {
    if (!Array.isArray(levels) || levels.length === 0 || !Number.isFinite(entryPrice)) return 0;
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < levels.length; i++) {
        const distance = Math.abs(toFiniteNumber(levels[i], NaN) - entryPrice);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = i;
        }
    }
    return bestIndex;
};

const buildGridExitPlan = ({
    side,
    entryIndex,
    levels,
    step,
    params,
    gridState = null,
    atr = null
} = {}) => {
    const normalizedSide = String(side || "").toLowerCase();
    const safeLevels = Array.isArray(levels) ? levels : [];
    const safeStep = toFiniteNumber(step, NaN);
    if ((normalizedSide !== "buy" && normalizedSide !== "sell") || safeLevels.length < 2 || !Number.isFinite(safeStep) || safeStep <= 0) {
        return { targetPrice: NaN, stopLossPrice: NaN, takeProfitLevels: 0, stopLossSteps: 0, mode: "INVALID" };
    }

    const takeProfitLevels = resolveEffectiveGridTakeProfitLevels(params?.gridTakeProfitLevels);
    const stopLossSteps = resolveEffectiveGridStopLossSteps(params?.gridStopLossLevels, safeStep, atr);
    const safeEntryIndex = clamp(Math.trunc(toFiniteNumber(entryIndex, 0)), 0, safeLevels.length - 1);
    const lowerBound = toFiniteNumber(gridState?.lowerBound, safeLevels[0]);
    const upperBound = toFiniteNumber(gridState?.upperBound, safeLevels[safeLevels.length - 1]);
    const autoStopMode = !(toFiniteNumber(params?.gridStopLossLevels, 0) > 0);

    if (normalizedSide === "buy") {
        const targetIndex = clamp(safeEntryIndex + takeProfitLevels, 1, safeLevels.length - 1);
        const rawStop = autoStopMode
            ? lowerBound - (safeStep * stopLossSteps)
            : toFiniteNumber(safeLevels[safeEntryIndex], lowerBound) - (safeStep * stopLossSteps);
        return {
            targetPrice: formatPriceToMarketPrecision(db.pair, safeLevels[targetIndex]),
            stopLossPrice: formatPriceToMarketPrecision(db.pair, rawStop),
            takeProfitLevels,
            stopLossSteps,
            mode: autoStopMode ? "AUTO_RANGE_SL" : "FIXED_STEP_SL"
        };
    }

    const targetIndex = clamp(safeEntryIndex - takeProfitLevels, 0, Math.max(0, safeLevels.length - 2));
    const rawStop = autoStopMode
        ? upperBound + (safeStep * stopLossSteps)
        : toFiniteNumber(safeLevels[safeEntryIndex], upperBound) + (safeStep * stopLossSteps);
    return {
        targetPrice: formatPriceToMarketPrecision(db.pair, safeLevels[targetIndex]),
        stopLossPrice: formatPriceToMarketPrecision(db.pair, rawStop),
        takeProfitLevels,
        stopLossSteps,
        mode: autoStopMode ? "AUTO_RANGE_SL" : "FIXED_STEP_SL"
    };
};

const buildGridLevels = (lowerBound, upperBound, gridLevels) => {
    const safeLevels = Math.max(2, Math.trunc(gridLevels));
    const step = (upperBound - lowerBound) / safeLevels;
    const levels = [];
    for (let i = 0; i <= safeLevels; i++) levels.push(lowerBound + (step * i));
    return { levels, step };
};

const resolveGridOrdersPerSideCap = (configuredOrdersPerSide, gridLevels = db?.gridLevels) => {
    const safeGridLevels = Math.max(2, Math.trunc(toFiniteNumber(gridLevels, 2)));
    const configured = Math.trunc(toFiniteNumber(configuredOrdersPerSide, 0));
    return configured <= 0 ? Math.max(1, safeGridLevels - 1) : Math.max(1, configured);
};

const getMinimumGridOrderSizeUsdt = (market, referencePrice) => {
    const safeReferencePrice = toFiniteNumber(referencePrice, NaN);
    if (!Number.isFinite(safeReferencePrice) || safeReferencePrice <= 0) return 0;
    const leverage = Math.max(1, toFiniteNumber(db.leverage, 1));
    const minAmount = toFiniteNumber(market?.limits?.amount?.min, 0);
    const minCost = toFiniteNumber(market?.limits?.cost?.min, 0);
    const amountFloorUsdt = Number.isFinite(minAmount) && minAmount > 0
        ? (minAmount * safeReferencePrice) / leverage
        : 0;
    const costFloorUsdt = Number.isFinite(minCost) && minCost > 0
        ? minCost / leverage
        : 0;
    return Math.max(costFloorUsdt, amountFloorUsdt, 0);
};

const getMinimumValidatedGridOrderSizeUsdt = (market, referencePrice) => {
    const safeReferencePrice = toFiniteNumber(referencePrice, NaN);
    const baseMinimum = getMinimumGridOrderSizeUsdt(market, safeReferencePrice);
    if (!Number.isFinite(baseMinimum) || baseMinimum <= 0 || !market || !Number.isFinite(safeReferencePrice) || safeReferencePrice <= 0) {
        return Math.max(0, baseMinimum);
    }

    const leverage = Math.max(1, toFiniteNumber(db.leverage, 1));
    let candidate = baseMinimum;
    const increment = Math.max(baseMinimum * 0.01, 0.01);

    for (let attempt = 0; attempt < 25; attempt++) {
        const rawQty = (candidate * leverage) / safeReferencePrice;
        const quantity = formatAmountToMarketPrecision(db.pair, rawQty);
        const sizeValidation = validateOrderSize(market, quantity, safeReferencePrice);
        if (sizeValidation.valid) return candidate;
        candidate += increment;
    }

    return candidate;
};

const resolveEffectiveGridOrderSizeUsdt = ({
    availableUsdt,
    configuredOrderSizeUsdt,
    configuredOrdersPerSide,
    referencePrice,
    market,
    gridLevels
} = {}) => {
    const maxConfiguredOrders = resolveGridOrdersPerSideCap(configuredOrdersPerSide, gridLevels);
    const safeAvailableUsdt = toFiniteNumber(availableUsdt, 0);
    const capitalBufferRatio = 0.9;
    const usableUsdt = safeAvailableUsdt * capitalBufferRatio;
    const minOrderSizeUsdt = getMinimumValidatedGridOrderSizeUsdt(market, referencePrice);
    const configuredSize = toFiniteNumber(configuredOrderSizeUsdt, 0);
    const isFullAutoSize = configuredSize <= 0;
    const derivedAutoSize = maxConfiguredOrders > 0 ? usableUsdt / Math.max(maxConfiguredOrders * 2, 1) : 0;
    const orderSizeUsdt = isFullAutoSize
        ? Math.max(derivedAutoSize, minOrderSizeUsdt)
        : configuredSize;
    return {
        orderSizeUsdt: Math.max(0, orderSizeUsdt),
        minOrderSizeUsdt,
        mode: isFullAutoSize ? "FULL_AUTO" : "CAPPED",
        maxConfiguredOrders
    };
};

const resolveGridOrderSizeForPrice = (baseOrderSizeUsdt, price, market) => {
    const configuredBaseSize = Math.max(0, toFiniteNumber(baseOrderSizeUsdt, 0));
    const minimumValidatedSize = getMinimumValidatedGridOrderSizeUsdt(market, price);
    return Math.max(configuredBaseSize, minimumValidatedSize);
};

const resolveEffectiveGridOrdersPerSide = ({
    availableUsdt,
    configuredOrdersPerSide,
    perOrderMargin,
    referencePrice,
    market,
    gridLevels
} = {}) => {
    const maxConfigured = resolveGridOrdersPerSideCap(configuredOrdersPerSide, gridLevels);
    const safeAvailableUsdt = toFiniteNumber(availableUsdt, 0);
    const safePerOrderMargin = Math.max(0, toFiniteNumber(perOrderMargin, db.gridOrderSizeUsdt));
    const safeReferencePrice = toFiniteNumber(referencePrice, NaN);
    if (maxConfigured <= 0 || safePerOrderMargin <= 0 || safeAvailableUsdt <= 0 || !Number.isFinite(safeReferencePrice) || safeReferencePrice <= 0) {
        return { count: 0, maxConfigured, mode: configuredOrdersPerSide <= 0 ? "FULL_AUTO" : "CAPPED", reason: "INVALID_INPUT" };
    }

    const rawQty = (safePerOrderMargin * Math.max(1, toFiniteNumber(db.leverage, 1))) / safeReferencePrice;
    const quantity = formatAmountToMarketPrecision(db.pair, rawQty);
    const sizeValidation = validateOrderSize(market, quantity, safeReferencePrice);
    if (!sizeValidation.valid) {
        return { count: 0, maxConfigured, mode: configuredOrdersPerSide <= 0 ? "FULL_AUTO" : "CAPPED", reason: sizeValidation.reason };
    }

    const capitalBufferRatio = 0.9;
    const usableUsdt = safeAvailableUsdt * capitalBufferRatio;
    const affordablePerSide = Math.floor(usableUsdt / Math.max(safePerOrderMargin * 2, 1e-8));
    return {
        count: clamp(affordablePerSide, 0, maxConfigured),
        maxConfigured,
        mode: configuredOrdersPerSide <= 0 ? "FULL_AUTO" : "CAPPED",
        reason: null
    };
};

const getGridStateFingerprint = (params) => ([
    normalizeSymbol(db?.pair),
    params?.gridTimeframe || db?.gridTimeframe || "",
    params?.gridLevels,
    params?.gridLookbackCandles,
    params?.gridRangePercent,
    params?.gridTakeProfitLevels,
    params?.gridStopLossLevels
].join("|"));

const sanitizeGridState = (state, params) => {
    if (!state || typeof state !== "object") return null;
    const lowerBound = toFiniteNumber(state.lowerBound, NaN);
    const upperBound = toFiniteNumber(state.upperBound, NaN);
    const step = toFiniteNumber(state.step, NaN);
    const levels = Array.isArray(state.levels) ? state.levels.map((level) => toFiniteNumber(level, NaN)) : [];
    const expectedLevels = Math.max(2, Math.trunc(toFiniteNumber(params?.gridLevels, NaN)));
    if (!Number.isFinite(lowerBound) || !Number.isFinite(upperBound) || !Number.isFinite(step)) return null;
    if (!(upperBound > lowerBound) || step <= 0) return null;
    if (levels.length !== expectedLevels + 1 || levels.some((level) => !Number.isFinite(level))) return null;
    if (String(state.fingerprint || "") !== getGridStateFingerprint(params)) return null;
    return {
        lowerBound,
        upperBound,
        step,
        levels,
        referencePrice: toFiniteNumber(state.referencePrice, (lowerBound + upperBound) / 2),
        createdAt: toFiniteNumber(state.createdAt, Date.now()),
        fingerprint: state.fingerprint
    };
};

const createLockedGridState = (snapshot, params) => {
    const recentHigh = Math.max(...snapshot.high.slice(-(params.gridLookbackCandles)));
    const recentLow = Math.min(...snapshot.low.slice(-(params.gridLookbackCandles)));
    const referencePrice = (recentHigh + recentLow) / 2;
    const lowerBound = Math.min(referencePrice * (1 - (params.gridRangePercent / 100)), recentLow);
    const upperBound = Math.max(referencePrice * (1 + (params.gridRangePercent / 100)), recentHigh);
    const { levels, step } = buildGridLevels(lowerBound, upperBound, params.gridLevels);
    if (!Number.isFinite(step) || step <= 0) return null;
    return {
        fingerprint: getGridStateFingerprint(params),
        referencePrice,
        lowerBound,
        upperBound,
        step,
        levels,
        createdAt: Date.now()
    };
};

const hasGridStateChanged = (currentState, nextState) => {
    if (!currentState || !nextState) return true;
    return currentState.fingerprint !== nextState.fingerprint ||
        currentState.lowerBound !== nextState.lowerBound ||
        currentState.upperBound !== nextState.upperBound ||
        currentState.step !== nextState.step;
};

const resolveActiveGridState = async (snapshot, params) => {
    const persistedState = sanitizeGridState(db?.activeGridState, params);
    const price = toFiniteNumber(snapshot?.currentPrice, NaN);
    const priceInsideLockedRange = persistedState
        ? Number.isFinite(price) && price >= persistedState.lowerBound && price <= persistedState.upperBound
        : false;
    if (persistedState && priceInsideLockedRange) return persistedState;

    const nextState = createLockedGridState(snapshot, params);
    if (!nextState) return null;

    const rebuildReason = !persistedState
        ? "INIT"
        : (!priceInsideLockedRange ? "PRICE_OUT_OF_RANGE" : "PARAM_CHANGE");
    console.log(`[GRID] ${rebuildReason}: locking range ${nextState.lowerBound.toFixed(6)} - ${nextState.upperBound.toFixed(6)} | step ${nextState.step.toFixed(6)}`);

    if (hasGridStateChanged(persistedState, nextState)) {
        db.activeGridState = nextState;
        await saveDB();
    }
    return nextState;
};

const getGridClientOrderId = (side, levelIndex, price) => {
    const safePrice = String(formatPriceToMarketPrecision(db?.pair, price) ?? price).replace(/[^\d]/g, "");
    return `${GRID_CLIENT_ORDER_PREFIX}_${side}_${levelIndex}_${safePrice}`.slice(0, 36);
};

const getTpClientOrderId = (position) => {
    const positionSide = getClosePositionSide(position);
    const side = position?.side === "buy" ? "sell" : "buy";
    const safeTarget = String(formatPriceToMarketPrecision(db?.pair, position?.targetPrice) ?? position?.targetPrice ?? "").replace(/[^\d]/g, "");
    return `${TP_CLIENT_ORDER_PREFIX}_${positionSide}_${side}_${safeTarget}`.slice(0, 36);
};

const getSlClientOrderId = (position) => {
    const positionSide = getClosePositionSide(position);
    const side = position?.side === "buy" ? "sell" : "buy";
    const safeStop = String(formatPriceToMarketPrecision(db?.pair, position?.stopLossPrice) ?? position?.stopLossPrice ?? "").replace(/[^\d]/g, "");
    return `${SL_CLIENT_ORDER_PREFIX}_${positionSide}_${side}_${safeStop}`.slice(0, 36);
};

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

const buildGridEntryOrders = (snapshot, params, gridState = null) => {
    const resolvedGridState = sanitizeGridState(gridState, params) || createLockedGridState(snapshot, params);
    const levels = resolvedGridState?.levels || [];
    const step = toFiniteNumber(resolvedGridState?.step, NaN);
    if (!Number.isFinite(step) || step <= 0) return [];
    const market = exchange?.markets?.[db?.pair];

    const minBuyPrice = snapshot.currentPrice * (1 - (params.gridEntryBufferPercent / 100));
    const maxSellPrice = snapshot.currentPrice * (1 + (params.gridEntryBufferPercent / 100));
    const buyOrders = [];
    const sellOrders = [];

    for (let i = levels.length - 2; i >= 0; i--) {
        const price = formatPriceToMarketPrecision(db.pair, levels[i]);
        const exitPlan = buildGridExitPlan({
            side: "buy",
            entryIndex: i,
            levels,
            step,
            params,
            gridState: resolvedGridState,
            atr: snapshot?.currentATR
        });
        const targetPrice = exitPlan.targetPrice;
        const stopLossPrice = exitPlan.stopLossPrice;
        const orderSizeUsdt = resolveGridOrderSizeForPrice(params.gridOrderSizeUsdt, price, market);
        const orderPlan = { targetPrice, stopLossPrice };
        if (Number.isFinite(price) && price > 0 && price < minBuyPrice) {
            if (!isDirectionalOrderPlanValid("buy", price, orderPlan)) {
                console.warn(`[GRID] Skipping BUY level ${i} @ ${price} because TP/SL would be invalid after precision rounding.`);
                continue;
            }
            buyOrders.push({
                side: "buy",
                price,
                orderSizeUsdt,
                targetPrice,
                stopLossPrice,
                levelIndex: i,
                clientOrderId: getGridClientOrderId("buy", i, price)
            });
        }
    }

    for (let i = 1; i < levels.length; i++) {
        const price = formatPriceToMarketPrecision(db.pair, levels[i]);
        const exitPlan = buildGridExitPlan({
            side: "sell",
            entryIndex: i,
            levels,
            step,
            params,
            gridState: resolvedGridState,
            atr: snapshot?.currentATR
        });
        const targetPrice = exitPlan.targetPrice;
        const stopLossPrice = exitPlan.stopLossPrice;
        const orderSizeUsdt = resolveGridOrderSizeForPrice(params.gridOrderSizeUsdt, price, market);
        const orderPlan = { targetPrice, stopLossPrice };
        if (Number.isFinite(price) && price > 0 && price > maxSellPrice) {
            if (!isDirectionalOrderPlanValid("sell", price, orderPlan)) {
                console.warn(`[GRID] Skipping SELL level ${i} @ ${price} because TP/SL would be invalid after precision rounding.`);
                continue;
            }
            sellOrders.push({
                side: "sell",
                price,
                orderSizeUsdt,
                targetPrice,
                stopLossPrice,
                levelIndex: i,
                clientOrderId: getGridClientOrderId("sell", i, price)
            });
        }
    }

    const dedupeBySideAndPrice = (orders) => {
        const seen = new Set();
        const deduped = [];
        const duplicates = [];
        for (const order of orders) {
            const key = `${order.side}:${order.price}`;
            if (seen.has(key)) duplicates.push(order);
            else {
                seen.add(key);
                deduped.push(order);
            }
        }
        return { deduped, duplicates };
    };

    const effectiveOrdersPerSide = Math.max(0, Math.trunc(toFiniteNumber(params.gridOrdersPerSide, 0)));
    const selectedOrders = [
        ...buyOrders.slice(0, effectiveOrdersPerSide),
        ...sellOrders.slice(0, effectiveOrdersPerSide)
    ];
    const { deduped, duplicates } = dedupeBySideAndPrice(selectedOrders);
    if (duplicates.length > 0) {
        console.warn(`[GRID] Deduped ${duplicates.length} grid order(s) that collapsed to the same rounded price.`);
    }
    return deduped;
};

const getActiveGridExposureSides = (openPositions = [], trackedPositions = getActivePositionsList()) => {
    const exposureSides = new Set();

    for (const position of openPositions || []) {
        const side = String(getExchangePositionSide(position) || "").toLowerCase();
        if (side === "buy" || side === "sell") exposureSides.add(side);
    }

    for (const position of trackedPositions || []) {
        const side = String(position?.side || "").toLowerCase();
        if (side === "buy" || side === "sell") exposureSides.add(side);
    }

    return exposureSides;
};

const filterGridOrdersForActiveExposure = (orders, openPositions = [], trackedPositions = getActivePositionsList()) => {
    if (!Array.isArray(orders) || orders.length === 0) return [];
    const exposureSides = getActiveGridExposureSides(openPositions, trackedPositions);
    if (exposureSides.size === 0 || isHedgeModeEnabled()) return orders;

    // In one-way mode we keep re-entry orders aligned with the live position side
    // so the ladder can stay active without creating unintended reversal orders.
    return orders.filter((order) => exposureSides.has(String(order?.side || "").toLowerCase()));
};

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

    console.log(`\n[STATUS] Mode=${accountPositionMode.label} | Pair=${db.pair} | Price=${Number.isFinite(currentPrice) ? currentPrice : "N/A"} | LocalActive=${activeEntries.length} | ExchangePos=${openExchangePositions.length}`);
    printStatusLine("Profile", `${gridSummary.presetName.toUpperCase()} | Grid Slot=${gridSummary.slotLabel} | Ladder=${gridSummary.ladderLabel}`);
    printStatusLine("Side Orders", `${gridSummary.ordersMode}=${gridSummary.effectiveOrdersPerSide}/${gridSummary.configuredOrdersPerSideCap} | Size ${gridSummary.sizeMode}=${gridSummary.effectiveOrderSizeUsdt.toFixed(4)} USDT | Min Valid=${gridSummary.minOrderSizeUsdt.toFixed(4)} USDT | Available USDT=${gridSummary.availableUsdtLabel}`);
    printStatusLine("Daily P&L", `${db.dailyPnL.toFixed(2)} USDT | Trades=${db.dailyTrades}`);
    printStatusLine("Runtime", `placing=${isPlacingOrder ? "Y" : "N"} closing=${isClosingPosition ? "Y" : "N"} posSync=${isSyncingPosition ? "Y" : "N"} gridSync=${isSyncingGridOrders ? "Y" : "N"}`);
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

    if (isPlacingOrder || isClosingPosition) return;
    await resetDailyStateIfNeeded(Date.now());

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

const buildDashboardStatus = () => {
    const activePositionsMap = getActivePositionsMap(db?.activePosition);
    return {
        botRunning: !isShuttingDown,
        exchangeConnected: Boolean(exchange),
        positionMode: accountPositionMode?.label || "UNKNOWN",
        activePositions: Object.keys(activePositionsMap).length,
        activeGridState: Boolean(db?.activeGridState),
        dailyPnL: toFiniteNumber(db?.dailyPnL, 0),
        dailyTrades: Math.max(0, Math.trunc(toFiniteNumber(db?.dailyTrades, 0))),
        lastUpdated: toFiniteNumber(db?.lastUpdated, 0),
        lastDailyReset: toFiniteNumber(db?.lastDailyReset, 0),
        pair: db?.pair || DEFAULT_CONFIG.pair,
        strategy: db?.strategy || DEFAULT_CONFIG.strategy,
        marginMode: db?.marginMode || DEFAULT_CONFIG.marginMode,
        leverage: Math.max(1, Math.trunc(toFiniteNumber(db?.leverage, DEFAULT_CONFIG.leverage)))
    };
};

const buildLiveStatusPayload = async () => {
    if (!db) {
        return {
            ok: false,
            error: "Config is not ready yet"
        };
    }

    let currentPrice = NaN;
    let exchangePositions = [];
    let managedOrders = { grid: [], tp: [], sl: [] };

    try {
        currentPrice = await getPrice();
    } catch {
        currentPrice = NaN;
    }

    try {
        exchangePositions = await fetchOpenExchangePositions();
    } catch (error) {
        console.warn(`[STATUS] Failed to fetch exchange positions: ${error.message}`);
    }

    try {
        managedOrders = await fetchManagedOpenOrdersSnapshot();
    } catch (error) {
        console.warn(`[STATUS] Failed to fetch managed open orders: ${error.message}`);
    }

    const activePositions = getActivePositionEntries().map(([positionKey, position]) => {
        const pnlState = Number.isFinite(currentPrice) ? calculatePositionPnL(position, currentPrice) : null;
        return {
            key: positionKey,
            side: position.side || null,
            quantity: toFiniteNumber(position.quantity, 0),
            entryPrice: toFiniteNumber(position.entryPrice, 0),
            targetPrice: Number.isFinite(position.targetPrice) ? position.targetPrice : null,
            stopLossPrice: Number.isFinite(position.stopLossPrice) ? position.stopLossPrice : null,
            pnlUSDT: pnlState ? toFiniteNumber(pnlState.netProfitUSDT, 0) : null,
            pnlPercent: pnlState ? toFiniteNumber(pnlState.displayProfitPercent ?? pnlState.profitPercent, 0) : null,
            currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
            strategy: position.strategy || null
        };
    });

    const openOrders = {
        grid: managedOrders.grid.map((order) => ({
            id: order.id ?? null,
            clientOrderId: order.clientOrderId ?? null,
            side: order.side ?? null,
            positionSide: order.positionSide ?? null,
            type: order.type ?? null,
            reduceOnly: Boolean(order.reduceOnly),
            price: Number.isFinite(Number(order.price)) ? Number(order.price) : null,
            triggerPrice: Number.isFinite(Number(order.triggerPrice)) ? Number(order.triggerPrice) : null,
            amount: Number.isFinite(Number(order.amount)) ? Number(order.amount) : null
        })),
        tp: managedOrders.tp.map((order) => ({
            id: order.id ?? null,
            clientOrderId: order.clientOrderId ?? null,
            side: order.side ?? null,
            positionSide: order.positionSide ?? null,
            type: order.type ?? null,
            reduceOnly: Boolean(order.reduceOnly),
            price: Number.isFinite(Number(order.price)) ? Number(order.price) : null,
            triggerPrice: Number.isFinite(Number(order.triggerPrice)) ? Number(order.triggerPrice) : null,
            amount: Number.isFinite(Number(order.amount)) ? Number(order.amount) : null
        })),
        sl: managedOrders.sl.map((order) => ({
            id: order.id ?? null,
            clientOrderId: order.clientOrderId ?? null,
            side: order.side ?? null,
            positionSide: order.positionSide ?? null,
            type: order.type ?? null,
            reduceOnly: Boolean(order.reduceOnly),
            price: Number.isFinite(Number(order.price)) ? Number(order.price) : null,
            triggerPrice: Number.isFinite(Number(order.triggerPrice)) ? Number(order.triggerPrice) : null,
            amount: Number.isFinite(Number(order.amount)) ? Number(order.amount) : null
        }))
    };

    return {
        ok: true,
        serverTime: Date.now(),
        pair: db.pair,
        currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
        botRunning: !isShuttingDown,
        positionMode: accountPositionMode?.label || "UNKNOWN",
        dailyPnL: toFiniteNumber(db.dailyPnL, 0),
        dailyTrades: Math.max(0, Math.trunc(toFiniteNumber(db.dailyTrades, 0))),
        activePositions,
        exchangePositionsCount: exchangePositions.length,
        openOrders,
        orderCounts: {
            grid: openOrders.grid.length,
            tp: openOrders.tp.length,
            sl: openOrders.sl.length,
            total: openOrders.grid.length + openOrders.tp.length + openOrders.sl.length
        }
    };
};

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

const buildDashboardConfigSignature = (config) => JSON.stringify(
    DASHBOARD_EDITABLE_FIELDS.map((field) => [field.key, config && Object.prototype.hasOwnProperty.call(config, field.key) ? config[field.key] : null])
);

const syncDashboardConfigSignature = (config = db) => {
    lastKnownDashboardConfigSignature = buildDashboardConfigSignature(config || {});
    return lastKnownDashboardConfigSignature;
};

const reloadConfigIfChanged = async () => {
    if (!db || isShuttingDown) return false;
    try {
        const persistedConfig = await loadPersistedConfig();
        if (!persistedConfig) return false;
        const persistedSignature = buildDashboardConfigSignature(persistedConfig);
        if (persistedSignature === lastKnownDashboardConfigSignature) return false;
        console.log("[CONFIG] Detected dashboard config change. Reloading...");
        const reloaded = await reloadConfig();
        if (reloaded) syncDashboardConfigSignature();
        return reloaded;
    } catch (error) {
        console.error("[ERROR] Auto config reload failed:", error.message);
        return false;
    }
};

const startConfigAutoReload = () => {
    if (configReloadTimer) return;
    configReloadTimer = setInterval(async () => {
        if (isShuttingDown || isProcessing || isPlacingOrder || isClosingPosition) return;
        await reloadConfigIfChanged();
    }, CONFIG_AUTO_RELOAD_INTERVAL_MS);
};

const requireDashboardAuth = (req, res, next) => {
    if (isDashboardAuthenticated(req)) return next();
    if (req.path.startsWith("/api")) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
    }
    res.redirect("/login");
};

const buildDashboardPayload = () => ({
    config: db ? { ...db } : getDefaultConfig(),
    defaults: getDefaultConfig(),
    schema: DASHBOARD_EDITABLE_FIELDS,
    status: buildDashboardStatus(),
    serverTime: Date.now()
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

const resolveAutoPairPresetName = (pair) => {
    const normalizedPair = String(pair || "").trim().toUpperCase();
    if (!normalizedPair) return "binance";
    if (normalizedPair.includes("DOGE")) return "doge";
    if (/(PEPE|BONK|FLOKI|SHIB|MEME|1000)/i.test(normalizedPair)) return "volatile";
    return "binance";
};

const getActiveAutoPairPresetName = () => resolveAutoPairPresetName(db?.pair);

const getGridRuntimeSummary = (currentPrice = NaN, managedOrders = null) => {
    const presetName = getActiveAutoPairPresetName();
    const gridState = db?.activeGridState;
    const lowerBound = toFiniteNumber(gridState?.lowerBound, NaN);
    const upperBound = toFiniteNumber(gridState?.upperBound, NaN);
    const step = toFiniteNumber(gridState?.step, NaN);
    const levels = Array.isArray(gridState?.levels) ? gridState.levels : [];
    const hasLockedGrid = Number.isFinite(lowerBound) && Number.isFinite(upperBound) && upperBound > lowerBound && Number.isFinite(step) && step > 0;
    const insideRange = hasLockedGrid && Number.isFinite(currentPrice) ? currentPrice >= lowerBound && currentPrice <= upperBound : false;

    let slotLabel = "N/A";
    if (hasLockedGrid && Number.isFinite(currentPrice)) {
        const rawIndex = (currentPrice - lowerBound) / step;
        const clampedIndex = clamp(rawIndex, 0, Math.max(0, levels.length - 1));
        const lowerIndex = clamp(Math.floor(clampedIndex), 0, Math.max(0, levels.length - 2));
        const upperIndex = clamp(lowerIndex + 1, 1, Math.max(1, levels.length - 1));
        slotLabel = `${lowerIndex}/${Math.max(1, db.gridLevels)}${insideRange ? "" : " OUT"}`;
        if (Number.isFinite(levels[lowerIndex]) && Number.isFinite(levels[upperIndex])) {
            slotLabel += ` (${levels[lowerIndex].toFixed(6)} - ${levels[upperIndex].toFixed(6)})`;
        }
    }

    const gridOrders = Array.isArray(managedOrders?.grid) ? managedOrders.grid : [];
    const buyOrders = gridOrders.filter((order) => String(order?.side || "").toLowerCase() === "buy").length;
    const sellOrders = gridOrders.filter((order) => String(order?.side || "").toLowerCase() === "sell").length;
    const availableUsdt = Number.isFinite(balanceCache.availableUSDT) ? balanceCache.availableUSDT : balanceCache.totalUSDT;
    const referencePrice = Number.isFinite(currentPrice) && currentPrice > 0
        ? currentPrice
        : (hasLockedGrid ? (lowerBound + upperBound) / 2 : tickerCache.price);
    const effectiveSizeMeta = resolveEffectiveGridOrderSizeUsdt({
        availableUsdt,
        configuredOrderSizeUsdt: db.gridOrderSizeUsdt,
        configuredOrdersPerSide: db.gridOrdersPerSide,
        referencePrice,
        market: exchange?.markets?.[db?.pair],
        gridLevels: db?.gridLevels
    });
    const effectiveOrdersMeta = resolveEffectiveGridOrdersPerSide({
        availableUsdt,
        configuredOrdersPerSide: db.gridOrdersPerSide,
        perOrderMargin: effectiveSizeMeta.orderSizeUsdt,
        referencePrice,
        market: exchange?.markets?.[db?.pair],
        gridLevels: db?.gridLevels
    });

    return {
        presetName,
        hasLockedGrid,
        lockedRangeLabel: hasLockedGrid ? `${lowerBound.toFixed(6)} - ${upperBound.toFixed(6)}` : "N/A",
        stepLabel: hasLockedGrid ? step.toFixed(6) : "N/A",
        slotLabel,
        ladderLabel: `${buyOrders} buy / ${sellOrders} sell`,
        effectiveOrdersPerSide: effectiveOrdersMeta.count,
        configuredOrdersPerSideCap: effectiveOrdersMeta.maxConfigured,
        ordersMode: effectiveOrdersMeta.mode,
        effectiveOrderSizeUsdt: effectiveSizeMeta.orderSizeUsdt,
        minOrderSizeUsdt: effectiveSizeMeta.minOrderSizeUsdt,
        sizeMode: effectiveSizeMeta.mode,
        availableUsdtLabel: Number.isFinite(availableUsdt) ? availableUsdt.toFixed(2) : "N/A"
    };
};

const applyAutoPairGridPreset = (config) => {
    if (!config || typeof config !== "object") return { config, changed: false, presetName: null };
    const strategy = String(config.strategy || "").toLowerCase();
    if (strategy && strategy !== "futures_grid") return { config, changed: false, presetName: null };

    const presetName = resolveAutoPairPresetName(config.pair);
    const preset = AUTO_PAIR_GRID_PRESETS[presetName];
    if (!preset) return { config, changed: false, presetName: null };

    const gridKeys = Object.keys(preset);
    let changed = false;
    const nextConfig = { ...config };

    for (const key of gridKeys) {
        if (nextConfig[key] !== preset[key]) {
            nextConfig[key] = preset[key];
            changed = true;
        }
    }

    const rawMarginMode = typeof config.marginMode === "string" ? config.marginMode.trim().toLowerCase() : "";
    if (VALID_MARGIN_MODES.includes(rawMarginMode)) {
        nextConfig.marginMode = rawMarginMode;
    }

    const activeGridFingerprint = String(nextConfig.activeGridState?.fingerprint || "");
    if (!activeGridFingerprint.includes(String(nextConfig.gridLevels)) || changed) {
        if (nextConfig.activeGridState !== null) changed = true;
        nextConfig.activeGridState = null;
    }

    nextConfig.strategy = "futures_grid";
    return { config: nextConfig, changed, presetName };
};

const normalizeConfig = (config) => {
    const defaults = getDefaultConfig();
    if (!config || typeof config !== "object") return { ...defaults };

    const normalized = { ...config };
    const numericRules = {
        gridOrderSizeUsdt: { min: 0, allowZero: true }, leverage: { min: 0, allowZero: false, integer: true },
        gridTargetProfitUsdt: { min: 0, allowZero: false }, dailyProfitTargetUsdt: { min: 0, allowZero: false },
        dailyMaxLossPercent: { min: 0, allowZero: false }, maxTradesPerDay: { min: 0, allowZero: false, integer: true },
        coolingPeriod: { min: 0, allowZero: true, integer: true }, monitoringInterval: { min: 200, allowZero: false, integer: true },
        gridStopLossPercent: { min: 0, allowZero: false }, gridLevels: { min: 4, allowZero: false, integer: true },
        gridLookbackCandles: { min: 20, allowZero: false, integer: true }, gridRangePercent: { min: 0.5, allowZero: false },
        gridEntryBufferPercent: { min: 0.02, allowZero: false }, gridTakeProfitLevels: { min: 0, allowZero: true, integer: true },
        gridOrdersPerSide: { min: 0, allowZero: true, integer: true },
        gridStopLossLevels: { min: 0, allowZero: true }, sessionStartUTC: { min: 0, allowZero: true, integer: true },
        sessionEndUTC: { min: 0, allowZero: true, integer: true }, volumePeriod: { min: 2, allowZero: false, integer: true },
        minVolumeRatio: { min: 1, allowZero: false },
        atrPeriod: { min: 2, allowZero: false, integer: true },
        trailingActivateATR: { min: 0.2, allowZero: false },
        trailingOffsetATR: { min: 0.1, allowZero: false }
    };

    Object.entries(numericRules).forEach(([key, rule]) => {
        const rawValue = normalized[key];
        const hasValue = rawValue !== undefined && rawValue !== null && rawValue !== "";
        if (!hasValue) { normalized[key] = defaults[key]; return; }
        const value = Number(rawValue);
        const invalidNumber = !Number.isFinite(value);
        const invalidZero = !rule.allowZero && value === 0;
        const belowMin = value < rule.min;
        if (invalidNumber || invalidZero || belowMin) {
            console.warn(`[WARN] Invalid config '${key}' (${normalized[key]}). Using default ${defaults[key]}.`);
            normalized[key] = defaults[key]; return;
        }
        normalized[key] = rule.integer ? Math.trunc(value) : value;
    });

    const isValidTimeframe = (value) => typeof value === "string" && /^[1-9]\d*[mhdwM]$/.test(value.trim());
    const rawPair = typeof normalized.pair === "string" ? normalized.pair.trim() : "";
    normalized.pair = rawPair || defaults.pair;
    const rawStrategy = typeof normalized.strategy === "string" ? normalized.strategy.trim().toLowerCase() : "";
    normalized.strategy = rawStrategy || defaults.strategy;
    const rawMarginMode = typeof normalized.marginMode === "string" ? normalized.marginMode.trim().toLowerCase() : "";
    normalized.marginMode = rawMarginMode === "isolated" || rawMarginMode === "cross" ? rawMarginMode : defaults.marginMode;
    const rawGridTimeframe = typeof normalized.gridTimeframe === "string"
        ? normalized.gridTimeframe
        : normalized.breakoutTimeframe;
    normalized.gridTimeframe = isValidTimeframe(rawGridTimeframe) ? rawGridTimeframe.trim() : defaults.gridTimeframe;
    delete normalized.breakoutTimeframe;
    normalized.activePosition = normalizeActivePositionState(normalized.activePosition);
    if (typeof normalized.activeGridState === "string") {
        normalized.activeGridState = safeParseJSON(normalized.activeGridState, null);
    } else if (!normalized.activeGridState || typeof normalized.activeGridState !== "object") {
        normalized.activeGridState = null;
    }

    const normalizeBoolean = (key) => {
        if (typeof normalized[key] === "boolean") return;
        if (typeof normalized[key] === "string") {
            const parsed = normalized[key].trim().toLowerCase();
            if (parsed === "true" || parsed === "1") normalized[key] = true;
            else if (parsed === "false" || parsed === "0") normalized[key] = false;
            else normalized[key] = defaults[key];
        } else if (typeof normalized[key] === "number") {
            normalized[key] = normalized[key] === 1;
        } else {
            normalized[key] = defaults[key];
        }
    };

    BOOLEAN_CONFIG_KEYS.forEach(normalizeBoolean);
    normalized.dailyPnL = toFiniteNumber(normalized.dailyPnL, defaults.dailyPnL);
    normalized.dailyTrades = Math.max(0, Math.trunc(toFiniteNumber(normalized.dailyTrades, defaults.dailyTrades)));
    normalized.lastDailyReset = toFiniteNumber(normalized.lastDailyReset, defaults.lastDailyReset);
    normalized.lastUpdated = toFiniteNumber(normalized.lastUpdated, defaults.lastUpdated);
    if (normalized.id !== undefined && normalized.id !== null && normalized.id !== "") {
        normalized.id = Math.max(0, Math.trunc(toFiniteNumber(normalized.id, 0)));
    }
    normalized.sessionStartUTC = clamp(Math.trunc(toFiniteNumber(normalized.sessionStartUTC, defaults.sessionStartUTC)), 0, 23);
    normalized.sessionEndUTC = clamp(Math.trunc(toFiniteNumber(normalized.sessionEndUTC, defaults.sessionEndUTC)), 0, 23);
    normalized.gridTakeProfitLevels = clamp(normalized.gridTakeProfitLevels, 0, Math.max(1, normalized.gridLevels - 1));
    normalized.gridOrdersPerSide = clamp(normalized.gridOrdersPerSide, 0, Math.max(1, normalized.gridLevels - 1));

    return normalized;
};

const applyAutoPresetToConfig = (config) => {
    const autoPresetResult = applyAutoPairGridPreset(config);
    return {
        config: normalizeConfig(autoPresetResult.config),
        autoPresetResult
    };
};

const createConfigLifecycleHelpers = () => {
    const saveDB = async () => {
        try { if (!db) return; await persistConfig(db); syncDashboardConfigSignature(); }
        catch (error) { console.error("[ERROR] Failed to save DB:", error.message); }
    };

    const initializeDB = async () => {
        try {
            await ensureConfigSchema();
            console.log("[OK] Database synced");
            const configRow = await ensureConfigRow();
            const persisted = configRow.toJSON();
            const { config: hydratedConfig, autoPresetResult } = applyAutoPresetToConfig(hydrateConfig(persisted));
            db = hydratedConfig;
            syncDashboardConfigSignature();
            if (autoPresetResult.changed) {
                await saveDB();
                console.log(`[PRESET] Auto-applied ${autoPresetResult.presetName} profile for ${db.pair}`);
            }
            console.log("[OK] DB initialized successfully");
            return true;
        } catch (error) {
            console.error("[ERROR] Error initializing DB:", error.message);
            db = null;
            return false;
        }
    };

    const reloadConfig = async (previousRuntimeConfig = null) => {
        try {
            if (!db) return false;
            const runtimeSnapshot = previousRuntimeConfig && typeof previousRuntimeConfig === "object"
                ? { ...previousRuntimeConfig }
                : { ...db };
            const persistedConfig = await loadPersistedConfig();
            if (!persistedConfig) return false;
            const { config: normalizedConfig, autoPresetResult } = applyAutoPresetToConfig(persistedConfig);
            mergeRuntimeConfig(normalizedConfig);
            await applyRuntimeConfigChanges(runtimeSnapshot);
            syncDashboardConfigSignature();
            if (autoPresetResult.changed && !hasAnyActivePosition()) {
                await saveDB();
                console.log(`[PRESET] Auto-refreshed ${autoPresetResult.presetName} profile for ${db.pair}`);
            }
            return true;
        } catch (error) {
            console.error("[ERROR] Failed to reload config:", error.message);
            return false;
        }
    };

    return { initializeDB, reloadConfig, saveDB };
};

const {
    initializeDB,
    reloadConfig,
    saveDB
} = createConfigLifecycleHelpers();

// -------------------- SYNC POSITION WITH EXCHANGE --------------------
const syncPositionWithExchange = async () => {
    if (isSyncingPosition || isClosingPosition) return;
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
    } catch (error) { console.error("[ERROR] Sync position failed:", error.message); }
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
    if (isSyncingGridOrders || isPlacingOrder || isClosingPosition) return;
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
            if (!db || !hasAnyActivePosition() || isClosingPosition) return;
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



