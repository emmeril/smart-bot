require("dotenv").config();
const fs = require("fs");
const path = require("path");
const ccxt = require("ccxt");
const { Sequelize, DataTypes } = require('sequelize');

// -------------------- DATABASE SETUP --------------------
const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: path.join(__dirname, 'database.sqlite'),
    logging: false
});

const Config = sequelize.define('Config', {
    strategy: { type: DataTypes.STRING, defaultValue: "futures_grid" },
    pair: { type: DataTypes.STRING, defaultValue: "DOGE/USDT:USDT" },
    gridOrderSizeUsdt: { type: DataTypes.FLOAT, defaultValue: 1.5 },
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
    gridTakeProfitLevels: { type: DataTypes.INTEGER, defaultValue: 1 },
    gridOrdersPerSide: { type: DataTypes.INTEGER, defaultValue: 1 },
    gridStopLossLevels: { type: DataTypes.FLOAT, defaultValue: 1.2 },

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
let balanceCache = { totalUSDT: 0, lastUpdate: 0 };
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
let isShuttingDown = false;
let accountPositionMode = { hedged: false, label: "ONE_WAY" };
const logPath = path.join(__dirname, 'trades.csv');
let db = null;
const BALANCE_CACHE_TTL = 15000;
const TICKER_CACHE_TTL = 800;
const OHLCV_CACHE_TTL = 1500;
const SYNC_LOG_TTL = 15000;
const SIGNAL_DETAIL_LOG_TTL = 10000;
const GRID_SYNC_LOG_TTL = 15000;
const METRICS_LOG_INTERVAL = 60000;
const POSITION_RUNTIME_PERSIST_TTL = 2000;
const POSITION_SYNC_QTY_TOLERANCE = 0.001;
const POSITION_SYNC_ENTRY_TOLERANCE_PCT = 0.05;
const BOOLEAN_CONFIG_KEYS = ["trailingEnabled", "allowLong", "allowShort"];
const DEFAULT_CONFIG = {
    strategy: "futures_grid",
    pair: "DOGE/USDT:USDT",
    gridOrderSizeUsdt: 1.5,
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
    gridTakeProfitLevels: 1,
    gridOrdersPerSide: 1,
    gridStopLossLevels: 1.2,
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
const TAKER_FEE_RATE = 0.0005;
const GRID_CLIENT_ORDER_PREFIX = "smartgrid";
const TP_CLIENT_ORDER_PREFIX = "smarttp";
const SL_CLIENT_ORDER_PREFIX = "smartsl";

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
    if (!value) return fallback;
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
        [metricsTimer, () => { metricsTimer = null; }]
    ];
    for (const [timer, resetTimer] of timers) {
        if (!timer) continue;
        clearInterval(timer);
        resetTimer();
    }
};

const printStartupBanner = (totalUSDT) => {
    const gridSummary = getGridRuntimeSummary();
    console.log("\n" + "=".repeat(70));
    console.log("BINANCE-STYLE FUTURES GRID BOT");
    console.log("=".repeat(70));
    console.log(`Balance: $${totalUSDT.toFixed(2)}`);
    console.log(`Pair: ${db.pair}`);
    console.log(`Strategy: ${String(db.strategy || "futures_grid").toUpperCase()} on ${db.gridTimeframe}`);
    console.log(`Preset Profile: ${gridSummary.presetName.toUpperCase()}`);
    console.log(`Position Mode: ${accountPositionMode.label}`);
    console.log(`Grid: ${db.gridLevels} levels | lookback ${db.gridLookbackCandles} candles | range ${db.gridRangePercent}%`);
    console.log(`Grid TP/SL: ${db.gridTakeProfitLevels} level(s) / ${db.gridStopLossLevels} step(s) | ${db.gridOrdersPerSide} order(s) per side`);
    console.log(`Grid Order Size: ${db.gridOrderSizeUsdt} USDT`);
    if (gridSummary.hasLockedGrid) {
        console.log(`Locked Grid Range: ${gridSummary.lockedRangeLabel}`);
        console.log(`Grid Step: ${gridSummary.stepLabel}`);
    }
    console.log(`Volume filter: ${db.minVolumeRatio}x over ${db.volumePeriod} periods`);
    console.log(`Session: ${db.sessionStartUTC}-${db.sessionEndUTC} UTC`);
    console.log(`Trailing ATR: ${db.trailingEnabled ? `${db.trailingActivateATR}/${db.trailingOffsetATR}x` : "OFF"}`);
    console.log(`Leverage: ${db.leverage}x`);
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
    hydrated.activePosition = safeParseJSON(hydrated.activePosition, null);
    hydrated.activeGridState = safeParseJSON(hydrated.activeGridState, null);
    if (hydrated.activePosition && isLegacySinglePosition(hydrated.activePosition)) {
        const legacyPositionSide = String(hydrated.activePosition.positionSide || "").toUpperCase();
        const legacySideValue = String(hydrated.activePosition.side || "").toLowerCase();
        const legacySide = legacyPositionSide || (legacySideValue === "buy" ? "LONG" : (legacySideValue === "sell" ? "SHORT" : "BOTH"));
        const legacyKey = toPositionMapKey(legacySide);
        hydrated.activePosition = { [legacyKey]: hydrated.activePosition };
    }
    return normalizeConfig(hydrated);
};

const serializeConfigForSave = (config) => ({
    ...config,
    activePosition: config.activePosition ? JSON.stringify(config.activePosition) : null,
    activeGridState: config.activeGridState ? JSON.stringify(config.activeGridState) : null,
    lastUpdated: Date.now()
});

const getConfigRow = async () => Config.findOne();
const OBSOLETE_CONFIG_COLUMNS = ["autoRiskEnabled", "atrTargetMult", "atrStopMult"];

const ensureConfigSchema = async () => {
    await sequelize.sync();
    const tableInfo = await sequelize.query("PRAGMA table_info('Configs');", { type: sequelize.QueryTypes.SELECT });
    const columnNames = new Set(tableInfo.map((column) => String(column.name)));
    if (!columnNames.has("gridOrderSizeUsdt")) {
        await sequelize.query("ALTER TABLE Configs ADD COLUMN gridOrderSizeUsdt FLOAT DEFAULT 1.5;");
        if (columnNames.has("usdtPerTrade")) {
            await sequelize.query("UPDATE Configs SET gridOrderSizeUsdt = COALESCE(usdtPerTrade, 1.5) WHERE gridOrderSizeUsdt IS NULL OR gridOrderSizeUsdt = '';");
        }
        console.log("[INFO] Added config column: gridOrderSizeUsdt");
    }
    if (!columnNames.has("gridTargetProfitUsdt")) {
        await sequelize.query("ALTER TABLE Configs ADD COLUMN gridTargetProfitUsdt FLOAT DEFAULT 0.5;");
        if (columnNames.has("targetProfitUSDT")) {
            await sequelize.query("UPDATE Configs SET gridTargetProfitUsdt = COALESCE(targetProfitUSDT, 0.5) WHERE gridTargetProfitUsdt IS NULL OR gridTargetProfitUsdt = '';");
        }
        console.log("[INFO] Added config column: gridTargetProfitUsdt");
    }
    if (!columnNames.has("gridStopLossPercent")) {
        await sequelize.query("ALTER TABLE Configs ADD COLUMN gridStopLossPercent FLOAT DEFAULT 5;");
        if (columnNames.has("stopLossPercent")) {
            await sequelize.query("UPDATE Configs SET gridStopLossPercent = COALESCE(stopLossPercent, 5) WHERE gridStopLossPercent IS NULL OR gridStopLossPercent = '';");
        }
        console.log("[INFO] Added config column: gridStopLossPercent");
    }
    if (!columnNames.has("gridTimeframe")) {
        await sequelize.query("ALTER TABLE Configs ADD COLUMN gridTimeframe VARCHAR(255) DEFAULT '5m';");
        if (columnNames.has("breakoutTimeframe")) {
            await sequelize.query("UPDATE Configs SET gridTimeframe = COALESCE(breakoutTimeframe, '5m') WHERE gridTimeframe IS NULL OR gridTimeframe = '';");
        }
        console.log("[INFO] Added config column: gridTimeframe");
    }
    if (!columnNames.has("activeGridState")) {
        await sequelize.query("ALTER TABLE Configs ADD COLUMN activeGridState TEXT DEFAULT NULL;");
        console.log("[INFO] Added config column: activeGridState");
    }
    if (!columnNames.has("dailyProfitTargetUsdt")) {
        await sequelize.query("ALTER TABLE Configs ADD COLUMN dailyProfitTargetUsdt FLOAT DEFAULT 1;");
        if (columnNames.has("targetDailyProfit")) {
            await sequelize.query("UPDATE Configs SET dailyProfitTargetUsdt = COALESCE(targetDailyProfit, 1) WHERE dailyProfitTargetUsdt IS NULL OR dailyProfitTargetUsdt = '';");
        }
        console.log("[INFO] Added config column: dailyProfitTargetUsdt");
    }
    if (!columnNames.has("dailyMaxLossPercent")) {
        await sequelize.query("ALTER TABLE Configs ADD COLUMN dailyMaxLossPercent FLOAT DEFAULT 10;");
        if (columnNames.has("maxDailyLossPercent")) {
            await sequelize.query("UPDATE Configs SET dailyMaxLossPercent = COALESCE(maxDailyLossPercent, 10) WHERE dailyMaxLossPercent IS NULL OR dailyMaxLossPercent = '';");
        }
        console.log("[INFO] Added config column: dailyMaxLossPercent");
    }
    if (!columnNames.has("strategy")) {
        await sequelize.query("ALTER TABLE Configs ADD COLUMN strategy VARCHAR(255) DEFAULT 'futures_grid';");
        console.log("[INFO] Added config column: strategy");
    }
    if (!columnNames.has("sessionStartUTC")) {
        await sequelize.query("ALTER TABLE Configs ADD COLUMN sessionStartUTC INTEGER DEFAULT 0;");
        console.log("[INFO] Added config column: sessionStartUTC");
    }
    if (!columnNames.has("sessionEndUTC")) {
        await sequelize.query("ALTER TABLE Configs ADD COLUMN sessionEndUTC INTEGER DEFAULT 23;");
        console.log("[INFO] Added config column: sessionEndUTC");
    }
    if (!columnNames.has("volumePeriod")) {
        await sequelize.query("ALTER TABLE Configs ADD COLUMN volumePeriod INTEGER DEFAULT 20;");
        console.log("[INFO] Added config column: volumePeriod");
    }
    if (!columnNames.has("minVolumeRatio")) {
        await sequelize.query("ALTER TABLE Configs ADD COLUMN minVolumeRatio FLOAT DEFAULT 1.3;");
        console.log("[INFO] Added config column: minVolumeRatio");
    }
    if (!columnNames.has("atrPeriod")) {
        await sequelize.query("ALTER TABLE Configs ADD COLUMN atrPeriod INTEGER DEFAULT 14;");
        console.log("[INFO] Added config column: atrPeriod");
    }
    if (!columnNames.has("trailingEnabled")) {
        await sequelize.query("ALTER TABLE Configs ADD COLUMN trailingEnabled BOOLEAN DEFAULT 1;");
        console.log("[INFO] Added config column: trailingEnabled");
    }
    if (!columnNames.has("trailingActivateATR")) {
        await sequelize.query("ALTER TABLE Configs ADD COLUMN trailingActivateATR FLOAT DEFAULT 1.2;");
        console.log("[INFO] Added config column: trailingActivateATR");
    }
    if (!columnNames.has("trailingOffsetATR")) {
        await sequelize.query("ALTER TABLE Configs ADD COLUMN trailingOffsetATR FLOAT DEFAULT 0.6;");
        console.log("[INFO] Added config column: trailingOffsetATR");
    }
    if (!columnNames.has("allowLong")) {
        await sequelize.query("ALTER TABLE Configs ADD COLUMN allowLong BOOLEAN DEFAULT 1;");
        console.log("[INFO] Added config column: allowLong");
    }
    if (!columnNames.has("allowShort")) {
        await sequelize.query("ALTER TABLE Configs ADD COLUMN allowShort BOOLEAN DEFAULT 1;");
        console.log("[INFO] Added config column: allowShort");
    }

    for (const obsoleteColumn of OBSOLETE_CONFIG_COLUMNS) {
        if (!columnNames.has(obsoleteColumn)) continue;
        try {
            await sequelize.query(`ALTER TABLE Configs DROP COLUMN ${obsoleteColumn};`);
            console.log(`[INFO] Dropped obsolete config column: ${obsoleteColumn}`);
        } catch (error) {
            console.warn(`[WARN] Could not drop obsolete config column ${obsoleteColumn}: ${error.message}`);
        }
    }
};

const loadPersistedConfig = async () => {
    const configRow = await getConfigRow();
    return configRow ? hydrateConfig(configRow.toJSON()) : null;
};

const ensureConfigRow = async () => {
    let configRow = await getConfigRow();
    if (configRow) return configRow;

    configRow = await Config.create(getDefaultConfig());
    console.log("[INFO] Created new config row");
    return configRow;
};

const persistConfig = async (config) => {
    const toSave = serializeConfigForSave(config);
    const createPayload = { ...toSave };
    delete createPayload.id;

    if (config.id) {
        const [affectedRows] = await Config.update(toSave, { where: { id: config.id } });
        if (affectedRows > 0) return config.id;
    }

    const firstRow = await getConfigRow();
    if (firstRow) {
        config.id = firstRow.id;
        const [fallbackAffectedRows] = await Config.update(toSave, { where: { id: firstRow.id } });
        if (fallbackAffectedRows > 0) return firstRow.id;
    }

    const created = await Config.create(createPayload);
    config.id = created.id;
    return created.id;
};

const getSignalParameters = () => {
    const volumePeriod = Math.max(2, Math.trunc(toFiniteNumber(db.volumePeriod, DEFAULT_CONFIG.volumePeriod)));
    const atrPeriod = Math.max(2, Math.trunc(toFiniteNumber(db.atrPeriod, DEFAULT_CONFIG.atrPeriod)));
    const gridLookbackCandles = Math.max(20, Math.trunc(toFiniteNumber(db.gridLookbackCandles, DEFAULT_CONFIG.gridLookbackCandles)));
    const gridLevels = Math.max(4, Math.trunc(toFiniteNumber(db.gridLevels, DEFAULT_CONFIG.gridLevels)));
    const gridTakeProfitLevels = Math.max(1, Math.trunc(toFiniteNumber(db.gridTakeProfitLevels, DEFAULT_CONFIG.gridTakeProfitLevels)));
    const neededCandles = Math.max(gridLookbackCandles + 5, volumePeriod + 10, atrPeriod + 10, 150);
    return {
        strategy: "futures_grid",
        volumePeriod,
        atrPeriod,
        neededCandles,
        gridLookbackCandles,
        gridLevels,
        gridTakeProfitLevels,
        gridOrdersPerSide: Math.max(1, Math.trunc(toFiniteNumber(db.gridOrdersPerSide, DEFAULT_CONFIG.gridOrdersPerSide))),
        gridRangePercent: Math.max(0.5, toFiniteNumber(db.gridRangePercent, DEFAULT_CONFIG.gridRangePercent)),
        gridEntryBufferPercent: Math.max(0.02, toFiniteNumber(db.gridEntryBufferPercent, DEFAULT_CONFIG.gridEntryBufferPercent)),
        gridStopLossLevels: Math.max(0.5, toFiniteNumber(db.gridStopLossLevels, DEFAULT_CONFIG.gridStopLossLevels))
    };
};

const buildGridLevels = (lowerBound, upperBound, gridLevels) => {
    const safeLevels = Math.max(2, Math.trunc(gridLevels));
    const step = (upperBound - lowerBound) / safeLevels;
    const levels = [];
    for (let i = 0; i <= safeLevels; i++) levels.push(lowerBound + (step * i));
    return { levels, step };
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

const fetchOpenGridOrders = async () => {
    const { regularOrders } = await fetchOpenOrdersSnapshot(db.pair);
    const openOrders = regularOrders;
    return openOrders.filter((order) => normalizeSymbol(order.symbol) === normalizeSymbol(db.pair) && isGridEntryOrder(order));
};

const findOpenGridOrderByClientOrderId = async (clientOrderId) => {
    if (!clientOrderId) return null;
    const openGridOrders = await fetchOpenGridOrders();
    return openGridOrders.find((order) => getExchangeClientOrderId(order) === clientOrderId) || null;
};

const fetchOpenTpOrders = async () => {
    const { regularOrders } = await fetchOpenOrdersSnapshot(db.pair);
    const openOrders = regularOrders;
    return openOrders.filter((order) => normalizeSymbol(order.symbol) === normalizeSymbol(db.pair) && isTpReduceOnlyOrder(order));
};

const fetchOpenSlOrders = async () => {
    const { triggerOrders } = await fetchOpenOrdersSnapshot(db.pair);
    const openOrders = triggerOrders;
    return openOrders.filter((order) => normalizeSymbol(order.symbol) === normalizeSymbol(db.pair) && isSlReduceOnlyOrder(order));
};

const findOpenOrderByClientOrderId = async (clientOrderId, symbol = db?.pair) => {
    if (!clientOrderId || !symbol) return null;
    const { regularOrders, triggerOrders } = await fetchOpenOrdersSnapshot(symbol);
    const openOrders = regularOrders;
    const regularMatch = openOrders.find((order) => getExchangeClientOrderId(order) === clientOrderId);
    if (regularMatch) return regularMatch;

    return triggerOrders.find((order) => getExchangeClientOrderId(order) === clientOrderId) || null;
};

const fetchManagedOpenOrdersSnapshot = async () => {
    const { regularOrders, triggerOrders } = await fetchOpenOrdersSnapshot(db.pair);
    const managedOrders = [...regularOrders, ...triggerOrders].filter((order) => normalizeSymbol(order.symbol) === normalizeSymbol(db.pair));
    return {
        grid: managedOrders.filter(isGridEntryOrder),
        tp: managedOrders.filter(isTpReduceOnlyOrder),
        sl: managedOrders.filter(isSlReduceOnlyOrder)
    };
};

const cancelManagedOrdersForPosition = async (position, reason = "POSITION_CLEANUP") => {
    if (!position) return;
    const tpOrders = await fetchOpenTpOrders();
    const matchingTpOrders = tpOrders.filter((order) => matchesOrderToTrackedPosition(order, position));
    if (matchingTpOrders.length > 0) await cancelTpOrders(matchingTpOrders, reason);

    const slOrders = await fetchOpenSlOrders();
    const matchingSlOrders = slOrders.filter((order) => matchesOrderToTrackedPosition(order, position));
    if (matchingSlOrders.length > 0) await cancelSlOrders(matchingSlOrders, reason);
};

const cancelDuplicateManagedOrders = async (orders, cancelReason, label = "ORDER") => {
    if (!Array.isArray(orders) || orders.length <= 1) return orders || [];

    const seen = new Set();
    const uniqueOrders = [];
    const duplicateOrders = [];

    for (const order of orders) {
        const clientOrderId = getExchangeClientOrderId(order);
        if (!clientOrderId) {
            uniqueOrders.push(order);
            continue;
        }

        if (seen.has(clientOrderId)) duplicateOrders.push(order);
        else {
            seen.add(clientOrderId);
            uniqueOrders.push(order);
        }
    }

    if (duplicateOrders.length > 0) {
        console.warn(`[${label}] Found ${duplicateOrders.length} duplicate managed order(s) (${cancelReason}). Cancelling extras...`);
        for (const duplicateOrder of duplicateOrders) {
            try {
                const cancelParams = isTriggerManagedOrder(duplicateOrder, label) ? { trigger: true } : undefined;
                await exchange.cancelOrder(duplicateOrder.id, db.pair, cancelParams);
                metrics.api.orders++;
            } catch (error) {
                console.warn(`[WARN] Failed to cancel duplicate ${label.toLowerCase()} order ${duplicateOrder.id}: ${error.message}`);
            }
        }
    }

    return uniqueOrders;
};

const buildGridEntryOrders = (snapshot, params, gridState = null) => {
    const resolvedGridState = sanitizeGridState(gridState, params) || createLockedGridState(snapshot, params);
    const levels = resolvedGridState?.levels || [];
    const step = toFiniteNumber(resolvedGridState?.step, NaN);
    if (!Number.isFinite(step) || step <= 0) return [];

    const minBuyPrice = snapshot.currentPrice * (1 - (params.gridEntryBufferPercent / 100));
    const maxSellPrice = snapshot.currentPrice * (1 + (params.gridEntryBufferPercent / 100));
    const buyOrders = [];
    const sellOrders = [];

    for (let i = levels.length - 2; i >= 0; i--) {
        const price = formatPriceToMarketPrecision(db.pair, levels[i]);
        const targetPrice = formatPriceToMarketPrecision(db.pair, levels[i + 1]);
        const stopLossPrice = formatPriceToMarketPrecision(db.pair, levels[i] - (step * params.gridStopLossLevels));
        const orderPlan = { targetPrice, stopLossPrice };
        if (Number.isFinite(price) && price > 0 && price < minBuyPrice) {
            if (!isDirectionalOrderPlanValid("buy", price, orderPlan)) {
                console.warn(`[GRID] Skipping BUY level ${i} @ ${price} because TP/SL would be invalid after precision rounding.`);
                continue;
            }
            buyOrders.push({
                side: "buy",
                price,
                targetPrice,
                stopLossPrice,
                levelIndex: i,
                clientOrderId: getGridClientOrderId("buy", i, price)
            });
        }
    }

    for (let i = 1; i < levels.length; i++) {
        const price = formatPriceToMarketPrecision(db.pair, levels[i]);
        const targetPrice = formatPriceToMarketPrecision(db.pair, levels[i - 1]);
        const stopLossPrice = formatPriceToMarketPrecision(db.pair, levels[i] + (step * params.gridStopLossLevels));
        const orderPlan = { targetPrice, stopLossPrice };
        if (Number.isFinite(price) && price > 0 && price > maxSellPrice) {
            if (!isDirectionalOrderPlanValid("sell", price, orderPlan)) {
                console.warn(`[GRID] Skipping SELL level ${i} @ ${price} because TP/SL would be invalid after precision rounding.`);
                continue;
            }
            sellOrders.push({
                side: "sell",
                price,
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

    const selectedOrders = [
        ...buyOrders.slice(0, params.gridOrdersPerSide),
        ...sellOrders.slice(0, params.gridOrdersPerSide)
    ];
    const { deduped, duplicates } = dedupeBySideAndPrice(selectedOrders);
    if (duplicates.length > 0) {
        console.warn(`[GRID] Deduped ${duplicates.length} grid order(s) that collapsed to the same rounded price.`);
    }
    return deduped;
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
    const longTargetIndex = clamp(lowerIndex + params.gridTakeProfitLevels, 1, levels.length - 1);
    const shortTargetIndex = clamp(upperIndex - params.gridTakeProfitLevels, 0, levels.length - 2);
    const longTargetPrice = formatPriceToMarketPrecision(db.pair, levels[longTargetIndex]);
    const shortTargetPrice = formatPriceToMarketPrecision(db.pair, levels[shortTargetIndex]);
    const longStopPrice = formatPriceToMarketPrecision(db.pair, currentLevelLow - (step * params.gridStopLossLevels));
    const shortStopPrice = formatPriceToMarketPrecision(db.pair, currentLevelHigh + (step * params.gridStopLossLevels));
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
    console.log("\n" + "=".repeat(50));
    console.log(`${signalState.detailTitle} (${db.gridTimeframe}):`);
    console.log(`   Current Price: ${snapshot.currentPrice}`);
    console.log(`   Current Volume: ${snapshot.currentVolume.toFixed(2)}`);
    console.log(`   Avg Volume (${params.volumePeriod}): ${snapshot.avgVolume.toFixed(2)}`);
    console.log(`   Volume Ratio: ${snapshot.volumeRatio.toFixed(2)}x`);
    console.log(`   ATR ${params.atrPeriod}: ${snapshot.currentATR.toFixed(6)}`);
    console.log("");
    console.log("SETUP CONDITIONS:");
    signalState.extraDetailLines.forEach((line) => console.log(line));
    console.log("");
    console.log("FINAL SIGNAL:");
    console.log(`   LONG Signal: ${signalState.canLong ? "[OK] CONFIRMED" : "[NO] NOT CONFIRMED"}`);
    console.log(`   SHORT Signal: ${signalState.canShort ? "[OK] CONFIRMED" : "[NO] NOT CONFIRMED"}`);
    console.log("=".repeat(50));
};

const logGridSyncStatus = (desiredOrders, openGridOrders) => {
    const now = Date.now();
    if (now - lastGridSyncLogAt < GRID_SYNC_LOG_TTL) return;
    console.log(`[GRID] Desired ladder=${desiredOrders.length} | Open grid orders=${openGridOrders.length}`);
    lastGridSyncLogAt = now;
};

const buildRiskOverrides = () => ({
    trailingActivateATR: toFiniteNumber(db.trailingActivateATR, 1.2),
    trailingOffsetATR: toFiniteNumber(db.trailingOffsetATR, 0.6)
});

const parseSignalOrderData = (signalData) => {
    if (typeof signalData !== "object" || signalData === null) {
        return {
            signalPrice: signalData,
            signalATR: null,
            strategyName: "FUTURES_GRID",
            riskOverrides: {},
            signalTargetPrice: null,
            signalStopLossPrice: null
        };
    }
    return {
        signalPrice: signalData.price,
        signalATR: toFiniteNumber(signalData.atr, null),
        strategyName: signalData.strategy ? String(signalData.strategy) : "FUTURES_GRID",
        riskOverrides: signalData.riskOverrides || {},
        signalTargetPrice: toFiniteNumber(signalData.targetPrice, null),
        signalStopLossPrice: toFiniteNumber(signalData.stopLossPrice, null)
    };
};

const buildExchangeOrderParams = ({ side, reduceOnly = false, positionSide } = {}) => {
    const params = {
        newOrderRespType: "RESULT"
    };
    if (isHedgeModeEnabled()) {
        const resolvedPositionSide = positionSide || getOrderPositionSide(side);
        if (resolvedPositionSide && resolvedPositionSide !== "BOTH") params.positionSide = resolvedPositionSide;
    } else if (reduceOnly) {
        params.reduceOnly = true;
    }
    return params;
};

const getOrderFillSnapshot = (order, fallbackPrice, fallbackQuantity) => {
    const filledQuantity = toFiniteNumber(order?.filled, 0);
    const averagePrice = toFiniteNumber(order?.average, 0);
    const orderCost = toFiniteNumber(order?.cost, 0);
    const directPrice = toFiniteNumber(order?.price, 0);
    const infoAveragePrice = toFiniteNumber(order?.info?.avgPrice, 0);
    const infoQuoteQty = toFiniteNumber(order?.info?.cumQuoteQty, 0);
    const resolvedQuantity = filledQuantity > 0 ? filledQuantity : fallbackQuantity;
    const resolvedPrice = averagePrice > 0
        ? averagePrice
        : (infoAveragePrice > 0
            ? infoAveragePrice
            : (filledQuantity > 0 && orderCost > 0
                ? orderCost / filledQuantity
                : (filledQuantity > 0 && infoQuoteQty > 0 ? infoQuoteQty / filledQuantity : (directPrice > 0 ? directPrice : fallbackPrice))));
    return { price: resolvedPrice, quantity: resolvedQuantity };
};

const fetchOpenOrdersSnapshot = async (symbol) => {
    metrics.api.orders++;
    const regularOrders = await exchange.fetchOpenOrders(symbol);
    metrics.api.orders++;
    const triggerOrders = await exchange.fetchOpenOrders(symbol, undefined, undefined, { trigger: true });
    return { regularOrders, triggerOrders };
};

const cancelManagedOrders = async (orders, reason, label, cancelOptions = undefined) => {
    if (!Array.isArray(orders) || orders.length === 0) return;
    console.log(`[${label}] Cancelling ${orders.length} ${label.toLowerCase()} order(s) (${reason})...`);
    for (const order of orders) {
        try {
            await exchange.cancelOrder(order.id, db.pair, cancelOptions);
            metrics.api.orders++;
        } catch (error) {
            console.warn(`[WARN] Failed to cancel ${label.toLowerCase()} order ${order.id}: ${error.message}`);
        }
    }
};

const cancelGridOrders = async (orders, reason = "SYNC") => cancelManagedOrders(orders, reason, "GRID");

const cancelTpOrders = async (orders, reason = "TP_SYNC") => {
    return cancelManagedOrders(orders, reason, "TP");
};

const cancelSlOrders = async (orders, reason = "SL_SYNC") => {
    return cancelManagedOrders(orders, reason, "SL", { trigger: true });
};

const fetchOpenExchangePositions = async () => {
    metrics.api.positions++;
    const positions = await exchange.fetchPositions([db.pair]);
    return positions.filter((position) => (
        normalizeSymbol(position.symbol) === normalizeSymbol(db.pair) &&
        Math.abs(getExchangePositionContracts(position)) > 0
    ));
};

const fetchTrackedExchangePosition = async () => {
    const positions = await fetchOpenExchangePositions();
    return findOpenExchangePosition(positions, db.pair, getPrimaryActivePosition());
};

const validateOrderSize = (market, quantity, referencePrice) => {
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
        return { valid: false, reason: `[ERROR] Order notional ${notional.toFixed(6)} is below exchange minimum ${minCost}. Order skipped.` };
    }
    return { valid: true };
};

const buildOrderPlan = (side, entryPrice, adjustedQty, signalATR, riskOverrides, explicitTargets = {}) => {
    const trailingActivateATR = toFiniteNumber(riskOverrides.trailingActivateATR, db.trailingActivateATR);
    const trailingOffsetATR = toFiniteNumber(riskOverrides.trailingOffsetATR, db.trailingOffsetATR);
    const explicitTargetPrice = toFiniteNumber(explicitTargets.targetPrice, null);
    const explicitStopLossPrice = toFiniteNumber(explicitTargets.stopLossPrice, null);

    let targetProfitUSDT = db.gridTargetProfitUsdt;
    let stopLossUSDT = -db.gridOrderSizeUsdt * (db.gridStopLossPercent / 100);
    let targetPrice;
    let stopLossPrice;

    if (Number.isFinite(explicitTargetPrice) && Number.isFinite(explicitStopLossPrice)) {
        const roundedTargetPrice = formatPriceToMarketPrecision(db.pair, explicitTargetPrice);
        const roundedStopLossPrice = formatPriceToMarketPrecision(db.pair, explicitStopLossPrice);
        targetPrice = Number.isFinite(roundedTargetPrice) ? roundedTargetPrice : explicitTargetPrice;
        stopLossPrice = Number.isFinite(roundedStopLossPrice) ? roundedStopLossPrice : explicitStopLossPrice;
        targetProfitUSDT = Math.abs(targetPrice - entryPrice) * adjustedQty;
        stopLossUSDT = -Math.abs(stopLossPrice - entryPrice) * adjustedQty;
    } else {
        const rawTargetPrice = side === "buy"
            ? entryPrice + (targetProfitUSDT / adjustedQty)
            : entryPrice - (targetProfitUSDT / adjustedQty);
        const rawStopLossPrice = side === "buy"
            ? entryPrice + (stopLossUSDT / adjustedQty)
            : entryPrice - (stopLossUSDT / adjustedQty);
        const roundedTargetPrice = formatPriceToMarketPrecision(db.pair, rawTargetPrice);
        const roundedStopLossPrice = formatPriceToMarketPrecision(db.pair, rawStopLossPrice);
        targetPrice = Number.isFinite(roundedTargetPrice) ? roundedTargetPrice : rawTargetPrice;
        stopLossPrice = Number.isFinite(roundedStopLossPrice) ? roundedStopLossPrice : rawStopLossPrice;
        targetProfitUSDT = Math.abs(targetPrice - entryPrice) * adjustedQty;
        stopLossUSDT = -Math.abs(stopLossPrice - entryPrice) * adjustedQty;
    }

    if (Number.isFinite(entryPrice) && Number.isFinite(targetPrice) && targetPrice === entryPrice) {
        console.warn(`[WARN] Rounded target price equals entry price for ${side} order. Review precision/minimum profit settings.`);
    }
    if (Number.isFinite(entryPrice) && Number.isFinite(stopLossPrice) && stopLossPrice === entryPrice) {
        console.warn(`[WARN] Rounded stop loss price equals entry price for ${side} order. Review precision/minimum stop settings.`);
    }

    return {
        trailingActivateATR, trailingOffsetATR,
        targetProfitUSDT, stopLossUSDT,
        targetPrice,
        stopLossPrice,
        trailingEnabled: Boolean(db.trailingEnabled)
    };
};

const isDirectionalOrderPlanValid = (side, entryPrice, orderPlan) => {
    if (!orderPlan) return false;
    const targetPrice = toFiniteNumber(orderPlan.targetPrice, NaN);
    const stopLossPrice = toFiniteNumber(orderPlan.stopLossPrice, NaN);
    if (!Number.isFinite(entryPrice) || !Number.isFinite(targetPrice) || !Number.isFinite(stopLossPrice)) return false;
    if (side === "buy") return targetPrice > entryPrice && stopLossPrice < entryPrice;
    if (side === "sell") return targetPrice < entryPrice && stopLossPrice > entryPrice;
    return false;
};

const logOrderPlan = (strategyName, entryPrice, adjustedQty, orderPlan) => {
    console.log("   Order Details:");
    console.log(`   - Amount: ${db.gridOrderSizeUsdt} USDT x ${db.leverage}x = ${(db.gridOrderSizeUsdt * db.leverage).toFixed(2)} USDT`);
    console.log(`   - Quantity: ${adjustedQty} ${db.pair.split('/')[0]}`);
    console.log(`   - Entry Price: ${entryPrice}`);
    console.log(`   - Strategy: ${strategyName}`);
    console.log(`   - Target Profit: ${orderPlan.targetProfitUSDT.toFixed(4)} USDT`);
    console.log(`   - Target Price: ${orderPlan.targetPrice}`);
    console.log(`   - Stop Loss: ${orderPlan.stopLossUSDT.toFixed(4)} USDT`);
    console.log(`   - Stop Loss Price: ${orderPlan.stopLossPrice}`);
    console.log(`   - Trailing ATR: ${orderPlan.trailingActivateATR}/${orderPlan.trailingOffsetATR}x`);
};

const placeGridEntryOrder = async (gridOrder) => {
    const market = exchange.markets[db.pair];
    const rawQty = (db.gridOrderSizeUsdt * db.leverage) / gridOrder.price;
    const quantity = formatAmountToMarketPrecision(db.pair, rawQty);
    const sizeValidation = validateOrderSize(market, quantity, gridOrder.price);
    if (!sizeValidation.valid) {
        console.warn(`[GRID] Skipping ${gridOrder.side.toUpperCase()} ${gridOrder.price}: ${sizeValidation.reason}`);
        return false;
    }

    const params = buildExchangeOrderParams({
        side: gridOrder.side,
        positionSide: getOrderPositionSide(gridOrder.side)
    });
    params.newClientOrderId = gridOrder.clientOrderId;

    const existingOrder = await findOpenGridOrderByClientOrderId(gridOrder.clientOrderId);
    if (existingOrder) {
        console.log(`[GRID] Existing order already on exchange for ${gridOrder.clientOrderId}. Skipping duplicate placement.`);
        return true;
    }

    try {
        await exchange.createOrder(
            db.pair,
            "limit",
            gridOrder.side,
            quantity,
            gridOrder.price,
            params
        );
        metrics.api.orders++;
        console.log(`[GRID] Placed ${gridOrder.side.toUpperCase()} limit @ ${gridOrder.price} -> TP ${gridOrder.targetPrice} | SL ${gridOrder.stopLossPrice}`);
        return true;
    } catch (error) {
        if (isDuplicateClientOrderIdError(error)) {
            console.warn(`[GRID] Duplicate clientOrderId ${gridOrder.clientOrderId}. Attempting to cancel existing order and retry.`);
            const existingDuplicate = await findOpenGridOrderByClientOrderId(gridOrder.clientOrderId);
            if (existingDuplicate) {
                console.log(`[GRID] Duplicate order already active for ${gridOrder.clientOrderId}. Treating as placed.`);
                return true;
            }

            const cancelled = await cancelOrderByClientOrderId(gridOrder.clientOrderId, db.pair);
            if (cancelled) {
                try {
                    await exchange.createOrder(
                        db.pair,
                        "limit",
                        gridOrder.side,
                        quantity,
                        gridOrder.price,
                        params
                    );
                    metrics.api.orders++;
                    console.log(`[GRID] Retry succeeded: placed ${gridOrder.side.toUpperCase()} limit @ ${gridOrder.price}`);
                    return true;
                } catch (retryError) {
                    console.error(`[GRID] Retry failed for ${gridOrder.clientOrderId}: ${retryError.message}`);
                    const retryExistingOrder = await findOpenGridOrderByClientOrderId(gridOrder.clientOrderId);
                    if (retryExistingOrder) {
                        console.log(`[GRID] Retry duplicate resolved by existing exchange order for ${gridOrder.clientOrderId}.`);
                        return true;
                    }
                    await syncPositionWithExchange();
                    return false;
                }
            }

            console.warn(`[GRID] Could not cancel order with clientOrderId ${gridOrder.clientOrderId}. Syncing position state instead.`);
            await syncPositionWithExchange();
            return false;
        }

        console.error(`[GRID] Failed to place ${gridOrder.side.toUpperCase()} limit @ ${gridOrder.price}: ${error.message}`);
        return false;
    }
};

const escapeCsvField = (value) => {
    const text = String(value ?? "");
    if (text.includes(",") || text.includes("\"") || text.includes("\n") || text.includes("\r")) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
};

const placeReduceOnlyTakeProfitOrder = async (position) => {
    if (!Number.isFinite(position?.targetPrice) || position.targetPrice <= 0) return null;
    if (!Number.isFinite(position?.quantity) || position.quantity <= 0) return null;
    const closeSide = position.side === "buy" ? "sell" : "buy";
    const quantity = formatAmountToMarketPrecision(db.pair, position.quantity);
    const market = exchange.markets[db.pair];
    const sizeValidation = validateOrderSize(market, quantity, position.targetPrice);
    if (!sizeValidation.valid) {
        console.warn(`[TP] Skipping TP placement: ${sizeValidation.reason}`);
        return null;
    }

    const params = buildExchangeOrderParams({
        side: closeSide,
        reduceOnly: true,
        positionSide: getClosePositionSide(position)
    });
    const clientOrderId = position?.tpClientOrderId || getTpClientOrderId(position);
    params.newClientOrderId = clientOrderId;

    const existingOrder = await findOpenOrderByClientOrderId(clientOrderId, db.pair);
    if (existingOrder) {
        console.log(`[TP] Existing exchange order already active for ${clientOrderId}. Reusing it.`);
        return existingOrder;
    }

    try {
        const order = await exchange.createOrder(
            db.pair,
            "limit",
            closeSide,
            quantity,
            position.targetPrice,
            params
        );
        metrics.api.orders++;
        console.log(`[TP] Placed reduce-only TP ${closeSide.toUpperCase()} @ ${position.targetPrice} for qty ${quantity}`);
        return order;
    } catch (error) {
        if (isDuplicateClientOrderIdError(error)) {
            console.warn(`[TP] Duplicate clientOrderId ${clientOrderId}. Attempting to cancel existing order and retry.`);
            const duplicateOrder = await findOpenOrderByClientOrderId(clientOrderId, db.pair);
            if (duplicateOrder) {
                console.log(`[TP] Duplicate resolved by existing exchange TP ${clientOrderId}.`);
                return duplicateOrder;
            }
            const cancelled = await cancelOrderByClientOrderId(clientOrderId, db.pair);
            if (cancelled) {
                try {
                    const retryOrder = await exchange.createOrder(
                        db.pair,
                        "limit",
                        closeSide,
                        quantity,
                        position.targetPrice,
                        params
                    );
                    metrics.api.orders++;
                    console.log(`[TP] Retry succeeded: placed reduce-only TP ${closeSide.toUpperCase()} @ ${position.targetPrice} for qty ${quantity}`);
                    return retryOrder;
                } catch (retryError) {
                    console.error(`[TP] Retry failed for ${clientOrderId}: ${retryError.message}`);
                    await syncPositionWithExchange();
                    return null;
                }
            } else {
                const replacementClientOrderId = buildReplacementClientOrderId(clientOrderId);
                console.warn(`[TP] Existing clientOrderId ${clientOrderId} is unusable. Retrying with replacement ${replacementClientOrderId}.`);
                try {
                    const retryOrder = await exchange.createOrder(
                        db.pair,
                        "limit",
                        closeSide,
                        quantity,
                        position.targetPrice,
                        { ...params, newClientOrderId: replacementClientOrderId }
                    );
                    metrics.api.orders++;
                    console.log(`[TP] Replacement succeeded with clientOrderId ${replacementClientOrderId}.`);
                    return retryOrder;
                } catch (replacementError) {
                    console.error(`[TP] Replacement retry failed for ${replacementClientOrderId}: ${replacementError.message}`);
                    await syncPositionWithExchange();
                    return null;
                }
            }
        }
        throw error;
    }
};

const placeReduceOnlyStopLossOrder = async (position) => {
    if (!Number.isFinite(position?.stopLossPrice) || position.stopLossPrice <= 0) return null;
    if (!Number.isFinite(position?.quantity) || position.quantity <= 0) return null;
    const closeSide = position.side === "buy" ? "sell" : "buy";
    const quantity = formatAmountToMarketPrecision(db.pair, position.quantity);
    const market = exchange.markets[db.pair];
    const sizeValidation = validateOrderSize(market, quantity, position.stopLossPrice);
    if (!sizeValidation.valid) {
        console.warn(`[SL] Skipping SL placement: ${sizeValidation.reason}`);
        return null;
    }

    const params = buildExchangeOrderParams({
        side: closeSide,
        reduceOnly: true,
        positionSide: getClosePositionSide(position)
    });
    const clientOrderId = position?.slClientOrderId || getSlClientOrderId(position);
    params.newClientOrderId = clientOrderId;
    params.stopPrice = formatPriceToMarketPrecision(db.pair, position.stopLossPrice);
    params.workingType = "MARK_PRICE";

    const existingOrder = await findOpenOrderByClientOrderId(clientOrderId, db.pair);
    if (existingOrder) {
        console.log(`[SL] Existing exchange order already active for ${clientOrderId}. Reusing it.`);
        return existingOrder;
    }

    try {
        const order = await exchange.createOrder(
            db.pair,
            "STOP_MARKET",
            closeSide,
            quantity,
            undefined,
            params
        );
        metrics.api.orders++;
        console.log(`[SL] Placed reduce-only STOP_MARKET ${closeSide.toUpperCase()} @ stop ${params.stopPrice} for qty ${quantity}`);
        return order;
    } catch (error) {
        if (isDuplicateClientOrderIdError(error)) {
            console.warn(`[SL] Duplicate clientOrderId ${clientOrderId}. Attempting to cancel existing order and retry.`);
            const duplicateOrder = await findOpenOrderByClientOrderId(clientOrderId, db.pair);
            if (duplicateOrder) {
                console.log(`[SL] Duplicate resolved by existing exchange SL ${clientOrderId}.`);
                return duplicateOrder;
            }
            const cancelled = await cancelOrderByClientOrderId(clientOrderId, db.pair);
            if (cancelled) {
                try {
                    const retryOrder = await exchange.createOrder(
                        db.pair,
                        "STOP_MARKET",
                        closeSide,
                        quantity,
                        undefined,
                        params
                    );
                    metrics.api.orders++;
                    console.log(`[SL] Retry succeeded: placed reduce-only STOP_MARKET ${closeSide.toUpperCase()} @ stop ${params.stopPrice} for qty ${quantity}`);
                    return retryOrder;
                } catch (retryError) {
                    console.error(`[SL] Retry failed for ${clientOrderId}: ${retryError.message}`);
                    await syncPositionWithExchange();
                    return null;
                }
            } else {
                const replacementClientOrderId = buildReplacementClientOrderId(clientOrderId);
                console.warn(`[SL] Existing clientOrderId ${clientOrderId} is unusable. Retrying with replacement ${replacementClientOrderId}.`);
                try {
                    const retryOrder = await exchange.createOrder(
                        db.pair,
                        "STOP_MARKET",
                        closeSide,
                        quantity,
                        undefined,
                        { ...params, newClientOrderId: replacementClientOrderId }
                    );
                    metrics.api.orders++;
                    console.log(`[SL] Replacement succeeded with clientOrderId ${replacementClientOrderId}.`);
                    return retryOrder;
                } catch (replacementError) {
                    console.error(`[SL] Replacement retry failed for ${replacementClientOrderId}: ${replacementError.message}`);
                    await syncPositionWithExchange();
                    return null;
                }
            }
        }
        throw error;
    }
};

// -------------------- Helper to cancel order by clientOrderId --------------------
const cancelOrderByClientOrderId = async (clientOrderId, symbol) => {
    const { regularOrders, triggerOrders } = await fetchOpenOrdersSnapshot(symbol);
    const order = regularOrders.find(o => getExchangeClientOrderId(o) === clientOrderId);
    if (order) {
        await exchange.cancelOrder(order.id, symbol);
        metrics.api.orders++;
        console.log(`[CANCEL] Cancelled order with clientOrderId ${clientOrderId}`);
        return true;
    }

    const triggerOrder = triggerOrders.find(o => getExchangeClientOrderId(o) === clientOrderId);
    if (triggerOrder) {
        await exchange.cancelOrder(triggerOrder.id, symbol, { trigger: true });
        metrics.api.orders++;
        console.log(`[CANCEL] Cancelled trigger order with clientOrderId ${clientOrderId}`);
        return true;
    }

    return false;
};

const normalizeSymbol = (symbol) => String(symbol || "").toUpperCase().trim();
const isHedgeModeEnabled = () => accountPositionMode.hedged === true;

const isLegacySinglePosition = (value) => value && typeof value === "object" && !Array.isArray(value) && ("entryPrice" in value || "quantity" in value || "side" in value);

const toPositionMapKey = (positionSide) => {
    const normalized = String(positionSide || "").toUpperCase();
    if (normalized === "LONG" || normalized === "SHORT" || normalized === "BOTH") return normalized;
    return normalized || "BOTH";
};

const getActivePositionsMap = (rawActivePosition = db?.activePosition) => {
    if (!rawActivePosition || typeof rawActivePosition !== "object") return {};
    if (isLegacySinglePosition(rawActivePosition)) {
        const rawPositionSide = String(rawActivePosition.positionSide || "").toUpperCase();
        const rawSide = String(rawActivePosition.side || "").toLowerCase();
        const fallbackSide = rawPositionSide || (rawSide === "buy" ? "LONG" : (rawSide === "sell" ? "SHORT" : "BOTH"));
        const key = toPositionMapKey(fallbackSide);
        return { [key]: rawActivePosition };
    }
    const map = {};
    Object.entries(rawActivePosition).forEach(([key, value]) => {
        if (value && typeof value === "object") map[toPositionMapKey(key)] = value;
    });
    return map;
};

const getActivePositionEntries = () => Object.entries(getActivePositionsMap());
const getActivePositionsList = () => Object.values(getActivePositionsMap());
const hasAnyActivePosition = () => getActivePositionEntries().length > 0;
const getActivePositionByKey = (key) => getActivePositionsMap()[toPositionMapKey(key)] || null;
const getPrimaryActivePosition = () => getActivePositionsList()[0] || null;

const setActivePositionsMap = (positionsMap) => {
    const entries = Object.entries(positionsMap || {}).filter(([, value]) => value && typeof value === "object");
    if (entries.length === 0) {
        db.activePosition = null;
        return;
    }
    db.activePosition = Object.fromEntries(entries);
};

const upsertActivePosition = (position) => {
    const map = getActivePositionsMap();
    const key = toPositionMapKey(position?.positionSide || getTrackedPositionSideLabel(position));
    map[key] = position;
    setActivePositionsMap(map);
};

const removeActivePositionByKey = (key) => {
    const map = getActivePositionsMap();
    delete map[toPositionMapKey(key)];
    setActivePositionsMap(map);
};

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
    const orderClientId = getExchangeClientOrderId(order);
    if (!orderClientId) return false;
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
    const normalizedExpected = formatPriceToMarketPrecision(db?.pair, expectedPrice);
    const normalizedActual = formatPriceToMarketPrecision(db?.pair, actualPrice);
    if (Number.isFinite(normalizedExpected) && Number.isFinite(normalizedActual)) {
        return normalizedExpected === normalizedActual;
    }
    if (!Number.isFinite(expectedPrice) || !Number.isFinite(actualPrice)) return false;
    const tolerance = Math.max(1e-8, Math.abs(expectedPrice) * 0.000001);
    return Math.abs(expectedPrice - actualPrice) <= tolerance;
};

const matchesTrackedPositionSide = (position, trackedPosition) => {
    if (!isHedgeModeEnabled()) return true;
    const targetSide = getTrackedPositionSideLabel(trackedPosition);
    const candidateSide = getTrackedPositionSideLabel(position);
    if (!targetSide || targetSide === "BOTH") return true;
    return candidateSide === targetSide;
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

const findOpenExchangePosition = (positions, pair, trackedPosition = null) => {
    const normalizedPair = normalizeSymbol(pair);
    const openPositions = positions.filter((position) => (
        normalizeSymbol(position.symbol) === normalizedPair &&
        Math.abs(getExchangePositionContracts(position)) > 0
    ));
    if (openPositions.length === 0) return null;
    if (trackedPosition) {
        return openPositions.find((position) => matchesTrackedPositionSide(position, trackedPosition)) || null;
    }
    if (isHedgeModeEnabled() && openPositions.length > 1) {
        console.warn("[WARN] Multiple hedge positions detected on the same symbol. Bot will track the first open side only.");
    }
    return openPositions[0];
};

const buildSyncedActivePosition = (openPosition, entryPrice, existingPosition = null) => {
    const contracts = Math.abs(getExchangePositionContracts(openPosition));
    const side = getExchangePositionSide(openPosition) || "buy";
    const positionSide = getExchangePositionModeSide(openPosition);
    const preservedStrategy = existingPosition?.strategy || "SYNC_ONLY";
    const preservedTrailingEnabled = existingPosition?.trailingEnabled ?? Boolean(db.trailingEnabled);
    const preservedTrailingActivateATR = existingPosition?.trailingActivateATR ?? toFiniteNumber(db.trailingActivateATR, 1.2);
    const preservedTrailingOffsetATR = existingPosition?.trailingOffsetATR ?? toFiniteNumber(db.trailingOffsetATR, 0.6);
    const preservedEntryTime = Number.isFinite(existingPosition?.entryTime) ? existingPosition.entryTime : Date.now() - 300000;
    const preservedHighestSinceEntry = Number.isFinite(existingPosition?.highestSinceEntry) ? existingPosition.highestSinceEntry : entryPrice;
    const preservedLowestSinceEntry = Number.isFinite(existingPosition?.lowestSinceEntry) ? existingPosition.lowestSinceEntry : entryPrice;
    const targetPrice = side === "buy"
        ? formatPriceToMarketPrecision(db.pair, entryPrice + (db.gridTargetProfitUsdt / Math.max(contracts, 1e-8)))
        : formatPriceToMarketPrecision(db.pair, entryPrice - (db.gridTargetProfitUsdt / Math.max(contracts, 1e-8)));
    const stopLossPrice = side === "buy"
        ? formatPriceToMarketPrecision(db.pair, entryPrice - (Math.abs(db.gridOrderSizeUsdt * (db.gridStopLossPercent / 100)) / Math.max(contracts, 1e-8)))
        : formatPriceToMarketPrecision(db.pair, entryPrice + (Math.abs(db.gridOrderSizeUsdt * (db.gridStopLossPercent / 100)) / Math.max(contracts, 1e-8)));
    const preservedTargetPrice = Number.isFinite(existingPosition?.targetPrice) ? existingPosition.targetPrice : targetPrice;
    const preservedStopLossPrice = Number.isFinite(existingPosition?.stopLossPrice) ? existingPosition.stopLossPrice : stopLossPrice;
    const preservedTargetProfitUSDT = Number.isFinite(existingPosition?.targetProfitUSDT) ? existingPosition.targetProfitUSDT : db.gridTargetProfitUsdt;
    const preservedStopLossUSDT = Number.isFinite(existingPosition?.stopLossUSDT) ? existingPosition.stopLossUSDT : -db.gridOrderSizeUsdt * (db.gridStopLossPercent / 100);
    return {
        side, entryPrice, targetPrice: preservedTargetPrice, stopLossPrice: preservedStopLossPrice,
        stopLossUSDT: preservedStopLossUSDT,
        orderId: `SYNC_${Date.now()}`, quantity: contracts,
        entryTime: preservedEntryTime, highestSinceEntry: preservedHighestSinceEntry, lowestSinceEntry: preservedLowestSinceEntry,
        marginMode: (db.marginMode || "isolated").toLowerCase(),
        positionSide,
        targetProfitUSDT: preservedTargetProfitUSDT,
        leverageAtEntry: toFiniteNumber(db.leverage, 1),
        trailingEnabled: preservedTrailingEnabled,
        trailingActivateATR: preservedTrailingActivateATR,
        trailingOffsetATR: preservedTrailingOffsetATR,
        strategy: preservedStrategy,
        tpOrderId: null, tpClientOrderId: null, slOrderId: null, slClientOrderId: null
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
    const quantityChanged = Math.abs(currentQuantity - nextQuantity) > POSITION_SYNC_QTY_TOLERANCE;
    const entryDeltaPercent = currentEntry > 0 ? Math.abs((currentEntry - nextEntry) / currentEntry) * 100 : 100;
    const entryChanged = entryDeltaPercent > POSITION_SYNC_ENTRY_TOLERANCE_PCT;
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
    const quantityChanged = Math.abs(currentQuantity - nextQuantity) > POSITION_SYNC_QTY_TOLERANCE;
    const entryDeltaPercent = currentEntry > 0 ? Math.abs((currentEntry - nextEntry) / currentEntry) * 100 : 100;
    return (
        currentSide === nextSide &&
        getTrackedPositionSideLabel(currentPosition) === getTrackedPositionSideLabel(nextPosition) &&
        !quantityChanged &&
        entryDeltaPercent <= POSITION_SYNC_ENTRY_TOLERANCE_PCT
    );
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

const calculatePositionPnL = (position, currentPrice) => {
    const entryValue = position.entryPrice * position.quantity;
    const exitValue = currentPrice * position.quantity;
    const leverageAtEntry = Math.max(1, toFiniteNumber(position?.leverageAtEntry, db.leverage));
    
    const entryFee = entryValue * TAKER_FEE_RATE;
    const exitFee = exitValue * TAKER_FEE_RATE;
    const totalEstimatedFee = entryFee + exitFee;

    const grossProfitUSDT = position.side === "buy"
        ? (currentPrice - position.entryPrice) * position.quantity
        : (position.entryPrice - currentPrice) * position.quantity;
    
    const netProfitUSDT = grossProfitUSDT - totalEstimatedFee;
    const profitPercent = (netProfitUSDT / (entryValue / leverageAtEntry)) * 100;

    return { grossProfitUSDT, netProfitUSDT, profitPercent, totalEstimatedFee };
};

const getPositionExitTargets = (position) => {
    const effectiveTargetProfitUSDT = Number.isFinite(position.targetProfitUSDT) && position.targetProfitUSDT > 0
        ? position.targetProfitUSDT
        : db.gridTargetProfitUsdt;
    const fallbackStopLossUSDT = -Math.abs(db.gridOrderSizeUsdt * (db.gridStopLossPercent / 100));
    const rawStopLossUSDT = Number.isFinite(position.stopLossUSDT) ? position.stopLossUSDT : fallbackStopLossUSDT;
    const effectiveStopLossUSDT = -Math.abs(rawStopLossUSDT);

    let effectiveStopLossPrice = toFiniteNumber(position.stopLossPrice, NaN);
    if (!Number.isFinite(effectiveStopLossPrice) || effectiveStopLossPrice <= 0) {
        const entryPrice = toFiniteNumber(position.entryPrice, NaN);
        const quantity = toFiniteNumber(position.quantity, NaN);
        if (Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(quantity) && quantity > 0 && Number.isFinite(effectiveStopLossUSDT)) {
            const derivedStopLossPrice = position.side === "buy"
                ? entryPrice + (effectiveStopLossUSDT / quantity)
                : entryPrice - (effectiveStopLossUSDT / quantity);
            effectiveStopLossPrice = formatPriceToMarketPrecision(db.pair, derivedStopLossPrice);
        } else {
            effectiveStopLossPrice = NaN;
        }
    }
    return { effectiveTargetProfitUSDT, effectiveStopLossUSDT, effectiveStopLossPrice };
};

const evaluatePositionExit = (position, currentPrice, pnlState, managedOrdersSnapshot = null) => {
    const { effectiveTargetProfitUSDT, effectiveStopLossUSDT, effectiveStopLossPrice } = getPositionExitTargets(position);
    const tpOrders = Array.isArray(managedOrdersSnapshot?.tp) ? managedOrdersSnapshot.tp : null;
    const slOrders = Array.isArray(managedOrdersSnapshot?.sl) ? managedOrdersSnapshot.sl : null;
    const hasExchangeTpOrder = tpOrders
        ? tpOrders.some((order) => matchesOrderToTrackedPosition(order, position))
        : Boolean(position?.tpOrderId || position?.tpClientOrderId);
    const hasExchangeSlOrder = slOrders
        ? slOrders.some((order) => matchesOrderToTrackedPosition(order, position))
        : Boolean(position?.slOrderId || position?.slClientOrderId);
    
    const targetHit = Number.isFinite(position.targetPrice) &&
        (position.side === "buy" ? currentPrice >= position.targetPrice : currentPrice <= position.targetPrice);
    
    const stopHit = Number.isFinite(effectiveStopLossPrice) &&
        (position.side === "buy" ? currentPrice <= effectiveStopLossPrice : currentPrice >= effectiveStopLossPrice);

    if (!hasExchangeTpOrder && (targetHit || pnlState.netProfitUSDT >= effectiveTargetProfitUSDT)) {
        return {
            shouldClose: true,
            reason: "PROFIT_TARGET",
            message: `\n[PROFIT] Net Target hit (+${pnlState.netProfitUSDT.toFixed(4)} USDT)! Closing...`,
            effectiveTargetProfitUSDT,
            effectiveStopLossUSDT
        };
    }

    if (!hasExchangeSlOrder && (stopHit || pnlState.netProfitUSDT <= effectiveStopLossUSDT)) {
        return {
            shouldClose: true,
            reason: "STOP_LOSS",
            message: `\n[STOP] Stop loss hit (${pnlState.netProfitUSDT.toFixed(4)} USDT)! Closing...`,
            effectiveTargetProfitUSDT,
            effectiveStopLossUSDT
        };
    }

    return {
        shouldClose: false,
        effectiveTargetProfitUSDT,
        effectiveStopLossUSDT
    };
};

const maybeLogPositionPnL = (pnlState, exitState) => {
    const nearExit =
        pnlState.netProfitUSDT >= (exitState.effectiveTargetProfitUSDT * 0.7) ||
        pnlState.netProfitUSDT <= (exitState.effectiveStopLossUSDT * 0.7);
    const pnlLogInterval = nearExit ? 2000 : 5000;

    if (Date.now() - lastPnlLog > pnlLogInterval) {
        console.log(`\n[PNL] Gross: ${pnlState.grossProfitUSDT.toFixed(4)} | Fee: ${pnlState.totalEstimatedFee.toFixed(4)} | NET: ${pnlState.netProfitUSDT.toFixed(4)} USDT (${pnlState.profitPercent.toFixed(2)}%)`);
        lastPnlLog = Date.now();
    }
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
    console.log(`[STATUS] Profile=${gridSummary.presetName.toUpperCase()} | Grid Slot=${gridSummary.slotLabel} | Ladder=${gridSummary.ladderLabel}`);
    console.log(`[STATUS] Daily P&L=${db.dailyPnL.toFixed(2)} USDT | Trades=${db.dailyTrades}`);
    console.log(`[STATUS] Runtime | placing=${isPlacingOrder ? "Y" : "N"} closing=${isClosingPosition ? "Y" : "N"} posSync=${isSyncingPosition ? "Y" : "N"} gridSync=${isSyncingGridOrders ? "Y" : "N"}`);
    console.log(`[STATUS] Last trade=${lastTradeAt > 0 ? new Date(lastTradeAt).toISOString() : "N/A"} | Daily reset=${new Date(toFiniteNumber(db.lastDailyReset, Date.now())).toISOString()}`);
    console.log(`[STATUS] Open Orders | Grid=${managedOrders.grid.length} | TP=${managedOrders.tp.length} | SL=${managedOrders.sl.length}`);
    if (gridSummary.hasLockedGrid) {
        console.log(`[STATUS] Locked Grid=${gridSummary.lockedRangeLabel} | Step=${gridSummary.stepLabel}`);
    }
    if (openExchangePositions.length !== activeEntries.length) {
        console.warn(`[STATUS] Position mismatch detected: local=${activeEntries.length} vs exchange=${openExchangePositions.length}`);
    }
    managedOrders.grid.slice(0, 4).forEach((order) => console.log(`   ${formatOrderSummary(order, "GRID")}`));
    managedOrders.tp.slice(0, 4).forEach((order) => console.log(`   ${formatOrderSummary(order, "TP")}`));
    managedOrders.sl.slice(0, 4).forEach((order) => console.log(`   ${formatOrderSummary(order, "SL")}`));
    if (activeEntries.length === 0) {
        console.log("[STATUS] No active positions.");
        return;
    }
    activeEntries.forEach(([positionKey, position]) => {
        const pnlState = Number.isFinite(currentPrice) ? calculatePositionPnL(position, currentPrice) : null;
        console.log(`   [${positionKey}] side=${String(position.side || "").toUpperCase()} qty=${position.quantity} entry=${position.entryPrice}`);
        console.log(`   [${positionKey}] tp=${position.targetPrice ?? "N/A"} sl=${position.stopLossPrice ?? "N/A"} strategy=${position.strategy || "N/A"}`);
        console.log(`   [${positionKey}] tpOrder=${position.tpClientOrderId ?? "N/A"} slOrder=${position.slClientOrderId ?? "N/A"}`);
        if (pnlState) console.log(`   [${positionKey}] unrealized=${pnlState.netProfitUSDT.toFixed(4)} USDT (${pnlState.profitPercent.toFixed(2)}%)`);
    });
};

const resetActivePosition = async () => {
    setActivePositionsMap({});
    await saveDB();
};

const finalizeClosedPosition = async (position, netProfitUSDT, profitPercent, reason, exitPrice = null, positionKey = null) => {
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
    console.log(`   Net P&L: ${netProfitUSDT.toFixed(4)} USDT (${profitPercent.toFixed(2)}%)`);
    console.log(`   Daily Total Net P&L: ${db.dailyPnL.toFixed(4)} USDT / ${db.dailyTrades} trades`);

    removeActivePositionByKey(positionKey || position?.positionSide || getTrackedPositionSideLabel(position));
    await saveDB();
    metrics.trades.closed++;
    if (netProfitUSDT > 0) metrics.trades.wins++;
    else if (netProfitUSDT < 0) metrics.trades.losses++;
};

const mergeRuntimeConfig = (nextConfig) => {
    const currentPositionsMap = getActivePositionsMap(db.activePosition);
    const nextPositionsMap = getActivePositionsMap(nextConfig.activePosition);
    const hasActiveTradeState = Object.keys(currentPositionsMap).length > 0;

    if (Object.keys(currentPositionsMap).length > 0 && Object.keys(nextPositionsMap).length === 0) {
        nextConfig.activePosition = currentPositionsMap;
    } else {
        Object.entries(currentPositionsMap).forEach(([key, currentPosition]) => {
            const nextPosition = nextPositionsMap[key];
            if (!nextPosition) nextPositionsMap[key] = currentPosition;
            else if (isSameTrackedPosition(currentPosition, nextPosition)) nextPositionsMap[key] = { ...nextPosition, ...currentPosition };
        });
        nextConfig.activePosition = Object.keys(nextPositionsMap).length > 0 ? nextPositionsMap : null;
    }

    if (hasActiveTradeState) {
        const protectedKeys = ["pair", "leverage", "marginMode", "gridTimeframe", "strategy"];
        protectedKeys.forEach((key) => {
            if (nextConfig[key] !== db[key]) {
                console.warn(`[WARN] Preserving runtime ${key}=${db[key]} while positions are active.`);
                nextConfig[key] = db[key];
            }
        });
    }

    if (db.dailyTrades > nextConfig.dailyTrades) {
        nextConfig.dailyPnL = db.dailyPnL;
        nextConfig.dailyTrades = db.dailyTrades;
    }

    Object.keys(nextConfig).forEach((key) => { db[key] = nextConfig[key]; });
};

const configureRecurringTask = (currentTimer, currentInterval, desiredInterval, label, callback, assignTimer, assignInterval) => {
    if (currentTimer && currentInterval === desiredInterval) return currentTimer;
    if (currentTimer) { clearInterval(currentTimer); assignTimer(null); }
    assignInterval(desiredInterval);
    console.log(`${label}${desiredInterval}ms`);
    const nextTimer = setInterval(callback, desiredInterval);
    assignTimer(nextTimer);
    return nextTimer;
};

const isNewTradingDay = (timestamp) => {
    const currentTime = toFiniteNumber(timestamp, NaN);
    if (!Number.isFinite(currentTime)) return false;
    const lastResetTime = toFiniteNumber(db.lastDailyReset, NaN);
    const todayUTC = new Date(currentTime).toISOString().split('T')[0];
    const lastResetUTC = Number.isFinite(lastResetTime)
        ? new Date(lastResetTime).toISOString().split('T')[0]
        : "";
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

const refreshRuntimeSchedulers = () => { startPnLMonitoring(); startPositionSync(); };

const handleRuntimeCommand = async (input) => {
    const cmd = input.toString().trim().toLowerCase();
    if (cmd === "sync") { await syncPositionWithExchange(); return; }
    if (cmd === "status") {
        try { await printDetailedStatus(); }
        catch (error) { console.error("[ERROR] Failed to print status:", error.message); }
    }
};

const registerRuntimeCommands = () => {
    if (!process.stdin.isTTY) return;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", handleRuntimeCommand);
};

const bootstrapRuntime = async () => {
    await initializeExchange();
    await detectPositionMode();
    await setMarginMode();
    await syncPositionWithExchange();
    startPnLMonitoring();
    startPositionSync();
    startMetricsReporting();
    process.once("SIGINT", () => { shutdown("SIGINT"); });
    process.once("SIGTERM", () => { shutdown("SIGTERM"); });
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

const AUTO_PAIR_GRID_PRESETS = {
    binance: {
        strategy: "futures_grid",
        marginMode: "isolated",
        leverage: 10,
        gridLevels: 10,
        gridLookbackCandles: 144,
        gridRangePercent: 4.0,
        gridEntryBufferPercent: 0.12,
        gridTakeProfitLevels: 1,
        gridOrdersPerSide: 3,
        gridStopLossLevels: 1.5,
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
        marginMode: "isolated",
        leverage: 8,
        gridLevels: 12,
        gridLookbackCandles: 180,
        gridRangePercent: 6.5,
        gridEntryBufferPercent: 0.18,
        gridTakeProfitLevels: 1,
        gridOrdersPerSide: 4,
        gridStopLossLevels: 2.0,
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
        marginMode: "isolated",
        leverage: 8,
        gridLevels: 12,
        gridLookbackCandles: 180,
        gridRangePercent: 5.5,
        gridEntryBufferPercent: 0.16,
        gridTakeProfitLevels: 1,
        gridOrdersPerSide: 4,
        gridStopLossLevels: 1.8,
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

    return {
        presetName,
        hasLockedGrid,
        lockedRangeLabel: hasLockedGrid ? `${lowerBound.toFixed(6)} - ${upperBound.toFixed(6)}` : "N/A",
        stepLabel: hasLockedGrid ? step.toFixed(6) : "N/A",
        slotLabel,
        ladderLabel: `${buyOrders} buy / ${sellOrders} sell`
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
        gridOrderSizeUsdt: { min: 0, allowZero: false }, leverage: { min: 0, allowZero: false, integer: true },
        gridTargetProfitUsdt: { min: 0, allowZero: false }, dailyProfitTargetUsdt: { min: 0, allowZero: false },
        dailyMaxLossPercent: { min: 0, allowZero: false }, maxTradesPerDay: { min: 0, allowZero: false, integer: true },
        coolingPeriod: { min: 0, allowZero: true, integer: true }, monitoringInterval: { min: 200, allowZero: false, integer: true },
        gridStopLossPercent: { min: 0, allowZero: false }, gridLevels: { min: 4, allowZero: false, integer: true },
        gridLookbackCandles: { min: 20, allowZero: false, integer: true }, gridRangePercent: { min: 0.5, allowZero: false },
        gridEntryBufferPercent: { min: 0.02, allowZero: false }, gridTakeProfitLevels: { min: 1, allowZero: false, integer: true },
        gridOrdersPerSide: { min: 1, allowZero: false, integer: true },
        gridStopLossLevels: { min: 0.5, allowZero: false }, sessionStartUTC: { min: 0, allowZero: true, integer: true },
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
    normalized.sessionStartUTC = clamp(Math.trunc(toFiniteNumber(normalized.sessionStartUTC, defaults.sessionStartUTC)), 0, 23);
    normalized.sessionEndUTC = clamp(Math.trunc(toFiniteNumber(normalized.sessionEndUTC, defaults.sessionEndUTC)), 0, 23);
    normalized.gridTakeProfitLevels = clamp(normalized.gridTakeProfitLevels, 1, Math.max(1, normalized.gridLevels - 1));
    normalized.gridOrdersPerSide = clamp(normalized.gridOrdersPerSide, 1, Math.max(1, normalized.gridLevels - 1));

    return normalized;
};

// -------------------- INITIALIZE DATABASE --------------------
const initializeDB = async () => {
    try {
        await ensureConfigSchema();
        console.log("[OK] Database synced");
        const configRow = await ensureConfigRow();
        const persisted = configRow.toJSON();
        let hydrated = hydrateConfig(persisted);
        const autoPresetResult = applyAutoPairGridPreset(hydrated);
        hydrated = normalizeConfig(autoPresetResult.config);
        db = hydrated;
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

// -------------------- RELOAD CONFIG FROM DB --------------------
const reloadConfig = async () => {
    try {
        if (!db) return false;
        let normalizedConfig = await loadPersistedConfig();
        if (!normalizedConfig) return false;
        const autoPresetResult = applyAutoPairGridPreset(normalizedConfig);
        normalizedConfig = normalizeConfig(autoPresetResult.config);
        mergeRuntimeConfig(normalizedConfig);
        if (autoPresetResult.changed && !hasAnyActivePosition()) {
            await saveDB();
            console.log(`[PRESET] Auto-refreshed ${autoPresetResult.presetName} profile for ${db.pair}`);
        }
        return true;
    } catch (error) { console.error("[ERROR] Failed to reload config:", error.message); return false; }
};

// -------------------- SAVE DB TO DATABASE --------------------
const saveDB = async () => {
    try { if (!db) return; await persistConfig(db); }
    catch (error) { console.error("[ERROR] Failed to save DB:", error.message); }
};

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
            const syncedPosition = buildSyncedActivePosition(openPosition, entryPrice, existingPosition);
            nextPositionsMap[toPositionMapKey(syncedPosition.positionSide)] = syncedPosition;
        });
        const currentKeys = Object.keys(currentPositionsMap).sort().join(",");
        const nextKeys = Object.keys(nextPositionsMap).sort().join(",");
        let shouldPersist = currentKeys !== nextKeys;

        if (!shouldPersist) {
            shouldPersist = Object.keys(nextPositionsMap).some((key) => shouldRefreshSyncedPosition(currentPositionsMap[key], nextPositionsMap[key]));
        }

        if (!shouldPersist) {
            for (const [positionKey, currentPosition] of Object.entries(currentPositionsMap)) {
                await ensureReduceOnlyTakeProfitOrder(positionKey, currentPosition);
                await ensureReduceOnlyStopLossOrder(positionKey, currentPosition);
            }
            return;
        }

        const removedPositions = Object.entries(currentPositionsMap)
            .filter(([key]) => !nextPositionsMap[key]);
        for (const [removedKey, removedPosition] of removedPositions) {
            if (Number.isFinite(currentPrice) && currentPrice > 0) {
                const pnlState = calculatePositionPnL(removedPosition, currentPrice);
                await finalizeClosedPosition(
                    removedPosition,
                    pnlState.netProfitUSDT,
                    pnlState.profitPercent,
                    "POSITION_SYNC_REMOVED",
                    currentPrice,
                    removedKey
                );
            } else {
                await cancelManagedOrdersForPosition(removedPosition, "POSITION_SYNC_REMOVED");
            }
        }

        setActivePositionsMap(nextPositionsMap);
        await saveDB();
        if (Object.keys(nextPositionsMap).length === 0) console.log("[OK] Cleared local active positions from exchange state");
        else console.log(`[OK] Synced active positions: ${Object.keys(nextPositionsMap).join(", ")}`);

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
        exchange = new ccxt.binanceusdm({
            apiKey: process.env.API_KEY,
            secret: process.env.API_SECRET,
            options: { defaultType: "future" },
            enableRateLimit: true,
            timeout: 20000
        });
        await exchange.loadMarkets();
        console.log("[OK] Exchange connected");
        return exchange;
    } catch (error) { 
        console.error("[ERROR] Exchange connection failed:", error.message); 
        throw error; 
    }
};

const detectPositionMode = async () => {
    try {
        const result = await exchange.fetchPositionMode(db?.pair, { subType: "linear" });
        const hedged = result?.hedged === true;
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

        let openGridOrders = await fetchOpenGridOrders();
        openGridOrders = await cancelDuplicateManagedOrders(openGridOrders, "GRID_DUPLICATE", "GRID");

        const openPositions = await fetchOpenExchangePositions();
        if (openPositions.length > 0 || hasAnyActivePosition()) {
            if (openGridOrders.length > 0) await cancelGridOrders(openGridOrders, "ACTIVE_POSITION");
            return;
        }

        const lockedGridState = await resolveActiveGridState(snapshot, params);
        if (!lockedGridState) {
            console.log("[GRID] Unable to resolve locked grid state. Ladder sync skipped.");
            return;
        }

        const desiredOrdersRaw = buildGridEntryOrders(snapshot, params, lockedGridState);
        const desiredOrderMap = new Map();
        const duplicateDesiredOrders = [];
        for (const order of desiredOrdersRaw) {
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

const syncManagedReduceOnlyOrder = async ({
    positionKey,
    position,
    matchingOrders,
    matchingOrder,
    priceKey,
    orderIdKey,
    clientIdKey,
    label,
    syncPrice,
    placeReplacement,
    buildClientOrderId,
    cancelDuplicates,
    cancelReason,
    syncLogPrefix,
    attachLogPrefix
}) => {
    if (matchingOrder) {
        if (matchingOrders.length > 1) {
            const duplicateOrders = matchingOrders.filter((order) => order !== matchingOrder);
            if (duplicateOrders.length > 0) await cancelDuplicates(duplicateOrders, cancelReason);
        }

        const nextClientOrderId = getExchangeClientOrderId(matchingOrder) || position[clientIdKey] || buildClientOrderId(position);
        const nextOrderId = matchingOrder.id || position[orderIdKey] || null;
        const nextPrice = syncPrice(matchingOrder);

        if (position[orderIdKey] !== nextOrderId || position[clientIdKey] !== nextClientOrderId || position[priceKey] !== nextPrice) {
            console.log(`${syncLogPrefix} Synced existing ${label} order for ${positionKey} @ ${nextPrice}`);
            position[orderIdKey] = nextOrderId;
            position[clientIdKey] = nextClientOrderId;
            position[priceKey] = nextPrice;
            upsertActivePosition(position);
            await saveDB();
        }
        return;
    }

    if (matchingOrders.length > 0) {
        console.log(`${syncLogPrefix} Existing ${label} order for ${positionKey} no longer matches target. Replacing...`);
        await cancelDuplicates(matchingOrders, cancelReason.replace("_DUPLICATE", "_REPLACE"));
    } else {
        console.log(`${syncLogPrefix} No exchange ${label} found for ${positionKey}. Creating replacement...`);
    }

    const placedOrder = await placeReplacement(position);
    if (!placedOrder) return;
    position[orderIdKey] = placedOrder.id || null;
    position[clientIdKey] = getExchangeClientOrderId(placedOrder) || buildClientOrderId(position);
    upsertActivePosition(position);
    await saveDB();
    console.log(`${attachLogPrefix} Attached exchange ${label} to ${positionKey}`);
};

const ensureReduceOnlyTakeProfitOrder = async (positionKey, sourcePosition) => {
    const position = { ...sourcePosition };
    if (!position || !Number.isFinite(position.targetPrice) || position.targetPrice <= 0) return;
    const openTpOrders = await fetchOpenTpOrders();
    const matchingTpOrders = openTpOrders.filter((order) => matchesOrderToTrackedPosition(order, position));
    const matchingOrder = matchingTpOrders.find((order) => {
        const orderPrice = toFiniteNumber(order.price, NaN);
        const orderAmount = getOrderQuantity(order);
        return isManagedOrderPriceMatch(position.targetPrice, orderPrice) && Math.abs(orderAmount - position.quantity) <= POSITION_SYNC_QTY_TOLERANCE;
    });
    return syncManagedReduceOnlyOrder({
        positionKey,
        position,
        matchingOrders: matchingTpOrders,
        matchingOrder,
        priceKey: "targetPrice",
        orderIdKey: "tpOrderId",
        clientIdKey: "tpClientOrderId",
        label: "TP",
        syncPrice: (order) => toFiniteNumber(order.price, position.targetPrice),
        placeReplacement: placeReduceOnlyTakeProfitOrder,
        buildClientOrderId: getTpClientOrderId,
        cancelDuplicates: cancelTpOrders,
        cancelReason: "TP_DUPLICATE",
        syncLogPrefix: "[TP]",
        attachLogPrefix: "[TP]"
    });
};

const ensureReduceOnlyStopLossOrder = async (positionKey, sourcePosition) => {
    const position = { ...sourcePosition };
    if (!position || !Number.isFinite(position.stopLossPrice) || position.stopLossPrice <= 0) return;
    const openSlOrders = await fetchOpenSlOrders();
    const matchingSlOrders = openSlOrders.filter((order) => matchesOrderToTrackedPosition(order, position));
    const matchingOrder = matchingSlOrders.find((order) => {
        const orderStopPrice = getOrderTriggerPrice(order);
        const orderAmount = getOrderQuantity(order);
        return isManagedOrderPriceMatch(position.stopLossPrice, orderStopPrice) && Math.abs(orderAmount - position.quantity) <= POSITION_SYNC_QTY_TOLERANCE;
    });
    return syncManagedReduceOnlyOrder({
        positionKey,
        position,
        matchingOrders: matchingSlOrders,
        matchingOrder,
        priceKey: "stopLossPrice",
        orderIdKey: "slOrderId",
        clientIdKey: "slClientOrderId",
        label: "SL",
        syncPrice: getOrderTriggerPrice,
        placeReplacement: placeReduceOnlyStopLossOrder,
        buildClientOrderId: getSlClientOrderId,
        cancelDuplicates: cancelSlOrders,
        cancelReason: "SL_DUPLICATE",
        syncLogPrefix: "[SL]",
        attachLogPrefix: "[SL]"
    });
};

// -------------------- PLACE ORDER --------------------
const placeOrder = async (side, signalData = {}) => {
    try {
        if (!db || isPlacingOrder || isClosingPosition) return;
        const targetPositionKey = getOrderPositionSide(side);
        if (getActivePositionByKey(targetPositionKey)) return;
        isPlacingOrder = true;
        console.log(`\n[ORDER] Attempting to place ${side.toUpperCase()} order...`);
        await setMarginMode();
        const openExchangePositions = await fetchOpenExchangePositions();
        const conflictingExchangePosition = isHedgeModeEnabled()
            ? openExchangePositions.find((position) => matchesTrackedPositionSide(position, { positionSide: targetPositionKey, side }))
            : openExchangePositions[0] || null;
        if (conflictingExchangePosition) {
            console.warn(`[WARN] Skipping ${side.toUpperCase()} order because an exchange position is already open for the same side.`);
            return;
        }
        const managedOrdersSnapshot = await fetchManagedOpenOrdersSnapshot();
        const managedOrderCount = managedOrdersSnapshot.grid.length + managedOrdersSnapshot.tp.length + managedOrdersSnapshot.sl.length;
        if (managedOrderCount > 0) {
            console.warn(`[WARN] Skipping ${side.toUpperCase()} order because ${managedOrderCount} managed order(s) are still open on the exchange.`);
            return;
        }
        await exchange.setLeverage(db.leverage, db.pair);

        const tickerPrice = await getPrice(true);
        if (!Number.isFinite(tickerPrice) || tickerPrice <= 0) { console.error("[ERROR] Invalid ticker price. Order skipped."); return; }

        const { signalPrice, signalATR, strategyName, riskOverrides, signalTargetPrice, signalStopLossPrice } = parseSignalOrderData(signalData);
        const hasSignalPrice = Number(signalPrice) > 0;
        const entryPrice = hasSignalPrice ? Number(signalPrice) : tickerPrice;
        const qty = (db.gridOrderSizeUsdt * db.leverage) / entryPrice;
        const market = exchange.markets[db.pair];
        const adjustedQty = formatAmountToMarketPrecision(db.pair, qty);
        const sizeValidation = validateOrderSize(market, adjustedQty, tickerPrice);
        if (!sizeValidation.valid) { console.error(sizeValidation.reason); return; }

        const orderPlan = buildOrderPlan(
            side,
            entryPrice,
            adjustedQty,
            signalATR,
            riskOverrides,
            { targetPrice: signalTargetPrice, stopLossPrice: signalStopLossPrice }
        );
        logOrderPlan(strategyName, entryPrice, adjustedQty, orderPlan);
        if (!isDirectionalOrderPlanValid(side, entryPrice, orderPlan)) {
            console.warn(`[WARN] Skipping ${side.toUpperCase()} order because TP/SL plan is not directional after rounding.`);
            return;
        }

        const order = await exchange.createOrder(
            db.pair,
            "market",
            side,
            adjustedQty,
            undefined,
            buildExchangeOrderParams({ side, positionSide: getOrderPositionSide(side) })
        );
        metrics.api.orders++;

        const fillSnapshot = getOrderFillSnapshot(order, tickerPrice, adjustedQty);
        const actualEntryPrice = fillSnapshot.price;
        const actualQuantity = fillSnapshot.quantity;
        const actualOrderPlan = buildOrderPlan(
            side,
            actualEntryPrice,
            actualQuantity,
            signalATR,
            riskOverrides,
            { targetPrice: signalTargetPrice, stopLossPrice: signalStopLossPrice }
        );
        const actualPlanValid = isDirectionalOrderPlanValid(side, actualEntryPrice, actualOrderPlan);
        const fallbackPlanValid = isDirectionalOrderPlanValid(side, actualEntryPrice, orderPlan);
        const closeSide = side === "buy" ? "sell" : "buy";
        let resolvedOrderPlan = actualPlanValid ? actualOrderPlan : (fallbackPlanValid ? orderPlan : null);
        if (!resolvedOrderPlan) {
            console.error(`[ERROR] Unable to derive a valid TP/SL plan after fill for ${side.toUpperCase()} order. Closing position to avoid unmanaged exposure.`);
            try {
                await exchange.createOrder(
                    db.pair,
                    "market",
                    closeSide,
                    actualQuantity,
                    undefined,
                    buildExchangeOrderParams({ side: closeSide, reduceOnly: true, positionSide: getOrderPositionSide(side) })
                );
                metrics.api.orders++;
            } catch (closeError) {
                console.error(`[ERROR] Failed to immediately close invalid ${side.toUpperCase()} position: ${closeError.message}`);
            }
            await syncPositionWithExchange();
            return;
        }
        if (!actualPlanValid) {
            console.warn(`[WARN] Actual fill produced an invalid directional TP/SL plan for ${side.toUpperCase()} order. Falling back to the pre-fill plan.`);
        }

        upsertActivePosition({
            side: side, entryPrice: actualEntryPrice, targetPrice: resolvedOrderPlan.targetPrice,
            stopLossPrice: resolvedOrderPlan.stopLossPrice, stopLossUSDT: resolvedOrderPlan.stopLossUSDT,
            orderId: order.id, quantity: actualQuantity, entryTime: Date.now(), highestSinceEntry: actualEntryPrice,
            lowestSinceEntry: actualEntryPrice, marginMode: (db.marginMode || "isolated").toLowerCase(),
            positionSide: getOrderPositionSide(side),
            targetProfitUSDT: resolvedOrderPlan.targetProfitUSDT, leverageAtEntry: toFiniteNumber(db.leverage, 1), trailingEnabled: resolvedOrderPlan.trailingEnabled, atrAtEntry: signalATR, strategy: strategyName,
            trailingActivateATR: resolvedOrderPlan.trailingActivateATR, trailingOffsetATR: resolvedOrderPlan.trailingOffsetATR,
            tpOrderId: null, tpClientOrderId: null, slOrderId: null, slClientOrderId: null
        });

        await saveDB();
        await ensureReduceOnlyTakeProfitOrder(targetPositionKey, getActivePositionByKey(targetPositionKey));
        await ensureReduceOnlyStopLossOrder(targetPositionKey, getActivePositionByKey(targetPositionKey));
        logTrade(side === "buy" ? "LONG" : "SHORT", actualEntryPrice, null, "OPEN", 0, strategyName);
        metrics.trades.opened++;
        console.log(`\n[OK] ORDER PLACED: ${side.toUpperCase()} at ${actualEntryPrice}`);
    } catch (error) { console.error("[ERROR] Order failed:", error.message); }
    finally { isPlacingOrder = false; }
};

// -------------------- CLOSE POSITION --------------------
const closePosition = async (positionKey, reason, netProfitUSDT, profitPercent) => {
    const closeLockKey = toPositionMapKey(positionKey);
    if (closingPositionKeys.has(closeLockKey)) return;
    closingPositionKeys.add(closeLockKey);
    try {
        if (!db || !hasAnyActivePosition() || isClosingPosition) return;
        isClosingPosition = true;
        const trackedPosition = getActivePositionByKey(positionKey);
        if (!trackedPosition) return;
        const position = { ...trackedPosition };
        const { side, quantity } = position;
        if (!Number.isFinite(quantity) || quantity <= 0) {
            console.error("[ERROR] Invalid position quantity. Removing local active position.");
            await cancelManagedOrdersForPosition(position, "INVALID_POSITION_QTY");
            removeActivePositionByKey(positionKey);
            await saveDB();
            return;
        }

        const currentPos = findOpenExchangePosition(await fetchOpenExchangePositions(), db.pair, position);
        if (!currentPos) {
            console.log("[INFO] No matching open position on exchange. Removing local active position.");
            const fallbackExitPrice = await getPrice(true);
            await cancelManagedOrdersForPosition(position, "POSITION_MISSING");
            if (Number.isFinite(fallbackExitPrice) && fallbackExitPrice > 0) {
                const realizedPnL = calculatePositionPnL(position, fallbackExitPrice);
                await finalizeClosedPosition(
                    position,
                    realizedPnL.netProfitUSDT,
                    realizedPnL.profitPercent,
                    "POSITION_MISSING",
                    fallbackExitPrice,
                    positionKey
                );
            } else {
                removeActivePositionByKey(positionKey);
                await saveDB();
            }
            return;
        }
        const actualQuantity = Math.abs(getExchangePositionContracts(currentPos));
        if (Math.abs(actualQuantity - quantity) > POSITION_SYNC_QTY_TOLERANCE) {
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
        const tpOrders = await fetchOpenTpOrders();
        const matchingTpOrders = tpOrders.filter((order) => matchesOrderToTrackedPosition(order, position));
        if (matchingTpOrders.length > 0) await cancelTpOrders(matchingTpOrders, "MANUAL_CLOSE");
        const slOrders = await fetchOpenSlOrders();
        const matchingSlOrders = slOrders.filter((order) => matchesOrderToTrackedPosition(order, position));
        if (matchingSlOrders.length > 0) await cancelSlOrders(matchingSlOrders, "MANUAL_CLOSE");

        let closeOrder;
        try {
            closeOrder = await exchange.createOrder(
                db.pair,
                "market",
                closeSide,
                position.quantity,
                undefined,
                buildExchangeOrderParams({ side: closeSide, reduceOnly: true, positionSide: getClosePositionSide(position) })
            );
            metrics.api.orders++;
        } catch (error) {
            if (error.code === -2022 || error.message.includes("ReduceOnly Order is rejected")) {
                console.warn("[WARN] Reduce-only order rejected. Syncing position with exchange...");
                const openPosition = findOpenExchangePosition(await fetchOpenExchangePositions(), db.pair, position);
                if (!openPosition) {
                    console.log("[INFO] No matching open position on exchange. Removing local active position.");
                    const fallbackExitPrice = await getPrice(true);
                    await cancelManagedOrdersForPosition(position, "POSITION_MISSING");
                    if (Number.isFinite(fallbackExitPrice) && fallbackExitPrice > 0) {
                        const realizedPnL = calculatePositionPnL(position, fallbackExitPrice);
                        await finalizeClosedPosition(
                            position,
                            realizedPnL.netProfitUSDT,
                            realizedPnL.profitPercent,
                            "POSITION_MISSING",
                            fallbackExitPrice,
                            positionKey
                        );
                    } else {
                        removeActivePositionByKey(positionKey);
                        await saveDB();
                    }
                    return;
                } else {
                    const entryPrice = getExchangePositionEntryPrice(openPosition, await getPrice());
                    const syncedPosition = buildSyncedActivePosition(openPosition, entryPrice, position);
                    await cancelManagedOrdersForPosition(position, "POSITION_RESYNC");
                    upsertActivePosition(syncedPosition);
                    await saveDB();
                    await ensureReduceOnlyTakeProfitOrder(positionKey, syncedPosition);
                    await ensureReduceOnlyStopLossOrder(positionKey, syncedPosition);
                    console.log("[INFO] Updated activePosition from exchange data. Will retry close on next cycle.");
                    return;
                }
            } else {
                throw error;
            }
        }

        const closeFillSnapshot = getOrderFillSnapshot(closeOrder, await getPrice(true), position.quantity);
        const remainingPosition = findOpenExchangePosition(await fetchOpenExchangePositions(), db.pair, position);
        if (remainingPosition) {
            const remainingContracts = Math.abs(getExchangePositionContracts(remainingPosition));
            if (remainingContracts > POSITION_SYNC_QTY_TOLERANCE) {
                const remainingEntryPrice = getExchangePositionEntryPrice(remainingPosition, position.entryPrice);
                const syncedRemainingPosition = buildSyncedActivePosition(remainingPosition, remainingEntryPrice, position);
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
    } catch (error) { console.error("[ERROR] Close position failed:", error.message); }
    finally {
        closingPositionKeys.delete(closeLockKey);
        isClosingPosition = closingPositionKeys.size > 0;
    }
};

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

const buildSignalSnapshot = (ohlcv, params) => {
    if (!Array.isArray(ohlcv) || ohlcv.length < 3) return null;

    const open = ohlcv.map((c) => c[1]); const high = ohlcv.map((c) => c[2]);
    const low = ohlcv.map((c) => c[3]); const close = ohlcv.map((c) => c[4]);
    const volume = ohlcv.map((c) => c[5]); const lastIndex = close.length - 2;

    const currentOpen = open[lastIndex]; const currentPrice = close[lastIndex];
    const currentVolume = volume[lastIndex];
    const recentVolumes = volume.slice(Math.max(0, lastIndex - params.volumePeriod), lastIndex);
    const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / Math.max(recentVolumes.length, 1);
    const volumeRatio = currentVolume / (avgVolume || 1);
    const hourUTC = new Date(ohlcv[lastIndex][0]).getUTCHours();

    const atrSeries = calcATR(high, low, close, params.atrPeriod);
    const currentATR = atrSeries[lastIndex];
    if (!Number.isFinite(currentATR) || currentATR <= 0) return { invalidAtr: true };

    return { ohlcv, open, high, low, close, volume, lastIndex, currentOpen, currentPrice, currentVolume, avgVolume, volumeRatio, hourUTC, currentATR };
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

const getTotalUSDTBalance = async (forceRefresh = false) => {
    try {
        const now = Date.now();
        if (!forceRefresh && now - balanceCache.lastUpdate < BALANCE_CACHE_TTL) return balanceCache.totalUSDT;
        const balance = await exchange.fetchBalance();
        metrics.api.balance++;
        const totalUSDT = Number(balance?.total?.USDT || 0);
        balanceCache.totalUSDT = Number.isFinite(totalUSDT) ? totalUSDT : 0;
        balanceCache.lastUpdate = now;
        return balanceCache.totalUSDT;
    } catch (error) { console.error("[ERROR] Failed to fetch balance:", error.message); return balanceCache.totalUSDT || 0; }
};

const getLastTradeTimestampFromLog = () => {
    try {
        if (!fs.existsSync(logPath)) return 0;
        const content = fs.readFileSync(logPath, "utf8");
        if (!content) return 0;
        const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (lines.length <= 1) return 0;
        const lastLine = lines[lines.length - 1];
        const timestamp = lastLine.split(",")[0];
        const parsed = Date.parse(timestamp);
        return Number.isFinite(parsed) ? parsed : 0;
    } catch (error) { console.error("[ERROR] Failed to read last trade timestamp:", error.message); return 0; }
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
            const managedOrdersSnapshot = await fetchManagedOpenOrdersSnapshot();

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
                }

                const pnlState = calculatePositionPnL(position, currentPrice);
                const exitState = evaluatePositionExit(position, currentPrice, pnlState, managedOrdersSnapshot);

                if (exitState.shouldClose) {
                    console.log(`[${positionKey}] ${exitState.message.trim()}`);
                    await closePosition(positionKey, exitState.reason, pnlState.netProfitUSDT, pnlState.profitPercent);
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
    console.log(`\n[SHUTDOWN] Received ${signal}. Stopping bot...`);
    clearRuntimeTimers();
    try { await saveDB(); } catch (error) { console.error("[ERROR] Failed to save DB during shutdown:", error.message); }
    try { await sequelize.close(); } catch (error) { console.error("[ERROR] Failed to close DB connection:", error.message); }
    console.log("[SHUTDOWN] Bot stopped.");
    process.exit(0);
};

// -------------------- MAIN LOOP --------------------
(async () => {
    try {
        if (!(await initializeDB())) process.exit(1);
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
