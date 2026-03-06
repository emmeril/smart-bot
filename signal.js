﻿require("dotenv").config();
const fs = require("fs");
const path = require("path");
const ccxt = require("ccxt");
const { RSI, EMA } = require("technicalindicators");
const { Sequelize, DataTypes } = require('sequelize');

// -------------------- DATABASE SETUP --------------------
const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: path.join(__dirname, 'database.sqlite'),
    logging: false
});

const Config = sequelize.define('Config', {
    strategy: { type: DataTypes.STRING, defaultValue: "hybrid" },
    pair: { type: DataTypes.STRING, defaultValue: "DOGE/USDT:USDT" },
    usdtPerTrade: { type: DataTypes.FLOAT, defaultValue: 10 },
    leverage: { type: DataTypes.INTEGER, defaultValue: 10 },
    targetProfitUSDT: { type: DataTypes.FLOAT, defaultValue: 0.5 },
    targetDailyProfit: { type: DataTypes.FLOAT, defaultValue: 1.0 },
    maxDailyLossPercent: { type: DataTypes.FLOAT, defaultValue: 10 },
    maxTradesPerDay: { type: DataTypes.INTEGER, defaultValue: 20 },
    coolingPeriod: { type: DataTypes.INTEGER, defaultValue: 3000 },
    activePosition: { type: DataTypes.TEXT, defaultValue: null },
    dailyPnL: { type: DataTypes.FLOAT, defaultValue: 0 },
    dailyTrades: { type: DataTypes.INTEGER, defaultValue: 0 },
    marginMode: { type: DataTypes.STRING, defaultValue: "isolated" },
    monitoringInterval: { type: DataTypes.INTEGER, defaultValue: 500 },
    stopLossPercent: { type: DataTypes.FLOAT, defaultValue: 5 },
    breakoutPeriod: { type: DataTypes.INTEGER, defaultValue: 20 },
    breakoutTimeframe: { type: DataTypes.STRING, defaultValue: "15m" },
    minBreakoutStrength: { type: DataTypes.FLOAT, defaultValue: 0.003 },
    minRangePercent: { type: DataTypes.FLOAT, defaultValue: 1.2 },
    sessionStartUTC: { type: DataTypes.INTEGER, defaultValue: 7 },
    sessionEndUTC: { type: DataTypes.INTEGER, defaultValue: 22 },
    volumePeriod: { type: DataTypes.INTEGER, defaultValue: 20 },
    minVolumeRatio: { type: DataTypes.FLOAT, defaultValue: 1.1 },
    shortMinVolumeRatio: { type: DataTypes.FLOAT, defaultValue: 1.4 },
    maxPriceDeviationPercent: { type: DataTypes.FLOAT, defaultValue: 0.5 },
    trendEnabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    trendTimeframe: { type: DataTypes.STRING, defaultValue: "15m" },
    trendPeriod: { type: DataTypes.INTEGER, defaultValue: 80 },
    shortTrendPeriod: { type: DataTypes.INTEGER, defaultValue: 120 },
    shortBreakoutPeriod: { type: DataTypes.INTEGER, defaultValue: 20 },
    shortMinRangePercent: { type: DataTypes.FLOAT, defaultValue: 0.8 },
    pullbackEmaPeriod: { type: DataTypes.INTEGER, defaultValue: 5 },
    pullbackLookback: { type: DataTypes.INTEGER, defaultValue: 2 },
    pullbackMaxDistancePct: { type: DataTypes.FLOAT, defaultValue: 0.5 },
    rsiLongMin: { type: DataTypes.FLOAT, defaultValue: 52 },
    rsiLongMax: { type: DataTypes.FLOAT, defaultValue: 72 },
    atrPeriod: { type: DataTypes.INTEGER, defaultValue: 14 },
    atrStopMult: { type: DataTypes.FLOAT, defaultValue: 0.8 },
    atrTargetMult: { type: DataTypes.FLOAT, defaultValue: 1.6 },
    shortAtrStopMult: { type: DataTypes.FLOAT, defaultValue: 1.4 },
    shortAtrTargetMult: { type: DataTypes.FLOAT, defaultValue: 1.6 },
    regimeFilterEnabled: { type: DataTypes.BOOLEAN, defaultValue: false },
    regimeAtrLookback: { type: DataTypes.INTEGER, defaultValue: 288 },
    regimeAtrPercentile: { type: DataTypes.FLOAT, defaultValue: 60 },
    breakoutUseCloseConfirm: { type: DataTypes.BOOLEAN, defaultValue: true },
    trailingEnabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    trailingActivateATR: { type: DataTypes.FLOAT, defaultValue: 1.2 },
    trailingOffsetATR: { type: DataTypes.FLOAT, defaultValue: 0.6 },
    shortTrailingActivateATR: { type: DataTypes.FLOAT, defaultValue: 1.0 },
    shortTrailingOffsetATR: { type: DataTypes.FLOAT, defaultValue: 0.8 },
    marketRegimeEnabled: { type: DataTypes.BOOLEAN, defaultValue: false },
    marketRegimeSymbol: { type: DataTypes.STRING, defaultValue: "BTC/USDT:USDT" },
    marketRegimeTimeframe: { type: DataTypes.STRING, defaultValue: "1h" },
    marketRegimeFastPeriod: { type: DataTypes.INTEGER, defaultValue: 20 },
    marketRegimeSlowPeriod: { type: DataTypes.INTEGER, defaultValue: 120 },
    allowLong: { type: DataTypes.BOOLEAN, defaultValue: true },
    allowShort: { type: DataTypes.BOOLEAN, defaultValue: true },
    adaptiveEnabled: { type: DataTypes.BOOLEAN, defaultValue: false },
    lastDailyReset: { type: DataTypes.BIGINT, defaultValue: Date.now() },
    lastUpdated: { type: DataTypes.BIGINT, defaultValue: Date.now() }
}, { timestamps: false });

// -------------------- GLOBAL VARIABLES --------------------
let isProcessing = false;
let isPlacingOrder = false;
let isClosingPosition = false;
let exchange = null;
let signalCount = 0;
let lastLogTime = Date.now();
let lastPnlLog = Date.now();
let lastTradeAt = 0;
let balanceCache = { totalUSDT: 0, lastUpdate: 0 };
let tickerCache = { price: null, lastUpdate: 0 };
let ohlcvCache = { key: "", data: null, lastUpdate: 0 }; // renamed from breakoutOhlcvCache
let pnlMonitorTimer = null;
let currentPnLMonitoringInterval = 0;
let isMonitoringPnL = false;
let positionSyncTimer = null;
let currentPositionSyncInterval = 0;
let isSyncingPosition = false;
let trendTimer = null;
let marketRegimeTimer = null;
let mainLoopTimer = null;
let metricsTimer = null;
let adaptiveTuneTimer = null;
let lastSignalDetailLogAt = 0;
let lastSyncLogAt = 0;
let isShuttingDown = false;
let isAdaptiveTuning = false;
const logPath = path.join(__dirname, 'trades.csv');
let db = null;
const BALANCE_CACHE_TTL = 15000;
const TICKER_CACHE_TTL = 800;
const OHLCV_CACHE_TTL = 1500;
const SYNC_LOG_TTL = 15000;
const SIGNAL_DETAIL_LOG_TTL = 10000;
const METRICS_LOG_INTERVAL = 60000;
const ADAPTIVE_TUNE_INTERVAL = 60 * 60 * 1000;

let metrics = {
    windowStart: Date.now(),
    api: {
        ticker: 0,
        ohlcv: 0,
        trendOhlcv: 0,
        balance: 0,
        positions: 0,
        orders: 0
    },
    signals: {
        analyzed: 0,
        crossoverDetected: 0,
        longConfirmed: 0,
        shortConfirmed: 0
    },
    trades: {
        opened: 0,
        closed: 0,
        wins: 0,
        losses: 0
    }
};

// Trend data
let trendData = { ema: null, lastUpdate: 0, timeframe: "1h", period: 200 };
let marketRegimeData = {
    symbol: "BTC/USDT:USDT",
    timeframe: "1h",
    state: "UNKNOWN",
    fastEma: null,
    slowEma: null,
    price: null,
    lastUpdate: 0
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
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
};

const toFiniteNumber = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const quantile = (sortedValues, p) => {
    if (!Array.isArray(sortedValues) || sortedValues.length === 0) return 0;
    const clampedP = clamp(p, 0, 1);
    const idx = Math.floor((sortedValues.length - 1) * clampedP);
    return toFiniteNumber(sortedValues[idx], 0);
};

const calcATR = (highs, lows, closes, period) => {
    const out = Array(closes.length).fill(null);
    if (!Array.isArray(highs) || !Array.isArray(lows) || !Array.isArray(closes) || closes.length <= period) {
        return out;
    }

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
    metrics.api.ticker = 0;
    metrics.api.ohlcv = 0;
    metrics.api.trendOhlcv = 0;
    metrics.api.balance = 0;
    metrics.api.positions = 0;
    metrics.api.orders = 0;
    metrics.signals.analyzed = 0;
    metrics.signals.crossoverDetected = 0;
    metrics.signals.longConfirmed = 0;
    metrics.signals.shortConfirmed = 0;
};

const startMetricsReporting = () => {
    if (metricsTimer) return;
    metricsTimer = setInterval(() => {
        const elapsedSec = Math.max(1, Math.round((Date.now() - metrics.windowStart) / 1000));
        const apiTotal =
            metrics.api.ticker +
            metrics.api.ohlcv +
            metrics.api.trendOhlcv +
            metrics.api.balance +
            metrics.api.positions +
            metrics.api.orders;
        const winRate = metrics.trades.closed > 0
            ? ((metrics.trades.wins / metrics.trades.closed) * 100).toFixed(1)
            : "0.0";

        console.log(
            `[METRICS] ${elapsedSec}s | API=${apiTotal} (ticker:${metrics.api.ticker}, ohlcv:${metrics.api.ohlcv}, trend:${metrics.api.trendOhlcv}, bal:${metrics.api.balance}, pos:${metrics.api.positions}, order:${metrics.api.orders}) | Signals=${metrics.signals.analyzed} (setups:${metrics.signals.crossoverDetected}, long:${metrics.signals.longConfirmed}, short:${metrics.signals.shortConfirmed}) | Trades today O/C/W/L=${metrics.trades.opened}/${metrics.trades.closed}/${metrics.trades.wins}/${metrics.trades.losses} (WR ${winRate}%)`
        );

        resetMetricWindow();
    }, METRICS_LOG_INTERVAL);
};

// -------------------- DEFAULT CONFIG --------------------
const getDefaultConfig = () => ({
    strategy: "hybrid",
    pair: "DOGE/USDT:USDT",
    usdtPerTrade: 2,
    leverage: 10,
    targetProfitUSDT: 0.5,
    targetDailyProfit: 5,
    maxDailyLossPercent: 10,
    maxTradesPerDay: 20,
    coolingPeriod: 3000,
    activePosition: null,
    dailyPnL: 0,
    dailyTrades: 0,
    marginMode: "isolated",
    monitoringInterval: 500,
    stopLossPercent: 5,
    breakoutPeriod: 20,
    breakoutTimeframe: "15m",
    minBreakoutStrength: 0.003,
    minRangePercent: 1.2,
    sessionStartUTC: 0,
    sessionEndUTC: 23,
    volumePeriod: 20,
    minVolumeRatio: 1.1,
    shortMinVolumeRatio: 1.4,
    maxPriceDeviationPercent: 0.5,
    trendEnabled: true,
    trendTimeframe: "15m",
    trendPeriod: 80,
    shortTrendPeriod: 120,
    shortBreakoutPeriod: 20,
    shortMinRangePercent: 0.8,
    pullbackEmaPeriod: 5,
    pullbackLookback: 2,
    pullbackMaxDistancePct: 0.5,
    rsiLongMin: 52,
    rsiLongMax: 72,
    atrPeriod: 14,
    atrStopMult: 0.8,
    atrTargetMult: 1.6,
    shortAtrStopMult: 1.4,
    shortAtrTargetMult: 1.6,
    regimeFilterEnabled: false,
    regimeAtrLookback: 288,
    regimeAtrPercentile: 60,
    breakoutUseCloseConfirm: true,
    trailingEnabled: true,
    trailingActivateATR: 1.2,
    trailingOffsetATR: 0.6,
    shortTrailingActivateATR: 1.0,
    shortTrailingOffsetATR: 0.8,
    marketRegimeEnabled: false,
    marketRegimeSymbol: "BTC/USDT:USDT",
    marketRegimeTimeframe: "1h",
    marketRegimeFastPeriod: 20,
    marketRegimeSlowPeriod: 120,
    allowLong: true,
    allowShort: true,
    adaptiveEnabled: false,
    lastDailyReset: Date.now(),
    lastUpdated: Date.now()
});

const normalizeConfig = (config) => {
    const defaults = getDefaultConfig();
    if (!config || typeof config !== "object") return { ...defaults };

    const normalized = { ...config };
    const numericRules = {
        usdtPerTrade: { min: 0, allowZero: false },
        leverage: { min: 0, allowZero: false, integer: true },
        targetProfitUSDT: { min: 0, allowZero: false },
        targetDailyProfit: { min: 0, allowZero: false },
        maxDailyLossPercent: { min: 0, allowZero: false },
        maxTradesPerDay: { min: 0, allowZero: false, integer: true },
        coolingPeriod: { min: 0, allowZero: true, integer: true },
        monitoringInterval: { min: 200, allowZero: false, integer: true },
        stopLossPercent: { min: 0, allowZero: false },
        breakoutPeriod: { min: 2, allowZero: false, integer: true },
        minBreakoutStrength: { min: 0, allowZero: false },
        minRangePercent: { min: 0, allowZero: true },
        sessionStartUTC: { min: 0, allowZero: true, integer: true },
        sessionEndUTC: { min: 0, allowZero: true, integer: true },
        volumePeriod: { min: 2, allowZero: false, integer: true },
        minVolumeRatio: { min: 1, allowZero: false },
        shortMinVolumeRatio: { min: 1, allowZero: false },
        maxPriceDeviationPercent: { min: 0, allowZero: true },
        trendPeriod: { min: 2, allowZero: false, integer: true },
        shortTrendPeriod: { min: 2, allowZero: false, integer: true },
        shortBreakoutPeriod: { min: 2, allowZero: false, integer: true },
        shortMinRangePercent: { min: 0, allowZero: true },
        pullbackEmaPeriod: { min: 2, allowZero: false, integer: true },
        pullbackLookback: { min: 1, allowZero: false, integer: true },
        pullbackMaxDistancePct: { min: 0.05, allowZero: false },
        rsiLongMin: { min: 1, allowZero: false },
        rsiLongMax: { min: 2, allowZero: false },
        atrPeriod: { min: 2, allowZero: false, integer: true },
        atrStopMult: { min: 0.2, allowZero: false },
        atrTargetMult: { min: 0.2, allowZero: false },
        shortAtrStopMult: { min: 0.2, allowZero: false },
        shortAtrTargetMult: { min: 0.2, allowZero: false },
        trailingActivateATR: { min: 0.2, allowZero: false },
        trailingOffsetATR: { min: 0.1, allowZero: false },
        shortTrailingActivateATR: { min: 0.2, allowZero: false },
        shortTrailingOffsetATR: { min: 0.1, allowZero: false },
        regimeAtrLookback: { min: 20, allowZero: false, integer: true },
        regimeAtrPercentile: { min: 10, allowZero: false },
        marketRegimeFastPeriod: { min: 2, allowZero: false, integer: true },
        marketRegimeSlowPeriod: { min: 2, allowZero: false, integer: true }
    };

    Object.entries(numericRules).forEach(([key, rule]) => {
        const rawValue = normalized[key];
        const hasValue = rawValue !== undefined && rawValue !== null && rawValue !== "";
        if (!hasValue) {
            normalized[key] = defaults[key];
            return;
        }

        const value = Number(rawValue);
        const invalidNumber = !Number.isFinite(value);
        const invalidZero = !rule.allowZero && value === 0;
        const belowMin = value < rule.min;

        if (invalidNumber || invalidZero || belowMin) {
            console.warn(`[WARN] Invalid config '${key}' (${normalized[key]}). Using default ${defaults[key]}.`);
            normalized[key] = defaults[key];
            return;
        }

        normalized[key] = rule.integer ? Math.trunc(value) : value;
    });

    const isValidTimeframe = (value) => typeof value === "string" && /^[1-9]\d*[mhdwM]$/.test(value.trim());
    const rawPair = typeof normalized.pair === "string" ? normalized.pair.trim() : "";
    normalized.pair = rawPair || defaults.pair;
    normalized.strategy = typeof normalized.strategy === "string" && normalized.strategy.trim()
        ? normalized.strategy.trim().toLowerCase()
        : defaults.strategy;

    const rawMarginMode = typeof normalized.marginMode === "string" ? normalized.marginMode.trim().toLowerCase() : "";
    normalized.marginMode = rawMarginMode === "isolated" || rawMarginMode === "cross"
        ? rawMarginMode
        : defaults.marginMode;

    normalized.breakoutTimeframe = isValidTimeframe(normalized.breakoutTimeframe)
        ? normalized.breakoutTimeframe.trim()
        : defaults.breakoutTimeframe;
    normalized.trendTimeframe = isValidTimeframe(normalized.trendTimeframe)
        ? normalized.trendTimeframe.trim()
        : defaults.trendTimeframe;
    normalized.marketRegimeTimeframe = isValidTimeframe(normalized.marketRegimeTimeframe)
        ? normalized.marketRegimeTimeframe.trim()
        : defaults.marketRegimeTimeframe;

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

    normalizeBoolean("trendEnabled");
    normalizeBoolean("adaptiveEnabled");
    normalizeBoolean("regimeFilterEnabled");
    normalizeBoolean("breakoutUseCloseConfirm");
    normalizeBoolean("trailingEnabled");
    normalizeBoolean("marketRegimeEnabled");
    normalizeBoolean("allowLong");
    normalizeBoolean("allowShort");

    normalized.regimeAtrPercentile = clamp(toFiniteNumber(normalized.regimeAtrPercentile, defaults.regimeAtrPercentile), 10, 95);
    normalized.rsiLongMin = clamp(toFiniteNumber(normalized.rsiLongMin, defaults.rsiLongMin), 1, 99);
    normalized.rsiLongMax = clamp(toFiniteNumber(normalized.rsiLongMax, defaults.rsiLongMax), normalized.rsiLongMin + 1, 99);
    normalized.sessionStartUTC = clamp(Math.trunc(toFiniteNumber(normalized.sessionStartUTC, defaults.sessionStartUTC)), 0, 23);
    normalized.sessionEndUTC = clamp(Math.trunc(toFiniteNumber(normalized.sessionEndUTC, defaults.sessionEndUTC)), 0, 23);
    normalized.marketRegimeSymbol = typeof normalized.marketRegimeSymbol === "string" && normalized.marketRegimeSymbol.trim()
        ? normalized.marketRegimeSymbol.trim()
        : defaults.marketRegimeSymbol;

    return normalized;
};

// -------------------- INITIALIZE DATABASE --------------------
const initializeDB = async () => {
    try {
        await sequelize.sync();
        console.log("[OK] Database synced");

        let configRow = await Config.findOne();
        if (!configRow) {
            configRow = await Config.create(getDefaultConfig());
            console.log("[INFO] Created new config row");
        }

        db = configRow.toJSON();
        db.activePosition = safeParseJSON(db.activePosition, null);
        db = normalizeConfig(db);
        console.log("[OK] DB initialized successfully");
        return true;
    } catch (error) {
        console.error("[ERROR] Error initializing DB:", error.message);
        db = getDefaultConfig();
        return true;
    }
};

// -------------------- RELOAD CONFIG FROM DB --------------------
const reloadConfig = async () => {
    try {
        if (!db) return false;
        const configRow = await Config.findOne();
        if (!configRow) return false;

        const freshConfig = configRow.toJSON();
        freshConfig.activePosition = safeParseJSON(freshConfig.activePosition, null);
        const normalizedConfig = normalizeConfig(freshConfig);

        if (db.activePosition && !normalizedConfig.activePosition) {
            normalizedConfig.activePosition = db.activePosition;
        }
        if (db.dailyTrades > normalizedConfig.dailyTrades) {
            normalizedConfig.dailyPnL = db.dailyPnL;
            normalizedConfig.dailyTrades = db.dailyTrades;
        }

        Object.keys(normalizedConfig).forEach(key => db[key] = normalizedConfig[key]);
        return true;
    } catch (error) {
        console.error("[ERROR] Failed to reload config:", error.message);
        return false;
    }
};

// -------------------- SAVE DB TO DATABASE --------------------
const saveDB = async () => {
    try {
        if (!db) return;
        const toSave = { ...db };
        toSave.activePosition = toSave.activePosition ? JSON.stringify(toSave.activePosition) : null;
        toSave.lastUpdated = Date.now();

        if (db.id) {
            await Config.update(toSave, { where: { id: db.id } });
            return;
        }

        const firstRow = await Config.findOne();
        if (firstRow) {
            db.id = firstRow.id;
            await Config.update(toSave, { where: { id: firstRow.id } });
            return;
        }

        const created = await Config.create(toSave);
        db.id = created.id;
    } catch (error) {
        console.error("[ERROR] Failed to save DB:", error.message);
    }
};

// -------------------- SYNC POSITION WITH EXCHANGE --------------------
const syncPositionWithExchange = async () => {
    if (isSyncingPosition) return;
    isSyncingPosition = true;
    try {
        if (!db || !exchange) return;
        const now = Date.now();
        if (now - lastSyncLogAt >= SYNC_LOG_TTL) {
            console.log(`[SYNC] Checking positions for ${db.pair}...`);
            lastSyncLogAt = now;
        }
        metrics.api.positions++;
        const positions = await exchange.fetchPositions();
        let openPosition = null;
        const normalizeSymbol = (symbol) => symbol.toUpperCase().trim();
        const dbPairNormalized = normalizeSymbol(db.pair);

        for (const position of positions) {
            if (normalizeSymbol(position.symbol) === dbPairNormalized && Math.abs(parseFloat(position.contracts || 0)) > 0) {
                openPosition = position;
                break;
            }
        }

        if (!openPosition) {
            if (db.activePosition) {
                console.log("[WARN] DB has activePosition but exchange doesn't. Resetting...");
                db.activePosition = null;
                await saveDB();
            }
            return;
        }

        const contracts = parseFloat(openPosition.contracts || 0);
        const side = openPosition.side === 'long' ? 'buy' : 'sell';
        const entryPrice = parseFloat(openPosition.entryPrice || 0) || (await getPrice());

        if (!db.activePosition) {
            db.activePosition = {
                side: side,
                entryPrice: entryPrice,
                targetPrice: null,
                stopLossPrice: null,
                stopLossUSDT: -db.usdtPerTrade * (db.stopLossPercent / 100),
                orderId: `SYNC_${Date.now()}`,
                quantity: Math.abs(contracts),
                entryTime: Date.now() - 300000,
                highestSinceEntry: entryPrice,
                lowestSinceEntry: entryPrice,
                marginMode: (db.marginMode || "isolated").toLowerCase(),
                targetProfitUSDT: db.targetProfitUSDT,
                strategy: "SYNC_ONLY"
            };
            await saveDB();
            console.log("[OK] Created activePosition from exchange data");
        } else {
            if (db.activePosition.side !== side || Math.abs(db.activePosition.quantity - Math.abs(contracts)) > 0.001) {
                db.activePosition.side = side;
                db.activePosition.quantity = Math.abs(contracts);
                db.activePosition.entryPrice = entryPrice;
                await saveDB();
                console.log("[OK] Updated activePosition to match exchange");
            }
        }
    } catch (error) {
        console.error("[ERROR] Sync position failed:", error.message);
    } finally {
        isSyncingPosition = false;
    }
};

// -------------------- INIT EXCHANGE --------------------
const initializeExchange = async () => {
    try {
        exchange = new ccxt.binance({
            apiKey: process.env.API_KEY,
            secret: process.env.API_SECRET,
            options: { defaultType: "future" },
            enableRateLimit: true,
        });
        await exchange.loadMarkets();
        console.log("[OK] Exchange connected");
        return exchange;
    } catch (error) {
        console.error("[ERROR] Exchange connection failed:", error.message);
        throw error;
    }
};

// -------------------- SET MARGIN MODE --------------------
const setMarginMode = async () => {
    try {
        if (!db) return false;
        const marginMode = (db.marginMode || "isolated").toLowerCase();
        await exchange.setMarginMode(marginMode, db.pair);
        console.log(`[OK] Margin mode set to: ${marginMode.toUpperCase()}`);
        return true;
    } catch (error) {
        if (!error.message.includes("No need to change margin mode")) {
            console.warn("[WARN] Margin mode warning:", error.message);
        }
        return false;
    }
};

// -------------------- UPDATE TREND EMA --------------------
const updateTrend = async () => {
    try {
        if (!exchange || !db) return;
        const timeframe = db.trendTimeframe || "1h";
        const period = db.trendPeriod || 200;
        metrics.api.trendOhlcv++;
        const ohlcv = await exchange.fetchOHLCV(db.pair, timeframe, undefined, period + 10);
        if (ohlcv.length < period) {
            console.log(`[WARN] Not enough data for trend EMA (${ohlcv.length} < ${period})`);
            return;
        }
        const closes = ohlcv.map(c => c[4]);
        const ema = EMA.calculate({ values: closes, period });
        if (ema.length > 0) {
            trendData.ema = ema[ema.length - 1];
            trendData.lastUpdate = Date.now();
            console.log(`[TREND] EMA${period} (${timeframe}): ${trendData.ema}`);
        }
    } catch (error) {
        console.error("[ERROR] Failed to update trend:", error.message);
    }
};

const updateMarketRegime = async () => {
    try {
        if (!exchange || !db || !db.marketRegimeEnabled) {
            marketRegimeData.state = "DISABLED";
            return;
        }

        const symbol = db.marketRegimeSymbol || "BTC/USDT:USDT";
        const timeframe = db.marketRegimeTimeframe || "1h";
        const fastPeriod = Math.max(2, Math.trunc(db.marketRegimeFastPeriod || 20));
        const slowPeriod = Math.max(fastPeriod + 1, Math.trunc(db.marketRegimeSlowPeriod || 120));
        metrics.api.trendOhlcv++;
        const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, slowPeriod + 10);
        if (!Array.isArray(ohlcv) || ohlcv.length < slowPeriod) {
            console.log(`[WARN] Not enough data for market regime (${symbol} ${timeframe})`);
            return;
        }

        const closes = ohlcv.map(c => c[4]);
        const fastEma = EMA.calculate({ values: closes, period: fastPeriod });
        const slowEma = EMA.calculate({ values: closes, period: slowPeriod });
        if (!fastEma.length || !slowEma.length) return;

        const price = closes[closes.length - 1];
        const fast = fastEma[fastEma.length - 1];
        const slow = slowEma[slowEma.length - 1];
        let state = "MIXED";
        if (price > fast && fast > slow) state = "UP-UP";
        else if (price < fast && fast < slow) state = "DOWN-DOWN";

        marketRegimeData = {
            symbol,
            timeframe,
            state,
            fastEma: fast,
            slowEma: slow,
            price,
            lastUpdate: Date.now()
        };
        console.log(`[REGIME] ${symbol} ${timeframe}: ${state} | price=${price} fast=${fast.toFixed(6)} slow=${slow.toFixed(6)}`);
    } catch (error) {
        console.error("[ERROR] Failed to update market regime:", error.message);
    }
};

// -------------------- SIGNAL DETECTION --------------------
const analyzeSignal = async () => {
    try {
        if (!db) return {};
        signalCount++;
        metrics.signals.analyzed++;
        const now = Date.now();
        const strategyMode = String(db.strategy || "breakout").toLowerCase();
        if (now - lastLogTime > 5000) {
            console.log(`\n[SIGNAL #${signalCount}] Analyzing ${strategyMode} setup (${db.breakoutTimeframe})...`);
            lastLogTime = now;
        }

        const breakoutPeriod = Math.max(2, Math.trunc(db.breakoutPeriod || 20));
        const shortBreakoutPeriod = Math.max(2, Math.trunc(db.shortBreakoutPeriod || breakoutPeriod));
        const volumePeriod = Math.max(2, Math.trunc(db.volumePeriod || 20));
        const atrPeriod = Math.max(2, Math.trunc(db.atrPeriod || 14));
        const regimeLookback = Math.max(20, Math.trunc(db.regimeAtrLookback || 288));
        const pullbackEmaPeriod = Math.max(2, Math.trunc(db.pullbackEmaPeriod || 5));
        const pullbackLookback = Math.max(1, Math.trunc(db.pullbackLookback || 2));
        const neededCandles = Math.max(
            breakoutPeriod + 2,
            volumePeriod + 2,
            atrPeriod + 2,
            atrPeriod + regimeLookback + 2,
            pullbackEmaPeriod + pullbackLookback + 5,
            60
        );
        const ohlcv = await getOHLCV(neededCandles);
        if (ohlcv.length < neededCandles) {
            console.log(`[WARN] Not enough OHLCV data: ${ohlcv.length} < ${neededCandles}`);
            return {};
        }

        const open = ohlcv.map(c => c[1]);
        const high = ohlcv.map(c => c[2]);
        const low = ohlcv.map(c => c[3]);
        const close = ohlcv.map(c => c[4]);
        const volume = ohlcv.map(c => c[5]);
        const lastIndex = close.length - 1;

        const currentOpen = open[lastIndex];
        const currentHigh = high[lastIndex];
        const currentLow = low[lastIndex];
        const currentPrice = close[lastIndex];
        const currentVolume = volume[lastIndex];

        const avgVolume = volume.slice(-volumePeriod - 1, -1).reduce((a, b) => a + b, 0) / volumePeriod;
        const safeAvgVolume = avgVolume > 0 ? avgVolume : Number.EPSILON;
        const volumeRatio = currentVolume / safeAvgVolume;
        const volumeOk = volumeRatio >= db.minVolumeRatio;

        const prevHighs = high.slice(lastIndex - breakoutPeriod, lastIndex);
        const prevLows = low.slice(lastIndex - breakoutPeriod, lastIndex);
        const resistance = Math.max(...prevHighs);
        const support = Math.min(...prevLows);
        const range = resistance - support;
        const shortPrevHighs = high.slice(lastIndex - shortBreakoutPeriod, lastIndex);
        const shortPrevLows = low.slice(lastIndex - shortBreakoutPeriod, lastIndex);
        const shortResistance = Math.max(...shortPrevHighs);
        const shortSupport = Math.min(...shortPrevLows);
        const shortRange = shortResistance - shortSupport;
        if (!Number.isFinite(range) || range <= 0 || !Number.isFinite(shortRange) || shortRange <= 0) {
            console.log("[WARN] Invalid setup range");
            return {};
        }

        const breakoutThreshold = range * db.minBreakoutStrength;
        const bullishBreakout = db.breakoutUseCloseConfirm
            ? currentPrice > resistance + breakoutThreshold
            : currentHigh > resistance + breakoutThreshold;
        const shortBreakoutThreshold = shortRange * db.minBreakoutStrength;
        const bearishBreakout = db.breakoutUseCloseConfirm
            ? currentPrice < shortSupport - shortBreakoutThreshold
            : currentLow < shortSupport - shortBreakoutThreshold;
        const rangePercent = currentPrice > 0 ? (range / currentPrice) * 100 : 0;
        const rangeOk = rangePercent >= db.minRangePercent;
        const shortRangePercent = currentPrice > 0 ? (shortRange / currentPrice) * 100 : 0;
        const shortRangeOk = shortRangePercent >= toFiniteNumber(db.shortMinRangePercent, 0.8);
        const hourUTC = new Date(ohlcv[lastIndex][0]).getUTCHours();
        const sessionOk = db.sessionStartUTC <= db.sessionEndUTC
            ? hourUTC >= db.sessionStartUTC && hourUTC <= db.sessionEndUTC
            : hourUTC >= db.sessionStartUTC || hourUTC <= db.sessionEndUTC;

        const atrSeries = calcATR(high, low, close, atrPeriod);
        const currentATR = atrSeries[lastIndex];
        if (!Number.isFinite(currentATR) || currentATR <= 0) {
            console.log("[WARN] ATR is not ready");
            return {};
        }

        const rsi = RSI.calculate({ values: close, period: 7 });
        const currentRSI = rsi.length > 0 ? rsi[rsi.length - 1] : 50;
        const prevRSI = rsi.length > 1 ? rsi[rsi.length - 2] : currentRSI;
        const pullbackEmaSeries = EMA.calculate({ values: close, period: pullbackEmaPeriod });
        const currentPullbackEma = pullbackEmaSeries.length > 0 ? pullbackEmaSeries[pullbackEmaSeries.length - 1] : null;
        const prevPullbackEma = pullbackEmaSeries.length > 1 ? pullbackEmaSeries[pullbackEmaSeries.length - 2] : currentPullbackEma;
        const longTrendSeries = EMA.calculate({ values: close, period: Math.max(2, Math.trunc(db.trendPeriod || 80)) });
        const currentLongTrendEma = longTrendSeries.length > 0 ? longTrendSeries[longTrendSeries.length - 1] : trendData.ema;
        const shortTrendPeriod = Math.max(2, Math.trunc(db.shortTrendPeriod || 120));
        const shortTrendSeries = EMA.calculate({ values: close, period: shortTrendPeriod });
        const currentShortTrendEma = shortTrendSeries.length > 0 ? shortTrendSeries[shortTrendSeries.length - 1] : trendData.ema;

        let regimeOk = true;
        if (db.regimeFilterEnabled) {
            const atrWindow = atrSeries
                .slice(Math.max(0, lastIndex - regimeLookback), lastIndex)
                .filter(value => Number.isFinite(value) && value > 0)
                .sort((a, b) => a - b);
            const atrThreshold = quantile(atrWindow, db.regimeAtrPercentile / 100);
            regimeOk = atrWindow.length >= Math.min(regimeLookback, 20) && currentATR >= atrThreshold;
        }

        let marketRegimeOkLong = true;
        let marketRegimeOkShort = true;
        if (db.marketRegimeEnabled) {
            marketRegimeOkLong = marketRegimeData.state === "UP-UP";
            marketRegimeOkShort = marketRegimeData.state === "DOWN-DOWN";
        }

        let canLong = false, canShort = false;
        let detailTitle = "HYBRID ANALYSIS";
        let setupDetected = bullishBreakout || bearishBreakout;
        let extraDetailLines = [];
        if (strategyMode === "pullback" || strategyMode === "hybrid") {
            detailTitle = "PULLBACK MOMENTUM ANALYSIS";
            const trendOk = Number.isFinite(currentLongTrendEma) ? currentPrice > currentLongTrendEma : true;
            const recentLow = Math.min(...low.slice(Math.max(0, lastIndex - pullbackLookback), lastIndex + 1));
            const touchDistancePct = Number.isFinite(currentPullbackEma) && currentPullbackEma > 0
                ? Math.abs((recentLow - currentPullbackEma) / currentPullbackEma) * 100
                : Number.POSITIVE_INFINITY;
            const touchedPullbackZone = Number.isFinite(currentPullbackEma) &&
                recentLow <= currentPullbackEma &&
                touchDistancePct <= db.pullbackMaxDistancePct;
            const prevClose = close[lastIndex - 1];
            const reclaim = Number.isFinite(prevPullbackEma) && prevClose <= prevPullbackEma && currentPrice > currentPullbackEma;
            const momentumLongOk = currentPrice > currentOpen && currentPrice > prevClose && currentRSI > prevRSI;
            setupDetected = touchedPullbackZone || reclaim;
            canLong =
                trendOk &&
                touchedPullbackZone &&
                reclaim &&
                volumeOk &&
                sessionOk &&
                regimeOk &&
                marketRegimeOkLong &&
                momentumLongOk &&
                currentRSI >= db.rsiLongMin &&
                currentRSI <= db.rsiLongMax;
            canShort = false;
            extraDetailLines = [
                `   Pullback EMA (${pullbackEmaPeriod}): ${Number.isFinite(currentPullbackEma) ? currentPullbackEma.toFixed(6) : "n/a"}`,
                `   Recent Low (${pullbackLookback}): ${recentLow.toFixed(6)}`,
                `   Pullback Distance: ${Number.isFinite(touchDistancePct) ? touchDistancePct.toFixed(2) : "n/a"}% (max ${db.pullbackMaxDistancePct}%)`,
                `   Pullback Touched: ${touchedPullbackZone ? "[OK]" : "[NO]"}`,
                `   Reclaim EMA: ${reclaim ? "[OK]" : "[NO]"}`,
                `   RSI Momentum: ${momentumLongOk ? "[OK]" : "[NO]"} (${currentRSI.toFixed(2)} vs prev ${prevRSI.toFixed(2)})`,
                `   Trend EMA Long: ${currentLongTrendEma} → Long trend ok: ${trendOk}`
            ];
            if (strategyMode === "hybrid") {
                const shortTrendOk = Number.isFinite(currentShortTrendEma) ? currentPrice < currentShortTrendEma : true;
                const shortVolumeOk = volumeRatio >= toFiniteNumber(db.shortMinVolumeRatio, 1.4);
                const shortMomentumOk = currentPrice < currentOpen;
                canShort =
                    bearishBreakout &&
                    shortVolumeOk &&
                    shortRangeOk &&
                    sessionOk &&
                    regimeOk &&
                    shortTrendOk &&
                    marketRegimeOkShort &&
                    shortMomentumOk &&
                    currentRSI > 25 &&
                    currentRSI < 50;
                setupDetected = setupDetected || bearishBreakout;
                detailTitle = "HYBRID PULLBACK/BREAKOUT ANALYSIS";
                extraDetailLines.push(`   Short Breakout (${shortBreakoutPeriod}): ${bearishBreakout ? "[OK]" : "[NO]"}`);
                extraDetailLines.push(`   Short Volume OK: ${shortVolumeOk ? "[OK]" : "[NO]"} (min ${db.shortMinVolumeRatio}x)`);
                extraDetailLines.push(`   Short Range OK: ${shortRangeOk ? "[OK]" : "[NO]"} (min ${db.shortMinRangePercent}%)`);
                extraDetailLines.push(`   Trend EMA Short: ${currentShortTrendEma} → Short trend ok: ${shortTrendOk}`);
            }
        } else {
            if (bullishBreakout && volumeOk && rangeOk && sessionOk && regimeOk && marketRegimeOkLong && currentRSI > 50 && currentRSI < 75) {
                canLong = true;
            }
            if (bearishBreakout && volumeRatio >= toFiniteNumber(db.shortMinVolumeRatio, db.minVolumeRatio) && shortRangeOk && sessionOk && regimeOk && marketRegimeOkShort && currentRSI > 25 && currentRSI < 50) {
                canShort = true;
            }
        }

        if (strategyMode !== "pullback") {
            if (currentPrice <= currentOpen) canLong = false;
            if (currentPrice >= currentOpen) canShort = false;
        }

        if (!db.allowLong) canLong = false;
        if (!db.allowShort) canShort = false;

        if (strategyMode !== "pullback" && db.trendEnabled && trendData.ema) {
            if (currentPrice <= trendData.ema) canLong = false;
            if (currentPrice >= trendData.ema) canShort = false;
        }

        if (setupDetected) metrics.signals.crossoverDetected++;
        if (canLong) metrics.signals.longConfirmed++;
        if (canShort) metrics.signals.shortConfirmed++;

        const shouldDetailLog = setupDetected || (Date.now() - lastSignalDetailLogAt >= SIGNAL_DETAIL_LOG_TTL);

        if (shouldDetailLog) {
            console.log("\n" + "=".repeat(50));
            console.log(`${detailTitle} (${db.breakoutTimeframe}):`);
            console.log(`   Current Price: ${currentPrice}`);
            if (strategyMode !== "pullback") {
                console.log(`   Resistance (${breakoutPeriod}): ${resistance.toFixed(6)}`);
                console.log(`   Support (${breakoutPeriod}): ${support.toFixed(6)}`);
                console.log(`   Range: ${range.toFixed(6)} (${rangePercent.toFixed(2)}%)`);
            }
            console.log(`   Current Volume: ${currentVolume.toFixed(2)}`);
            console.log(`   Avg Volume (${volumePeriod}): ${avgVolume.toFixed(2)}`);
            console.log(`   Volume Ratio: ${volumeRatio.toFixed(2)}x (min ${db.minVolumeRatio}x)`);
            console.log(`   RSI 7: ${currentRSI.toFixed(2)}`);
            console.log(`   ATR ${atrPeriod}: ${currentATR.toFixed(6)}`);
            console.log("");
            console.log("SETUP CONDITIONS:");
            if (strategyMode !== "pullback") {
                console.log(`   Bullish Breakout: ${bullishBreakout ? "[OK]" : "[NO]"}`);
                console.log(`   Bearish Breakout: ${bearishBreakout ? "[OK]" : "[NO]"}`);
            }
            console.log(`   Volume OK: ${volumeOk ? "[OK]" : "[NO]"}`);
            if (strategyMode !== "pullback") {
                console.log(`   Range OK: ${rangeOk ? "[OK]" : "[NO]"} (min ${db.minRangePercent}%)`);
            }
            console.log(`   Session OK: ${sessionOk ? "[OK]" : "[NO]"} (${db.sessionStartUTC}-${db.sessionEndUTC} UTC, now ${hourUTC})`);
            console.log(`   Regime OK: ${regimeOk ? "[OK]" : "[NO]"}`);
            if (db.marketRegimeEnabled) {
                console.log(`   Market Regime: ${marketRegimeData.state} (${marketRegimeData.symbol} ${marketRegimeData.timeframe})`);
            }
            extraDetailLines.forEach((line) => console.log(line));
            if (strategyMode !== "pullback" && db.trendEnabled && trendData.ema) {
                console.log(`   Trend EMA: ${trendData.ema} → Long allowed: ${canLong}, Short allowed: ${canShort}`);
            }
            console.log("");
            console.log("FINAL SIGNAL:");
            console.log(`   LONG Signal: ${canLong ? "[OK] CONFIRMED" : "[NO] NOT CONFIRMED"}`);
            console.log(`   SHORT Signal: ${canShort ? "[OK] CONFIRMED" : "[NO] NOT CONFIRMED"}`);
            console.log("=".repeat(50));
            lastSignalDetailLogAt = Date.now();
        }

        return {
            canLong,
            canShort,
            price: currentPrice,
            rsi: currentRSI,
            atr: currentATR,
            rangePercent,
            resistance,
            support,
            hasSignal: setupDetected,
            strategy: strategyMode === "hybrid" ? (canShort ? "BREAKOUT_SHORT_ATR" : "PULLBACK_LONG_ATR") : (strategyMode === "pullback" ? "PULLBACK_ATR" : "BREAKOUT_ATR"),
            riskOverrides: canShort
                ? {
                    atrStopMult: toFiniteNumber(db.shortAtrStopMult, db.atrStopMult),
                    atrTargetMult: toFiniteNumber(db.shortAtrTargetMult, db.atrTargetMult),
                    trailingActivateATR: toFiniteNumber(db.shortTrailingActivateATR, db.trailingActivateATR),
                    trailingOffsetATR: toFiniteNumber(db.shortTrailingOffsetATR, db.trailingOffsetATR)
                }
                : {
                    atrStopMult: toFiniteNumber(db.atrStopMult, 0.8),
                    atrTargetMult: toFiniteNumber(db.atrTargetMult, 1.6),
                    trailingActivateATR: toFiniteNumber(db.trailingActivateATR, 1.2),
                    trailingOffsetATR: toFiniteNumber(db.trailingOffsetATR, 0.6)
                }
        };
    } catch (error) {
        console.error("[ERROR] Breakout analysis failed:", error.message);
        return {};
    }
};

// -------------------- PLACE ORDER --------------------
const placeOrder = async (side, signalData = {}) => {
    try {
        if (!db || db.activePosition || isPlacingOrder || isClosingPosition) return;
        isPlacingOrder = true;

        console.log(`\n[ORDER] Attempting to place ${side.toUpperCase()} order...`);
        await setMarginMode();
        await exchange.setLeverage(db.leverage, db.pair);

        const tickerPrice = await getPrice(true);
        if (!Number.isFinite(tickerPrice) || tickerPrice <= 0) {
            console.error("[ERROR] Invalid ticker price. Order skipped.");
            return;
        }

        const signalPrice = typeof signalData === "object" ? signalData.price : signalData;
        const signalATR = typeof signalData === "object" ? toFiniteNumber(signalData.atr, null) : null;
        const strategyName = typeof signalData === "object" && signalData.strategy ? String(signalData.strategy) : "BREAKOUT_ATR";
        const riskOverrides = typeof signalData === "object" && signalData.riskOverrides ? signalData.riskOverrides : {};
        const atrStopMult = toFiniteNumber(riskOverrides.atrStopMult, db.atrStopMult);
        const atrTargetMult = toFiniteNumber(riskOverrides.atrTargetMult, db.atrTargetMult);
        const trailingActivateATR = toFiniteNumber(riskOverrides.trailingActivateATR, db.trailingActivateATR);
        const trailingOffsetATR = toFiniteNumber(riskOverrides.trailingOffsetATR, db.trailingOffsetATR);
        const hasSignalPrice = Number(signalPrice) > 0;
        const entryPrice = hasSignalPrice ? Number(signalPrice) : tickerPrice;
        const maxDeviationPercent = Number(db.maxPriceDeviationPercent ?? 0.5);
        if (hasSignalPrice && maxDeviationPercent > 0) {
            const deviationPercent = Math.abs((entryPrice - tickerPrice) / tickerPrice) * 100;
            if (deviationPercent > maxDeviationPercent) {
                console.warn(
                    `[WARN] Price deviation too high (${deviationPercent.toFixed(3)}% > ${maxDeviationPercent}%). Order skipped.`
                );
                return;
            }
        }
        const qty = (db.usdtPerTrade * db.leverage) / entryPrice;
        const market = exchange.markets[db.pair];
        const precision = market?.precision?.amount || 3;
        const adjustedQty = parseFloat(qty.toFixed(precision));
        if (!Number.isFinite(adjustedQty) || adjustedQty <= 0) {
            console.error("[ERROR] Invalid order quantity after precision adjustment.");
            return;
        }
        const minAmount = Number(market?.limits?.amount?.min);
        if (Number.isFinite(minAmount) && adjustedQty < minAmount) {
            console.error(`[ERROR] Quantity ${adjustedQty} is below exchange minimum ${minAmount}. Order skipped.`);
            return;
        }

        let targetPrice;
        const pricePrecision = market?.precision?.price || 8;
        let stopLossPrice;
        let targetProfitUSDT = db.targetProfitUSDT;
        let stopLossUSDT = -db.usdtPerTrade * (db.stopLossPercent / 100);
        if (signalATR && signalATR > 0) {
            const stopDistance = signalATR * atrStopMult;
            const targetDistance = signalATR * atrTargetMult;
            targetPrice = side === "buy" ? entryPrice + targetDistance : entryPrice - targetDistance;
            stopLossPrice = side === "buy" ? entryPrice - stopDistance : entryPrice + stopDistance;
            targetProfitUSDT = Math.abs(targetPrice - entryPrice) * adjustedQty;
            stopLossUSDT = -Math.abs(stopLossPrice - entryPrice) * adjustedQty;
        } else {
            targetPrice = side === "buy"
                ? entryPrice + (targetProfitUSDT / adjustedQty)
                : entryPrice - (targetProfitUSDT / adjustedQty);
            stopLossPrice = side === "buy"
                ? entryPrice + (stopLossUSDT / adjustedQty)
                : entryPrice - (stopLossUSDT / adjustedQty);
        }
        targetPrice = parseFloat(targetPrice.toFixed(pricePrecision));
        stopLossPrice = parseFloat(stopLossPrice.toFixed(pricePrecision));

        console.log(`   Order Details:`);
        console.log(`   - Amount: ${db.usdtPerTrade} USDT × ${db.leverage}x = ${(db.usdtPerTrade * db.leverage).toFixed(2)} USDT`);
        console.log(`   - Quantity: ${adjustedQty} ${db.pair.split('/')[0]}`);
        console.log(`   - Entry Price: ${entryPrice}`);
        console.log(`   - Strategy: ${strategyName}`);
        console.log(`   - Target Profit: ${targetProfitUSDT.toFixed(4)} USDT`);
        console.log(`   - Target Price: ${targetPrice}`);
        console.log(`   - Stop Loss: ${stopLossUSDT.toFixed(4)} USDT`);
        console.log(`   - Stop Loss Price: ${stopLossPrice}`);
        console.log(`   - ATR Risk: stop ${atrStopMult}x | target ${atrTargetMult}x | trail ${trailingActivateATR}/${trailingOffsetATR}x`);

        const order = await exchange.createOrder(db.pair, "market", side, adjustedQty, undefined, {
            marginMode: (db.marginMode || "isolated").toLowerCase()
        });
        metrics.api.orders++;

        db.activePosition = {
            side: side,
            entryPrice: entryPrice,
            targetPrice: targetPrice,
            stopLossPrice: stopLossPrice,
            stopLossUSDT: stopLossUSDT,
            orderId: order.id,
            quantity: adjustedQty,
            entryTime: Date.now(),
            highestSinceEntry: entryPrice,
            lowestSinceEntry: entryPrice,
            marginMode: (db.marginMode || "isolated").toLowerCase(),
            targetProfitUSDT: targetProfitUSDT,
            atrAtEntry: signalATR,
            strategy: strategyName,
            trailingActivateATR,
            trailingOffsetATR
        };

        await saveDB();
        logTrade(side, entryPrice, null, "OPEN");
        metrics.trades.opened++;

        console.log(`\n[OK] ORDER PLACED: ${side.toUpperCase()} at ${entryPrice}`);
    } catch (error) {
        console.error("[ERROR] Order failed:", error.message);
    } finally {
        isPlacingOrder = false;
    }
};

// -------------------- CLOSE POSITION --------------------
const closePosition = async (reason, profitUSDT, profitPercent) => {
    try {
        if (!db || !db.activePosition || isClosingPosition) return;
        isClosingPosition = true;
        const { side, quantity, entryPrice } = db.activePosition;
        if (!Number.isFinite(quantity) || quantity <= 0) {
            console.error("[ERROR] Invalid position quantity. Resetting activePosition.");
            db.activePosition = null;
            await saveDB();
            return;
        }
        const closeSide = side === "buy" ? "sell" : "buy";

        console.log(`\n[CLOSE] Closing position...`);
        await exchange.createOrder(db.pair, "market", closeSide, quantity, undefined, {
            reduceOnly: true,
            marginMode: (db.marginMode || "isolated").toLowerCase()
        });
        metrics.api.orders++;

        db.dailyPnL += profitUSDT;
        db.dailyTrades++;

        const exitPrice = await getPrice(true);
        logTrade(side === "buy" ? "LONG" : "SHORT", entryPrice, exitPrice, "CLOSE", profitUSDT);

        console.log(`\n[OK] POSITION CLOSED: ${reason}`);
        console.log(`   P&L: ${profitUSDT.toFixed(4)} USDT (${profitPercent.toFixed(2)}%)`);
        console.log(`   Daily P&L: ${db.dailyPnL.toFixed(2)} USDT / ${db.dailyTrades} trades`);

        db.activePosition = null;
        await saveDB();
        metrics.trades.closed++;
        if (profitUSDT > 0) metrics.trades.wins++;
        else if (profitUSDT < 0) metrics.trades.losses++;
    } catch (error) {
        console.error("[ERROR] Close position failed:", error.message);
    } finally {
        isClosingPosition = false;
    }
};

// -------------------- UTILITY FUNCTIONS --------------------
const getPrice = async (forceRefresh = false) => {
    try {
        const now = Date.now();
        if (!forceRefresh && now - tickerCache.lastUpdate < TICKER_CACHE_TTL) {
            return tickerCache.price;
        }

        const ticker = await exchange.fetchTicker(db.pair);
        metrics.api.ticker++;
        const latestPrice = toFiniteNumber(ticker?.last, null);
        if (latestPrice) {
            tickerCache.price = latestPrice;
            tickerCache.lastUpdate = now;
        }
        return latestPrice;
    } catch (error) {
        console.error("[ERROR] Failed to get price:", error.message);
        return tickerCache.price;
    }
};

const getOHLCV = async (limit = 100, forceRefresh = false) => {
    const timeframe = db?.breakoutTimeframe || "5m";
    const cacheKey = `${db?.pair || ""}:${timeframe}:${limit}`;
    const now = Date.now();

    if (
        !forceRefresh &&
        ohlcvCache.key === cacheKey &&
        now - ohlcvCache.lastUpdate < OHLCV_CACHE_TTL &&
        Array.isArray(ohlcvCache.data)
    ) {
        return ohlcvCache.data;
    }

    const ohlcv = await exchange.fetchOHLCV(db.pair, timeframe, undefined, limit);
    metrics.api.ohlcv++;
    ohlcvCache = { key: cacheKey, data: ohlcv, lastUpdate: now };
    return ohlcv;
};

// Adaptive tuning is disabled; this function now does nothing if adaptiveEnabled is false
const runAdaptiveConfigTuning = async () => {
    if (!db || !exchange || isAdaptiveTuning) return;
    if (!db.adaptiveEnabled) return; // disabled for new strategy
    isAdaptiveTuning = true;
    try {
        // Original tuning logic for breakout – not used, but kept for compatibility
        // (could be removed or left as is)
        console.log("[ADAPTIVE] Tuning is disabled for breakout ATR strategy.");
    } catch (error) {
        console.error("[ERROR] Adaptive tuning failed:", error.message);
    } finally {
        isAdaptiveTuning = false;
    }
};

const logTrade = (side, entry, exit, status, pnl = 0) => {
    try {
        ensureFileExists(logPath, "timestamp,pair,side,entry,exit,status,pnl,leverage,margin_mode,stop_loss_percent,strategy\n");
        const timestamp = new Date().toISOString();
        const parsedTime = Date.parse(timestamp);
        lastTradeAt = Number.isFinite(parsedTime) ? parsedTime : Date.now();
        const marginMode = (db.marginMode || "isolated").toUpperCase();
        const strategy = db?.activePosition?.strategy || `BREAKOUT_ATR_${String(db.breakoutTimeframe || "5m").toUpperCase()}`;
        const line = `${timestamp},${db.pair},${side},${entry},${exit || ""},${status},${pnl.toFixed(4)},${db.leverage},${marginMode},${db.stopLossPercent},${strategy}\n`;
        fs.appendFileSync(logPath, line);
    } catch (error) {
        console.error("[ERROR] Failed to log trade:", error.message);
    }
};

const getTotalUSDTBalance = async (forceRefresh = false) => {
    try {
        const now = Date.now();
        if (!forceRefresh && now - balanceCache.lastUpdate < BALANCE_CACHE_TTL) {
            return balanceCache.totalUSDT;
        }

        const balance = await exchange.fetchBalance();
        metrics.api.balance++;
        const totalUSDT = Number(balance?.total?.USDT || 0);
        balanceCache.totalUSDT = Number.isFinite(totalUSDT) ? totalUSDT : 0;
        balanceCache.lastUpdate = now;
        return balanceCache.totalUSDT;
    } catch (error) {
        console.error("[ERROR] Failed to fetch balance:", error.message);
        return balanceCache.totalUSDT || 0;
    }
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
    } catch (error) {
        console.error("[ERROR] Failed to read last trade timestamp:", error.message);
        return 0;
    }
};

// -------------------- REAL-TIME PNL MONITORING --------------------
const startPnLMonitoring = () => {
    if (!db) return;
    const desiredInterval = Math.max(200, Math.trunc(toFiniteNumber(db.monitoringInterval, 500)));
    if (pnlMonitorTimer && currentPnLMonitoringInterval === desiredInterval) return;

    if (pnlMonitorTimer) {
        clearInterval(pnlMonitorTimer);
        pnlMonitorTimer = null;
    }

    currentPnLMonitoringInterval = desiredInterval;
    console.log(`[MONITOR] Real-time P&L monitoring interval: ${desiredInterval}ms`);

    const monitorTick = async () => {
        if (isMonitoringPnL) return;
        isMonitoringPnL = true;
        try {
        if (!db || !db.activePosition || isClosingPosition) return;
        const currentPrice = await getPrice();
        if (!currentPrice) return;

        const {
            side,
            entryPrice,
            quantity,
            targetProfitUSDT,
            targetPrice,
            stopLossPrice,
            atrAtEntry,
            highestSinceEntry,
            lowestSinceEntry,
            trailingActivateATR: positionTrailingActivateATR,
            trailingOffsetATR: positionTrailingOffsetATR
        } = db.activePosition;
        if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
            console.error("[ERROR] Invalid active position data for P&L monitoring.");
            return;
        }

        if (!Number.isFinite(db.activePosition.highestSinceEntry)) db.activePosition.highestSinceEntry = entryPrice;
        if (!Number.isFinite(db.activePosition.lowestSinceEntry)) db.activePosition.lowestSinceEntry = entryPrice;
        db.activePosition.highestSinceEntry = Math.max(highestSinceEntry ?? entryPrice, currentPrice);
        db.activePosition.lowestSinceEntry = Math.min(lowestSinceEntry ?? entryPrice, currentPrice);

        if (db.trailingEnabled && Number.isFinite(atrAtEntry) && atrAtEntry > 0) {
            const effectiveTrailingActivateATR = toFiniteNumber(positionTrailingActivateATR, db.trailingActivateATR);
            const effectiveTrailingOffsetATR = toFiniteNumber(positionTrailingOffsetATR, db.trailingOffsetATR);
            const trailActivationMove = effectiveTrailingActivateATR * atrAtEntry;
            const trailOffsetMove = effectiveTrailingOffsetATR * atrAtEntry;
            if (side === "buy") {
                const activated = db.activePosition.highestSinceEntry >= entryPrice + trailActivationMove;
                if (activated) {
                    const trailedStop = db.activePosition.highestSinceEntry - trailOffsetMove;
                    if (!Number.isFinite(db.activePosition.stopLossPrice) || trailedStop > db.activePosition.stopLossPrice) {
                        db.activePosition.stopLossPrice = trailedStop;
                        db.activePosition.stopLossUSDT = -Math.abs(db.activePosition.stopLossPrice - entryPrice) * quantity;
                    }
                }
            } else {
                const activated = db.activePosition.lowestSinceEntry <= entryPrice - trailActivationMove;
                if (activated) {
                    const trailedStop = db.activePosition.lowestSinceEntry + trailOffsetMove;
                    if (!Number.isFinite(db.activePosition.stopLossPrice) || trailedStop < db.activePosition.stopLossPrice) {
                        db.activePosition.stopLossPrice = trailedStop;
                        db.activePosition.stopLossUSDT = -Math.abs(db.activePosition.stopLossPrice - entryPrice) * quantity;
                    }
                }
            }
        }
        const profitUSDT = side === "buy"
            ? (currentPrice - entryPrice) * quantity
            : (entryPrice - currentPrice) * quantity;
        const profitPercent = side === "buy"
            ? ((currentPrice - entryPrice) / entryPrice * 100)
            : ((entryPrice - currentPrice) / entryPrice * 100);

        const targetHit = Number.isFinite(targetPrice) &&
            (side === "buy" ? currentPrice >= targetPrice : currentPrice <= targetPrice);
        const effectiveTargetProfitUSDT = Number.isFinite(targetProfitUSDT) && targetProfitUSDT > 0
            ? targetProfitUSDT
            : db.targetProfitUSDT;
        if (targetHit || profitUSDT >= effectiveTargetProfitUSDT) {
            console.log(`\n[PROFIT] Target hit (+${effectiveTargetProfitUSDT.toFixed(4)} USDT)! Closing...`);
            await closePosition("PROFIT_TARGET", profitUSDT, profitPercent);
            return;
        }

        const effectiveStopLossUSDT = Number.isFinite(db.activePosition.stopLossUSDT)
            ? db.activePosition.stopLossUSDT
            : -db.usdtPerTrade * (db.stopLossPercent / 100);
        const effectiveStopLossPrice = Number.isFinite(db.activePosition.stopLossPrice)
            ? db.activePosition.stopLossPrice
            : stopLossPrice;
        const stopHit = Number.isFinite(effectiveStopLossPrice) &&
            (side === "buy" ? currentPrice <= effectiveStopLossPrice : currentPrice >= effectiveStopLossPrice);
        if (stopHit || profitUSDT <= effectiveStopLossUSDT) {
            console.log(`\n[STOP] Stop loss hit (${effectiveStopLossUSDT.toFixed(4)} USDT)! Closing...`);
            await closePosition("STOP_LOSS", profitUSDT, profitPercent);
            return;
        }

        const nearExit =
            profitUSDT >= (effectiveTargetProfitUSDT * 0.7) ||
            profitUSDT <= (effectiveStopLossUSDT * 0.7);
        const pnlLogInterval = nearExit ? 2000 : 5000;
        if (Date.now() - lastPnlLog > pnlLogInterval) {
            console.log(`\n[PNL] Real-time P&L: ${profitUSDT.toFixed(4)} USDT (${profitPercent.toFixed(2)}%)`);
            lastPnlLog = Date.now();
        }
        } finally {
            isMonitoringPnL = false;
        }
    };

    pnlMonitorTimer = setInterval(monitorTick, desiredInterval);
};

const startPositionSync = () => {
    if (!db) return;
    const desiredInterval = db.activePosition ? 5000 : 15000;
    if (positionSyncTimer && currentPositionSyncInterval === desiredInterval) return;

    if (positionSyncTimer) {
        clearInterval(positionSyncTimer);
        positionSyncTimer = null;
    }

    currentPositionSyncInterval = desiredInterval;
    console.log(`[SYNC] Position sync interval: ${desiredInterval}ms`);

    positionSyncTimer = setInterval(async () => {
        await syncPositionWithExchange();
    }, desiredInterval);
};

const startAdaptiveTuning = () => {
    if (!db?.adaptiveEnabled) {
        if (adaptiveTuneTimer) {
            clearInterval(adaptiveTuneTimer);
            adaptiveTuneTimer = null;
            console.log("[ADAPTIVE] Dynamic config tuning disabled.");
        }
        return;
    }
    if (adaptiveTuneTimer) return;
    runAdaptiveConfigTuning();
    adaptiveTuneTimer = setInterval(async () => {
        await runAdaptiveConfigTuning();
    }, ADAPTIVE_TUNE_INTERVAL);
    console.log(`[ADAPTIVE] Dynamic config tuning active (${Math.round(ADAPTIVE_TUNE_INTERVAL / 60000)}m interval).`);
};

const shutdown = async (signal = "EXIT") => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n[SHUTDOWN] Received ${signal}. Stopping bot...`);
    if (pnlMonitorTimer) clearInterval(pnlMonitorTimer);
    if (positionSyncTimer) clearInterval(positionSyncTimer);
    if (trendTimer) clearInterval(trendTimer);
    if (marketRegimeTimer) clearInterval(marketRegimeTimer);
    if (mainLoopTimer) clearInterval(mainLoopTimer);
    if (metricsTimer) clearInterval(metricsTimer);
    if (adaptiveTuneTimer) clearInterval(adaptiveTuneTimer);

    try {
        await saveDB();
    } catch (error) {
        console.error("[ERROR] Failed to save DB during shutdown:", error.message);
    }

    try {
        await sequelize.close();
    } catch (error) {
        console.error("[ERROR] Failed to close DB connection:", error.message);
    }

    console.log("[SHUTDOWN] Bot stopped.");
    process.exit(0);
};

// -------------------- MAIN LOOP --------------------
(async () => {
    try {
        if (!(await initializeDB())) process.exit(1);

        await initializeExchange();
        await setMarginMode();
        await syncPositionWithExchange();
        await updateTrend();
        await updateMarketRegime();
        trendTimer = setInterval(updateTrend, 15 * 60 * 1000);
        marketRegimeTimer = setInterval(updateMarketRegime, 15 * 60 * 1000);

        startPnLMonitoring();
        startPositionSync();
        startMetricsReporting();
        startAdaptiveTuning();
        process.once("SIGINT", () => { shutdown("SIGINT"); });
        process.once("SIGTERM", () => { shutdown("SIGTERM"); });

        const totalUSDT = await getTotalUSDTBalance(true);

        console.log("\n" + "=".repeat(70));
        console.log("HYBRID DOGE MOMENTUM BOT");
        console.log("=".repeat(70));
        console.log(`Balance: $${totalUSDT.toFixed(2)}`);
        console.log(`Pair: ${db.pair}`);
        console.log(`Strategy: ${db.strategy} | ${db.breakoutTimeframe} | pair ${db.pair}`);
        console.log(`Long: pullback EMA ${db.pullbackEmaPeriod} | lookback ${db.pullbackLookback} | max distance ${db.pullbackMaxDistancePct}% | RSI ${db.rsiLongMin}-${db.rsiLongMax} | vol ${db.minVolumeRatio}x | trend ${db.trendPeriod}`);
        console.log(`Short: breakout ${db.shortBreakoutPeriod} | min range ${db.shortMinRangePercent}% | vol ${db.shortMinVolumeRatio}x | trend ${db.shortTrendPeriod}`);
        console.log(`ATR long: ${db.atrStopMult}/${db.atrTargetMult}x trail ${db.trailingEnabled ? `${db.trailingActivateATR}/${db.trailingOffsetATR}x` : "OFF"}`);
        console.log(`ATR short: ${db.shortAtrStopMult}/${db.shortAtrTargetMult}x trail ${db.trailingEnabled ? `${db.shortTrailingActivateATR}/${db.shortTrailingOffsetATR}x` : "OFF"}`);
        console.log(`Filters: session ${db.sessionStartUTC}-${db.sessionEndUTC} UTC | atr regime ${db.regimeFilterEnabled ? `ON p${db.regimeAtrPercentile}` : "OFF"} | market regime ${db.marketRegimeEnabled ? `${db.marketRegimeSymbol} ${marketRegimeData.state}` : "OFF"}`);
        console.log(`Leverage: ${db.leverage}x`);
        console.log(`Adaptive tuning: ${db.adaptiveEnabled ? "ON" : "OFF"}`);
        console.log(`Daily target: $${db.targetDailyProfit} (max ${db.maxTradesPerDay} trades)`);
        console.log("=".repeat(70) + "\n");

        lastTradeAt = getLastTradeTimestampFromLog();

        mainLoopTimer = setInterval(async () => {
            if (isProcessing) return;
            isProcessing = true;

            try {
                await reloadConfig();
                startPnLMonitoring();
                startPositionSync();
                startAdaptiveTuning();
                if (isPlacingOrder || isClosingPosition) {
                    isProcessing = false;
                    return;
                }

                const now = Date.now();
                if (new Date(now).toDateString() !== new Date(db.lastDailyReset || 0).toDateString()) {
                    console.log("[DAILY] Daily reset");
                    db.dailyPnL = 0;
                    db.dailyTrades = 0;
                    db.lastDailyReset = now;
                    metrics.trades.opened = 0;
                    metrics.trades.closed = 0;
                    metrics.trades.wins = 0;
                    metrics.trades.losses = 0;
                    await saveDB();
                }

                const totalUSDT = await getTotalUSDTBalance();
                const maxDailyLoss = totalUSDT * db.maxDailyLossPercent / 100;

                if (db.dailyPnL >= db.targetDailyProfit) {
                    console.log(`[PAUSE] Daily target reached: $${db.dailyPnL.toFixed(2)}. Trading paused.`);
                    isProcessing = false;
                    return;
                }
                if (db.dailyPnL <= -maxDailyLoss) {
                    console.log(`[PAUSE] Daily loss limit reached: $${db.dailyPnL.toFixed(2)}. Trading paused.`);
                    isProcessing = false;
                    return;
                }
                if (db.dailyTrades >= db.maxTradesPerDay) {
                    console.log(`[PAUSE] Max trades per day (${db.maxTradesPerDay}) reached.`);
                    isProcessing = false;
                    return;
                }

                if (db.activePosition) {
                    isProcessing = false;
                    return;
                }

                if (db.dailyTrades > 0) {
                    const tradeTimestamp = lastTradeAt || getLastTradeTimestampFromLog();
                    if (tradeTimestamp > 0 && Date.now() - tradeTimestamp < db.coolingPeriod) {
                        isProcessing = false;
                        return;
                    }
                }

                const signal = await analyzeSignal();
                if (signal.canLong) await placeOrder("buy", signal);
                else if (signal.canShort) await placeOrder("sell", signal);

            } catch (error) {
                console.error("[ERROR] Loop error:", error.message);
            } finally {
                isProcessing = false;
            }
        }, 2000);

        if (process.stdin.isTTY) {
            process.stdin.setEncoding('utf8');
            process.stdin.on('data', (input) => {
                const cmd = input.toString().trim().toLowerCase();
                if (cmd === 'sync') syncPositionWithExchange();
                else if (cmd === 'status') {
                    console.log(`\n[STATUS] Active=${!!db.activePosition}, Daily P&L=${db.dailyPnL.toFixed(2)} USDT, Trades=${db.dailyTrades}, Adaptive=${db.adaptiveEnabled ? "ON" : "OFF"}`);
                }
            });
        }

    } catch (error) {
        console.error("[ERROR] Bot startup failed:", error.message);
        process.exit(1);
    }
})();
