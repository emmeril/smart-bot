// signal.js (perbaikan deteksi posisi & close/TP-SL)
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

// const COOLDOWN_MINUTES = 15;

// -------------------- FILE INIT --------------------
if (!fs.existsSync(logPath)) {
  fs.writeFileSync(logPath, "timestamp,pair,type,entry,tp,sl,status\n");
  console.log("📝 Log: File log.csv dibuat.");
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
      usdtPerTrade: 5.1,
    };

let prevPosAmt = 0;

console.log(`⚙️ Konfigurasi Bot:`);
console.log(`   - Pair Aktif: ${db.pair}`);
console.log(`   - Leverage: ${db.leverage}x`);
console.log(`   - Margin Mode: ${db.marginMode}`);
console.log(`   - USDT per Trade: ${db.usdtPerTrade}`);

// -------------------- EXCHANGE --------------------
const exchange = new ccxt.binance({
  apiKey: process.env.API_KEY,
  secret: process.env.API_SECRET,
  options: { defaultType: "future" },
});

(async () => {
  try {
    await exchange.loadMarkets();
    console.log("✅ Exchange: Markets berhasil dimuat.");
  } catch (err) {
    console.error("❌ Exchange: Gagal memuat markets.", err.message);
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
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  },
});

app.listen(serverPort, () =>
  console.log(`🟢 Server: QR server aktif di http://localhost:${serverPort}/qr`)
);

client.on("qr", (qr) => {
  currentQR = qr;
  isReady = false;
  console.log("📲 WhatsApp: QR baru siap discan.");
});

client.on("ready", () => {
  isReady = true;
  currentQR = null;
  console.log("✅ WhatsApp: Koneksi berhasil.");
});

client.on("disconnected", (reason) => {
  console.log("❌ WhatsApp: Terputus, bot dimatikan.", reason);
  process.exit();
});

client.on("message", async (msg) => {
  if (!msg.from.includes(process.env.ADMIN_PHONE)) return;
  const txt = msg.body.toLowerCase();
  const [cmd, ...args] = txt.split(" ");

  if (cmd === "!pair") {
    const newPair = args[0]?.toUpperCase();
    if (!newPair) {
      return msg.reply(
        "⚠️ Format salah. Gunakan: *!pair [SIMBOL]*, contoh: *!pair BTC/USDT:USDT*"
      );
    }
    db.pair = newPair;
    db.lastLongEntryTime = 0;
    db.lastShortEntryTime = 0;
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
    console.log(`🔄 Perintah: Pair diganti ke ${db.pair}.`);
    msg.reply(`✅ Pair trading berhasil diubah ke *${db.pair}*.`);
  }

  if (cmd === "!leverage") {
    const newLeverage = parseInt(args[0]);
    const newMarginMode = args[1]?.toUpperCase();
    const validModes = ["ISOLATED", "CROSSED"];

    if (!newLeverage || newLeverage < 1 || newLeverage > 125) {
      return msg.reply(
        "⚠️ Format salah. Gunakan: *!leverage [1-125] [isolated/crossed]*"
      );
    }
    if (newMarginMode && !validModes.includes(newMarginMode)) {
      return msg.reply(
        `⚠️ Margin mode tidak valid. Pilihan: *${validModes.join(" atau ")}*.`
      );
    }

    db.leverage = newLeverage;
    if (newMarginMode) db.marginMode = newMarginMode;
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

    let replyMsg = `✅ Pengaturan berhasil diperbarui:\n\n*Leverage:* ${db.leverage}x`;
    if (newMarginMode) replyMsg += `\n*Margin Mode:* ${db.marginMode}`;

    console.log(
      `🔄 Perintah: Leverage/margin mode diganti ke ${db.leverage}x (${db.marginMode}).`
    );
    msg.reply(replyMsg);
  }

  if (cmd === "!order") {
    const newAmount = parseFloat(args[0]);
    if (isNaN(newAmount) || newAmount <= 0) {
      return msg.reply(
        "⚠️ Format salah. Gunakan: *!order [JUMLAH]*, contoh: *!order 10.5*"
      );
    }
    db.usdtPerTrade = newAmount;
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
    console.log(
      `🔄 Perintah: Jumlah USDT per trade diubah ke ${db.usdtPerTrade}.`
    );
    msg.reply(
      `✅ Jumlah USDT per trade berhasil diubah menjadi *${db.usdtPerTrade} USDT*.`
    );
  }

  if (cmd === "!reset") {
    db.activePosition = null;
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
    console.log(`🔄 Perintah: Status posisi bot direset.`);
    msg.reply(
      "✅ Status posisi bot telah direset. Bot akan mulai mencari sinyal baru."
    );
  }

  if (cmd === "!status") {
    try {
      const price = await getPrice();
      const bal = await exchange.fetchBalance();
      const usdt = bal.total.USDT;
      const positions =
        bal.info?.positions?.filter((p) => parseFloat(p.positionAmt) !== 0) ||
        [];

      let posText = `*Posisi Terbuka di Binance:*`;
      if (positions.length === 0) {
        posText += `\n❌ Tidak ada posisi terbuka di akun Anda.`;
      } else {
        positions.forEach((pos) => {
          const side = parseFloat(pos.positionAmt) > 0 ? "LONG" : "SHORT";
          posText += `\n\n  *Pair:* ${pos.symbol}
  - Tipe: ${side}
  - PnL (Unrealized): ${parseFloat(pos.unrealizedProfit).toFixed(2)} USDT`;
        });
      }

      const lastLong = db.lastLongEntryTime
        ? new Date(db.lastLongEntryTime).toLocaleString()
        : "-";
      const lastShort = db.lastShortEntryTime
        ? new Date(db.lastShortEntryTime).toLocaleString()
        : "-";

      let msgText = `📊 *Status Bot Trading*\n
*Pair Bot:* ${db.pair}
*Harga Saat Ini:* ${formatPrice(price)}
*Saldo USDT:* ${usdt?.toFixed(2) || "N/A"} USDT
*Leverage:* ${db.leverage}x (${db.marginMode})
*USDT per Trade:* ${db.usdtPerTrade}
*Sinyal Terakhir:*
  - LONG: ${lastLong}
  - SHORT: ${lastShort}`;

      if (db.activePosition) {
        msgText += `\n\n*Posisi yang Dimonitor Bot:*
  - Tipe: ${db.activePosition.side.toUpperCase()}
  - Entry: ${formatPrice(db.activePosition.entryPrice)}
  - TP: ${db.activePosition.tp ? formatPrice(db.activePosition.tp) : "N/A"}
  - SL: ${db.activePosition.sl ? formatPrice(db.activePosition.sl) : "N/A"}`;
      } else {
        msgText += `\n\n*Posisi yang Dimonitor Bot:*
  - ❌ Tidak ada posisi yang dimonitor bot.`;
      }

      msgText += `\n\n${posText}`;

      await msg.reply(msgText);
      console.log("📤 WhatsApp: Laporan status dikirim.");
    } catch (err) {
      console.error("❌ WhatsApp: Gagal ambil status.", err.message);
      await msg.reply("⚠️ Error saat mengambil status bot.");
    }
  }
});

client.initialize();

app.get("/qr", async (req, res) => {
  if (isReady) return res.send("✅ WhatsApp sudah terhubung.");
  if (!currentQR) return res.send("⏳ Tunggu... QR code sedang dibuat.");
  const qrImage = await QRCode.toDataURL(currentQR);
  res.send(`<img src="${qrImage}" width="300" />`);
});

// -------------------- UTIL --------------------
const saveDB = () => fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
const mins = (ms) => ms / 1000 / 60;

const sendMsg = async (text) => {
  try {
    const chats = await client.getChats();
    const chat = chats.find(
      (c) => !c.isGroup && c.id.user.includes(process.env.ADMIN_PHONE)
    );
    if (chat) {
      await chat.sendMessage(text);
      console.log("📤 WhatsApp: Pesan terkirim.", text.split("\n")[0] + "...");
    }
  } catch (err) {
    console.error("❌ WhatsApp: Gagal mengirim pesan.", err.message);
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
    console.log(`💰 Data: Harga ${db.pair} = ${formatPrice(t.last)}.`);
    return t.last;
  } catch (e) {
    console.error("❌ Data: Gagal mengambil harga.", e.message);
    return null;
  }
};

const calcQty = (price) => {
  if (!price) return 0;
  let qty = db.usdtPerTrade / price;
  const prec = exchange.markets[db.pair]?.precision?.amount ?? 3;
  qty = parseFloat(qty.toFixed(prec));
  console.log(
    `📐 Kalkulasi: Kuantitas dihitung: ${qty} (${db.usdtPerTrade} USDT).`
  );
  return qty;
};

const logSignal = (type, entry, tp, sl, status) => {
  const line = `${new Date().toISOString()},${
    db.pair
  },${type},${entry},${tp},${sl},${status}\n`;
  fs.appendFileSync(logPath, line);
  console.log("📝 Log: Sinyal dicatat di log.csv");
};

// ---------- NEW HELPERS: market id & position fetch ----------
const getMarketId = () => {
  // Prefer ccxt's market id (exchange.markets[db.pair].id) if available
  try {
    const market = exchange.markets[db.pair];
    if (market && market.id) return market.id; // e.g. "XRPUSDT"
  } catch (e) {
    // ignore
  }
  // fallback: remove separators
  return db.pair.replace("/", "").replace(":", "");
};

const getPositionFromBalance = async () => {
  try {
    const bal = await exchange.fetchBalance();
    const marketId = getMarketId();
    const positions = bal.info?.positions || [];
    // Some exchanges have symbol or contractCode; try multiple keys
    const pos = positions.find((p) => {
      return [p.symbol, p.contractCode, p.comm, p.info, p.asset].some(
        (k) => false
      ); // noop
    });
    // Instead do safe find:
    let found = positions.find(
      (p) =>
        p.symbol === marketId ||
        p.contractCode === marketId ||
        (p.symbol && p.symbol.includes(marketId))
    );
    if (!found) {
      // try matching by removing non-alphanum
      const norm = (s) =>
        (s || "")
          .toString()
          .replace(/[^a-zA-Z0-9]/g, "")
          .toUpperCase();
      found = positions.find(
        (p) =>
          norm(p.symbol) === norm(marketId) ||
          norm(p.contractCode) === norm(marketId)
      );
    }
    return { balance: bal, position: found };
  } catch (err) {
    console.error("❌ Helper: Gagal ambil posisi dari balance.", err.message);
    return { balance: null, position: null };
  }
};

// -------------------- ORDER --------------------
const placeOrder = async (side, tp, sl) => {
  console.log("🔍 Order: Memeriksa apakah ada posisi aktif...");
  if (db.activePosition) {
    console.log(
      "⚠️ Order: Masih ada posisi terbuka yang dimonitor oleh bot, order dibatalkan."
    );
    await sendMsg(
      `⚠️ ${db.pair}: Masih ada posisi terbuka yang dimonitor bot. Order ${side} dibatalkan.`
    );
    return;
  }

  // Extra: pastikan tidak ada posisi yang aktif di account
  try {
    const { position } = await getPositionFromBalance();
    const amt = parseFloat(position?.positionAmt || "0");
    if (isFinite(amt) && Math.abs(amt) > 0) {
      console.log(
        "⚠️ Order: Terdapat posisi aktif di akun (detected). Order dibatalkan."
      );
      await sendMsg(
        `⚠️ ${db.pair}: Terdeteksi posisi aktif di akun. Order ${side} dibatalkan.`
      );
      return;
    }
  } catch (e) {
    console.warn("⚠️ Order: Gagal cek posisi live sebelum entry.", e.message);
  }

  const price = await getPrice();
  if (!price)
    return console.log("❌ Order: Gagal mendapatkan harga, order dibatalkan.");
  const qty = calcQty(price);

  console.log(`➡️ Order: ENTRY ${side.toUpperCase()}
  - Qty: ${qty}
  - Entry Price: ${formatPrice(price)}
  - TP: ${formatPrice(tp)}
  - SL: ${formatPrice(sl)}`);

  try {
    await exchange.setLeverage(db.leverage, db.pair);
    await exchange.setMarginMode(db.marginMode, db.pair);
    console.log("✅ Order: Leverage dan margin mode berhasil diatur.");
  } catch (e) {
    console.warn("⚠️ Order: Gagal mengatur leverage/margin mode.", e.message);
  }

  try {
    const order = await exchange.createOrder(db.pair, "market", side, qty);
    console.log("✅ Order: Entry market order berhasil dibuat.");

    // Simpan detail posisi di database
    db.activePosition = {
      side: side,
      entryPrice: price,
      tp: tp,
      sl: sl,
      offset: side === "buy" ? sig.longOffset : sig.shortOffset,
      orderId: order.id,
    };
    saveDB();

    await sendMsg(`✅ *Order Terkirim!*
*Pair:* ${db.pair}
*Tipe:* ${side.toUpperCase()}
*Entry:* ${formatPrice(price)}
*TP:* ${formatPrice(tp)}
*SL:* ${formatPrice(sl)}
*Leverage:* ${db.leverage}x
*Catatan:* TP & SL akan dimonitor oleh bot.`);

    logSignal(
      side === "buy" ? "LONG" : "SHORT",
      price,
      tp,
      sl,
      "ORDER_PLACED_MONITOR_BY_BOT"
    );
  } catch (e) {
    console.error("❌ Order: Gagal membuat order.", e.message);
    await sendMsg(`❌ *Gagal Membuat Order!*
*Pair:* ${db.pair}
*Tipe:* ${side.toUpperCase()}
*Pesan Error:* ${e.message}`);
  }
};

const closePosition = async (reason, entryPrice = "N/A") => {
  console.log(`🚨 Posisi: Menutup posisi karena ${reason}.`);
  try {
    const { position } = await getPositionFromBalance();
    const qty = parseFloat(position?.positionAmt || "0");

    if (!isFinite(qty) || Math.abs(qty) === 0) {
      console.log("ℹ️ Posisi: Tidak ada posisi yang perlu ditutup (qty=0).");
    } else {
      const side = qty > 0 ? "sell" : "buy";
      const amount = Math.abs(qty);
      // buat reduceOnly order untuk menutup
      await exchange.createOrder(db.pair, "market", side, amount, undefined, {
        reduceOnly: true,
      });
      console.log(
        `✅ Posisi: Order tutup posisi berhasil dibuat (side=${side}, amt=${amount}).`
      );

      const exitPrice = await getPrice();
      await sendMsg(`📉 *Posisi Ditutup!*
*Pair:* ${db.pair}
*Sebab:* ${reason}
*Harga Entry:* ${formatPrice(entryPrice)}
*Harga Exit:* ${formatPrice(exitPrice)}`);
    }
  } catch (err) {
    console.error("❌ Posisi: Gagal menutup posisi.", err.message);
    await sendMsg(`❌ *Gagal Menutup Posisi!*
*Pair:* ${db.pair}
*Sebab:* ${reason}
*Pesan Error:* ${err.message}`);
  } finally {
    // Reset status di database (pastikan bot tidak langsung open new order tanpa verifikasi posisi live)
    db.activePosition = null;
    saveDB();
  }
};

// -------------------- ANALYSIS --------------------
const analyzeSignal = async () => {
  console.log("🧠 Analisis: Melakukan analisis teknikal...");
  const ohlcv = await exchange.fetchOHLCV(db.pair, "15m", undefined, 200);
  if (!ohlcv || ohlcv.length < 200) {
    console.warn("⚠️ Analisis: Data OHLCV tidak cukup, menunggu...");
    return {};
  }
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
  const prev = ohlcv.at(-2);
  const prev2 = ohlcv.at(-3);

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

  const targetLong = Math.max(...high.slice(-50));
  const stopLossLong = Math.min(...low.slice(-50));
  const targetShort = Math.min(...low.slice(-50));
  const stopLossShort = Math.max(...high.slice(-50));

  // Hitung offset dari jarak antara TP dan SL
  const longOffset = targetLong - stopLossLong;
  const shortOffset = stopLossShort - targetShort;

  const canLong = scoreLong >= 3 && isAboveMA200;
  const canShort = scoreShort >= 3 && isBelowMA200;

  console.log(`\n📊 *Hasil Analisis ${db.pair}*`);
  console.log(`  - Harga: ${formatPrice(price)}`);
  console.log(`  - Sinyal Long: ${canLong ? "✅ VALID" : "❌ TIDAK VALID"}`);
  console.log(`  - Sinyal Short: ${canShort ? "✅ VALID" : "❌ TIDAK VALID"}`);
  console.log(`  --- Detail Indikator ---`);
  console.log(
    `  - RSI: ${rsi?.toFixed(2)} (${rsi < 35 ? "✅" : "❌"} Long | ${
      rsi > 65 ? "✅" : "❌"
    } Short)`
  );
  console.log(
    `  - MACD Hist: ${macd?.histogram?.toFixed(4)} (${
      macd?.histogram > 0 ? "✅" : "❌"
    } Long | ${macd?.histogram < 0 ? "✅" : "❌"} Short)`
  );
  console.log(
    `  - EMA20 vs EMA50: ${ema20?.toFixed(4)} vs ${ema50?.toFixed(4)} (${
      ema20 > ema50 ? "✅" : "❌"
    } Long | ${ema20 < ema50 ? "✅" : "❌"} Short)`
  );
  console.log(
    `  - MA200: ${ma200?.toFixed(4)} (Harga ${
      isAboveMA200 ? "✅ di atas" : "❌ di bawah"
    } | ${isBelowMA200 ? "✅ di bawah" : "❌ di atas"})`
  );
  console.log(
    `  - ADX: ${adx?.adx?.toFixed(2)} (${
      adx?.adx > 20 ? "✅" : "❌"
    } Tren Kuat)`
  );
  console.log(`  - Total Score: Long=${scoreLong} | Short=${scoreShort}`);
  console.log(`  ---`);

  return {
    canLong,
    canShort,
    targetLong,
    stopLossLong,
    targetShort,
    stopLossShort,
    longOffset,
    shortOffset,
    price,
  };
};

// -------------------- CEK POSISI (TP/SL trigger) --------------------
const checkPositionStatus = async () => {
  try {
    const { position } = await getPositionFromBalance();
    const amt = parseFloat(position?.positionAmt || "0");
    const amtSafe = isFinite(amt) ? amt : 0;

    // Deteksi penutupan posisi manual atau oleh Binance
    const prevSafe = isFinite(prevPosAmt) ? prevPosAmt : 0;
    if (prevSafe !== 0 && amtSafe === 0) {
      const side = prevSafe > 0 ? "LONG" : "SHORT";
      await sendMsg(`📉 *Posisi ${side} Ditutup!*
*Pair:* ${db.pair}
*Harga Exit:* (lihat di Binance)`);
      console.log(`📉 Posisi ${side} di ${db.pair} sudah ditutup.`);

      // Reset status di database jika posisi ditutup manual
      db.activePosition = null;
      saveDB();
    }

    // Monitoring internal untuk TP/SL dari data di database
    if (db.activePosition && amtSafe !== 0) {
      const { tp, sl, side, entryPrice } = db.activePosition;
      const currentPrice = await getPrice();
      if (!currentPrice) return;

      // --- LOGIKA TRAILING STOP LOSS DENGAN OFFSET DINAMIS ---
      if (side === "buy") {
        const newSL = currentPrice - offset;
        if (newSL > sl) {
          db.activePosition.sl = newSL;
          saveDB();
          await sendMsg(
            `📈 Trailing SL diperbarui untuk posisi LONG!\n*New SL:* ${formatPrice(
              newSL
            )}`
          );
        }
      } else if (side === "sell") {
        const newSL = currentPrice + offset;
        if (newSL < sl) {
          db.activePosition.sl = newSL;
          saveDB();
          await sendMsg(
            `📉 Trailing SL diperbarui untuk posisi SHORT!\n*New SL:* ${formatPrice(
              newSL
            )}`
          );
        }
      }

      if (side === "buy") {
        if (currentPrice >= tp) {
          await closePosition("TP tercapai", entryPrice);
        } else if (currentPrice <= sl) {
          await closePosition("SL tercapai", entryPrice);
        }
      } else if (side === "sell") {
        if (currentPrice <= tp) {
          await closePosition("TP tercapai", entryPrice);
        } else if (currentPrice >= sl) {
          await closePosition("SL tercapai", entryPrice);
        }
      }
    }

    prevPosAmt = amtSafe;
  } catch (err) {
    console.error("❌ Posisi: Gagal mengecek status posisi.", err.message);
  }
};

// -------------------- MAIN LOOP --------------------
setInterval(async () => {
  try {
    const now = new Date();
    const currentMinute = now.getMinutes();
    const isScheduledTime = currentMinute % 15 === 0;

    // PENTING: Selalu cek status posisi di Binance
    const { position } = await getPositionFromBalance();
    const amt = parseFloat(position?.positionAmt || "0");
    const hasActiveBinancePosition = isFinite(amt) && Math.abs(amt) > 0;
    await checkPositionStatus();

    console.log("🔍 Loop Utama: Memeriksa sinyal baru...");
    console.log("🔍 Status Posisi Aktif di DB: ", db.activePosition);

    // Hanya cari sinyal baru jika tidak ada posisi yang dimonitor
    if (db.activePosition === null && !hasActiveBinancePosition) {
      const now = Date.now();
      const sig = await analyzeSignal();
      if (!sig.price) {
        console.log("⚠️ Analisis: Sinyal tidak valid, menunggu...");
        return;
      }

      // const readyLong = !db.lastLongEntryTime || mins(now - db.lastLongEntryTime) >= COOLDOWN_MINUTES;
      // const readyShort = !db.lastShortEntryTime || mins(now - db.lastShortEntryTime) >= COOLDOWN_MINUTES;

      if (sig.canLong && isScheduledTime) {
        console.log(
          "🚀 Sinyal: Sinyal LONG valid dan bot siap, membuat order."
        );
        db.lastLongEntryTime = now;
        saveDB();
        await placeOrder("buy", sig.targetLong, sig.stopLossLong);
      }

      if (sig.canShort && isScheduledTime) {
        console.log(
          "📉 Sinyal: Sinyal SHORT valid dan bot siap, membuat order."
        );
        db.lastShortEntryTime = now;
        saveDB();
        await placeOrder("sell", sig.targetShort, sig.stopLossShort);
      }

      if (!sig.canLong && !sig.canShort) {
        console.log("💤 Sinyal: Tidak ada sinyal valid. Menunggu...");
      }
    } else {
      console.log(
        "➡️ Loop Utama: Posisi aktif terdeteksi. Melewatkan analisis sinyal."
      );
    }
  } catch (e) {
    console.error("⚠️ Loop: Terjadi kesalahan di loop utama.", e.message);
    console.error(e.stack);
  }
}, 10000);
