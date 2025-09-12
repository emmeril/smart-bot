require("dotenv").config();
const fs = require("fs");
const ccxt = require("ccxt");
const { RSI, EMA, MACD, ADX } = require("technicalindicators");
const { Client, LocalAuth } = require("whatsapp-web.js");
const express = require("express");
const QRCode = require("qrcode");

// -----------------------------------------------------------------------------
// 1. KONSTANTA & KONFIGURASI
// -----------------------------------------------------------------------------
const isBacktest = process.argv.includes("--backtest");
const app = express();
const dbPath = "./db.json";
const logPath = "./log.csv";
const serverPort = 7890;

const COOLDOWN_MINUTES = 5;
const LOSS_LIMIT = 3;
const LOSS_WAIT_MINUTES = 15;
const MAX_HOLD_MINUTES = 1440;
const SPREAD_FILTER = 0.003; // Maksimal spread yang diizinkan (0.3%)
const MIN_ORDER_USDT = 5; // Minimal ukuran order dalam USDT
const RISK_PER_TRADE = 0.01; // Risiko per trade sebagai persentase dari saldo (1%)

// -----------------------------------------------------------------------------
// 2. INITIALISASI
// -----------------------------------------------------------------------------
const db = fs.existsSync(dbPath)
  ? JSON.parse(fs.readFileSync(dbPath))
  : {
      pair: "XRP/USDT:USDT",
      pairs: ["XRP/USDT:USDT"],
      balancePercent: 100,
      positions: {}, // BARU: Objek untuk menyimpan posisi per-pair
      lastEntryTime: {}, // BARU: Objek untuk menyimpan waktu entry terakhir per-pair
      lossCount: {}, // BARU: Objek untuk menyimpan jumlah loss per-pair
      winCount: {}, // BARU: Objek untuk menyimpan jumlah win per-pair
      leverage: 10,
      marginMode: "isolated",
      totalProfit: 0,
      totalLoss: 0,
      tpPercent: 0.03, // TP default
      slPercent: 0.02, // SL default
      entryMode: "agresif",
    };

db.tpPercent ??= 0.03;
db.slPercent ??= 0.02;
db.positions ??= {};
db.lastEntryTime ??= {};
db.lossCount ??= {};
db.winCount ??= {};
db.pairs ??= [db.pair];

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
  console.log(`🟢 QR server di http://localhost:${serverPort}`)
);

// -----------------------------------------------------------------------------
// 3. FUNGSI UTILITAS
// -----------------------------------------------------------------------------
const saveDB = () => fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
const now = () => Date.now();
const mins = (ms) => ms / 1000 / 60;
const formatPrice = (price) =>
  exchange.decimalToPrecision(price, "currency", 5, 5);
const formatUSD = (amount) =>
  exchange.decimalToPrecision(amount, "currency", 2, 2);

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
    if (chat) await chat.sendMessage(text);
  } catch (err) {
    console.error("❌ Gagal mengirim pesan WA:", err.message);
  }
};

const updatePnL = (pair, type, entry, exit, amount, result) => {
  const diff = type === "long" ? exit - entry : entry - exit;
  const pnl = diff * amount;
  if (result === "sl_hit" || result === "cut_timeout") {
    db.totalLoss += Math.abs(pnl);
    if (!db.lossCount[pair]) db.lossCount[pair] = { long: 0, short: 0 };
    db.lossCount[pair][type]++;
  } else {
    db.totalProfit += pnl;
    if (!db.winCount[pair]) db.winCount[pair] = { long: 0, short: 0 };
    db.winCount[pair][type]++;
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
  usedUSDT = 0,
  pair
) => {
  const row = `${new Date().toISOString()},${pair},${type},${entry},${tp},${sl},${result},${exitPrice},${amount},${usedUSDT}\n`;
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(
      logPath,
      "timestamp,pair,side,entry,tp,sl,result,exitPrice,amount,usedUSDT\n"
    );
  }
  fs.appendFileSync(logPath, row);
};

const getPrice = async (pair) => {
  try {
    const ticker = await exchange.fetchTicker(pair);
    return ticker.last;
  } catch (e) {
    console.error(`❌ Gagal fetch harga untuk ${pair}:`, e.message);
    return null;
  }
};

const calcFloatingPnl = async (pair, type) => {
  if (!db.positions[pair] || !db.positions[pair][type]) return null;
  const position = db.positions[pair][type];
  const price = await getPrice(pair);
  if (!price) return null;
  const diff =
    type === "long" ? price - position.entry : position.entry - price;
  return diff * position.amount;
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

    // Command handling (gunakan switch case untuk struktur lebih rapi)
    const [command, ...args] = txt.split(" ");
    switch (command) {
      case "!pair": {
        const newPair = args[0]?.toUpperCase();
        if (!newPair) {
          msg.reply(
            "⚠️ Format salah. Contoh: !pair BTC/USDT:USDT atau !pair all"
          );
          return;
        }

        if (newPair === "ALL") {
          const allPairs = await exchange.fetchMarkets();
          // Filter yang diperbaiki: cari pasar yang linear (futures) dan quote-nya USDT
          const futurePairs = allPairs
            .filter((market) => market.quote === 'USDT' && market.info.contractType === 'PERPETUAL')
            .map((market) => market.symbol);

          if (futurePairs.length > 0) {
            db.pairs = futurePairs;
            db.pair = "ALL"; // menandakan mode multi-pair
            db.positions = {};
            db.lastEntryTime = {};
            db.lossCount = {};
            saveDB();
            msg.reply(
              `✅ Mode multi-pair diaktifkan. Bot akan mencari sinyal di ${futurePairs.length} pasangan perpetual futures USDT yang tersedia.`
            );
          } else {
            msg.reply(
              "❌ Gagal menemukan pasangan futures USDT. Pastikan koneksi ke bursa stabil."
            );
          }
        } else {
          db.pair = newPair;
          db.pairs = [newPair]; // Atur kembali ke mode single-pair
          db.positions = {};
          db.lastEntryTime = {};
          db.lossCount = {};
          saveDB();
          msg.reply(`✅ Pair diubah ke *${db.pair}*.`);
        }
        break;
      }
      case "!status": {
        const statusMsgs = [];
        const pairsToDisplay =
          db.pair === "ALL"
            ? Object.keys(db.positions)
            : [db.pair].filter((p) => p !== "ALL");
        if (pairsToDisplay.length === 0) {
          statusMsgs.push("📌 Pair: *" + db.pair + "*");
          statusMsgs.push("🚫 Belum ada posisi aktif.");
        }
        for (const pair of pairsToDisplay) {
          const price = await getPrice(pair);
          const longPos = db.positions[pair]?.long;
          const shortPos = db.positions[pair]?.short;

          const fltLong = await calcFloatingPnl(pair, "long");
          const fltShort = await calcFloatingPnl(pair, "short");

          const roiLong =
            longPos && fltLong != null
              ? ((fltLong / ((longPos.entry * longPos.amount) / db.leverage)) *
                  100).toFixed(2)
              : null;
          const roiShort =
            shortPos && fltShort != null
              ? ((fltShort / ((shortPos.entry * shortPos.amount) / db.leverage)) *
                  100).toFixed(2)
              : null;

          const posLong = longPos
            ? `\n*LONG*\n📍 Entry @ ${longPos.entry.toFixed(4)}\n📊 Floating PnL: ${
                fltLong >= 0 ? "+" : "-"
              }$${Math.abs(fltLong).toFixed(4)} (${roiLong}%)`
            : "";

          const posShort = shortPos
            ? `\n*SHORT*\n📍 Entry @ ${shortPos.entry.toFixed(4)}\n📊 Floating PnL: ${
                fltShort >= 0 ? "+" : "-"
              }$${Math.abs(fltShort).toFixed(4)} (${roiShort}%)`
            : "";

          statusMsgs.push(
            `📊 *Status Trading di ${pair}*` +
            `\n📈 Harga: *${price ? price.toFixed(4) : "N/A"}*` +
            `\n🧭 Leverage: *${db.leverage}x* (${db.marginMode?.toUpperCase() || "?"})` +
            `\n📎 Mode Entry: *${(db.entryMode || "DEFAULT").toUpperCase()}*` +
            `\n\n✅ Wins: L:${db.winCount[pair]?.long || 0} | S:${db.winCount[pair]?.short || 0}` +
            `\n❌ Losses: L:${db.lossCount[pair]?.long || 0} | S:${db.lossCount[pair]?.short || 0}` +
            (posLong || posShort ? posLong + posShort : "\n\n🚫 Tidak ada posisi aktif.")
          );
        }

        const net = (db.totalProfit || 0) - (db.totalLoss || 0);
        statusMsgs.push(
            `\n---` +
            `\n💹 *Global PNL Summary*` +
            `\n📈 Profit: $${(db.totalProfit || 0).toFixed(2)}` +
            `\n📉 Loss: $${(db.totalLoss || 0).toFixed(2)}` +
            `\n📊 Net: $${net.toFixed(2)} ${net >= 0 ? "🟢" : "🔴"}`
        );

        msg.reply(statusMsgs.join("\n\n"));
        break;
      }
      case "!leverage": {
        const [lev, mode] = args;
        const leverage = parseInt(lev);
        const validMode = mode === "cross" || mode === "isolated";
        if (!leverage || !validMode) {
          msg.reply("⚠️ Format salah. Contoh: !leverage 10 isolated");
        } else {
          db.leverage = leverage;
          db.marginMode = mode;
          saveDB();
          msg.reply(
            `✅ Leverage diatur: *${leverage}x* (${mode.toUpperCase()})`
          );
        }
        break;
      }
      case "!balance": {
        const val = parseFloat(args[0]);
        if (isNaN(val) || val < 1 || val > 100) {
          msg.reply("⚠️ Format salah. Contoh: !balance 20");
        } else {
          db.balancePercent = val;
          saveDB();
          msg.reply(`✅ Bot akan gunakan *${val}%* dari saldo USDT.`);
        }
        break;
      }
      case "!pnl": {
        const net = (db.totalProfit || 0) - (db.totalLoss || 0);
        msg.reply(`💹 *PNL Summary*
📈 Profit: $${(db.totalProfit || 0).toFixed(2)}
📉 Loss: $${(db.totalLoss || 0).toFixed(2)}
📊 Net: $${net.toFixed(2)} ${net >= 0 ? "🟢" : "🔴"}`);
        break;
      }
      case "!mode": {
        const mode = args[0];
        if (["agresif", "konservatif"].includes(mode)) {
          db.entryMode = mode;
          saveDB();
          msg.reply(`✅ Mode entry diatur ke *${mode.toUpperCase()}*`);
        } else {
          msg.reply("⚠️ Pilih mode: `!mode agresif` atau `!mode konservatif`");
        }
        break;
      }
      case "!tp": {
        const val = parseFloat(args[0]);
        if (isNaN(val) || val < 0.5 || val > 20) {
          msg.reply("⚠️ Format salah. Contoh: !tp 5");
        } else {
          db.tpPercent = val / 100;
          saveDB();
          msg.reply(`✅ Take Profit diatur ke *${val}%* ROI.`);
        }
        break;
      }
      case "!sl": {
        const val = parseFloat(args[0]);
        if (isNaN(val) || val < 0.5 || val > 10) {
          msg.reply("⚠️ Format salah. Contoh: !sl 2.5");
        } else {
          db.slPercent = val / 100;
          saveDB();
          msg.reply(`✅ Stop Loss diatur ke *${val}%* ROI.`);
        }
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
const analyzeSignal = async (pair) => {
  const ohlcv = await exchange.fetchOHLCV(pair, "15m", undefined, 200);
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
    prevCandle[4] < prevPrevCandle[1];

  let scoreLong = 0;
  if (rsi < 35) scoreLong++;
  if (macd?.histogram > 0) scoreLong++;
  if (ema20 > ema50) scoreLong++;
  if (adx?.adx > 20) scoreLong++;
  if (isStrongCandle && candleUp) scoreLong++;
  if (isBullishEngulfing) scoreLong += 2;

  let scoreShort = 0;
  if (rsi > 65) scoreShort++;
  if (macd?.histogram < 0) scoreShort++;
  if (ema20 < ema50) scoreShort++;
  if (adx?.adx > 20) scoreShort++;
  if (isStrongCandle && candleDown) scoreShort++;
  if (isBearishEngulfing) scoreShort += 2;

  const high10 = Math.max(...high.slice(-10));
  const low10 = Math.min(...low.slice(-10));

  const longTPcands = [ma200, ema50, high10, close.at(-2), close.at(-3)].filter(
    (v) => v > price
  );
  const shortTPcands = [ma200, ema50, low10, close.at(-2), close.at(-3)].filter(
    (v) => v < price
  );

  const targetLong = longTPcands.length
    ? Math.max(...longTPcands)
    : price * (1 + db.tpPercent);
  const targetShort = shortTPcands.length
    ? Math.min(...shortTPcands)
    : price * (1 - db.tpPercent);

  const stopLossLong = Math.max(ema20, ...low.slice(-5));
  const stopLossShort = Math.min(ema20, ...high.slice(-5));

  const leverage = db.leverage || 10;
  const margin = price / leverage;

  const roiTpLong = ((targetLong - price) / margin) * 100;
  const roiSlLong = ((price - stopLossLong) / margin) * 100;
  const roiTpShort = ((price - targetShort) / margin) * 100;
  const roiSlShort = ((stopLossShort - price) / margin) * 100;

  const aggressive = db.entryMode === "agresif";
  const canLong = aggressive
    ? scoreLong >= 3 && price > ma200 && roiTpLong >= db.tpPercent * 100
    : scoreLong >= 4 &&
      price > ma200 &&
      isBullishEngulfing &&
      roiTpLong >= db.tpPercent * 100;

  const canShort = aggressive
    ? scoreShort >= 3 && price < ma200 && roiTpShort >= db.tpPercent * 100
    : scoreShort >= 4 &&
      price < ma200 &&
      isBearishEngulfing &&
      roiTpShort >= db.tpPercent * 100;

  return { canLong, canShort, roiTpLong, roiSlLong, roiTpShort, roiSlShort };
};

const openPosition = async (pair, type) => {
  const nowTime = now();
  if (!db.lastEntryTime[pair]) db.lastEntryTime[pair] = { long: 0, short: 0 };
  db.lastEntryTime[pair][type] = nowTime;

  try {
    await exchange.setLeverage(db.leverage, pair);
    await exchange
      .setMarginMode(db.marginMode, pair)
      .catch((e) => console.log("⚠️ Gagal set margin mode:", e.message));

    const side = type === "long" ? "buy" : "sell";
    const balance = await exchange.fetchBalance();
    const usdt = balance.total.USDT;

    const price = await getPrice(pair);
    if (!price) return;
    const { roiSlLong, roiSlShort } = await analyzeSignal(pair);
    const slPercent = type === "long" ? roiSlLong / 100 : roiSlShort / 100;
    const stopLossUSDT = usdt * RISK_PER_TRADE;
    if (slPercent === 0) {
      console.warn("⚠️ SL Percent tidak valid. Menggunakan default.");
      slPercent = db.slPercent;
    }
    const amountUSDT = stopLossUSDT / slPercent;
    if (amountUSDT < MIN_ORDER_USDT) {
      console.log("❌ Ukuran order terlalu kecil (<$5), dilewati.");
      return;
    }

    const ticker = await exchange.fetchTicker(pair);
    const spread = Math.abs(ticker.ask - ticker.bid) / ticker.last;
    if (spread > SPREAD_FILTER) {
      console.log(
        `⚠️ SPREAD terlalu tinggi (${(spread * 100).toFixed(2)}%), skip entry.`
      );
      return;
    }

    const market = await exchange.market(pair);
    const amountRaw = amountUSDT / price;
    const amount = exchange.amountToPrecision(pair, amountRaw);

    const order = await exchange.createMarketOrder(
      pair,
      side,
      parseFloat(amount)
    );
    const entry = order.average;
    const usedUSDT = amountUSDT;

    const position = {
      entry,
      sl:
        type === "long"
          ? entry * (1 - db.slPercent)
          : entry * (1 + db.slPercent),
      trailingActive: false,
      trailingStop: 0,
      entryTime: nowTime,
      amount: parseFloat(amount),
      usedUSDT: parseFloat(usedUSDT.toFixed(2)),
    };

    if (!db.positions[pair]) db.positions[pair] = {};
    db.positions[pair][type] = position;
    saveDB();

    sendMsg(
      `${type === "long" ? "🟢 LONG" : "🔴 SHORT"} dibuka di ${pair} @ ${formatPrice(
        entry
      )}\n` +
        `💰 Ukuran: ~${formatUSD(usedUSDT)} USDT\n` +
        `🎯 TP: ${(db.tpPercent * 100).toFixed(2)}% | SL: ${(
          db.slPercent * 100
        ).toFixed(2)}%`
    );
  } catch (e) {
    console.error("❌ Gagal buka posisi:", e.message);
    sendMsg(`❌ Gagal buka posisi ${type} di ${pair}: ${e.message}`);
  }
};

const closePosition = async (pair, type, amount) => {
  const side = type === "long" ? "sell" : "buy";
  try {
    await exchange.createMarketOrder(pair, side, amount);
    console.log(`✅ Posisi ${type.toUpperCase()} di ${pair} ditutup`);
  } catch (e) {
    console.error(`❌ Gagal close posisi ${type} di ${pair}:`, e.message);
    await sendMsg(`❌ Gagal close posisi ${type} di ${pair}: ${e.message}`);
  }
};

const checkTP_SL = async (pair, type) => {
  if (!db.positions[pair] || !db.positions[pair][type]) return;
  const position = db.positions[pair][type];

  const price = await getPrice(pair);
  if (!price) return;
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
  const TRAILING_OFFSET = 0.005; // 0.5% offset dari harga tertinggi/terendah

  // ❌ Stop Loss
  if (roi <= -ROI_SL) {
    await closePosition(pair, type, amount);
    delete db.positions[pair][type];
    if (Object.keys(db.positions[pair]).length === 0) {
      delete db.positions[pair];
    }
    saveDB();
    sendMsg(
      `⚠️ ${type.toUpperCase()} STOP LOSS hit di ${pair} @ ${formatPrice(price)} (ROI ${(
        roi * 100
      ).toFixed(2)}%)`
    );
    logTrade(type, entry, "-", "-", price, "sl_hit", amount, usedUSDT, pair);
    updatePnL(pair, type, entry, price, amount, "sl_hit");
    return;
  }

  // 🎯 Aktifkan Trailing saat ROI >= TP
  if (!trailingActive && roi >= ROI_TP) {
    const stopPrice =
      type === "long"
        ? price * (1 - TRAILING_OFFSET)
        : price * (1 + TRAILING_OFFSET);
    position.trailingActive = true;
    position.trailingStop = stopPrice;
    saveDB();
    sendMsg(
      `🎯 ${type.toUpperCase()} di ${pair} ROI ${(roi * 100).toFixed(
        2
      )}% hit. Trailing ON @ ${formatPrice(stopPrice)}`
    );
    return;
  }

  // 🏁 Trailing Stop Exit
  if (trailingActive) {
    const stopHit =
      type === "long" ? price <= trailingStop : price >= trailingStop;
    if (stopHit) {
      await closePosition(pair, type, amount);
      delete db.positions[pair][type];
      if (Object.keys(db.positions[pair]).length === 0) {
        delete db.positions[pair];
      }
      if (!db.lossCount[pair]) db.lossCount[pair] = { long: 0, short: 0 };
      db.lossCount[pair][type] = 0;
      saveDB();
      sendMsg(
        `🏁 ${type.toUpperCase()} Trailing Stop HIT di ${pair} @ ${formatPrice(price)}`
      );
      logTrade(type, entry, "-", "-", price, "trailing_exit", amount, usedUSDT, pair);
      updatePnL(pair, type, entry, price, amount, "trailing_exit");
      return;
    }
    // OPTIMASI: Update trailing stop agar lebih responsif
    const newStop =
      type === "long"
        ? price * (1 - TRAILING_OFFSET)
        : price * (1 + TRAILING_OFFSET);
    position.trailingStop =
      type === "long"
        ? Math.max(position.trailingStop, newStop)
        : Math.min(position.trailingStop, newStop);
    saveDB();
  }

  // ⏱ Timeout (hanya jika belum trailing aktif)
  if (timeExpired && !trailingActive) {
    await closePosition(pair, type, amount);
    delete db.positions[pair][type];
    if (Object.keys(db.positions[pair]).length === 0) {
        delete db.positions[pair];
    }
    saveDB();
    sendMsg(
      `⌛ ${type.toUpperCase()} auto-close (timeout) di ${pair} @ ${formatPrice(price)}`
    );
    logTrade(type, entry, "-", "-", price, "cut_timeout", amount, usedUSDT, pair);
    updatePnL(pair, type, entry, price, amount, "cut_timeout");
  }
};

const syncPositionWithBinance = async (pairs) => {
  for (const pair of pairs) {
    const positions = await exchange.fetchPositions([pair]);
    const longPos = positions.find((p) => p.side === "long" && p.contracts > 0);
    const shortPos = positions.find((p) => p.side === "short" && p.contracts > 0);

    if (!db.positions[pair]) db.positions[pair] = {};
    if (!longPos && db.positions[pair]?.long) {
      console.log(`🔄 LONG di ${pair} sudah ditutup manual. Sinkronisasi...`);
      delete db.positions[pair].long;
    }
    if (!shortPos && db.positions[pair]?.short) {
      console.log(`🔄 SHORT di ${pair} sudah ditutup manual. Sinkronisasi...`);
      delete db.positions[pair].short;
    }
    if (Object.keys(db.positions[pair]).length === 0) {
        delete db.positions[pair];
    }
  }
  saveDB();
};

let isBinanceConnected = true;
let lastBinanceStatus = true;
let failCount = 0;
const MAX_FAIL = 3;

const testBinanceConnection = async () => {
  try {
    await exchange.fetchTime();
    isBinanceConnected = true;
    failCount = 0;
  } catch (e) {
    isBinanceConnected = false;
    failCount++;
  }
  if (isBinanceConnected !== lastBinanceStatus) {
    if (isBinanceConnected) console.log("✅ Reconnected to Binance.");
    else console.log("⚠️ Lost connection to Binance.");
    lastBinanceStatus = isBinanceConnected;
  }
  if (failCount >= MAX_FAIL) {
    console.log(
      "❌ Binance connection failed 3x berturut-turut. Exit & restart via PM2."
    );
    process.exit(1);
  }
};

// -----------------------------------------------------------------------------
// 6. EKSEKUSI UTAMA
// -----------------------------------------------------------------------------
setInterval(async () => {
  try {
    await testBinanceConnection();
    if (!isBinanceConnected) return;

    const pairsToAnalyze = db.pair === "ALL" ? db.pairs : [db.pair];
    await syncPositionWithBinance(pairsToAnalyze);

    for (const pair of pairsToAnalyze) {
      console.log(`⏳ Menganalisis ${pair}...`);
      const nowTime = now();
      const longPos = db.positions[pair]?.long;
      const shortPos = db.positions[pair]?.short;

      if (longPos) await checkTP_SL(pair, "long");
      if (shortPos) await checkTP_SL(pair, "short");

      if (!db.lossCount[pair]) db.lossCount[pair] = { long: 0, short: 0 };
      const canResetLong =
        db.lossCount[pair].long >= LOSS_LIMIT &&
        mins(nowTime - (db.lastEntryTime[pair]?.long || 0)) >= LOSS_WAIT_MINUTES;
      const canResetShort =
        db.lossCount[pair].short >= LOSS_LIMIT &&
        mins(nowTime - (db.lastEntryTime[pair]?.short || 0)) >= LOSS_WAIT_MINUTES;

      if (canResetLong) {
        db.lossCount[pair].long = 0;
        saveDB();
        console.log(`🔁 Reset lossCountLong untuk ${pair}`);
      }
      if (canResetShort) {
        db.lossCount[pair].short = 0;
        saveDB();
        console.log(`🔁 Reset lossCountShort untuk ${pair}`);
      }

      const { canLong, canShort } = await analyzeSignal(pair);

      if (canLong && shortPos) {
        console.log(`🔁 Close SHORT di ${pair} & ganti ke LONG`);
        await closePosition(pair, "short", shortPos.amount);
        delete db.positions[pair].short;
        db.lossCount[pair].short = 0;
        saveDB();
        sendMsg(`🔁 Close SHORT di ${pair} & ganti ke LONG`);
        await openPosition(pair, "long");
        return;
      }
      if (canShort && longPos) {
        console.log(`🔁 Close LONG di ${pair} & ganti ke SHORT`);
        await closePosition(pair, "long", longPos.amount);
        delete db.positions[pair].long;
        db.lossCount[pair].long = 0;
        saveDB();
        sendMsg(`🔁 Close LONG di ${pair} & ganti ke SHORT`);
        await openPosition(pair, "short");
        return;
      }

      const readyLong =
        !longPos &&
        mins(nowTime - (db.lastEntryTime[pair]?.long || 0)) >= COOLDOWN_MINUTES &&
        db.lossCount[pair].long < LOSS_LIMIT;
      const readyShort =
        !shortPos &&
        mins(nowTime - (db.lastEntryTime[pair]?.short || 0)) >= COOLDOWN_MINUTES &&
        db.lossCount[pair].short < LOSS_LIMIT;

      if (canLong && readyLong) {
        console.log(`🟢 Sinyal LONG terdeteksi di ${pair}. Membuka posisi...`);
        await openPosition(pair, "long");
      }
      if (canShort && readyShort) {
        console.log(`🔴 Sinyal SHORT terdeteksi di ${pair}. Membuka posisi...`);
        await openPosition(pair, "short");
      }
    }
  } catch (e) {
    console.error("⚠️ Global Loop Error:", e.message);
  }
}, 300 * 1000);