// signal.js (Cleaned Version)
require("dotenv").config();
const fs = require("fs");
const ccxt = require("ccxt");
const { SMA } = require("technicalindicators");

// -------------------- CONFIG --------------------
const dbPath = "./db.json";
const logPath = "./log.csv";
let isProcessing = false;

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
const saveDB = () => {
    if (db.activePosition) {
        db.activePosition.entryPrice = formatPrice(db.activePosition.entryPrice);
        db.activePosition.tp = formatPrice(db.activePosition.tp);
        db.activePosition.sl = formatPrice(db.activePosition.sl);
    }
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
};

const formatPrice = (price, pair = db.pair) => {
    if (!price || !isFinite(price)) return "N/A";
    
    try {
        const market = exchange.markets[pair];
        if (!market) {
            console.warn(`⚠️ Format: Market ${pair} tidak ditemukan, fallback ke 5 decimals`);
            return parseFloat(price.toFixed(5));
        }
        
        // Ambil precision dari Binance
        let decimals = market.precision?.price;
        
        // Jika precision tidak ada, tentukan berdasarkan price range
        if (decimals === undefined || decimals === null) {
            if (price < 0.0001) decimals = 8;
            else if (price < 0.001) decimals = 7;
            else if (price < 0.01) decimals = 6;
            else if (price < 0.1) decimals = 5;
            else if (price < 1) decimals = 4;
            else if (price < 10) decimals = 3;
            else if (price < 100) decimals = 2;
            else if (price < 1000) decimals = 1;
            else decimals = 0;
        }
        
        // Pastikan decimals valid
        decimals = Math.max(0, Math.min(8, parseInt(decimals) || 5));
        
        const formatted = parseFloat(price.toFixed(decimals));
        return formatted;
        
    } catch (err) {
        console.warn(`⚠️ Format: Error format price ${price}, fallback:`, err.message);
        return parseFloat(price.toFixed(5)); // Fallback safe
    }
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

    // -------------------- MOVING AVERAGES --------------------
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

    // -------------------- IMPROVED SUPPORT/RESISTANCE --------------------
    const findAdvancedSwingLevels = (highArr, lowArr, lookback = 10, minStrength = 2) => {
        const swingHighs = [];
        const swingLows = [];
        
        for (let i = lookback; i < highArr.length - lookback; i++) {
            let isSwingHigh = true;
            let isSwingLow = true;
            let strengthHigh = 0;
            let strengthLow = 0;
            
            // Check left and right untuk swing high
            for (let j = 1; j <= lookback; j++) {
                if (highArr[i - j] > highArr[i]) isSwingHigh = false;
                if (highArr[i + j] > highArr[i]) isSwingHigh = false;
                
                if (lowArr[i - j] < lowArr[i]) isSwingLow = false;
                if (lowArr[i + j] < lowArr[i]) isSwingLow = false;
                
                // Hitung strength (berapa banyak candle di sekitarnya yang lebih rendah/tinggi)
                if (highArr[i - j] < highArr[i] && highArr[i + j] < highArr[i]) strengthHigh++;
                if (lowArr[i - j] > lowArr[i] && lowArr[i + j] > lowArr[i]) strengthLow++;
            }
            
            if (isSwingHigh && strengthHigh >= minStrength) {
                swingHighs.push({
                    price: highArr[i],
                    strength: strengthHigh,
                    index: i
                });
            }
            
            if (isSwingLow && strengthLow >= minStrength) {
                swingLows.push({
                    price: lowArr[i],
                    strength: strengthLow,
                    index: i
                });
            }
        }
        
        // Group level yang berdekatan (dalam 0.2%)
        const groupLevels = (levels, threshold = 0.002) => {
            const groups = [];
            
            levels.sort((a, b) => a.price - b.price).forEach(level => {
                const existingGroup = groups.find(g => 
                    Math.abs(g.price - level.price) / g.price < threshold
                );
                
                if (existingGroup) {
                    existingGroup.members.push(level);
                    existingGroup.price = (existingGroup.price + level.price) / 2; // average price
                    existingGroup.strength += level.strength;
                } else {
                    groups.push({
                        price: level.price,
                        strength: level.strength,
                        members: [level]
                    });
                }
            });
            
            return groups.sort((a, b) => b.strength - a.strength);
        };
        
        return {
            resistance: groupLevels(swingHighs).slice(0, 3), // 3 resistance terkuat
            support: groupLevels(swingLows).slice(0, 3)      // 3 support terkuat
        };
    };

    // -------------------- ATR CALCULATION --------------------
    const calculateATR = (highArr, lowArr, closeArr, period = 14) => {
        const tr = [];
        for (let i = 1; i < highArr.length; i++) {
            const tr1 = highArr[i] - lowArr[i];
            const tr2 = Math.abs(highArr[i] - closeArr[i - 1]);
            const tr3 = Math.abs(lowArr[i] - closeArr[i - 1]);
            tr.push(Math.max(tr1, tr2, tr3));
        }
        
        const atr = [];
        for (let i = period - 1; i < tr.length; i++) {
            const slice = tr.slice(i - period + 1, i + 1);
            atr.push(slice.reduce((a, b) => a + b) / period);
        }
        
        return atr;
    };

    // -------------------- IMPROVED S/R DETECTION --------------------
    const advancedLevels = findAdvancedSwingLevels(high, low, 8, 3);
    const currentATR = calculateATR(high, low, close, 14).pop() || 0;
    
    // Filter level yang terlalu dekat dengan harga current (min 0.5 ATR)
    const minDistance = currentATR * 0.5;
    
    const validResistance = advancedLevels.resistance
        .filter(level => level.price > price + minDistance)
        .sort((a, b) => a.price - b.price); // Urutkan dari terdekat
    
    const validSupport = advancedLevels.support
        .filter(level => level.price < price - minDistance)
        .sort((a, b) => b.price - a.price); // Urutkan dari terdekat

    // Pilih level terdekat yang valid, atau fallback ke method lama
    const resistance = validResistance.length > 0 ? 
        validResistance[0].price : 
        Math.max(...high.slice(-96));
    
    const support = validSupport.length > 0 ? 
        validSupport[0].price : 
        Math.min(...low.slice(-96));

    const targetLong = resistance;
    const stopLossLong = support;
    const targetShort = support;
    const stopLossShort = resistance;

    // -------------------- ENHANCED LOGGING --------------------
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
🎯 Advanced Support/Resistance:
- ATR Current: ${formatPrice(currentATR)}
- Resistance Levels: ${validResistance.map(l => formatPrice(l.price) + `(strength:${l.strength})`).join(', ')}
- Support Levels: ${validSupport.map(l => formatPrice(l.price) + `(strength:${l.strength})`).join(', ')}
- Selected Resistance: ${formatPrice(resistance)}
- Selected Support: ${formatPrice(support)}
-----------------------------------
📈 Strategi Long:
- Target: ${formatPrice(targetLong)}
- Stop Loss: ${formatPrice(stopLossLong)}
- Risk/Reward: ${((targetLong - price) / (price - stopLossLong)).toFixed(2)}
-----------------------------------
📉 Strategi Short:
- Target: ${formatPrice(targetShort)}
- Stop Loss: ${formatPrice(stopLossShort)}
- Risk/Reward: ${((price - targetShort) / (stopLossShort - price)).toFixed(2)}
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

// -------------------- DYNAMIC TP/SL UPDATE --------------------
const updateTPSLForOpenPosition = async (signal) => {
    if (!db.activePosition) return;
    
    try {
        console.log("🔄 Update TP/SL: Memeriksa update untuk posisi terbuka...");
        
        const { side, entryPrice, tp: currentTP, sl: currentSL } = db.activePosition;
        let newTP, newSL;

        if (side === "buy") {
            // Untuk LONG position - TP di Resistance, SL di Support
            newTP = signal.targetLong;    // Resistance terbaru
            newSL = signal.stopLossLong;  // Support terbaru
            
            // ✅ FIX: Jangan update TP jika harga SUDAH DEKAT dengan current TP (80% profit tercapai)
            const profitToCurrentTP = (currentTP - entryPrice) / entryPrice * 100;
            const profitToNewTP = (newTP - entryPrice) / entryPrice * 100;
            
            // Jika sudah profit 80% ke current TP, jangan ganti TP
            if (profitToCurrentTP >= 0.8 && newTP > currentTP) {
                console.log(`🎯 Update TP/SL: Sudah profit ${profitToCurrentTP.toFixed(2)}%, pertahankan TP lama.`);
                newTP = currentTP;
            }
            
            // Validasi: TP harus > entry price, SL harus < entry price
            if (newTP <= entryPrice || newSL >= entryPrice) {
                console.log("⚠️ Update TP/SL: Level TP/SL tidak valid untuk LONG, skip update.");
                return;
            }
            
            // Safety: Jangan pindah SL jadi lebih riskan (lebih dekat ke entry)
            if (newSL > currentSL) {
                console.log("🛡️ Update TP/SL: SL baru lebih riskan untuk LONG, pertahankan SL lama.");
                newSL = currentSL;
            }
            
        } else if (side === "sell") {
            // Untuk SHORT position - TP di Support, SL di Resistance  
            newTP = signal.targetShort;   // Support terbaru
            newSL = signal.stopLossShort; // Resistance terbaru
            
            // ✅ FIX: Jangan update TP jika harga SUDAH DEKAT dengan current TP (80% profit tercapai)
            const profitToCurrentTP = (entryPrice - currentTP) / entryPrice * 100;
            const profitToNewTP = (entryPrice - newTP) / entryPrice * 100;
            
            // Jika sudah profit 80% ke current TP, jangan ganti TP
            if (profitToCurrentTP >= 0.8 && newTP < currentTP) {
                console.log(`🎯 Update TP/SL: Sudah profit ${profitToCurrentTP.toFixed(2)}%, pertahankan TP lama.`);
                newTP = currentTP;
            }
            
            // Validasi: TP harus < entry price, SL harus > entry price
            if (newTP >= entryPrice || newSL <= entryPrice) {
                console.log("⚠️ Update TP/SL: Level TP/SL tidak valid untuk SHORT, skip update.");
                return;
            }
            
            // Safety: Jangan pindah SL jadi lebih riskan (lebih dekat ke entry)
            if (newSL < currentSL) {
                console.log("🛡️ Update TP/SL: SL baru lebih riskan untuk SHORT, pertahankan SL lama.");
                newSL = currentSL;
            }
        } else {
            return;
        }

        // ✅ FIX: Batasi maksimal TP update (jangan terlalu jauh dari entry)
        const maxProfitPercent = 2.0; // Maksimal 2% profit dari entry
        let currentPrice = signal.price;
        
        if (side === "buy") {
            const maxTP = entryPrice * (1 + maxProfitPercent / 100);
            if (newTP > maxTP) {
                console.log(`📏 Update TP/SL: TP baru terlalu jauh, batasi ke ${formatPrice(maxTP)}`);
                newTP = maxTP;
            }
        } else if (side === "sell") {
            const maxTP = entryPrice * (1 - maxProfitPercent / 100);
            if (newTP < maxTP) {
                console.log(`📏 Update TP/SL: TP baru terlalu jauh, batasi ke ${formatPrice(maxTP)}`);
                newTP = maxTP;
            }
        }

        // Cek apakah ada perubahan yang signifikan (minimal 0.2% perubahan)
        const tpChangePercent = Math.abs((newTP - currentTP) / currentTP * 100);
        const slChangePercent = Math.abs((newSL - currentSL) / currentSL * 100);
        
        const minChangeThreshold = 0.2; // Naikkan threshold jadi 0.2%
        
        if (tpChangePercent < minChangeThreshold && slChangePercent < minChangeThreshold) {
            console.log("ℹ️ Update TP/SL: Perubahan tidak signifikan, skip update.");
            return;
        }

        // Update TP/SL di database
        db.activePosition.tp = newTP;
        db.activePosition.sl = newSL;
        saveDB();

        console.log(`✅ TP/SL Updated untuk posisi ${side.toUpperCase()}:`);
        console.log(`   Entry: ${formatPrice(entryPrice)}`);
        console.log(`   TP: ${formatPrice(currentTP)} → ${formatPrice(newTP)} (${tpChangePercent.toFixed(2)}%)`);
        console.log(`   SL: ${formatPrice(currentSL)} → ${formatPrice(newSL)} (${slChangePercent.toFixed(2)}%)`);
        
        // Hitung profit potential
        if (side === "buy") {
            const profitPercent = ((newTP - entryPrice) / entryPrice * 100).toFixed(2);
            console.log(`   Profit Potential: +${profitPercent}%`);
        } else {
            const profitPercent = ((entryPrice - newTP) / entryPrice * 100).toFixed(2);
            console.log(`   Profit Potential: +${profitPercent}%`);
        }
        
        // Log perubahan
        logSignal(
            side === "buy" ? "LONG" : "SHORT",
            entryPrice,
            newTP,
            newSL,
            "TP_SL_UPDATED"
        );

    } catch (error) {
        console.error("❌ Update TP/SL: Gagal update:", error.message);
    }
};

// -------------------- POSITION RECOVERY --------------------
const recoverPositionState = async () => {
    try {
        console.log("🔄 Memeriksa sinkronisasi posisi...");
        
        const { position } = await getPositionFromBalance();
        const amt = parseFloat(position?.positionAmt || "0");
        const MIN_POSITION_AMOUNT = 0.000001;
        const amtSafe = isFinite(amt) ? amt : 0;
        
        // SCENARIO 1: Ada posisi di Binance tapi DB null
        if (Math.abs(amtSafe) > MIN_POSITION_AMOUNT && !db.activePosition) {
            console.log("\n⚠️  **POSITION RECOVERY NEEDED**");
            console.log("   ──────────────────────────────");
            console.log("   📊 Ditemukan posisi aktif di Binance");
            console.log("   💾 Tidak tercatat di database lokal");
            
            const currentPrice = await getPrice();
            if (!currentPrice) return;
            
            // Reconstruct position info
            const side = amtSafe > 0 ? "buy" : "sell";
            const entryPrice = parseFloat(position?.entryPrice || currentPrice);
            const leverage = position?.leverage || db.leverage;
            
            // DAPATKAN SINYAL TERKINI DENGAN FALLBACK
            const signal = await analyzeSignal();
            let tp, sl;
            
            if (!signal || !signal.price) {
                console.log("   ⚠️  Gagal analisis, menggunakan fallback TP/SL");
                if (side === "buy") {
                    tp = entryPrice * 1.015;
                    sl = entryPrice * 0.995;
                } else {
                    tp = entryPrice * 0.985;
                    sl = entryPrice * 1.005;
                }
            } else {
                if (side === "buy") {
                    tp = signal.targetLong || (entryPrice * 1.015);
                    sl = signal.stopLossLong || (entryPrice * 0.995);
                } else {
                    tp = signal.targetShort || (entryPrice * 0.985);
                    sl = signal.stopLossShort || (entryPrice * 1.005);
                }
            }
            
            // SAFETY MARGIN
            const SAFETY_MARGIN = 0.001;
            if (side === "buy") {
                tp = tp * (1 - SAFETY_MARGIN);
                sl = sl * (1 + SAFETY_MARGIN);
            } else {
                tp = tp * (1 + SAFETY_MARGIN);
                sl = sl * (1 - SAFETY_MARGIN);
            }
            
            // VALIDASI TP/SL
            if (side === "buy") {
                if (tp <= entryPrice) tp = entryPrice * 1.015;
                if (sl >= entryPrice) sl = entryPrice * 0.995;
            } else {
                if (tp >= entryPrice) tp = entryPrice * 0.985;
                if (sl <= entryPrice) sl = entryPrice * 1.005;
            }
            
            // Hitung Risk/Reward Ratio
            let rrRatio;
            if (side === "buy") {
                rrRatio = ((tp - entryPrice) / (entryPrice - sl)).toFixed(2);
            } else {
                rrRatio = ((entryPrice - tp) / (sl - entryPrice)).toFixed(2);
            }
            
            // Rebuild activePosition in DB
            db.activePosition = {
                side: side,
                entryPrice: entryPrice,
                tp: tp,
                sl: sl,
                orderId: "RECOVERED_" + Date.now(),
                recovered: true,
                rrRatio: parseFloat(rrRatio),
                recoveredAt: new Date().toISOString()
            };
            
            saveDB();
            
            console.log("\n✅ **POSITION RECOVERED SUCCESSFULLY**");
            console.log("   ──────────────────────────────────");
            console.log(`   📈 Position: ${side.toUpperCase()}`);
            console.log(`   💰 Entry: ${formatPrice(entryPrice)}`);
            console.log(`   🎯 Take Profit: ${formatPrice(tp)}`);
            console.log(`   🛡️  Stop Loss: ${formatPrice(sl)}`);
            console.log(`   📊 Risk/Reward: ${rrRatio}`);
            console.log(`   ⚡ Leverage: ${leverage}x`);
            console.log(`   🕒 Recovered: ${new Date().toLocaleTimeString()}`);
            
            // Hitung unrealized PnL
            const unrealizedPnl = side === "buy" ? currentPrice - entryPrice : entryPrice - currentPrice;
            const pnlPercent = (unrealizedPnl / entryPrice * 100).toFixed(2);
            const pnlEmoji = unrealizedPnl >= 0 ? "📈" : "📉";
            
            console.log(`   ${pnlEmoji} Unrealized PnL: ${formatPrice(unrealizedPnl)} (${pnlPercent}%)`);
            console.log("   ──────────────────────────────────");
            
            logSignal(
                side === "buy" ? "LONG" : "SHORT",
                entryPrice,
                tp,
                sl,
                "POSITION_RECOVERED"
            );
        }
        
        // SCENARIO 2: DB ada posisi tapi Binance sudah closed
        if (db.activePosition && Math.abs(amtSafe) <= MIN_POSITION_AMOUNT) {
            console.log("\n⚠️  **POSITION CLEANUP NEEDED**");
            console.log("   ─────────────────────────────");
            console.log("   💾 Posisi tercatat di database");
            console.log("   📊 Tidak ditemukan di Binance");
            
            const wasRecovered = db.activePosition.recovered ? " (Recovered Position)" : "";
            const side = db.activePosition.side === "buy" ? "LONG" : "SHORT";
            
            console.log(`   🔄 Membersihkan: ${side}${wasRecovered}`);
            
            logSignal(
                side,
                db.activePosition.entryPrice,
                db.activePosition.tp,
                db.activePosition.sl,
                "CLOSED_EXTERNALLY" + wasRecovered
            );
            
            db.activePosition = null;
            saveDB();
            
            console.log("   ✅ Database berhasil dibersihkan");
            console.log("   ─────────────────────────────");
        }
        
        // SCENARIO 3: Log current position status untuk monitoring
        if (db.activePosition && Math.abs(amtSafe) > MIN_POSITION_AMOUNT) {
            const currentPrice = await getPrice();
            if (currentPrice) {
                const { side, entryPrice, tp, sl, recovered } = db.activePosition;
                const unrealizedPnl = side === "buy" ? currentPrice - entryPrice : entryPrice - currentPrice;
                const pnlPercent = (unrealizedPnl / entryPrice * 100).toFixed(2);
                
                // Check jika mendekati TP/SL
                let status = "🟢 NORMAL";
                let warning = "";
                
                if (side === "buy") {
                    if (currentPrice >= tp * 0.998) {
                        status = "🟡 DEKAT TP";
                        warning = " - Hampir Take Profit!";
                    } else if (currentPrice <= sl * 1.002) {
                        status = "🔴 DEKAT SL";
                        warning = " - Hampir Stop Loss!";
                    }
                } else {
                    if (currentPrice <= tp * 1.002) {
                        status = "🟡 DEKAT TP";
                        warning = " - Hampir Take Profit!";
                    } else if (currentPrice >= sl * 0.998) {
                        status = "🔴 DEKAT SL";
                        warning = " - Hampir Stop Loss!";
                    }
                }
                
                const recoveryTag = recovered ? " ♻️ RECOVERED" : "";
                const pnlEmoji = unrealizedPnl >= 0 ? "💹" : "🔻";
                
                console.log("\n📊 **POSITION MONITOR**" + recoveryTag);
                console.log("   ─────────────────────────────");
                console.log(`   ${side.toUpperCase()} | ${status}${warning}`);
                console.log(`   💰 Entry: ${formatPrice(entryPrice)}`);
                console.log(`   📈 Current: ${formatPrice(currentPrice)}`);
                console.log(`   🎯 TP: ${formatPrice(tp)}`);
                console.log(`   🛡️  SL: ${formatPrice(sl)}`);
                console.log(`   ${pnlEmoji} PnL: ${formatPrice(unrealizedPnl)} (${pnlPercent}%)`);
                
                // Progress bar untuk TP/SL
                if (side === "buy") {
                    const progressToTP = Math.max(0, Math.min(100, ((currentPrice - entryPrice) / (tp - entryPrice)) * 100));
                    const progressToSL = Math.max(0, Math.min(100, ((entryPrice - currentPrice) / (entryPrice - sl)) * 100));
                    console.log(`   📊 Progress TP: ${progressToTP.toFixed(1)}%`);
                    console.log(`   📊 Progress SL: ${progressToSL.toFixed(1)}%`);
                } else {
                    const progressToTP = Math.max(0, Math.min(100, ((entryPrice - currentPrice) / (entryPrice - tp)) * 100));
                    const progressToSL = Math.max(0, Math.min(100, ((currentPrice - entryPrice) / (sl - entryPrice)) * 100));
                    console.log(`   📊 Progress TP: ${progressToTP.toFixed(1)}%`);
                    console.log(`   📊 Progress SL: ${progressToSL.toFixed(1)}%`);
                }
                console.log("   ─────────────────────────────");
            }
        }
        
    } catch (err) {
        console.log("\n❌ **RECOVERY ERROR**");
        console.log("   ──────────────────");
        console.log(`   💥 Error: ${err.message}`);
        console.log("   ──────────────────");
    }
};

// -------------------- MAIN LOOP --------------------
setInterval(async () => {
    // ✅ AUTO RELOAD CONFIG
    try {
        const freshDb = JSON.parse(fs.readFileSync(dbPath));
        db.pair = freshDb.pair;
        db.leverage = freshDb.leverage; 
        db.marginMode = freshDb.marginMode;
        db.usdtPerTrade = freshDb.usdtPerTrade;
    } catch (error) {
        // Biarkan pakai config lama kalau error
    }

    if (isProcessing) {
        console.log("⏳ Skip: Masih processing sebelumnya...");
        return;
    }
    
    isProcessing = true;
    try {
        const now = new Date();
        
        // ✅ POSITION RECOVERY - TAMBAHKAN INI SEBELUM CHECK POSITION
        await recoverPositionState();
        await checkPositionStatus();

        console.log("🔍 Loop Utama: Memeriksa sinyal baru...");
        console.log("🔍 Status Posisi Aktif di DB: ", db.activePosition);
        console.log("⚙️ Config Aktif:", { 
            pair: db.pair, 
            leverage: db.leverage,
            usdtPerTrade: db.usdtPerTrade 
        });

        const signal = await analyzeSignal();
        if (!signal.price) {
            console.log("⚠️ Analisis: Sinyal tidak valid, menunggu...");
            return;
        }

        // ✅ UPDATE TP/SL UNTUK POSISI TERBUKA
        if (db.activePosition) {
            await updateTPSLForOpenPosition(signal);
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
    } finally {
        isProcessing = false;
    }
}, 30000);
