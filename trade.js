/**
 * @fileoverview Trading bot menggunakan ccxt untuk Binance Futures, indikator teknikal, dan WhatsApp-web.js.
 * @author Kode asli oleh [Nama Penulis Asli]
 * @version 2.0.0
 */

require("dotenv").config();
const fs = require("fs");
const ccxt = require("ccxt");
const { SMA } = require("technicalindicators");
const { Client, LocalAuth } = require("whatsapp-web.js");
const express = require("express");
const QRCode = require("qrcode");

// -------------------- KONFIGURASI --------------------
const app = express();
const dbPath = "./db.json";
const logPath = "./log.csv";
const serverPort = 7890;

const db = fs.existsSync(dbPath)
  ? JSON.parse(fs.readFileSync(dbPath, "utf8"))
  : {
      pair: "XRP/USDT:USDT",
      lastLongEntryTime: 0,
      lastShortEntryTime: 0,
      leverage: 10,
      marginMode: "ISOLATED",
      activePosition: null,
      usdtPerTrade: 5.1,
    };

let previousPositionAmount = 0;
let currentQR = null;
let isWhatsappReady = false;

// -------------------- INISIALISASI & PENGATURAN --------------------

// Inisialisasi file log
if (!fs.existsSync(logPath)) {
  fs.writeFileSync(logPath, "timestamp,pair,type,entry,tp,sl,status,pnl\n");
  console.log("📝 Log: File `log.csv` berhasil dibuat.");
}

// Catat konfigurasi bot
console.log("⚙️ Konfigurasi Bot:");
console.log(`   - Pair Aktif: ${db.pair}`);
console.log(`   - Leverage: ${db.leverage}x`);
console.log(`   - Mode Margin: ${db.marginMode}`);
console.log(`   - USDT per Trade: ${db.usdtPerTrade}`);

// Inisialisasi CCXT Exchange
const exchange = new ccxt.binance({
  apiKey: process.env.API_KEY,
  secret: process.env.API_SECRET,
  options: { defaultType: "future" },
});

// Muat pasar saat startup
(async () => {
  try {
    await exchange.loadMarkets();
    console.log("✅ Bursa: Pasar berhasil dimuat.");
  } catch (err) {
    console.error("❌ Bursa: Gagal memuat pasar.", err.message);
  }
})();

// Inisialisasi Klien WhatsApp
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
  console.log(
    `🟢 Server: Server QR aktif di http://localhost:${serverPort}/qr`
  )
);

client.on("qr", (qr) => {
  currentQR = qr;
  isWhatsappReady = false;
  console.log("📲 WhatsApp: Kode QR baru siap untuk dipindai.");
});

client.on("ready", () => {
  isWhatsappReady = true;
  currentQR = null;
  console.log("✅ WhatsApp: Koneksi berhasil.");
});

client.on("disconnected", (reason) => {
  console.log("❌ WhatsApp: Terputus, bot akan mati.", reason);
  process.exit();
});

// -------------------- FUNGSI BANTU --------------------

/**
 * Menyimpan status database saat ini ke `db.json`.
 */
const saveDB = () => fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

/**
 * Mengirim pesan melalui WhatsApp ke admin.
 * @param {string} text - Pesan yang akan dikirim.
 */
const sendMessage = async (text) => {
  try {
    const chats = await client.getChats();
    const adminChat = chats.find(
      (c) => !c.isGroup && c.id.user.includes(process.env.ADMIN_PHONE)
    );
    if (adminChat) {
      await adminChat.sendMessage(text);
      console.log("📤 WhatsApp: Pesan terkirim.", text.split("\n")[0] + "...");
    }
  } catch (err) {
    console.error("❌ WhatsApp: Gagal mengirim pesan.", err.message);
  }
};

/**
 * Memformat nilai harga ke presisi yang benar untuk pasangan trading.
 * @param {number} price - Harga untuk diformat.
 * @param {string} pair - Simbol pasangan trading.
 * @returns {string} String harga yang diformat.
 */
const formatPrice = (price, pair = db.pair) => {
  if (!price || !isFinite(price)) return "N/A";
  const market = exchange.markets[pair];
  let decimals = market?.precision?.price ?? 5;
  if (decimals <= 0 || price < 1) decimals = 5;
  return price.toFixed(decimals);
};

/**
 * Mengambil harga ticker saat ini untuk pasangan trading aktif.
 * @returns {Promise<number|null>} Harga terakhir, atau null jika terjadi kesalahan.
 */
const getPrice = async () => {
  try {
    const ticker = await exchange.fetchTicker(db.pair);
    console.log(`💰 Data: Harga ${db.pair} = ${formatPrice(ticker.last)}.`);
    return ticker.last;
  } catch (e) {
    console.error("❌ Data: Gagal mengambil harga.", e.message);
    return null;
  }
};

/**
 * Menghitung kuantitas aset yang akan diperdagangkan berdasarkan jumlah USDT yang dikonfigurasi.
 * @param {number} price - Harga aset saat ini.
 * @returns {number} Kuantitas yang dihitung.
 */
const calculateQuantity = (price) => {
  if (!price) return 0;
  let quantity = db.usdtPerTrade / price;
  const precision = exchange.markets[db.pair]?.precision?.amount ?? 3;
  quantity = parseFloat(quantity.toFixed(precision));
  console.log(
    `📐 Perhitungan: Kuantitas dihitung: ${quantity} (${db.usdtPerTrade} USDT).`
  );
  return quantity;
};

/**
 * Mencatat sinyal ke file `log.csv`.
 * @param {string} type - 'LONG' atau 'SHORT'.
 * @param {number} entry - Harga entry.
 * @param {number} tp - Harga Take Profit.
 * @param {number} sl - Harga Stop Loss.
 * @param {string} status - Status trade (misalnya, 'ORDER_PLACED', 'TP_REALIZED').
 * @param {number|null} pnl - PnL trade, jika berlaku.
 */
const logSignal = (type, entry, tp, sl, status, pnl = null) => {
  const entryStr = entry !== undefined && entry !== null ? entry : "";
  const tpStr = tp !== undefined && tp !== null ? tp : "";
  const slStr = sl !== undefined && sl !== null ? sl : "";
  const pnlStr = pnl !== null && isFinite(pnl) ? Number(pnl).toFixed(6) : "";
  const line = `${new Date().toISOString()},${db.pair},${type},${entryStr},${tpStr},${slStr},${status},${pnlStr}\n`;
  fs.appendFileSync(logPath, line);
  console.log("📝 Log: Sinyal dicatat di `log.csv`.");
};

/**
 * Mengambil ID pasar untuk pasangan saat ini.
 * @returns {string} ID pasar (misalnya, "XRPUSDT").
 */
const getMarketId = () => {
  try {
    const market = exchange.markets[db.pair];
    if (market && market.id) return market.id;
  } catch (e) {
    // Abaikan
  }
  return db.pair.replace("/", "").replace(":", "");
};

/**
 * Mengambil detail posisi saat ini dari bursa.
 * @returns {Promise<{balance: object|null, position: object|null}>}
 */
const getPositionFromBalance = async () => {
  try {
    const balance = await exchange.fetchBalance();
    const marketId = getMarketId();
    const positions = balance.info?.positions || [];
    const position = positions.find(
      (p) =>
        p.symbol === marketId ||
        p.contractCode === marketId ||
        (p.symbol && p.symbol.includes(marketId))
    );
    return { balance, position };
  } catch (err) {
    console.error("❌ Helper: Gagal mendapatkan posisi dari saldo.", err.message);
    return { balance: null, position: null };
  }
};

// -------------------- HANDLER PESAN WHATSAPP --------------------
client.on("message", async (msg) => {
  if (!msg.from.includes(process.env.ADMIN_PHONE)) return;
  const [command, ...args] = msg.body.toLowerCase().split(" ");

  switch (command) {
    case "!pair":
      const newPair = args[0]?.toUpperCase();
      if (!newPair) {
        return msg.reply(
          "⚠️ Format tidak valid. Gunakan: `!pair [SIMBOL]`, contoh: `!pair BTC/USDT:USDT`"
        );
      }
      db.pair = newPair;
      db.lastLongEntryTime = 0;
      db.lastShortEntryTime = 0;
      saveDB();
      console.log(`🔄 Perintah: Pasangan diubah ke ${db.pair}.`);
      msg.reply(`✅ Pasangan trading berhasil diubah ke *${db.pair}*.`);
      break;

    case "!leverage":
      const newLeverage = parseInt(args[0]);
      const newMarginMode = args[1]?.toUpperCase();
      const validModes = ["ISOLATED", "CROSSED"];
      if (!newLeverage || newLeverage < 1 || newLeverage > 125) {
        return msg.reply(
          "⚠️ Format tidak valid. Gunakan: `!leverage [1-125] [isolated/crossed]`"
        );
      }
      if (newMarginMode && !validModes.includes(newMarginMode)) {
        return msg.reply(
          `⚠️ Mode margin tidak valid. Pilihan: *${validModes.join(" atau ")}*.`
        );
      }
      db.leverage = newLeverage;
      if (newMarginMode) db.marginMode = newMarginMode;
      saveDB();
      let replyMsg = `✅ Pengaturan berhasil diperbarui:\n\n*Leverage:* ${db.leverage}x`;
      if (newMarginMode) replyMsg += `\n*Mode Margin:* ${db.marginMode}`;
      console.log(
        `🔄 Perintah: Leverage/mode margin diubah ke ${db.leverage}x (${db.marginMode}).`
      );
      msg.reply(replyMsg);
      break;

    case "!order":
      const newAmount = parseFloat(args[0]);
      if (isNaN(newAmount) || newAmount <= 0) {
        return msg.reply(
          "⚠️ Format tidak valid. Gunakan: `!order [JUMLAH]`, contoh: `!order 10.5`"
        );
      }
      db.usdtPerTrade = newAmount;
      saveDB();
      console.log(
        `🔄 Perintah: Jumlah USDT per trade diubah ke ${db.usdtPerTrade}.`
      );
      msg.reply(
        `✅ Jumlah USDT per trade berhasil diubah ke *${db.usdtPerTrade} USDT*.`
      );
      break;

    case "!reset":
      db.activePosition = null;
      saveDB();
      console.log(`🔄 Perintah: Status posisi bot direset.`);
      msg.reply(
        "✅ Status posisi bot telah direset. Bot sekarang akan mencari sinyal baru."
      );
      break;

    case "!pnl":
      try {
        if (!fs.existsSync(logPath)) {
          return msg.reply("ℹ️ File log tidak ditemukan (`log.csv` tidak ada).");
        }
        const raw = fs.readFileSync(logPath, "utf8");
        const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
        const dataLines = lines.slice(1);
        let tpCount = 0, slCount = 0;
        let tpSum = 0, slSum = 0;
        let netSum = 0;
        const recentTrades = [];

        dataLines.forEach((line) => {
          const parts = line.split(",");
          if (parts.length < 7) return;
          const status = parts[6]?.trim() || "";
          const pnl = parseFloat(parts[7]?.trim());
          if (isNaN(pnl)) return;

          if (/TP_REALIZED/i.test(status)) {
            tpCount++;
            tpSum += pnl;
          } else if (/SL_REALIZED/i.test(status)) {
            slCount++;
            slSum += pnl;
          }
          netSum += pnl;

          if (/TP_REALIZED|SL_REALIZED/i.test(status)) {
            recentTrades.push({ time: parts[0], status, pnl });
          }
        });

        const avgTp = tpCount ? tpSum / tpCount : 0;
        const avgSl = slCount ? slSum / slCount : 0;
        let reply = `📊 *Ringkasan PnL*\n\n*TP (Terealisasi):*\n${tpCount} trade\nTotal: ${tpSum.toFixed(4)} USDT\nRata-rata: ${avgTp.toFixed(4)} USDT\n*SL (Terealisasi):*\n${slCount} trade\nTotal: ${slSum.toFixed(4)} USDT\nRata-rata: ${avgSl.toFixed(4)} USDT\n\n*PnL Bersih:* ${netSum >= 0 ? "+" : ""}${netSum.toFixed(4)} USDT`;

        if (recentTrades.length > 0) {
          const last5 = recentTrades.slice(-5).reverse();
          reply += `\n\n*5 Trade Terealisasi Terakhir:*\n`;
          last5.forEach((trade) => {
            reply += `\n- ${trade.time.split("T")[0]} ${trade.status} PnL:${
              trade.pnl >= 0 ? "+" : ""
            }${trade.pnl.toFixed(4)} USDT`;
          });
        }
        await msg.reply(reply);
      } catch (e) {
        console.error("❌ Error with `!pnl` command:", e.message);
        await msg.reply("⚠️ Terjadi kesalahan saat menghitung PnL.");
      }
      break;

    case "!status":
      try {
        const price = await getPrice();
        const balance = await exchange.fetchBalance();
        const usdt = balance.total.USDT;
        const binancePositions =
          balance.info?.positions?.filter(
            (p) => parseFloat(p.positionAmt) !== 0
          ) || [];

        let positionText = `*Posisi Terbuka di Binance:*`;
        if (binancePositions.length === 0) {
          positionText += `\n❌ Tidak ada posisi terbuka di akun Anda.`;
        } else {
          binancePositions.forEach((pos) => {
            const side = parseFloat(pos.positionAmt) > 0 ? "LONG" : "SHORT";
            positionText += `\n\n*Pair:* ${pos.symbol}\n*Tipe:* ${side}\n*PnL (Belum Terealisasi):* ${parseFloat(pos.unrealizedProfit).toFixed(2)} USDT`;
          });
        }

        const lastLong = db.lastLongEntryTime
          ? new Date(db.lastLongEntryTime).toLocaleString()
          : "N/A";
        const lastShort = db.lastShortEntryTime
          ? new Date(db.lastShortEntryTime).toLocaleString()
          : "N/A";

        let statusText = `📊 *Status Bot Trading*\n\n*Pair Bot:* ${db.pair}\n*Harga Saat Ini:* ${formatPrice(price)}\n*Saldo USDT:* ${usdt?.toFixed(2) || "N/A"} USDT\n*Leverage:* ${db.leverage}x (${db.marginMode})\n*USDT per Trade:* ${db.usdtPerTrade}\n*Sinyal Terakhir:*\nLONG: ${lastLong}\nSHORT: ${lastShort}`;

        if (db.activePosition) {
          statusText += `\n\n*Posisi yang Dipantau oleh Bot:*\n*Tipe:* ${db.activePosition.side.toUpperCase()}\n*Entry:* ${formatPrice(db.activePosition.entryPrice)}\n*TP:* ${db.activePosition.tp ? formatPrice(db.activePosition.tp) : "N/A"}\n*SL:* ${db.activePosition.sl ? formatPrice(db.activePosition.sl) : "N/A"}`;
        } else {
          statusText += `\n\n*Posisi yang Dipantau oleh Bot:*\n❌ Tidak ada posisi yang dipantau oleh bot.`;
        }

        statusText += `\n\n${positionText}`;
        await msg.reply(statusText);
        console.log("📤 WhatsApp: Laporan status terkirim.");
      } catch (err) {
        console.error("❌ WhatsApp: Gagal mendapatkan status.", err.message);
        await msg.reply("⚠️ Terjadi kesalahan saat mengambil status bot.");
      }
      break;
  }
});

// -------------------- LOGIKA TRADING --------------------

/**
 * Melakukan analisis teknikal untuk menghasilkan sinyal trading.
 * @returns {Promise<object>} Objek yang berisi validitas sinyal, harga, TP, dan level SL.
 */
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

  // Hitung SMA
  const ma7 = SMA.calculate({ values: close.slice(-100), period: 7 }).pop();
  const ma25 = SMA.calculate({ values: close.slice(-100), period: 25 }).pop();
  const ma99 = SMA.calculate({ values: close, period: 99 }).pop();
  const price = close.at(-1);

  // Periksa persilangan SMA
  const previousMA7 = SMA.calculate({ values: close.slice(-101, -1), period: 7 }).pop();
  const previousMA25 = SMA.calculate({ values: close.slice(-101, -1), period: 25 }).pop();
  const isCrossedUp = ma7 > ma25 && previousMA7 <= previousMA25;
  const isCrossedDown = ma7 < ma25 && previousMA7 >= previousMA25;
  const isPriceAboveMA99 = price > ma99;
  const isPriceBelowMA99 = price < ma99;

  let canLong = isCrossedUp && isPriceAboveMA99;
  let canShort = isCrossedDown && isPriceBelowMA99;

  // Hitung level TP dan SL berdasarkan high/low terbaru
  const targetLong = Math.max(...high.slice(-16));
  const stopLossLong = Math.min(...low.slice(-16));
  const targetShort = Math.min(...low.slice(-16));
  const stopLossShort = Math.max(...high.slice(-16));

  const longOffset = targetLong - stopLossLong;
  const shortOffset = stopLossShort - targetShort;
  const midPriceLong = (targetLong + stopLossLong) / 2;
  const midPriceShort = (targetShort + stopLossShort) / 2;

  console.log(`\n📊 *Hasil Analisis untuk ${db.pair}*`);
  console.log(`  - Sinyal Long: ${canLong ? "✅ VALID" : "❌ TIDAK VALID"}`);
  console.log(`  - Sinyal Short: ${canShort ? "✅ VALID" : "❌ TIDAK VALID"}`);
  console.log(`  --- Detail Indikator ---`);
  console.log(`  - Persilangan SMA: ${isCrossedUp ? "✅ MA7 Memotong MA25 ke Atas" : isCrossedDown ? "✅ MA7 Memotong MA25 ke Bawah" : "❌ Tidak Ada"}`);
  console.log(`  - Harga vs MA99: ${isPriceAboveMA99 ? "✅ Harga di atas MA99 (Tren Naik)" : "❌ Harga di bawah MA99 (Tren Turun)"}`);
  console.log(`  - Harga Saat Ini: ${formatPrice(price)}`);
  console.log(`  - Target Long: ${formatPrice(targetLong)}`);
  console.log(`  - Stop Loss Long: ${formatPrice(stopLossLong)}`);
  console.log(`  - Target Short: ${formatPrice(targetShort)}`);
  console.log(`  - Stop Loss Short: ${formatPrice(stopLossShort)}`);
  console.log(`  ---`);

  return {
    canLong,
    canShort,
    targetLong,
    stopLossLong,
    targetShort,
    stopLossShort,
    longOffset,
    shortOffset,
    midPriceLong,
    midPriceShort,
    price,
  };
};

/**
 * Menempatkan order pasar di bursa.
 * @param {string} side - 'buy' atau 'sell'.
 * @param {number} tp - Harga Take Profit.
 * @param {number} sl - Harga Stop Loss.
 * @param {number} offset - Offset dinamis untuk trailing SL.
 * @param {number} targetEntryPrice - Harga untuk diperiksa sebelum entry.
 */
const placeOrder = async (side, tp, sl, offset, targetEntryPrice) => {
  console.log("🔍 Order: Memeriksa posisi aktif...");
  if (db.activePosition) {
    console.log("⚠️ Order: Posisi aktif sudah dipantau, order dibatalkan.");
    await sendMessage(
      `⚠️ ${db.pair}: Posisi aktif sedang dipantau. Order ${side} dibatalkan.`
    );
    return;
  }
  try {
    const { position } = await getPositionFromBalance();
    const amount = parseFloat(position?.positionAmt || "0");
    if (isFinite(amount) && Math.abs(amount) > 0) {
      console.log("⚠️ Order: Posisi aktif terdeteksi di akun. Order dibatalkan.");
      await sendMessage(
        `⚠️ ${db.pair}: Posisi aktif terdeteksi di akun. Order ${side} dibatalkan.`
      );
      return;
    }
  } catch (e) {
    console.warn("⚠️ Order: Gagal memeriksa posisi live sebelum entry.", e.message);
  }

  const price = await getPrice();
  if (!price) {
    console.log("❌ Order: Gagal mendapatkan harga, order dibatalkan.");
    return;
  }
  let isEntryConditionMet = false;
  if ((side === "buy" && price <= targetEntryPrice) || (side === "sell" && price >= targetEntryPrice)) {
    isEntryConditionMet = true;
  }
  if (!isEntryConditionMet) {
    console.log(`⚠️ Order: Kondisi entry tidak terpenuhi untuk ${side}. Harga saat ini ${formatPrice(price)} tidak di sisi yang diinginkan dari target entry ${formatPrice(targetEntryPrice)}. Order dibatalkan.`);
    return;
  }

  const quantity = calculateQuantity(price);
  console.log(`➡️ Order: ENTRY ${side.toUpperCase()}\n- Qty: ${quantity}\n- Harga Entry: ${formatPrice(price)}\n- TP: ${formatPrice(tp)}\n- SL: ${formatPrice(sl)}`);

  try {
    await exchange.setLeverage(db.leverage, db.pair);
    await exchange.setMarginMode(db.marginMode, db.pair);
    console.log("✅ Order: Leverage dan mode margin berhasil diatur.");
    const order = await exchange.createOrder(db.pair, "market", side, quantity);
    console.log("✅ Order: Order pasar berhasil dibuat.");

    db.activePosition = {
      side,
      entryPrice: price,
      tp,
      sl,
      offset,
      orderId: order.id,
    };
    saveDB();

    await sendMessage(`✅ *Order Terkirim!*
*Pair:* ${db.pair}
*Tipe:* ${side.toUpperCase()}
*Entry:* ${formatPrice(price)}
*TP:* ${formatPrice(tp)}
*SL:* ${formatPrice(sl)}
*Leverage:* ${db.leverage}x
*Catatan:* TP & SL akan dipantau oleh bot.`);

    logSignal(side === "buy" ? "LONG" : "SHORT", price, tp, sl, "ORDER_PLACED_MONITOR_BY_BOT");
  } catch (e) {
    console.error("❌ Order: Gagal membuat order.", e.message);
    await sendMessage(`❌ *Gagal Membuat Order!*
*Pair:* ${db.pair}
*Tipe:* ${side.toUpperCase()}
*Pesan Error:* ${e.message}`);
  }
};

/**
 * Menutup posisi aktif di bursa.
 * @param {string} reason - Alasan untuk menutup posisi (misalnya, 'TP reached', 'SL reached').
 * @param {number|string} [entryPrice='N/A'] - Harga entry dari posisi yang ditutup.
 */
const closePosition = async (reason, entryPrice = "N/A") => {
  console.log(`🚨 Posisi: Menutup posisi karena ${reason}.`);
  try {
    const { position } = await getPositionFromBalance();
    const quantity = parseFloat(position?.positionAmt || "0");
    if (!isFinite(quantity) || Math.abs(quantity) === 0) {
      console.log("ℹ️ Posisi: Tidak ada posisi untuk ditutup (kuantitas nol).");
      return;
    }
    const side = quantity > 0 ? "sell" : "buy";
    const amount = Math.abs(quantity);
    await exchange.createOrder(db.pair, "market", side, amount, undefined, { reduceOnly: true });
    console.log(`✅ Posisi: Order penutupan berhasil dibuat (sisi=${side}, jumlah=${amount}).`);
    const exitPrice = await getPrice();
    let pnl = null;
    if (entryPrice !== "N/A" && isFinite(exitPrice) && isFinite(entryPrice)) {
      const entryNum = Number(entryPrice);
      const exitNum = Number(exitPrice);
      if (side === "sell") {
        pnl = (exitNum - entryNum) * amount;
      } else {
        pnl = (entryNum - exitNum) * amount;
      }
    }
    let message = `📉 *Posisi Ditutup!*
*Pair:* ${db.pair}
*Alasan:* ${reason}
*Harga Entry:* ${formatPrice(entryPrice)}
*Harga Exit:* ${formatPrice(exitPrice)}`;
    if (pnl !== null && isFinite(pnl)) {
      message += `\n*PnL (est):* ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} USDT`;
    }
    await sendMessage(message);
    let statusTag = "CLOSED_MANUAL";
    if (/TP/i.test(reason)) statusTag = "TP_REALIZED";
    if (/SL/i.test(reason)) statusTag = "SL_REALIZED";
    logSignal(quantity > 0 ? "LONG" : "SHORT", entryPrice, db.activePosition?.tp, db.activePosition?.sl, statusTag, pnl);
  } catch (err) {
    console.error("❌ Posisi: Gagal menutup posisi.", err.message);
    await sendMessage(`❌ *Gagal Menutup Posisi!*
*Pair:* ${db.pair}
*Alasan:* ${reason}
*Pesan Error:* ${err.message}`);
  } finally {
    db.activePosition = null;
    saveDB();
  }
};

/**
 * Memeriksa status posisi aktif untuk pemicu TP/SL dan penutupan manual.
 */
const checkPositionStatus = async () => {
  try {
    const { position } = await getPositionFromBalance();
    const amount = parseFloat(position?.positionAmt || "0");
    const amountSafe = isFinite(amount) ? amount : 0;
    const previousAmountSafe = isFinite(previousPositionAmount) ? previousPositionAmount : 0;

    // Deteksi penutupan posisi manual atau eksternal
    if (previousAmountSafe !== 0 && amountSafe === 0) {
      const side = previousAmountSafe > 0 ? "LONG" : "SHORT";
      await sendMessage(`📉 *Posisi ${side} Ditutup!*
*Pair:* ${db.pair}
*Harga Exit:* (periksa di Binance)`);
      console.log(`📉 Posisi ${side} di ${db.pair} telah ditutup.`);
      db.activePosition = null;
      saveDB();
    }

    // Pemantauan internal untuk pemicu TP/SL dari database
    if (db.activePosition && amountSafe !== 0) {
      const { tp, sl, side, entryPrice, offset } = db.activePosition;
      const currentPrice = await getPrice();
      if (!currentPrice) return;

      // Logika Trailing Stop Loss
      let newSL = sl;
      if (side === "buy") {
        newSL = Math.max(sl, currentPrice - offset);
      } else if (side === "sell") {
        newSL = Math.min(sl, currentPrice + offset);
      }

      // Perbarui SL jika telah trailing
      if (newSL !== sl) {
        db.activePosition.sl = newSL;
        saveDB();
        await sendMessage(
          `📈 Trailing SL diperbarui untuk posisi ${side.toUpperCase()}!\n*SL Baru:* ${formatPrice(newSL)}`
        );
      }

      // Periksa pemicu TP/SL
      if (
        (side === "buy" && currentPrice >= tp) ||
        (side === "sell" && currentPrice <= tp)
      ) {
        await closePosition("TP tercapai", entryPrice);
      } else if (
        (side === "buy" && currentPrice <= newSL) ||
        (side === "sell" && currentPrice >= newSL)
      ) {
        await closePosition("SL tercapai", entryPrice);
      }
    }
    previousPositionAmount = amountSafe;
  } catch (err) {
    console.error("❌ Posisi: Gagal memeriksa status posisi.", err.message);
  }
};

// -------------------- LOOP UTAMA --------------------
setInterval(async () => {
  try {
    const { position } = await getPositionFromBalance();
    const amount = parseFloat(position?.positionAmt || "0");
    const hasActiveBinancePosition = isFinite(amount) && Math.abs(amount) > 0;
    await checkPositionStatus();
    console.log("🔍 Loop Utama: Memeriksa sinyal baru...");

    const signal = await analyzeSignal();
    if (!signal.price) {
      console.log("⚠️ Analisis: Sinyal tidak valid, menunggu...");
      return;
    }

    const hasBotPosition = db.activePosition !== null;
    let shouldExitCurrentPosition = false;

    // Logika swing: periksa apakah posisi saat ini harus ditutup karena sinyal berbalik
    if (hasBotPosition) {
      const currentSide = db.activePosition.side;
      if ((currentSide === "buy" && signal.canShort) || (currentSide === "sell" && signal.canLong)) {
        console.log("⚠️ Sinyal: Sinyal berbalik valid, menutup posisi aktif.");
        shouldExitCurrentPosition = true;
      }
    }

    // Eksekusi penutupan posisi untuk swing trade
    if (shouldExitCurrentPosition) {
      await closePosition("Sinyal berbalik", db.activePosition.entryPrice);
      // Tunggu sebentar untuk memastikan posisi sebelumnya benar-benar tertutup
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    // Periksa kembali status posisi setelah potensi penutupan
    const { position: updatedPosition } = await getPositionFromBalance();
    const updatedAmount = parseFloat(updatedPosition?.positionAmt || "0");
    const hasActiveBinancePositionAfterClose = isFinite(updatedAmount) && Math.abs(updatedAmount) > 0;

    // Buka posisi baru hanya jika tidak ada posisi aktif
    if (db.activePosition === null && !hasActiveBinancePositionAfterClose) {
      if (signal.canLong) {
        console.log("🚀 Sinyal: Sinyal LONG valid dan bot siap. Menempatkan order.");
        db.lastLongEntryTime = new Date().getTime();
        saveDB();
        await placeOrder(
          "buy",
          signal.targetLong,
          signal.stopLossLong,
          signal.longOffset,
          signal.midPriceLong
        );
      } else if (signal.canShort) {
        console.log("📉 Sinyal: Sinyal SHORT valid dan bot siap. Menempatkan order.");
        db.lastShortEntryTime = new Date().getTime();
        saveDB();
        await placeOrder(
          "sell",
          signal.targetShort,
          signal.stopLossShort,
          signal.shortOffset,
          signal.midPriceShort
        );
      } else {
        console.log("💤 Sinyal: Tidak ada sinyal valid ditemukan. Menunggu...");
      }
    } else if (db.activePosition !== null) {
      // Perbarui TP/SL dan offset jika posisi sudah aktif
      console.log("➡️ Posisi aktif terdeteksi. Memeriksa pembaruan TP/SL dan offset.");
      if (signal.price) {
        const { side } = db.activePosition;
        let newSL, newTP, newOffset;
        if (side === "buy") {
          newSL = signal.stopLossLong;
          newTP = signal.targetLong;
          newOffset = signal.longOffset;
        } else if (side === "sell") {
          newSL = signal.stopLossShort;
          newTP = signal.targetShort;
          newOffset = signal.shortOffset;
        }
        if (newSL !== db.activePosition.sl || newTP !== db.activePosition.tp || newOffset !== db.activePosition.offset) {
          console.log("✅ Sinyal: TP/SL/Offset baru terdeteksi! Memperbarui database.");
          db.activePosition.sl = newSL;
          db.activePosition.tp = newTP;
          db.activePosition.offset = newOffset;
          saveDB();
        } else {
          console.log("✔️ Sinyal: Tidak ada perubahan pada TP/SL/Offset. Tidak ada pembaruan yang diperlukan.");
        }
      } else {
        console.log("⚠️ Analisis: Sinyal tidak valid. Tidak dapat memperbarui TP/SL/Offset.");
      }
    }
  } catch (e) {
    console.error("⚠️ Loop: Terjadi kesalahan di loop utama.", e.message);
    console.error(e.stack);
  }
}, 10000); // Interval 10 detik