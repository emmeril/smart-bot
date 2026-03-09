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
    usdtPerTrade: { type: DataTypes.FLOAT, defaultValue: 2 },
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
let lastPositionRuntimePersistAt = 0;
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
const POSITION_RUNTIME_PERSIST_TTL = 2000;
const POSITION_SYNC_QTY_TOLERANCE = 0.001;
const POSITION_SYNC_ENTRY_TOLERANCE_PCT = 0.05;
const BOOLEAN_CONFIG_KEYS = [
    "trendEnabled",
    "adaptiveEnabled",
    "regimeFilterEnabled",
    "breakoutUseCloseConfirm",
    "trailingEnabled",
    "marketRegimeEnabled",
    "allowLong",
    "allowShort"
];
const DEFAULT_CONFIG = {
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
    adaptiveEnabled: false
};

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

const formatAmountToMarketPrecision = (symbol, amount) => {
    const numericAmount = Number(amount);
    if (!exchange || !symbol || !Number.isFinite(numericAmount)) return NaN;
    try {
        return Number.parseFloat(exchange.amountToPrecision(symbol, numericAmount));
    } catch {
        return numericAmount;
    }
};

const formatPriceToMarketPrecision = (symbol, price) => {
    const numericPrice = Number(price);
    if (!exchange || !symbol || !Number.isFinite(numericPrice)) return NaN;
    try {
        return Number.parseFloat(exchange.priceToPrecision(symbol, numericPrice));
    } catch {
        return numericPrice;
    }
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

const resetDailyTradeMetrics = () => {
    metrics.trades.opened = 0;
    metrics.trades.closed = 0;
    metrics.trades.wins = 0;
    metrics.trades.losses = 0;
};

const clearRuntimeTimers = () => {
    const timers = [
        [pnlMonitorTimer, () => { pnlMonitorTimer = null; }],
        [positionSyncTimer, () => { positionSyncTimer = null; }],
        [trendTimer, () => { trendTimer = null; }],
        [marketRegimeTimer, () => { marketRegimeTimer = null; }],
        [mainLoopTimer, () => { mainLoopTimer = null; }],
        [metricsTimer, () => { metricsTimer = null; }],
        [adaptiveTuneTimer, () => { adaptiveTuneTimer = null; }]
    ];

    for (const [timer, resetTimer] of timers) {
        if (!timer) continue;
        clearInterval(timer);
        resetTimer();
    }
};

const printStartupBanner = (totalUSDT) => {
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
};

const hydrateConfig = (config) => {
    const hydrated = { ...config };
    hydrated.activePosition = safeParseJSON(hydrated.activePosition, null);
    return normalizeConfig(hydrated);
};

const serializeConfigForSave = (config) => ({
    ...config,
    activePosition: config.activePosition ? JSON.stringify(config.activePosition) : null,
    lastUpdated: Date.now()
});

const getConfigRow = async () => Config.findOne();

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

    if (config.id) {
        await Config.update(toSave, { where: { id: config.id } });
        return config.id;
    }

    const firstRow = await getConfigRow();
    if (firstRow) {
        config.id = firstRow.id;
        await Config.update(toSave, { where: { id: firstRow.id } });
        return firstRow.id;
    }

    const created = await Config.create(toSave);
    config.id = created.id;
    return created.id;
};

const fetchCloses = async (symbol, timeframe, limit) => {
    metrics.api.trendOhlcv++;
    const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
    return {
        ohlcv,
        closes: Array.isArray(ohlcv) ? ohlcv.map((c) => c[4]) : []
    };
};

const getLatestEma = (closes, period) => {
    const ema = EMA.calculate({ values: closes, period });
    return ema.length > 0 ? ema[ema.length - 1] : null;
};

const deriveMarketRegimeState = (price, fast, slow) => {
    if (price > fast && fast > slow) return "UP-UP";
    if (price < fast && fast < slow) return "DOWN-DOWN";
    return "MIXED";
};

const getSignalParameters = () => {
    const breakoutPeriod = Math.max(2, Math.trunc(db.breakoutPeriod || 20));
    const shortBreakoutPeriod = Math.max(2, Math.trunc(db.shortBreakoutPeriod || breakoutPeriod));
    const volumePeriod = Math.max(2, Math.trunc(db.volumePeriod || 20));
    const atrPeriod = Math.max(2, Math.trunc(db.atrPeriod || 14));
    const regimeLookback = Math.max(20, Math.trunc(db.regimeAtrLookback || 288));
    const pullbackEmaPeriod = Math.max(2, Math.trunc(db.pullbackEmaPeriod || 5));
    const pullbackLookback = Math.max(1, Math.trunc(db.pullbackLookback || 2));
    const shortTrendPeriod = Math.max(2, Math.trunc(db.shortTrendPeriod || 120));
    const longTrendPeriod = Math.max(2, Math.trunc(db.trendPeriod || 80));
    const neededCandles = Math.max(
        breakoutPeriod + 2,
        volumePeriod + 2,
        atrPeriod + 2,
        atrPeriod + regimeLookback + 2,
        pullbackEmaPeriod + pullbackLookback + 5,
        60
    );

    return {
        breakoutPeriod,
        shortBreakoutPeriod,
        volumePeriod,
        atrPeriod,
        regimeLookback,
        pullbackEmaPeriod,
        pullbackLookback,
        shortTrendPeriod,
        longTrendPeriod,
        neededCandles
    };
};

const buildSignalSnapshot = (ohlcv, params) => {
    if (!Array.isArray(ohlcv) || ohlcv.length < 3) {
        return null;
    }

    const open = ohlcv.map((c) => c[1]);
    const high = ohlcv.map((c) => c[2]);
    const low = ohlcv.map((c) => c[3]);
    const close = ohlcv.map((c) => c[4]);
    const volume = ohlcv.map((c) => c[5]);
    const lastIndex = close.length - 2;

    const currentOpen = open[lastIndex];
    const currentHigh = high[lastIndex];
    const currentLow = low[lastIndex];
    const currentPrice = close[lastIndex];
    const currentVolume = volume[lastIndex];
    const recentVolumes = volume.slice(Math.max(0, lastIndex - params.volumePeriod), lastIndex);
    const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / Math.max(recentVolumes.length, 1);
    const safeAvgVolume = avgVolume > 0 ? avgVolume : Number.EPSILON;
    const volumeRatio = currentVolume / safeAvgVolume;
    const volumeOk = volumeRatio >= db.minVolumeRatio;

    const prevHighs = high.slice(lastIndex - params.breakoutPeriod, lastIndex);
    const prevLows = low.slice(lastIndex - params.breakoutPeriod, lastIndex);
    const resistance = Math.max(...prevHighs);
    const support = Math.min(...prevLows);
    const range = resistance - support;
    const shortPrevHighs = high.slice(lastIndex - params.shortBreakoutPeriod, lastIndex);
    const shortPrevLows = low.slice(lastIndex - params.shortBreakoutPeriod, lastIndex);
    const shortResistance = Math.max(...shortPrevHighs);
    const shortSupport = Math.min(...shortPrevLows);
    const shortRange = shortResistance - shortSupport;

    if (!Number.isFinite(range) || range <= 0 || !Number.isFinite(shortRange) || shortRange <= 0) {
        return null;
    }

    const breakoutThreshold = range * db.minBreakoutStrength;
    const shortBreakoutThreshold = shortRange * db.minBreakoutStrength;
    const bullishBreakout = db.breakoutUseCloseConfirm
        ? currentPrice > resistance + breakoutThreshold
        : currentHigh > resistance + breakoutThreshold;
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

    const atrSeries = calcATR(high, low, close, params.atrPeriod);
    const currentATR = atrSeries[lastIndex];
    if (!Number.isFinite(currentATR) || currentATR <= 0) {
        return { invalidAtr: true };
    }

    const rsi = RSI.calculate({ values: close, period: 7 });
    const currentRSI = rsi.length > 0 ? rsi[rsi.length - 1] : 50;
    const prevRSI = rsi.length > 1 ? rsi[rsi.length - 2] : currentRSI;
    const pullbackEmaSeries = EMA.calculate({ values: close, period: params.pullbackEmaPeriod });
    const currentPullbackEma = pullbackEmaSeries.length > 0 ? pullbackEmaSeries[pullbackEmaSeries.length - 1] : null;
    const prevPullbackEma = pullbackEmaSeries.length > 1 ? pullbackEmaSeries[pullbackEmaSeries.length - 2] : currentPullbackEma;
    const longTrendSeries = EMA.calculate({ values: close, period: params.longTrendPeriod });
    const currentLongTrendEma = longTrendSeries.length > 0 ? longTrendSeries[longTrendSeries.length - 1] : trendData.ema;
    const shortTrendSeries = EMA.calculate({ values: close, period: params.shortTrendPeriod });
    const currentShortTrendEma = shortTrendSeries.length > 0 ? shortTrendSeries[shortTrendSeries.length - 1] : trendData.ema;

    return {
        ohlcv,
        open,
        high,
        low,
        close,
        volume,
        lastIndex,
        currentOpen,
        currentHigh,
        currentLow,
        currentPrice,
        currentVolume,
        avgVolume,
        volumeRatio,
        volumeOk,
        resistance,
        support,
        range,
        shortResistance,
        shortSupport,
        shortRange,
        bullishBreakout,
        bearishBreakout,
        rangePercent,
        rangeOk,
        shortRangePercent,
        shortRangeOk,
        hourUTC,
        sessionOk,
        atrSeries,
        currentATR,
        currentRSI,
        prevRSI,
        currentPullbackEma,
        prevPullbackEma,
        currentLongTrendEma,
        currentShortTrendEma
    };
};

const getRegimeState = (snapshot, params) => {
    let regimeOk = true;
    if (db.regimeFilterEnabled) {
        const atrWindow = snapshot.atrSeries
            .slice(Math.max(0, snapshot.lastIndex - params.regimeLookback), snapshot.lastIndex)
            .filter((value) => Number.isFinite(value) && value > 0)
            .sort((a, b) => a - b);
        const atrThreshold = quantile(atrWindow, db.regimeAtrPercentile / 100);
        regimeOk = atrWindow.length >= Math.min(params.regimeLookback, 20) && snapshot.currentATR >= atrThreshold;
    }

    let marketRegimeOkLong = true;
    let marketRegimeOkShort = true;
    if (db.marketRegimeEnabled) {
        marketRegimeOkLong = marketRegimeData.state === "UP-UP";
        marketRegimeOkShort = marketRegimeData.state === "DOWN-DOWN";
    }

    return { regimeOk, marketRegimeOkLong, marketRegimeOkShort };
};

const evaluatePullbackSignal = (snapshot, params, regimeState, strategyMode) => {
    const trendOk = Number.isFinite(snapshot.currentLongTrendEma) ? snapshot.currentPrice > snapshot.currentLongTrendEma : true;
    const recentLow = Math.min(...snapshot.low.slice(Math.max(0, snapshot.lastIndex - params.pullbackLookback), snapshot.lastIndex + 1));
    const touchDistancePct = Number.isFinite(snapshot.currentPullbackEma) && snapshot.currentPullbackEma > 0
        ? Math.abs((recentLow - snapshot.currentPullbackEma) / snapshot.currentPullbackEma) * 100
        : Number.POSITIVE_INFINITY;
    const touchedPullbackZone = Number.isFinite(snapshot.currentPullbackEma) &&
        recentLow <= snapshot.currentPullbackEma &&
        touchDistancePct <= db.pullbackMaxDistancePct;
    const prevClose = snapshot.close[snapshot.lastIndex - 1];
    const reclaim = Number.isFinite(snapshot.prevPullbackEma) &&
        prevClose <= snapshot.prevPullbackEma &&
        snapshot.currentPrice > snapshot.currentPullbackEma;
    const momentumLongOk = snapshot.currentPrice > snapshot.currentOpen &&
        snapshot.currentPrice > prevClose &&
        snapshot.currentRSI > snapshot.prevRSI;

    let canShort = false;
    let setupDetected = touchedPullbackZone || reclaim;
    let detailTitle = "PULLBACK MOMENTUM ANALYSIS";
    const extraDetailLines = [
        `   Pullback EMA (${params.pullbackEmaPeriod}): ${Number.isFinite(snapshot.currentPullbackEma) ? snapshot.currentPullbackEma.toFixed(6) : "n/a"}`,
        `   Recent Low (${params.pullbackLookback}): ${recentLow.toFixed(6)}`,
        `   Pullback Distance: ${Number.isFinite(touchDistancePct) ? touchDistancePct.toFixed(2) : "n/a"}% (max ${db.pullbackMaxDistancePct}%)`,
        `   Pullback Touched: ${touchedPullbackZone ? "[OK]" : "[NO]"}`,
        `   Reclaim EMA: ${reclaim ? "[OK]" : "[NO]"}`,
        `   RSI Momentum: ${momentumLongOk ? "[OK]" : "[NO]"} (${snapshot.currentRSI.toFixed(2)} vs prev ${snapshot.prevRSI.toFixed(2)})`,
        `   Trend EMA Long: ${snapshot.currentLongTrendEma} → Long trend ok: ${trendOk}`
    ];

    const canLong =
        trendOk &&
        touchedPullbackZone &&
        reclaim &&
        snapshot.volumeOk &&
        snapshot.sessionOk &&
        regimeState.regimeOk &&
        regimeState.marketRegimeOkLong &&
        momentumLongOk &&
        snapshot.currentRSI >= db.rsiLongMin &&
        snapshot.currentRSI <= db.rsiLongMax;

    if (strategyMode === "hybrid") {
        const shortTrendOk = Number.isFinite(snapshot.currentShortTrendEma) ? snapshot.currentPrice < snapshot.currentShortTrendEma : true;
        const shortVolumeOk = snapshot.volumeRatio >= toFiniteNumber(db.shortMinVolumeRatio, 1.4);
        const shortMomentumOk = snapshot.currentPrice < snapshot.currentOpen;
        canShort =
            snapshot.bearishBreakout &&
            shortVolumeOk &&
            snapshot.shortRangeOk &&
            snapshot.sessionOk &&
            regimeState.regimeOk &&
            shortTrendOk &&
            regimeState.marketRegimeOkShort &&
            shortMomentumOk &&
            snapshot.currentRSI > 25 &&
            snapshot.currentRSI < 50;
        setupDetected = setupDetected || snapshot.bearishBreakout;
        detailTitle = "HYBRID PULLBACK/BREAKOUT ANALYSIS";
        extraDetailLines.push(`   Short Breakout (${params.shortBreakoutPeriod}): ${snapshot.bearishBreakout ? "[OK]" : "[NO]"}`);
        extraDetailLines.push(`   Short Volume OK: ${shortVolumeOk ? "[OK]" : "[NO]"} (min ${db.shortMinVolumeRatio}x)`);
        extraDetailLines.push(`   Short Range OK: ${snapshot.shortRangeOk ? "[OK]" : "[NO]"} (min ${db.shortMinRangePercent}%)`);
        extraDetailLines.push(`   Trend EMA Short: ${snapshot.currentShortTrendEma} → Short trend ok: ${shortTrendOk}`);
    }

    return { canLong, canShort, setupDetected, detailTitle, extraDetailLines };
};

const evaluateBreakoutSignal = (snapshot, regimeState) => ({
    canLong:
        snapshot.bullishBreakout &&
        snapshot.volumeOk &&
        snapshot.rangeOk &&
        snapshot.sessionOk &&
        regimeState.regimeOk &&
        regimeState.marketRegimeOkLong &&
        snapshot.currentRSI > 50 &&
        snapshot.currentRSI < 75,
    canShort:
        snapshot.bearishBreakout &&
        snapshot.volumeRatio >= toFiniteNumber(db.shortMinVolumeRatio, db.minVolumeRatio) &&
        snapshot.shortRangeOk &&
        snapshot.sessionOk &&
        regimeState.regimeOk &&
        regimeState.marketRegimeOkShort &&
        snapshot.currentRSI > 25 &&
        snapshot.currentRSI < 50,
    setupDetected: snapshot.bullishBreakout || snapshot.bearishBreakout,
    detailTitle: "HYBRID ANALYSIS",
    extraDetailLines: []
});

const applySignalGuards = (signalState, snapshot, strategyMode) => {
    let { canLong, canShort } = signalState;

    if (strategyMode !== "pullback") {
        if (snapshot.currentPrice <= snapshot.currentOpen) canLong = false;
        if (snapshot.currentPrice >= snapshot.currentOpen) canShort = false;
    }

    if (!db.allowLong) canLong = false;
    if (!db.allowShort) canShort = false;

    if (strategyMode !== "pullback" && db.trendEnabled && trendData.ema) {
        if (snapshot.currentPrice <= trendData.ema) canLong = false;
        if (snapshot.currentPrice >= trendData.ema) canShort = false;
    }

    return { ...signalState, canLong, canShort };
};

const logSignalDetails = (strategyMode, params, snapshot, signalState, regimeState) => {
    console.log("\n" + "=".repeat(50));
    console.log(`${signalState.detailTitle} (${db.breakoutTimeframe}):`);
    console.log(`   Current Price: ${snapshot.currentPrice}`);
    if (strategyMode !== "pullback") {
        console.log(`   Resistance (${params.breakoutPeriod}): ${snapshot.resistance.toFixed(6)}`);
        console.log(`   Support (${params.breakoutPeriod}): ${snapshot.support.toFixed(6)}`);
        console.log(`   Range: ${snapshot.range.toFixed(6)} (${snapshot.rangePercent.toFixed(2)}%)`);
    }
    console.log(`   Current Volume: ${snapshot.currentVolume.toFixed(2)}`);
    console.log(`   Avg Volume (${params.volumePeriod}): ${snapshot.avgVolume.toFixed(2)}`);
    console.log(`   Volume Ratio: ${snapshot.volumeRatio.toFixed(2)}x (min ${db.minVolumeRatio}x)`);
    console.log(`   RSI 7: ${snapshot.currentRSI.toFixed(2)}`);
    console.log(`   ATR ${params.atrPeriod}: ${snapshot.currentATR.toFixed(6)}`);
    console.log("");
    console.log("SETUP CONDITIONS:");
    if (strategyMode !== "pullback") {
        console.log(`   Bullish Breakout: ${snapshot.bullishBreakout ? "[OK]" : "[NO]"}`);
        console.log(`   Bearish Breakout: ${snapshot.bearishBreakout ? "[OK]" : "[NO]"}`);
    }
    console.log(`   Volume OK: ${snapshot.volumeOk ? "[OK]" : "[NO]"}`);
    if (strategyMode !== "pullback") {
        console.log(`   Range OK: ${snapshot.rangeOk ? "[OK]" : "[NO]"} (min ${db.minRangePercent}%)`);
    }
    console.log(`   Session OK: ${snapshot.sessionOk ? "[OK]" : "[NO]"} (${db.sessionStartUTC}-${db.sessionEndUTC} UTC, now ${snapshot.hourUTC})`);
    console.log(`   Regime OK: ${regimeState.regimeOk ? "[OK]" : "[NO]"}`);
    if (db.marketRegimeEnabled) {
        console.log(`   Market Regime: ${marketRegimeData.state} (${marketRegimeData.symbol} ${marketRegimeData.timeframe})`);
    }
    signalState.extraDetailLines.forEach((line) => console.log(line));
    if (strategyMode !== "pullback" && db.trendEnabled && trendData.ema) {
        console.log(`   Trend EMA: ${trendData.ema} → Long allowed: ${signalState.canLong}, Short allowed: ${signalState.canShort}`);
    }
    console.log("");
    console.log("FINAL SIGNAL:");
    console.log(`   LONG Signal: ${signalState.canLong ? "[OK] CONFIRMED" : "[NO] NOT CONFIRMED"}`);
    console.log(`   SHORT Signal: ${signalState.canShort ? "[OK] CONFIRMED" : "[NO] NOT CONFIRMED"}`);
    console.log("=".repeat(50));
};

const buildRiskOverrides = (useShortProfile) => useShortProfile
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
    };

const parseSignalOrderData = (signalData) => {
    if (typeof signalData !== "object" || signalData === null) {
        return {
            signalPrice: signalData,
            signalATR: null,
            strategyName: "BREAKOUT_ATR",
            riskOverrides: {}
        };
    }

    return {
        signalPrice: signalData.price,
        signalATR: toFiniteNumber(signalData.atr, null),
        strategyName: signalData.strategy ? String(signalData.strategy) : "BREAKOUT_ATR",
        riskOverrides: signalData.riskOverrides || {}
    };
};

const getOrderFillSnapshot = (order, fallbackPrice, fallbackQuantity) => {
    const filledQuantity = toFiniteNumber(order?.filled, 0);
    const averagePrice = toFiniteNumber(order?.average, 0);
    const orderCost = toFiniteNumber(order?.cost, 0);
    const resolvedQuantity = filledQuantity > 0 ? filledQuantity : fallbackQuantity;
    const resolvedPrice = averagePrice > 0
        ? averagePrice
        : (filledQuantity > 0 && orderCost > 0 ? orderCost / filledQuantity : fallbackPrice);

    return {
        price: resolvedPrice,
        quantity: resolvedQuantity
    };
};

const fetchTrackedExchangePosition = async () => {
    metrics.api.positions++;
    const positions = await exchange.fetchPositions();
    return findOpenExchangePosition(positions, db.pair);
};

const validateOrderSize = (market, quantity, referencePrice) => {
    if (!Number.isFinite(quantity) || quantity <= 0) {
        return { valid: false, reason: "[ERROR] Invalid order quantity after precision adjustment." };
    }

    const minAmount = Number(market?.limits?.amount?.min);
    if (Number.isFinite(minAmount) && quantity < minAmount) {
        return {
            valid: false,
            reason: `[ERROR] Quantity ${quantity} is below exchange minimum ${minAmount}. Order skipped.`
        };
    }

    const notional = quantity * referencePrice;
    const minCost = Number(market?.limits?.cost?.min);
    if (Number.isFinite(minCost) && Number.isFinite(notional) && notional < minCost) {
        return {
            valid: false,
            reason: `[ERROR] Order notional ${notional.toFixed(6)} is below exchange minimum ${minCost}. Order skipped.`
        };
    }

    return { valid: true };
};

const buildOrderPlan = (side, entryPrice, adjustedQty, signalATR, riskOverrides) => {
    const atrStopMult = toFiniteNumber(riskOverrides.atrStopMult, db.atrStopMult);
    const atrTargetMult = toFiniteNumber(riskOverrides.atrTargetMult, db.atrTargetMult);
    const trailingActivateATR = toFiniteNumber(riskOverrides.trailingActivateATR, db.trailingActivateATR);
    const trailingOffsetATR = toFiniteNumber(riskOverrides.trailingOffsetATR, db.trailingOffsetATR);

    let targetProfitUSDT = db.targetProfitUSDT;
    let stopLossUSDT = -db.usdtPerTrade * (db.stopLossPercent / 100);
    let targetPrice;
    let stopLossPrice;

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

    return {
        atrStopMult,
        atrTargetMult,
        trailingActivateATR,
        trailingOffsetATR,
        targetProfitUSDT,
        stopLossUSDT,
        targetPrice: formatPriceToMarketPrecision(db.pair, targetPrice),
        stopLossPrice: formatPriceToMarketPrecision(db.pair, stopLossPrice)
    };
};

const logOrderPlan = (strategyName, entryPrice, adjustedQty, orderPlan) => {
    console.log("   Order Details:");
    console.log(`   - Amount: ${db.usdtPerTrade} USDT × ${db.leverage}x = ${(db.usdtPerTrade * db.leverage).toFixed(2)} USDT`);
    console.log(`   - Quantity: ${adjustedQty} ${db.pair.split('/')[0]}`);
    console.log(`   - Entry Price: ${entryPrice}`);
    console.log(`   - Strategy: ${strategyName}`);
    console.log(`   - Target Profit: ${orderPlan.targetProfitUSDT.toFixed(4)} USDT`);
    console.log(`   - Target Price: ${orderPlan.targetPrice}`);
    console.log(`   - Stop Loss: ${orderPlan.stopLossUSDT.toFixed(4)} USDT`);
    console.log(`   - Stop Loss Price: ${orderPlan.stopLossPrice}`);
    console.log(`   - ATR Risk: stop ${orderPlan.atrStopMult}x | target ${orderPlan.atrTargetMult}x | trail ${orderPlan.trailingActivateATR}/${orderPlan.trailingOffsetATR}x`);
};

const normalizeSymbol = (symbol) => String(symbol || "").toUpperCase().trim();

const getExchangePositionContracts = (position) => {
    const rawContracts = toFiniteNumber(position?.contracts, NaN);
    if (Number.isFinite(rawContracts) && rawContracts !== 0) {
        return rawContracts;
    }

    const rawPositionAmt = toFiniteNumber(position?.info?.positionAmt, NaN);
    if (Number.isFinite(rawPositionAmt) && rawPositionAmt !== 0) {
        return rawPositionAmt;
    }

    return 0;
};

const getExchangePositionSide = (position) => {
    if (position?.side === "long") return "buy";
    if (position?.side === "short") return "sell";

    const contracts = getExchangePositionContracts(position);
    if (contracts > 0) return "buy";
    if (contracts < 0) return "sell";
    return null;
};

const getExchangePositionEntryPrice = (position, fallbackPrice = 0) => {
    const directEntry = toFiniteNumber(position?.entryPrice, NaN);
    if (Number.isFinite(directEntry) && directEntry > 0) {
        return directEntry;
    }

    const infoEntry = toFiniteNumber(position?.info?.entryPrice, NaN);
    if (Number.isFinite(infoEntry) && infoEntry > 0) {
        return infoEntry;
    }

    return fallbackPrice;
};

const findOpenExchangePosition = (positions, pair) => {
    const normalizedPair = normalizeSymbol(pair);
    return positions.find((position) => (
        normalizeSymbol(position.symbol) === normalizedPair &&
        Math.abs(getExchangePositionContracts(position)) > 0
    )) || null;
};

const buildSyncedActivePosition = (openPosition, entryPrice) => {
    const contracts = Math.abs(getExchangePositionContracts(openPosition));
    const side = getExchangePositionSide(openPosition) || "buy";

    return {
        side,
        entryPrice,
        targetPrice: null,
        stopLossPrice: null,
        stopLossUSDT: -db.usdtPerTrade * (db.stopLossPercent / 100),
        orderId: `SYNC_${Date.now()}`,
        quantity: contracts,
        entryTime: Date.now() - 300000,
        highestSinceEntry: entryPrice,
        lowestSinceEntry: entryPrice,
        marginMode: (db.marginMode || "isolated").toLowerCase(),
        targetProfitUSDT: db.targetProfitUSDT,
        strategy: "SYNC_ONLY"
    };
};

const shouldRefreshSyncedPosition = (activePosition, nextPosition) => {
    if (!activePosition) return true;

    const currentQuantity = toFiniteNumber(activePosition.quantity, 0);
    const nextQuantity = toFiniteNumber(nextPosition.quantity, 0);
    const currentEntry = toFiniteNumber(activePosition.entryPrice, 0);
    const nextEntry = toFiniteNumber(nextPosition.entryPrice, 0);
    const quantityChanged = Math.abs(
        currentQuantity - nextQuantity
    ) > POSITION_SYNC_QTY_TOLERANCE;
    const entryDeltaPercent = currentEntry > 0
        ? Math.abs((currentEntry - nextEntry) / currentEntry) * 100
        : 100;
    const entryChanged = entryDeltaPercent > POSITION_SYNC_ENTRY_TOLERANCE_PCT;

    return activePosition.side !== nextPosition.side || quantityChanged || entryChanged;
};

const isSameTrackedPosition = (currentPosition, nextPosition) => {
    if (!currentPosition || !nextPosition) return false;

    const currentQuantity = toFiniteNumber(currentPosition.quantity, 0);
    const nextQuantity = toFiniteNumber(nextPosition.quantity, 0);
    const currentEntry = toFiniteNumber(currentPosition.entryPrice, 0);
    const nextEntry = toFiniteNumber(nextPosition.entryPrice, 0);
    const quantityChanged = Math.abs(currentQuantity - nextQuantity) > POSITION_SYNC_QTY_TOLERANCE;
    const entryDeltaPercent = currentEntry > 0
        ? Math.abs((currentEntry - nextEntry) / currentEntry) * 100
        : 100;

    return (
        currentPosition.side === nextPosition.side &&
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
    if (now - lastPositionRuntimePersistAt < POSITION_RUNTIME_PERSIST_TTL) {
        return;
    }
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
    if (!db.trailingEnabled || !Number.isFinite(position.atrAtEntry) || position.atrAtEntry <= 0) {
        return;
    }

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
    const profitUSDT = position.side === "buy"
        ? (currentPrice - position.entryPrice) * position.quantity
        : (position.entryPrice - currentPrice) * position.quantity;
    const profitPercent = position.side === "buy"
        ? ((currentPrice - position.entryPrice) / position.entryPrice * 100)
        : ((position.entryPrice - currentPrice) / position.entryPrice * 100);

    return { profitUSDT, profitPercent };
};

const getPositionExitTargets = (position) => {
    const effectiveTargetProfitUSDT = Number.isFinite(position.targetProfitUSDT) && position.targetProfitUSDT > 0
        ? position.targetProfitUSDT
        : db.targetProfitUSDT;
    const effectiveStopLossUSDT = Number.isFinite(position.stopLossUSDT)
        ? position.stopLossUSDT
        : -db.usdtPerTrade * (db.stopLossPercent / 100);
    const effectiveStopLossPrice = Number.isFinite(position.stopLossPrice)
        ? position.stopLossPrice
        : position.stopLossPrice;

    return {
        effectiveTargetProfitUSDT,
        effectiveStopLossUSDT,
        effectiveStopLossPrice
    };
};

const evaluatePositionExit = (position, currentPrice, pnlState) => {
    const { effectiveTargetProfitUSDT, effectiveStopLossUSDT, effectiveStopLossPrice } = getPositionExitTargets(position);
    const targetHit = Number.isFinite(position.targetPrice) &&
        (position.side === "buy" ? currentPrice >= position.targetPrice : currentPrice <= position.targetPrice);
    const stopHit = Number.isFinite(effectiveStopLossPrice) &&
        (position.side === "buy" ? currentPrice <= effectiveStopLossPrice : currentPrice >= effectiveStopLossPrice);

    if (targetHit || pnlState.profitUSDT >= effectiveTargetProfitUSDT) {
        return {
            shouldClose: true,
            reason: "PROFIT_TARGET",
            message: `\n[PROFIT] Target hit (+${effectiveTargetProfitUSDT.toFixed(4)} USDT)! Closing...`,
            effectiveTargetProfitUSDT,
            effectiveStopLossUSDT
        };
    }

    if (stopHit || pnlState.profitUSDT <= effectiveStopLossUSDT) {
        return {
            shouldClose: true,
            reason: "STOP_LOSS",
            message: `\n[STOP] Stop loss hit (${effectiveStopLossUSDT.toFixed(4)} USDT)! Closing...`,
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
        pnlState.profitUSDT >= (exitState.effectiveTargetProfitUSDT * 0.7) ||
        pnlState.profitUSDT <= (exitState.effectiveStopLossUSDT * 0.7);
    const pnlLogInterval = nearExit ? 2000 : 5000;

    if (Date.now() - lastPnlLog > pnlLogInterval) {
        console.log(`\n[PNL] Real-time P&L: ${pnlState.profitUSDT.toFixed(4)} USDT (${pnlState.profitPercent.toFixed(2)}%)`);
        lastPnlLog = Date.now();
    }
};

const resetActivePosition = async () => {
    db.activePosition = null;
    await saveDB();
};

const finalizeClosedPosition = async (position, profitUSDT, profitPercent, reason, exitPrice = null) => {
    db.dailyPnL += profitUSDT;
    db.dailyTrades++;

    const resolvedExitPrice = Number.isFinite(exitPrice) && exitPrice > 0 ? exitPrice : await getPrice(true);
    logTrade(position.side === "buy" ? "LONG" : "SHORT", position.entryPrice, resolvedExitPrice, "CLOSE", profitUSDT);

    console.log(`\n[OK] POSITION CLOSED: ${reason}`);
    console.log(`   P&L: ${profitUSDT.toFixed(4)} USDT (${profitPercent.toFixed(2)}%)`);
    console.log(`   Daily P&L: ${db.dailyPnL.toFixed(2)} USDT / ${db.dailyTrades} trades`);

    db.activePosition = null;
    await saveDB();
    metrics.trades.closed++;
    if (profitUSDT > 0) metrics.trades.wins++;
    else if (profitUSDT < 0) metrics.trades.losses++;
};

const mergeRuntimeConfig = (nextConfig) => {
    if (db.activePosition && !nextConfig.activePosition) {
        nextConfig.activePosition = db.activePosition;
    }
    if (isSameTrackedPosition(db.activePosition, nextConfig.activePosition)) {
        nextConfig.activePosition = {
            ...nextConfig.activePosition,
            ...db.activePosition
        };
    }
    if (db.dailyTrades > nextConfig.dailyTrades) {
        nextConfig.dailyPnL = db.dailyPnL;
        nextConfig.dailyTrades = db.dailyTrades;
    }

    Object.keys(nextConfig).forEach((key) => {
        db[key] = nextConfig[key];
    });
};

const configureRecurringTask = (currentTimer, currentInterval, desiredInterval, label, callback, assignTimer, assignInterval) => {
    if (currentTimer && currentInterval === desiredInterval) {
        return currentTimer;
    }

    if (currentTimer) {
        clearInterval(currentTimer);
        assignTimer(null);
    }

    assignInterval(desiredInterval);
    console.log(`${label}${desiredInterval}ms`);
    const nextTimer = setInterval(callback, desiredInterval);
    assignTimer(nextTimer);
    return nextTimer;
};

const isNewTradingDay = (timestamp) => new Date(timestamp).toDateString() !== new Date(db.lastDailyReset || 0).toDateString();

const resetDailyStateIfNeeded = async (now) => {
    if (!isNewTradingDay(now)) return false;

    console.log("[DAILY] Daily reset");
    db.dailyPnL = 0;
    db.dailyTrades = 0;
    db.lastDailyReset = now;
    resetDailyTradeMetrics();
    await saveDB();
    return true;
};

const getDailyRiskLimit = async () => {
    const totalUSDT = await getTotalUSDTBalance();
    if (!Number.isFinite(totalUSDT) || totalUSDT <= 0) {
        return null;
    }
    return totalUSDT * db.maxDailyLossPercent / 100;
};

const getTradingPauseReason = async () => {
    const maxDailyLoss = await getDailyRiskLimit();

    if (db.dailyPnL >= db.targetDailyProfit) {
        return `[PAUSE] Daily target reached: $${db.dailyPnL.toFixed(2)}. Trading paused.`;
    }
    if (Number.isFinite(maxDailyLoss) && db.dailyPnL <= -maxDailyLoss) {
        return `[PAUSE] Daily loss limit reached: $${db.dailyPnL.toFixed(2)}. Trading paused.`;
    }
    if (db.dailyTrades >= db.maxTradesPerDay) {
        return `[PAUSE] Max trades per day (${db.maxTradesPerDay}) reached.`;
    }

    return null;
};

const isCoolingDown = () => {
    if (db.dailyTrades <= 0) return false;

    const tradeTimestamp = lastTradeAt || getLastTradeTimestampFromLog();
    return tradeTimestamp > 0 && Date.now() - tradeTimestamp < db.coolingPeriod;
};

const refreshRuntimeSchedulers = () => {
    startPnLMonitoring();
    startPositionSync();
    startAdaptiveTuning();
};

const handleRuntimeCommand = (input) => {
    const cmd = input.toString().trim().toLowerCase();
    if (cmd === "sync") {
        syncPositionWithExchange();
        return;
    }

    if (cmd === "status") {
        console.log(`\n[STATUS] Active=${!!db.activePosition}, Daily P&L=${db.dailyPnL.toFixed(2)} USDT, Trades=${db.dailyTrades}, Adaptive=${db.adaptiveEnabled ? "ON" : "OFF"}`);
    }
};

const registerRuntimeCommands = () => {
    if (!process.stdin.isTTY) return;

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", handleRuntimeCommand);
};

const startMarketDataLoops = () => {
    trendTimer = setInterval(updateTrend, 15 * 60 * 1000);
    marketRegimeTimer = setInterval(updateMarketRegime, 15 * 60 * 1000);
};

const bootstrapRuntime = async () => {
    await initializeExchange();
    await setMarginMode();
    await syncPositionWithExchange();
    await updateTrend();
    await updateMarketRegime();
    startMarketDataLoops();
    startPnLMonitoring();
    startPositionSync();
    startMetricsReporting();
    startAdaptiveTuning();
    process.once("SIGINT", () => { shutdown("SIGINT"); });
    process.once("SIGTERM", () => { shutdown("SIGTERM"); });
};

const runTradingCycle = async () => {
    await reloadConfig();
    refreshRuntimeSchedulers();

    if (isPlacingOrder || isClosingPosition) return;

    await resetDailyStateIfNeeded(Date.now());

    const pauseReason = await getTradingPauseReason();
    if (pauseReason) {
        console.log(pauseReason);
        return;
    }

    if (db.activePosition || isCoolingDown()) return;

    const signal = await analyzeSignal();
    if (signal.canLong) await placeOrder("buy", signal);
    else if (signal.canShort) await placeOrder("sell", signal);
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
    ...DEFAULT_CONFIG,
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

    BOOLEAN_CONFIG_KEYS.forEach(normalizeBoolean);

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

        const configRow = await ensureConfigRow();
        db = hydrateConfig(configRow.toJSON());
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
        const normalizedConfig = await loadPersistedConfig();
        if (!normalizedConfig) return false;
        mergeRuntimeConfig(normalizedConfig);
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
        await persistConfig(db);
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
        const openPosition = await fetchTrackedExchangePosition();

        if (!openPosition) {
            if (db.activePosition) {
                console.log("[WARN] DB has activePosition but exchange doesn't. Resetting...");
                await resetActivePosition();
            }
            return;
        }

        const entryPrice = getExchangePositionEntryPrice(openPosition, await getPrice());
        const syncedPosition = buildSyncedActivePosition(openPosition, entryPrice);

        if (shouldRefreshSyncedPosition(db.activePosition, syncedPosition)) {
            const wasTrackingPosition = !!db.activePosition;
            db.activePosition = syncedPosition;
            await saveDB();
            console.log(wasTrackingPosition
                ? "[OK] Refreshed activePosition from exchange data"
                : "[OK] Created activePosition from exchange data");
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
        const { ohlcv, closes } = await fetchCloses(db.pair, timeframe, period + 10);
        if (ohlcv.length < period) {
            console.log(`[WARN] Not enough data for trend EMA (${ohlcv.length} < ${period})`);
            return;
        }
        const latestEma = getLatestEma(closes, period);
        if (Number.isFinite(latestEma)) {
            trendData.ema = latestEma;
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
        const { ohlcv, closes } = await fetchCloses(symbol, timeframe, slowPeriod + 10);
        if (!Array.isArray(ohlcv) || ohlcv.length < slowPeriod) {
            console.log(`[WARN] Not enough data for market regime (${symbol} ${timeframe})`);
            return;
        }

        const fast = getLatestEma(closes, fastPeriod);
        const slow = getLatestEma(closes, slowPeriod);
        if (!Number.isFinite(fast) || !Number.isFinite(slow)) return;

        const price = closes[closes.length - 1];
        const state = deriveMarketRegimeState(price, fast, slow);

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

        const params = getSignalParameters();
        const ohlcv = await getOHLCV(params.neededCandles);
        if (ohlcv.length < params.neededCandles) {
            console.log(`[WARN] Not enough OHLCV data: ${ohlcv.length} < ${params.neededCandles}`);
            return {};
        }

        const snapshot = buildSignalSnapshot(ohlcv, params);
        if (!snapshot) {
            console.log("[WARN] Invalid setup range");
            return {};
        }
        if (snapshot.invalidAtr) {
            console.log("[WARN] ATR is not ready");
            return {};
        }

        const regimeState = getRegimeState(snapshot, params);
        const baseSignalState = strategyMode === "pullback" || strategyMode === "hybrid"
            ? evaluatePullbackSignal(snapshot, params, regimeState, strategyMode)
            : evaluateBreakoutSignal(snapshot, regimeState);
        const signalState = applySignalGuards(baseSignalState, snapshot, strategyMode);

        if (signalState.setupDetected) metrics.signals.crossoverDetected++;
        if (signalState.canLong) metrics.signals.longConfirmed++;
        if (signalState.canShort) metrics.signals.shortConfirmed++;

        const shouldDetailLog = signalState.setupDetected || (Date.now() - lastSignalDetailLogAt >= SIGNAL_DETAIL_LOG_TTL);

        if (shouldDetailLog) {
            logSignalDetails(strategyMode, params, snapshot, signalState, regimeState);
            lastSignalDetailLogAt = Date.now();
        }

        return {
            canLong: signalState.canLong,
            canShort: signalState.canShort,
            price: snapshot.currentPrice,
            rsi: snapshot.currentRSI,
            atr: snapshot.currentATR,
            rangePercent: snapshot.rangePercent,
            resistance: snapshot.resistance,
            support: snapshot.support,
            hasSignal: signalState.setupDetected,
            strategy: strategyMode === "hybrid"
                ? (signalState.canShort ? "BREAKOUT_SHORT_ATR" : "PULLBACK_LONG_ATR")
                : (strategyMode === "pullback" ? "PULLBACK_ATR" : "BREAKOUT_ATR"),
            riskOverrides: buildRiskOverrides(signalState.canShort)
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

        const { signalPrice, signalATR, strategyName, riskOverrides } = parseSignalOrderData(signalData);
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
        const adjustedQty = formatAmountToMarketPrecision(db.pair, qty);
        const sizeValidation = validateOrderSize(market, adjustedQty, tickerPrice);
        if (!sizeValidation.valid) {
            console.error(sizeValidation.reason);
            return;
        }

        const orderPlan = buildOrderPlan(side, entryPrice, adjustedQty, signalATR, riskOverrides);
        logOrderPlan(strategyName, entryPrice, adjustedQty, orderPlan);

        const order = await exchange.createOrder(db.pair, "market", side, adjustedQty, undefined, {
            marginMode: (db.marginMode || "isolated").toLowerCase()
        });
        metrics.api.orders++;
        const fillSnapshot = getOrderFillSnapshot(order, tickerPrice, adjustedQty);
        const actualEntryPrice = fillSnapshot.price;
        const actualQuantity = fillSnapshot.quantity;
        const actualOrderPlan = buildOrderPlan(side, actualEntryPrice, actualQuantity, signalATR, riskOverrides);

        db.activePosition = {
            side: side,
            entryPrice: actualEntryPrice,
            targetPrice: actualOrderPlan.targetPrice,
            stopLossPrice: actualOrderPlan.stopLossPrice,
            stopLossUSDT: actualOrderPlan.stopLossUSDT,
            orderId: order.id,
            quantity: actualQuantity,
            entryTime: Date.now(),
            highestSinceEntry: actualEntryPrice,
            lowestSinceEntry: actualEntryPrice,
            marginMode: (db.marginMode || "isolated").toLowerCase(),
            targetProfitUSDT: actualOrderPlan.targetProfitUSDT,
            atrAtEntry: signalATR,
            strategy: strategyName,
            trailingActivateATR: actualOrderPlan.trailingActivateATR,
            trailingOffsetATR: actualOrderPlan.trailingOffsetATR
        };

        await saveDB();
        logTrade(side === "buy" ? "LONG" : "SHORT", actualEntryPrice, null, "OPEN");
        metrics.trades.opened++;

        console.log(`\n[OK] ORDER PLACED: ${side.toUpperCase()} at ${actualEntryPrice}`);
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
        const position = { ...db.activePosition };
        const { side, quantity } = position;
        if (!Number.isFinite(quantity) || quantity <= 0) {
            console.error("[ERROR] Invalid position quantity. Resetting activePosition.");
            await resetActivePosition();
            return;
        }
        const closeSide = side === "buy" ? "sell" : "buy";

        console.log(`\n[CLOSE] Closing position...`);
        const closeOrder = await exchange.createOrder(db.pair, "market", closeSide, quantity, undefined, {
            reduceOnly: true,
            marginMode: (db.marginMode || "isolated").toLowerCase()
        });
        metrics.api.orders++;
        const closeFillSnapshot = getOrderFillSnapshot(closeOrder, await getPrice(true), quantity);
        const remainingPosition = await fetchTrackedExchangePosition();
        if (remainingPosition) {
            const remainingContracts = Math.abs(getExchangePositionContracts(remainingPosition));
            if (remainingContracts > POSITION_SYNC_QTY_TOLERANCE) {
                const remainingEntryPrice = getExchangePositionEntryPrice(remainingPosition, position.entryPrice);
                db.activePosition = buildSyncedActivePosition(remainingPosition, remainingEntryPrice);
                await saveDB();
                console.warn(`[WARN] Close order partially filled. Remaining quantity on exchange: ${remainingContracts}`);
                return;
            }
        }

        const realizedPnL = calculatePositionPnL(position, closeFillSnapshot.price);

        await finalizeClosedPosition(
            position,
            realizedPnL.profitUSDT,
            realizedPnL.profitPercent,
            reason,
            closeFillSnapshot.price
        );
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

    const monitorTick = async () => {
        if (isMonitoringPnL) return;
        isMonitoringPnL = true;
        try {
            if (!db || !db.activePosition || isClosingPosition) return;
            const currentPrice = await getPrice();
            if (!currentPrice) return;

            const position = db.activePosition;
            if (!Number.isFinite(position.entryPrice) || position.entryPrice <= 0 || !Number.isFinite(position.quantity) || position.quantity <= 0) {
                console.error("[ERROR] Invalid active position data for P&L monitoring.");
                return;
            }

            const previousRuntimeState = snapshotPositionRuntimeState(position);
            updateActivePositionExtremes(position, currentPrice);
            applyTrailingStopUpdate(position);
            if (didPositionRuntimeStateChange(previousRuntimeState, position)) {
                await maybePersistActivePositionRuntimeState();
            }

            const pnlState = calculatePositionPnL(position, currentPrice);
            const exitState = evaluatePositionExit(position, currentPrice, pnlState);

            if (exitState.shouldClose) {
                console.log(exitState.message);
                await closePosition(exitState.reason, pnlState.profitUSDT, pnlState.profitPercent);
                return;
            }

            maybeLogPositionPnL(pnlState, exitState);
        } finally {
            isMonitoringPnL = false;
        }
    };

    configureRecurringTask(
        pnlMonitorTimer,
        currentPnLMonitoringInterval,
        desiredInterval,
        "[MONITOR] Real-time P&L monitoring interval: ",
        monitorTick,
        (timer) => { pnlMonitorTimer = timer; },
        (interval) => { currentPnLMonitoringInterval = interval; }
    );
};

const startPositionSync = () => {
    if (!db) return;
    const desiredInterval = db.activePosition ? 5000 : 15000;
    configureRecurringTask(
        positionSyncTimer,
        currentPositionSyncInterval,
        desiredInterval,
        "[SYNC] Position sync interval: ",
        async () => {
            await syncPositionWithExchange();
        },
        (timer) => { positionSyncTimer = timer; },
        (interval) => { currentPositionSyncInterval = interval; }
    );
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
    clearRuntimeTimers();

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

        await bootstrapRuntime();

        const totalUSDT = await getTotalUSDTBalance(true);

        printStartupBanner(totalUSDT);

        lastTradeAt = getLastTradeTimestampFromLog();

        mainLoopTimer = setInterval(async () => {
            if (isProcessing) return;
            isProcessing = true;

            try {
                await runTradingCycle();
            } catch (error) {
                console.error("[ERROR] Loop error:", error.message);
            } finally {
                isProcessing = false;
            }
        }, 2000);

        registerRuntimeCommands();

    } catch (error) {
        console.error("[ERROR] Bot startup failed:", error.message);
        process.exit(1);
    }
})();
