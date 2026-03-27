#!/usr/bin/env node
"use strict";

require("dotenv").config();

const path = require("path");
const { Sequelize, DataTypes } = require("sequelize");

const DB_PATH = path.join(__dirname, "..", "database.sqlite");

const BOOLEAN_CONFIG_KEYS = ["trailingEnabled", "allowLong", "allowShort"];
const OBSOLETE_CONFIG_COLUMNS = ["autoRiskEnabled", "atrTargetMult", "atrStopMult"];

const GRID_PRESETS = {
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
    allowShort: true,
    activeGridState: null,
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
    allowShort: true,
    activeGridState: null,
  },
  doge: {
    strategy: "futures_grid",
    pair: "DOGE/USDT:USDT",
    marginMode: "isolated",
    leverage: 8,
    gridOrderSizeUsdt: 1.5,
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
    allowShort: true,
    activeGridState: null,
  },
};

const AUTO_PRESET_RULES = [
  { match: /DOGE/i, preset: "doge" },
  { match: /(PEPE|BONK|FLOKI|SHIB|MEME|1000)/i, preset: "volatile" },
];

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
  allowShort: true,
};

const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: DB_PATH,
  logging: false,
});

const Config = sequelize.define(
  "Config",
  {
    strategy: { type: DataTypes.STRING, defaultValue: DEFAULT_CONFIG.strategy },
    pair: { type: DataTypes.STRING, defaultValue: DEFAULT_CONFIG.pair },
    gridOrderSizeUsdt: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.gridOrderSizeUsdt },
    leverage: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.leverage },
    gridTargetProfitUsdt: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.gridTargetProfitUsdt },
    dailyProfitTargetUsdt: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.dailyProfitTargetUsdt },
    dailyMaxLossPercent: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.dailyMaxLossPercent },
    maxTradesPerDay: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.maxTradesPerDay },
    coolingPeriod: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.coolingPeriod },
    activePosition: { type: DataTypes.TEXT, defaultValue: null },
    activeGridState: { type: DataTypes.TEXT, defaultValue: null },
    dailyPnL: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.dailyPnL },
    dailyTrades: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.dailyTrades },
    marginMode: { type: DataTypes.STRING, defaultValue: DEFAULT_CONFIG.marginMode },
    monitoringInterval: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.monitoringInterval },
    gridStopLossPercent: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.gridStopLossPercent },
    gridLevels: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.gridLevels },
    gridLookbackCandles: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.gridLookbackCandles },
    gridRangePercent: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.gridRangePercent },
    gridEntryBufferPercent: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.gridEntryBufferPercent },
    gridTakeProfitLevels: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.gridTakeProfitLevels },
    gridOrdersPerSide: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.gridOrdersPerSide },
    gridStopLossLevels: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.gridStopLossLevels },
    gridTimeframe: { type: DataTypes.STRING, defaultValue: DEFAULT_CONFIG.gridTimeframe },
    sessionStartUTC: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.sessionStartUTC },
    sessionEndUTC: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.sessionEndUTC },
    volumePeriod: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.volumePeriod },
    minVolumeRatio: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.minVolumeRatio },
    atrPeriod: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.atrPeriod },
    trailingEnabled: { type: DataTypes.BOOLEAN, defaultValue: DEFAULT_CONFIG.trailingEnabled },
    trailingActivateATR: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.trailingActivateATR },
    trailingOffsetATR: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.trailingOffsetATR },
    allowLong: { type: DataTypes.BOOLEAN, defaultValue: DEFAULT_CONFIG.allowLong },
    allowShort: { type: DataTypes.BOOLEAN, defaultValue: DEFAULT_CONFIG.allowShort },
    lastDailyReset: { type: DataTypes.BIGINT, defaultValue: () => Date.now() },
    lastUpdated: { type: DataTypes.BIGINT, defaultValue: () => Date.now() },
  },
  { timestamps: false },
);

const printUsage = () => {
  console.log(
    [
      "Usage:",
      "  node scripts/config.js show",
      "  node scripts/config.js get <key>",
      "  node scripts/config.js set <key> <value>",
      "  node scripts/config.js reset <key>",
      "  node scripts/config.js preset <name>",
      "  node scripts/config.js autopreset [pair]",
      "  node scripts/config.js defaults",
      "",
      "Examples:",
      "  node scripts/config.js set leverage 20",
      "  node scripts/config.js set pair BTC/USDT:USDT",
      "  node scripts/config.js set gridOrderSizeUsdt 1.5",
      "  node scripts/config.js set gridOrderSizeUsdt 0",
      "  node scripts/config.js set gridTargetProfitUsdt 0.8",
      "  node scripts/config.js set gridStopLossPercent 4",
      "  node scripts/config.js set gridOrdersPerSide 0",
      "  node scripts/config.js set gridTimeframe 15m",
      "  node scripts/config.js set dailyProfitTargetUsdt 3",
      "  node scripts/config.js set dailyMaxLossPercent 8",
      "  node scripts/config.js preset binance",
      "  node scripts/config.js preset volatile",
      "  node scripts/config.js preset doge",
      "  node scripts/config.js autopreset DOGE/USDT:USDT",
      "",
      "Notes:",
      "  gridOrderSizeUsdt=0 -> full auto by available balance",
      "  gridOrdersPerSide=0 -> full auto by available balance",
    ].join("\n"),
  );
};

const safeParseJSON = (value, fallback = null) => {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withSqliteBusyRetry = async (fn, { attempts = 5, delayMs = 150 } = {}) => {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const message = String(error && error.message ? error.message : error);
      const isBusy = message.includes("SQLITE_BUSY") || message.includes("database is locked");
      if (!isBusy || i === attempts - 1) throw error;
      await sleep(delayMs);
    }
  }
  throw lastError;
};

const coerceBoolean = (raw) => {
  if (typeof raw === "boolean") return raw;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "y") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "n") return false;
  return null;
};

const parseValueForKey = (key, rawValue) => {
  if (!(key in DEFAULT_CONFIG) && key !== "activePosition" && key !== "activeGridState") {
    throw new Error(`Unknown config key: ${key}`);
  }

  if (key === "activePosition" || key === "activeGridState") {
    const trimmed = String(rawValue).trim();
    if (trimmed === "" || trimmed.toLowerCase() === "null") return null;
    const parsed = safeParseJSON(trimmed, undefined);
    if (parsed === undefined) throw new Error(`${key} must be valid JSON or 'null'`);
    return JSON.stringify(parsed);
  }

  if (BOOLEAN_CONFIG_KEYS.includes(key)) {
    const parsed = coerceBoolean(rawValue);
    if (parsed === null) throw new Error(`Invalid boolean for ${key}: ${rawValue}`);
    return parsed;
  }

  const defaultValue = DEFAULT_CONFIG[key];
  if (typeof defaultValue === "number") {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) throw new Error(`Invalid number for ${key}: ${rawValue}`);
    return parsed;
  }

  return String(rawValue);
};

const getPresetNames = () => Object.keys(GRID_PRESETS).sort();

const buildPresetPayload = (name) => {
  const preset = GRID_PRESETS[String(name || "").trim().toLowerCase()];
  if (!preset) {
    throw new Error(`Unknown preset: ${name}. Available presets: ${getPresetNames().join(", ")}`);
  }
  return { ...preset };
};

const resolveAutoPresetName = (pair) => {
  const normalizedPair = String(pair || "").trim().toUpperCase();
  if (!normalizedPair) return "binance";
  const matchedRule = AUTO_PRESET_RULES.find((rule) => rule.match.test(normalizedPair));
  return matchedRule ? matchedRule.preset : "binance";
};

const ensureConfigSchema = async () => {
  await withSqliteBusyRetry(() => sequelize.sync());
  const tableInfo = await withSqliteBusyRetry(() =>
    sequelize.query("PRAGMA table_info('Configs');", { type: sequelize.QueryTypes.SELECT }),
  );
  const columnNames = new Set(tableInfo.map((column) => String(column.name)));

  if (!columnNames.has("gridOrderSizeUsdt")) {
    await withSqliteBusyRetry(() =>
      sequelize.query("ALTER TABLE Configs ADD COLUMN gridOrderSizeUsdt FLOAT DEFAULT 1.5;"),
    );
    if (columnNames.has("usdtPerTrade")) {
      await withSqliteBusyRetry(() =>
        sequelize.query("UPDATE Configs SET gridOrderSizeUsdt = COALESCE(usdtPerTrade, 1.5) WHERE gridOrderSizeUsdt IS NULL OR gridOrderSizeUsdt = '';"),
      );
    }
  }

  if (!columnNames.has("gridTargetProfitUsdt")) {
    await withSqliteBusyRetry(() =>
      sequelize.query("ALTER TABLE Configs ADD COLUMN gridTargetProfitUsdt FLOAT DEFAULT 0.5;"),
    );
    if (columnNames.has("targetProfitUSDT")) {
      await withSqliteBusyRetry(() =>
        sequelize.query("UPDATE Configs SET gridTargetProfitUsdt = COALESCE(targetProfitUSDT, 0.5) WHERE gridTargetProfitUsdt IS NULL OR gridTargetProfitUsdt = '';"),
      );
    }
  }

  if (!columnNames.has("gridStopLossPercent")) {
    await withSqliteBusyRetry(() =>
      sequelize.query("ALTER TABLE Configs ADD COLUMN gridStopLossPercent FLOAT DEFAULT 5;"),
    );
    if (columnNames.has("stopLossPercent")) {
      await withSqliteBusyRetry(() =>
        sequelize.query("UPDATE Configs SET gridStopLossPercent = COALESCE(stopLossPercent, 5) WHERE gridStopLossPercent IS NULL OR gridStopLossPercent = '';"),
      );
    }
  }

  if (!columnNames.has("gridTimeframe")) {
    await withSqliteBusyRetry(() =>
      sequelize.query("ALTER TABLE Configs ADD COLUMN gridTimeframe VARCHAR(255) DEFAULT '5m';"),
    );
    if (columnNames.has("breakoutTimeframe")) {
      await withSqliteBusyRetry(() =>
        sequelize.query("UPDATE Configs SET gridTimeframe = COALESCE(breakoutTimeframe, '5m') WHERE gridTimeframe IS NULL OR gridTimeframe = '';"),
      );
    }
  }

  if (!columnNames.has("activeGridState")) {
    await withSqliteBusyRetry(() =>
      sequelize.query("ALTER TABLE Configs ADD COLUMN activeGridState TEXT DEFAULT NULL;"),
    );
  }

  if (!columnNames.has("dailyProfitTargetUsdt")) {
    await withSqliteBusyRetry(() =>
      sequelize.query("ALTER TABLE Configs ADD COLUMN dailyProfitTargetUsdt FLOAT DEFAULT 1;"),
    );
    if (columnNames.has("targetDailyProfit")) {
      await withSqliteBusyRetry(() =>
        sequelize.query("UPDATE Configs SET dailyProfitTargetUsdt = COALESCE(targetDailyProfit, 1) WHERE dailyProfitTargetUsdt IS NULL OR dailyProfitTargetUsdt = '';"),
      );
    }
  }

  if (!columnNames.has("dailyMaxLossPercent")) {
    await withSqliteBusyRetry(() =>
      sequelize.query("ALTER TABLE Configs ADD COLUMN dailyMaxLossPercent FLOAT DEFAULT 10;"),
    );
    if (columnNames.has("maxDailyLossPercent")) {
      await withSqliteBusyRetry(() =>
        sequelize.query("UPDATE Configs SET dailyMaxLossPercent = COALESCE(maxDailyLossPercent, 10) WHERE dailyMaxLossPercent IS NULL OR dailyMaxLossPercent = '';"),
      );
    }
  }

  for (const obsoleteColumn of OBSOLETE_CONFIG_COLUMNS) {
    if (!columnNames.has(obsoleteColumn)) continue;
    try {
      await withSqliteBusyRetry(() =>
        sequelize.query(`ALTER TABLE Configs DROP COLUMN ${obsoleteColumn};`),
      );
    } catch (error) {
      console.warn(`[WARN] Could not drop obsolete config column ${obsoleteColumn}: ${error.message}`);
    }
  }
};

const ensureConfigRow = async () => {
  await ensureConfigSchema();
  let row = await withSqliteBusyRetry(() => Config.findOne());
  if (row) return row;
  row = await withSqliteBusyRetry(() =>
    Config.create({ ...DEFAULT_CONFIG, lastDailyReset: Date.now(), lastUpdated: Date.now() }),
  );
  return row;
};

const hydrateForOutput = (row) => {
  const json = row.toJSON();

  if (json.gridOrderSizeUsdt === undefined && json.usdtPerTrade !== undefined) {
    json.gridOrderSizeUsdt = json.usdtPerTrade;
  }
  delete json.usdtPerTrade;

  if (json.gridTargetProfitUsdt === undefined && json.targetProfitUSDT !== undefined) {
    json.gridTargetProfitUsdt = json.targetProfitUSDT;
  }
  delete json.targetProfitUSDT;

  if (json.gridStopLossPercent === undefined && json.stopLossPercent !== undefined) {
    json.gridStopLossPercent = json.stopLossPercent;
  }
  delete json.stopLossPercent;

  if (json.gridTimeframe === undefined && typeof json.breakoutTimeframe === "string") {
    json.gridTimeframe = json.breakoutTimeframe;
  }
  delete json.breakoutTimeframe;

  if (json.dailyProfitTargetUsdt === undefined && json.targetDailyProfit !== undefined) {
    json.dailyProfitTargetUsdt = json.targetDailyProfit;
  }
  delete json.targetDailyProfit;

  if (json.dailyMaxLossPercent === undefined && json.maxDailyLossPercent !== undefined) {
    json.dailyMaxLossPercent = json.maxDailyLossPercent;
  }
  delete json.maxDailyLossPercent;

  json.activePosition = safeParseJSON(json.activePosition, null);
  json.activeGridState = safeParseJSON(json.activeGridState, null);
  return json;
};

const main = async () => {
  const [, , command, ...args] = process.argv;
  const cmd = (command || "").trim().toLowerCase();

  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    printUsage();
    return;
  }

  if (cmd === "defaults") {
    console.log(JSON.stringify(DEFAULT_CONFIG, null, 2));
    return;
  }

  const row = await ensureConfigRow();

  if (cmd === "show") {
    console.log(JSON.stringify(hydrateForOutput(row), null, 2));
    return;
  }

  if (cmd === "preset") {
    const name = args[0];
    if (!name) throw new Error(`Missing <name>. Available presets: ${getPresetNames().join(", ")}`);
    const presetPayload = buildPresetPayload(name);
    await withSqliteBusyRetry(() => row.update({ ...presetPayload, lastUpdated: Date.now() }));
    console.log(`[OK] Applied preset ${String(name).trim().toLowerCase()}`);
    await row.reload();
    console.log(JSON.stringify(hydrateForOutput(row), null, 2));
    return;
  }

  if (cmd === "autopreset") {
    const inputPair = args.join(" ").trim();
    const targetPair = inputPair || hydrateForOutput(row).pair || DEFAULT_CONFIG.pair;
    const presetName = resolveAutoPresetName(targetPair);
    const presetPayload = { ...buildPresetPayload(presetName), pair: targetPair, activeGridState: null };
    await withSqliteBusyRetry(() => row.update({ ...presetPayload, lastUpdated: Date.now() }));
    console.log(`[OK] Applied autopreset ${presetName} for ${targetPair}`);
    await row.reload();
    console.log(JSON.stringify(hydrateForOutput(row), null, 2));
    return;
  }

  if (cmd === "get") {
    const key = args[0];
    if (!key) throw new Error("Missing <key>");
    const json = hydrateForOutput(row);
    if (!(key in json)) throw new Error(`Unknown config key: ${key}`);
    const value = json[key];
    if (typeof value === "string") console.log(value);
    else console.log(JSON.stringify(value));
    return;
  }

  if (cmd === "set") {
    const key = args[0];
    const rawValue = args.slice(1).join(" ");
    if (!key) throw new Error("Missing <key>");
    if (!rawValue) throw new Error("Missing <value>");
    const nextValue = parseValueForKey(key, rawValue);
    await withSqliteBusyRetry(() => row.update({ [key]: nextValue, lastUpdated: Date.now() }));
    console.log(`[OK] Updated ${key}`);
    return;
  }

  if (cmd === "reset") {
    const key = args[0];
    if (!key) throw new Error("Missing <key>");
    if (!(key in DEFAULT_CONFIG) && key !== "activePosition" && key !== "activeGridState") throw new Error(`Unknown config key: ${key}`);
    const nextValue = key === "activePosition" || key === "activeGridState" ? null : DEFAULT_CONFIG[key];
    await withSqliteBusyRetry(() => row.update({ [key]: nextValue, lastUpdated: Date.now() }));
    console.log(`[OK] Reset ${key}`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
};

main()
  .catch((error) => {
    console.error(`[ERROR] ${error.message}`);
    printUsage();
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await sequelize.close();
    } catch {
      // ignore
    }
  });


