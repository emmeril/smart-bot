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
      pair: "XRP/USDT:USDT",
      trailingOffset: 0.003,
      balancePercent: 100,
      positionLong: null,
      positionShort: null,
      lastLongEntryTime: 0,
      lastShortEntryTime: 0,
      lossCountLong: 0,
      lossCountShort: 0,
      winCountLong: 0,
      winCountShort: 0,
      leverage: 10,
      marginMode: "isolated",
      totalProfit: 0,
      totalLoss: 0,
    };

const TP_PERCENT = 0.03;
const SL_PERCENT = 0.02;
const COOLDOWN_MINUTES = 30;
const LOSS_LIMIT = 3;
const MAX_HOLD_MINUTES = 1440;

const exchange = new ccxt.binance({
  apiKey: isBacktest ? undefined : process.env.API_KEY,
  secret: isBacktest ? undefined : process.env.API_SECRET,
  options: { defaultType: "future" },
});

let currentQR = null;
let isReady = false;

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: "/snap/bin/chromium",
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

client.on("message", async (msg) => {
  const txt = msg.body.toLowerCase();
  if (!msg.fromMe && !msg.from.includes(process.env.ADMIN_PHONE)) return;

  // Ganti pair
  if (txt.startsWith("!pair ")) {
    db.pair = txt.split(" ")[1].toUpperCase();
    db.positionLong = null;
    db.positionShort = null;
    db.lastLongEntryTime = 0;
    db.lastShortEntryTime = 0;
    saveDB();
    msg.reply(`✅ Pair diubah ke *${db.pair}*.`);
  }

  // Cek status bot
  else if (txt === "!status") {
    const cooldownLong = db.lastLongEntryTime
      ? Math.round(mins(now() - db.lastLongEntryTime)) + "m"
      : "Belum pernah entry";

    const cooldownShort = db.lastShortEntryTime
      ? Math.round(mins(now() - db.lastShortEntryTime)) + "m"
      : "Belum pernah entry";

    const fltLong = await calcFloatingPnl("long");
    const fltShort = await calcFloatingPnl("short");

    const roiLong =
      db.positionLong && fltLong != null
        ? (
            (fltLong /
              ((db.positionLong.entry * db.positionLong.amount) /
                db.leverage)) *
            100
          ).toFixed(2)
        : null;

    const roiShort =
      db.positionShort && fltShort != null
        ? (
            (fltShort /
              ((db.positionShort.entry * db.positionShort.amount) /
                db.leverage)) *
            100
          ).toFixed(2)
        : null;

    const posLong = db.positionLong
      ? `📍 Entry @ ${db.positionLong.entry.toFixed(4)}\n🎯 ROI TP: ${(
          TP_PERCENT * 100
        ).toFixed(1)}% | SL: ${(SL_PERCENT * 100).toFixed(
          1
        )}%\n📊 Floating PnL: ${fltLong >= 0 ? "+" : "-"}$${Math.abs(
          fltLong
        ).toFixed(4)} (${roiLong}%)`
      : "🚫 Belum ada";

    const posShort = db.positionShort
      ? `📍 Entry @ ${db.positionShort.entry.toFixed(4)}\n🎯 ROI TP: ${(
          TP_PERCENT * 100
        ).toFixed(1)}% | SL: ${(SL_PERCENT * 100).toFixed(
          1
        )}%\n📊 Floating PnL: ${fltShort >= 0 ? "+" : "-"}$${Math.abs(
          fltShort
        ).toFixed(4)} (${roiShort}%)`
      : "🚫 Belum ada";

    msg.reply(`📊 *Status Bot*
📌 Pair: *${db.pair}*
🧭 Leverage: *${db.leverage}x* (${db.marginMode?.toUpperCase() || "?"})
📎 Mode Entry: *${(db.entryMode || "DEFAULT").toUpperCase()}*

📈 *LONG*
⏱ Cooldown: ${cooldownLong}
✅ Profit Count: ${db.winCountLong || 0}
❌ Loss Count: ${db.lossCountLong}
${posLong}

📉 *SHORT*
⏱ Cooldown: ${cooldownShort}
✅ Profit Count: ${db.winCountShort || 0}
❌ Loss Count: ${db.lossCountShort}
${posShort}`);
  }

  // Set leverage dan margin mode
  else if (txt.startsWith("!leverage ")) {
    const [, lev, mode] = txt.split(" ");
    const leverage = parseInt(lev);
    const validMode = mode === "cross" || mode === "isolated";
    if (!leverage || !validMode) {
      msg.reply("⚠️ Format salah. Contoh: !leverage 10 isolated");
    } else {
      db.leverage = leverage;
      db.marginMode = mode;
      saveDB();
      msg.reply(`✅ Leverage diatur: *${leverage}x* (${mode.toUpperCase()})`);
    }
  }

  // Atur persentase balance
  else if (txt.startsWith("!balance ")) {
    const val = parseFloat(txt.split(" ")[1]);
    if (isNaN(val) || val < 1 || val > 100) {
      msg.reply("⚠️ Format salah. Contoh: !balance 20");
    } else {
      db.balancePercent = val;
      saveDB();
      msg.reply(`✅ Bot akan gunakan *${val}%* dari saldo USDT.`);
    }
  }

  // Cek PnL total
  else if (txt === "!pnl") {
    const net = (db.totalProfit || 0) - (db.totalLoss || 0);
    msg.reply(`💹 *PNL Summary*
📈 Profit: $${(db.totalProfit || 0).toFixed(2)}
📉 Loss: $${(db.totalLoss || 0).toFixed(2)}
📊 Net: $${net.toFixed(2)} ${net >= 0 ? "🟢" : "🔴"}`);
  }

  // Set mode entry agresif/konservatif
  else if (txt.startsWith("!mode ")) {
    const mode = txt.split(" ")[1];
    if (["agresif", "konservatif"].includes(mode)) {
      db.entryMode = mode;
      saveDB();
      msg.reply(`✅ Mode entry diatur ke *${mode.toUpperCase()}*`);
    } else {
      msg.reply("⚠️ Pilih mode: `!mode agresif` atau `!mode konservatif`");
    }
  }
});

client.initialize();

app.get("/qr", async (req, res) => {
  if (isReady) {
    return res.send(
      `<html><body><div style="font-family:sans-serif;padding:20px;text-align:center;font-size:1.5rem;color:green;">✅ WhatsApp sudah terhubung.</div></body></html>`
    );
  }
  if (!currentQR) return res.send("⏳ Menunggu QR code tersedia...");
  const qrImage = await QRCode.toDataURL(currentQR);
  res.send(`
    <html><body style="text-align:center;font-family:sans-serif">
      <h1>Scan QR WhatsApp</h1>
      <img src="${qrImage}" style="width:90%;max-width:300px;border:10px solid #fff;box-shadow:0 0 10px #aaa;border-radius:8px;" />
      <p>⏳ Halaman ini auto-refresh tiap 15 detik</p>
      <meta http-equiv="refresh" content="15" />
    </body></html>
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
    if (type === "long") db.winCountLong++;
    else db.winCountShort++;
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

const calcFloatingPnl = async (type) => {
  const key = type === "long" ? "positionLong" : "positionShort";
  const position = db[key];
  if (!position) return null;

  const price = await getPrice();
  const entry = position.entry;
  const amount = position.amount;
  const diff = type === "long" ? price - entry : entry - price;
  const pnl = diff * amount;

  return pnl;
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
  const prevPrevCandle = ohlcv[ohlcv.length - 3];

  const candleBody = Math.abs(prevCandle[4] - prevCandle[1]);
  const candleRange = prevCandle[2] - prevCandle[3];
  const isStrongCandle = candleBody / candleRange >= 0.4;
  const candleUp = prevCandle[4] > prevCandle[1];
  const candleDown = prevCandle[4] < prevCandle[1];
  const price = ohlcv.at(-1)[4];

  // Engulfing pattern
  const isBullishEngulfing =
    prevPrevCandle[1] > prevPrevCandle[4] &&
    prevCandle[1] < prevCandle[4] &&
    prevCandle[1] < prevPrevCandle[4] &&
    prevCandle[4] > prevPrevCandle[1];

  const isBearishEngulfing =
    prevPrevCandle[1] < prevPrevCandle[4] &&
    prevCandle[1] > prevCandle[4] &&
    prevCandle[1] > prevPrevCandle[4] &&
    prevCandle[4] < prevPrevCandle[1];

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

  const canLong = (() => {
    if (db.entryMode === "agresif") {
      return (
        (scoreLong >= 3 || (scoreLong >= 2 && isBullishEngulfing)) &&
        price > ma200
      );
    } else {
      return scoreLong >= 4 && price > ma200 && isBullishEngulfing;
    }
  })();

  const canShort = (() => {
    if (db.entryMode === "agresif") {
      return (
        (scoreShort >= 3 || (scoreShort >= 2 && isBearishEngulfing)) &&
        price < ma200
      );
    } else {
      return scoreShort >= 4 && price < ma200 && isBearishEngulfing;
    }
  })();

  return { canLong, canShort };
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

  if (amountUSDT < 5) {
    console.log("❌ Order terlalu kecil (<$5), dilewati.");
    return;
  }

  const ticker = await exchange.fetchTicker(db.pair);
  const price = ticker.last;

  // 🔍 Spread Filter
  const spread = (ticker.ask - ticker.bid) / ticker.last;
  if (spread > 0.003) {
    console.log(
      `⚠️ SPREAD terlalu tinggi (${(spread * 100).toFixed(2)}%), skip entry.`
    );
    return;
  }

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

  const { entry, trailingActive, trailingStop, entryTime, amount, usedUSDT } =
    position;
  const holdMins = mins(now() - entryTime);

  const pnlUSD =
    type === "long" ? (price - entry) * amount : (entry - price) * amount;

  // 🔁 ROI berdasarkan margin aktual: notional / leverage
  const notional = entry * amount;
  const margin = notional / db.leverage;
  const roi = pnlUSD / margin;

  const timeExpired = holdMins >= MAX_HOLD_MINUTES;
  const ROI_TP = TP_PERCENT;
  const ROI_SL = SL_PERCENT;

  // ❌ Stop Loss by ROI
  if (roi <= -ROI_SL) {
    db[key] = null;
    db[lossKey]++;
    saveDB();
    sendMsg(
      `⚠️ ${type.toUpperCase()} STOP LOSS hit @ ${price} (ROI ${(
        roi * 100
      ).toFixed(2)}%)`
    );
    logTrade(type, entry, "-", "-", price, "sl_hit", amount, usedUSDT);
    updatePnL(type, entry, price, amount, "sl_hit");
    return;
  }

  // ⏱ Timeout
  if (timeExpired) {
    db[key] = null;
    db[lossKey]++;
    saveDB();
    sendMsg(`⌛ ${type.toUpperCase()} auto-close (timeout) @ ${price}`);
    logTrade(type, entry, "-", "-", price, "cut_timeout", amount, usedUSDT);
    updatePnL(type, entry, price, amount, "cut_timeout");
    return;
  }

  // 🎯 Activate Trailing
  if (!trailingActive && roi >= ROI_TP) {
    position.trailingActive = true;
    position.trailingStop =
      type === "long"
        ? price * (1 - db.trailingOffset)
        : price * (1 + db.trailingOffset);
    saveDB();
    sendMsg(
      `🎯 ${type.toUpperCase()} ROI > ${(ROI_TP * 100).toFixed(
        2
      )}%. Trailing ON @ ${price}`
    );
    return;
  }

  // 🏁 Trailing Exit
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
      logTrade(type, entry, "-", "-", price, "trailing_exit", amount, usedUSDT);
      updatePnL(type, entry, price, amount, "trailing_exit");
    } else {
      position.trailingStop =
        type === "long"
          ? Math.max(position.trailingStop, price * (1 - db.trailingOffset))
          : Math.min(position.trailingStop, price * (1 + db.trailingOffset));
      saveDB();
    }
  }
};

const forceClose = async (type, reason = "manual_close") => {
  const key = type === "long" ? "positionLong" : "positionShort";
  const position = db[key];
  if (!position) return;

  const price = await getPrice();
  const { entry, amount, usedUSDT } = position;

  db[key] = null;
  saveDB();

  sendMsg(`🔁 ${type.toUpperCase()} closed (switch signal) @ ${price}`);
  logTrade(type, entry, "-", "-", price, reason, amount, usedUSDT);
  updatePnL(type, entry, price, amount, reason);
};

// Eksekusi bot tiap 1 menit
setInterval(async () => {
  try {
    await checkTP_SL("long");
    await checkTP_SL("short");
    const day = new Date(new Date().getTime() + 7 * 60 * 60 * 1000).getDay();
    if (day === 6 || day === 0) {
      console.log("⛔ Weekend detected (Saturday/Sunday). Trading skipped.");
      return;
    }
    const { canLong, canShort } = await analyzeSignal();

    const nowTime = now();

    if (canLong && db.positionShort) {
      console.log(
        "🔁 Sinyal LONG muncul saat SHORT terbuka → Close SHORT & ganti ke LONG"
      );
      await forceClose("short", "switch_to_long");
      await openPosition("long");
      return;
    }

    if (canShort && db.positionLong) {
      console.log(
        "🔁 Sinyal SHORT muncul saat LONG terbuka → Close LONG & ganti ke SHORT"
      );
      await forceClose("long", "switch_to_short");
      await openPosition("short");
      return;
    }

    const readyLong =
      !db.positionLong &&
      nowTime - db.lastLongEntryTime >= COOLDOWN_MINUTES * 60 * 1000 &&
      db.lossCountLong < LOSS_LIMIT;

    const readyShort =
      !db.positionShort &&
      nowTime - db.lastShortEntryTime >= COOLDOWN_MINUTES * 60 * 1000 &&
      db.lossCountShort < LOSS_LIMIT;

    if (canLong && readyLong) await openPosition("long");
    if (canShort && readyShort) await openPosition("short");
  } catch (e) {
    console.log("⚠️ Bot error:", e.message);
  }
}, 60 * 1000); // per menit
