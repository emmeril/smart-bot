const DEFAULTS = {
  symbol: "DOGEUSDT",
  interval: "5m",
  days: 30,
  feeRate: 0.0004, // taker fee estimate per side (0.04%)
  slippageRate: 0.0002, // 0.02% per side
  config: {
    strategy: "hybrid",
    usdtPerTrade: 10,
    leverage: 10,
    targetProfitUSDT: 0.5,
    targetDailyProfit: 1.0,
    maxDailyLossPercent: 10,
    maxTradesPerDay: 3,
    coolingPeriod: 3000,
    stopLossPercent: 5,
    breakoutPeriod: 20,
    shortBreakoutPeriod: 20,
    minBreakoutStrength: 0.003,
    minRangePercent: 1.0,
    shortMinRangePercent: 0.8,
    sessionStartUTC: 7,
    sessionEndUTC: 22,
    volumePeriod: 20,
    minVolumeRatio: 1.4,
    shortMinVolumeRatio: 1.4,
    trendEnabled: true,
    trendPeriod: 120,
    shortTrendPeriod: 120,
    v2Enabled: true,
    breakoutUseCloseConfirm: true,
    atrPeriod: 14,
    atrStopMult: 1.2,
    atrTargetMult: 2.0,
    trailingEnabled: true,
    trailingActivateATR: 1.0,
    trailingOffsetATR: 0.8,
    regimeFilterEnabled: false,
    regimeAtrLookback: 288,
    regimeAtrPercentile: 60,
    allowLong: true,
    allowShort: true,
    pullbackEmaPeriod: 20,
    pullbackLookback: 5,
    pullbackMaxDistancePct: 0.6,
    rsiLongMin: 52,
    rsiLongMax: 68,
    rsiShortMin: 25,
    rsiShortMax: 50,
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
  mode: String(getArg("mode", "single")).toLowerCase(),
  strategy: String(getArg("strategy", DEFAULTS.config.strategy)).toLowerCase(),
};

const toNum = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const toNumList = (value, fallback) => {
  if (!value) return fallback;
  const list = String(value)
    .split(",")
    .map((v) => toNum(v.trim(), NaN))
    .filter((n) => Number.isFinite(n));
  return list.length ? list : fallback;
};

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

const quantileFromArray = (arr, p) => {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const pp = clamp(p, 0, 1);
  const idx = Math.floor((sorted.length - 1) * pp);
  return sorted[idx];
};

const buildRuntimeConfig = () => {
  const cfg = { ...DEFAULTS.config };
  cfg.strategy = options.strategy;
  const numKeys = [
    "usdtPerTrade",
    "leverage",
    "targetProfitUSDT",
    "targetDailyProfit",
    "maxDailyLossPercent",
    "maxTradesPerDay",
    "coolingPeriod",
    "stopLossPercent",
    "breakoutPeriod",
    "shortBreakoutPeriod",
    "minBreakoutStrength",
    "minRangePercent",
    "shortMinRangePercent",
    "sessionStartUTC",
    "sessionEndUTC",
    "volumePeriod",
    "minVolumeRatio",
    "shortMinVolumeRatio",
    "trendPeriod",
    "shortTrendPeriod",
    "atrPeriod",
    "atrStopMult",
    "atrTargetMult",
    "trailingActivateATR",
    "trailingOffsetATR",
    "regimeAtrLookback",
    "regimeAtrPercentile",
    "pullbackEmaPeriod",
    "pullbackLookback",
    "pullbackMaxDistancePct",
    "rsiLongMin",
    "rsiLongMax",
    "rsiShortMin",
    "rsiShortMax",
  ];
  for (const key of numKeys) {
    const raw = getArg(key, null);
    if (raw !== null) cfg[key] = toNum(raw, cfg[key]);
  }
  const trendEnabledRaw = getArg("trendEnabled", null);
  if (trendEnabledRaw !== null) {
    const p = String(trendEnabledRaw).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(p)) cfg.trendEnabled = true;
    if (["0", "false", "no", "off"].includes(p)) cfg.trendEnabled = false;
  }
  const boolKeys = ["v2Enabled", "breakoutUseCloseConfirm", "trailingEnabled", "regimeFilterEnabled", "allowLong", "allowShort"];
  for (const key of boolKeys) {
    const raw = getArg(key, null);
    if (raw === null) continue;
    const p = String(raw).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(p)) cfg[key] = true;
    if (["0", "false", "no", "off"].includes(p)) cfg[key] = false;
  }
  cfg.breakoutPeriod = Math.max(2, Math.trunc(cfg.breakoutPeriod));
  cfg.shortBreakoutPeriod = Math.max(2, Math.trunc(cfg.shortBreakoutPeriod));
  cfg.volumePeriod = Math.max(2, Math.trunc(cfg.volumePeriod));
  cfg.trendPeriod = Math.max(2, Math.trunc(cfg.trendPeriod));
  cfg.shortTrendPeriod = Math.max(2, Math.trunc(cfg.shortTrendPeriod));
  cfg.atrPeriod = Math.max(2, Math.trunc(cfg.atrPeriod));
  cfg.pullbackEmaPeriod = Math.max(2, Math.trunc(cfg.pullbackEmaPeriod));
  cfg.pullbackLookback = Math.max(1, Math.trunc(cfg.pullbackLookback));
  cfg.regimeAtrLookback = Math.max(20, Math.trunc(cfg.regimeAtrLookback));
  cfg.regimeAtrPercentile = clamp(toNum(cfg.regimeAtrPercentile, 60), 10, 95);
  cfg.maxTradesPerDay = Math.max(1, Math.trunc(cfg.maxTradesPerDay));
  cfg.sessionStartUTC = clamp(Math.trunc(cfg.sessionStartUTC), 0, 23);
  cfg.sessionEndUTC = clamp(Math.trunc(cfg.sessionEndUTC), 0, 23);
  cfg.minRangePercent = Math.max(0, cfg.minRangePercent);
  cfg.shortMinRangePercent = Math.max(0, cfg.shortMinRangePercent);
  cfg.pullbackMaxDistancePct = Math.max(0.05, cfg.pullbackMaxDistancePct);
  cfg.rsiLongMin = clamp(cfg.rsiLongMin, 1, 99);
  cfg.rsiLongMax = clamp(cfg.rsiLongMax, cfg.rsiLongMin + 1, 99);
  cfg.rsiShortMin = clamp(cfg.rsiShortMin, 1, 99);
  cfg.rsiShortMax = clamp(cfg.rsiShortMax, cfg.rsiShortMin + 1, 99);
  cfg.atrStopMult = Math.max(0.2, cfg.atrStopMult);
  cfg.atrTargetMult = Math.max(0.2, cfg.atrTargetMult);
  cfg.trailingActivateATR = Math.max(0.2, cfg.trailingActivateATR);
  cfg.trailingOffsetATR = Math.max(0.1, cfg.trailingOffsetATR);
  cfg.minVolumeRatio = Math.max(1, cfg.minVolumeRatio);
  cfg.shortMinVolumeRatio = Math.max(1, cfg.shortMinVolumeRatio);
  return cfg;
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
  const opens = candles.map((c) => toNum(c[1]));
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

  const calcATR = (h, l, c, period) => {
    const out = Array(c.length).fill(null);
    if (!Array.isArray(h) || !Array.isArray(l) || !Array.isArray(c) || c.length <= period) return out;
    const tr = Array(c.length).fill(0);
    for (let i = 1; i < c.length; i++) {
      const hl = h[i] - l[i];
      const hc = Math.abs(h[i] - c[i - 1]);
      const lc = Math.abs(l[i] - c[i - 1]);
      tr[i] = Math.max(hl, hc, lc);
    }
    let seed = 0;
    for (let i = 1; i <= period; i++) seed += tr[i];
    out[period] = seed / period;
    for (let i = period + 1; i < c.length; i++) {
      out[i] = ((out[i - 1] * (period - 1)) + tr[i]) / period;
    }
    return out;
  };

  const rsiAligned = calcRSI(closes, 7);
  const emaAligned = calcEMA(closes, cfg.trendPeriod);
  const shortEmaAligned = calcEMA(closes, cfg.shortTrendPeriod);
  const pullbackEmaAligned = calcEMA(closes, cfg.pullbackEmaPeriod);
  const atrAligned = calcATR(highs, lows, closes, cfg.atrPeriod);

  const start = Math.max(cfg.breakoutPeriod, cfg.volumePeriod, cfg.trendPeriod, cfg.atrPeriod, cfg.pullbackEmaPeriod, cfg.pullbackLookback + 2, 10);
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
    const open = opens[i];
    const high = highs[i];
    const low = lows[i];
    const atrNow = atrAligned[i];

    if (position) {
      if (cfg.v2Enabled && cfg.trailingEnabled && Number.isFinite(position.atrAtEntry) && position.atrAtEntry > 0) {
        position.highestSinceEntry = Math.max(position.highestSinceEntry ?? position.entryPrice, high);
        position.lowestSinceEntry = Math.min(position.lowestSinceEntry ?? position.entryPrice, low);
        const trailActivationMove = cfg.trailingActivateATR * position.atrAtEntry;
        const trailOffsetMove = cfg.trailingOffsetATR * position.atrAtEntry;
        if (position.side === "buy") {
          if ((position.highestSinceEntry - position.entryPrice) >= trailActivationMove) {
            const trailStop = position.highestSinceEntry - trailOffsetMove;
            if (trailStop > position.stopLossPrice) position.stopLossPrice = trailStop;
          }
        } else {
          if ((position.entryPrice - position.lowestSinceEntry) >= trailActivationMove) {
            const trailStop = position.lowestSinceEntry + trailOffsetMove;
            if (trailStop < position.stopLossPrice) position.stopLossPrice = trailStop;
          }
        }
      }

      let exitPrice = null;
      let reason = "";
      if (position.side === "buy") {
        const hitSL = low <= position.stopLossPrice;
        const hitTP = high >= position.targetPrice;
        if (hitSL && hitTP) {
          exitPrice = position.stopLossPrice; // conservative
          reason = cfg.v2Enabled && cfg.trailingEnabled ? "TRAIL_OR_SL_AND_TARGET_SAME_CANDLE" : "STOP_LOSS_AND_TARGET_SAME_CANDLE";
        } else if (hitSL) {
          exitPrice = position.stopLossPrice;
          reason = cfg.v2Enabled && cfg.trailingEnabled ? "STOP_OR_TRAIL" : "STOP_LOSS";
        } else if (hitTP) {
          exitPrice = position.targetPrice;
          reason = "PROFIT_TARGET";
        }
      } else {
        const hitSL = high >= position.stopLossPrice;
        const hitTP = low <= position.targetPrice;
        if (hitSL && hitTP) {
          exitPrice = position.stopLossPrice; // conservative
          reason = cfg.v2Enabled && cfg.trailingEnabled ? "TRAIL_OR_SL_AND_TARGET_SAME_CANDLE" : "STOP_LOSS_AND_TARGET_SAME_CANDLE";
        } else if (hitSL) {
          exitPrice = position.stopLossPrice;
          reason = cfg.v2Enabled && cfg.trailingEnabled ? "STOP_OR_TRAIL" : "STOP_LOSS";
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

    const hourUTC = new Date(ts).getUTCHours();
    const sessionOk =
      cfg.sessionStartUTC <= cfg.sessionEndUTC
        ? hourUTC >= cfg.sessionStartUTC && hourUTC <= cfg.sessionEndUTC
        : hourUTC >= cfg.sessionStartUTC || hourUTC <= cfg.sessionEndUTC;

    let regimeOk = true;
    if (cfg.regimeFilterEnabled) {
      const lb = cfg.regimeAtrLookback;
      if (i > lb && Number.isFinite(atrNow) && atrNow > 0) {
        const atrWindow = atrAligned
          .slice(i - lb, i)
          .filter((v) => Number.isFinite(v) && v > 0);
        const atrThreshold = quantileFromArray(atrWindow, cfg.regimeAtrPercentile / 100);
        regimeOk = Number.isFinite(atrThreshold) ? atrNow >= atrThreshold : false;
      } else {
        regimeOk = false;
      }
    }

    const avgVolume = volumes.slice(i - cfg.volumePeriod, i).reduce((a, b) => a + b, 0) / cfg.volumePeriod;
    const safeAvgVol = avgVolume > 0 ? avgVolume : Number.EPSILON;
    const volumeRatio = volumes[i] / safeAvgVol;
    const volumeOkLong = volumeRatio >= cfg.minVolumeRatio;
    const volumeOkShort = volumeRatio >= cfg.shortMinVolumeRatio;

    const currentRSI = rsiAligned[i] ?? 50;
    const prevRSI = rsiAligned[i - 1] ?? currentRSI;
    let canLong = false;
    let canShort = false;
    if (cfg.strategy === "pullback" || cfg.strategy === "hybrid") {
      const trendEma = emaAligned[i];
      const pullbackEma = pullbackEmaAligned[i];
      const prevPullbackEma = pullbackEmaAligned[i - 1];
      if (!Number.isFinite(trendEma) || !Number.isFinite(pullbackEma) || !Number.isFinite(prevPullbackEma)) continue;
      const recentLow = Math.min(...lows.slice(i - cfg.pullbackLookback, i + 1));
      const touchDistancePct = Math.abs((recentLow - pullbackEma) / pullbackEma) * 100;
      const touchedPullbackZone = recentLow <= pullbackEma && touchDistancePct <= cfg.pullbackMaxDistancePct;
      const reclaim = closes[i - 1] <= prevPullbackEma && price > pullbackEma;
      const trendOk = price > trendEma && pullbackEma > trendEma;
      const momentumOk = price > open && price > closes[i - 1] && currentRSI > prevRSI;
      canLong =
        trendOk &&
        touchedPullbackZone &&
        reclaim &&
        volumeOkLong &&
        sessionOk &&
        regimeOk &&
        currentRSI >= cfg.rsiLongMin &&
        currentRSI <= cfg.rsiLongMax &&
        momentumOk;

      if (cfg.strategy === "hybrid") {
        const shortTrendEma = shortEmaAligned[i];
        const shortTrendOk = Number.isFinite(shortTrendEma) ? price < shortTrendEma : true;
        const shortPrevHighs = highs.slice(i - cfg.shortBreakoutPeriod, i);
        const shortPrevLows = lows.slice(i - cfg.shortBreakoutPeriod, i);
        const shortResistance = Math.max(...shortPrevHighs);
        const shortSupport = Math.min(...shortPrevLows);
        const shortRange = shortResistance - shortSupport;
        if (Number.isFinite(shortRange) && shortRange > 0) {
          const shortBreakoutThreshold = shortRange * cfg.minBreakoutStrength;
          const bearishBreakout = cfg.v2Enabled && cfg.breakoutUseCloseConfirm
            ? price < shortSupport - shortBreakoutThreshold
            : low < shortSupport - shortBreakoutThreshold;
          const shortRangePercent = price > 0 ? (shortRange / price) * 100 : 0;
          const shortRangeOk = shortRangePercent >= cfg.shortMinRangePercent;
          const shortMomentumOk = !cfg.v2Enabled || price < open;
          canShort =
            bearishBreakout &&
            volumeOkShort &&
            shortRangeOk &&
            sessionOk &&
            regimeOk &&
            shortTrendOk &&
            currentRSI >= cfg.rsiShortMin &&
            currentRSI <= cfg.rsiShortMax &&
            shortMomentumOk;
        }
      } else {
        canShort = false;
      }
    } else {
      const prevHighs = highs.slice(i - cfg.breakoutPeriod, i);
      const prevLows = lows.slice(i - cfg.breakoutPeriod, i);
      const resistance = Math.max(...prevHighs);
      const support = Math.min(...prevLows);
      const range = resistance - support;
      if (!Number.isFinite(range) || range <= 0) continue;

      const breakoutThreshold = range * cfg.minBreakoutStrength;
      const bullishBreakout = cfg.v2Enabled && cfg.breakoutUseCloseConfirm
        ? price > resistance + breakoutThreshold
        : high > resistance + breakoutThreshold;

      const shortPrevHighs = highs.slice(i - cfg.shortBreakoutPeriod, i);
      const shortPrevLows = lows.slice(i - cfg.shortBreakoutPeriod, i);
      const shortResistance = Math.max(...shortPrevHighs);
      const shortSupport = Math.min(...shortPrevLows);
      const shortRange = shortResistance - shortSupport;
      if (!Number.isFinite(shortRange) || shortRange <= 0) continue;
      const shortBreakoutThreshold = shortRange * cfg.minBreakoutStrength;
      const bearishBreakout = cfg.v2Enabled && cfg.breakoutUseCloseConfirm
        ? price < shortSupport - shortBreakoutThreshold
        : low < shortSupport - shortBreakoutThreshold;
      const rangePercent = price > 0 ? (range / price) * 100 : 0;
      const rangeOk = rangePercent >= cfg.minRangePercent;
      const shortRangePercent = price > 0 ? (shortRange / price) * 100 : 0;
      const shortRangeOk = shortRangePercent >= cfg.shortMinRangePercent;
      const momentumLongOk = !cfg.v2Enabled || price > open;
      const momentumShortOk = !cfg.v2Enabled || price < open;
      canLong =
        bullishBreakout &&
        currentRSI >= cfg.rsiLongMin &&
        currentRSI <= cfg.rsiLongMax &&
        volumeOkLong &&
        rangeOk &&
        sessionOk &&
        regimeOk &&
        momentumLongOk;
      canShort =
        bearishBreakout &&
        currentRSI >= cfg.rsiShortMin &&
        currentRSI <= cfg.rsiShortMax &&
        volumeOkShort &&
        shortRangeOk &&
        sessionOk &&
        regimeOk &&
        momentumShortOk;
    }
    if (!cfg.allowLong) canLong = false;
    if (!cfg.allowShort) canShort = false;

    if (cfg.trendEnabled && cfg.strategy !== "pullback" && Number.isFinite(emaAligned[i])) {
      if (price <= emaAligned[i]) canLong = false;
      if (price >= emaAligned[i]) canShort = false;
    }

    if (!canLong && !canShort) continue;
    const side = canLong ? "buy" : "sell";
    const entry = side === "buy" ? price * (1 + slippageRate) : price * (1 - slippageRate);
    const quantity = (cfg.usdtPerTrade * cfg.leverage) / entry;
    if (!Number.isFinite(quantity) || quantity <= 0) continue;

    const atrForRisk = Number.isFinite(atrNow) && atrNow > 0 ? atrNow : null;
    let tp;
    let sl;
    if (cfg.v2Enabled && atrForRisk) {
      const stopDist = atrForRisk * cfg.atrStopMult;
      const targetDist = atrForRisk * cfg.atrTargetMult;
      tp = side === "buy" ? entry + targetDist : entry - targetDist;
      sl = side === "buy" ? entry - stopDist : entry + stopDist;
    } else {
      tp = side === "buy" ? entry + cfg.targetProfitUSDT / quantity : entry - cfg.targetProfitUSDT / quantity;
      const slUSDT = -cfg.usdtPerTrade * (cfg.stopLossPercent / 100);
      sl = side === "buy" ? entry + slUSDT / quantity : entry - slUSDT / quantity;
    }

    position = {
      side,
      entryPrice: entry,
      entryTs: ts,
      quantity,
      targetPrice: tp,
      stopLossPrice: sl,
      atrAtEntry: atrForRisk,
      highestSinceEntry: entry,
      lowestSinceEntry: entry,
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

const runGridSearch = (candles) => {
  const baseConfig = buildRuntimeConfig();
  if (baseConfig.strategy === "pullback") {
    return runPullbackGridSearch(candles);
  }
  const minVolumeRatios = toNumList(getArg("minVolumeRatios", ""), [1.2, 1.3, 1.4, 1.5, 1.6]);
  const breakoutPeriods = toNumList(getArg("breakoutPeriods", ""), [16, 20, 24, 28, 32]).map((v) => Math.trunc(v));
  const trendPeriods = toNumList(getArg("trendPeriods", ""), [80, 100, 120, 150]).map((v) => Math.trunc(v));
  const targetProfits = toNumList(getArg("targetProfits", ""), [0.5, 0.6, 0.7, 0.8, 1.0]);
  const minRangePercents = toNumList(getArg("minRangePercents", ""), [0.8, 1.0, 1.2]);
  const sessionWindowsRaw = String(getArg("sessionWindows", "7-22,0-23"));
  const sessionWindows = sessionWindowsRaw
    .split(",")
    .map((s) => s.trim())
    .map((s) => {
      const [a, b] = s.split("-").map((v) => Math.trunc(toNum(v, NaN)));
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      return { start: clamp(a, 0, 23), end: clamp(b, 0, 23) };
    })
    .filter(Boolean);

  const results = [];
  for (const minVolumeRatio of minVolumeRatios) {
    for (const breakoutPeriod of breakoutPeriods) {
      for (const trendPeriod of trendPeriods) {
        for (const targetProfitUSDT of targetProfits) {
          for (const minRangePercent of minRangePercents) {
            for (const win of sessionWindows) {
              const cfg = {
                ...baseConfig,
                minVolumeRatio,
                breakoutPeriod,
                trendPeriod,
                targetProfitUSDT,
                minRangePercent,
                sessionStartUTC: win.start,
                sessionEndUTC: win.end,
              };
              const r = backtest(candles, cfg, DEFAULTS.feeRate, DEFAULTS.slippageRate);
              const score = r.netPnlUSDT - Math.abs(r.maxDrawdownUSDT) * 0.3 + r.winRate * 0.02;
              results.push({
                minVolumeRatio,
                breakoutPeriod,
                trendPeriod,
                targetProfitUSDT,
                minRangePercent,
                sessionStartUTC: win.start,
                sessionEndUTC: win.end,
                trades: r.trades,
                winRate: r.winRate,
                netPnlUSDT: r.netPnlUSDT,
                maxDrawdownUSDT: r.maxDrawdownUSDT,
                score,
              });
            }
          }
        }
      }
    }
  }

  const filtered = results
    .filter((r) => r.trades >= 20)
    .sort((a, b) => b.score - a.score || b.netPnlUSDT - a.netPnlUSDT);
  const top = filtered.slice(0, 10);
  return { tested: results.length, qualified: filtered.length, top };
};

const runShortGridSearch = (candles) => {
  const baseConfig = buildRuntimeConfig();
  const minTrades = Math.max(5, Math.trunc(toNum(getArg("minTrades", "20"), 20)));

  const shortMinVolumeRatios = toNumList(getArg("shortMinVolumeRatios", ""), [1.1, 1.2, 1.3, 1.4, 1.5]);
  const shortBreakoutPeriods = toNumList(getArg("shortBreakoutPeriods", ""), [12, 16, 20, 24, 28]).map((v) => Math.trunc(v));
  const shortTrendPeriods = toNumList(getArg("shortTrendPeriods", ""), [80, 100, 120, 150]).map((v) => Math.trunc(v));
  const shortMinRangePercents = toNumList(getArg("shortMinRangePercents", ""), [0.4, 0.6, 0.8, 1.0]);
  const sessionWindowsRaw = String(getArg("sessionWindows", "0-23,7-22"));
  const sessionWindows = sessionWindowsRaw
    .split(",")
    .map((s) => s.trim())
    .map((s) => {
      const [a, b] = s.split("-").map((v) => Math.trunc(toNum(v, NaN)));
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      return { start: clamp(a, 0, 23), end: clamp(b, 0, 23) };
    })
    .filter(Boolean);

  const results = [];
  for (const shortMinVolumeRatio of shortMinVolumeRatios) {
    for (const shortBreakoutPeriod of shortBreakoutPeriods) {
      for (const shortTrendPeriod of shortTrendPeriods) {
        for (const shortMinRangePercent of shortMinRangePercents) {
          for (const win of sessionWindows) {
            const cfg = {
              ...baseConfig,
              strategy: "breakout",
              allowLong: false,
              allowShort: true,
              shortMinVolumeRatio,
              shortBreakoutPeriod,
              shortTrendPeriod,
              shortMinRangePercent,
              sessionStartUTC: win.start,
              sessionEndUTC: win.end,
            };
            const r = backtest(candles, cfg, DEFAULTS.feeRate, DEFAULTS.slippageRate);
            const score = r.netPnlUSDT - Math.abs(r.maxDrawdownUSDT) * 0.3 + r.winRate * 0.02;
            results.push({
              shortMinVolumeRatio,
              shortBreakoutPeriod,
              shortTrendPeriod,
              shortMinRangePercent,
              sessionStartUTC: win.start,
              sessionEndUTC: win.end,
              trades: r.trades,
              winRate: r.winRate,
              netPnlUSDT: r.netPnlUSDT,
              maxDrawdownUSDT: r.maxDrawdownUSDT,
              score,
            });
          }
        }
      }
    }
  }

  const filtered = results
    .filter((r) => r.trades >= minTrades)
    .sort((a, b) => b.score - a.score || b.netPnlUSDT - a.netPnlUSDT);
  return { tested: results.length, qualified: filtered.length, top: filtered.slice(0, 12), minTrades };
};

const runPullbackGridSearch = (candles) => {
  const baseConfig = buildRuntimeConfig();
  const minVolumeRatios = toNumList(getArg("minVolumeRatios", ""), [1.0, 1.1, 1.2, 1.3]);
  const trendPeriods = toNumList(getArg("trendPeriods", ""), [100, 120, 150, 200]).map((v) => Math.trunc(v));
  const pullbackEmaPeriods = toNumList(getArg("pullbackEmaPeriods", ""), [10, 20, 30, 50]).map((v) => Math.trunc(v));
  const pullbackLookbacks = toNumList(getArg("pullbackLookbacks", ""), [3, 5, 7]).map((v) => Math.trunc(v));
  const pullbackMaxDistancePcts = toNumList(getArg("pullbackMaxDistancePcts", ""), [0.3, 0.5, 0.8, 1.0]);
  const rsiLongMins = toNumList(getArg("rsiLongMins", ""), [50, 52, 55]);
  const rsiLongMaxs = toNumList(getArg("rsiLongMaxs", ""), [65, 68, 72]);
  const sessionWindowsRaw = String(getArg("sessionWindows", "0-23,7-22"));
  const sessionWindows = sessionWindowsRaw
    .split(",")
    .map((s) => s.trim())
    .map((s) => {
      const [a, b] = s.split("-").map((v) => Math.trunc(toNum(v, NaN)));
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      return { start: clamp(a, 0, 23), end: clamp(b, 0, 23) };
    })
    .filter(Boolean);

  const results = [];
  for (const minVolumeRatio of minVolumeRatios) {
    for (const trendPeriod of trendPeriods) {
      for (const pullbackEmaPeriod of pullbackEmaPeriods) {
        if (pullbackEmaPeriod >= trendPeriod) continue;
        for (const pullbackLookback of pullbackLookbacks) {
          for (const pullbackMaxDistancePct of pullbackMaxDistancePcts) {
            for (const rsiLongMin of rsiLongMins) {
              for (const rsiLongMax of rsiLongMaxs) {
                if (rsiLongMax <= rsiLongMin) continue;
                for (const win of sessionWindows) {
                  const cfg = {
                    ...baseConfig,
                    strategy: "pullback",
                    allowLong: true,
                    allowShort: false,
                    minVolumeRatio,
                    trendPeriod,
                    pullbackEmaPeriod,
                    pullbackLookback,
                    pullbackMaxDistancePct,
                    rsiLongMin,
                    rsiLongMax,
                    sessionStartUTC: win.start,
                    sessionEndUTC: win.end,
                  };
                  const r = backtest(candles, cfg, DEFAULTS.feeRate, DEFAULTS.slippageRate);
                  const score = r.netPnlUSDT - Math.abs(r.maxDrawdownUSDT) * 0.3 + r.winRate * 0.02;
                  results.push({
                    minVolumeRatio,
                    trendPeriod,
                    pullbackEmaPeriod,
                    pullbackLookback,
                    pullbackMaxDistancePct,
                    rsiLongMin,
                    rsiLongMax,
                    sessionStartUTC: win.start,
                    sessionEndUTC: win.end,
                    trades: r.trades,
                    winRate: r.winRate,
                    netPnlUSDT: r.netPnlUSDT,
                    maxDrawdownUSDT: r.maxDrawdownUSDT,
                    score,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  const minTrades = Math.max(8, Math.trunc(toNum(getArg("minTrades", "12"), 12)));
  const filtered = results
    .filter((r) => r.trades >= minTrades)
    .sort((a, b) => b.score - a.score || b.netPnlUSDT - a.netPnlUSDT);
  return { tested: results.length, qualified: filtered.length, top: filtered.slice(0, 12), minTrades };
};

const runRiskGridSearch = (candles) => {
  const baseConfig = buildRuntimeConfig();
  const minTrades = Math.max(5, Math.trunc(toNum(getArg("minTrades", "20"), 20)));
  const atrStopMults = toNumList(getArg("atrStopMults", ""), [0.8, 1.0, 1.2, 1.4]);
  const atrTargetMults = toNumList(getArg("atrTargetMults", ""), [1.6, 2.0, 2.4, 2.8]);
  const trailingActivateATRs = toNumList(getArg("trailingActivateATRs", ""), [0.8, 1.0, 1.2]);
  const trailingOffsetATRs = toNumList(getArg("trailingOffsetATRs", ""), [0.6, 0.8, 1.0]);
  const trailingModesRaw = String(getArg("trailingModes", "on"));
  const trailingModes = trailingModesRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .map((s) => (["off", "0", "false", "no"].includes(s) ? false : ["on", "1", "true", "yes"].includes(s) ? true : null))
    .filter((v) => v !== null);
  const trailModes = trailingModes.length ? trailingModes : [true];

  const results = [];
  for (const atrStopMult of atrStopMults) {
    for (const atrTargetMult of atrTargetMults) {
      for (const trailingActivateATR of trailingActivateATRs) {
        for (const trailingOffsetATR of trailingOffsetATRs) {
          for (const trailingEnabled of trailModes) {
            const cfg = {
              ...baseConfig,
              v2Enabled: true,
              atrStopMult,
              atrTargetMult,
              trailingActivateATR,
              trailingOffsetATR,
              trailingEnabled,
            };
            const r = backtest(candles, cfg, DEFAULTS.feeRate, DEFAULTS.slippageRate);
            const score = r.netPnlUSDT - Math.abs(r.maxDrawdownUSDT) * 0.3 + r.winRate * 0.02;
            results.push({
              atrStopMult,
              atrTargetMult,
              trailingActivateATR,
              trailingOffsetATR,
              trailingEnabled,
              trades: r.trades,
              winRate: r.winRate,
              netPnlUSDT: r.netPnlUSDT,
              maxDrawdownUSDT: r.maxDrawdownUSDT,
              score,
            });
          }
        }
      }
    }
  }

  const filtered = results
    .filter((r) => r.trades >= minTrades)
    .sort((a, b) => b.score - a.score || b.netPnlUSDT - a.netPnlUSDT);
  const top = filtered.slice(0, 12);
  return { tested: results.length, qualified: filtered.length, top, minTrades };
};

const runSensitivityAnalysis = (candles) => {
  const cfg = buildRuntimeConfig();
  const feeRates = toNumList(getArg("feeRates", ""), [0.0002, 0.0003, 0.0004, 0.0005, 0.0006]);
  const slippageRates = toNumList(getArg("slippageRates", ""), [0.0001, 0.0002, 0.0003, 0.0004, 0.0005]);

  const results = [];
  for (const feeRate of feeRates) {
    for (const slippageRate of slippageRates) {
      const r = backtest(candles, cfg, feeRate, slippageRate);
      const score = r.netPnlUSDT - Math.abs(r.maxDrawdownUSDT) * 0.2 + r.winRate * 0.01;
      results.push({
        feeRate,
        slippageRate,
        trades: r.trades,
        winRate: r.winRate,
        netPnlUSDT: r.netPnlUSDT,
        maxDrawdownUSDT: r.maxDrawdownUSDT,
        score,
      });
    }
  }

  const ordered = results.sort((a, b) => b.score - a.score || b.netPnlUSDT - a.netPnlUSDT);
  return { tested: results.length, top: ordered.slice(0, 12), all: ordered };
};

(async () => {
  try {
    console.log(`[BACKTEST] Fetching ${options.days}d ${options.interval} data for ${options.symbol}...`);
    const candles = await fetchAllKlines(options);
    if (!candles.length) throw new Error("No candles fetched");
    const selectedConfig = buildRuntimeConfig();

    if (options.mode === "grid") {
      console.log("[BACKTEST] Running grid search...");
      const grid = runGridSearch(candles);
      console.log("\n=== Grid Summary ===");
      console.log(`Tested combos : ${grid.tested}`);
      console.log(`Qualified     : ${grid.qualified} (trades >= ${grid.minTrades || 20})`);
      if (!grid.top.length) {
        console.log("No qualified result. Try wider ranges or longer days.");
        return;
      }
      console.table(selectedConfig.strategy === "pullback"
        ? grid.top.map((r, i) => ({
            rank: i + 1,
            minVolumeRatio: r.minVolumeRatio.toFixed(2),
            trendPeriod: r.trendPeriod,
            pullbackEma: r.pullbackEmaPeriod,
            lookback: r.pullbackLookback,
            maxDistPct: r.pullbackMaxDistancePct.toFixed(2),
            rsiBand: `${r.rsiLongMin}-${r.rsiLongMax}`,
            sessionUTC: `${r.sessionStartUTC}-${r.sessionEndUTC}`,
            trades: r.trades,
            winRate: `${r.winRate.toFixed(2)}%`,
            netPnlUSDT: r.netPnlUSDT.toFixed(4),
            maxDD: r.maxDrawdownUSDT.toFixed(4),
            score: r.score.toFixed(4),
          }))
        : grid.top.map((r, i) => ({
            rank: i + 1,
            minVolumeRatio: r.minVolumeRatio.toFixed(2),
            breakoutPeriod: r.breakoutPeriod,
            trendPeriod: r.trendPeriod,
            targetProfitUSDT: r.targetProfitUSDT.toFixed(2),
            minRangePercent: r.minRangePercent.toFixed(2),
            sessionUTC: `${r.sessionStartUTC}-${r.sessionEndUTC}`,
            trades: r.trades,
            winRate: `${r.winRate.toFixed(2)}%`,
            netPnlUSDT: r.netPnlUSDT.toFixed(4),
            maxDD: r.maxDrawdownUSDT.toFixed(4),
            score: r.score.toFixed(4),
          })));
      const best = grid.top[0];
      console.log("\nBest config candidate:");
      console.log(
        JSON.stringify(
          selectedConfig.strategy === "pullback"
            ? {
                strategy: "pullback",
                allowLong: true,
                allowShort: false,
                minVolumeRatio: best.minVolumeRatio,
                trendPeriod: best.trendPeriod,
                pullbackEmaPeriod: best.pullbackEmaPeriod,
                pullbackLookback: best.pullbackLookback,
                pullbackMaxDistancePct: best.pullbackMaxDistancePct,
                rsiLongMin: best.rsiLongMin,
                rsiLongMax: best.rsiLongMax,
                sessionStartUTC: best.sessionStartUTC,
                sessionEndUTC: best.sessionEndUTC,
              }
            : {
                minVolumeRatio: best.minVolumeRatio,
                breakoutPeriod: best.breakoutPeriod,
                trendPeriod: best.trendPeriod,
                targetProfitUSDT: best.targetProfitUSDT,
                minRangePercent: best.minRangePercent,
                sessionStartUTC: best.sessionStartUTC,
                sessionEndUTC: best.sessionEndUTC,
              },
          null,
          2
        )
      );
    } else if (options.mode === "grid-short") {
      console.log("[BACKTEST] Running short-only grid search...");
      const grid = runShortGridSearch(candles);
      console.log("\n=== Short Grid Summary ===");
      console.log(`Tested combos : ${grid.tested}`);
      console.log(`Qualified     : ${grid.qualified} (trades >= ${grid.minTrades})`);
      if (!grid.top.length) {
        console.log("No qualified result. Try wider ranges or longer days.");
        return;
      }
      console.table(
        grid.top.map((r, i) => ({
          rank: i + 1,
          shortMinVolumeRatio: r.shortMinVolumeRatio.toFixed(2),
          shortBreakoutPeriod: r.shortBreakoutPeriod,
          shortTrendPeriod: r.shortTrendPeriod,
          shortMinRangePercent: r.shortMinRangePercent.toFixed(2),
          sessionUTC: `${r.sessionStartUTC}-${r.sessionEndUTC}`,
          trades: r.trades,
          winRate: `${r.winRate.toFixed(2)}%`,
          netPnlUSDT: r.netPnlUSDT.toFixed(4),
          maxDD: r.maxDrawdownUSDT.toFixed(4),
          score: r.score.toFixed(4),
        }))
      );
      const best = grid.top[0];
      console.log("\nBest short config candidate:");
      console.log(
        JSON.stringify(
          {
            allowLong: false,
            allowShort: true,
            shortMinVolumeRatio: best.shortMinVolumeRatio,
            shortBreakoutPeriod: best.shortBreakoutPeriod,
            shortTrendPeriod: best.shortTrendPeriod,
            shortMinRangePercent: best.shortMinRangePercent,
            sessionStartUTC: best.sessionStartUTC,
            sessionEndUTC: best.sessionEndUTC,
          },
          null,
          2
        )
      );
    } else if (options.mode === "grid-risk") {
      console.log("[BACKTEST] Running risk grid search (ATR + trailing)...");
      const grid = runRiskGridSearch(candles);
      console.log("\n=== Risk Grid Summary ===");
      console.log(`Tested combos : ${grid.tested}`);
      console.log(`Qualified     : ${grid.qualified} (trades >= ${grid.minTrades || 20})`);
      if (!grid.top.length) {
        console.log("No qualified result. Try wider ranges or longer days.");
        return;
      }
      console.table(
        grid.top.map((r, i) => ({
          rank: i + 1,
          atrStopMult: r.atrStopMult.toFixed(2),
          atrTargetMult: r.atrTargetMult.toFixed(2),
          trailingActivateATR: r.trailingActivateATR.toFixed(2),
          trailingOffsetATR: r.trailingOffsetATR.toFixed(2),
          trailing: r.trailingEnabled ? "ON" : "OFF",
          trades: r.trades,
          winRate: `${r.winRate.toFixed(2)}%`,
          netPnlUSDT: r.netPnlUSDT.toFixed(4),
          maxDD: r.maxDrawdownUSDT.toFixed(4),
          score: r.score.toFixed(4),
        }))
      );
      const best = grid.top[0];
      console.log("\nBest risk config candidate:");
      console.log(
        JSON.stringify(
          {
            atrStopMult: best.atrStopMult,
            atrTargetMult: best.atrTargetMult,
            trailingActivateATR: best.trailingActivateATR,
            trailingOffsetATR: best.trailingOffsetATR,
            trailingEnabled: best.trailingEnabled,
          },
          null,
          2
        )
      );
    } else if (options.mode === "sensitivity") {
      console.log("[BACKTEST] Running fee/slippage sensitivity analysis...");
      const sens = runSensitivityAnalysis(candles);
      console.log("\n=== Sensitivity Summary ===");
      console.log(`Tested combos : ${sens.tested}`);
      console.table(
        sens.top.map((r, i) => ({
          rank: i + 1,
          feeRate: (r.feeRate * 100).toFixed(3) + "%",
          slippageRate: (r.slippageRate * 100).toFixed(3) + "%",
          trades: r.trades,
          winRate: `${r.winRate.toFixed(2)}%`,
          netPnlUSDT: r.netPnlUSDT.toFixed(4),
          maxDD: r.maxDrawdownUSDT.toFixed(4),
          score: r.score.toFixed(4),
        }))
      );
      const best = sens.top[0];
      if (best) {
        console.log("\nBest execution assumptions:");
        console.log(
          JSON.stringify(
            {
              feeRate: best.feeRate,
              slippageRate: best.slippageRate,
              netPnlUSDT: best.netPnlUSDT,
              trades: best.trades,
            },
            null,
            2
          )
        );
      }
    } else {
      const runtimeConfig = buildRuntimeConfig();
      const result = backtest(candles, runtimeConfig, DEFAULTS.feeRate, DEFAULTS.slippageRate);
      const profitableDays = result.daily.filter((d) => d.pnl > 0).length;
      const losingDays = result.daily.filter((d) => d.pnl < 0).length;

      console.log("\n=== Backtest Summary ===");
      console.log(
        runtimeConfig.strategy === "pullback"
          ? `Config         : strategy=pullback | vol>=${runtimeConfig.minVolumeRatio}x | trend=${runtimeConfig.trendPeriod} | pullbackEMA=${runtimeConfig.pullbackEmaPeriod} | lookback=${runtimeConfig.pullbackLookback} | maxDist=${runtimeConfig.pullbackMaxDistancePct}% | RSI=${runtimeConfig.rsiLongMin}-${runtimeConfig.rsiLongMax} | session=${runtimeConfig.sessionStartUTC}-${runtimeConfig.sessionEndUTC} UTC | regime=${runtimeConfig.regimeFilterEnabled ? `ATR p${runtimeConfig.regimeAtrPercentile} (${runtimeConfig.regimeAtrLookback})` : "OFF"} | ATR(${runtimeConfig.atrPeriod}) stop=${runtimeConfig.atrStopMult} target=${runtimeConfig.atrTargetMult} trail=${runtimeConfig.trailingEnabled}`
          : `Config         : strategy=breakout | vol>=${runtimeConfig.minVolumeRatio}x | breakout=${runtimeConfig.breakoutPeriod} | trend=${runtimeConfig.trendPeriod} | TP=${runtimeConfig.targetProfitUSDT} | range>=${runtimeConfig.minRangePercent}% | session=${runtimeConfig.sessionStartUTC}-${runtimeConfig.sessionEndUTC} UTC | regime=${runtimeConfig.regimeFilterEnabled ? `ATR p${runtimeConfig.regimeAtrPercentile} (${runtimeConfig.regimeAtrLookback})` : "OFF"} | v2=${runtimeConfig.v2Enabled} closeConfirm=${runtimeConfig.breakoutUseCloseConfirm} ATR(${runtimeConfig.atrPeriod}) stop=${runtimeConfig.atrStopMult} target=${runtimeConfig.atrTargetMult} trail=${runtimeConfig.trailingEnabled}`
      );
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
    }
  } catch (error) {
    console.error("[BACKTEST_ERROR]", error.message);
    process.exit(1);
  }
})();
