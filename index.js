require("dotenv").config();
const fs = require("fs");
const path = require("path");
const ccxt = require("ccxt");
const { SMA } = require("technicalindicators");
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

    // Binance-style futures grid parameters
    gridLevels: { type: DataTypes.INTEGER, defaultValue: 8 },
    gridLookbackCandles: { type: DataTypes.INTEGER, defaultValue: 120 },
    gridRangePercent: { type: DataTypes.FLOAT, defaultValue: 3.5 },
    gridEntryBufferPercent: { type: DataTypes.FLOAT, defaultValue: 0.15 },
    gridTakeProfitLevels: { type: DataTypes.INTEGER, defaultValue: 1 },
    gridOrdersPerSide: { type: DataTypes.INTEGER, defaultValue: 3 },
    gridStopLossLevels: { type: DataTypes.FLOAT, defaultValue: 1.2 },

    // Legacy SMA parameters kept for backward compatibility
    fastEMAPeriod: { type: DataTypes.INTEGER, defaultValue: 7 },
    slowEMAPeriod: { type: DataTypes.INTEGER, defaultValue: 25 },
    trendEMAPeriod: { type: DataTypes.INTEGER, defaultValue: 99 },
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
const BOOLEAN_CONFIG_KEYS = [
    "useTrendFilter",
    "trailingEnabled",
    "allowLong",
    "allowShort"
];
const DEFAULT_CONFIG = {
    strategy: "futures_grid",
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
    gridLevels: 8,
    gridLookbackCandles: 120,
    gridRangePercent: 3.5,
    gridEntryBufferPercent: 0.15,
    gridTakeProfitLevels: 1,
    gridOrdersPerSide: 3,
    gridStopLossLevels: 1.2,
    fastEMAPeriod: 7,
    slowEMAPeriod: 25,
    trendEMAPeriod: 99,
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

// -------------------- RETRY HELPER (NEW) --------------------
const retry = async (fn, retries = 3, delay = 1000) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === retries - 1) throw error;
            console.log(`[RETRY] Attempt ${i + 1} failed, retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2; // exponential backoff
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
    console.log("BINANCE-STYLE FUTURES GRID BOT");
    console.log("=".repeat(70));
    console.log(`Balance: $${totalUSDT.toFixed(2)}`);
    console.log(`Pair: ${db.pair}`);
    console.log(`Strategy: ${String(db.strategy || "futures_grid").toUpperCase()} on ${db.breakoutTimeframe}`);
    console.log(`Position Mode: ${accountPositionMode.label}`);
    console.log(`Grid: ${db.gridLevels} levels | lookback ${db.gridLookbackCandles} candles | range ${db.gridRangePercent}%`);
    console.log(`Grid TP/SL: ${db.gridTakeProfitLevels} level(s) / ${db.gridStopLossLevels} step(s) | ${db.gridOrdersPerSide} order(s) per side`);
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
    if (hydrated.activePosition && isLegacySinglePosition(hydrated.activePosition)) {
        const legacyKey = toPositionMapKey(hydrated.activePosition.positionSide || "BOTH");
        hydrated.activePosition = { [legacyKey]: hydrated.activePosition };
    }
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
    const strategy = String(db?.strategy || "futures_grid").toLowerCase();
    const volumePeriod = Math.max(2, Math.trunc(db.volumePeriod || 20));
    const atrPeriod = Math.max(2, Math.trunc(db.atrPeriod || 14));
    if (strategy === "futures_grid") {
        const gridLookbackCandles = Math.max(20, Math.trunc(db.gridLookbackCandles || 120));
        const gridLevels = Math.max(4, Math.trunc(db.gridLevels || 8));
        const gridTakeProfitLevels = Math.max(1, Math.trunc(db.gridTakeProfitLevels || 1));
        const neededCandles = Math.max(gridLookbackCandles + 5, volumePeriod + 10, atrPeriod + 10, 150);
        return {
            strategy,
            volumePeriod,
            atrPeriod,
            neededCandles,
            gridLookbackCandles,
            gridLevels,
            gridTakeProfitLevels,
            gridOrdersPerSide: Math.max(1, Math.trunc(db.gridOrdersPerSide || 3)),
            gridRangePercent: Math.max(0.5, toFiniteNumber(db.gridRangePercent, 3.5)),
            gridEntryBufferPercent: Math.max(0.02, toFiniteNumber(db.gridEntryBufferPercent, 0.15)),
            gridStopLossLevels: Math.max(0.5, toFiniteNumber(db.gridStopLossLevels, 1.2))
        };
    }

    const fastEMAPeriod = 7;
    const slowEMAPeriod = 25;
    const trendEMAPeriod = 99;
    const neededCandles = Math.max(
        slowEMAPeriod + 10, trendEMAPeriod + 10, volumePeriod + 10, atrPeriod + 10, 100
    );

    return { strategy, fastEMAPeriod, slowEMAPeriod, trendEMAPeriod, volumePeriod, atrPeriod, neededCandles };
};

const buildGridLevels = (lowerBound, upperBound, gridLevels) => {
    const safeLevels = Math.max(2, Math.trunc(gridLevels));
    const step = (upperBound - lowerBound) / safeLevels;
    const levels = [];
    for (let i = 0; i <= safeLevels; i++) levels.push(lowerBound + (step * i));
    return { levels, step };
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

const getExchangeClientOrderId = (order) => (
    String(order?.clientOrderId || order?.info?.clientOrderId || order?.info?.origClientOrderId || "")
);

const isGridEntryOrder = (order) => getExchangeClientOrderId(order).startsWith(GRID_CLIENT_ORDER_PREFIX);
const isTpReduceOnlyOrder = (order) => getExchangeClientOrderId(order).startsWith(TP_CLIENT_ORDER_PREFIX);
const isSlReduceOnlyOrder = (order) => getExchangeClientOrderId(order).startsWith(SL_CLIENT_ORDER_PREFIX);

const fetchOpenGridOrders = async () => {
    metrics.api.orders++;
    const openOrders = await exchange.fetchOpenOrders(db.pair);
    return openOrders.filter((order) => normalizeSymbol(order.symbol) === normalizeSymbol(db.pair) && isGridEntryOrder(order));
};

const fetchOpenTpOrders = async () => {
    metrics.api.orders++;
    const openOrders = await exchange.fetchOpenOrders(db.pair);
    return openOrders.filter((order) => normalizeSymbol(order.symbol) === normalizeSymbol(db.pair) && isTpReduceOnlyOrder(order));
};

const fetchOpenSlOrders = async () => {
    metrics.api.orders++;
    const openOrders = await exchange.fetchOpenOrders(db.pair);
    return openOrders.filter((order) => normalizeSymbol(order.symbol) === normalizeSymbol(db.pair) && isSlReduceOnlyOrder(order));
};

const fetchManagedOpenOrdersSnapshot = async () => {
    metrics.api.orders++;
    const openOrders = await exchange.fetchOpenOrders(db.pair);
    const managedOrders = openOrders.filter((order) => normalizeSymbol(order.symbol) === normalizeSymbol(db.pair));
    return {
        grid: managedOrders.filter(isGridEntryOrder),
        tp: managedOrders.filter(isTpReduceOnlyOrder),
        sl: managedOrders.filter(isSlReduceOnlyOrder)
    };
};

const buildGridEntryOrders = (snapshot, params) => {
    const recentHigh = Math.max(...snapshot.high.slice(-(params.gridLookbackCandles)));
    const recentLow = Math.min(...snapshot.low.slice(-(params.gridLookbackCandles)));
    const referencePrice = (recentHigh + recentLow) / 2;
    const lowerBound = Math.min(referencePrice * (1 - (params.gridRangePercent / 100)), recentLow);
    const upperBound = Math.max(referencePrice * (1 + (params.gridRangePercent / 100)), recentHigh);
    const { levels, step } = buildGridLevels(lowerBound, upperBound, params.gridLevels);
    if (!Number.isFinite(step) || step <= 0) return [];

    const minBuyPrice = snapshot.currentPrice * (1 - (params.gridEntryBufferPercent / 100));
    const maxSellPrice = snapshot.currentPrice * (1 + (params.gridEntryBufferPercent / 100));
    const buyOrders = [];
    const sellOrders = [];

    for (let i = levels.length - 2; i >= 0; i--) {
        const price = formatPriceToMarketPrecision(db.pair, levels[i]);
        const targetPrice = formatPriceToMarketPrecision(db.pair, levels[i + 1]);
        const stopLossPrice = formatPriceToMarketPrecision(db.pair, levels[i] - (step * params.gridStopLossLevels));
        if (Number.isFinite(price) && price > 0 && price < minBuyPrice) {
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
        if (Number.isFinite(price) && price > 0 && price > maxSellPrice) {
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

    return [
        ...buyOrders.slice(0, params.gridOrdersPerSide),
        ...sellOrders.slice(0, params.gridOrdersPerSide)
    ];
};

const evaluateGridSignal = (snapshot, params) => {
    const recentClose = snapshot.close.slice(-(params.gridLookbackCandles));
    if (recentClose.length < params.gridLookbackCandles) {
        return {
            canLong: false, canShort: false, setupDetected: false,
            detailTitle: "BINANCE GRID ANALYSIS",
            extraDetailLines: ["   Not enough candle data to build grid range."]
        };
    }

    const recentHigh = Math.max(...snapshot.high.slice(-(params.gridLookbackCandles)));
    const recentLow = Math.min(...snapshot.low.slice(-(params.gridLookbackCandles)));
    const referencePrice = (recentHigh + recentLow) / 2;
    const lowerBound = Math.min(referencePrice * (1 - (params.gridRangePercent / 100)), recentLow);
    const upperBound = Math.max(referencePrice * (1 + (params.gridRangePercent / 100)), recentHigh);
    const { levels, step } = buildGridLevels(lowerBound, upperBound, params.gridLevels);
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

    return {
        canLong,
        canShort,
        setupDetected: canLong || canShort,
        detailTitle: "BINANCE GRID ANALYSIS",
        strategyName: "FUTURES_GRID",
        longPlan: canLong ? { targetPrice: longTargetPrice, stopLossPrice: longStopPrice, gridIndex: lowerIndex } : null,
        shortPlan: canShort ? { targetPrice: shortTargetPrice, stopLossPrice: shortStopPrice, gridIndex: upperIndex } : null,
        extraDetailLines: [
            `   Reference Price: ${referencePrice.toFixed(6)}`,
            `   Grid Range: ${lowerBound.toFixed(6)} - ${upperBound.toFixed(6)}`,
            `   Grid Levels: ${params.gridLevels} | Step: ${step.toFixed(6)}`,
            `   Current Slot: ${lowerIndex}/${params.gridLevels} (${currentLevelLow.toFixed(6)} - ${currentLevelHigh.toFixed(6)})`,
            `   Distance From Mid: ${distanceFromMidSteps.toFixed(2)} steps`,
            `   Volume Ratio: ${snapshot.volumeRatio.toFixed(2)}x (min ${db.minVolumeRatio}x) -> ${volumeOk ? "[OK]" : "[NO]"}`,
            `   Session Filter: ${sessionOk ? "[OK]" : "[NO]"}`,
            `   Long Grid Re-entry: ${meanReversionLong ? "[OK]" : "[NO]"}`,
            `   Short Grid Re-entry: ${meanReversionShort ? "[OK]" : "[NO]"}`
        ]
    };
};

const evaluateCrossoverSignal = (snapshot, params) => {
    const { close, lastIndex, currentPrice, currentVolume, avgVolume, hourUTC } = snapshot;
    const signalClose = Array.isArray(close) ? close.slice(0, lastIndex + 1) : [];
    if (signalClose.length < Math.max(params.slowEMAPeriod, params.trendEMAPeriod) + 2) {
        return {
            canLong: false, canShort: false, setupDetected: false,
            detailTitle: "SMA AUTO ANALYSIS", extraDetailLines: ["   Not enough candle data to evaluate."]
        };
    }

    const fastSMA = SMA.calculate({ values: signalClose, period: params.fastEMAPeriod });
    const slowSMA = SMA.calculate({ values: signalClose, period: params.slowEMAPeriod });
    const trendSMA = SMA.calculate({ values: signalClose, period: params.trendEMAPeriod });

    const currentFast = fastSMA[fastSMA.length - 1];
    const prevFast = fastSMA[fastSMA.length - 2];
    const currentSlow = slowSMA[slowSMA.length - 1];
    const prevSlow = slowSMA[slowSMA.length - 2];
    const currentTrend = trendSMA[trendSMA.length - 1];
    
    // Volume ratio
    const volumeRatio = currentVolume / (avgVolume || 1);
    const volumeOk = volumeRatio >= db.minVolumeRatio;
    
    // Session filter
    const sessionOk = db.sessionStartUTC <= db.sessionEndUTC
        ? hourUTC >= db.sessionStartUTC && hourUTC <= db.sessionEndUTC
        : hourUTC >= db.sessionStartUTC || hourUTC <= db.sessionEndUTC;
    
    const bullishCrossover = currentFast > currentSlow && prevFast <= prevSlow;
    const bearishCrossover = currentFast < currentSlow && prevFast >= prevSlow;
    const structureOkLong = currentFast > currentTrend && currentSlow > currentTrend;
    const structureOkShort = currentFast < currentTrend && currentSlow < currentTrend;

    const canLong = db.allowLong && bullishCrossover && volumeOk && sessionOk && structureOkLong;
    const canShort = db.allowShort && bearishCrossover && volumeOk && sessionOk && structureOkShort;
    
    const setupDetected = bullishCrossover || bearishCrossover;
    
    return {
        canLong,
        canShort,
        setupDetected,
        detailTitle: "SMA AUTO ANALYSIS",
        extraDetailLines: [
            `   SMA Fast (${params.fastEMAPeriod}): ${currentFast.toFixed(6)} (prev ${prevFast.toFixed(6)})`,
            `   SMA Mid (${params.slowEMAPeriod}): ${currentSlow.toFixed(6)} (prev ${prevSlow.toFixed(6)})`,
            `   SMA Trend (${params.trendEMAPeriod}): ${currentTrend.toFixed(6)}`,
            `   Bullish Cross (SMA ${params.fastEMAPeriod} > SMA ${params.slowEMAPeriod}): ${bullishCrossover ? "[OK]" : "[NO]"}`,
            `   Bearish Cross (SMA ${params.fastEMAPeriod} < SMA ${params.slowEMAPeriod}): ${bearishCrossover ? "[OK]" : "[NO]"}`,
            `   Volume Ratio: ${volumeRatio.toFixed(2)}x (min ${db.minVolumeRatio}x) -> ${volumeOk ? "[OK]" : "[NO]"}`,
            `   Structure Long: SMA ${params.fastEMAPeriod} & SMA ${params.slowEMAPeriod} above SMA ${params.trendEMAPeriod} -> ${structureOkLong ? "[OK]" : "[NO]"}`,
            `   Structure Short: SMA ${params.fastEMAPeriod} & SMA ${params.slowEMAPeriod} below SMA ${params.trendEMAPeriod} -> ${structureOkShort ? "[OK]" : "[NO]"}`
        ]
    };
};

const applySignalGuards = (signalState, snapshot) => {
    if (String(db?.strategy || "futures_grid").toLowerCase() === "futures_grid") {
        return signalState;
    }
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
    const resolvedQuantity = filledQuantity > 0 ? filledQuantity : fallbackQuantity;
    const resolvedPrice = averagePrice > 0
        ? averagePrice
        : (filledQuantity > 0 && orderCost > 0 ? orderCost / filledQuantity : fallbackPrice);
    return { price: resolvedPrice, quantity: resolvedQuantity };
};

const cancelGridOrders = async (orders, reason = "SYNC") => {
    if (!Array.isArray(orders) || orders.length === 0) return;
    console.log(`[GRID] Cancelling ${orders.length} grid order(s) (${reason})...`);
    for (const order of orders) {
        try {
            await exchange.cancelOrder(order.id, db.pair);
            metrics.api.orders++;
        } catch (error) {
            console.warn(`[WARN] Failed to cancel grid order ${order.id}: ${error.message}`);
        }
    }
};

const cancelTpOrders = async (orders, reason = "TP_SYNC") => {
    if (!Array.isArray(orders) || orders.length === 0) return;
    console.log(`[TP] Cancelling ${orders.length} TP order(s) (${reason})...`);
    for (const order of orders) {
        try {
            await exchange.cancelOrder(order.id, db.pair);
            metrics.api.orders++;
        } catch (error) {
            console.warn(`[WARN] Failed to cancel TP order ${order.id}: ${error.message}`);
        }
    }
};

const cancelSlOrders = async (orders, reason = "SL_SYNC") => {
    if (!Array.isArray(orders) || orders.length === 0) return;
    console.log(`[SL] Cancelling ${orders.length} SL order(s) (${reason})...`);
    for (const order of orders) {
        try {
            await exchange.cancelOrder(order.id, db.pair);
            metrics.api.orders++;
        } catch (error) {
            console.warn(`[WARN] Failed to cancel SL order ${order.id}: ${error.message}`);
        }
    }
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
    const atrStopMult = toFiniteNumber(riskOverrides.atrStopMult, db.atrStopMult);
    const atrTargetMult = toFiniteNumber(riskOverrides.atrTargetMult, db.atrTargetMult);
    const trailingActivateATR = toFiniteNumber(riskOverrides.trailingActivateATR, db.trailingActivateATR);
    const trailingOffsetATR = toFiniteNumber(riskOverrides.trailingOffsetATR, db.trailingOffsetATR);
    const explicitTargetPrice = toFiniteNumber(explicitTargets.targetPrice, null);
    const explicitStopLossPrice = toFiniteNumber(explicitTargets.stopLossPrice, null);

    let targetProfitUSDT = db.targetProfitUSDT;
    let stopLossUSDT = -db.usdtPerTrade * (db.stopLossPercent / 100);
    let targetPrice;
    let stopLossPrice;

    if (Number.isFinite(explicitTargetPrice) && Number.isFinite(explicitStopLossPrice)) {
        targetPrice = explicitTargetPrice;
        stopLossPrice = explicitStopLossPrice;
        targetProfitUSDT = Math.abs(targetPrice - entryPrice) * adjustedQty;
        stopLossUSDT = -Math.abs(stopLossPrice - entryPrice) * adjustedQty;
    } else if (signalATR && signalATR > 0) {
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

const placeGridEntryOrder = async (gridOrder) => {
    const market = exchange.markets[db.pair];
    const rawQty = (db.usdtPerTrade * db.leverage) / gridOrder.price;
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
    params.newClientOrderId = getTpClientOrderId(position);

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
    params.newClientOrderId = getSlClientOrderId(position);
    params.stopPrice = formatPriceToMarketPrecision(db.pair, position.stopLossPrice);
    params.workingType = "MARK_PRICE";

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
        const fallbackSide = rawActivePosition.positionSide || (isHedgeModeEnabled() ? (rawActivePosition.side === "buy" ? "LONG" : "SHORT") : "BOTH");
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
    const side = position?.side;
    if (side === "buy") return isHedgeModeEnabled() ? "LONG" : "BOTH";
    if (side === "sell") return isHedgeModeEnabled() ? "SHORT" : "BOTH";
    return isHedgeModeEnabled() ? null : "BOTH";
};

const getOrderPositionSide = (side) => {
    if (!isHedgeModeEnabled()) return "BOTH";
    return side === "buy" ? "LONG" : "SHORT";
};

const getClosePositionSide = (position) => {
    if (!isHedgeModeEnabled()) return "BOTH";
    const tracked = getTrackedPositionSideLabel(position);
    if (tracked === "LONG" || tracked === "SHORT") return tracked;
    return position?.side === "buy" ? "LONG" : "SHORT";
};

const matchesOrderToTrackedPosition = (order, position) => {
    const orderClientId = getExchangeClientOrderId(order);
    if (!orderClientId) return false;
    const expectedCloseSide = position?.side === "buy" ? "sell" : "buy";
    if (String(order?.side || "").toLowerCase() !== expectedCloseSide) return false;
    if (!isHedgeModeEnabled()) return true;
    const orderPositionSide = String(order?.info?.positionSide || order?.positionSide || "").toUpperCase();
    return !orderPositionSide || orderPositionSide === getClosePositionSide(position);
};

const getOrderTriggerPrice = (order) => {
    const directStopPrice = toFiniteNumber(order?.stopPrice, NaN);
    if (Number.isFinite(directStopPrice) && directStopPrice > 0) return directStopPrice;
    const infoStopPrice = toFiniteNumber(order?.info?.stopPrice, NaN);
    if (Number.isFinite(infoStopPrice) && infoStopPrice > 0) return infoStopPrice;
    const triggerPrice = toFiniteNumber(order?.triggerPrice, NaN);
    return Number.isFinite(triggerPrice) && triggerPrice > 0 ? triggerPrice : NaN;
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
    if (position?.side === "long") return "buy";
    if (position?.side === "short") return "sell";
    const contracts = getExchangePositionContracts(position);
    if (contracts > 0) return "buy";
    if (contracts < 0) return "sell";
    return null;
};

const getExchangePositionModeSide = (position) => {
    const rawPositionSide = String(position?.positionSide || position?.info?.positionSide || "").toUpperCase();
    if (rawPositionSide === "LONG" || rawPositionSide === "SHORT" || rawPositionSide === "BOTH") return rawPositionSide;
    if (position?.side === "long") return "LONG";
    if (position?.side === "short") return "SHORT";
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

const buildSyncedActivePosition = (openPosition, entryPrice) => {
    const contracts = Math.abs(getExchangePositionContracts(openPosition));
    const side = getExchangePositionSide(openPosition) || "buy";
    const positionSide = getExchangePositionModeSide(openPosition);
    const targetPrice = side === "buy"
        ? formatPriceToMarketPrecision(db.pair, entryPrice + (db.targetProfitUSDT / Math.max(contracts, 1e-8)))
        : formatPriceToMarketPrecision(db.pair, entryPrice - (db.targetProfitUSDT / Math.max(contracts, 1e-8)));
    const stopLossPrice = side === "buy"
        ? formatPriceToMarketPrecision(db.pair, entryPrice - (Math.abs(db.usdtPerTrade * (db.stopLossPercent / 100)) / Math.max(contracts, 1e-8)))
        : formatPriceToMarketPrecision(db.pair, entryPrice + (Math.abs(db.usdtPerTrade * (db.stopLossPercent / 100)) / Math.max(contracts, 1e-8)));
    return {
        side, entryPrice, targetPrice, stopLossPrice,
        stopLossUSDT: -db.usdtPerTrade * (db.stopLossPercent / 100),
        orderId: `SYNC_${Date.now()}`, quantity: contracts,
        entryTime: Date.now() - 300000, highestSinceEntry: entryPrice, lowestSinceEntry: entryPrice,
        marginMode: (db.marginMode || "isolated").toLowerCase(),
        positionSide,
        targetProfitUSDT: db.targetProfitUSDT, strategy: "SYNC_ONLY",
        tpOrderId: null, tpClientOrderId: null, slOrderId: null, slClientOrderId: null
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
    const currentPositionSide = getTrackedPositionSideLabel(activePosition);
    const nextPositionSide = getTrackedPositionSideLabel(nextPosition);
    return activePosition.side !== nextPosition.side || currentPositionSide !== nextPositionSide || quantityChanged || entryChanged;
};

const isSameTrackedPosition = (currentPosition, nextPosition) => {
    if (!currentPosition || !nextPosition) return false;
    const currentQuantity = toFiniteNumber(currentPosition.quantity, 0);
    const nextQuantity = toFiniteNumber(nextPosition.quantity, 0);
    const currentEntry = toFiniteNumber(currentPosition.entryPrice, 0);
    const nextEntry = toFiniteNumber(nextPosition.entryPrice, 0);
    const quantityChanged = Math.abs(currentQuantity - nextQuantity) > POSITION_SYNC_QTY_TOLERANCE;
    const entryDeltaPercent = currentEntry > 0 ? Math.abs((currentEntry - nextEntry) / currentEntry) * 100 : 100;
    return (
        currentPosition.side === nextPosition.side &&
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
    const entryValue = position.entryPrice * position.quantity;
    const exitValue = currentPrice * position.quantity;
    
    // Biaya buka posisi (sudah terjadi) + estimasi biaya tutup posisi (akan terjadi)
    const entryFee = entryValue * TAKER_FEE_RATE;
    const exitFee = exitValue * TAKER_FEE_RATE;
    const totalEstimatedFee = entryFee + exitFee;

    const grossProfitUSDT = position.side === "buy"
        ? (currentPrice - position.entryPrice) * position.quantity
        : (position.entryPrice - currentPrice) * position.quantity;
    
    const netProfitUSDT = grossProfitUSDT - totalEstimatedFee;
    const profitPercent = (netProfitUSDT / (entryValue / db.leverage)) * 100;

    return { grossProfitUSDT, netProfitUSDT, profitPercent, totalEstimatedFee };
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
    const hasExchangeTpOrder = Boolean(position?.tpOrderId || position?.tpClientOrderId);
    const hasExchangeSlOrder = Boolean(position?.slOrderId || position?.slClientOrderId);
    
    const targetHit = Number.isFinite(position.targetPrice) &&
        (position.side === "buy" ? currentPrice >= position.targetPrice : currentPrice <= position.targetPrice);
    
    const stopHit = Number.isFinite(effectiveStopLossPrice) &&
        (position.side === "buy" ? currentPrice <= effectiveStopLossPrice : currentPrice >= effectiveStopLossPrice);

    // Sekarang kita cek Net Profit, bukan Gross
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
    // Gunakan netProfitUSDT untuk menentukan interval log
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
    const managedOrders = await fetchManagedOpenOrdersSnapshot();
    const activeEntries = getActivePositionEntries();
    console.log(`\n[STATUS] Mode=${accountPositionMode.label} | Pair=${db.pair} | Price=${Number.isFinite(currentPrice) ? currentPrice : "N/A"} | Active=${activeEntries.length}`);
    console.log(`[STATUS] Daily P&L=${db.dailyPnL.toFixed(2)} USDT | Trades=${db.dailyTrades}`);
    console.log(`[STATUS] Open Orders | Grid=${managedOrders.grid.length} | TP=${managedOrders.tp.length} | SL=${managedOrders.sl.length}`);
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

const finalizeClosedPosition = async (position, netProfitUSDT, profitPercent, reason, exitPrice = null) => {
    if (position?.tpOrderId || position?.tpClientOrderId) {
        const tpOrders = await fetchOpenTpOrders();
        const matchingTpOrders = tpOrders.filter((order) => matchesOrderToTrackedPosition(order, position));
        if (matchingTpOrders.length > 0) await cancelTpOrders(matchingTpOrders, "POSITION_CLOSED");
    }
    if (position?.slOrderId || position?.slClientOrderId) {
        const slOrders = await fetchOpenSlOrders();
        const matchingSlOrders = slOrders.filter((order) => matchesOrderToTrackedPosition(order, position));
        if (matchingSlOrders.length > 0) await cancelSlOrders(matchingSlOrders, "POSITION_CLOSED");
    }
    db.dailyPnL += netProfitUSDT; // Mencatat profit bersih ke database
    db.dailyTrades++;

    const resolvedExitPrice = Number.isFinite(exitPrice) && exitPrice > 0 ? exitPrice : await getPrice(true);
    
    // Log ke CSV juga menggunakan netProfit
    logTrade(position.side === "buy" ? "LONG" : "SHORT", position.entryPrice, resolvedExitPrice, "CLOSE", netProfitUSDT);

    console.log(`\n[OK] POSITION CLOSED: ${reason}`);
    console.log(`   Net P&L: ${netProfitUSDT.toFixed(4)} USDT (${profitPercent.toFixed(2)}%)`);
    console.log(`   Daily Total Net P&L: ${db.dailyPnL.toFixed(4)} USDT / ${db.dailyTrades} trades`);

    removeActivePositionByKey(getTrackedPositionSideLabel(position));
    await saveDB();
    metrics.trades.closed++;
    if (netProfitUSDT > 0) metrics.trades.wins++;
    else if (netProfitUSDT < 0) metrics.trades.losses++;
};

const mergeRuntimeConfig = (nextConfig) => {
    const currentPositionsMap = getActivePositionsMap(db.activePosition);
    const nextPositionsMap = getActivePositionsMap(nextConfig.activePosition);
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

const handleRuntimeCommand = async (input) => {
    const cmd = input.toString().trim().toLowerCase();
    if (cmd === "sync") { syncPositionWithExchange(); return; }
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

const normalizeConfig = (config) => {
    const defaults = getDefaultConfig();
    if (!config || typeof config !== "object") return { ...defaults };

    const normalized = { ...config };
    const numericRules = {
        usdtPerTrade: { min: 0, allowZero: false }, leverage: { min: 0, allowZero: false, integer: true },
        targetProfitUSDT: { min: 0, allowZero: false }, targetDailyProfit: { min: 0, allowZero: false },
        maxDailyLossPercent: { min: 0, allowZero: false }, maxTradesPerDay: { min: 0, allowZero: false, integer: true },
        coolingPeriod: { min: 0, allowZero: true, integer: true }, monitoringInterval: { min: 200, allowZero: false, integer: true },
        stopLossPercent: { min: 0, allowZero: false }, gridLevels: { min: 4, allowZero: false, integer: true },
        gridLookbackCandles: { min: 20, allowZero: false, integer: true }, gridRangePercent: { min: 0.5, allowZero: false },
        gridEntryBufferPercent: { min: 0.02, allowZero: false }, gridTakeProfitLevels: { min: 1, allowZero: false, integer: true },
        gridOrdersPerSide: { min: 1, allowZero: false, integer: true },
        gridStopLossLevels: { min: 0.5, allowZero: false }, fastEMAPeriod: { min: 2, allowZero: false, integer: true },
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
    normalized.strategy = "futures_grid";
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
    normalized.fastEMAPeriod = 7;
    normalized.slowEMAPeriod = 25;
    normalized.trendEMAPeriod = 99;
    normalized.gridTakeProfitLevels = clamp(normalized.gridTakeProfitLevels, 1, Math.max(1, normalized.gridLevels - 1));
    normalized.gridOrdersPerSide = clamp(normalized.gridOrdersPerSide, 1, Math.max(1, normalized.gridLevels - 1));

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
        const openPositions = await fetchOpenExchangePositions();
        const currentPrice = await getPrice();
        const nextPositionsMap = {};
        openPositions.forEach((openPosition) => {
            const entryPrice = getExchangePositionEntryPrice(openPosition, currentPrice);
            const syncedPosition = buildSyncedActivePosition(openPosition, entryPrice);
            nextPositionsMap[toPositionMapKey(syncedPosition.positionSide)] = syncedPosition;
        });

        const currentPositionsMap = getActivePositionsMap();
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
            timeout: 20000 // Increased timeout to 20s
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
        const strategy = String(db.strategy || "futures_grid").toLowerCase();
        const now = Date.now();
        if (now - lastLogTime > 5000) {
            console.log(`\n[SIGNAL #${signalCount}] Analyzing ${strategy.toUpperCase()} setup (${db.breakoutTimeframe})...`);
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
            : evaluateCrossoverSignal(snapshot, params);
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
            strategy: signalState.strategyName || (strategy === "futures_grid" ? "FUTURES_GRID" : "SMA_CROSSOVER"),
            riskOverrides: buildRiskOverrides(finalState.canShort),
            targetPrice: finalState.canLong ? signalState.longPlan?.targetPrice : (finalState.canShort ? signalState.shortPlan?.targetPrice : null),
            stopLossPrice: finalState.canLong ? signalState.longPlan?.stopLossPrice : (finalState.canShort ? signalState.shortPlan?.stopLossPrice : null)
        };
    } catch (error) { console.error("[ERROR] Signal analysis failed:", error.message); return {}; }
};

const syncGridOrders = async () => {
    if (!db || String(db.strategy || "futures_grid").toLowerCase() !== "futures_grid") return;

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

    const openGridOrders = await fetchOpenGridOrders();
    if (hasAnyActivePosition()) {
        if (openGridOrders.length > 0) await cancelGridOrders(openGridOrders, "ACTIVE_POSITION");
        return;
    }

    const desiredOrders = buildGridEntryOrders(snapshot, params);
    logGridSyncStatus(desiredOrders, openGridOrders);

    const desiredIds = new Set(desiredOrders.map((order) => order.clientOrderId));
    const staleOrders = openGridOrders.filter((order) => !desiredIds.has(getExchangeClientOrderId(order)));
    if (staleOrders.length > 0) await cancelGridOrders(staleOrders, "REBUILD");

    const openOrderIds = new Set(openGridOrders.map((order) => getExchangeClientOrderId(order)));
    for (const desiredOrder of desiredOrders) {
        if (openOrderIds.has(desiredOrder.clientOrderId)) continue;
        await placeGridEntryOrder(desiredOrder);
    }
};

const formatOrderSummary = (order, typeLabel) => {
    const side = String(order?.side || "").toUpperCase();
    const amount = toFiniteNumber(order?.amount, NaN);
    const price = typeLabel === "SL" ? getOrderTriggerPrice(order) : toFiniteNumber(order?.price, NaN);
    const clientId = getExchangeClientOrderId(order) || "N/A";
    return `${typeLabel} ${side} qty=${Number.isFinite(amount) ? amount : "N/A"} price=${Number.isFinite(price) ? price : "N/A"} id=${clientId}`;
};

const ensureReduceOnlyTakeProfitOrder = async (positionKey, sourcePosition) => {
    const position = { ...sourcePosition };
    if (!position || !Number.isFinite(position.targetPrice) || position.targetPrice <= 0) return;
    const openTpOrders = await fetchOpenTpOrders();
    const matchingTpOrders = openTpOrders.filter((order) => matchesOrderToTrackedPosition(order, position));
    const matchingOrder = matchingTpOrders.find((order) => {
        const orderPrice = toFiniteNumber(order.price, NaN);
        const orderAmount = Math.abs(toFiniteNumber(order.amount, NaN));
        return orderPrice === position.targetPrice && Math.abs(orderAmount - position.quantity) <= POSITION_SYNC_QTY_TOLERANCE;
    });
    if (matchingOrder) {
        const nextClientOrderId = getExchangeClientOrderId(matchingOrder) || position.tpClientOrderId || getTpClientOrderId(position);
        const nextOrderId = matchingOrder.id || position.tpOrderId || null;
        const nextPrice = toFiniteNumber(matchingOrder.price, position.targetPrice);
        if (position.tpOrderId !== nextOrderId || position.tpClientOrderId !== nextClientOrderId || position.targetPrice !== nextPrice) {
            console.log(`[TP] Synced existing TP order for ${positionKey} @ ${nextPrice}`);
            position.tpOrderId = nextOrderId;
            position.tpClientOrderId = nextClientOrderId;
            position.targetPrice = nextPrice;
            upsertActivePosition(position);
            await saveDB();
        }
        return;
    }

    if (matchingTpOrders.length > 0) {
        console.log(`[TP] Existing TP order for ${positionKey} no longer matches target. Replacing...`);
        await cancelTpOrders(matchingTpOrders, "TP_REPLACE");
    } else {
        console.log(`[TP] No exchange TP found for ${positionKey}. Creating replacement...`);
    }

    const placedOrder = await placeReduceOnlyTakeProfitOrder(position);
    if (!placedOrder) return;
    position.tpOrderId = placedOrder.id || null;
    position.tpClientOrderId = getExchangeClientOrderId(placedOrder) || getTpClientOrderId(position);
    upsertActivePosition(position);
    await saveDB();
    console.log(`[TP] Attached exchange TP to ${positionKey}`);
};

const ensureReduceOnlyStopLossOrder = async (positionKey, sourcePosition) => {
    const position = { ...sourcePosition };
    if (!position || !Number.isFinite(position.stopLossPrice) || position.stopLossPrice <= 0) return;
    const openSlOrders = await fetchOpenSlOrders();
    const matchingSlOrders = openSlOrders.filter((order) => matchesOrderToTrackedPosition(order, position));
    const matchingOrder = matchingSlOrders.find((order) => {
        const orderStopPrice = getOrderTriggerPrice(order);
        const orderAmount = Math.abs(toFiniteNumber(order.amount, NaN));
        return orderStopPrice === position.stopLossPrice && Math.abs(orderAmount - position.quantity) <= POSITION_SYNC_QTY_TOLERANCE;
    });
    if (matchingOrder) {
        const nextClientOrderId = getExchangeClientOrderId(matchingOrder) || position.slClientOrderId || getSlClientOrderId(position);
        const nextOrderId = matchingOrder.id || position.slOrderId || null;
        const nextStopPrice = getOrderTriggerPrice(matchingOrder);
        if (position.slOrderId !== nextOrderId || position.slClientOrderId !== nextClientOrderId || position.stopLossPrice !== nextStopPrice) {
            console.log(`[SL] Synced existing SL order for ${positionKey} @ ${nextStopPrice}`);
            position.slOrderId = nextOrderId;
            position.slClientOrderId = nextClientOrderId;
            position.stopLossPrice = nextStopPrice;
            upsertActivePosition(position);
            await saveDB();
        }
        return;
    }

    if (matchingSlOrders.length > 0) {
        console.log(`[SL] Existing SL order for ${positionKey} no longer matches stop. Replacing...`);
        await cancelSlOrders(matchingSlOrders, "SL_REPLACE");
    } else {
        console.log(`[SL] No exchange SL found for ${positionKey}. Creating replacement...`);
    }

    const placedOrder = await placeReduceOnlyStopLossOrder(position);
    if (!placedOrder) return;
    position.slOrderId = placedOrder.id || null;
    position.slClientOrderId = getExchangeClientOrderId(placedOrder) || getSlClientOrderId(position);
    upsertActivePosition(position);
    await saveDB();
    console.log(`[SL] Attached exchange SL to ${positionKey}`);
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
        await exchange.setLeverage(db.leverage, db.pair);

        const tickerPrice = await getPrice(true);
        if (!Number.isFinite(tickerPrice) || tickerPrice <= 0) { console.error("[ERROR] Invalid ticker price. Order skipped."); return; }

        const { signalPrice, signalATR, strategyName, riskOverrides, signalTargetPrice, signalStopLossPrice } = parseSignalOrderData(signalData);
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

        const orderPlan = buildOrderPlan(
            side,
            entryPrice,
            adjustedQty,
            signalATR,
            riskOverrides,
            { targetPrice: signalTargetPrice, stopLossPrice: signalStopLossPrice }
        );
        logOrderPlan(strategyName, entryPrice, adjustedQty, orderPlan);

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

        upsertActivePosition({
            side: side, entryPrice: actualEntryPrice, targetPrice: actualOrderPlan.targetPrice,
            stopLossPrice: actualOrderPlan.stopLossPrice, stopLossUSDT: actualOrderPlan.stopLossUSDT,
            orderId: order.id, quantity: actualQuantity, entryTime: Date.now(), highestSinceEntry: actualEntryPrice,
            lowestSinceEntry: actualEntryPrice, marginMode: (db.marginMode || "isolated").toLowerCase(),
            positionSide: getOrderPositionSide(side),
            targetProfitUSDT: actualOrderPlan.targetProfitUSDT, atrAtEntry: signalATR, strategy: strategyName,
            trailingActivateATR: actualOrderPlan.trailingActivateATR, trailingOffsetATR: actualOrderPlan.trailingOffsetATR,
            tpOrderId: null, tpClientOrderId: null, slOrderId: null, slClientOrderId: null
        });

        await saveDB();
        await ensureReduceOnlyTakeProfitOrder(targetPositionKey, getActivePositionByKey(targetPositionKey));
        await ensureReduceOnlyStopLossOrder(targetPositionKey, getActivePositionByKey(targetPositionKey));
        logTrade(side === "buy" ? "LONG" : "SHORT", actualEntryPrice, null, "OPEN");
        metrics.trades.opened++;
        console.log(`\n[OK] ORDER PLACED: ${side.toUpperCase()} at ${actualEntryPrice}`);
    } catch (error) { console.error("[ERROR] Order failed:", error.message); }
    finally { isPlacingOrder = false; }
};

// -------------------- CLOSE POSITION --------------------
const closePosition = async (positionKey, reason, netProfitUSDT, profitPercent) => {
    try {
        if (!db || !hasAnyActivePosition() || isClosingPosition) return;
        isClosingPosition = true;
        const trackedPosition = getActivePositionByKey(positionKey);
        if (!trackedPosition) return;
        const position = { ...trackedPosition };
        const { side, quantity } = position;
        if (!Number.isFinite(quantity) || quantity <= 0) {
            console.error("[ERROR] Invalid position quantity. Removing local active position.");
            removeActivePositionByKey(positionKey);
            await saveDB();
            return;
        }

        const currentPos = findOpenExchangePosition(await fetchOpenExchangePositions(), db.pair, position);
        if (!currentPos) {
            console.log("[INFO] No matching open position on exchange. Removing local active position.");
            removeActivePositionByKey(positionKey);
            await saveDB();
            return;
        }
        // Optionally sync quantity if it changed (e.g., partial fills)
        const actualQuantity = Math.abs(getExchangePositionContracts(currentPos));
        if (Math.abs(actualQuantity - quantity) > POSITION_SYNC_QTY_TOLERANCE) {
            console.log("[INFO] Position size changed on exchange. Updating local record.");
            position.quantity = actualQuantity;
            position.entryPrice = getExchangePositionEntryPrice(currentPos, position.entryPrice);
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
            // Handle reduce-only rejection
            if (error.code === -2022 || error.message.includes("ReduceOnly Order is rejected")) {
                console.warn("[WARN] Reduce-only order rejected. Syncing position with exchange...");
                const openPosition = findOpenExchangePosition(await fetchOpenExchangePositions(), db.pair, position);
                if (!openPosition) {
                    console.log("[INFO] No matching open position on exchange. Removing local active position.");
                    removeActivePositionByKey(positionKey);
                    await saveDB();
                    return;
                } else {
                    // Position still exists – update from exchange and retry later
                    const entryPrice = getExchangePositionEntryPrice(openPosition, await getPrice());
                    upsertActivePosition(buildSyncedActivePosition(openPosition, entryPrice));
                    await saveDB();
                    console.log("[INFO] Updated activePosition from exchange data. Will retry close on next cycle.");
                    return;
                }
            } else {
                throw error; // rethrow other errors
            }
        }

        const closeFillSnapshot = getOrderFillSnapshot(closeOrder, await getPrice(true), position.quantity);
        const remainingPosition = findOpenExchangePosition(await fetchOpenExchangePositions(), db.pair, position);
        if (remainingPosition) {
            const remainingContracts = Math.abs(getExchangePositionContracts(remainingPosition));
            if (remainingContracts > POSITION_SYNC_QTY_TOLERANCE) {
                const remainingEntryPrice = getExchangePositionEntryPrice(remainingPosition, position.entryPrice);
                const syncedRemainingPosition = buildSyncedActivePosition(remainingPosition, remainingEntryPrice);
                upsertActivePosition(syncedRemainingPosition);
                await saveDB();
                await ensureReduceOnlyTakeProfitOrder(positionKey, syncedRemainingPosition);
                await ensureReduceOnlyStopLossOrder(positionKey, syncedRemainingPosition);
                console.warn(`[WARN] Close order partially filled. Remaining quantity on exchange: ${remainingContracts}`);
                return;
            }
        }
        const realizedPnL = calculatePositionPnL(position, closeFillSnapshot.price);
        await finalizeClosedPosition(position, realizedPnL.netProfitUSDT, realizedPnL.profitPercent, reason, closeFillSnapshot.price); // FIX: use netProfitUSDT
    } catch (error) { console.error("[ERROR] Close position failed:", error.message); }
    finally { isClosingPosition = false; }
};

// -------------------- UTILITY FUNCTIONS --------------------
const getPrice = async (forceRefresh = false) => {
    try {
        const now = Date.now();
        if (!forceRefresh && now - tickerCache.lastUpdate < TICKER_CACHE_TTL) return tickerCache.price;
        // Use retry
        const ticker = await retry(() => exchange.fetchTicker(db.pair));
        metrics.api.ticker++;
        const latestPrice = toFiniteNumber(ticker?.last, null);
        if (latestPrice) { tickerCache.price = latestPrice; tickerCache.lastUpdate = now; }
        return latestPrice;
    } catch (error) {
        console.error("[ERROR] Failed to get price after retries:", error.message);
        return tickerCache.price; // return stale price if available
    }
};

const getOHLCV = async (limit = 100, forceRefresh = false) => {
    const timeframe = db?.breakoutTimeframe || "5m";
    const cacheKey = `${db?.pair || ""}:${timeframe}:${limit}`;
    const now = Date.now();
    if (!forceRefresh && ohlcvCache.key === cacheKey && now - ohlcvCache.lastUpdate < OHLCV_CACHE_TTL && Array.isArray(ohlcvCache.data)) {
        return ohlcvCache.data;
    }
    try {
        // Use retry
        const ohlcv = await retry(() => exchange.fetchOHLCV(db.pair, timeframe, undefined, limit));
        metrics.api.ohlcv++;
        ohlcvCache = { key: cacheKey, data: ohlcv, lastUpdate: now };
        return ohlcv;
    } catch (error) {
        console.error("[ERROR] Failed to fetch OHLCV after retries:", error.message);
        return ohlcvCache.data || []; // fallback to stale cache or empty array
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

const logTrade = (side, entry, exit, status, pnl = 0) => {
    try {
        ensureFileExists(logPath, "timestamp,pair,side,entry,exit,status,pnl,leverage,margin_mode,stop_loss_percent,strategy\n");
        const timestamp = new Date().toISOString();
        const parsedTime = Date.parse(timestamp);
        lastTradeAt = Number.isFinite(parsedTime) ? parsedTime : Date.now();
        const marginMode = (db.marginMode || "isolated").toUpperCase();
        const strategy = getPrimaryActivePosition()?.strategy || `SMA_CROSSOVER_${String(db.breakoutTimeframe || "5m").toUpperCase()}`;
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
            if (!db || !hasAnyActivePosition() || isClosingPosition) return;
            const currentPrice = await getPrice();
            if (!currentPrice) return;

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
                const exitState = evaluatePositionExit(position, currentPrice, pnlState);

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
