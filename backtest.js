const DEFAULTS = {
  symbol: "DOGEUSDT",
  interval: "5m",
  days: 30,
  feeRate: 0.0004, // taker fee estimate per side (0.04%)
  slippageRate: 0.0002, // 0.02% per side
  config: {
    usdtPerTrade: 10,
    leverage: 10,
    targetProfitUSDT: 0.5,
    targetDailyProfit: 1.0,
    maxDailyLossPercent: 10,
    maxTradesPerDay: 3,
    coolingPeriod: 3000,
    stopLossPercent: 5,
    breakoutPeriod: 20,
    minBreakoutStrength: 0.003,
    volumePeriod: 20,
    minVolumeRatio: 1.4,
    trendEnabled: true,
    trendPeriod: 120,
  },
};

const args = process.argv.slice(2);
const getArg = (key, fallback) => {
  const idx = args.indexOf(`--${key}`);
  if (idx === -1 || idx + 1 >= args.length) return fallback;
  return args[idx + 1];
};

const options = {
  symbol: getArg("symbol", DEFAULTS.symbol).toUpperCase(),
  interval: getArg("interval", DEFAULTS.interval),
  days: Number(getArg("days", DEFAULTS.days)),
};

const toNum = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const formatDateKey = (ms) => new Date(ms).toISOString().slice(0, 10);

const fetchKlines = async ({ symbol, interval, startTime, endTime, limit = 1500 }) => {
  const url = new URL("https://fapi.binance.com/fapi/v1/klines");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));
  if (startTime) url.searchParams.set("startTime", String(startTime));
  if (endTime) url.searchParams.set("endTime", String(endTime));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
};

const fetchAllKlines = async ({ symbol, interval, days }) => {
  const now = Date.now();
  const start = now - days * 24 * 60 * 60 * 1000;
  const all = [];
  let cursor = start;

  while (true) {
    const chunk = await fetchKlines({ symbol, interval, startTime: cursor, limit: 1500 });
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    all.push(...chunk);
    const lastOpen = toNum(chunk[chunk.length - 1][0], 0);
    if (lastOpen <= 0 || lastOpen >= now || chunk.length < 1500) break;
    cursor = lastOpen + 5 * 60 * 1000;
    if (all.length > 20000) break;
  }

  const unique = new Map();
  for (const k of all) unique.set(String(k[0]), k);
  return [...unique.values()]
    .filter((k) => toNum(k[0], 0) >= start && toNum(k[0], 0) <= now)
    .sort((a, b) => toNum(a[0], 0) - toNum(b[0], 0));
};

const backtest = (candles, cfg, feeRate, slippageRate) => {
  const highs = candles.map((c) => toNum(c[2]));
  const lows = candles.map((c) => toNum(c[3]));
  const closes = candles.map((c) => toNum(c[4]));
  const volumes = candles.map((c) => toNum(c[5]));
  const times = candles.map((c) => toNum(c[0]));

  const calcEMA = (values, period) => {
    const out = Array(values.length).fill(null);
    if (!Array.isArray(values) || values.length < period || period < 2) return out;
    const alpha = 2 / (period + 1);
    let seed = 0;
    for (let i = 0; i < period; i++) seed += values[i];
    out[period - 1] = seed / period;
    for (let i = period; i < values.length; i++) {
      out[i] = (values[i] - out[i - 1]) * alpha + out[i - 1];
    }
    return out;
  };

  const calcRSI = (values, period) => {
    const out = Array(values.length).fill(null);
    if (!Array.isArray(values) || values.length <= period || period < 2) return out;
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = values[i] - values[i - 1];
      if (d >= 0) gain += d;
      else loss += -d;
    }
    let avgGain = gain / period;
    let avgLoss = loss / period;
    out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    for (let i = period + 1; i < values.length; i++) {
      const d = values[i] - values[i - 1];
      const g = d > 0 ? d : 0;
      const l = d < 0 ? -d : 0;
      avgGain = ((avgGain * (period - 1)) + g) / period;
      avgLoss = ((avgLoss * (period - 1)) + l) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return out;
  };

  const rsiAligned = calcRSI(closes, 7);
  const emaAligned = calcEMA(closes, cfg.trendPeriod);

  const start = Math.max(cfg.breakoutPeriod, cfg.volumePeriod, cfg.trendPeriod, 10);
  let position = null;
  let equity = 0;
  let peakEquity = 0;
  let maxDrawdown = 0;

  let dailyTrades = 0;
  let dailyPnL = 0;
  let currentDay = "";
  let lastTradeTs = 0;

  const trades = [];
  const daily = new Map();

  const addDaily = (ts, pnl) => {
    const key = formatDateKey(ts);
    daily.set(key, toNum(daily.get(key), 0) + pnl);
  };

  for (let i = start; i < candles.length; i++) {
    const ts = times[i];
    const day = formatDateKey(ts);
    if (day !== currentDay) {
      currentDay = day;
      dailyTrades = 0;
      dailyPnL = 0;
    }

    const price = closes[i];
    const high = highs[i];
    const low = lows[i];

    if (position) {
      let exitPrice = null;
      let reason = "";
      if (position.side === "buy") {
        const hitSL = low <= position.stopLossPrice;
        const hitTP = high >= position.targetPrice;
        if (hitSL && hitTP) {
          exitPrice = position.stopLossPrice; // conservative
          reason = "STOP_LOSS_AND_TARGET_SAME_CANDLE";
        } else if (hitSL) {
          exitPrice = position.stopLossPrice;
          reason = "STOP_LOSS";
        } else if (hitTP) {
          exitPrice = position.targetPrice;
          reason = "PROFIT_TARGET";
        }
      } else {
        const hitSL = high >= position.stopLossPrice;
        const hitTP = low <= position.targetPrice;
        if (hitSL && hitTP) {
          exitPrice = position.stopLossPrice; // conservative
          reason = "STOP_LOSS_AND_TARGET_SAME_CANDLE";
        } else if (hitSL) {
          exitPrice = position.stopLossPrice;
          reason = "STOP_LOSS";
        } else if (hitTP) {
          exitPrice = position.targetPrice;
          reason = "PROFIT_TARGET";
        }
      }

      if (exitPrice !== null) {
        const slipExit = position.side === "buy" ? exitPrice * (1 - slippageRate) : exitPrice * (1 + slippageRate);
        const grossPnl =
          position.side === "buy"
            ? (slipExit - position.entryPrice) * position.quantity
            : (position.entryPrice - slipExit) * position.quantity;
        const fee = (position.entryPrice * position.quantity + slipExit * position.quantity) * feeRate;
        const netPnl = grossPnl - fee;

        equity += netPnl;
        peakEquity = Math.max(peakEquity, equity);
        maxDrawdown = Math.min(maxDrawdown, equity - peakEquity);
        dailyPnL += netPnl;
        addDaily(ts, netPnl);
        dailyTrades++;
        lastTradeTs = ts;

        trades.push({
          side: position.side,
          entryTs: position.entryTs,
          exitTs: ts,
          entry: position.entryPrice,
          exit: slipExit,
          qty: position.quantity,
          pnl: netPnl,
          reason,
        });
        position = null;
      }
      continue;
    }

    const equityAnchor = 100;
    const maxDailyLoss = equityAnchor * (cfg.maxDailyLossPercent / 100);
    if (dailyPnL >= cfg.targetDailyProfit) continue;
    if (dailyPnL <= -maxDailyLoss) continue;
    if (dailyTrades >= cfg.maxTradesPerDay) continue;
    if (lastTradeTs > 0 && ts - lastTradeTs < cfg.coolingPeriod) continue;

    const prevHighs = highs.slice(i - cfg.breakoutPeriod, i);
    const prevLows = lows.slice(i - cfg.breakoutPeriod, i);
    const resistance = Math.max(...prevHighs);
    const support = Math.min(...prevLows);
    const range = resistance - support;
    if (!Number.isFinite(range) || range <= 0) continue;

    const breakoutThreshold = range * cfg.minBreakoutStrength;
    const bullishBreakout = high > resistance + breakoutThreshold;
    const bearishBreakout = low < support - breakoutThreshold;

    const avgVolume = volumes.slice(i - cfg.volumePeriod, i).reduce((a, b) => a + b, 0) / cfg.volumePeriod;
    const safeAvgVol = avgVolume > 0 ? avgVolume : Number.EPSILON;
    const volumeOk = volumes[i] > safeAvgVol * cfg.minVolumeRatio;

    const currentRSI = rsiAligned[i] ?? 50;
    let canLong = bullishBreakout && currentRSI > 50 && currentRSI < 75 && volumeOk;
    let canShort = bearishBreakout && currentRSI > 25 && currentRSI < 50 && volumeOk;

    if (cfg.trendEnabled && Number.isFinite(emaAligned[i])) {
      if (price <= emaAligned[i]) canLong = false;
      if (price >= emaAligned[i]) canShort = false;
    }

    if (!canLong && !canShort) continue;
    const side = canLong ? "buy" : "sell";
    const entry = side === "buy" ? price * (1 + slippageRate) : price * (1 - slippageRate);
    const quantity = (cfg.usdtPerTrade * cfg.leverage) / entry;
    if (!Number.isFinite(quantity) || quantity <= 0) continue;

    const tp = side === "buy" ? entry + cfg.targetProfitUSDT / quantity : entry - cfg.targetProfitUSDT / quantity;
    const slUSDT = -cfg.usdtPerTrade * (cfg.stopLossPercent / 100);
    const sl = side === "buy" ? entry + slUSDT / quantity : entry - slUSDT / quantity;

    position = {
      side,
      entryPrice: entry,
      entryTs: ts,
      quantity,
      targetPrice: tp,
      stopLossPrice: sl,
    };
  }

  const total = trades.length;
  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl < 0).length;
  const net = trades.reduce((a, t) => a + t.pnl, 0);
  const avg = total ? net / total : 0;

  return {
    candles: candles.length,
    trades: total,
    wins,
    losses,
    winRate: total ? (wins / total) * 100 : 0,
    netPnlUSDT: net,
    avgPnlUSDT: avg,
    maxDrawdownUSDT: maxDrawdown,
    daily: [...daily.entries()].map(([day, pnl]) => ({ day, pnl })),
    sampleTrades: trades.slice(0, 5),
  };
};

(async () => {
  try {
    console.log(`[BACKTEST] Fetching ${options.days}d ${options.interval} data for ${options.symbol}...`);
    const candles = await fetchAllKlines(options);
    if (!candles.length) throw new Error("No candles fetched");

    const result = backtest(candles, DEFAULTS.config, DEFAULTS.feeRate, DEFAULTS.slippageRate);
    const profitableDays = result.daily.filter((d) => d.pnl > 0).length;
    const losingDays = result.daily.filter((d) => d.pnl < 0).length;

    console.log("\n=== Backtest Summary ===");
    console.log(`Candles        : ${result.candles}`);
    console.log(`Trades         : ${result.trades}`);
    console.log(`Win rate       : ${result.winRate.toFixed(2)}%`);
    console.log(`Net PnL        : ${result.netPnlUSDT.toFixed(4)} USDT`);
    console.log(`Avg / trade    : ${result.avgPnlUSDT.toFixed(4)} USDT`);
    console.log(`Max drawdown   : ${result.maxDrawdownUSDT.toFixed(4)} USDT`);
    console.log(`Days + / -     : ${profitableDays} / ${losingDays}`);
    console.log("\nSample trades:");
    console.table(
      result.sampleTrades.map((t) => ({
        side: t.side,
        entry: t.entry.toFixed(6),
        exit: t.exit.toFixed(6),
        pnl: t.pnl.toFixed(4),
        reason: t.reason,
        entryTs: new Date(t.entryTs).toISOString(),
        exitTs: new Date(t.exitTs).toISOString(),
      }))
    );
  } catch (error) {
    console.error("[BACKTEST_ERROR]", error.message);
    process.exit(1);
  }
})();
