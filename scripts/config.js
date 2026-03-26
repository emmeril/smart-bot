#!/usr/bin/env node
"use strict";

require("dotenv").config();

const path = require("path");
const { Sequelize, DataTypes } = require("sequelize");

const DB_PATH = path.join(__dirname, "..", "database.sqlite");

const BOOLEAN_CONFIG_KEYS = ["useTrendFilter", "trailingEnabled", "allowLong", "allowShort"];

const DEFAULT_CONFIG = {
  strategy: "sma_crossover",
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
    usdtPerTrade: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.usdtPerTrade },
    leverage: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.leverage },
    targetProfitUSDT: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.targetProfitUSDT },
    targetDailyProfit: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.targetDailyProfit },
    maxDailyLossPercent: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.maxDailyLossPercent },
    maxTradesPerDay: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.maxTradesPerDay },
    coolingPeriod: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.coolingPeriod },
    activePosition: { type: DataTypes.TEXT, defaultValue: null },
    dailyPnL: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.dailyPnL },
    dailyTrades: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.dailyTrades },
    marginMode: { type: DataTypes.STRING, defaultValue: DEFAULT_CONFIG.marginMode },
    monitoringInterval: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.monitoringInterval },
    stopLossPercent: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.stopLossPercent },
    fastEMAPeriod: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.fastEMAPeriod },
    slowEMAPeriod: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.slowEMAPeriod },
    trendEMAPeriod: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.trendEMAPeriod },
    rsiPeriod: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.rsiPeriod },
    rsiOverbought: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.rsiOverbought },
    rsiOversold: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.rsiOversold },
    useTrendFilter: { type: DataTypes.BOOLEAN, defaultValue: DEFAULT_CONFIG.useTrendFilter },
    breakoutTimeframe: { type: DataTypes.STRING, defaultValue: DEFAULT_CONFIG.breakoutTimeframe },
    sessionStartUTC: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.sessionStartUTC },
    sessionEndUTC: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.sessionEndUTC },
    volumePeriod: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.volumePeriod },
    minVolumeRatio: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.minVolumeRatio },
    maxPriceDeviationPercent: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.maxPriceDeviationPercent },
    atrPeriod: { type: DataTypes.INTEGER, defaultValue: DEFAULT_CONFIG.atrPeriod },
    atrStopMult: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.atrStopMult },
    atrTargetMult: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.atrTargetMult },
    shortAtrStopMult: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.shortAtrStopMult },
    shortAtrTargetMult: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.shortAtrTargetMult },
    trailingEnabled: { type: DataTypes.BOOLEAN, defaultValue: DEFAULT_CONFIG.trailingEnabled },
    trailingActivateATR: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.trailingActivateATR },
    trailingOffsetATR: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.trailingOffsetATR },
    shortTrailingActivateATR: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.shortTrailingActivateATR },
    shortTrailingOffsetATR: { type: DataTypes.FLOAT, defaultValue: DEFAULT_CONFIG.shortTrailingOffsetATR },
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
      "  node scripts/config.js defaults",
      "",
      "Examples:",
      "  node scripts/config.js set leverage 20",
      "  node scripts/config.js set pair BTC/USDT:USDT",
      "  node scripts/config.js set allowShort false",
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
  if (!(key in DEFAULT_CONFIG) && key !== "activePosition") {
    throw new Error(`Unknown config key: ${key}`);
  }

  if (key === "activePosition") {
    const trimmed = String(rawValue).trim();
    if (trimmed === "" || trimmed.toLowerCase() === "null") return null;
    const parsed = safeParseJSON(trimmed, undefined);
    if (parsed === undefined) throw new Error("activePosition must be valid JSON or 'null'");
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

const ensureConfigRow = async () => {
  await withSqliteBusyRetry(() => sequelize.sync());
  let row = await withSqliteBusyRetry(() => Config.findOne());
  if (row) return row;
  row = await withSqliteBusyRetry(() =>
    Config.create({ ...DEFAULT_CONFIG, lastDailyReset: Date.now(), lastUpdated: Date.now() }),
  );
  return row;
};

const hydrateForOutput = (row) => {
  const json = row.toJSON();
  json.activePosition = safeParseJSON(json.activePosition, null);
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
    if (!(key in DEFAULT_CONFIG) && key !== "activePosition") throw new Error(`Unknown config key: ${key}`);
    const nextValue = key === "activePosition" ? null : DEFAULT_CONFIG[key];
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
