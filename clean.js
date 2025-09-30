// signal.js (perbaikan deteksi posisi & close/TP-SL)
require("dotenv").config();
const fs = require("fs");
const ccxt = require("ccxt");
const {
    SMA
} = require("technicalindicators");
const {
    Client,
    LocalAuth
} = require("whatsapp-web.js");
const express = require("express");
const QRCode = require("qrcode");

// -------------------- CONFIG --------------------
const app = express();
const dbPath = "./db.json";
const logPath = "./log.csv";
const serverPort = 7890;

// -------------------- FILE INIT --------------------
if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, "timestamp,pair,type,entry,tp,sl,status,pnl\n");
    console.log("📝 Log: File log.csv dibuat.");
}

const db = fs.existsSync(dbPath) ?
    JSON.parse(fs.readFileSync(dbPath)) : {
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
    options: {
        defaultType: "future"
    },
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

    if (cmd === "!pnl") {
        try {
            if (!fs.existsSync(logPath)) {
                return msg.reply("ℹ️ Log tidak ditemukan (log.csv belum ada).");
            }
            const raw = fs.readFileSync(logPath, "utf8");
            const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
            // skip header
            const dataLines = lines.slice(1);

            let tpCount = 0,
                slCount = 0;
            let tpSum = 0,
                slSum = 0;
            let netSum = 0;
            let items = [];

            dataLines.forEach((line) => {
                const parts = line.split(",");
                if (parts.length < 7) return;
                const status = parts[6] ? parts[6].trim() : "";
                // pnl may be at index 7 (if present)
                const pnlRaw = parts[7] ? parts[7].trim() : "";
                const pnl =
                    pnlRaw !== "" && !isNaN(Number(pnlRaw)) ? Number(pnlRaw) : null;

                if (
                    (/TP_REALIZED/i.test(status) || /TP/i.test(status)) &&
                    pnl !== null
                ) {
                    tpCount++;
                    if (pnl !== null) tpSum += pnl;
                }
                if (
                    (/SL_REALIZED/i.test(status) || /SL/i.test(status)) &&
                    pnl !== null
                ) {
                    slCount++;
                    if (pnl !== null) slSum += pnl;
                }
                if (pnl !== null) netSum += pnl;

                // optional: collect last 5 realized events
                if (/TP_REALIZED|SL_REALIZED/i.test(status)) {
                    items.push({
                        time: parts[0],
                        pair: parts[1],
                        type: parts[2],
                        entry: parts[3],
                        tp: parts[4],
                        sl: parts[5],
                        status,
                        pnl,
                    });
                }
            });

            const avgTp = tpCount ? tpSum / tpCount : 0;
            const avgSl = slCount ? slSum / slCount : 0;

            let reply = `📊 *Rekap PnL*\n\n*TP (realisasi):*\n${tpCount} trade\nTotal: ${tpSum.toFixed(
        4
      )} USDT\nRata2: ${avgTp.toFixed(
        4
      )} USDT\n*SL (realisasi):*\n${slCount} trade\nTotal: ${slSum.toFixed(
        4
      )} USDT\nRata2: ${avgSl.toFixed(4)} USDT\n\n*Net PnL:* ${
        netSum >= 0 ? "+" : ""
      }${netSum.toFixed(4)} USDT`;

            // tambahkan 5 record terakhir (jika ada)
            if (items.length > 0) {
                const last = items.slice(-5).reverse();
                reply += `\n\n*5 Realized Terakhir:*\n`;
                last.forEach((it) => {
                    reply += `\n- ${it.time.split("T")[0]} ${it.status} ${it.type} PnL:${
            it.pnl !== null
              ? (it.pnl >= 0 ? "+" : "") + it.pnl.toFixed(4) + " USDT"
              : "N/A"
          }`;
                });
            }

            await msg.reply(reply);
        } catch (e) {
            console.error("❌ Error !pnl:", e.message);
            await msg.reply("⚠️ Terjadi error saat menghitung PnL.");
        }
    }

    if (cmd === "!status") {
        try {
            const price = await getPrice();
            const bal = await exchange.fetchBalance();
            const usdt = bal.total.USDT;
            const positions =
                bal.info?.positions?.filter((p) => parseFloat(p.positionAmt) !== 0) || [];

            let posText = `*Posisi Terbuka di Binance:*`;
            if (positions.length === 0) {
                posText += `\n❌ Tidak ada posisi terbuka di akun Anda.`;
            } else {
                positions.forEach((pos) => {
                    const side = parseFloat(pos.positionAmt) > 0 ? "LONG" : "SHORT";
                    posText += `*\nPair:* ${pos.symbol}
  \nTipe: ${side}
  \nPnL (Unrealized): ${parseFloat(pos.unrealizedProfit).toFixed(2)} USDT`;
                });
            }

            const lastLong = db.lastLongEntryTime ?
                new Date(db.lastLongEntryTime).toLocaleString() :
                "-";
            const lastShort = db.lastShortEntryTime ?
                new Date(db.lastShortEntryTime).toLocaleString() :
                "-";

            let msgText = `📊 *Status Bot Trading*\n
*Pair Bot:* ${db.pair}
*Harga Saat Ini:* ${formatPrice(price)}
*Saldo USDT:* ${usdt?.toFixed(2) || "N/A"} USDT
*Leverage:* ${db.leverage}x (${db.marginMode})
*USDT per Trade:* ${db.usdtPerTrade}
*Sinyal Terakhir:*
LONG: ${lastLong}
SHORT: ${lastShort}`;

            if (db.activePosition) {
                msgText += `\n\n*Posisi yang Dimonitor Bot:*
  *Tipe:* ${db.activePosition.side.toUpperCase()}
  *Entry:* ${formatPrice(db.activePosition.entryPrice)}
  *TP:* ${db.activePosition.tp ? formatPrice(db.activePosition.tp) : "N/A"}
  *SL:* ${db.activePosition.sl ? formatPrice(db.activePosition.sl) : "N/A"}`;
            } else {
                msgText += `\n\n*Posisi yang Dimonitor Bot:*
  ❌ Tidak ada posisi yang dimonitor bot.`;
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

const logSignal = (type, entry, tp, sl, status, pnl = null) => {
    // pastikan nilai numeric untuk entry/tp/sl jika ada
    const entryStr = entry !== undefined && entry !== null ? entry : "";
    const tpStr = tp !== undefined && tp !== null ? tp : "";
    const slStr = sl !== undefined && sl !== null ? sl : "";
    const pnlStr = pnl !== null && isFinite(pnl) ? Number(pnl).toFixed(6) : ""; // simpan 6 desimal
    const line = `${new Date().toISOString()},${
    db.pair
  },${type},${entryStr},${tpStr},${slStr},${status},${pnlStr}\n`;
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
        return {
            balance: bal,
            position: found
        };
    } catch (err) {
        console.error("❌ Helper: Gagal ambil posisi dari balance.", err.message);
        return {
            balance: null,
            position: null
        };
    }
};

// -------------------- ORDER --------------------
const placeOrder = async (side, tp, sl, offset) => {
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
        const {
            position
        } = await getPositionFromBalance();
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
            offset: offset,
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
        const {
            position
        } = await getPositionFromBalance();
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

            // ---- HITUNG PNL ESTIMASI BERDASARKAN db.usdtPerTrade ----
            let pnl = null;
            if (entryPrice !== "N/A" && isFinite(exitPrice) && isFinite(entryPrice)) {
                try {
                    const entryNum = Number(entryPrice);
                    const exitNum = Number(exitPrice);
                    const qtyAbs = Math.abs(parseFloat(position?.positionAmt || "0"));
                    if (qtyAbs > 0 && isFinite(exitPrice) && isFinite(entryPrice)) {
                        if (side === "sell") {
                            pnl = (exitNum - entryNum) * qtyAbs; // LONG close
                        } else {
                            pnl = (entryNum - exitNum) * qtyAbs; // SHORT close
                        }
                    }
                } catch (e) {
                    pnl = null;
                }
            }

            let message = `📉 *Posisi Ditutup!*
*Pair:* ${db.pair}
*Sebab:* ${reason}
*Harga Entry:* ${formatPrice(entryPrice)}
*Harga Exit:* ${formatPrice(exitPrice)}`;

            if (pnl !== null && isFinite(pnl)) {
                message += `\n*PnL (est):* ${pnl >= 0 ? "+" : ""}${pnl.toFixed(
          4
        )} USDT`;
            }

            await sendMsg(message);

            // Log hasil realisasi (TP/SL) ke log.csv
            let statusTag = "CLOSED_MANUAL";
            if (/TP/i.test(reason)) statusTag = "TP_REALIZED";
            if (/SL/i.test(reason)) statusTag = "SL_REALIZED";
            logSignal(
                qty > 0 ? "LONG" : "SHORT",
                entryPrice,
                db.activePosition?.tp ?? "",
                db.activePosition?.sl ?? "",
                statusTag,
                pnl
            );
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

    // Menghitung SMA
    const ma7 = SMA.calculate({
        values: close.slice(-100),
        period: 7
    }).pop();
    const ma25 = SMA.calculate({
        values: close.slice(-100),
        period: 25
    }).pop();
    const ma99 = SMA.calculate({
        values: close,
        period: 99
    }).pop();

    const price = close.at(-1);

    // Ambil nilai SMA sebelumnya untuk mendeteksi crossover
    const prevMA7 = SMA.calculate({
        values: close.slice(-101, -1),
        period: 7,
    }).pop();
    const prevMA25 = SMA.calculate({
        values: close.slice(-101, -1),
        period: 25,
    }).pop();

    const isCrossedUp = ma7 > ma25 && prevMA7 <= prevMA25;
    const isCrossedDown = ma7 < ma25 && prevMA7 >= prevMA25;

    let canLong = false;
    let canShort = false;

    const isPriceAboveMA99 = price > ma99;
    const isPriceBelowMA99 = price < ma99;

    // Analisis Sinyal LONG
    if (isCrossedUp && isPriceAboveMA99) {
        canLong = true;
    }

    // Analisis Sinyal SHORT
    if (isCrossedDown && isPriceBelowMA99) {
        canShort = true;
    }

    // =================== SUPPORT & RESISTANCE ===================
    function findSwingLevels(highArr, lowArr, lookback) {
        let swingHighs = [];
        let swingLows = [];

        for (let i = 2; i < lookback - 2; i++) {
            if (highArr[i] > highArr[i - 1] && highArr[i] > highArr[i - 2] &&
                highArr[i] > highArr[i + 1] && highArr[i] > highArr[i + 2]) {
                swingHighs.push(highArr[i]);
            }
            if (lowArr[i] < lowArr[i - 1] && lowArr[i] < lowArr[i - 2] &&
                lowArr[i] < lowArr[i + 1] && lowArr[i] < lowArr[i + 2]) {
                swingLows.push(lowArr[i]);
            }
        }

        const resistance = swingHighs.length ?
            Math.max(...swingHighs) :
            Math.max(...highArr.slice(-lookback));
        const support = swingLows.length ?
            Math.min(...swingLows) :
            Math.min(...lowArr.slice(-lookback));

        return {
            support,
            resistance
        };
    }

    const {
        support,
        resistance
    } = findSwingLevels(high.slice(-96), low.slice(-96), 96);

    // =================== TP & SL LOGIC ===================
    const targetLong = resistance;
    const stopLossLong = support;
    const targetShort = support;
    const stopLossShort = resistance;

    // Hitung offset
    const longOffset = targetLong - stopLossLong;
    const shortOffset = stopLossShort - targetShort;

    // Awal output yang rapi
    console.log(`\n📊 *Hasil Analisis ${db.pair}*`);
    console.log(`-----------------------------------`);

    // Sinyal Utama
    console.log(`📈 Sinyal Long: ${canLong ? "✅ VALID" : "❌ TIDAK VALID"}`);
    console.log(`📉 Sinyal Short: ${canShort ? "✅ VALID" : "❌ TIDAK VALID"}`);
    console.log(`-----------------------------------`);

    // Detail Indikator
    console.log(`📝 Detail Indikator:`);
    console.log(`   - Crossover MA: ${isCrossedUp ? "📈 MA7 Crossed Up MA25" : isCrossedDown ? "📉 MA7 Crossed Down MA25" : "↔️ Tidak Ada"}`);
    console.log(`   - Posisi Harga vs MA99: ${isPriceAboveMA99 ? "📈 Harga di atas MA99 (Tren Naik)" : "📉 Harga di bawah MA99 (Tren Turun)"}`);

    // Informasi Harga
    console.log(`💰 Harga Saat Ini: ${formatPrice(price)}`);
    console.log(`-----------------------------------`);

    // Strategi Long
    console.log(`📈 Strategi Long:`);
    console.log(`   - Target: ${formatPrice(targetLong)}`);
    console.log(`   - Stop Loss: ${formatPrice(stopLossLong)}`);
    console.log(`-----------------------------------`);

    // Strategi Short
    console.log(`📉 Strategi Short:`);
    console.log(`   - Target: ${formatPrice(targetShort)}`);
    console.log(`   - Stop Loss: ${formatPrice(stopLossShort)}`);
    console.log(`-----------------------------------`);

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
        const {
            position
        } = await getPositionFromBalance();
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
            const {
                tp,
                sl,
                side,
                entryPrice,
                offset
            } = db.activePosition;
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
        await checkPositionStatus();

        console.log("🔍 Loop Utama: Memeriksa sinyal baru...");
        console.log("🔍 Status Posisi Aktif di DB: ", db.activePosition);

        const sig = await analyzeSignal();

        if (!sig.price) {
            console.log("⚠️ Analisis: Sinyal tidak valid, menunggu...");
            return;
        }

        const hasBotPosition = db.activePosition !== null;
        let shouldExitCurrentPosition = false;
        // --- LOGIKA BARU UNTUK SWING POSISI ---
        if (hasBotPosition) {
            const currentSide = db.activePosition.side;
            if (currentSide === "buy" && sig.canShort) {
                console.log(
                    "⚠️ Sinyal: Sinyal SHORT valid, menutup posisi LONG yang aktif."
                );
                shouldExitCurrentPosition = true;
            } else if (currentSide === "sell" && sig.canLong) {
                console.log(
                    "⚠️ Sinyal: Sinyal LONG valid, menutup posisi SHORT yang aktif."
                );
                shouldExitCurrentPosition = true;
            }
        }
        // Eksekusi penutupan posisi jika ada sinyal valid untuk swing
        if (shouldExitCurrentPosition) {
            await closePosition("Sinyal berbalik arah", db.activePosition.entryPrice);
            // JEDA SEBENTAR untuk memastikan posisi sebelumnya benar-benar tertutup
            await new Promise((resolve) => setTimeout(resolve, 5000));
        }
        // Logika untuk membuka posisi baru hanya jika tidak ada posisi aktif // Periksa kembali status setelah kemungkinan close position
        const {
            position
        } = await getPositionFromBalance();
        const amt = parseFloat(position?.positionAmt || "0");
        const hasActiveBinancePositionAfterClose =
            isFinite(amt) && Math.abs(amt) > 0;

        if (db.activePosition === null && !hasActiveBinancePositionAfterClose) {

            // ================== LOGIKA ORDER (TERMASUK BREAKOUT) ==================

            // Gunakan variabel sementara untuk TP/SL yang mungkin diubah
            let entryTP, entrySL, entryOffset;

            if (sig.canLong) {
                // Sinyal LONG

                // Cek Breakout LONG: Harga di atas Resistance (targetLong awal)
                const isLongBreakout = sig.price > sig.targetLong;

                if (isLongBreakout) {
                    const midPriceDiff = sig.targetLong - sig.stopLossLong; // Resistance - Support

                    entryTP = sig.targetLong + midPriceDiff; // Resistance + Diff
                    entrySL = sig.targetLong - midPriceDiff; // Resistance - Diff
                    entryOffset = entryTP - entrySL;

                    console.log(
                        `🚀 Sinyal LONG: BREAKOUT terdeteksi. TP: ${formatPrice(entryTP)}, SL: ${formatPrice(entrySL)}.`
                    );
                } else {
                    // Swing/Normal LONG
                    entryTP = sig.targetLong;
                    entrySL = sig.stopLossLong;
                    entryOffset = sig.longOffset;

                    console.log(
                        `🚀 Sinyal LONG: SWING. TP: ${formatPrice(entryTP)}, SL: ${formatPrice(entrySL)}.`
                    );
                }

                db.lastLongEntryTime = now;
                saveDB();
                await placeOrder(
                    "buy",
                    entryTP,
                    entrySL,
                    entryOffset
                );

            } else if (sig.canShort) {
                // Sinyal SHORT

                // Cek Breakout SHORT: Harga di bawah Support (targetShort awal)
                const isShortBreakout = sig.price < sig.targetShort;

                if (isShortBreakout) {
                    const midPriceDiff = sig.stopLossShort - sig.targetShort; // Resistance - Support

                    entryTP = sig.targetShort - midPriceDiff; // Support - Diff
                    entrySL = sig.targetShort + midPriceDiff; // Support + Diff
                    entryOffset = entrySL - entryTP;

                    console.log(
                        `📉 Sinyal SHORT: BREAKOUT terdeteksi. TP: ${formatPrice(entryTP)}, SL: ${formatPrice(entrySL)}.`
                    );
                } else {
                    // Swing/Normal SHORT
                    entryTP = sig.targetShort;
                    entrySL = sig.stopLossShort;
                    entryOffset = sig.shortOffset;

                    console.log(
                        `📉 Sinyal SHORT: SWING. TP: ${formatPrice(entryTP)}, SL: ${formatPrice(entrySL)}.`
                    );
                }

                db.lastShortEntryTime = now;
                saveDB();
                await placeOrder(
                    "sell",
                    entryTP,
                    entrySL,
                    entryOffset
                );

            } else {
                console.log("💤 Sinyal: Tidak ada sinyal valid. Menunggu...");
            }         
        }
        // Logika untuk memperbarui TP/SL dan offset jika ada posisi aktif
        else if (db.activePosition !== null) {
            console.log(
                "➡️ Posisi aktif terdeteksi. Memeriksa sinyal untuk pembaruan TP/SL dan offset."
            );
            if (sig.price) {
                const currentSide = db.activePosition.side;
                let newSL, newTP, newOffset;

                // --- LOGIKA UPDATE POSISI AKTIF (SAMA SEPERTI LOGIKA ENTRY DI ATAS) ---
                if (currentSide === "buy") {
                    const isLongBreakout = sig.price > sig.targetLong;
                    if (isLongBreakout) {
                        const midPriceDiff = sig.targetLong - sig.stopLossLong;
                        newTP = sig.targetLong + midPriceDiff;
                        newSL = sig.targetLong - midPriceDiff;
                        newOffset = newTP - newSL;
                    } else {
                        newTP = sig.targetLong;
                        newSL = sig.stopLossLong;
                        newOffset = sig.longOffset;
                    }
                } else if (currentSide === "sell") {
                    const isShortBreakout = sig.price < sig.targetShort;
                    if (isShortBreakout) {
                        const midPriceDiff = sig.stopLossShort - sig.targetShort;
                        newTP = sig.targetShort - midPriceDiff;
                        newSL = sig.targetShort + midPriceDiff;
                        newOffset = newSL - newTP;
                    } else {
                        newTP = sig.targetShort;
                        newSL = sig.stopLossShort;
                        newOffset = sig.shortOffset;
                    }
                }
                // --- AKHIR LOGIKA UPDATE POSISI AKTIF ---


                // Cek apakah ada perubahan yang signifikan dari hasil analisis baru
                if (
                    newSL !== db.activePosition.sl ||
                    newTP !== db.activePosition.tp ||
                    newOffset !== db.activePosition.offset
                ) {
                    // Logika Trailing SL: hanya update SL jika lebih menguntungkan (lebih tinggi untuk long, lebih rendah untuk short)
                    let shouldUpdate = false;

                    if (currentSide === "buy" && newSL > db.activePosition.sl) {
                        // Trailing SL: SL baru lebih tinggi
                        shouldUpdate = true;
                    } else if (currentSide === "sell" && newSL < db.activePosition.sl) {
                        // Trailing SL: SL baru lebih rendah
                        shouldUpdate = true;
                    } else if (newTP !== db.activePosition.tp) {
                        // Update TP jika berubah (misal dari Swing ke Breakout)
                         shouldUpdate = true;
                    }

                    if (shouldUpdate) {
                         console.log(
                            `✅ Sinyal: TP/SL/Offset baru terdeteksi! Memperbarui dari DB.`
                        );
                        db.activePosition.sl = newSL;
                        db.activePosition.tp = newTP;
                        db.activePosition.offset = newOffset;
                        saveDB();
                    } else {
                        console.log(
                            "✔️ Sinyal: TP/SL/Offset baru tidak lebih baik atau sama. Tidak ada pembaruan."
                        );
                    }
                } else {
                    console.log(
                        "✔️ Sinyal: Tidak ada perubahan TP/SL/Offset. Tidak ada pembaruan."
                    );
                }
            } else {
                console.log(
                    "⚠️ Analisis: Sinyal tidak valid. Tidak ada pembaruan TP/SL/Offset."
                );
            }
        }
    } catch (e) {
        console.error("⚠️ Loop: Terjadi kesalahan di loop utama.", e.message);
        console.error(e.stack);
    }
}, 10000);