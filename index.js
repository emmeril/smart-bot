require("dotenv").config();
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
    strategy: { type: DataTypes.STRING, defaultValue: "ema_crossover" },
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

    // EMA Crossover parameters
    fastEMAPeriod: { type: DataTypes.INTEGER, defaultValue: 9 },
    slowEMAPeriod: { type: DataTypes.INTEGER, defaultValue: 21 },
    trendEMAPeriod: { type: DataTypes.INTEGER, defaultValue: 200 },
    rsiPeriod: { type: DataTypes.INTEGER, defaultValue: 14 },
    rsiOverbought: { type: DataTypes.FLOAT, defaultValue: 70 },
    rsiOversold: { type: DataTypes.FLOAT, defaultValue: 30 },
    useTrendFilter: { type: DataTypes.BOOLEAN, defaultValue: true },

    // Additional parameters (still used)
    breakoutTimeframe: { type: DataTypes.STRING, defaultValue: "5m" },
    sessionStartUTC: { type: DataTypes.INTEGER, defaultValue: 0 },
    sessionEndUTC: { type: DataTypes.INTEGER, defaultValue: 23 },
    volumePeriod: { type: DataTypes.INTEGER, defaultValue: 20 },
    minVolumeRatio: { type: DataTypes.FLOAT, defaultValue: 1.3 },
    maxPriceDeviationPercent: { type: DataTypes.FLOAT, defaultValue: 0.5 },
    atrPeriod: { type: DataTypes.INTEGER, defaultValue: 14 },
    atrStopMult: { type: DataTypes.FLOAT, defaultValue: 1.4 },
    atrTargetMult: { type: DataTypes.FLOAT, defaultValue: 1.6 },
    shortAtrStopMult: { type: DataTypes.FLOAT, defaultValue: 1.4 },
    shortAtrTargetMult: { type: DataTypes.FLOAT, defaultValue: 1.6 },
    trailingEnabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    trailingActivateATR: { type: DataTypes.FLOAT, defaultValue: 1.2 },
    trailingOffsetATR: { type: DataTypes.FLOAT, defaultValue: 0.6 },
    shortTrailingActivateATR: { type: DataTypes.FLOAT, defaultValue: 1.0 },
    shortTrailingOffsetATR: { type: DataTypes.FLOAT, defaultValue: 0.8 },
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
let mainLoopTimer = null;
let metricsTimer = null;
let lastSignalDetailLogAt = 0;
let lastSyncLogAt = 0;
let isShuttingDown = false;
const logPath = path.join(__dirname, 'trades.csv');
let db = null;
const BALANCE_CACHE_TTL = 15000;
const TICKER_CACHE_TTL = 800;
const OHLCV_CACHE_TTL = 1500;
const SYNC_LOG_TTL = 15000;
const SIGNAL_DETAIL_LOG_TTL = 10000;
const METRICS_LOG_INTERVAL = 60000;
const POSITION_RUNTIME_PERSIST_TTL = 2000;
const POSITION_SYNC_QTY_TOLERANCE = 0.001;
const POSITION_SYNC_ENTRY_TOLERANCE_PCT = 0.05;
const BOOLEAN_CONFIG_KEYS = [
    "useTrendFilter",
    "trailingEnabled",
    "allowLong",
    "allowShort"
];
const DEFAULT_CONFIG = {
    strategy: "ema_crossover",
    pair: "DOGE/USDT:USDT",
    usdtPerTrade: 2,
    leverage: 10,
    targetProfitUSDT: 0.5,
    targetDailyProfit: 1.0,
    maxDailyLossPercent: 10,
    maxTradesPerDay: 20,
    coolingPeriod: 3000,
    activePosition: null,
    dailyPnL: 0,
    dailyTrades: 0,
    marginMode: "isolated",
    monitoringInterval: 500,
    stopLossPercent: 5,
    fastEMAPeriod: 9,
    slowEMAPeriod: 21,
    trendEMAPeriod: 200,
    rsiPeriod: 14,
    rsiOverbought: 70,
    rsiOversold: 30,
    useTrendFilter: true,
    breakoutTimeframe: "5m",
    sessionStartUTC: 0,
    sessionEndUTC: 23,
    volumePeriod: 20,
    minVolumeRatio: 1.3,
    maxPriceDeviationPercent: 0.5,
    atrPeriod: 14,
    atrStopMult: 1.4,
    atrTargetMult: 1.6,
    shortAtrStopMult: 1.4,
    shortAtrTargetMult: 1.6,
    trailingEnabled: true,
    trailingActivateATR: 1.2,
    trailingOffsetATR: 0.6,
    shortTrailingActivateATR: 1.0,
    shortTrailingOffsetATR: 0.8,
    allowLong: true,
    allowShort: true
};

let metrics = {
    windowStart: Date.now(),
    api: { ticker: 0, ohlcv: 0, balance: 0, positions: 0, orders: 0 },
    signals: { analyzed: 0, crossoverDetected: 0, longConfirmed: 0, shortConfirmed: 0 },
    trades: { opened: 0, closed: 0, wins: 0, losses: 0 }
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
    console.log("\n" + "=".repeat(70));
    console.log("EMA CROSSOVER + RSI BOT");
    console.log("=".repeat(70));
    console.log(`Balance: $${totalUSDT.toFixed(2)}`);
    console.log(`Pair: ${db.pair}`);
    console.log(`Strategy: EMA Crossover (fast ${db.fastEMAPeriod}, slow ${db.slowEMAPeriod}, trend ${db.trendEMAPeriod}) on ${db.breakoutTimeframe}`);
    console.log(`RSI: period ${db.rsiPeriod}, overbought ${db.rsiOverbought}, oversold ${db.rsiOversold}`);
    console.log(`Volume filter: ${db.minVolumeRatio}x over ${db.volumePeriod} periods`);
    console.log(`Session: ${db.sessionStartUTC}-${db.sessionEndUTC} UTC`);
    console.log(`ATR: stop ${db.atrStopMult}x, target ${db.atrTargetMult}x, trailing ${db.trailingEnabled ? `${db.trailingActivateATR}/${db.trailingOffsetATR}x` : "OFF"}`);
    console.log(`Leverage: ${db.leverage}x`);
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

const getSignalParameters = () => {
    const fastEMAPeriod = Math.max(2, Math.trunc(db.fastEMAPeriod || 9));
    const slowEMAPeriod = Math.max(fastEMAPeriod + 1, Math.trunc(db.slowEMAPeriod || 21));
    const trendEMAPeriod = Math.max(2, Math.trunc(db.trendEMAPeriod || 200));
    const rsiPeriod = Math.max(2, Math.trunc(db.rsiPeriod || 14));
    const volumePeriod = Math.max(2, Math.trunc(db.volumePeriod || 20));
    const atrPeriod = Math.max(2, Math.trunc(db.atrPeriod || 14));
    const neededCandles = Math.max(
        slowEMAPeriod + 10, trendEMAPeriod + 10, rsiPeriod + 10, volumePeriod + 10, atrPeriod + 10, 100
    );

    return { fastEMAPeriod, slowEMAPeriod, trendEMAPeriod, rsiPeriod, volumePeriod, atrPeriod, neededCandles };
};

const evaluateCrossoverSignal = (snapshot, params) => {
    const { close, lastIndex, currentPrice, currentVolume, avgVolume, hourUTC } = snapshot;
    const signalClose = Array.isArray(close) ? close.slice(0, lastIndex + 1) : [];
    if (signalClose.length < Math.max(params.slowEMAPeriod, params.trendEMAPeriod, params.rsiPeriod) + 2) {
        return {
            canLong: false, canShort: false, setupDetected: false,
            detailTitle: "EMA CROSSOVER ANALYSIS", extraDetailLines: ["   Not enough candle data to evaluate."]
        };
    }
    
    // Calculate EMAs
    const fastEMA = EMA.calculate({ values: signalClose, period: params.fastEMAPeriod });
    const slowEMA = EMA.calculate({ values: signalClose, period: params.slowEMAPeriod });
    const trendEMA = EMA.calculate({ values: signalClose, period: params.trendEMAPeriod });
    
    // Get current and previous values
    const currentFast = fastEMA[fastEMA.length - 1];
    const prevFast = fastEMA[fastEMA.length - 2];
    const currentSlow = slowEMA[slowEMA.length - 1];
    const prevSlow = slowEMA[slowEMA.length - 2];
    const currentTrend = trendEMA[trendEMA.length - 1];
    
    // Gunakan RSI yang sudah di-cache dari snapshot
    const currentRSI = snapshot.currentRSI;
    
    // Volume ratio
    const volumeRatio = currentVolume / (avgVolume || 1);
    const volumeOk = volumeRatio >= db.minVolumeRatio;
    
    // Session filter
    const sessionOk = db.sessionStartUTC <= db.sessionEndUTC
        ? hourUTC >= db.sessionStartUTC && hourUTC <= db.sessionEndUTC
        : hourUTC >= db.sessionStartUTC || hourUTC <= db.sessionEndUTC;
    
    // Crossover detection
    const bullishCrossover = currentFast > currentSlow && prevFast <= prevSlow;
    const bearishCrossover = currentFast < currentSlow && prevFast >= prevSlow;
    
    // Trend filter
    const trendOkLong = !db.useTrendFilter || currentPrice > currentTrend;
    const trendOkShort = !db.useTrendFilter || currentPrice < currentTrend;
    
    // RSI filter
    const rsiOkLong = currentRSI < db.rsiOverbought;
    const rsiOkShort = currentRSI > db.rsiOversold;
    
    // Final signals
    const canLong = db.allowLong && bullishCrossover && volumeOk && sessionOk && trendOkLong && rsiOkLong;
    const canShort = db.allowShort && bearishCrossover && volumeOk && sessionOk && trendOkShort && rsiOkShort;
    
    const setupDetected = bullishCrossover || bearishCrossover;
    
    return {
        canLong,
        canShort,
        setupDetected,
        detailTitle: "EMA CROSSOVER ANALYSIS",
        extraDetailLines: [
            `   Fast EMA (${params.fastEMAPeriod}): ${currentFast.toFixed(6)} (prev ${prevFast.toFixed(6)})`,
            `   Slow EMA (${params.slowEMAPeriod}): ${currentSlow.toFixed(6)} (prev ${prevSlow.toFixed(6)})`,
            `   Trend EMA (${params.trendEMAPeriod}): ${currentTrend.toFixed(6)}`,
            `   Bullish Crossover: ${bullishCrossover ? "[OK]" : "[NO]"}`,
            `   Bearish Crossover: ${bearishCrossover ? "[OK]" : "[NO]"}`,
            `   Volume Ratio: ${volumeRatio.toFixed(2)}x (min ${db.minVolumeRatio}x) -> ${volumeOk ? "[OK]" : "[NO]"}`,
            `   RSI (${params.rsiPeriod}): ${currentRSI.toFixed(2)} -> Long OK: ${rsiOkLong}, Short OK: ${rsiOkShort}`,
            `   Trend Filter: Long ${trendOkLong ? "[OK]" : "[NO]"}, Short ${trendOkShort ? "[OK]" : "[NO]"}`
        ]
    };
};

const applySignalGuards = (signalState, snapshot) => {
    let { canLong, canShort } = signalState;
    if (snapshot.currentPrice <= snapshot.currentOpen) canLong = false;
    if (snapshot.currentPrice >= snapshot.currentOpen) canShort = false;
    return { ...signalState, canLong, canShort };
};

const logSignalDetails = (params, snapshot, signalState) => {
    console.log("\n" + "=".repeat(50));
    console.log(`${signalState.detailTitle} (${db.breakoutTimeframe}):`);
    console.log(`   Current Price: ${snapshot.currentPrice}`);
    console.log(`   Current Volume: ${snapshot.currentVolume.toFixed(2)}`);
    console.log(`   Avg Volume (${params.volumePeriod}): ${snapshot.avgVolume.toFixed(2)}`);
    console.log(`   Volume Ratio: ${snapshot.volumeRatio.toFixed(2)}x`);
    console.log(`   RSI ${params.rsiPeriod}: ${snapshot.currentRSI.toFixed(2)}`);
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
        return { signalPrice: signalData, signalATR: null, strategyName: "EMA_CROSSOVER", riskOverrides: {} };
    }
    return {
        signalPrice: signalData.price,
        signalATR: toFiniteNumber(signalData.atr, null),
        strategyName: signalData.strategy ? String(signalData.strategy) : "EMA_CROSSOVER",
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
    return { price: resolvedPrice, quantity: resolvedQuantity };
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
        return { valid: false, reason: `[ERROR] Quantity ${quantity} is below exchange minimum ${minAmount}. Order skipped.` };
    }
    const notional = quantity * referencePrice;
    const minCost = Number(market?.limits?.cost?.min);
    if (Number.isFinite(minCost) && Number.isFinite(notional) && notional < minCost) {
        return { valid: false, reason: `[ERROR] Order notional ${notional.toFixed(6)} is below exchange minimum ${minCost}. Order skipped.` };
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
        atrStopMult, atrTargetMult, trailingActivateATR, trailingOffsetATR,
        targetProfitUSDT, stopLossUSDT,
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
    if (Number.isFinite(rawContracts) && rawContracts !== 0) return rawContracts;
    const rawPositionAmt = toFiniteNumber(position?.info?.positionAmt, NaN);
    if (Number.isFinite(rawPositionAmt) && rawPositionAmt !== 0) return rawPositionAmt;
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
    if (Number.isFinite(directEntry) && directEntry > 0) return directEntry;
    const infoEntry = toFiniteNumber(position?.info?.entryPrice, NaN);
    if (Number.isFinite(infoEntry) && infoEntry > 0) return infoEntry;
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
        side, entryPrice, targetPrice: null, stopLossPrice: null,
        stopLossUSDT: -db.usdtPerTrade * (db.stopLossPercent / 100),
        orderId: `SYNC_${Date.now()}`, quantity: contracts,
        entryTime: Date.now() - 300000, highestSinceEntry: entryPrice, lowestSinceEntry: entryPrice,
        marginMode: (db.marginMode || "isolated").toLowerCase(),
        targetProfitUSDT: db.targetProfitUSDT, strategy: "SYNC_ONLY"
    };
};

const shouldRefreshSyncedPosition = (activePosition, nextPosition) => {
    if (!activePosition) return true;
    const currentQuantity = toFiniteNumber(activePosition.quantity, 0);
    const nextQuantity = toFiniteNumber(nextPosition.quantity, 0);
    const currentEntry = toFiniteNumber(activePosition.entryPrice, 0);
    const nextEntry = toFiniteNumber(nextPosition.entryPrice, 0);
    const quantityChanged = Math.abs(currentQuantity - nextQuantity) > POSITION_SYNC_QTY_TOLERANCE;
    const entryDeltaPercent = currentEntry > 0 ? Math.abs((currentEntry - nextEntry) / currentEntry) * 100 : 100;
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
    const entryDeltaPercent = currentEntry > 0 ? Math.abs((currentEntry - nextEntry) / currentEntry) * 100 : 100;
    return (currentPosition.side === nextPosition.side && !quantityChanged && entryDeltaPercent <= POSITION_SYNC_ENTRY_TOLERANCE_PCT);
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
    if (!db.trailingEnabled || !Number.isFinite(position.atrAtEntry) || position.atrAtEntry <= 0) return;
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
        
    // PERBAIKAN: Hitung profitPercent dengan Leverage (ROE)
    const marginUsed = (position.entryPrice * position.quantity) / (db.leverage || 10);
    const profitPercent = marginUsed > 0 ? (profitUSDT / marginUsed) * 100 : 0;

    return { profitUSDT, profitPercent };
};

const getPositionExitTargets = (position) => {
    const effectiveTargetProfitUSDT = Number.isFinite(position.targetProfitUSDT) && position.targetProfitUSDT > 0
        ? position.targetProfitUSDT
        : db.targetProfitUSDT;
    const fallbackStopLossUSDT = -Math.abs(db.usdtPerTrade * (db.stopLossPercent / 100));
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

const evaluatePositionExit = (position, currentPrice, pnlState) => {
    const { effectiveTargetProfitUSDT, effectiveStopLossUSDT, effectiveStopLossPrice } = getPositionExitTargets(position);
    const targetHit = Number.isFinite(position.targetPrice) &&
        (position.side === "buy" ? currentPrice >= position.targetPrice : currentPrice <= position.targetPrice);
    const stopHit = Number.isFinite(effectiveStopLossPrice) &&
        (position.side === "buy" ? currentPrice <= effectiveStopLossPrice : currentPrice >= effectiveStopLossPrice);

    if (targetHit || pnlState.profitUSDT >= effectiveTargetProfitUSDT) {
        return {
            shouldClose: true, reason: "PROFIT_TARGET",
            message: `\n[PROFIT] Target hit (+${effectiveTargetProfitUSDT.toFixed(4)} USDT)! Closing...`,
            effectiveTargetProfitUSDT, effectiveStopLossUSDT
        };
    }

    if (stopHit || pnlState.profitUSDT <= effectiveStopLossUSDT) {
        return {
            shouldClose: true, reason: "STOP_LOSS",
            message: `\n[STOP] Stop loss hit (${effectiveStopLossUSDT.toFixed(4)} USDT)! Closing...`,
            effectiveTargetProfitUSDT, effectiveStopLossUSDT
        };
    }

    return { shouldClose: false, effectiveTargetProfitUSDT, effectiveStopLossUSDT };
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
        nextConfig.activePosition = { ...nextConfig.activePosition, ...db.activePosition };
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

// PERBAIKAN: Gunakan ISOString untuk konsistensi reset dengan zona waktu UTC
const isNewTradingDay = (timestamp) => {
    const todayUTC = new Date(timestamp).toISOString().split('T')[0];
    const lastResetUTC = new Date(db.lastDailyReset || 0).toISOString().split('T')[0];
    return todayUTC !== lastResetUTC;
};

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
    if (!Number.isFinite(totalUSDT) || totalUSDT <= 0) return null;
    return totalUSDT * db.maxDailyLossPercent / 100;
};

const getTradingPauseReason = async () => {
    const maxDailyLoss = await getDailyRiskLimit();
    if (db.dailyPnL >= db.targetDailyProfit) return `[PAUSE] Daily target reached: $${db.dailyPnL.toFixed(2)}. Trading paused.`;
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

const handleRuntimeCommand = (input) => {
    const cmd = input.toString().trim().toLowerCase();
    if (cmd === "sync") { syncPositionWithExchange(); return; }
    if (cmd === "status") { console.log(`\n[STATUS] Active=${!!db.activePosition}, Daily P&L=${db.dailyPnL.toFixed(2)} USDT, Trades=${db.dailyTrades}`); }
};

const registerRuntimeCommands = () => {
    if (!process.stdin.isTTY) return;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", handleRuntimeCommand);
};

const bootstrapRuntime = async () => {
    await initializeExchange();
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

    if (isPlacingOrder || isClosingPosition) return;
    await resetDailyStateIfNeeded(Date.now());

    const pauseReason = await getTradingPauseReason();
    if (pauseReason) { console.log(pauseReason); return; }
    if (db.activePosition || isCoolingDown()) return;

    const signal = await analyzeSignal();
    if (signal.canLong) await placeOrder("buy", signal);
    else if (signal.canShort) await placeOrder("sell", signal);
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

const normalizeConfig = (config) => {
    const defaults = getDefaultConfig();
    if (!config || typeof config !== "object") return { ...defaults };

    const normalized = { ...config };
    const numericRules = {
        usdtPerTrade: { min: 0, allowZero: false }, leverage: { min: 0, allowZero: false, integer: true },
        targetProfitUSDT: { min: 0, allowZero: false }, targetDailyProfit: { min: 0, allowZero: false },
        maxDailyLossPercent: { min: 0, allowZero: false }, maxTradesPerDay: { min: 0, allowZero: false, integer: true },
        coolingPeriod: { min: 0, allowZero: true, integer: true }, monitoringInterval: { min: 200, allowZero: false, integer: true },
        stopLossPercent: { min: 0, allowZero: false }, fastEMAPeriod: { min: 2, allowZero: false, integer: true },
        slowEMAPeriod: { min: 3, allowZero: false, integer: true }, trendEMAPeriod: { min: 2, allowZero: false, integer: true },
        rsiPeriod: { min: 2, allowZero: false, integer: true }, rsiOverbought: { min: 50, allowZero: false },
        rsiOversold: { min: 1, allowZero: false }, sessionStartUTC: { min: 0, allowZero: true, integer: true },
        sessionEndUTC: { min: 0, allowZero: true, integer: true }, volumePeriod: { min: 2, allowZero: false, integer: true },
        minVolumeRatio: { min: 1, allowZero: false }, maxPriceDeviationPercent: { min: 0, allowZero: true },
        atrPeriod: { min: 2, allowZero: false, integer: true }, atrStopMult: { min: 0.2, allowZero: false },
        atrTargetMult: { min: 0.2, allowZero: false }, shortAtrStopMult: { min: 0.2, allowZero: false },
        shortAtrTargetMult: { min: 0.2, allowZero: false }, trailingActivateATR: { min: 0.2, allowZero: false },
        trailingOffsetATR: { min: 0.1, allowZero: false }, shortTrailingActivateATR: { min: 0.2, allowZero: false },
        shortTrailingOffsetATR: { min: 0.1, allowZero: false }
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
    normalized.strategy = typeof normalized.strategy === "string" && normalized.strategy.trim() ? normalized.strategy.trim().toLowerCase() : defaults.strategy;
    const rawMarginMode = typeof normalized.marginMode === "string" ? normalized.marginMode.trim().toLowerCase() : "";
    normalized.marginMode = rawMarginMode === "isolated" || rawMarginMode === "cross" ? rawMarginMode : defaults.marginMode;
    normalized.breakoutTimeframe = isValidTimeframe(normalized.breakoutTimeframe) ? normalized.breakoutTimeframe.trim() : defaults.breakoutTimeframe;

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
    if (normalized.slowEMAPeriod <= normalized.fastEMAPeriod) {
        normalized.slowEMAPeriod = normalized.fastEMAPeriod + 1;
    }

    return normalized;
};

// -------------------- INITIALIZE DATABASE --------------------
const initializeDB = async () => {
    try {
        await sequelize.sync();
        console.log("[OK] Database synced");
        const configRow = await ensureConfigRow();
        const persisted = configRow.toJSON();
        db = hydrateConfig(persisted);
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
    } catch (error) { console.error("[ERROR] Failed to reload config:", error.message); return false; }
};

// -------------------- SAVE DB TO DATABASE --------------------
const saveDB = async () => {
    try { if (!db) return; await persistConfig(db); }
    catch (error) { console.error("[ERROR] Failed to save DB:", error.message); }
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
            console.log(wasTrackingPosition ? "[OK] Refreshed activePosition from exchange data" : "[OK] Created activePosition from exchange data");
        }
    } catch (error) { console.error("[ERROR] Sync position failed:", error.message); }
    finally { isSyncingPosition = false; }
};

// -------------------- INIT EXCHANGE --------------------
const initializeExchange = async () => {
    try {
        exchange = new ccxt.binance({
            apiKey: process.env.API_KEY, secret: process.env.API_SECRET,
            options: { defaultType: "future" }, enableRateLimit: true,
        });
        await exchange.loadMarkets();
        console.log("[OK] Exchange connected");
        return exchange;
    } catch (error) { console.error("[ERROR] Exchange connection failed:", error.message); throw error; }
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
        if (!error.message.includes("No need to change margin mode")) console.warn("[WARN] Margin mode warning:", error.message);
        return false;
    }
};

// -------------------- SIGNAL DETECTION --------------------
const analyzeSignal = async () => {
    try {
        if (!db) return {};
        signalCount++; metrics.signals.analyzed++;
        const now = Date.now();
        if (now - lastLogTime > 5000) {
            console.log(`\n[SIGNAL #${signalCount}] Analyzing EMA crossover setup (${db.breakoutTimeframe})...`);
            lastLogTime = now;
        }

        const params = getSignalParameters();
        const ohlcv = await getOHLCV(params.neededCandles);
        if (ohlcv.length < params.neededCandles) {
            console.log(`[WARN] Not enough OHLCV data: ${ohlcv.length} < ${params.neededCandles}`); return {};
        }

        const snapshot = buildSignalSnapshot(ohlcv, params);
        if (!snapshot || snapshot.invalidAtr) { console.log("[WARN] Invalid data for signal"); return {}; }

        const signalState = evaluateCrossoverSignal(snapshot, params);
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
            rsi: snapshot.currentRSI, atr: snapshot.currentATR, hasSignal: finalState.setupDetected,
            strategy: "EMA_CROSSOVER", riskOverrides: buildRiskOverrides(finalState.canShort)
        };
    } catch (error) { console.error("[ERROR] Signal analysis failed:", error.message); return {}; }
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
        if (!Number.isFinite(tickerPrice) || tickerPrice <= 0) { console.error("[ERROR] Invalid ticker price. Order skipped."); return; }

        const { signalPrice, signalATR, strategyName, riskOverrides } = parseSignalOrderData(signalData);
        const hasSignalPrice = Number(signalPrice) > 0;
        const entryPrice = hasSignalPrice ? Number(signalPrice) : tickerPrice;
        const maxDeviationPercent = Number(db.maxPriceDeviationPercent ?? 0.5);
        if (hasSignalPrice && maxDeviationPercent > 0) {
            const deviationPercent = Math.abs((entryPrice - tickerPrice) / tickerPrice) * 100;
            if (deviationPercent > maxDeviationPercent) {
                console.warn(`[WARN] Price deviation too high (${deviationPercent.toFixed(3)}% > ${maxDeviationPercent}%). Order skipped.`);
                return;
            }
        }
        const qty = (db.usdtPerTrade * db.leverage) / entryPrice;
        const market = exchange.markets[db.pair];
        const adjustedQty = formatAmountToMarketPrecision(db.pair, qty);
        const sizeValidation = validateOrderSize(market, adjustedQty, tickerPrice);
        if (!sizeValidation.valid) { console.error(sizeValidation.reason); return; }

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
            side: side, entryPrice: actualEntryPrice, targetPrice: actualOrderPlan.targetPrice,
            stopLossPrice: actualOrderPlan.stopLossPrice, stopLossUSDT: actualOrderPlan.stopLossUSDT,
            orderId: order.id, quantity: actualQuantity, entryTime: Date.now(), highestSinceEntry: actualEntryPrice,
            lowestSinceEntry: actualEntryPrice, marginMode: (db.marginMode || "isolated").toLowerCase(),
            targetProfitUSDT: actualOrderPlan.targetProfitUSDT, atrAtEntry: signalATR, strategy: strategyName,
            trailingActivateATR: actualOrderPlan.trailingActivateATR, trailingOffsetATR: actualOrderPlan.trailingOffsetATR
        };

        await saveDB();
        logTrade(side === "buy" ? "LONG" : "SHORT", actualEntryPrice, null, "OPEN");
        metrics.trades.opened++;
        console.log(`\n[OK] ORDER PLACED: ${side.toUpperCase()} at ${actualEntryPrice}`);
    } catch (error) { console.error("[ERROR] Order failed:", error.message); }
    finally { isPlacingOrder = false; }
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
            await resetActivePosition(); return;
        }
        const closeSide = side === "buy" ? "sell" : "buy";
        console.log(`\n[CLOSE] Closing position...`);
        const closeOrder = await exchange.createOrder(db.pair, "market", closeSide, quantity, undefined, {
            reduceOnly: true, marginMode: (db.marginMode || "isolated").toLowerCase()
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
        await finalizeClosedPosition(position, realizedPnL.profitUSDT, realizedPnL.profitPercent, reason, closeFillSnapshot.price);
    } catch (error) { console.error("[ERROR] Close position failed:", error.message); }
    finally { isClosingPosition = false; }
};

// -------------------- UTILITY FUNCTIONS --------------------
const getPrice = async (forceRefresh = false) => {
    try {
        const now = Date.now();
        if (!forceRefresh && now - tickerCache.lastUpdate < TICKER_CACHE_TTL) return tickerCache.price;
        const ticker = await exchange.fetchTicker(db.pair);
        metrics.api.ticker++;
        const latestPrice = toFiniteNumber(ticker?.last, null);
        if (latestPrice) { tickerCache.price = latestPrice; tickerCache.lastUpdate = now; }
        return latestPrice;
    } catch (error) { console.error("[ERROR] Failed to get price:", error.message); return tickerCache.price; }
};

const getOHLCV = async (limit = 100, forceRefresh = false) => {
    const timeframe = db?.breakoutTimeframe || "5m";
    const cacheKey = `${db?.pair || ""}:${timeframe}:${limit}`;
    const now = Date.now();
    if (!forceRefresh && ohlcvCache.key === cacheKey && now - ohlcvCache.lastUpdate < OHLCV_CACHE_TTL && Array.isArray(ohlcvCache.data)) {
        return ohlcvCache.data;
    }
    const ohlcv = await exchange.fetchOHLCV(db.pair, timeframe, undefined, limit);
    metrics.api.ohlcv++;
    ohlcvCache = { key: cacheKey, data: ohlcv, lastUpdate: now };
    return ohlcv;
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

    const rsi = RSI.calculate({ values: close.slice(0, lastIndex + 1), period: params.rsiPeriod });
    const currentRSI = rsi.length > 0 ? rsi[rsi.length - 1] : 50;

    return { ohlcv, open, high, low, close, volume, lastIndex, currentOpen, currentPrice, currentVolume, avgVolume, volumeRatio, hourUTC, currentATR, currentRSI };
};

const logTrade = (side, entry, exit, status, pnl = 0) => {
    try {
        ensureFileExists(logPath, "timestamp,pair,side,entry,exit,status,pnl,leverage,margin_mode,stop_loss_percent,strategy\n");
        const timestamp = new Date().toISOString();
        const parsedTime = Date.parse(timestamp);
        lastTradeAt = Number.isFinite(parsedTime) ? parsedTime : Date.now();
        const marginMode = (db.marginMode || "isolated").toUpperCase();
        const strategy = db?.activePosition?.strategy || `EMA_CROSSOVER_${String(db.breakoutTimeframe || "5m").toUpperCase()}`;
        const line = `${timestamp},${db.pair},${side},${entry},${exit || ""},${status},${pnl.toFixed(4)},${db.leverage},${marginMode},${db.stopLossPercent},${strategy}\n`;
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
        } catch (error) {
            // PERBAIKAN: Tangkap exception agar script tidak crash
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
    const desiredInterval = db.activePosition ? 5000 : 15000;
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