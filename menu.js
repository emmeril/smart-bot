const fs = require("fs");
const readline = require("readline");

const dbPath = "./db.json";

const getDefaultConfig = () => ({
  strategy: "hybrid",
  pair: "DOGE/USDT:USDT",
  usdtPerTrade: 0.2,
  leverage: 50,
  targetProfitUSDT: 0.01,
  targetDailyProfit: 1.0,
  maxDailyLossPercent: 40,
  maxTradesPerDay: 3,
  coolingPeriod: 2000,
  activePosition: null,
  dailyPnL: 0,
  dailyTrades: 0,
  marginMode: "isolated",
  monitoringInterval: 500,
  stopLossPercent: 50,
  breakoutTimeframe: "15m",
  sessionStartUTC: 0,
  sessionEndUTC: 23,
  trendTimeframe: "15m",
  trendPeriod: 80,
  pullbackEmaPeriod: 5,
  pullbackLookback: 2,
  pullbackMaxDistancePct: 0.5,
  rsiLongMin: 52,
  rsiLongMax: 72,
  minVolumeRatio: 1.1,
  shortBreakoutPeriod: 20,
  shortTrendPeriod: 120,
  shortMinRangePercent: 0.8,
  shortMinVolumeRatio: 1.4,
  atrPeriod: 14,
  atrStopMult: 0.8,
  atrTargetMult: 1.6,
  trailingActivateATR: 1.2,
  trailingOffsetATR: 0.6,
  shortAtrStopMult: 1.4,
  shortAtrTargetMult: 1.6,
  shortTrailingActivateATR: 1.0,
  shortTrailingOffsetATR: 0.8,
  allowLong: true,
  allowShort: true
});

const loadDB = () => {
  try {
    if (fs.existsSync(dbPath)) {
      return { ...getDefaultConfig(), ...JSON.parse(fs.readFileSync(dbPath, "utf8")) };
    }
  } catch (error) {
    console.warn(`Failed to load ${dbPath}: ${error.message}`);
  }
  return getDefaultConfig();
};

const saveDB = (config) => {
  try {
    fs.writeFileSync(dbPath, JSON.stringify(config, null, 2));
    console.log(`Saved config to ${dbPath}`);
    return true;
  } catch (error) {
    console.error(`Failed to save config: ${error.message}`);
    return false;
  }
};

const validateNumber = (input, min, max, isInteger = false) => {
  const num = isInteger ? parseInt(input, 10) : parseFloat(input);
  if (Number.isNaN(num)) return { valid: false, message: "Invalid number" };
  if (min !== undefined && num < min) return { valid: false, message: `Must be at least ${min}` };
  if (max !== undefined && num > max) return { valid: false, message: `Must be at most ${max}` };
  return { valid: true, value: num };
};

const displayConfig = (config) => {
  console.clear();
  console.log("=".repeat(72));
  console.log("HYBRID DOGE BOT CONFIG");
  console.log("=".repeat(72));
  console.log(`Pair           : ${config.pair}`);
  console.log(`Mode           : ${config.strategy} | ${config.breakoutTimeframe}`);
  console.log(`Risk           : ${config.usdtPerTrade} USDT | ${config.leverage}x | max loss ${config.maxDailyLossPercent}%`);
  console.log(`Session UTC    : ${config.sessionStartUTC}-${config.sessionEndUTC}`);
  console.log(`Direction      : long=${config.allowLong} short=${config.allowShort}`);
  console.log(`Long Pullback  : EMA ${config.pullbackEmaPeriod} | lookback ${config.pullbackLookback} | dist ${config.pullbackMaxDistancePct}%`);
  console.log(`Long Filters   : RSI ${config.rsiLongMin}-${config.rsiLongMax} | vol ${config.minVolumeRatio}x | trend ${config.trendPeriod}`);
  console.log(`Short Breakout : breakout ${config.shortBreakoutPeriod} | range ${config.shortMinRangePercent}% | vol ${config.shortMinVolumeRatio}x | trend ${config.shortTrendPeriod}`);
  console.log(`ATR Long       : stop ${config.atrStopMult} | target ${config.atrTargetMult} | trail ${config.trailingActivateATR}/${config.trailingOffsetATR}`);
  console.log(`ATR Short      : stop ${config.shortAtrStopMult} | target ${config.shortAtrTargetMult} | trail ${config.shortTrailingActivateATR}/${config.shortTrailingOffsetATR}`);
  console.log(`Daily Status   : PnL ${(config.dailyPnL || 0).toFixed(2)} | trades ${config.dailyTrades || 0}`);
  console.log("=".repeat(72));
  if (config.activePosition) {
    console.log(`Active Position: ${config.activePosition.side} @ ${config.activePosition.entryPrice}`);
  } else {
    console.log("Active Position: none");
  }
  console.log("=".repeat(72));
};

const menuOptions = [
  "Exit",
  "Change Pair",
  "Change Strategy Mode",
  "Change Timeframe",
  "Change USDT per Trade",
  "Change Leverage",
  "Change Max Daily Loss %",
  "Change Cooling Period",
  "Change Monitoring Interval",
  "Edit Long Pullback",
  "Edit Long Filters",
  "Edit Short Breakout",
  "Edit ATR Long",
  "Edit ATR Short",
  "Edit Session UTC",
  "Toggle Long/Short",
  "Reset Daily PnL & Trades",
  "Force Close Position",
  "Reload Config",
  "View Log"
];

const updateConfig = (rl, config, option) => {
  switch (option) {
    case 1:
      rl.question(`Pair (${config.pair}): `, (input) => {
        const value = String(input || "").trim();
        if (value.includes("/")) {
          config.pair = value;
          saveDB(config);
        } else {
          console.log("Invalid pair format");
        }
        rl.prompt();
      });
      break;
    case 2:
      rl.question(`Strategy mode [hybrid/pullback/breakout] (${config.strategy}): `, (input) => {
        const value = String(input || "").trim().toLowerCase();
        if (["hybrid", "pullback", "breakout"].includes(value)) {
          config.strategy = value;
          saveDB(config);
        } else {
          console.log("Valid: hybrid, pullback, breakout");
        }
        rl.prompt();
      });
      break;
    case 3:
      rl.question(`Timeframe (${config.breakoutTimeframe}): `, (input) => {
        const value = String(input || "").trim();
        if (/^[1-9]\d*[mhdwM]$/.test(value)) {
          config.breakoutTimeframe = value;
          config.trendTimeframe = value;
          saveDB(config);
        } else {
          console.log("Invalid timeframe format");
        }
        rl.prompt();
      });
      break;
    case 4:
      rl.question(`USDT per trade (${config.usdtPerTrade}): `, (input) => {
        const result = validateNumber(input, 0.01, 1000);
        if (result.valid) {
          config.usdtPerTrade = result.value;
          saveDB(config);
        } else {
          console.log(result.message);
        }
        rl.prompt();
      });
      break;
    case 5:
      rl.question(`Leverage (${config.leverage}): `, (input) => {
        const result = validateNumber(input, 1, 125, true);
        if (result.valid) {
          config.leverage = result.value;
          saveDB(config);
        } else {
          console.log(result.message);
        }
        rl.prompt();
      });
      break;
    case 6:
      rl.question(`Max daily loss % (${config.maxDailyLossPercent}): `, (input) => {
        const result = validateNumber(input, 1, 100);
        if (result.valid) {
          config.maxDailyLossPercent = result.value;
          saveDB(config);
        } else {
          console.log(result.message);
        }
        rl.prompt();
      });
      break;
    case 7:
      rl.question(`Cooling period ms (${config.coolingPeriod}): `, (input) => {
        const result = validateNumber(input, 0, 600000, true);
        if (result.valid) {
          config.coolingPeriod = result.value;
          saveDB(config);
        } else {
          console.log(result.message);
        }
        rl.prompt();
      });
      break;
    case 8:
      rl.question(`Monitoring interval ms (${config.monitoringInterval}): `, (input) => {
        const result = validateNumber(input, 100, 10000, true);
        if (result.valid) {
          config.monitoringInterval = result.value;
          saveDB(config);
        } else {
          console.log(result.message);
        }
        rl.prompt();
      });
      break;
    case 9:
      rl.question(`Long pullback ema,lookback,maxDist (${config.pullbackEmaPeriod},${config.pullbackLookback},${config.pullbackMaxDistancePct}): `, (input) => {
        const [ema, lookback, dist] = String(input || "").split(",").map((v) => v.trim());
        const a = validateNumber(ema, 2, 100, true);
        const b = validateNumber(lookback, 1, 20, true);
        const c = validateNumber(dist, 0.05, 5);
        if (a.valid && b.valid && c.valid) {
          config.pullbackEmaPeriod = a.value;
          config.pullbackLookback = b.value;
          config.pullbackMaxDistancePct = c.value;
          saveDB(config);
        } else {
          console.log("Invalid format. Example: 5,2,0.5");
        }
        rl.prompt();
      });
      break;
    case 10:
      rl.question(`Long filters rsiMin,rsiMax,vol,trend (${config.rsiLongMin},${config.rsiLongMax},${config.minVolumeRatio},${config.trendPeriod}): `, (input) => {
        const [rsiMin, rsiMax, vol, trend] = String(input || "").split(",").map((v) => v.trim());
        const a = validateNumber(rsiMin, 1, 98);
        const b = validateNumber(rsiMax, 2, 99);
        const c = validateNumber(vol, 0.5, 5);
        const d = validateNumber(trend, 2, 300, true);
        if (a.valid && b.valid && b.value > a.value && c.valid && d.valid) {
          config.rsiLongMin = a.value;
          config.rsiLongMax = b.value;
          config.minVolumeRatio = c.value;
          config.trendPeriod = d.value;
          saveDB(config);
        } else {
          console.log("Invalid format. Example: 52,72,1.1,80");
        }
        rl.prompt();
      });
      break;
    case 11:
      rl.question(`Short breakout period,range,vol,trend (${config.shortBreakoutPeriod},${config.shortMinRangePercent},${config.shortMinVolumeRatio},${config.shortTrendPeriod}): `, (input) => {
        const [period, range, vol, trend] = String(input || "").split(",").map((v) => v.trim());
        const a = validateNumber(period, 2, 100, true);
        const b = validateNumber(range, 0, 10);
        const c = validateNumber(vol, 0.5, 5);
        const d = validateNumber(trend, 2, 300, true);
        if (a.valid && b.valid && c.valid && d.valid) {
          config.shortBreakoutPeriod = a.value;
          config.shortMinRangePercent = b.value;
          config.shortMinVolumeRatio = c.value;
          config.shortTrendPeriod = d.value;
          saveDB(config);
        } else {
          console.log("Invalid format. Example: 20,0.8,1.4,120");
        }
        rl.prompt();
      });
      break;
    case 12:
      rl.question(`ATR long stop,target,trailAct,trailOff (${config.atrStopMult},${config.atrTargetMult},${config.trailingActivateATR},${config.trailingOffsetATR}): `, (input) => {
        const [stop, target, act, off] = String(input || "").split(",").map((v) => v.trim());
        const a = validateNumber(stop, 0.2, 10);
        const b = validateNumber(target, 0.2, 10);
        const c = validateNumber(act, 0.2, 10);
        const d = validateNumber(off, 0.1, 10);
        if (a.valid && b.valid && c.valid && d.valid) {
          config.atrStopMult = a.value;
          config.atrTargetMult = b.value;
          config.trailingActivateATR = c.value;
          config.trailingOffsetATR = d.value;
          saveDB(config);
        } else {
          console.log("Invalid format. Example: 0.8,1.6,1.2,0.6");
        }
        rl.prompt();
      });
      break;
    case 13:
      rl.question(`ATR short stop,target,trailAct,trailOff (${config.shortAtrStopMult},${config.shortAtrTargetMult},${config.shortTrailingActivateATR},${config.shortTrailingOffsetATR}): `, (input) => {
        const [stop, target, act, off] = String(input || "").split(",").map((v) => v.trim());
        const a = validateNumber(stop, 0.2, 10);
        const b = validateNumber(target, 0.2, 10);
        const c = validateNumber(act, 0.2, 10);
        const d = validateNumber(off, 0.1, 10);
        if (a.valid && b.valid && c.valid && d.valid) {
          config.shortAtrStopMult = a.value;
          config.shortAtrTargetMult = b.value;
          config.shortTrailingActivateATR = c.value;
          config.shortTrailingOffsetATR = d.value;
          saveDB(config);
        } else {
          console.log("Invalid format. Example: 1.4,1.6,1.0,0.8");
        }
        rl.prompt();
      });
      break;
    case 14:
      rl.question(`Session UTC start,end (${config.sessionStartUTC},${config.sessionEndUTC}): `, (input) => {
        const [start, end] = String(input || "").split(",").map((v) => v.trim());
        const a = validateNumber(start, 0, 23, true);
        const b = validateNumber(end, 0, 23, true);
        if (a.valid && b.valid) {
          config.sessionStartUTC = a.value;
          config.sessionEndUTC = b.value;
          saveDB(config);
        } else {
          console.log("Invalid format. Example: 0,23");
        }
        rl.prompt();
      });
      break;
    case 15:
      rl.question(`Enable long,short (${config.allowLong},${config.allowShort}): `, (input) => {
        const [longVal, shortVal] = String(input || "").split(",").map((v) => v.trim().toLowerCase());
        if (["true", "false"].includes(longVal) && ["true", "false"].includes(shortVal)) {
          config.allowLong = longVal === "true";
          config.allowShort = shortVal === "true";
          saveDB(config);
        } else {
          console.log("Invalid format. Example: true,true");
        }
        rl.prompt();
      });
      break;
    case 16:
      rl.question("Reset daily PnL and trades? (yes/no): ", (input) => {
        if (String(input || "").trim().toLowerCase() === "yes") {
          config.dailyPnL = 0;
          config.dailyTrades = 0;
          saveDB(config);
        }
        rl.prompt();
      });
      break;
    case 17:
      if (config.activePosition) {
        rl.question("Force clear activePosition? (yes/no): ", (input) => {
          if (String(input || "").trim().toLowerCase() === "yes") {
            config.activePosition = null;
            saveDB(config);
          }
          rl.prompt();
        });
      } else {
        console.log("No active position");
        rl.prompt();
      }
      break;
    case 18:
      Object.assign(config, loadDB());
      console.log("Reloaded config from file");
      displayConfig(config);
      rl.prompt();
      break;
    case 19:
      try {
        const logContent = fs.readFileSync("./log.csv", "utf8");
        const lines = logContent.trim().split("\n").slice(-10);
        console.log("\nLast log lines:");
        lines.forEach((line) => console.log(line));
      } catch {
        console.log("No log file found");
      }
      rl.prompt();
      break;
    default:
      rl.prompt();
  }
};

const mainMenu = () => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\nEnter option number (0 to exit, h for help): "
  });

  let config = loadDB();
  const autoReload = setInterval(() => {
    const freshConfig = loadDB();
    Object.assign(config, freshConfig);
  }, 2000);

  displayConfig(config);
  console.log("\nMenu:");
  menuOptions.forEach((option, index) => console.log(`  ${index}. ${option}`));
  rl.prompt();

  rl.on("line", (line) => {
    const input = line.trim().toLowerCase();
    if (input === "0" || input === "exit" || input === "quit") {
      clearInterval(autoReload);
      rl.close();
      return;
    }
    if (input === "h" || input === "help") {
      displayConfig(config);
      console.log("\nMenu:");
      menuOptions.forEach((option, index) => console.log(`  ${index}. ${option}`));
      rl.prompt();
      return;
    }
    const option = parseInt(input, 10);
    if (Number.isNaN(option) || option < 0 || option >= menuOptions.length) {
      console.log(`Invalid option. Enter 0-${menuOptions.length - 1}`);
      rl.prompt();
      return;
    }
    if (option === 0) {
      clearInterval(autoReload);
      rl.close();
      return;
    }
    updateConfig(rl, config, option);
  });

  rl.on("close", () => {
    clearInterval(autoReload);
    console.log("\nMenu closed.");
    process.exit(0);
  });
};

if (require.main === module) {
  mainMenu();
}

module.exports = { loadDB, saveDB, getDefaultConfig };
