// signal.js
require("dotenv").config();
const fs = require("fs");
const ccxt = require("ccxt");
const { RSI, EMA, MACD, ADX } = require("technicalindicators");
const { Client, LocalAuth } = require("whatsapp-web.js");
const express = require("express");
const QRCode = require("qrcode");

// -------------------- CONFIG --------------------
const app = express();
const dbPath = "./db.json";
const logPath = "./log.csv";
const serverPort = 7890;

const COOLDOWN_MINUTES = 5;
const USDT_PER_TRADE = 5;
const DEFAULT_LEVERAGE = 10;
const DEFAULT_MARGIN_MODE = "ISOLATED";

// -------------------- FILE INIT --------------------
if (!fs.existsSync(logPath)) {
  fs.writeFileSync(logPath, "timestamp,pair,type,entry,tp,sl,status\n");
  console.log("📝 Log file dibuat:", logPath);
}

const db = fs.existsSync(dbPath)
  ? JSON.parse(fs.readFileSync(dbPath))
  : { pair: "XRP/USDT:USDT", lastLongEntryTime: 0, lastShortEntryTime: 0 };

console.log(`⚙️ Pair aktif: ${db.pair}`);

// -------------------- EXCHANGE --------------------
const exchange = new ccxt.binance({
  apiKey: process.env.API_KEY,
  secret: process.env.API_SECRET,
  options: { defaultType: "future" },
});

(async () => {
  try {
    await exchange.loadMarkets();
    console.log("📊 Markets loaded.");
  } catch (err) {
    console.error("❌ Gagal load markets:", err.message);
  }
})();

// -------------------- WHATSAPP --------------------
let currentQR = null;
let isReady = false;

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: process.env.PUPPETEER_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  },
});

app.listen(serverPort, () => console.log(`🟢 QR Server: http://localhost:${serverPort}/qr`));

client.on("qr", (qr) => {
  currentQR = qr;
  isReady = false;
  console.log("📲 QR baru siap discan.");
});

client.on("ready", () => {
  isReady = true;
  currentQR = null;
  console.log("✅ WhatsApp ready.");
});

client.on("disconnected", (reason) => {
  console.log("❌ WhatsApp disconnected:", reason);
  process.exit();
});

client.on("message", async (msg) => {
  if (!msg.from.includes(process.env.ADMIN_PHONE)) return;
  const txt = msg.body.toLowerCase();
  const [cmd, ...args] = txt.split(" ");
  if (cmd === "!pair") {
    const newPair = args[0]?.toUpperCase();
    if (!newPair) return msg.reply("⚠️ Format: !pair BTC/USDT:USDT");
    db.pair = newPair;
    db.lastLongEntryTime = 0;
    db.lastShortEntryTime = 0;
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
    console.log(`🔄 Pair diganti ke ${db.pair}`);
    msg.reply(`✅ Pair diganti ke *${db.pair}*`);
  }
});

client.initialize();

app.get("/qr", async (req, res) => {
  if (isReady) return res.send("✅ WhatsApp sudah connect.");
  if (!currentQR) return res.send("⏳ Tunggu QR...");
  const qrImage = await QRCode.toDataURL(currentQR);
  res.send(`<img src="${qrImage}" width="300" />`);
});

// -------------------- UTIL --------------------
const saveDB = () => fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
const mins = (ms) => ms / 1000 / 60;

const sendMsg = async (text) => {
  try {
    const chats = await client.getChats();
    const chat = chats.find((c) => !c.isGroup && c.id.user.includes(process.env.ADMIN_PHONE));
    if (chat) {
      await chat.sendMessage(text);
      console.log("📤 WA terkirim:", text.replace(/\n/g, " | "));
    }
  } catch (err) {
    console.error("❌ WA send error:", err.message);
  }
};

const formatPrice = (price, pair = db.pair) => {
  if (!price || !isFinite(price)) return "N/A";
  const market = exchange.markets[pair];
  let decimals = market?.precision?.price ?? 5;
  if (decimals <= 0) decimals = 5;
  if (price < 1 && decimals < 5) decimals = 5;
  return price.toFixed(decimals);
};

const getPrice = async () => {
  try {
    const t = await exchange.fetchTicker(db.pair);
    console.log("💰 Harga:", formatPrice(t.last));
    return t.last;
  } catch (e) {
    console.error("❌ Price error:", e.message);
    return null;
  }
};

const calcQty = (price) => {
  if (!price) return 0;
  let qty = USDT_PER_TRADE / price;
  const prec = exchange.markets[db.pair]?.precision?.amount ?? 3;
  qty = parseFloat(qty.toFixed(prec));
  console.log(`📐 Qty dihitung: ${qty} (${USDT_PER_TRADE} USDT / ${price})`);
  return qty;
};

const hasOpenPosition = async () => {
  try {
    const bal = await exchange.fetchBalance();
    const pos = bal.info?.positions?.find((p) => p.symbol === db.pair.replace("/", ""));
    const open = pos && parseFloat(pos.positionAmt) !== 0;
    console.log(`📌 Cek posisi terbuka: ${open ? "ADA" : "TIDAK ADA"}`);
    return open;
  } catch (err) {
    console.error("❌ Cek posisi error:", err.message);
    return false;
  }
};

const logSignal = (type, entry, tp, sl, status = "SIGNAL_SENT") => {
  const timestamp = new Date().toISOString();
  const line = `${timestamp},${db.pair},${type},${entry},${tp},${sl},${status}\n`;
  fs.appendFileSync(logPath, line);
  console.log(`📝 Log: ${line.trim()}`);
};

// -------------------- ORDER --------------------
const placeOrder = async (side, tp, sl) => {
  if (await hasOpenPosition()) {
    console.log("⚠️ Masih ada posisi, skip order.");
    await sendMsg(`⚠️ ${db.pair}: masih ada posisi terbuka, order ${side} dibatalkan.`);
    return;
  }
  const price = await getPrice();
  const qty = calcQty(price);

  console.log(`➡️ ENTRY ${side.toUpperCase()} | Qty=${qty} | Entry=${formatPrice(price)} | TP=${formatPrice(tp)} | SL=${formatPrice(sl)}`);

  try {
    await exchange.setLeverage(DEFAULT_LEVERAGE, db.pair);
    await exchange.setMarginMode(DEFAULT_MARGIN_MODE, db.pair);
  } catch (e) {
    console.warn("⚠️ Leverage/margin mode error:", e.message);
  }

  await exchange.createOrder(db.pair, "market", side, qty);
  console.log("✅ Entry Market Order dibuat.");

  if (side === "buy") {
    await exchange.createOrder(db.pair, "TAKE_PROFIT_MARKET", "sell", qty, undefined, { stopPrice: tp, reduceOnly: true });
    await exchange.createOrder(db.pair, "STOP_MARKET", "sell", qty, undefined, { stopPrice: sl, reduceOnly: true });
  } else {
    await exchange.createOrder(db.pair, "TAKE_PROFIT_MARKET", "buy", qty, undefined, { stopPrice: tp, reduceOnly: true });
    await exchange.createOrder(db.pair, "STOP_MARKET", "buy", qty, undefined, { stopPrice: sl, reduceOnly: true });
  }

  console.log("🎯 TP & SL order dipasang.");
  await sendMsg(`✅ Order ${side.toUpperCase()} ${db.pair}\nQty: ${qty}\n🎯 TP: ${tp}\n🛑 SL: ${sl}`);
  logSignal(side === "buy" ? "LONG" : "SHORT", price, tp, sl, "ORDER_PLACED");
};

// -------------------- ANALYSIS --------------------
const analyzeSignal = async () => {
  const ohlcv = await exchange.fetchOHLCV(db.pair, "15m", undefined, 200);
  const close = ohlcv.map((c) => c[4]);
  const high = ohlcv.map((c) => c[2]);
  const low = ohlcv.map((c) => c[3]);

  const rsi = RSI.calculate({ values: close.slice(-50), period: 14 }).pop();
  const ema20 = EMA.calculate({ values: close.slice(-50), period: 20 }).pop();
  const ema50 = EMA.calculate({ values: close.slice(-50), period: 50 }).pop();
  const ma200 = EMA.calculate({ values: close, period: 200 }).pop();
  const macd = MACD.calculate({ values: close.slice(-50), fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }).pop();
  const adx = ADX.calculate({ close: close.slice(-50), high: high.slice(-50), low: low.slice(-50), period: 14 }).pop();

  const price = close.at(-1);
  const prev = ohlcv.at(-2);
  const prev2 = ohlcv.at(-3);

  const isBullishEngulf = prev2[1] > prev2[4] && prev[1] < prev[4] && prev[1] < prev2[4] && prev[4] > prev2[1];
  const isBearishEngulf = prev2[1] < prev2[4] && prev[1] > prev[4] && prev[1] > prev2[4] && prev[4] < prev2[1];

  let scoreLong = 0;
  if (rsi < 35) scoreLong++;
  if (macd?.histogram > 0) scoreLong++;
  if (ema20 > ema50) scoreLong++;
  if (adx?.adx > 20) scoreLong++;
  if (isBullishEngulf) scoreLong += 2;

  let scoreShort = 0;
  if (rsi > 65) scoreShort++;
  if (macd?.histogram < 0) scoreShort++;
  if (ema20 < ema50) scoreShort++;
  if (adx?.adx > 20) scoreShort++;
  if (isBearishEngulf) scoreShort += 2;

  const targetLong = Math.max(...high.slice(-10));
  const stopLossLong = Math.min(...low.slice(-5));
  const targetShort = Math.min(...low.slice(-10));
  const stopLossShort = Math.max(...high.slice(-5));

  console.log(`📊 ANALISA ${db.pair} | Price=${formatPrice(price)} | RSI=${rsi?.toFixed(2)} | EMA20=${ema20} | EMA50=${ema50} | MA200=${ma200} | MACD=${macd?.histogram?.toFixed(4)} | ADX=${adx?.adx?.toFixed(2)} | ScoreLong=${scoreLong} | ScoreShort=${scoreShort}`);

  return {
    canLong: scoreLong >= 3 && price > ma200 && isBullishEngulf,
    canShort: scoreShort >= 3 && price < ma200 && isBearishEngulf,
    targetLong,
    stopLossLong,
    targetShort,
    stopLossShort,
    price,
  };
};

// -------------------- MAIN LOOP --------------------
setInterval(async () => {
  try {
    const now = Date.now();
    const sig = await analyzeSignal();
    if (!sig.price) return;

    const readyLong = !db.lastLongEntryTime || mins(now - db.lastLongEntryTime) >= COOLDOWN_MINUTES;
    const readyShort = !db.lastShortEntryTime || mins(now - db.lastShortEntryTime) >= COOLDOWN_MINUTES;

    if (sig.canLong && readyLong) {
      console.log("🚀 SINYAL LONG TERDETEKSI");
      db.lastLongEntryTime = now;
      saveDB();
      await placeOrder("buy", sig.targetLong, sig.stopLossLong);
    }

    if (sig.canShort && readyShort) {
      console.log("📉 SINYAL SHORT TERDETEKSI");
      db.lastShortEntryTime = now;
      saveDB();
      await placeOrder("sell", sig.targetShort, sig.stopLossShort);
    }
  } catch (e) {
    console.error("⚠️ Loop error:", e.message);
    console.error(e.stack);
  }
}, 10000);
