// signal.js (Cleaned Version)
require("dotenv").config();
const fs = require("fs");
const ccxt = require("ccxt");
const { SMA } = require("technicalindicators");

// -------------------- CONFIG --------------------
const dbPath = "./db.json";
const logPath = "./log.csv";

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

console.log(`⚙️ Konfigurasi Bot:
- Pair Aktif: ${db.pair}
- Leverage: ${db.leverage}x
- Margin Mode: ${db.marginMode}
- USDT per Trade: ${db.usdtPerTrade}`);

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

// -------------------- UTIL FUNCTIONS --------------------
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
        const ticker = await exchange.fetchTicker(db.pair);
        console.log(`💰 Data: Harga ${db.pair} = ${formatPrice(ticker.last)}.`);
        return ticker.last;
    } catch (err) {
        console.error("❌ Data: Gagal mengambil harga.", err.message);
        return null;
    }
};

const calcQty = (price) => {
    if (!price) return 0;
    let qty = db.usdtPerTrade / price;
    const prec = exchange.markets[db.pair]?.precision?.amount ?? 3;
    qty = parseFloat(qty.toFixed(prec));
    console.log(`📐 Kalkulasi: Kuantitas dihitung: ${qty} (${db.usdtPerTrade} USDT).`);
    return qty;
};

const logSignal = (type, entry, tp, sl, status, pnl = null) => {
    const entryStr = entry !== undefined && entry !== null ? entry : "";
    const tpStr = tp !== undefined && tp !== null ? tp : "";
    const slStr = sl !== undefined && sl !== null ? sl : "";
    const pnlStr = pnl !== null && isFinite(pnl) ? Number(pnl).toFixed(6) : "";
    const line = `${new Date().toISOString()},${db.pair},${type},${entryStr},${tpStr},${slStr},${status},${pnlStr}\n`;
    fs.appendFileSync(logPath, line);
    console.log("📝 Log: Sinyal dicatat di log.csv");
};

const getMarketId = () => {
    try {
        const market = exchange.markets[db.pair];
        if (market && market.id) return market.id;
    } catch (err) {
        // ignore
    }
    return db.pair.replace("/", "").replace(":", "");
};

const getPositionFromBalance = async () => {
    try {
        const balance = await exchange.fetchBalance();
        const marketId = getMarketId();
        const positions = balance.info?.positions || [];

        const normalize = (str) => (str || "").toString().replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
        const found = positions.find(p => 
            normalize(p.symbol) === normalize(marketId) || 
            normalize(p.contractCode) === normalize(marketId)
        );

        return { balance, position: found };
    } catch (err) {
        console.error("❌ Helper: Gagal ambil posisi dari balance.", err.message);
        return { balance: null, position: null };
    }
};

// -------------------- ORDER MANAGEMENT --------------------
const placeOrder = async (side, tp, sl) => {
    console.log("🔍 Order: Memeriksa apakah ada posisi aktif...");
    if (db.activePosition) {
        console.log("⚠️ Order: Masih ada posisi terbuka yang dimonitor oleh bot, order dibatalkan.");
        return;
    }

    try {
        const { position } = await getPositionFromBalance();
        const amt = parseFloat(position?.positionAmt || "0");
        if (isFinite(amt) && Math.abs(amt) > 0) {
            console.log("⚠️ Order: Terdapat posisi aktif di akun (detected). Order dibatalkan.");
            return;
        }
    } catch (err) {
        console.warn("⚠️ Order: Gagal cek posisi live sebelum entry.", err.message);
    }

    const price = await getPrice();
    if (!price) {
        console.log("❌ Order: Gagal mendapatkan harga, order dibatalkan.");
        return;
    }

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
    } catch (err) {
        console.warn("⚠️ Order: Gagal mengatur leverage/margin mode.", err.message);
    }

    try {
        const order = await exchange.createOrder(db.pair, "market", side, qty);
        console.log("✅ Order: Entry market order berhasil dibuat.");

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
    } catch (err) {
        console.error("❌ Order: Gagal membuat order.", err.message);
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
            
            await exchange.createOrder(db.pair, "market", side, amount, undefined, {
                reduceOnly: true,
            });
            console.log(`✅ Posisi: Order tutup posisi berhasil dibuat (side=${side}, amt=${amount}).`);

            const exitPrice = await getPrice();
            let pnl = null;
            let statusTag = "CLOSED_MANUAL";

            const isTP = /TP/i.test(reason);
            const isSL = /SL/i.test(reason);

            if (isTP) statusTag = "TP_REALIZED";
            else if (isSL) statusTag = "SL_REALIZED";

            if (entryPrice !== "N/A" && db.activePosition) {
                const { tp, sl, side: entrySide } = db.activePosition;
                try {
                    const entryNum = Number(entryPrice);
                    const closedQty = amount;

                    if (closedQty > 0) {
                        let exitNum;
                        if (isTP) {
                            exitNum = entrySide === "buy" ? tp : sl;
                        } else if (isSL) {
                            exitNum = entrySide === "buy" ? sl : tp;
                        } else if (isFinite(exitPrice)) {
                            exitNum = Number(exitPrice);
                        } else {
                            console.warn("⚠️ PNL: Harga keluar tidak ditemukan, PNL tidak dihitung.");
                            return;
                        }

                        const pnlGross = entrySide === "buy" ? 
                            (exitNum - entryNum) : 
                            (entryNum - exitNum);
                        pnl = pnlGross * closedQty;
                    }
                } catch (err) {
                    console.warn("⚠️ PNL: Gagal hitung PNL berdasarkan status.", err.message);
                }
            }

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
        db.activePosition = null;
        saveDB();
    }
};

// -------------------- TECHNICAL ANALYSIS --------------------
const analyzeSignal = async () => {
    console.log("🧠 Analisis: Melakukan analisis teknikal...");
    const ohlcv = await exchange.fetchOHLCV(db.pair, "15m", undefined, 200);
    if (!ohlcv || ohlcv.length < 200) {
        console.warn("⚠️ Analisis: Data OHLCV tidak cukup, menunggu...");
        return {};
    }

    const close = ohlcv.map(c => c[4]);
    const high = ohlcv.map(c => c[2]);
    const low = ohlcv.map(c => c[3]);

    const ma7 = SMA.calculate({ values: close.slice(-100), period: 7 }).pop();
    const ma25 = SMA.calculate({ values: close.slice(-100), period: 25 }).pop();
    const ma99 = SMA.calculate({ values: close, period: 99 }).pop();

    const price = close.at(-1);

    const prevMA7 = SMA.calculate({ values: close.slice(-101, -1), period: 7 }).pop();
    const prevMA25 = SMA.calculate({ values: close.slice(-101, -1), period: 25 }).pop();

    const isCrossedUp = ma7 > ma25 && prevMA7 <= prevMA25;
    const isCrossedDown = ma7 < ma25 && prevMA7 >= prevMA25;

    let canLong = false;
    let canShort = false;

    const isMA7AboveMA99 = ma7 > ma99;
    const isMA7BelowMA99 = ma7 < ma99;
    const isMA25AboveMA99 = ma25 > ma99;
    const isMA25BelowMA99 = ma25 < ma99;

    if (isCrossedUp && isMA7AboveMA99 && isMA25AboveMA99) {
        canLong = true;
    }

    if (isCrossedDown && isMA7BelowMA99 && isMA25BelowMA99) {
        canShort = true;
    }

    const findSwingLevels = (highArr, lowArr, lookback) => {
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

        return { support, resistance };
    };

    const { support, resistance } = findSwingLevels(high.slice(-96), low.slice(-96), 96);

    const targetLong = resistance;
    const stopLossLong = support;
    const targetShort = support;
    const stopLossShort = resistance;

    console.log(`\n📊 Hasil Analisis ${db.pair}
-----------------------------------
📈 Sinyal Long: ${canLong ? "✅ VALID" : "❌ TIDAK VALID"}
📉 Sinyal Short: ${canShort ? "✅ VALID" : "❌ TIDAK VALID"}
-----------------------------------
📝 Detail Indikator:
- Crossover MA: ${isCrossedUp ? "📈 MA7 Crossed Up MA25" : isCrossedDown ? "📉 MA7 Crossed Down MA25" : "↔️ Tidak Ada"}
- Posisi MA7 vs MA99: ${isMA7AboveMA99 ? "📈 Di atas MA99" : "📉 Di bawah MA99"}
- Posisi MA25 vs MA99: ${isMA25AboveMA99 ? "📈 Di atas MA99" : "📉 Di bawah MA99"}
💰 Harga Saat Ini: ${formatPrice(price)}
-----------------------------------
📈 Strategi Long:
- Target: ${formatPrice(targetLong)}
- Stop Loss: ${formatPrice(stopLossLong)}
-----------------------------------
📉 Strategi Short:
- Target: ${formatPrice(targetShort)}
- Stop Loss: ${formatPrice(stopLossShort)}
-----------------------------------`);

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

// -------------------- POSITION MONITORING --------------------
const checkPositionStatus = async () => {
    try {
        const { position } = await getPositionFromBalance();
        const amt = parseFloat(position?.positionAmt || "0");
        const amtSafe = isFinite(amt) ? amt : 0;

        const prevSafe = isFinite(prevPosAmt) ? prevPosAmt : 0;
        if (prevSafe !== 0 && amtSafe === 0) {
            const side = prevSafe > 0 ? "LONG" : "SHORT";
            console.log(`📉 Posisi ${side} di ${db.pair} sudah ditutup.`);
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
            } else if (side === "sell") {
                if (currentPrice <= tp) await closePosition("TP tercapai", entryPrice);
                else if (currentPrice >= sl) await closePosition("SL tercapai", entryPrice);
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

        const signal = await analyzeSignal();
        if (!signal.price) {
            console.log("⚠️ Analisis: Sinyal tidak valid, menunggu...");
            return;
        }

        const hasBotPosition = db.activePosition !== null;
        let shouldExitCurrentPosition = false;

        if (hasBotPosition) {
            const currentSide = db.activePosition.side;
            if (currentSide === "buy" && signal.canShort) {
                console.log("⚠️ Sinyal: Sinyal SHORT valid, menutup posisi LONG yang aktif.");
                shouldExitCurrentPosition = true;
            } else if (currentSide === "sell" && signal.canLong) {
                console.log("⚠️ Sinyal: Sinyal LONG valid, menutup posisi SHORT yang aktif.");
                shouldExitCurrentPosition = true;
            }
        }

        if (shouldExitCurrentPosition) {
            await closePosition("Sinyal berbalik arah", db.activePosition.entryPrice);
            await new Promise(resolve => setTimeout(resolve, 15000));
        }

        const { position } = await getPositionFromBalance();
        const amt = parseFloat(position?.positionAmt || "0");
        const hasActiveBinancePositionAfterClose = isFinite(amt) && Math.abs(amt) > 0;

        if (db.activePosition === null && !hasActiveBinancePositionAfterClose) {
            if (signal.canLong) {
                const isLongBreakout = signal.price > signal.targetLong;
                if (!isLongBreakout) {
                    console.log(`🚀 Sinyal LONG: SWING. TP: ${formatPrice(signal.targetLong)}, SL: ${formatPrice(signal.stopLossLong)}.`);
                    db.lastLongEntryTime = now;
                    saveDB();
                    await placeOrder("buy", signal.targetLong, signal.stopLossLong);
                } else {
                    console.log(`⏸️ Sinyal LONG: BREAKOUT terdeteksi. SKIP posisi.`);
                }
            } else if (signal.canShort) {
                const isShortBreakout = signal.price < signal.targetShort;
                if (!isShortBreakout) {
                    console.log(`📉 Sinyal SHORT: SWING. TP: ${formatPrice(signal.targetShort)}, SL: ${formatPrice(signal.stopLossShort)}.`);
                    db.lastShortEntryTime = now;
                    saveDB();
                    await placeOrder("sell", signal.targetShort, signal.stopLossShort);
                } else {
                    console.log(`⏸️ Sinyal SHORT: BREAKOUT terdeteksi. SKIP posisi.`);
                }
            } else {
                console.log("💤 Sinyal: Tidak ada sinyal valid. Menunggu...");
            }
        }
    } catch (err) {
        console.error("⚠️ Loop: Terjadi kesalahan di loop utama.", err.message);
        console.error(err.stack);
    }
}, 30000);