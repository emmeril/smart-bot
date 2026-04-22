const test = require("node:test");
const assert = require("node:assert/strict");

const { createConfigModelHelpers } = require("../services/config-model");

const defaultConfig = {
    leverage: 10,
    maxTradesPerDay: 20,
    monitoringInterval: 500,
    gridLevels: 8,
    gridLookbackCandles: 120,
    gridTakeProfitLevels: 0,
    gridOrdersPerSide: 0,
    gridOrderSizeUsdt: 0,
    gridTargetProfitUsdt: 0.5,
    coolingPeriod: 3000,
    gridStopLossPercent: 5,
    gridRangePercent: 3.5,
    gridEntryBufferPercent: 0.15,
    gridStopLossLevels: 0,
    sessionStartUTC: 0,
    sessionEndUTC: 23,
    volumePeriod: 20,
    minVolumeRatio: 1.3,
    atrPeriod: 14,
    targetProfitAtrMultiplier: 0.75,
    targetProfitMinUsdt: 0.25,
    targetProfitMaxUsdt: 3,
    stopLossAtrMultiplier: 0.12,
    stopLossMinPercent: 3,
    stopLossMaxPercent: 7,
    trailingActivateATR: 1.2,
    trailingOffsetATR: 0.6,
    pair: "DOGE/USDT",
    strategy: "futures_grid",
    marginMode: "isolated",
    gridTimeframe: "5m",
    activePosition: null,
    activeGridState: null,
    trailingEnabled: true,
    allowLong: true,
    allowShort: true,
    autoTargetProfitEnabled: true,
    autoStopLossEnabled: true,
    dailyPnL: 0,
    dailyTrades: 0,
    lastDailyReset: 1,
    lastUpdated: 1
};

const createHelpers = () => createConfigModelHelpers({
    sequelize: {},
    Config: {},
    booleanConfigKeys: ["trailingEnabled", "allowLong", "allowShort", "autoTargetProfitEnabled", "autoStopLossEnabled"],
    defaultConfig,
    validMarginModes: ["cross", "isolated"],
    withSqliteBusyRetry: async (fn) => fn(),
    getDefaultConfig: () => ({ ...defaultConfig }),
    toFiniteNumber: (value, fallback = 0) => {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : fallback;
    },
    clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
    isLegacySinglePosition: () => false,
    toPositionMapKey: (key) => String(key || "").toUpperCase()
});

test("normalizeConfig rejects fractional integer inputs that truncate below the allowed minimum", () => {
    const helpers = createHelpers();

    const normalized = helpers.normalizeConfig({
        leverage: 0.5,
        maxTradesPerDay: 0.5,
        monitoringInterval: 199.9,
        gridLevels: 3.9
    });

    assert.equal(normalized.leverage, defaultConfig.leverage);
    assert.equal(normalized.maxTradesPerDay, defaultConfig.maxTradesPerDay);
    assert.equal(normalized.monitoringInterval, defaultConfig.monitoringInterval);
    assert.equal(normalized.gridLevels, defaultConfig.gridLevels);
});

test("normalizeConfig still accepts valid integer-like numeric strings", () => {
    const helpers = createHelpers();

    const normalized = helpers.normalizeConfig({
        leverage: "7.9",
        maxTradesPerDay: "12",
        monitoringInterval: "900",
        gridLevels: "10"
    });

    assert.equal(normalized.leverage, 7);
    assert.equal(normalized.maxTradesPerDay, 12);
    assert.equal(normalized.monitoringInterval, 900);
    assert.equal(normalized.gridLevels, 10);
});

test("normalizeConfig allows gridLevels zero for automatic mode", () => {
    const helpers = createHelpers();

    const normalized = helpers.normalizeConfig({
        gridLevels: 0,
        gridRangePercent: 0,
        gridEntryBufferPercent: 0,
        gridTakeProfitLevels: 0,
        gridOrdersPerSide: 0
    });

    assert.equal(normalized.gridLevels, 0);
    assert.equal(normalized.gridRangePercent, 0);
    assert.equal(normalized.gridEntryBufferPercent, 0);
    assert.equal(normalized.gridTakeProfitLevels, 0);
    assert.equal(normalized.gridOrdersPerSide, 0);
});
