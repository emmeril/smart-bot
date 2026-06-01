const path = require("path");
const { Sequelize, DataTypes } = require("sequelize");

const sequelize = new Sequelize({
    dialect: "sqlite",
    storage: path.join(__dirname, "..", "database.sqlite"),
    logging: false
});

const Config = sequelize.define("Config", {
    strategy: { type: DataTypes.STRING, defaultValue: "spot_grid" },
    pair: { type: DataTypes.STRING, defaultValue: "DOGE/USDT" },
    pendingPair: { type: DataTypes.STRING, defaultValue: null },
    gridOrderSizeUsdt: { type: DataTypes.FLOAT, defaultValue: 0 },
    gridTargetProfitUsdt: { type: DataTypes.FLOAT, defaultValue: 0.15 },
    coolingPeriod: { type: DataTypes.INTEGER, defaultValue: 10000 },
    activePosition: { type: DataTypes.TEXT, defaultValue: null },
    activeGridState: { type: DataTypes.TEXT, defaultValue: null },
    dailyPnL: { type: DataTypes.FLOAT, defaultValue: 0 },
    dailyTrades: { type: DataTypes.INTEGER, defaultValue: 0 },
    estimatedPnL: { type: DataTypes.FLOAT, defaultValue: 0 },
    estimatedTrades: { type: DataTypes.INTEGER, defaultValue: 0 },
    dailyPnlSource: { type: DataTypes.STRING, defaultValue: "local" },
    dailyPnlSyncedAt: { type: DataTypes.BIGINT, defaultValue: 0 },
    marginMode: { type: DataTypes.STRING, defaultValue: "spot" },
    monitoringInterval: { type: DataTypes.INTEGER, defaultValue: 500 },
    gridStopLossPercent: { type: DataTypes.FLOAT, defaultValue: 2.4 },
    syncExchangePnl: { type: DataTypes.BOOLEAN, defaultValue: false },

    gridLevels: { type: DataTypes.INTEGER, defaultValue: 0 },
    gridLookbackCandles: { type: DataTypes.INTEGER, defaultValue: 200 },
    gridRangePercent: { type: DataTypes.FLOAT, defaultValue: 0 },
    gridEntryBufferPercent: { type: DataTypes.FLOAT, defaultValue: 0 },
    gridTakeProfitLevels: { type: DataTypes.INTEGER, defaultValue: 0 },
    gridOrdersPerSide: { type: DataTypes.INTEGER, defaultValue: 0 },
    gridAutoOrdersCap: { type: DataTypes.INTEGER, defaultValue: 200 },
    gridStopLossLevels: { type: DataTypes.FLOAT, defaultValue: 0 },

    gridTimeframe: { type: DataTypes.STRING, defaultValue: "5m" },
    sessionStartUTC: { type: DataTypes.INTEGER, defaultValue: 0 },
    sessionEndUTC: { type: DataTypes.INTEGER, defaultValue: 23 },
    volumePeriod: { type: DataTypes.INTEGER, defaultValue: 20 },
    minVolumeRatio: { type: DataTypes.FLOAT, defaultValue: 1.05 },
    atrPeriod: { type: DataTypes.INTEGER, defaultValue: 14 },
    riskRewardRatio: { type: DataTypes.FLOAT, defaultValue: 1.35 },
    trailingEnabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    autoStopLossEnabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    stopLossAtrMultiplier: { type: DataTypes.FLOAT, defaultValue: 1.4 },
    stopLossMinPercent: { type: DataTypes.FLOAT, defaultValue: 1.2 },
    stopLossMaxPercent: { type: DataTypes.FLOAT, defaultValue: 3.5 },
    autoTargetProfitEnabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    gridRecalculateExitsOnScaleIn: { type: DataTypes.BOOLEAN, defaultValue: true },
    targetProfitAtrMultiplier: { type: DataTypes.FLOAT, defaultValue: 1.8 },
    targetProfitMinUsdt: { type: DataTypes.FLOAT, defaultValue: 0.05 },
    targetProfitMaxUsdt: { type: DataTypes.FLOAT, defaultValue: 1.2 },
    trailingActivateATR: { type: DataTypes.FLOAT, defaultValue: 1.8 },
    trailingOffsetATR: { type: DataTypes.FLOAT, defaultValue: 0.9 },
    entryRsiPeriod: { type: DataTypes.INTEGER, defaultValue: 14 },
    entryRsiLongThreshold: { type: DataTypes.FLOAT, defaultValue: 38 },
    entryRsiShortThreshold: { type: DataTypes.FLOAT, defaultValue: 62 },
    entryAdxPeriod: { type: DataTypes.INTEGER, defaultValue: 14 },
    entryAdxMax: { type: DataTypes.FLOAT, defaultValue: 26 },
    entryBbPeriod: { type: DataTypes.INTEGER, defaultValue: 20 },
    entryBbStdDev: { type: DataTypes.FLOAT, defaultValue: 2 },
    entryBbLongThreshold: { type: DataTypes.FLOAT, defaultValue: 0.18 },
    entryBbShortThreshold: { type: DataTypes.FLOAT, defaultValue: 0.82 },

    lastDailyReset: { type: DataTypes.BIGINT, defaultValue: () => Date.now() },
    lastUpdated: { type: DataTypes.BIGINT, defaultValue: () => Date.now() }
}, { timestamps: false });

const BOOLEAN_CONFIG_KEYS = ["trailingEnabled", "autoTargetProfitEnabled", "autoStopLossEnabled", "gridRecalculateExitsOnScaleIn", "syncExchangePnl"];
const VALID_MARGIN_MODES = ["spot"];
const DEFAULT_CONFIG = {
    strategy: "spot_grid",
    pair: "DOGE/USDT",
    pendingPair: null,
    gridOrderSizeUsdt: 0,
    gridTargetProfitUsdt: 0.15,
    coolingPeriod: 10000,
    activePosition: null,
    activeGridState: null,
    dailyPnL: 0,
    dailyTrades: 0,
    estimatedPnL: 0,
    estimatedTrades: 0,
    dailyPnlSource: "local",
    dailyPnlSyncedAt: 0,
    marginMode: "spot",
    monitoringInterval: 500,
    gridStopLossPercent: 2.4,
    syncExchangePnl: false,
    autoStopLossEnabled: true,
    stopLossAtrMultiplier: 1.4,
    stopLossMinPercent: 1.2,
    stopLossMaxPercent: 3.5,
    autoTargetProfitEnabled: true,
    gridRecalculateExitsOnScaleIn: true,
    targetProfitAtrMultiplier: 1.8,
    targetProfitMinUsdt: 0.05,
    targetProfitMaxUsdt: 1.2,
    gridLevels: 0,
    gridLookbackCandles: 200,
    gridRangePercent: 0,
    gridEntryBufferPercent: 0,
    gridTakeProfitLevels: 0,
    gridOrdersPerSide: 0,
    gridAutoOrdersCap: 200,
    gridStopLossLevels: 0,
    gridTimeframe: "5m",
    sessionStartUTC: 0,
    sessionEndUTC: 23,
    volumePeriod: 20,
    minVolumeRatio: 1.05,
    atrPeriod: 14,
    riskRewardRatio: 1.35,
    trailingEnabled: true,
    trailingActivateATR: 1.8,
    trailingOffsetATR: 0.9,
    entryRsiPeriod: 14,
    entryRsiLongThreshold: 38,
    entryRsiShortThreshold: 62,
    entryAdxPeriod: 14,
    entryAdxMax: 26,
    entryBbPeriod: 20,
    entryBbStdDev: 2,
    entryBbLongThreshold: 0.18,
    entryBbShortThreshold: 0.82
};

const DASHBOARD_EDITABLE_FIELDS = [
    { key: "pair", label: "Pair", section: "General", type: "text", placeholder: "DOGE/USDT", description: "Spot symbol to trade." },
    { key: "gridOrderSizeUsdt", label: "Grid Order Size (USDT)", section: "Risk", type: "number", min: 0, step: 0.1, description: "Order size per grid entry in USDT. Parameter lain ditentukan otomatis dari data market valid (OHLCV, ATR, volume, RSI, ADX, Bollinger Band)." }
];

const DASHBOARD_EDITABLE_KEYS = new Set(DASHBOARD_EDITABLE_FIELDS.map((field) => field.key));
const RUNTIME_PROTECTED_CONFIG_KEYS = ["strategy", "pair", "marginMode", "gridTimeframe"];
const DASHBOARD_PROTECTED_KEYS = new Set(RUNTIME_PROTECTED_CONFIG_KEYS);
const DASHBOARD_USERNAME = String(process.env.DASHBOARD_USERNAME || "admin");
const DASHBOARD_PASSWORD = String(process.env.DASHBOARD_PASSWORD || "admin123");
const DASHBOARD_SESSION_SECRET = String(process.env.DASHBOARD_SESSION_SECRET || process.env.API_SECRET || "smart-bot-dashboard-secret");
const DASHBOARD_SESSION_COOKIE = "smartbot_dashboard_session";
const DASHBOARD_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const CONFIG_AUTO_RELOAD_INTERVAL_MS = Math.max(3000, Math.trunc(Number(process.env.CONFIG_AUTO_RELOAD_INTERVAL_MS || 5000) || 5000));

module.exports = {
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
};
