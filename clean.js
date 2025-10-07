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


// -------------------- UTIL --------------------
const saveDB = () => fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

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
const placeOrder = async (side, tp, sl) => {
    console.log("🔍 Order: Memeriksa apakah ada posisi aktif...");
    if (db.activePosition) {
        console.log(
            "⚠️ Order: Masih ada posisi terbuka yang dimonitor oleh bot, order dibatalkan."
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
            orderId: order.id,
        };
        saveDB();

        
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

            

            if (pnl !== null && isFinite(pnl)) {
                message += `\n*PnL (est):* ${pnl >= 0 ? "+" : ""}${pnl.toFixed(
          4
        )} USDT`;
            }


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

    // Menghapus penghitungan offset

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
            } = db.activePosition; // Menghapus offset
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
            let entryTP, entrySL;

            if (sig.canLong) {
                // Sinyal LONG

                // Cek Breakout LONG: Harga di atas Resistance (targetLong awal)
                const isLongBreakout = sig.price > sig.targetLong;

                if (isLongBreakout) {
                    // LOGIKA BREAKOUT LONG
                    // ...
                    const priceDecimals = exchange.markets[db.pair]?.precision?.price ?? 5; // Dapatkan presisi harga
                    const midPriceDiff = sig.targetLong - sig.stopLossLong;
                    // 1. Hitung setengah dari selisih
                    const rawHalfDiff = midPriceDiff / 2;

                    // 2. Bulatkan ke jumlah desimal yang diinginkan (Misal: 5 desimal)
                    // Menggunakan parseFloat(toFixed()) untuk membulatkan lalu menjadikannya angka
                    const halfMidPriceDiff = parseFloat(Math.abs(rawHalfDiff).toFixed(priceDecimals));

                    entryTP = sig.targetLong + halfMidPriceDiff;
                    entrySL = sig.targetLong - halfMidPriceDiff;
                    // ...


                    console.log(
                        `🚀 Sinyal LONG: BREAKOUT terdeteksi. TP: ${formatPrice(entryTP)}, SL: ${formatPrice(entrySL)}.`
                    );
                } else {
                    // Swing/Normal LONG
                    entryTP = sig.targetLong;
                    entrySL = sig.stopLossLong;

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
                ); // Menghapus entryOffset

            } else if (sig.canShort) {
                // Sinyal SHORT

                // Cek Breakout SHORT: Harga di bawah Support (targetShort awal)
                const isShortBreakout = sig.price < sig.targetShort;

                if (isShortBreakout) {
                    // LOGIKA BREAKOUT SHORT
                    // ...
                    const priceDecimals = exchange.markets[db.pair]?.precision?.price ?? 5; // Dapatkan presisi harga
                    const midPriceDiff = sig.stopLossShort - sig.targetShort;
                    // 1. Hitung setengah dari selisih
                    const rawHalfDiff = midPriceDiff / 2;

                    // 2. Bulatkan ke jumlah desimal yang diinginkan (Misal: 5 desimal)
                    // Menggunakan parseFloat(toFixed()) untuk membulatkan lalu menjadikannya angka
                    const halfMidPriceDiff = parseFloat(Math.abs(rawHalfDiff).toFixed(priceDecimals));

                    entryTP = sig.targetShort - halfMidPriceDiff; // Support - Diff
                    entrySL = sig.targetShort + halfMidPriceDiff; // Support + Diff
                    // ...

                    console.log(
                        `📉 Sinyal SHORT: BREAKOUT terdeteksi. TP: ${formatPrice(entryTP)}, SL: ${formatPrice(entrySL)}.`
                    );
                } else {
                    // Swing/Normal SHORT
                    entryTP = sig.targetShort;
                    entrySL = sig.stopLossShort;

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
                ); // Menghapus entryOffset

            } else {
                console.log("💤 Sinyal: Tidak ada sinyal valid. Menunggu...");
            }
        }
        // Logika untuk memperbarui TP/SL
        // else if (db.activePosition !== null) {
        //     console.log(
        //         "➡️ Posisi aktif terdeteksi. Memeriksa sinyal untuk pembaruan TP/SL."
        //     );
        //     if (sig.price) {
        //         const currentSide = db.activePosition.side;
        //         let newSL, newTP;

        //         // --- LOGIKA UPDATE POSISI AKTIF (SAMA SEPERTI LOGIKA ENTRY DI ATAS) ---
        //         if (currentSide === "buy") {
        //             const isLongBreakout = sig.price > sig.targetLong;
        //             if (isLongBreakout) {
        //                 const midPriceDiff = sig.targetLong - sig.stopLossLong;
        //                 // 1. Hitung setengah dari selisih
        //                 const rawHalfDiff = midPriceDiff / 2;

        //                 // 2. Bulatkan ke jumlah desimal yang diinginkan (Misal: 5 desimal)
        //                 // Gunakan Math.abs() untuk mendapatkan jarak positif
        //                 const halfMidPriceDiff = formatPrice(rawHalfDiff);
        //                 newTP = sig.targetLong + halfMidPriceDiff;
        //                 newSL = sig.targetLong - halfMidPriceDiff;
        //             } else {
        //                 newTP = sig.targetLong;
        //                 newSL = sig.stopLossLong;
        //             }
        //         } else if (currentSide === "sell") {
        //             const isShortBreakout = sig.price < sig.targetShort;
        //             if (isShortBreakout) {
        //                 const midPriceDiff = sig.stopLossShort - sig.targetShort;
        //                 // 1. Hitung setengah dari selisih
        //                 const rawHalfDiff = midPriceDiff / 2;

        //                 // 2. Bulatkan ke jumlah desimal yang diinginkan (Misal: 5 desimal)
        //                 // Gunakan Math.abs() untuk mendapatkan jarak positif
        //                 const halfMidPriceDiff = formatPrice(rawHalfDiff);
        //                 newTP = sig.targetShort - halfMidPriceDiff;
        //                 newSL = sig.targetShort + halfMidPriceDiff;
        //             } else {
        //                 newTP = sig.targetShort;
        //                 newSL = sig.stopLossShort;
        //             }
        //         }
        //         // --- AKHIR LOGIKA UPDATE POSISI AKTIF ---


        //         // Cek apakah ada perubahan yang signifikan dari hasil analisis baru
        //         if (
        //             newSL !== db.activePosition.sl ||
        //             newTP !== db.activePosition.tp
        //         ) {
        //             // Logika Trailing SL yang dihapus, kini hanya pengecekan perubahan murni.
        //             // Jika ada perubahan TP/SL, kita hanya mengupdate yang *lebih menguntungkan*
        //             // atau yang berubah karena pergerakan Breakout/Swing.
        //             let shouldUpdate = false;

        //             if (currentSide === "buy") {
        //                 // Update jika TP naik (lebih baik) atau SL naik (Trailing SL sederhana: harga telah naik)
        //                 if (newTP > db.activePosition.tp || newSL > db.activePosition.sl) {
        //                     shouldUpdate = true;
        //                 }
        //             } else if (currentSide === "sell") {
        //                 // Update jika TP turun (lebih baik) atau SL turun (Trailing SL sederhana: harga telah turun)
        //                 if (newTP < db.activePosition.tp || newSL < db.activePosition.sl) {
        //                     shouldUpdate = true;
        //                 }
        //             }

        //             if (shouldUpdate) {
        //                 console.log(
        //                     `✅ Sinyal: TP/SL baru terdeteksi! Memperbarui dari DB.`
        //                 );
        //                 db.activePosition.sl = newSL;
        //                 db.activePosition.tp = newTP;
        //                 // Hapus pembaruan offset
        //                 saveDB();
        //             } else {
        //                 console.log(
        //                     "✔️ Sinyal: TP/SL baru tidak lebih baik atau sama. Tidak ada pembaruan."
        //                 );
        //             }
        //         } else {
        //             console.log(
        //                 "✔️ Sinyal: Tidak ada perubahan TP/SL. Tidak ada pembaruan."
        //             );
        //         }
        //     } else {
        //         console.log(
        //             "⚠️ Analisis: Sinyal tidak valid. Tidak ada pembaruan TP/SL."
        //         );
        //     }
        // }
    } catch (e) {
        console.error("⚠️ Loop: Terjadi kesalahan di loop utama.", e.message);
        console.error(e.stack);
    }
}, 15000);
