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

const COOLDOWN_MINUTES = 1;
const USDT_PER_TRADE = 5.1;

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
      activePosition: null 
    };

let prevPosAmt = 0;

console.log(`⚙️ Konfigurasi Bot:`);
console.log(`   - Pair Aktif: ${db.pair}`);
console.log(`   - Leverage: ${db.leverage}x`);
console.log(`   - Margin Mode: ${db.marginMode}`);

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
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  },
});

app.listen(serverPort, () => console.log(`🟢 Server: QR server aktif di http://localhost:${serverPort}/qr`));

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
      return msg.reply("⚠️ Format salah. Gunakan: *!pair [SIMBOL]*, contoh: *!pair BTC/USDT:USDT*");
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
      return msg.reply("⚠️ Format salah. Gunakan: *!leverage [1-125] [isolated/crossed]*");
    }
    if (newMarginMode && !validModes.includes(newMarginMode)) {
      return msg.reply(`⚠️ Margin mode tidak valid. Pilihan: *${validModes.join(" atau ")}*.`);
    }
    
    db.leverage = newLeverage;
    if (newMarginMode) db.marginMode = newMarginMode;
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

    let replyMsg = `✅ Pengaturan berhasil diperbarui:\n\n*Leverage:* ${db.leverage}x`;
    if (newMarginMode) replyMsg += `\n*Margin Mode:* ${db.marginMode}`;

    console.log(`🔄 Perintah: Leverage/margin mode diganti ke ${db.leverage}x (${db.marginMode}).`);
    msg.reply(replyMsg);
  }

  if (cmd === "!status") {
    try {
      const price = await getPrice();
      const bal = await exchange.fetchBalance();
      const usdt = bal.total.USDT;
      const pos = bal.info?.positions?.find((p) => p.symbol === db.pair.replace("/", ""));
      let posText = "❌ Tidak ada posisi terbuka.";
      let posDetails = "";
      if (pos && parseFloat(pos.positionAmt) !== 0) {
        const side = parseFloat(pos.positionAmt) > 0 ? "LONG" : "SHORT";
        posText = `✅ OPEN *${side}*`;
        posDetails = `\n  - Jumlah: ${pos.positionAmt} ${pos.symbol}
  - Entry: ${formatPrice(pos.entryPrice)}
  - PnL (Unrealized): ${parseFloat(pos.unrealizedProfit).toFixed(2)} USDT`;
      }
      const lastLong = db.lastLongEntryTime ? new Date(db.lastLongEntryTime).toLocaleString() : "-";
      const lastShort = db.lastShortEntryTime ? new Date(db.lastShortEntryTime).toLocaleString() : "-";

      let msgText = `📊 *Status Bot Trading*\n
*Pair:* ${db.pair}
*Harga Saat Ini:* ${formatPrice(price)}
*Saldo USDT:* ${usdt?.toFixed(2) || "N/A"} USDT
*Posisi:* ${posText}${posDetails}
*Leverage:* ${db.leverage}x (${db.marginMode})
*Sinyal Terakhir:*
  - LONG: ${lastLong}
  - SHORT: ${lastShort}`;
  
      if (db.activePosition) {
        msgText += `\n*Detail Posisi Bot:*
  - Tipe: ${db.activePosition.side.toUpperCase()}
  - Entry: ${formatPrice(db.activePosition.entryPrice)}
  - TP: ${formatPrice(db.activePosition.tp)}
  - SL: ${formatPrice(db.activePosition.sl)}`;
      }

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
    const chat = chats.find((c) => !c.isGroup && c.id.user.includes(process.env.ADMIN_PHONE));
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
  let qty = USDT_PER_TRADE / price;
  const prec = exchange.markets[db.pair]?.precision?.amount ?? 3;
  qty = parseFloat(qty.toFixed(prec));
  console.log(`📐 Kalkulasi: Kuantitas dihitung: ${qty} (${USDT_PER_TRADE} USDT).`);
  return qty;
};

const hasOpenPosition = async () => {
  try {
    const bal = await exchange.fetchBalance();
    const pos = bal.info?.positions?.find((p) => p.symbol === db.pair.replace("/", ""));
    const open = pos && parseFloat(pos.positionAmt) !== 0;
    console.log(`🔍 Posisi: Cek posisi terbuka: ${open ? "ADA" : "TIDAK ADA"}.`);
    return open;
  } catch (err) {
    console.error("❌ Posisi: Gagal mengecek posisi.", err.message);
    return false;
  }
};

const logSignal = (type, entry, tp, sl, status = "SIGNAL_SENT") => {
  const timestamp = new Date().toISOString();
  const line = `${timestamp},${db.pair},${type},${entry},${tp},${sl},${status}\n`;
  fs.appendFileSync(logPath, line);
  console.log(`📝 Log: Sinyal '${type}' dicatat.`);
};

// -------------------- ORDER --------------------
const placeOrder = async (side, tp, sl) => {
  console.log("🔍 Order: Memeriksa apakah ada posisi aktif...");
  if (db.activePosition) {
    console.log("⚠️ Order: Masih ada posisi terbuka yang dimonitor oleh bot, order dibatalkan.");
    await sendMsg(`⚠️ ${db.pair}: Masih ada posisi terbuka yang dimonitor bot. Order ${side} dibatalkan.`);
    return;
  }
  const price = await getPrice();
  if (!price) return console.log("❌ Order: Gagal mendapatkan harga, order dibatalkan.");
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

    logSignal(side === "buy" ? "LONG" : "SHORT", price, tp, sl, "ORDER_PLACED_MONITOR_BY_BOT");

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
    const bal = await exchange.fetchBalance();
    const pos = bal.info?.positions?.find((p) => p.symbol === db.pair.replace("/", ""));
    const qty = parseFloat(pos?.positionAmt);

    if (qty !== 0) {
      const side = qty > 0 ? "sell" : "buy";
      await exchange.createOrder(db.pair, "market", side, Math.abs(qty), undefined, { reduceOnly: true });
      console.log(`✅ Posisi: Order tutup posisi berhasil dibuat.`);
      
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
    // Reset status di database
    db.activePosition = null;
    saveDB();
  }
}

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
  const macd = MACD.calculate({ values: close.slice(-50), fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }).pop();
  const adx = ADX.calculate({ close: close.slice(-50), high: high.slice(-50), low: low.slice(-50), period: 14 }).pop();

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

  const targetLong = Math.max(...high.slice(-20));
  const stopLossLong = Math.min(...low.slice(-20));
  const targetShort = Math.min(...low.slice(-20));
  const stopLossShort = Math.max(...high.slice(-20));

  const canLong = scoreLong >= 3 && isAboveMA200;
  const canShort = scoreShort >= 3 && isBelowMA200;

  console.log(`\n📊 *Hasil Analisis ${db.pair}*`);
  console.log(`  - Harga: ${formatPrice(price)}`);
  console.log(`  - Sinyal Long: ${canLong ? "✅ VALID" : "❌ TIDAK VALID"}`);
  console.log(`  - Sinyal Short: ${canShort ? "✅ VALID" : "❌ TIDAK VALID"}`);
  console.log(`  --- Detail Indikator ---`);
  console.log(`  - RSI: ${rsi?.toFixed(2)} (${rsi < 35 ? '✅' : '❌'} Long | ${rsi > 65 ? '✅' : '❌'} Short)`);
  console.log(`  - MACD Hist: ${macd?.histogram?.toFixed(4)} (${macd?.histogram > 0 ? '✅' : '❌'} Long | ${macd?.histogram < 0 ? '✅' : '❌'} Short)`);
  console.log(`  - EMA20 vs EMA50: ${ema20?.toFixed(4)} vs ${ema50?.toFixed(4)} (${ema20 > ema50 ? '✅' : '❌'} Long | ${ema20 < ema50 ? '✅' : '❌'} Short)`);
  console.log(`  - MA200: ${ma200?.toFixed(4)} (Harga ${isAboveMA200 ? '✅ di atas' : '❌ di bawah'} | ${isBelowMA200 ? '✅ di bawah' : '❌ di atas'})`);
  console.log(`  - ADX: ${adx?.adx?.toFixed(2)} (${adx?.adx > 20 ? '✅' : '❌'} Tren Kuat)`);
  console.log(`  - Total Score: Long=${scoreLong} | Short=${scoreShort}`);
  console.log(`  ---`);

  return {
    canLong,
    canShort,
    targetLong,
    stopLossLong,
    targetShort,
    stopLossShort,
    price,
  };
};

// -------------------- CEK POSISI (TP/SL trigger) --------------------
const checkPositionStatus = async () => {
  try {
    const bal = await exchange.fetchBalance();
    const pos = bal.info?.positions?.find((p) => p.symbol === db.pair.replace("/", ""));
    const amt = parseFloat(pos?.positionAmt || 0);

    // Deteksi penutupan posisi manual atau oleh Binance
    if (prevPosAmt !== 0 && amt === 0) {
      const side = prevPosAmt > 0 ? "LONG" : "SHORT";
      const exitPrice = pos?.entryPrice || "N/A";
      await sendMsg(`📉 *Posisi ${side} Ditutup!*
*Pair:* ${db.pair}
*Harga Exit:* ${exitPrice}`);
      console.log(`📉 Posisi ${side} di ${db.pair} sudah ditutup.`);
      
      // Reset status di database jika posisi ditutup manual
      db.activePosition = null;
      saveDB();
    }

    // Monitoring internal untuk TP/SL dari data di database
    if (db.activePosition && amt !== 0) {
      const { tp, sl, side, entryPrice } = db.activePosition;
      const currentPrice = await getPrice();
      if (!currentPrice) return;

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

    prevPosAmt = amt;
  } catch (err) {
    console.error("❌ Posisi: Gagal mengecek status posisi.", err.message);
  }
};

// -------------------- MAIN LOOP --------------------
setInterval(async () => {
  try {
    await checkPositionStatus();
    
    console.log("🔍 Loop Utama: Memeriksa sinyal baru...");
    console.log("🔍 Status Posisi Aktif di DB: ", db.activePosition);

    // Hanya cari sinyal baru jika tidak ada posisi yang dimonitor
    if (db.activePosition === null) {
      const now = Date.now();
      const sig = await analyzeSignal();
      if (!sig.price) {
        console.log("⚠️ Analisis: Sinyal tidak valid, menunggu...");
        return;
      }

      const readyLong = !db.lastLongEntryTime || mins(now - db.lastLongEntryTime) >= COOLDOWN_MINUTES;
      const readyShort = !db.lastShortEntryTime || mins(now - db.lastShortEntryTime) >= COOLDOWN_MINUTES;
      
      if (sig.canLong && readyLong) {
        console.log("🚀 Sinyal: Sinyal LONG valid dan bot siap, membuat order.");
        db.lastLongEntryTime = now;
        saveDB();
        await placeOrder("buy", sig.targetLong, sig.stopLossLong);
      }

      if (sig.canShort && readyShort) {
        console.log("📉 Sinyal: Sinyal SHORT valid dan bot siap, membuat order.");
        db.lastShortEntryTime = now;
        saveDB();
        await placeOrder("sell", sig.targetShort, sig.stopLossShort);
      }
      
      if (!sig.canLong && !sig.canShort) {
          console.log("💤 Sinyal: Tidak ada sinyal valid. Menunggu...");
      }
    } else {
      console.log("➡️ Loop Utama: Posisi aktif terdeteksi. Melewatkan analisis sinyal.");
    }

  } catch (e) {
    console.error("⚠️ Loop: Terjadi kesalahan di loop utama.", e.message);
    console.error(e.stack);
  }
}, 10000);
