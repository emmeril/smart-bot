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

db.tpPercent ??= 0.03;
db.slPercent ??= 0.02;
const COOLDOWN_MINUTES = 5;
const LOSS_LIMIT = 3;
const LOSS_WAIT_MINUTES = 15;
const MAX_HOLD_MINUTES = 1440;

const exchange = new ccxt.binance({
  apiKey: isBacktest ? undefined : process.env.API_KEY,
  secret: isBacktest ? undefined : process.env.API_SECRET,
  options: { defaultType: "future" },
});

const saveDB = () => fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
const now = () => Date.now();
const mins = (ms) => ms / 1000 / 60;

let currentQR = null;
let isReady = false;

// Inisialisasi WhatsApp client

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
      const price = await getPrice();

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

      const trailingLong = db.positionLong?.trailingActive
        ? `\n🔁 Trailing aktif @ ${db.positionLong.trailingStop.toFixed(4)}`
        : "";

      const trailingShort = db.positionShort?.trailingActive
        ? `\n🔁 Trailing aktif @ ${db.positionShort.trailingStop.toFixed(4)}`
        : "";

      const posLong = db.positionLong
        ? `📍 Entry @ ${db.positionLong.entry.toFixed(4)}\n🎯 ROI TP: ${(
            db.tpPercent * 100
          ).toFixed(1)}% | SL: ${(db.slPercent * 100).toFixed(
            1
          )}%\n📊 Floating PnL: ${fltLong >= 0 ? "+" : "-"}$${Math.abs(
            fltLong
          ).toFixed(4)} (${roiLong}%)${trailingLong}`
        : "🚫 Belum ada";

      const posShort = db.positionShort
        ? `📍 Entry @ ${db.positionShort.entry.toFixed(4)}\n🎯 ROI TP: ${(
            db.tpPercent * 100
          ).toFixed(1)}% | SL: ${(db.slPercent * 100).toFixed(
            1
          )}%\n📊 Floating PnL: ${fltShort >= 0 ? "+" : "-"}$${Math.abs(
            fltShort
          ).toFixed(4)} (${roiShort}%)${trailingShort}`
        : "🚫 Belum ada";

      msg.reply(`📊 *Status Bot*
📌 Pair: *${db.pair}*
📈 Harga Saat Ini: *${price.toFixed(4)}*
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

    // Set balance %
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

    // Cek total PnL
    else if (txt === "!pnl") {
      const net = (db.totalProfit || 0) - (db.totalLoss || 0);
      msg.reply(`💹 *PNL Summary*
📈 Profit: $${(db.totalProfit || 0).toFixed(2)}
📉 Loss: $${(db.totalLoss || 0).toFixed(2)}
📊 Net: $${net.toFixed(2)} ${net >= 0 ? "🟢" : "🔴"}`);
    }

    // Set mode entry
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

    // Set TP ROI %
    else if (txt.startsWith("!tp ")) {
      const val = parseFloat(txt.split(" ")[1]);
      if (isNaN(val) || val < 0.5 || val > 20) {
        msg.reply("⚠️ Format salah. Contoh: !tp 5");
      } else {
        db.tpPercent = val / 100;
        saveDB();
        msg.reply(`✅ Take Profit diatur ke *${val}%* ROI.`);
      }
    }

    // Set SL ROI %
    else if (txt.startsWith("!sl ")) {
      const val = parseFloat(txt.split(" ")[1]);
      if (isNaN(val) || val < 0.5 || val > 10) {
        msg.reply("⚠️ Format salah. Contoh: !sl 2.5");
      } else {
        db.slPercent = val / 100;
        saveDB();
        msg.reply(`✅ Stop Loss diatur ke *${val}%* ROI.`);
      }
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

// Fungsi untuk menguji koneksi ke Binance
let isBinanceConnected = true;
let lastBinanceStatus = true;
let failCount = 0;
const MAX_FAIL = 3;

const testBinanceConnection = async () => {
  try {
    await exchange.fetchTime(); // ping Binance
    isBinanceConnected = true;
    failCount = 0;
  } catch (e) {
    isBinanceConnected = false;
    failCount++;
  }

  if (isBinanceConnected !== lastBinanceStatus) {
    if (isBinanceConnected) {
      console.log("✅ Reconnected to Binance.");
    } else {
      console.log("⚠️ Lost connection to Binance.");
    }
    lastBinanceStatus = isBinanceConnected;
  }

  if (failCount >= MAX_FAIL) {
    console.log("❌ Binance connection failed 3x berturut-turut. Exit & restart via PM2.");
    process.exit(1);
  }
};

// fungsi untuk mengirim pesan ke admin
const sendMsg = async (text) => {
  const chats = await client.getChats();
  const chat = chats.find(
    (c) => c.isGroup === false && c.id.user === process.env.ADMIN_PHONE
  );
  if (chat) chat.sendMessage(text);
};

// Fungsi untuk update PnL
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

// Fungsi untuk mencatat trade ke log
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

// Fungsi untuk mendapatkan harga terkini
const getPrice = async () => {
  const ticker = await exchange.fetchTicker(db.pair);
  return ticker.last;
};

// Fungsi untuk menghitung floating PnL
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

// Fungsi untuk menganalisis sinyal trading
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

  const leverage = db.leverage || 10;
  const tpPercent = db.tpPercent || 0.05;
  const slPercent = db.slPercent || 0.025;
  const margin = price / leverage;

  const potentialProfitLong = Math.max(ma200 - price, 0);
  const potentialLossLong = Math.max(price - ema20, 0);
  const potentialProfitShort = Math.max(price - ma200, 0);
  const potentialLossShort = Math.max(ema20 - price, 0);

  const roiProfitLong = (potentialProfitLong / margin) * 100;
  const roiLossLong = (potentialLossLong / margin) * 100;
  const roiProfitShort = (potentialProfitShort / margin) * 100;
  const roiLossShort = (potentialLossShort / margin) * 100;

  // ✅ Validasi hanya berdasarkan TP
  const validLong = potentialProfitLong >= tpPercent * margin;
  const validShort = potentialProfitShort >= tpPercent * margin;

  // === LOGGING ===
  console.log("📊 [Indikator LONG]");
  console.log("  RSI < 35          :", rsi < 35 ? "✅" : "❌");
  console.log("  MACD > 0          :", macd?.histogram > 0 ? "✅" : "❌");
  console.log("  EMA20 > EMA50     :", ema20 > ema50 ? "✅" : "❌");
  console.log("  ADX > 20          :", adx?.adx > 20 ? "✅" : "❌");
  console.log("  Candle Strong     :", isStrongCandle ? "✅" : "❌");
  console.log("  Candle Up         :", candleUp ? "✅" : "❌");
  console.log("  Bull Engulfing    :", isBullishEngulfing ? "✅" : "❌");
  console.log("  Price > MA200     :", price > ma200 ? "✅" : "❌");
  console.log(`  Est. ROI TP Long  : ${roiProfitLong.toFixed(2)}%`);
  console.log(`  Est. ROI SL Long  : ${roiLossLong.toFixed(2)}%`);
  console.log(`  ROI Valid         : ${validLong ? "✅" : "❌"}`);
  console.log(`  → Skor LONG       : ${scoreLong}`);

  console.log("📊 [Indikator SHORT]");
  console.log("  RSI > 65          :", rsi > 65 ? "✅" : "❌");
  console.log("  MACD < 0          :", macd?.histogram < 0 ? "✅" : "❌");
  console.log("  EMA20 < EMA50     :", ema20 < ema50 ? "✅" : "❌");
  console.log("  ADX > 20          :", adx?.adx > 20 ? "✅" : "❌");
  console.log("  Candle Strong     :", isStrongCandle ? "✅" : "❌");
  console.log("  Candle Down       :", candleDown ? "✅" : "❌");
  console.log("  Bear Engulfing    :", isBearishEngulfing ? "✅" : "❌");
  console.log("  Price < MA200     :", price < ma200 ? "✅" : "❌");
  console.log(`  Est. ROI TP Short : ${roiProfitShort.toFixed(2)}%`);
  console.log(`  Est. ROI SL Short : ${roiLossShort.toFixed(2)}%`);
  console.log(`  ROI Valid         : ${validShort ? "✅" : "❌"}`);
  console.log(`  → Skor SHORT      : ${scoreShort}`);

  const canLong = (() => {
    if (db.entryMode === "agresif") {
      return (
        (scoreLong >= 3 || (scoreLong >= 2 && isBullishEngulfing)) &&
        price > ma200 &&
        validLong
      );
    } else {
      return scoreLong >= 4 && price > ma200 && isBullishEngulfing && validLong;
    }
  })();

  const canShort = (() => {
    if (db.entryMode === "agresif") {
      return (
        (scoreShort >= 3 || (scoreShort >= 2 && isBearishEngulfing)) &&
        price < ma200 &&
        validShort
      );
    } else {
      return scoreShort >= 4 && price < ma200 && isBearishEngulfing && validShort;
    }
  })();

  return { canLong, canShort };
};

// Fungsi untuk membuka posisi
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
    sl:
      type === "long" ? entry * (1 - db.slPercent) : entry * (1 + db.slPercent),
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
    )}\n💰 Size: ~${amount} ${market.base} ($${usedUSDT.toFixed(2)})`
  );
};

// Fungsi untuk menutup posisi
const closePosition = async (type, amount) => {
  const side = type === "long" ? "sell" : "buy";
  try {
    await exchange.createMarketOrder(db.pair, side, amount);
    console.log(`✅ Posisi ${type.toUpperCase()} ditutup (side: ${side})`);
  } catch (e) {
    console.log(`❌ Gagal close posisi ${type}:`, e.message);
    await sendMsg(`❌ Gagal close posisi ${type}: ${e.message}`);
  }
};

// Fungsi untuk mengecek Take Profit dan Stop Loss
const checkTP_SL = async (type) => {
  const price = await getPrice();
  const key = type === "long" ? "positionLong" : "positionShort";
  const lossKey = type === "long" ? "lossCountLong" : "lossCountShort";
  const position = db[key];
  if (!position) return;

  const { entry, entryTime, amount, usedUSDT, trailingActive, trailingStop } =
    position;
  const holdMins = mins(now() - entryTime);

  const pnlUSD =
    type === "long" ? (price - entry) * amount : (entry - price) * amount;
  const notional = entry * amount;
  const margin = notional / db.leverage;
  const roi = pnlUSD / margin;

  const timeExpired = holdMins >= MAX_HOLD_MINUTES;
  const ROI_TP = db.tpPercent;
  const ROI_SL = db.slPercent;
  const offset = (ROI_TP + ROI_SL) / 2;

  // ❌ Stop Loss
  if (roi <= -ROI_SL) {
    await closePosition(type, amount);
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

  // 🎯 Aktifkan Trailing saat ROI >= TP
  if (!trailingActive && roi >= ROI_TP) {
    const stopPrice =
      type === "long" ? entry * (1 + offset) : entry * (1 - offset);

    position.trailingActive = true;
    position.trailingStop = stopPrice;
    db[key] = position;
    saveDB();
    sendMsg(
      `🎯 ${type.toUpperCase()} ROI ${(roi * 100).toFixed(
        2
      )}% hit. Trailing ON @ ${price} (Offset ${(offset * 100).toFixed(2)}%)`
    );
    return;
  }

  // 🏁 Trailing Stop Exit
  if (trailingActive) {
    const stopHit =
      type === "long" ? price <= trailingStop : price >= trailingStop;

    if (stopHit) {
      await closePosition(type, amount);
      db[key] = null;
      db[lossKey] = 0;
      saveDB();
      sendMsg(`🏁 ${type.toUpperCase()} Trailing Stop HIT @ ${price}`);
      logTrade(type, entry, "-", "-", price, "trailing_exit", amount, usedUSDT);
      updatePnL(type, entry, price, amount, "trailing_exit");
      return;
    }

    // 🔁 Update trailing stop berdasarkan entry + offset sesuai harga terbaru
    const dynamicOffset = offset * (roi / ROI_TP || 1); // semakin tinggi ROI, semakin tinggi offset
    const newStop =
      type === "long"
        ? entry * (1 + dynamicOffset)
        : entry * (1 - dynamicOffset);

    position.trailingStop =
      type === "long"
        ? Math.max(position.trailingStop, newStop)
        : Math.min(position.trailingStop, newStop);

    db[key] = position;
    saveDB();
  }

  // ⏱ Timeout (hanya jika belum trailing aktif)
  if (timeExpired && !trailingActive) {
    await closePosition(type, amount);
    db[key] = null;
    db[lossKey]++;
    saveDB();
    sendMsg(`⌛ ${type.toUpperCase()} auto-close (timeout) @ ${price}`);
    logTrade(type, entry, "-", "-", price, "cut_timeout", amount, usedUSDT);
    updatePnL(type, entry, price, amount, "cut_timeout");
  }
};

// Fungsi untuk sinkronisasi posisi dengan Binance
const syncPositionWithBinance = async () => {
  const positions = await exchange.fetchPositions([db.pair]);

  const longPos = positions.find((p) => p.side === "long" && p.contracts > 0);
  const shortPos = positions.find((p) => p.side === "short" && p.contracts > 0);

  if (!longPos && db.positionLong) {
    console.log("🔄 LONG sudah ditutup manual. Sinkronisasi...");
    db.positionLong = null;
  }

  if (!shortPos && db.positionShort) {
    console.log("🔄 SHORT sudah ditutup manual. Sinkronisasi...");
    db.positionShort = null;
  }

  saveDB();
};

// Eksekusi bot
setInterval(async () => {
  try {
    // await testBinanceConnection();
     await testBinanceConnection();

    if (!isBinanceConnected) return; // jangan lanjut eksekusi trading

    await syncPositionWithBinance();
    await checkTP_SL("long");
    await checkTP_SL("short");

    const nowDate = new Date();
    const nowTime = nowDate.getTime();
    const minute = nowDate.getUTCMinutes();
    const day = new Date(nowTime + 7 * 60 * 60 * 1000).getUTCDay();

    // ⛔ Lewati saat weekend
    if (day === 6 || day === 0) {
      console.log("⛔ Weekend detected (Saturday/Sunday). Trading skipped.");
      return;
    }

    // 📈 Analisa sinyal
    const { canLong, canShort } = await analyzeSignal();

    if (minute % 1 !== 0) return;

    // 🔁 Reset loss count
    const canResetLong =
      db.lossCountLong >= LOSS_LIMIT &&
      nowTime - db.lastLongEntryTime >= LOSS_WAIT_MINUTES * 60 * 1000;

    const canResetShort =
      db.lossCountShort >= LOSS_LIMIT &&
      nowTime - db.lastShortEntryTime >= LOSS_WAIT_MINUTES * 60 * 1000;

    if (canResetLong) {
      db.lossCountLong = 0;
      saveDB();
      console.log("🔁 Reset lossCountLong");
    }

    if (canResetShort) {
      db.lossCountShort = 0;
      saveDB();
      console.log("🔁 Reset lossCountShort");
    }

    
    // 🔄 Switch posisi jika sinyal berlawanan muncul
    if (canLong && db.positionShort) {
      console.log("🔁 Close SHORT & ganti ke LONG");
      const type = "short";
      const amount = db.positionShort.amount;
      await closePosition(type, amount);
      db.positionShort = null;
      db.lossCountShort = 0;
      saveDB();
      sendMsg(`🔁 Close SHORT & ganti ke LONG`);
      await openPosition("long");
      return;
    }

    if (canShort && db.positionLong) {
      console.log("🔁 Close LONG & ganti ke SHORT");
      const type = "long";
      const amount = db.positionLong.amount;
      await closePosition(type, amount);
      db.positionLong = null;
      db.lossCountLong = 0;
      saveDB();
      sendMsg(`🔁 Close LONG & ganti ke SHORT`);
      await openPosition("short");
      return;
    }

    // 📥 Entry baru jika siap
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
    console.log("⚠️ Signal/entry error:", e.message);
  }
}, 10 * 1000);
