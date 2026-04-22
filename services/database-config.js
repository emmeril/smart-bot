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
    binanceBotMode: { type: DataTypes.STRING, defaultValue: "auto" },
    binanceGridType: { type: DataTypes.STRING, defaultValue: "arithmetic" },
    binanceDirection: { type: DataTypes.STRING, defaultValue: "neutral" },
    binanceLowerPrice: { type: DataTypes.FLOAT, defaultValue: 0 },
    binanceUpperPrice: { type: DataTypes.FLOAT, defaultValue: 0 },
    binanceInvestmentUsdt: { type: DataTypes.FLOAT, defaultValue: 0 },
    gridOrderSizeUsdt: { type: DataTypes.FLOAT, defaultValue: 0 },
    leverage: { type: DataTypes.INTEGER, defaultValue: 10 },
    gridTargetProfitUsdt: { type: DataTypes.FLOAT, defaultValue: 0.5 },
    dailyProfitTargetUsdt: { type: DataTypes.FLOAT, defaultValue: 1.0 },
    dailyMaxLossPercent: { type: DataTypes.FLOAT, defaultValue: 10 },
    maxTradesPerDay: { type: DataTypes.INTEGER, defaultValue: 20 },
    coolingPeriod: { type: DataTypes.INTEGER, defaultValue: 3000 },
    activePosition: { type: DataTypes.TEXT, defaultValue: null },
    activeGridState: { type: DataTypes.TEXT, defaultValue: null },
    pendingRuntimeConfig: { type: DataTypes.TEXT, defaultValue: null },
    dailyPnL: { type: DataTypes.FLOAT, defaultValue: 0 },
    dailyTrades: { type: DataTypes.INTEGER, defaultValue: 0 },
    dailyPnlSource: { type: DataTypes.STRING, defaultValue: "local" },
    dailyPnlSyncedAt: { type: DataTypes.BIGINT, defaultValue: 0 },
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
    binanceBotMode: "auto",
    binanceGridType: "arithmetic",
    binanceDirection: "neutral",
    binanceLowerPrice: 0,
    binanceUpperPrice: 0,
    binanceInvestmentUsdt: 100,
    gridOrderSizeUsdt: 25,
    leverage: 10,
    gridTargetProfitUsdt: 0.5,
    dailyProfitTargetUsdt: 1.0,
    dailyMaxLossPercent: 10,
    maxTradesPerDay: 20,
    coolingPeriod: 3000,
    activePosition: null,
    activeGridState: null,
    pendingRuntimeConfig: null,
    dailyPnL: 0,
    dailyTrades: 0,
    dailyPnlSource: "local",
    dailyPnlSyncedAt: 0,
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
    { key: "pair", label: "Trading Pair", section: "Market", type: "text", placeholder: "BTC/USDT:USDT", description: "Perpetual futures pair traded by the bot." },
    {
        key: "binanceBotMode",
        label: "Bot Mode",
        section: "Strategy",
        type: "select",
        options: [
            { value: "auto", label: "Auto" },
            { value: "manual", label: "Manual" }
        ],
        description: "Auto derives the grid from live volatility. Manual uses your explicit range and grid count."
    },
    {
        key: "binanceGridType",
        label: "Grid Type",
        section: "Strategy",
        type: "select",
        options: [
            { value: "arithmetic", label: "Arithmetic" },
            { value: "geometric", label: "Geometric" }
        ],
        description: "Arithmetic uses equal price spacing. Geometric uses equal percentage spacing."
    },
    {
        key: "binanceDirection",
        label: "Direction",
        section: "Strategy",
        type: "select",
        options: [
            { value: "neutral", label: "Neutral" },
            { value: "long", label: "Long" },
            { value: "short", label: "Short" }
        ],
        description: "Controls whether the bot trades both sides, long-only, or short-only."
    },
    { key: "leverage", label: "Leverage", section: "Capital", type: "number", min: 1, step: 1, description: "Exchange leverage applied to the grid strategy." },
    { key: "binanceInvestmentUsdt", label: "Investment (USDT)", section: "Capital", type: "number", min: 0, step: 0.1, description: "Total margin budget used to derive grid order allocation." },
    { key: "binanceLowerPrice", label: "Lower Price", section: "Manual Grid", type: "number", min: 0, step: "any", description: "Manual mode lower bound for the grid range." },
    { key: "binanceUpperPrice", label: "Upper Price", section: "Manual Grid", type: "number", min: 0, step: "any", description: "Manual mode upper bound for the grid range." },
    { key: "gridLevels", label: "Grid Count", section: "Manual Grid", type: "number", min: 2, step: 1, description: "Number of grid intervals across the selected range." },
    { key: "gridTimeframe", label: "Timeframe", section: "Strategy", type: "select", options: [
        { value: "1m", label: "1m" },
        { value: "3m", label: "3m" },
        { value: "5m", label: "5m" },
        { value: "15m", label: "15m" },
        { value: "30m", label: "30m" },
        { value: "1h", label: "1h" },
        { value: "4h", label: "4h" },
        { value: "1d", label: "1d" }
    ], description: "Candle interval used for auto parameter derivation and signal analysis." }
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
