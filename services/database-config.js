const path = require("path");
const { Sequelize, DataTypes } = require("sequelize");

const sequelize = new Sequelize({
    dialect: "sqlite",
    storage: path.join(__dirname, "..", "database.sqlite"),
    logging: false
});

const Config = sequelize.define("Config", {
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

    gridLevels: { type: DataTypes.INTEGER, defaultValue: 8 },
    gridLookbackCandles: { type: DataTypes.INTEGER, defaultValue: 120 },
    gridRangePercent: { type: DataTypes.FLOAT, defaultValue: 3.5 },
    gridEntryBufferPercent: { type: DataTypes.FLOAT, defaultValue: 0.15 },
    gridTakeProfitLevels: { type: DataTypes.INTEGER, defaultValue: 0 },
    gridOrdersPerSide: { type: DataTypes.INTEGER, defaultValue: 0 },
    gridStopLossLevels: { type: DataTypes.FLOAT, defaultValue: 0 },

    gridTimeframe: { type: DataTypes.STRING, defaultValue: "5m" },
    sessionStartUTC: { type: DataTypes.INTEGER, defaultValue: 0 },
    sessionEndUTC: { type: DataTypes.INTEGER, defaultValue: 23 },
    volumePeriod: { type: DataTypes.INTEGER, defaultValue: 20 },
    minVolumeRatio: { type: DataTypes.FLOAT, defaultValue: 1.3 },
    atrPeriod: { type: DataTypes.INTEGER, defaultValue: 14 },
    trailingEnabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    autoStopLossEnabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    stopLossAtrMultiplier: { type: DataTypes.FLOAT, defaultValue: 0.12 },
    stopLossMinPercent: { type: DataTypes.FLOAT, defaultValue: 3 },
    stopLossMaxPercent: { type: DataTypes.FLOAT, defaultValue: 7 },
    autoTargetProfitEnabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    targetProfitAtrMultiplier: { type: DataTypes.FLOAT, defaultValue: 0.75 },
    targetProfitMinUsdt: { type: DataTypes.FLOAT, defaultValue: 0.25 },
    targetProfitMaxUsdt: { type: DataTypes.FLOAT, defaultValue: 3 },
    trailingActivateATR: { type: DataTypes.FLOAT, defaultValue: 1.2 },
    trailingOffsetATR: { type: DataTypes.FLOAT, defaultValue: 0.6 },
    allowLong: { type: DataTypes.BOOLEAN, defaultValue: true },
    allowShort: { type: DataTypes.BOOLEAN, defaultValue: true },

    lastDailyReset: { type: DataTypes.BIGINT, defaultValue: () => Date.now() },
    lastUpdated: { type: DataTypes.BIGINT, defaultValue: () => Date.now() }
}, { timestamps: false });

const BOOLEAN_CONFIG_KEYS = ["trailingEnabled", "allowLong", "allowShort", "autoTargetProfitEnabled", "autoStopLossEnabled"];
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
    autoStopLossEnabled: true,
    stopLossAtrMultiplier: 0.12,
    stopLossMinPercent: 3,
    stopLossMaxPercent: 7,
    autoTargetProfitEnabled: true,
    targetProfitAtrMultiplier: 0.75,
    targetProfitMinUsdt: 0.25,
    targetProfitMaxUsdt: 3,
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

const DASHBOARD_EDITABLE_FIELDS = [
    { key: "strategy", label: "Strategy", section: "General", type: "select", options: ["futures_grid"], description: "Main strategy used by the bot." },
    { key: "pair", label: "Pair", section: "General", type: "text", placeholder: "DOGE/USDT:USDT", description: "Futures symbol to trade." },
    { key: "marginMode", label: "Margin Mode", section: "General", type: "select", options: ["isolated", "cross"], description: "Margin mode used on the exchange." },
    { key: "leverage", label: "Leverage", section: "General", type: "number", min: 1, step: 1, description: "Futures leverage." },
    { key: "monitoringInterval", label: "Monitoring Interval", section: "General", type: "number", min: 200, step: 100, description: "PnL monitoring interval in milliseconds." },
    { key: "coolingPeriod", label: "Cooling Period", section: "General", type: "number", min: 0, step: 500, description: "Cooldown after a trade in milliseconds." },
    { key: "gridOrderSizeUsdt", label: "Grid Order Size (USDT)", section: "Risk", type: "number", min: 0, step: 0.1, description: "Order size per grid entry in USDT." },
    { key: "gridTargetProfitUsdt", label: "Target Profit (USDT)", section: "Risk", type: "number", min: 0, step: 0.1, description: "Take-profit target in USDT." },
    { key: "autoTargetProfitEnabled", label: "Auto Target Profit", section: "Risk", type: "boolean", description: "Use ATR-based TP with a capped range instead of a fixed profit." },
    { key: "targetProfitAtrMultiplier", label: "TP ATR Multiplier", section: "Risk", type: "number", min: 0.1, step: 0.05, description: "ATR multiplier used to derive automatic target profit." },
    { key: "targetProfitMinUsdt", label: "TP Min (USDT)", section: "Risk", type: "number", min: 0, step: 0.05, description: "Lower bound for automatic target profit." },
    { key: "targetProfitMaxUsdt", label: "TP Max (USDT)", section: "Risk", type: "number", min: 0, step: 0.1, description: "Upper bound for automatic target profit." },
    { key: "gridStopLossPercent", label: "Stop Loss (%)", section: "Risk", type: "number", min: 0, step: 0.1, description: "Stop loss percentage used by the grid engine." },
    { key: "autoStopLossEnabled", label: "Auto Stop Loss", section: "Risk", type: "boolean", description: "Use ATR-based stop loss with a capped range instead of a fixed percentage." },
    { key: "stopLossAtrMultiplier", label: "SL ATR Multiplier", section: "Risk", type: "number", min: 0.05, step: 0.05, description: "ATR multiplier used to derive automatic stop loss." },
    { key: "stopLossMinPercent", label: "SL Min (%)", section: "Risk", type: "number", min: 0, step: 0.1, description: "Lower bound for automatic stop loss percent." },
    { key: "stopLossMaxPercent", label: "SL Max (%)", section: "Risk", type: "number", min: 0, step: 0.1, description: "Upper bound for automatic stop loss percent." },
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
