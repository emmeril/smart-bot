require("dotenv").config();
const fs = require("fs");
const path = require("path");
const ccxt = require("ccxt");
const { RSI, EMA, MACD, ADX } = require("technicalindicators");
const { Client, LocalAuth } = require("whatsapp-web.js");
const express = require("express");
const QRCode = require("qrcode");

console.log("🚀 Memulai bot sinyal...");

// -----------------------------------------------------------------------------
// 1. KONSTANTA & KONFIGURASI
// -----------------------------------------------------------------------------
const app = express();
const dbPath = "./db.json";
const logPath = "./log.csv";
const serverPort = 7890;

const COOLDOWN_MINUTES = 5;

// Pastikan file log ada
if (!fs.existsSync(logPath)) {
  fs.writeFileSync(
    logPath,
    "timestamp,pair,type,entryPrice,tp,sl,status\n"
  );
  console.log(`📝 File log baru dibuat di: ${logPath}`);
}

// -----------------------------------------------------------------------------
// 2. INITIALISASI
// -----------------------------------------------------------------------------
const db = fs.existsSync(dbPath)
  ? JSON.parse(fs.readFileSync(dbPath))
  : {
      pair: "XRP/USDT:USDT",
      lastLongEntryTime: 0,
      lastShortEntryTime: 0,
    };

console.log(`⚙️ Menggunakan pair dari db.json: ${db.pair}`);

const exchange = new ccxt.binance({
  options: { defaultType: "future" },
});

// load markets biar precision tersedia
(async () => {
  try {
    await exchange.loadMarkets();
    console.log("📊 Markets loaded, precision siap dipakai.");
  } catch (err) {
    console.error("❌ Gagal load markets:", err.message);
  }
})();

let currentQR = null;
let isReady = false;

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: "/usr/bin/chromium",
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  },
});

app.listen(serverPort, () =>
  console.log(`🟢 Server QR code berjalan di http://localhost:${serverPort}`)
);

// -----------------------------------------------------------------------------
// 3. FUNGSI UTILITAS
// -----------------------------------------------------------------------------
const saveDB = () => fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
const now = () => Date.now();
const mins = (ms) => ms / 1000 / 60;

const formatPrice = (price, pair = db.pair) => {
  if (typeof price !== "number" || !isFinite(price)) return "N/A";

  // fallback kalau market belum loaded
  if (!exchange.markets || Object.keys(exchange.markets).length === 0) {
    return price.toFixed(5);
  }

  const market = exchange.markets[pair];
  let decimals = market?.precision?.price ?? 5;

  // jika precision terlalu kecil untuk harga < 1, pakai minimal 5 desimal
  if (price < 1 && decimals < 5) decimals = 5;

  // kalau precision = 0, fallback juga
  if (decimals <= 0) decimals = 5;

  return price.toFixed(decimals);
};


const sendMsg = async (text) => {
  try {
    const chats = await client.getChats();
    const adminPhone = process.env.ADMIN_PHONE;
    if (!adminPhone) {
      console.error("ADMIN_PHONE tidak terdefinisi di .env");
      return;
    }
    const chat = chats.find(
      (c) => c.isGroup === false && c.id.user.includes(adminPhone)
    );
    if (chat) {
      await chat.sendMessage(text);
      console.log("✅ Pesan WhatsApp terkirim.");
    }
  } catch (err) {
    console.error("❌ Gagal mengirim pesan WA:", err.message);
  }
};

const getPrice = async () => {
  try {
    const ticker = await exchange.fetchTicker(db.pair);
    return ticker.last;
  } catch (e) {
    console.error("❌ Gagal fetch harga:", e.message);
    return null;
  }
};

const logSignal = (type, entry, tp, sl) => {
  const timestamp = new Date().toISOString();
  const logLine = `${timestamp},${db.pair},${type},${entry},${tp},${sl},SIGNAL_SENT\n`;
  fs.appendFileSync(logPath, logLine);
  console.log(`✅ Sinyal tercatat ke ${logPath}`);
};

// -----------------------------------------------------------------------------
// 4. WA CLIENT
// -----------------------------------------------------------------------------
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
  try {
    const txt = msg.body.toLowerCase();
    if (!msg.fromMe && !msg.from.includes(process.env.ADMIN_PHONE)) return;

    // Command handling
    const [command, ...args] = txt.split(" ");
    switch (command) {
      case "!pair": {
        const newPair = args[0]?.toUpperCase();
        if (!newPair) {
          console.log("⚠️ WA Command: Format salah.");
          return msg.reply("⚠️ Format salah. Contoh: !pair BTC/USDT:USDT");
        }
        db.pair = newPair;
        db.lastLongEntryTime = 0;
        db.lastShortEntryTime = 0;
        saveDB();
        console.log(`✅ WA Command: Pair diubah ke ${db.pair}`);
        msg.reply(`✅ Pair diubah ke *${db.pair}*.`);
        break;
      }
      case "!status": {
        const price = await getPrice();
        const cooldownLong = db.lastLongEntryTime
          ? Math.round(mins(now() - db.lastLongEntryTime)) + "m"
          : "Belum pernah sinyal";
        const cooldownShort = db.lastShortEntryTime
          ? Math.round(mins(now() - db.lastShortEntryTime)) + "m"
          : "Belum pernah sinyal";
        
        console.log("📊 WA Command: Meminta status bot.");
        msg.reply(`📊 *Status Bot Sinyal*
📌 Pair: *${db.pair}*
📈 Harga Saat Ini: *${price ? formatPrice(price) : "N/A"}*
---
📈 *LONG*
⏱ Cooldown: ${cooldownLong}

📉 *SHORT*
⏱ Cooldown: ${cooldownShort}`);
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error("❌ WA Command Error:", err.message);
    msg.reply("⚠️ Terjadi error saat memproses perintah.");
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

// -----------------------------------------------------------------------------
// 5. LOGIKA INTI BOT (Optimasi)
// -----------------------------------------------------------------------------
const analyzeSignal = async () => {
  console.log("🔍 Menganalisis sinyal...");
  const ohlcv = await exchange.fetchOHLCV(db.pair, "15m", undefined, 200);

  if (!ohlcv || ohlcv.length < 200) {
    console.log("⚠️ Data OHLCV tidak mencukupi untuk analisis (diperlukan 200 candle).");
    return {};
  }
  
  const close = ohlcv.map((c) => c[4]);
  const high = ohlcv.map((c) => c[2]);
  const low = ohlcv.map((c) => c[3]);

  if (close.length < 200) {
    console.log(`⚠️ Data close tidak mencukupi. Length: ${close.length}.`);
    return {};
  }

  const rsi = RSI.calculate({ values: close.slice(-50), period: 14 }).pop();
  const ema20 = EMA.calculate({ values: close.slice(-50), period: 20 }).pop();
  const ema50 = EMA.calculate({ values: close.slice(-50), period: 50 }).pop();
  const ma200 = EMA.calculate({ values: close, period: 200 }).pop();
  const macd = MACD.calculate({ values: close.slice(-50), fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }).pop();
  const adx = ADX.calculate({ close: close.slice(-50), high: high.slice(-50), low: low.slice(-50), period: 14 }).pop();

  console.log(`Debug Indikator:
    RSI: ${isFinite(rsi) ? rsi : "N/A"}
    EMA20: ${isFinite(ema20) ? ema20 : "N/A"}
    EMA50: ${isFinite(ema50) ? ema50 : "N/A"}
    MA200: ${isFinite(ma200) ? ma200 : "N/A"}
    MACD Histogram: ${isFinite(macd?.histogram) ? macd.histogram : "N/A"}
    ADX: ${isFinite(adx?.adx) ? adx.adx : "N/A"}
  `);

  const price = close.at(-1);
  const prevCandle = ohlcv.at(-2);
  const prevPrevCandle = ohlcv.at(-3);

  const candleBody = Math.abs(prevCandle[4] - prevCandle[1]);
  const candleRange = prevCandle[2] - prevCandle[3];
  const isStrongCandle = candleBody / candleRange >= 0.4;
  const candleUp = prevCandle[4] > prevCandle[1];
  const candleDown = prevCandle[4] < prevCandle[1];

  const isBullishEngulfing =
    prevPrevCandle[1] > prevPrevCandle[4] &&
    prevCandle[1] < prevCandle[4] &&
    prevCandle[1] < prevPrevCandle[4] &&
    prevCandle[4] > prevPrevCandle[1];

  const isBearishEngulfing =
    prevPrevCandle[1] < prevPrevCandle[4] &&
    prevCandle[1] > prevCandle[4] &&
    prevCandle[1] > prevPrevCandle[4] &&
    prevCandle[4] < prevCandle[1];

  let scoreLong = 0;
  if (isFinite(rsi) && rsi < 35) scoreLong++;
  if (isFinite(macd?.histogram) && macd?.histogram > 0) scoreLong++;
  if (isFinite(ema20) && isFinite(ema50) && ema20 > ema50) scoreLong++;
  if (isFinite(adx?.adx) && adx?.adx > 20) scoreLong++;
  if (isStrongCandle && candleUp) scoreLong++;
  if (isBullishEngulfing) scoreLong += 2;

  let scoreShort = 0;
  if (isFinite(rsi) && rsi > 65) scoreShort++;
  if (isFinite(macd?.histogram) && macd?.histogram < 0) scoreShort++;
  if (isFinite(ema20) && isFinite(ema50) && ema20 < ema50) scoreShort++;
  if (isFinite(adx?.adx) && adx?.adx > 20) scoreShort++;
  if (isStrongCandle && candleDown) scoreShort++;
  if (isBearishEngulfing) scoreShort += 2;

  const high10 = Math.max(...high.slice(-10));
  const low10 = Math.min(...low.slice(-10));

  const targetLong = high10;
  const stopLossLong = Math.min(...low.slice(-5));
  const targetShort = low10;
  const stopLossShort = Math.max(...high.slice(-5));

  const canLong = scoreLong >= 3 && isFinite(price) && isFinite(ma200) && price > ma200 && isBullishEngulfing;
  const canShort = scoreShort >= 3 && isFinite(price) && isFinite(ma200) && price < ma200 && isBearishEngulfing;

  return { canLong, canShort, targetLong, stopLossLong, targetShort, stopLossShort, price, ma200, isBullishEngulfing, isBearishEngulfing, scoreLong, scoreShort };
};

// -----------------------------------------------------------------------------
// 6. EKSEKUSI UTAMA
// -----------------------------------------------------------------------------
setInterval(async () => {
  try {
    const nowTime = now();
    const result = await analyzeSignal();

    if (Object.keys(result).length === 0) {
      console.log("⏳ Analisis sinyal tidak dapat diselesaikan, menunggu data cukup.");
      return;
    }
    
    const { canLong, canShort, targetLong, stopLossLong, targetShort, stopLossShort, price, ma200, isBullishEngulfing, isBearishEngulfing, scoreLong, scoreShort } = result;

    if (!isFinite(price) || !isFinite(ma200)) {
      console.log("❌ Data harga atau MA200 tidak valid (NaN/Infinity). Menunggu data valid...");
      return;
    }

    console.log(`📊 Sinyal Analisis:
    LONG: ${canLong} (score ${scoreLong}, price ${formatPrice(price)} > MA200 ${formatPrice(ma200)}, engulfing ${isBullishEngulfing})
    SHORT: ${canShort} (score ${scoreShort}, price ${formatPrice(price)} < MA200 ${formatPrice(ma200)}, engulfing ${isBearishEngulfing})
    `);

    const readyLong = !db.lastLongEntryTime || mins(nowTime - db.lastLongEntryTime) >= COOLDOWN_MINUTES;
    const readyShort = !db.lastShortEntryTime || mins(nowTime - db.lastShortEntryTime) >= COOLDOWN_MINUTES;

    if (canLong && readyLong) {
      db.lastLongEntryTime = nowTime;
      saveDB();
      sendMsg(
        `🟢 *Sinyal LONG* untuk ${db.pair}\n` +
        `Entry: ${formatPrice(price)}\n` +
        `TP: ${formatPrice(targetLong)}\n` +
        `SL: ${formatPrice(stopLossLong)}`
      );
      logSignal("LONG", price, targetLong, stopLossLong);
    } else if (canLong && !readyLong) {
      console.log("⏳ Sinyal LONG terdeteksi, tapi masih dalam masa cooldown.");
    }

    if (canShort && readyShort) {
      db.lastShortEntryTime = nowTime;
      saveDB();
      sendMsg(
        `🔴 *Sinyal SHORT* untuk ${db.pair}\n` +
        `Entry: ${formatPrice(price)}\n` +
        `TP: ${formatPrice(targetShort)}\n` +
        `SL: ${formatPrice(stopLossShort)}`
      );
      logSignal("SHORT", price, targetShort, stopLossShort);
    } else if (canShort && !readyShort) {
      console.log("⏳ Sinyal SHORT terdeteksi, tapi masih dalam masa cooldown.");
    }
    
  } catch (e) {
    console.error("⚠️ Global Loop Error:", e.message);
    console.error(e.stack);
  }
}, 10 * 1000);
