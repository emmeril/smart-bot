require("dotenv").config();
const fs = require("fs");
const ccxt = require("ccxt");
const { RSI, EMA, MACD, ADX } = require("technicalindicators");
const { Client, LocalAuth } = require("whatsapp-web.js");
const express = require("express");
const QRCode = require("qrcode");
const isBacktest = process.argv.includes("--backtest");

const app = express();
app.listen(7890, () => console.log("🟢 QR server di http://localhost:7890"));

const dbPath = "./db.json";
const logPath = "./log.csv";
const db = fs.existsSync(dbPath)
  ? JSON.parse(fs.readFileSync(dbPath))
  : {
      pair: "DOGE/USDT:USDT",
      trailingOffset: 0.003,
      positionLong: null,
      positionShort: null,
      lastLongEntryTime: 0,
      lastShortEntryTime: 0,
      lossCountLong: 0,
      lossCountShort: 0,
      leverage: 10,
      marginMode: "isolated",
    };

const TP_PERCENT = 0.03;
const SL_PERCENT = 0.02;
const SCORE_THRESHOLD = 7;
const COOLDOWN_MINUTES = 30;
const LOSS_LIMIT = 3;
const MAX_HOLD_MINUTES = 45;

const exchange = new ccxt.binance({
  apiKey: isBacktest ? undefined : process.env.API_KEY,
  secret: isBacktest ? undefined : process.env.API_SECRET,
  options: {
    defaultType: "future",
  },
});

let currentQR = null;
let isReady = false;

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    // executablePath: "/usr/bin/chromium",
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  },
});

client.on("qr", (qr) => {
  currentQR = qr;
  isReady = false;
  console.log("📲 QR code siap discan.");
});

client.on("ready", () => {
  isReady = true;
  currentQR = null;
  console.log("✅ WhatsApp berhasil terhubung.");
});

client.on("disconnected", (reason) => {
  console.log("❌ WhatsApp disconnected:", reason);
  fs.rmSync(".wwebjs_auth", { recursive: true, force: true });
  process.exit();
});

client.initialize();

app.get("/qr", async (req, res) => {
  if (isReady) {
    return res.send(
      `<html><body><div style="font-family:sans-serif;padding:20px;text-align:center;font-size:1.5rem;color:green;">✅ WhatsApp sudah terhubung.</div></body></html>`
    );
  }

  if (!currentQR) {
    return res.send("⏳ Menunggu QR code tersedia...");
  }

  const qrImage = await QRCode.toDataURL(currentQR);
  res.send(`
    <html>
      <head><meta http-equiv="refresh" content="15" /></head>
      <body style="text-align:center;font-family:sans-serif">
        <h1>Scan QR WhatsApp</h1>
        <img src="${qrImage}" style="width:90%;max-width:300px;border:10px solid #fff;box-shadow:0 0 10px #aaa;border-radius:8px;" />
        <p>⏳ Halaman ini auto-refresh tiap 15 detik</p>
      </body>
    </html>
  `);
});

const saveDB = () => fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
const now = () => Date.now();
const mins = (ms) => ms / 1000 / 60;

const sendMsg = async (text) => {
  const chats = await client.getChats();
  const chat = chats.find(
    (c) => c.isGroup === false && c.id.user === process.env.ADMIN_PHONE
  );
  if (chat) chat.sendMessage(text);
};

const updatePnL = (type, entry, exit, amount, result) => {
  const diff = type === "long" ? exit - entry : entry - exit;
  const pnl = diff * amount;
  if (result === "sl_hit" || result === "cut_timeout") {
    db.totalLoss += Math.abs(pnl);
  } else {
    db.totalProfit += pnl;
  }
  saveDB();
};

const logTrade = (
  type,
  entry,
  tp,
  sl,
  exitPrice,
  result,
  amount = 0,
  usedUSDT = 0
) => {
  const row = `${new Date().toISOString()},${
    db.pair
  },${type},${entry},${tp},${sl},${result},${exitPrice},${amount},${usedUSDT}\n`;
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(
      logPath,
      "timestamp,pair,side,entry,tp,sl,result,exitPrice,amount,usedUSDT\n"
    );
  }
  fs.appendFileSync(logPath, row);
};

const getPrice = async () => {
  const ticker = await exchange.fetchTicker(db.pair);
  return ticker.last;
};

const analyzeSignal = async () => {
  const ohlcv = await exchange.fetchOHLCV(db.pair, "15m", undefined, 200);
  const close = ohlcv.map((c) => c[4]);
  const high = ohlcv.map((c) => c[2]);
  const low = ohlcv.map((c) => c[3]);

  const rsi = RSI.calculate({ values: close.slice(-50), period: 14 }).pop();
  const ema20 = EMA.calculate({ values: close.slice(-50), period: 20 }).pop();
  const ema50 = EMA.calculate({ values: close.slice(-50), period: 50 }).pop();
  const ma200 = EMA.calculate({ values: close, period: 200 }).pop();
  const macd = MACD.calculate({
    values: close.slice(-50),
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
  }).pop();
  const adx = ADX.calculate({
    close: close.slice(-50),
    high: high.slice(-50),
    low: low.slice(-50),
    period: 14,
  }).pop();

  const prevCandle = ohlcv[ohlcv.length - 2];
  const candleBody = Math.abs(prevCandle[4] - prevCandle[1]);
  const candleRange = prevCandle[2] - prevCandle[3];
  const isStrongCandle = candleBody / candleRange >= 0.4;
  const candleUp = prevCandle[4] > prevCandle[1];
  const candleDown = prevCandle[4] < prevCandle[1];

  const price = ohlcv.at(-1)[4];

  const countTrue = (...conds) => conds.filter(Boolean).length;

  const scoreLong = countTrue(
    rsi < 35,
    macd?.histogram > 0,
    ema20 > ema50,
    adx?.adx > 20,
    isStrongCandle,
    candleUp
  );

  const scoreShort = countTrue(
    rsi > 65,
    macd?.histogram < 0,
    ema20 < ema50,
    adx?.adx > 20,
    isStrongCandle,
    candleDown
  );

  const canLong = scoreLong >= 4 && price > ma200;
  const canShort = scoreShort >= 4 && price < ma200;

  return { canLong, canShort };
};

const runBacktest = async () => {
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
  fs.writeFileSync(
    logPath,
    "timestamp,pair,side,entry,tp,sl,result,exitPrice,amount,usedUSDT\n"
  );

  const since = exchange.milliseconds() - 30 * 24 * 60 * 60 * 1000;
  const ohlcv = await exchange.fetchOHLCV(db.pair, "15m", since);

  const countTrue = (...conds) => conds.filter(Boolean).length;

  const TRAIL_OFFSET = 0.015;
  const ACTIVATE_PROFIT = 0.03;
  const SL_PERCENT = 0.02;

  let longCount = 0,
    shortCount = 0;
  let lastLongTime = 0,
    lastShortTime = 0;

  for (let i = 200; i < ohlcv.length; i++) {
    const slice = ohlcv.slice(i - 200, i);
    const close = slice.map((c) => c[4]);
    const high = slice.map((c) => c[2]);
    const low = slice.map((c) => c[3]);

    const rsi = RSI.calculate({ values: close.slice(-50), period: 14 }).pop();
    const ema20 = EMA.calculate({ values: close.slice(-50), period: 20 }).pop();
    const ema50 = EMA.calculate({ values: close.slice(-50), period: 50 }).pop();
    const ma200 = EMA.calculate({ values: close, period: 200 }).pop();
    const macd = MACD.calculate({
      values: close.slice(-50),
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
    }).pop();
    const adx = ADX.calculate({
      close: close.slice(-50),
      high: high.slice(-50),
      low: low.slice(-50),
      period: 14,
    }).pop();

    const prevCandle = slice[198];
    const candleBody = Math.abs(prevCandle[4] - prevCandle[1]);
    const candleRange = prevCandle[2] - prevCandle[3];
    const isStrongCandle = candleBody / candleRange >= 0.4;
    const candleUp = prevCandle[4] > prevCandle[1];
    const candleDown = prevCandle[4] < prevCandle[1];

    const price = slice[199][4];
    const timestamp = slice[199][0];

    const longScore = countTrue(
      rsi < 35,
      macd?.histogram > 0,
      ema20 > ema50,
      adx?.adx > 20,
      isStrongCandle,
      candleUp
    );

    const shortScore = countTrue(
      rsi > 65,
      macd?.histogram < 0,
      ema20 < ema50,
      adx?.adx > 20,
      isStrongCandle,
      candleDown
    );

    const canLong = longScore >= 4 && price > ma200;
    const canShort = shortScore >= 4 && price < ma200;

    const simulateTrailingExit = (future, entry, type) => {
      let trailActivated = false;
      let trailStop = 0;

      for (let j = 0; j < future.length; j++) {
        const p = future[j][4];

        // Hit SL langsung
        const slHit =
          type === "long"
            ? p <= entry * (1 - SL_PERCENT)
            : p >= entry * (1 + SL_PERCENT);
        if (slHit) return { price: p, result: "sl_hit" };

        const profit =
          type === "long" ? (p - entry) / entry : (entry - p) / entry;

        if (!trailActivated && profit >= ACTIVATE_PROFIT) {
          trailActivated = true;
          trailStop =
            type === "long" ? p * (1 - TRAIL_OFFSET) : p * (1 + TRAIL_OFFSET);
        }

        if (trailActivated) {
          const stopHit = type === "long" ? p <= trailStop : p >= trailStop;
          if (stopHit) {
            return { price: p, result: "trailing_exit" };
          }

          trailStop =
            type === "long"
              ? Math.max(trailStop, p * (1 - TRAIL_OFFSET))
              : Math.min(trailStop, p * (1 + TRAIL_OFFSET));
        }
      }

      return { price: future.at(-1)[4], result: "timeout_exit" };
    };

    // Entry Long
    if (canLong && timestamp - lastLongTime >= COOLDOWN_MINUTES * 60 * 1000) {
      lastLongTime = timestamp;
      longCount++;

      const future = ohlcv.slice(i, i + 48); // 12 jam ke depan
      const entry = price;
      const exit = simulateTrailingExit(future, entry, "long");

      const usedUSDT = 100;
      const amount = usedUSDT / entry;

      console.log(
        `[LONG] Entry @ ${entry.toFixed(4)} Exit @ ${exit.price.toFixed(4)} | ${
          exit.result
        }`
      );
      logTrade(
        "long",
        entry,
        "-",
        "-",
        exit.price,
        exit.result,
        amount,
        usedUSDT
      );
    }

    // Entry Short
    if (canShort && timestamp - lastShortTime >= COOLDOWN_MINUTES * 60 * 1000) {
      lastShortTime = timestamp;
      shortCount++;

      const future = ohlcv.slice(i, i + 48);
      const entry = price;
      const exit = simulateTrailingExit(future, entry, "short");

      const usedUSDT = 100;
      const amount = usedUSDT / entry;

      console.log(
        `[SHORT] Entry @ ${entry.toFixed(4)} Exit @ ${exit.price.toFixed(
          4
        )} | ${exit.result}`
      );
      logTrade(
        "short",
        entry,
        "-",
        "-",
        exit.price,
        exit.result,
        amount,
        usedUSDT
      );
    }
  }

  console.log("✅ Backtest selesai. Lihat hasil di log.csv");
  console.log(`📈 Total Entry Long: ${longCount} | Short: ${shortCount}`);
  summarizeLog();
  process.exit();
};

const simulateExit = (slice, entry, tp, sl, type) => {
  for (let j = 0; j < slice.length; j++) {
    const candle = slice[j];
    const high = candle[2];
    const low = candle[3];

    if (type === "long") {
      if (low <= sl) return { price: sl, result: "sl_hit" };
      if (high >= tp) return { price: tp, result: "tp_hit" };
    } else {
      if (high >= sl) return { price: sl, result: "sl_hit" };
      if (low <= tp) return { price: tp, result: "tp_hit" };
    }
  }
  return { price: slice[slice.length - 1][4], result: "timeout" };
};

const summarizeLog = () => {
  if (!fs.existsSync(logPath)) {
    console.log("⚠️ log.csv tidak ditemukan.");
    return;
  }

  const rows = fs.readFileSync(logPath, "utf-8").trim().split("\n").slice(1);
  if (rows.length === 0) {
    console.log("⚠️ log.csv kosong.");
    return;
  }

  let total = 0;
  let win = 0;
  let loss = 0;
  let profit = 0;
  let lossAmount = 0;

  for (const line of rows) {
    const [, , side, entry, tp, sl, result, exitPrice, amount, usedUSDT] =
      line.split(",");

    const entryPrice = parseFloat(entry);
    const exit = parseFloat(exitPrice);
    const qty = parseFloat(amount);

    let pnl = 0;
    if (side === "long") pnl = (exit - entryPrice) * qty;
    else pnl = (entryPrice - exit) * qty;

    total++;
    if (result.includes("tp") || result.includes("trailing")) {
      win++;
      profit += pnl;
    } else {
      loss++;
      lossAmount += Math.abs(pnl);
    }
  }

  const net = profit - lossAmount;
  const winrate = ((win / total) * 100).toFixed(2);

  console.log(`📊 Ringkasan Backtest dari log.csv
📈 Total Posisi: ${total}
✅ Menang (TP): ${win}
❌ Kalah (SL): ${loss}
🎯 Winrate: ${winrate}%
💵 Profit: $${profit.toFixed(2)}
📉 Loss: $${lossAmount.toFixed(2)}
📊 Net PnL: $${net.toFixed(2)} ${net >= 0 ? "🟢" : "🔴"}
`);
};

const openPosition = async (type) => {
  const nowTime = now();
  if (type === "long") db.lastLongEntryTime = nowTime;
  else db.lastShortEntryTime = nowTime;

  await exchange.setLeverage(db.leverage, db.pair);
  await exchange.setMarginMode(db.marginMode, db.pair).catch(() => {});

  const side = type === "long" ? "buy" : "sell";

  const balance = await exchange.fetchBalance();
  const usdt = balance.total.USDT;
  const percent = db.balancePercent || 10;
  const amountUSDT = usdt * (percent / 100);

  const price = await getPrice();
  const market = await exchange.market(db.pair);
  const amountRaw = amountUSDT / price;
  const amount = exchange.amountToPrecision(db.pair, amountRaw);

  const order = await exchange.createMarketOrder(
    db.pair,
    side,
    parseFloat(amount)
  );

  const entry = order.average;

  const usedUSDT = amountUSDT;
  const position = {
    entry,
    sl: type === "long" ? entry * (1 - SL_PERCENT) : entry * (1 + SL_PERCENT),
    trailingActive: false,
    trailingStop: 0,
    entryTime: nowTime,
    amount: parseFloat(amount),
    usedUSDT: parseFloat(usedUSDT.toFixed(2)),
  };

  if (type === "long") db.positionLong = position;
  else db.positionShort = position;

  saveDB();

  sendMsg(
    `${type === "long" ? "🟢 LONG" : "🔴 SHORT"} opened @ ${entry.toFixed(
      5
    )} | SL: ${position.sl.toFixed(5)}\n💰 Size: ~${amount} ${
      market.base
    } ($${usedUSDT.toFixed(2)})`
  );
};

const checkTP_SL = async (type) => {
  const price = await getPrice();
  const key = type === "long" ? "positionLong" : "positionShort";
  const lossKey = type === "long" ? "lossCountLong" : "lossCountShort";
  const position = db[key];
  if (!position) return;

  const { entry, trailingActive, trailingStop, entryTime, amount } = position;
  const holdMins = mins(now() - entryTime);

  const profit =
    type === "long" ? (price - entry) / entry : (entry - price) / entry;

  const slHit =
    type === "long"
      ? price <= entry * (1 - SL_PERCENT)
      : price >= entry * (1 + SL_PERCENT);

  // ✅ Exit by Stop Loss
  if (slHit) {
    db[key] = null;
    db[lossKey]++;
    saveDB();
    sendMsg(`⚠️ ${type.toUpperCase()} STOP LOSS hit @ ${price}`);
    logTrade(type, entry, "-", "-", price, "sl_hit", amount, position.usedUSDT);
    updatePnL(type, entry, price, amount, "sl_hit");
    return;
  }

  // 🟢 Activate Trailing
  if (!trailingActive && profit >= 0.03) {
    position.trailingActive = true;
    position.trailingStop =
      type === "long"
        ? price * (1 - db.trailingOffset)
        : price * (1 + db.trailingOffset);
    saveDB();
    sendMsg(`🎯 ${type.toUpperCase()} profit > 3%. Trailing ON @ ${price}`);
    return;
  }

  // 🏁 Exit by Trailing
  if (trailingActive) {
    const stopHit =
      type === "long"
        ? price <= position.trailingStop
        : price >= position.trailingStop;
    if (stopHit) {
      db[key] = null;
      db[lossKey] = 0;
      saveDB();
      sendMsg(`🏁 ${type.toUpperCase()} Trailing Stop HIT @ ${price}`);
      logTrade(
        type,
        entry,
        "-",
        "-",
        price,
        "trailing_exit",
        amount,
        position.usedUSDT
      );
      updatePnL(type, entry, price, amount, "trailing_exit");
    } else {
      // Update trailing stop lebih tinggi
      position.trailingStop =
        type === "long"
          ? Math.max(position.trailingStop, price * (1 - db.trailingOffset))
          : Math.min(position.trailingStop, price * (1 + db.trailingOffset));
      saveDB();
    }
  }
};

client.on("message", async (msg) => {
  const txt = msg.body.toLowerCase();
  if (!msg.fromMe && !msg.from.includes(process.env.ADMIN_PHONE)) return;

  if (txt.startsWith("!pair ")) {
    db.pair = txt.split(" ")[1].toUpperCase();
    db.positionLong = null;
    db.positionShort = null;
    saveDB();
    msg.reply(`✅ Pair set to ${db.pair}`);
  } else if (txt === "!status") {
    const cooldownLong = Math.round(mins(now() - db.lastLongEntryTime));
    const cooldownShort = Math.round(mins(now() - db.lastShortEntryTime));
    const posLong = db.positionLong
      ? `📍 Entry @ ${db.positionLong.entry.toFixed(
          4
        )} | SL: ${db.positionLong.sl.toFixed(4)}`
      : "🚫 Belum ada";
    const posShort = db.positionShort
      ? `📍 Entry @ ${db.positionShort.entry.toFixed(
          4
        )} | SL: ${db.positionShort.sl.toFixed(4)}`
      : "🚫 Belum ada";

    msg.reply(`📊 *Status Bot*
📌 Pair: *${db.pair}*
🧭 Leverage: *${db.leverage}x* (${db.marginMode.toUpperCase()})

📉 *LONG*
⏱ Cooldown: ${cooldownLong}m
❌ Loss Count: ${db.lossCountLong}
${posLong}

📈 *SHORT*
⏱ Cooldown: ${cooldownShort}m
❌ Loss Count: ${db.lossCountShort}
${posShort}`);
  } else if (txt.startsWith("!leverage")) {
    const [, lev, mode] = txt.split(" ");
    const leverage = parseInt(lev);
    const validMode = mode === "cross" || mode === "isolated";
    if (!leverage || !validMode) {
      msg.reply("⚠️ Format salah. Contoh: !leverage 10 isolated");
    } else {
      db.leverage = leverage;
      db.marginMode = mode;
      saveDB();
      msg.reply(`✅ Leverage diset: ${leverage}x (${mode.toUpperCase()})`);
    }
  } else if (txt.startsWith("!balance ")) {
    const val = parseFloat(txt.split(" ")[1]);
    if (isNaN(val) || val < 1 || val > 100) {
      msg.reply("⚠️ Format salah. Contoh: !balance 10");
    } else {
      db.balancePercent = val;
      saveDB();
      msg.reply(`✅ Bot hanya akan gunakan ${val}% dari saldo USDT`);
    }
  } else if (txt === "!pnl") {
    const net = db.totalProfit - db.totalLoss;
    msg.reply(`💹 PnL Summary:
📈 Profit: $${db.totalProfit.toFixed(2)}
📉 Loss: $${db.totalLoss.toFixed(2)}
📊 Net: $${net.toFixed(2)} ${net >= 0 ? "🟢" : "🔴"}`);
  }
});

setInterval(async () => {
  try {
    await checkTP_SL("long");
    await checkTP_SL("short");

    const { canLong, canShort } = await analyzeSignal();

    const nowTime = now();

    const readyLong =
      !db.positionLong &&
      nowTime - db.lastLongEntryTime >= COOLDOWN_MINUTES * 60 * 1000 &&
      db.lossCountLong < LOSS_LIMIT;

    const readyShort =
      !db.positionShort &&
      nowTime - db.lastShortEntryTime >= COOLDOWN_MINUTES * 60 * 1000 &&
      db.lossCountShort < LOSS_LIMIT;

    if (canLong && readyLong) {
      await openPosition("long");
    }

    if (canShort && readyShort) {
      await openPosition("short");
    }
  } catch (e) {
    console.log("⚠️ Bot error:", e.message);
  }
}, 60 * 1000); // setiap 1 menit

if (isBacktest) runBacktest();
