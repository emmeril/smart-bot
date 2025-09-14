// done.js
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

const COOLDOWN_MINUTES = 1;

// -------------------- FILE INIT --------------------
if (!fs.existsSync(logPath)) {
  fs.writeFileSync(logPath, "timestamp,pair,type,entry,tp,sl,status\n");
  log("SYSTEM", "File log.csv dibuat.");
}

const db = fs.existsSync(dbPath)
  ? JSON.parse(fs.readFileSync(dbPath))
  : { 
      pair: "XRP/USDT:USDT", 
      lastLongEntryTime: 0, 
      lastShortEntryTime: 0,
      leverage: 10,
      marginMode: "ISOLATED",
      activePosition: null,
      usdtPerTrade: 5.1 
    };

let prevPosAmt = 0;

log("SYSTEM", `Pair: ${db.pair} | Lev: ${db.leverage}x | Mode: ${db.marginMode} | USDT/trade: ${db.usdtPerTrade}`);

// -------------------- LOGGER --------------------
const log = (tag, msg) => {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${tag}] ${ts} - ${msg}`);
};

// -------------------- FORMAT WA --------------------
const formatMsg = (title, data) => {
  let msg = `✅ ${title}\n\n`;
  for (const [k, v] of Object.entries(data)) {
    msg += `${k.padEnd(7)}: ${v}\n`;
  }
  return msg.trim();
};

// -------------------- EXCHANGE --------------------
const exchange = new ccxt.binance({
  apiKey: process.env.API_KEY,
  secret: process.env.API_SECRET,
  options: { defaultType: "future" },
});

(async () => {
  try {
    await exchange.loadMarkets();
    log("EXCHANGE", "Markets berhasil dimuat.");
  } catch (err) {
    log("EXCHANGE", `Gagal memuat markets: ${err.message}`);
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

app.listen(serverPort, () => log("SERVER", `QR server aktif di http://localhost:${serverPort}/qr`));

client.on("qr", (qr) => {
  currentQR = qr;
  isReady = false;
  log("WA", "QR baru siap discan.");
});

client.on("ready", () => {
  isReady = true;
  currentQR = null;
  log("WA", "Koneksi berhasil.");
});

client.on("disconnected", (reason) => {
  log("WA", `Terputus, bot dimatikan. ${reason}`);
  process.exit();
});

// -------------------- DB & UTILS --------------------
const saveDB = () => fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
const mins = (ms) => ms / 1000 / 60;

const sendMsg = async (text) => {
  try {
    const chats = await client.getChats();
    const chat = chats.find((c) => !c.isGroup && c.id.user.includes(process.env.ADMIN_PHONE));
    if (chat) {
      await chat.sendMessage(text);
      log("WA", "Pesan terkirim.");
    }
  } catch (err) {
    log("WA", `Gagal kirim pesan: ${err.message}`);
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
    return t.last;
  } catch (e) {
    log("DATA", `Gagal ambil harga: ${e.message}`);
    return null;
  }
};

const calcQty = (price) => {
  if (!price) return 0;
  let qty = db.usdtPerTrade / price;
  const prec = exchange.markets[db.pair]?.precision?.amount ?? 3;
  return parseFloat(qty.toFixed(prec));
};

// ---------- NEW HELPERS: market id & position fetch ----------
const getMarketId = () => {
  try {
    const market = exchange.markets[db.pair];
    if (market && market.id) return market.id; // e.g. "XRPUSDT"
  } catch {}
  return db.pair.replace("/", "").replace(":", "");
};

const getPositionFromBalance = async () => {
  try {
    const bal = await exchange.fetchBalance();
    const marketId = getMarketId();
    const positions = bal.info?.positions || [];
    let found = positions.find(p => p.symbol === marketId || (p.symbol && p.symbol.includes(marketId)));
    return { balance: bal, position: found };
  } catch (err) {
    log("HELPER", `Gagal ambil posisi: ${err.message}`);
    return { balance: null, position: null };
  }
};

// -------------------- ORDER --------------------
const placeOrder = async (side, tp, sl) => {
  if (db.activePosition) {
    await sendMsg(`⚠️ Masih ada posisi dimonitor. Order ${side.toUpperCase()} dibatalkan.`);
    return;
  }

  const { position } = await getPositionFromBalance();
  const amt = parseFloat(position?.positionAmt || "0");
  if (Math.abs(amt) > 0) {
    await sendMsg(`⚠️ Terdeteksi posisi aktif di akun. Order ${side.toUpperCase()} dibatalkan.`);
    return;
  }

  const price = await getPrice();
  if (!price) return;
  const qty = calcQty(price);

  log("ORDER", `${side.toUpperCase()} ${db.pair} @${formatPrice(price)} | TP:${formatPrice(tp)} SL:${formatPrice(sl)} Qty:${qty}`);

  try {
    await exchange.setLeverage(db.leverage, db.pair);
    await exchange.setMarginMode(db.marginMode, db.pair);
  } catch (e) {
    log("ORDER", `Gagal set leverage/margin: ${e.message}`);
  }
  
  try {
    const order = await exchange.createOrder(db.pair, "market", side, qty);
    db.activePosition = { side, entryPrice: price, tp, sl, orderId: order.id };
    saveDB();

    await sendMsg(formatMsg("ORDER TERKIRIM", {
      Pair: db.pair,
      Tipe: side.toUpperCase(),
      Entry: formatPrice(price),
      TP: formatPrice(tp),
      SL: formatPrice(sl),
      Lev: `${db.leverage}x (${db.marginMode})`
    }));
  } catch (e) {
    await sendMsg(`❌ Gagal order ${side.toUpperCase()}: ${e.message}`);
  }
};

const closePosition = async (reason, entryPrice = "N/A") => {
  try {
    const { position } = await getPositionFromBalance();
    const qty = parseFloat(position?.positionAmt || "0");

    if (Math.abs(qty) > 0) {
      const side = qty > 0 ? "sell" : "buy";
      await exchange.createOrder(db.pair, "market", side, Math.abs(qty), undefined, { reduceOnly: true });
      const exitPrice = await getPrice();
      await sendMsg(formatMsg("POSISI DITUTUP", {
        Pair: db.pair,
        Sebab: reason,
        Entry: formatPrice(entryPrice),
        Exit: formatPrice(exitPrice)
      }));
    }
  } catch (err) {
    await sendMsg(`❌ Gagal menutup posisi: ${err.message}`);
  } finally {
    db.activePosition = null;
    saveDB();
  }
};

// -------------------- CEK POSISI --------------------
const checkPositionStatus = async () => {
  try {
    const { position } = await getPositionFromBalance();
    const amt = parseFloat(position?.positionAmt || "0");
    const amtSafe = isFinite(amt) ? amt : 0;

    const prevSafe = isFinite(prevPosAmt) ? prevPosAmt : 0;
    if (prevSafe !== 0 && amtSafe === 0) {
      const side = prevSafe > 0 ? "LONG" : "SHORT";
      await sendMsg(`📉 Posisi ${side} di ${db.pair} sudah ditutup manual.`);
      db.activePosition = null;
      saveDB();
    }

    if (db.activePosition && amtSafe !== 0) {
      const { tp, sl, side, entryPrice } = db.activePosition;
      const currentPrice = await getPrice();
      if (!currentPrice) return;

      if (side === "buy") {
        if (currentPrice >= tp) await closePosition("TP tercapai", entryPrice);
        else if (currentPrice <= sl) await closePosition("SL tercapai", entryPrice);
      } else {
        if (currentPrice <= tp) await closePosition("TP tercapai", entryPrice);
        else if (currentPrice >= sl) await closePosition("SL tercapai", entryPrice);
      }
    }

    prevPosAmt = amtSafe;
  } catch (err) {
    log("POSISI", `Gagal cek posisi: ${err.message}`);
  }
};

// -------------------- ANALYSIS --------------------
const analyzeSignal = async () => {
  const ohlcv = await exchange.fetchOHLCV(db.pair, "15m", undefined, 200);
  if (!ohlcv || ohlcv.length < 200) return {};

  const close = ohlcv.map(c => c[4]);
  const high = ohlcv.map(c => c[2]);
  const low = ohlcv.map(c => c[3]);

  const rsi = RSI.calculate({ values: close.slice(-50), period: 14 }).pop();
  const ema20 = EMA.calculate({ values: close.slice(-50), period: 20 }).pop();
  const ema50 = EMA.calculate({ values: close.slice(-50), period: 50 }).pop();
  const ma200 = EMA.calculate({ values: close, period: 200 }).pop();
  const macd = MACD.calculate({ values: close.slice(-50), fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }).pop();
  const adx = ADX.calculate({ close: close.slice(-50), high: high.slice(-50), low: low.slice(-50), period: 14 }).pop();

  const price = close.at(-1);
  const isAboveMA200 = price > ma200;
  const isBelowMA200 = price < ma200;

  let scoreLong = 0;
  if (rsi < 35) scoreLong++;
  if (macd?.histogram > 0) scoreLong++;
  if (ema20 > ema50) scoreLong++;
  if (adx?.adx > 20) scoreLong++;

  let scoreShort = 0;
  if (rsi > 65) scoreShort++;
  if (macd?.histogram < 0) scoreShort++;
  if (ema20 < ema50) scoreShort++;
  if (adx?.adx > 20) scoreShort++;

  return {
    canLong: scoreLong >= 3 && isAboveMA200,
    canShort: scoreShort >= 3 && isBelowMA200,
    targetLong: Math.max(...high.slice(-20)),
    stopLossLong: Math.min(...low.slice(-20)),
    targetShort: Math.min(...low.slice(-20)),
    stopLossShort: Math.max(...high.slice(-20)),
    price,
  };
};

// -------------------- MAIN LOOP --------------------
setInterval(async () => {
  try {
    await checkPositionStatus();

    if (db.activePosition === null) {
      const now = Date.now();
      const sig = await analyzeSignal();
      if (!sig.price) return;

      const readyLong = !db.lastLongEntryTime || mins(now - db.lastLongEntryTime) >= COOLDOWN_MINUTES;
      const readyShort = !db.lastShortEntryTime || mins(now - db.lastShortEntryTime) >= COOLDOWN_MINUTES;
      
      if (sig.canLong && readyLong) {
        db.lastLongEntryTime = now;
        saveDB();
        await placeOrder("buy", sig.targetLong, sig.stopLossLong);
      }

      if (sig.canShort && readyShort) {
        db.lastShortEntryTime = now;
        saveDB();
        await placeOrder("sell", sig.targetShort, sig.stopLossShort);
      }
    }
  } catch (e) {
    log("LOOP", `Error: ${e.message}`);
  }
}, 10000);

// -------------------- QR WEB --------------------
app.get("/qr", async (req, res) => {
  if (isReady) return res.send("✅ WhatsApp sudah terhubung.");
  if (!currentQR) return res.send("⏳ Tunggu... QR code sedang dibuat.");
  const qrImage = await QRCode.toDataURL(currentQR);
  res.send(`<img src="${qrImage}" width="300" />`);
});

client.initialize();
