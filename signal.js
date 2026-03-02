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
    pair: { type: DataTypes.STRING, defaultValue: "DOGE/USDT:USDT" },
    usdtPerTrade: { type: DataTypes.FLOAT, defaultValue: 10 },
    leverage: { type: DataTypes.INTEGER, defaultValue: 10 },
    targetProfitUSDT: { type: DataTypes.FLOAT, defaultValue: 0.5 },
    targetDailyProfit: { type: DataTypes.FLOAT, defaultValue: 1.0 },
    maxDailyLossPercent: { type: DataTypes.FLOAT, defaultValue: 10 },
    maxTradesPerDay: { type: DataTypes.INTEGER, defaultValue: 3 },
    coolingPeriod: { type: DataTypes.INTEGER, defaultValue: 3000 },
    activePosition: { type: DataTypes.TEXT, defaultValue: null },
    dailyPnL: { type: DataTypes.FLOAT, defaultValue: 0 },
    dailyTrades: { type: DataTypes.INTEGER, defaultValue: 0 },
    marginMode: { type: DataTypes.STRING, defaultValue: "isolated" },
    monitoringInterval: { type: DataTypes.INTEGER, defaultValue: 500 },
    stopLossPercent: { type: DataTypes.FLOAT, defaultValue: 5 },
    breakoutPeriod: { type: DataTypes.INTEGER, defaultValue: 20 },
    breakoutTimeframe: { type: DataTypes.STRING, defaultValue: "5m" },
    minBreakoutStrength: { type: DataTypes.FLOAT, defaultValue: 0.003 },
    volumePeriod: { type: DataTypes.INTEGER, defaultValue: 20 },
    minVolumeRatio: { type: DataTypes.FLOAT, defaultValue: 1.4 },
    trendEnabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    trendTimeframe: { type: DataTypes.STRING, defaultValue: "1h" },
    trendPeriod: { type: DataTypes.INTEGER, defaultValue: 120 },
    adaptiveEnabled: { type: DataTypes.BOOLEAN, defaultValue: true },
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
let breakoutOhlcvCache = { key: "", data: null, lastUpdate: 0 };
let pnlMonitorTimer = null;
let currentPnLMonitoringInterval = 0;
let isMonitoringPnL = false;
let positionSyncTimer = null;
let currentPositionSyncInterval = 0;
let isSyncingPosition = false;
let trendTimer = null;
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
const ADAPTIVE_LOOKBACK_CANDLES = 288; // ~24h on 5m timeframe
const ADAPTIVE_MIN_VOLUME_RATIO_MIN = 1.2;
const ADAPTIVE_MIN_VOLUME_RATIO_MAX = 1.8;
const ADAPTIVE_MIN_VOLUME_RATIO_STEP = 0.1;
const ADAPTIVE_BREAKOUT_PERIOD_MIN = 16;
const ADAPTIVE_BREAKOUT_PERIOD_MAX = 36;
const ADAPTIVE_BREAKOUT_PERIOD_STEP = 2;

let metrics = {
    windowStart: Date.now(),
    api: {
        ticker: 0,
        breakoutOhlcv: 0,
        trendOhlcv: 0,
        balance: 0,
        positions: 0,
        orders: 0
    },
    signals: {
        analyzed: 0,
        breakoutDetected: 0,
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

const resetMetricWindow = () => {
    metrics.windowStart = Date.now();
    metrics.api.ticker = 0;
    metrics.api.breakoutOhlcv = 0;
    metrics.api.trendOhlcv = 0;
    metrics.api.balance = 0;
    metrics.api.positions = 0;
    metrics.api.orders = 0;
    metrics.signals.analyzed = 0;
    metrics.signals.breakoutDetected = 0;
    metrics.signals.longConfirmed = 0;
    metrics.signals.shortConfirmed = 0;
};

const startMetricsReporting = () => {
    if (metricsTimer) return;
    metricsTimer = setInterval(() => {
        const elapsedSec = Math.max(1, Math.round((Date.now() - metrics.windowStart) / 1000));
        const apiTotal =
            metrics.api.ticker +
            metrics.api.breakoutOhlcv +
            metrics.api.trendOhlcv +
            metrics.api.balance +
            metrics.api.positions +
            metrics.api.orders;
        const winRate = metrics.trades.closed > 0
            ? ((metrics.trades.wins / metrics.trades.closed) * 100).toFixed(1)
            : "0.0";

        console.log(
            `[METRICS] ${elapsedSec}s | API=${apiTotal} (ticker:${metrics.api.ticker}, breakout:${metrics.api.breakoutOhlcv}, trend:${metrics.api.trendOhlcv}, bal:${metrics.api.balance}, pos:${metrics.api.positions}, order:${metrics.api.orders}) | Signals=${metrics.signals.analyzed} (breakout:${metrics.signals.breakoutDetected}, long:${metrics.signals.longConfirmed}, short:${metrics.signals.shortConfirmed}) | Trades today O/C/W/L=${metrics.trades.opened}/${metrics.trades.closed}/${metrics.trades.wins}/${metrics.trades.losses} (WR ${winRate}%)`
        );

        resetMetricWindow();
    }, METRICS_LOG_INTERVAL);
};

// -------------------- DEFAULT CONFIG --------------------
const getDefaultConfig = () => ({
    pair: "DOGE/USDT:USDT",
    usdtPerTrade: 10,
    leverage: 10,
    targetProfitUSDT: 0.5,
    targetDailyProfit: 1.0,
    maxDailyLossPercent: 10,
    maxTradesPerDay: 3,
    coolingPeriod: 3000,
    activePosition: null,
    dailyPnL: 0,
    dailyTrades: 0,
    marginMode: "isolated",
    monitoringInterval: 500,
    stopLossPercent: 5,
    breakoutPeriod: 20,
    breakoutTimeframe: "5m",
    minBreakoutStrength: 0.003,
    volumePeriod: 20,
    minVolumeRatio: 1.4,
    maxPriceDeviationPercent: 0.5,
    trendEnabled: true,
    trendTimeframe: "1h",
    trendPeriod: 120,
    adaptiveEnabled: true,
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
        volumePeriod: { min: 2, allowZero: false, integer: true },
        minVolumeRatio: { min: 1, allowZero: false },
        maxPriceDeviationPercent: { min: 0, allowZero: true },
        trendPeriod: { min: 2, allowZero: false, integer: true }
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

    return normalized;
};

const applyDataDrivenConfigTuning = (config) => {
    if (!config || typeof config !== "object") return false;
    let changed = false;

    // Data-backed relaxation:
    // - 7-day DOGE 5m volume ratio p75~1.17, p90~1.98
    // - 2.0x volume filter is too restrictive for daily consistency
    if (Number(config.minVolumeRatio) === 2) {
        config.minVolumeRatio = 1.4;
        changed = true;
    }

    // Long trend period can over-filter entries on intraday breakout strategy.
    if (Number(config.trendPeriod) === 200) {
        config.trendPeriod = 120;
        changed = true;
    }

    return changed;
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
        if (applyDataDrivenConfigTuning(db)) {
            await saveDB();
            console.log("[TUNE] Applied data-driven config relaxation (volume/trend).");
        }

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
        if (applyDataDrivenConfigTuning(db)) {
            await saveDB();
            console.log("[TUNE] Applied data-driven config relaxation (volume/trend).");
        }
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
                stopLossUSDT: db.usdtPerTrade * (db.stopLossPercent / 100),
                orderId: `SYNC_${Date.now()}`,
                quantity: Math.abs(contracts),
                entryTime: Date.now() - 300000,
                marginMode: (db.marginMode || "isolated").toLowerCase(),
                targetProfitUSDT: db.targetProfitUSDT
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

// -------------------- BREAKOUT SIGNAL DETECTION --------------------
const analyzeSignal = async () => {
    try {
        if (!db) return {};
        signalCount++;
        metrics.signals.analyzed++;
        const now = Date.now();
        if (now - lastLogTime > 5000) {
            console.log(`\n[SIGNAL #${signalCount}] Analyzing market for BREAKOUT (${db.breakoutTimeframe})...`);
            lastLogTime = now;
        }

        const ohlcv = await getBreakoutOHLCV();
        const minCandles = Math.max(db.breakoutPeriod + 1, db.volumePeriod + 1, 8);
        if (ohlcv.length < minCandles) {
            console.log(`[WARN] Not enough OHLCV data: ${ohlcv.length} candles`);
            return {};
        }

        const close = ohlcv.map(c => c[4]);
        const high = ohlcv.map(c => c[2]);
        const low = ohlcv.map(c => c[3]);
        const volume = ohlcv.map(c => c[5]);

        const currentPrice = close[close.length - 1];
        const currentHigh = high[high.length - 1];
        const currentLow = low[low.length - 1];
        const currentVolume = volume[volume.length - 1];

        const volumePeriod = db.volumePeriod;
        const avgVolume = volume.slice(-volumePeriod - 1, -1).reduce((a, b) => a + b, 0) / volumePeriod;
        const safeAvgVolume = avgVolume > 0 ? avgVolume : Number.EPSILON;

        const lookbackPeriod = db.breakoutPeriod;
        const previousHighs = high.slice(-lookbackPeriod - 1, -1);
        const previousLows = low.slice(-lookbackPeriod - 1, -1);
        const resistance = Math.max(...previousHighs);
        const support = Math.min(...previousLows);
        const range = resistance - support;
        if (!Number.isFinite(resistance) || !Number.isFinite(support) || !Number.isFinite(range) || range <= 0) {
            console.log("[WARN] Invalid breakout range data. Signal skipped.");
            return {};
        }
        const breakoutThreshold = range * db.minBreakoutStrength;

        const rsi = RSI.calculate({ values: close, period: 7 });
        const currentRSI = rsi.length > 0 ? rsi[rsi.length - 1] : 50;

        const bullishBreakout = currentHigh > resistance + breakoutThreshold;
        const bearishBreakout = currentLow < support - breakoutThreshold;
        const volumeOk = currentVolume > safeAvgVolume * db.minVolumeRatio;
        const hasBreakout = bullishBreakout || bearishBreakout;
        if (hasBreakout) metrics.signals.breakoutDetected++;
        const shouldDetailLog = hasBreakout || (Date.now() - lastSignalDetailLogAt >= SIGNAL_DETAIL_LOG_TTL);

        let canLong = bullishBreakout && currentRSI > 50 && currentRSI < 75 && volumeOk;
        let canShort = bearishBreakout && currentRSI > 25 && currentRSI < 50 && volumeOk;

        if (db.trendEnabled && trendData.ema) {
            if (currentPrice <= trendData.ema) canLong = false;
            if (currentPrice >= trendData.ema) canShort = false;
        }
        if (canLong) metrics.signals.longConfirmed++;
        if (canShort) metrics.signals.shortConfirmed++;

        if (shouldDetailLog) {
            console.log("\n" + "=".repeat(50));
            console.log(`BREAKOUT LEVELS (${db.breakoutTimeframe}):`);
            console.log(`   Current Price: ${currentPrice}`);
            console.log(`   Current Volume: ${currentVolume.toFixed(2)}`);
            console.log(`   Avg Volume (${volumePeriod}): ${avgVolume.toFixed(2)}`);
            console.log(`   Volume Ratio: ${(currentVolume / safeAvgVolume).toFixed(2)}x (min ${db.minVolumeRatio}x)`);
            console.log(`   Resistance: ${resistance.toFixed(6)}`);
            console.log(`   Support: ${support.toFixed(6)}`);
            console.log(`   Range: ${range.toFixed(6)}`);
            console.log(`   Breakout Threshold: ±${breakoutThreshold.toFixed(6)} (${db.minBreakoutStrength*100}% of range)`);
            console.log(`   RSI 7: ${currentRSI.toFixed(2)}`);
            console.log("");
            console.log("BREAKOUT CONDITIONS:");
            console.log(`   Bullish Breakout: ${bullishBreakout ? "[OK] ABOVE RESISTANCE" : "[NO] NOT BROKEN"}`);
            console.log(`   Bearish Breakout: ${bearishBreakout ? "[OK] BELOW SUPPORT" : "[NO] NOT BROKEN"}`);
            console.log(`   Volume OK: ${volumeOk ? "[OK]" : "[NO]"}`);
            if (db.trendEnabled && trendData.ema) {
                console.log(`   Trend EMA: ${trendData.ema} → Long allowed: ${canLong}, Short allowed: ${canShort}`);
            }
            console.log("");
            console.log("FINAL SIGNAL:");
            console.log(`   LONG Signal: ${canLong ? "[OK] CONFIRMED" : "[NO] NOT CONFIRMED"}`);
            console.log(`   SHORT Signal: ${canShort ? "[OK] CONFIRMED" : "[NO] NOT CONFIRMED"}`);
            console.log("=".repeat(50));
            lastSignalDetailLogAt = Date.now();
        }

        return { canLong, canShort, price: currentPrice, rsi: currentRSI, resistance, support, hasSignal: hasBreakout };
    } catch (error) {
        console.error("[ERROR] Breakout analysis failed:", error.message);
        return {};
    }
};

// -------------------- PLACE ORDER --------------------
const placeOrder = async (side, signalPrice) => {
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

        const targetProfitUSDT = db.targetProfitUSDT;
        let targetPrice;
        if (side === "buy") {
            targetPrice = entryPrice + (targetProfitUSDT / adjustedQty);
        } else {
            targetPrice = entryPrice - (targetProfitUSDT / adjustedQty);
        }
        const pricePrecision = market?.precision?.price || 8;
        targetPrice = parseFloat(targetPrice.toFixed(pricePrecision));

        const stopLossUSDT = -db.usdtPerTrade * (db.stopLossPercent / 100);
        let stopLossPrice;
        if (side === "buy") {
            stopLossPrice = entryPrice + (stopLossUSDT / adjustedQty);
        } else {
            stopLossPrice = entryPrice - (stopLossUSDT / adjustedQty);
        }
        stopLossPrice = parseFloat(stopLossPrice.toFixed(pricePrecision));

        console.log(`   Order Details:`);
        console.log(`   - Amount: ${db.usdtPerTrade} USDT × ${db.leverage}x = ${(db.usdtPerTrade * db.leverage).toFixed(2)} USDT`);
        console.log(`   - Quantity: ${adjustedQty} ${db.pair.split('/')[0]}`);
        console.log(`   - Entry Price: ${entryPrice}`);
        console.log(`   - Target Profit: ${targetProfitUSDT} USDT (1:1 risk-reward)`);
        console.log(`   - Target Price: ${targetPrice}`);
        console.log(`   - Stop Loss: ${stopLossUSDT} USDT (${db.stopLossPercent}%)`);
        console.log(`   - Stop Loss Price: ${stopLossPrice}`);

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
            marginMode: (db.marginMode || "isolated").toLowerCase(),
            targetProfitUSDT: targetProfitUSDT
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

const getBreakoutOHLCV = async (forceRefresh = false) => {
    const timeframe = db?.breakoutTimeframe || "5m";
    const limit = (db?.breakoutPeriod || 20) + 10 + (db?.volumePeriod || 20);
    const cacheKey = `${db?.pair || ""}:${timeframe}:${limit}`;
    const now = Date.now();

    if (
        !forceRefresh &&
        breakoutOhlcvCache.key === cacheKey &&
        now - breakoutOhlcvCache.lastUpdate < OHLCV_CACHE_TTL &&
        Array.isArray(breakoutOhlcvCache.data)
    ) {
        return breakoutOhlcvCache.data;
    }

    const ohlcv = await exchange.fetchOHLCV(db.pair, timeframe, undefined, limit);
    metrics.api.breakoutOhlcv++;
    breakoutOhlcvCache = { key: cacheKey, data: ohlcv, lastUpdate: now };
    return ohlcv;
};

const runAdaptiveConfigTuning = async () => {
    if (!db || !exchange || isAdaptiveTuning) return;
    if (!db.trendEnabled && !db.breakoutTimeframe) return;
    isAdaptiveTuning = true;
    try {
        const timeframe = db.breakoutTimeframe || "5m";
        const limit = Math.max(
            ADAPTIVE_LOOKBACK_CANDLES,
            (db.breakoutPeriod || 20) + (db.volumePeriod || 20) + 30
        );
        const ohlcv = await exchange.fetchOHLCV(db.pair, timeframe, undefined, limit);
        metrics.api.breakoutOhlcv++;
        if (!Array.isArray(ohlcv) || ohlcv.length < Math.max(80, (db.volumePeriod || 20) + 10)) {
            return;
        }

        const highs = ohlcv.map(c => toFiniteNumber(c[2], 0));
        const lows = ohlcv.map(c => toFiniteNumber(c[3], 0));
        const volumes = ohlcv.map(c => toFiniteNumber(c[5], 0));
        const period = Math.max(2, Math.trunc(db.breakoutPeriod || 20));
        const volumePeriod = Math.max(2, Math.trunc(db.volumePeriod || 20));
        const minStrength = toFiniteNumber(db.minBreakoutStrength, 0.003);
        const start = Math.max(period, volumePeriod);

        const volRatios = [];
        let breakoutCount = 0;
        let tested = 0;
        for (let i = start; i < ohlcv.length; i++) {
            const resistance = Math.max(...highs.slice(i - period, i));
            const support = Math.min(...lows.slice(i - period, i));
            const range = resistance - support;
            if (!Number.isFinite(range) || range <= 0) continue;

            tested++;
            const threshold = range * minStrength;
            if (highs[i] > resistance + threshold || lows[i] < support - threshold) {
                breakoutCount++;
            }

            const avgVol = volumes.slice(i - volumePeriod, i).reduce((a, b) => a + b, 0) / volumePeriod;
            if (avgVol > 0) volRatios.push(volumes[i] / avgVol);
        }

        if (tested < 30 || volRatios.length < 30) return;
        const sortedRatios = [...volRatios].sort((a, b) => a - b);
        const p75 = quantile(sortedRatios, 0.75);
        const breakoutRatePct = (breakoutCount / tested) * 100;

        const oldVolumeRatio = toFiniteNumber(db.minVolumeRatio, 1.4);
        const oldBreakoutPeriod = period;

        const targetVolumeRatio = clamp(
            Number((p75 * 1.05).toFixed(2)),
            ADAPTIVE_MIN_VOLUME_RATIO_MIN,
            ADAPTIVE_MIN_VOLUME_RATIO_MAX
        );
        const volumeDelta = clamp(
            targetVolumeRatio - oldVolumeRatio,
            -ADAPTIVE_MIN_VOLUME_RATIO_STEP,
            ADAPTIVE_MIN_VOLUME_RATIO_STEP
        );
        const newVolumeRatio = Number(
            clamp(oldVolumeRatio + volumeDelta, ADAPTIVE_MIN_VOLUME_RATIO_MIN, ADAPTIVE_MIN_VOLUME_RATIO_MAX).toFixed(2)
        );

        let breakoutPeriodDelta = 0;
        if (breakoutRatePct > 22) breakoutPeriodDelta = ADAPTIVE_BREAKOUT_PERIOD_STEP;
        else if (breakoutRatePct < 10) breakoutPeriodDelta = -ADAPTIVE_BREAKOUT_PERIOD_STEP;

        const newBreakoutPeriod = clamp(
            oldBreakoutPeriod + breakoutPeriodDelta,
            ADAPTIVE_BREAKOUT_PERIOD_MIN,
            ADAPTIVE_BREAKOUT_PERIOD_MAX
        );

        let changed = false;
        if (Math.abs(newVolumeRatio - oldVolumeRatio) >= 0.01) {
            db.minVolumeRatio = newVolumeRatio;
            changed = true;
        }
        if (newBreakoutPeriod !== oldBreakoutPeriod) {
            db.breakoutPeriod = newBreakoutPeriod;
            changed = true;
        }

        if (changed) {
            await saveDB();
            console.log(
                `[ADAPTIVE] Updated config from market stats (${timeframe}, ${ohlcv.length} candles): minVolumeRatio ${oldVolumeRatio} -> ${db.minVolumeRatio}, breakoutPeriod ${oldBreakoutPeriod} -> ${db.breakoutPeriod}, breakoutRate=${breakoutRatePct.toFixed(2)}%, volP75=${p75.toFixed(2)}`
            );
        } else {
            console.log(
                `[ADAPTIVE] No config change (${timeframe}): breakoutRate=${breakoutRatePct.toFixed(2)}%, volP75=${p75.toFixed(2)}, minVolumeRatio=${oldVolumeRatio}, breakoutPeriod=${oldBreakoutPeriod}`
            );
        }
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
        const strategy = `BREAKOUT_${String(db.breakoutTimeframe || "5m").toUpperCase()}`;
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

        const { side, entryPrice, quantity, targetProfitUSDT } = db.activePosition;
        if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
            console.error("[ERROR] Invalid active position data for P&L monitoring.");
            return;
        }
        const profitUSDT = side === "buy"
            ? (currentPrice - entryPrice) * quantity
            : (entryPrice - currentPrice) * quantity;
        const profitPercent = side === "buy"
            ? ((currentPrice - entryPrice) / entryPrice * 100)
            : ((entryPrice - currentPrice) / entryPrice * 100);

        if (profitUSDT >= targetProfitUSDT) {
            console.log(`\n[PROFIT] Target hit (+${targetProfitUSDT} USDT)! Closing...`);
            await closePosition("PROFIT_TARGET", profitUSDT, profitPercent);
            return;
        }

        const stopLossUSDT = -db.usdtPerTrade * (db.stopLossPercent / 100);
        if (profitUSDT <= stopLossUSDT) {
            console.log(`\n[STOP] Stop loss hit (${stopLossUSDT} USDT)! Closing...`);
            await closePosition("STOP_LOSS", profitUSDT, profitPercent);
            return;
        }

        const nearExit =
            profitUSDT >= (targetProfitUSDT * 0.7) ||
            profitUSDT <= (stopLossUSDT * 0.7);
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
        trendTimer = setInterval(updateTrend, 15 * 60 * 1000);

        startPnLMonitoring();
        startPositionSync();
        startMetricsReporting();
        startAdaptiveTuning();
        process.once("SIGINT", () => { shutdown("SIGINT"); });
        process.once("SIGTERM", () => { shutdown("SIGTERM"); });

        const totalUSDT = await getTotalUSDTBalance(true);

        console.log("\n" + "=".repeat(70));
        console.log("BREAKOUT SCALPING BOT (5m, Volume 2x, RSI Ketat)");
        console.log("=".repeat(70));
        console.log(`Balance: $${totalUSDT.toFixed(2)}`);
        console.log(`Pair: ${db.pair}`);
        console.log(`Strategy: ${db.breakoutTimeframe} breakout (${db.breakoutPeriod}c) + Volume ${db.minVolumeRatio}x + RSI`);
        console.log(`Target per trade: $${db.targetProfitUSDT} | Stop loss: $${(db.usdtPerTrade * db.stopLossPercent/100).toFixed(2)}`);
        console.log(`Risk:Reward = 1:1`);
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
                if (signal.canLong) await placeOrder("buy", signal.price);
                else if (signal.canShort) await placeOrder("sell", signal.price);

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
