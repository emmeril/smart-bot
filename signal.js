// signal.js (Simple Scalping Version - Profit Kecil, Tanpa Stop Loss) - ISOLATED MARGIN
require("dotenv").config();
const fs = require("fs");
const ccxt = require("ccxt");
const { EMA, RSI } = require("technicalindicators"); // Ganti SMA dengan EMA

// -------------------- CONFIG SEDERHANA --------------------
const dbPath = "./db.json";
const logPath = "./log.csv";
let isProcessing = false;
let exchange = null;
let signalCount = 0;
let lastLogTime = Date.now();

// -------------------- LOAD CONFIG --------------------
const loadDB = () => {
    try {
        if (fs.existsSync(dbPath)) {
            return JSON.parse(fs.readFileSync(dbPath));
        }
    } catch (error) {
        console.warn("⚠️ Failed to load DB, using default config");
    }

    return {
        pair: "XRP/USDT:USDT",
        usdtPerTrade: 5,
        leverage: 15,
        targetProfitPercent: 0.3,
        maxDailyLossPercent: 10,
        coolingPeriod: 3000,
        activePosition: null,
        dailyPnL: 0,
        dailyTrades: 0,
        marginMode: "isolated"
    };
};

let db = loadDB();

// -------------------- INIT EXCHANGE --------------------
const initializeExchange = async () => {
    try {
        exchange = new ccxt.binance({
            apiKey: process.env.API_KEY,
            secret: process.env.API_SECRET,
            options: { defaultType: "future" },
            enableRateLimit: true,
        });

        await exchange.loadMarkets();
        console.log("✅ Exchange connected");
        return exchange;
    } catch (error) {
        console.error("❌ Exchange connection failed:", error.message);
        throw error;
    }
};

// -------------------- SET ISOLATED MARGIN MODE --------------------
const setMarginMode = async () => {
    try {
        await exchange.setMarginMode("isolated", db.pair);
        console.log("✅ Margin mode set to: ISOLATED");
    } catch (error) {
        if (!error.message.includes("No need to change margin mode")) {
            console.warn("⚠️ Margin mode setting warning:", error.message);
        }
    }
};

// -------------------- SIMPLE SIGNAL DETECTION --------------------
const analyzeSignal = async () => {
    try {
        signalCount++;
        const now = Date.now();
        
        // Log hanya setiap 5 detik untuk mengurangi spam
        if (now - lastLogTime > 5000) {
            console.log(`\n📊 [SIGNAL #${signalCount}] Analyzing market...`);
            lastLogTime = now;
        }
        
        // Gunakan timeframe 1m untuk scalping cepat, ambil 50 candle untuk data yang cukup
        const ohlcv = await exchange.fetchOHLCV(db.pair, "1m", undefined, 50);
        
        if (ohlcv.length < 20) {
            if (now - lastLogTime > 5000) {
                console.log(`⚠️ Not enough OHLCV data: ${ohlcv.length} candles (need at least 20)`);
            }
            return {};
        }

        const close = ohlcv.map(c => c[4]);
        const currentPrice = close[close.length - 1];
        
        if (now - lastLogTime > 5000) {
            console.log(`💰 Current Price: ${currentPrice} USDT`);
            console.log(`📈 Data points: ${close.length} candles available`);
        }

        // EMA 5 & 10 untuk sinyal cepat
        // Untuk EMA 10, kita butuh minimal 11 data untuk mendapatkan 2 titik perbandingan
        // Ambil data yang cukup untuk perhitungan
        const valuesForEMA = close.slice(-30); // Ambil 30 data terakhir untuk perhitungan
        
        try {
            const ema5 = EMA.calculate({ values: valuesForEMA, period: 5 });
            const ema10 = EMA.calculate({ values: valuesForEMA, period: 10 });

            if (ema5.length < 2 || ema10.length < 2) {
                if (now - lastLogTime > 5000) {
                    console.log(`⚠️ EMA calculation failed: EMA5=${ema5.length}, EMA10=${ema10.length} (need at least 2 each)`);
                    console.log(`   Using ${valuesForEMA.length} data points`);
                }
                return {};
            }

            const currentEma5 = ema5[ema5.length - 1];
            const currentEma10 = ema10[ema10.length - 1];
            const prevEma5 = ema5[ema5.length - 2];
            const prevEma10 = ema10[ema10.length - 2];

            // RSI 7 untuk konfirmasi - butuh minimal 8 data untuk 2 titik
            const valuesForRSI = close.slice(-25); // Ambil lebih banyak untuk RSI
            const rsi = RSI.calculate({ values: valuesForRSI, period: 7 });
            const currentRSI = rsi.length > 0 ? rsi[rsi.length - 1] : 50;

            // Sinyal sederhana
            const bullishCross = currentEma5 > currentEma10 && prevEma5 <= prevEma10;
            const bearishCross = currentEma5 < currentEma10 && prevEma5 >= prevEma10;

            // Target profit kecil (0.3%)
            const targetProfit = db.targetProfitPercent / 100;
            const targetLong = currentPrice * (1 + targetProfit);
            const targetShort = currentPrice * (1 - targetProfit);

            // LOG DETAILED ANALYSIS (hanya tampilkan jika ada perubahan signifikan atau setiap 5 detik)
            const hasSignal = bullishCross || bearishCross;
            
            if (hasSignal || now - lastLogTime > 5000) {
                console.log("\n" + "=".repeat(50));
                console.log("📈 INDICATOR VALUES:");
                console.log(`   Current Price: ${currentPrice}`);
                console.log(`   EMA 5: ${currentEma5.toFixed(6)} (prev: ${prevEma5.toFixed(6)})`);
                console.log(`   EMA 10: ${currentEma10.toFixed(6)} (prev: ${prevEma10.toFixed(6)})`);
                console.log(`   RSI 7: ${currentRSI.toFixed(2)}`);
                console.log("");
                console.log("🎯 SIGNAL CONDITIONS:");
                console.log(`   EMA Crossover: ${bullishCross ? "BULLISH ↗️" : bearishCross ? "BEARISH ↘️" : "NO CROSS"}`);
                
                if (bullishCross) {
                    console.log(`   RSI for LONG: ${currentRSI > 40 && currentRSI < 75 ? "✅ OK" : "❌ NOT OK (RSI: " + currentRSI.toFixed(2) + ")"}`);
                }
                if (bearishCross) {
                    console.log(`   RSI for SHORT: ${currentRSI < 60 && currentRSI > 25 ? "✅ OK" : "❌ NOT OK (RSI: " + currentRSI.toFixed(2) + ")"}`);
                }
                console.log("");
                
                const canLong = bullishCross && currentRSI > 40 && currentRSI < 75;
                const canShort = bearishCross && currentRSI < 60 && currentRSI > 25;
                
                console.log("🚦 FINAL SIGNAL:");
                console.log(`   LONG Signal: ${canLong ? "✅ READY" : "❌ NOT READY"}`);
                console.log(`   SHORT Signal: ${canShort ? "✅ READY" : "❌ NOT READY"}`);
                
                if (canLong) {
                    console.log(`   🎯 LONG Target: ${targetLong.toFixed(6)} (+${db.targetProfitPercent}%)`);
                }
                if (canShort) {
                    console.log(`   🎯 SHORT Target: ${targetShort.toFixed(6)} (-${db.targetProfitPercent}%)`);
                }
                console.log("=".repeat(50));
            }

            return {
                canLong: bullishCross && currentRSI > 40 && currentRSI < 75,
                canShort: bearishCross && currentRSI < 60 && currentRSI > 25,
                price: currentPrice,
                targetLong,
                targetShort,
                rsi: currentRSI,
                ema5: currentEma5,
                ema10: currentEma10,
                hasSignal: bullishCross || bearishCross
            };
        } catch (emaError) {
            console.error(`❌ EMA calculation error:`, emaError.message);
            return {};
        }
    } catch (error) {
        console.error("❌ Signal analysis failed:", error.message);
        return {};
    }
};

// -------------------- SIMPLE ORDER MANAGEMENT --------------------
const placeOrder = async (side, targetPrice) => {
    try {
        // Cek apakah sudah ada posisi aktif
        if (db.activePosition) {
            console.log("⚠️ Active position exists, skipping");
            return;
        }

        console.log(`\n🔄 [ORDER] Attempting to place ${side.toUpperCase()} order...`);
        
        // 1. Set margin mode ke ISOLATED
        await setMarginMode();
        
        // 2. Set leverage
        await exchange.setLeverage(db.leverage, db.pair);
        
        // 3. Hitung quantity - PERBAIKI: gunakan price dari signal, bukan dari db.activePosition
        const signalPrice = await getPrice();
        const qty = (db.usdtPerTrade * db.leverage) / signalPrice;
        const market = exchange.markets[db.pair];
        const precision = market?.precision?.amount || 3;
        const adjustedQty = parseFloat(qty.toFixed(precision));

        console.log(`   📊 Order Details:`);
        console.log(`   - Amount: ${db.usdtPerTrade} USDT × ${db.leverage}x = ${(db.usdtPerTrade * db.leverage).toFixed(2)} USDT`);
        console.log(`   - Quantity: ${adjustedQty} ${db.pair.split('/')[0]}`);
        console.log(`   - Entry Price: ${signalPrice}`);

        // 4. Place order dengan params untuk isolated margin
        const order = await exchange.createOrder(db.pair, "market", side, adjustedQty, undefined, {
            marginMode: "isolated"
        });
        
        // Simpan posisi aktif
        db.activePosition = {
            side: side,
            entryPrice: signalPrice,
            targetPrice: targetPrice,
            orderId: order.id,
            quantity: adjustedQty,
            entryTime: Date.now(),
            marginMode: "isolated"
        };

        saveDB();
        logTrade(side, signalPrice, targetPrice, "OPEN");

        console.log(`\n✅ ORDER PLACED:`);
        console.log(`   Type: ${side.toUpperCase()}`);
        console.log(`   Entry: ${signalPrice}`);
        console.log(`   Target: ${targetPrice} (+${db.targetProfitPercent}%)`);
        console.log(`   Order ID: ${order.id}`);
        console.log(`   Margin Mode: ISOLATED`);
        console.log(`   Time: ${new Date().toLocaleTimeString()}`);

    } catch (error) {
        console.error("❌ Order failed:", error.message);
    }
};

// -------------------- CHECK & CLOSE POSITION --------------------
const checkAndClosePosition = async () => {
    if (!db.activePosition) return;

    try {
        const currentPrice = await getPrice();
        if (!currentPrice) return;

        const { side, entryPrice, targetPrice } = db.activePosition;
        const profitPercent = side === "buy" 
            ? ((currentPrice - entryPrice) / entryPrice * 100)
            : ((entryPrice - currentPrice) / entryPrice * 100);

        // TUTUP JIKA PROFIT TARGET TERCAPAI
        if ((side === "buy" && currentPrice >= targetPrice) ||
            (side === "sell" && currentPrice <= targetPrice)) {
            
            console.log(`\n🎯 TARGET HIT! Closing position...`);
            console.log(`   Current Price: ${currentPrice}`);
            console.log(`   Target Price: ${targetPrice}`);
            console.log(`   Profit: ${profitPercent.toFixed(2)}%`);
            
            await closePosition("PROFIT_TARGET", profitPercent);
        }
        // TUTUP JIKAN SUDAH LEWAT 1 MENIT (safety)
        else if (Date.now() - db.activePosition.entryTime > 60000) {
            console.log(`\n⏰ TIMEOUT! Closing position after 1 minute...`);
            await closePosition("TIMEOUT", profitPercent);
        }
        // TAMPILKAN STATUS setiap 10 detik
        else {
            const timeElapsed = Math.floor((Date.now() - db.activePosition.entryTime) / 1000);
            if (timeElapsed % 10 === 0) { // Log hanya setiap 10 detik
                const status = profitPercent >= 0 ? "🟢" : "🔴";
                console.log(`\n📊 POSITION STATUS:`);
                console.log(`   ${status} Profit: ${profitPercent.toFixed(2)}% (Target: ${db.targetProfitPercent}%)`);
                console.log(`   Entry: ${entryPrice} | Current: ${currentPrice}`);
                console.log(`   Time in trade: ${timeElapsed}s`);
                console.log(`   Need: ${side === "buy" ? (targetPrice - currentPrice).toFixed(6) : (currentPrice - targetPrice).toFixed(6)} to target`);
            }
        }

    } catch (error) {
        console.error("❌ Position check failed:", error.message);
    }
};

const closePosition = async (reason, profitPercent) => {
    try {
        const { side, quantity, entryPrice } = db.activePosition;
        const closeSide = side === "buy" ? "sell" : "buy";
        
        console.log(`\n🔄 Closing position: ${side.toUpperCase()} -> ${closeSide.toUpperCase()}`);
        
        await exchange.createOrder(db.pair, "market", closeSide, quantity, undefined, {
            reduceOnly: true,
            marginMode: "isolated"
        });

        // Hitung PnL
        const currentPrice = await getPrice();
        const pnl = side === "buy" 
            ? (currentPrice - entryPrice) * quantity
            : (entryPrice - currentPrice) * quantity;

        // Update daily PnL
        db.dailyPnL += pnl;
        db.dailyTrades++;
        
        // Log trade
        logTrade(side === "buy" ? "LONG" : "SHORT", entryPrice, currentPrice, "CLOSE", pnl);
        
        console.log(`\n✅ POSITION CLOSED:`);
        console.log(`   Reason: ${reason}`);
        console.log(`   PnL: ${pnl.toFixed(4)} USDT (${profitPercent.toFixed(2)}%)`);
        console.log(`   Daily PnL: ${db.dailyPnL.toFixed(2)} USDT`);
        console.log(`   Daily Trades: ${db.dailyTrades}`);
        console.log(`   Exit Price: ${currentPrice}`);
        console.log(`   Time: ${new Date().toLocaleTimeString()}`);

        // Reset posisi aktif
        db.activePosition = null;
        saveDB();

    } catch (error) {
        console.error("❌ Close position failed:", error.message);
    }
};

// -------------------- UTILITY FUNCTIONS --------------------
const getPrice = async () => {
    try {
        const ticker = await exchange.fetchTicker(db.pair);
        return ticker.last;
    } catch (error) {
        console.error("❌ Failed to get price:", error.message);
        return null;
    }
};

const saveDB = () => {
    try {
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
    } catch (error) {
        console.error("❌ Failed to save DB:", error.message);
    }
};

const logTrade = (side, entry, exit, status, pnl = 0) => {
    try {
        const timestamp = new Date().toISOString();
        const line = `${timestamp},${db.pair},${side},${entry},${exit},${status},${pnl.toFixed(4)},${db.leverage},ISOLATED\n`;
        
        if (!fs.existsSync(logPath)) {
            fs.writeFileSync(logPath, "timestamp,pair,side,entry,exit,status,pnl,leverage,margin_mode\n");
        }
        
        fs.appendFileSync(logPath, line);
    } catch (error) {
        console.error("❌ Failed to log trade:", error.message);
    }
};

// -------------------- MAIN LOOP --------------------
(async () => {
    try {
        // Initialize
        await initializeExchange();
        
        // Set margin mode awal ke ISOLATED
        await setMarginMode();
        
        const balance = await exchange.fetchBalance();
        const totalUSDT = balance.total?.USDT || 0;
        
        console.log("\n" + "=".repeat(60));
        console.log("🚀 SIMPLE SCALPING BOT STARTED (ISOLATED MARGIN)");
        console.log("=".repeat(60));
        console.log(`💰 Balance: ${totalUSDT.toFixed(2)} USDT`);
        console.log(`📊 Pair: ${db.pair}`);
        console.log(`🎯 Target Profit: ${db.targetProfitPercent}% per trade`);
        console.log(`⚡ Leverage: ${db.leverage}x`);
        console.log(`🛡️ Margin Mode: ISOLATED`);
        console.log(`📈 Strategy: Quick scalping, NO STOP LOSS`);
        console.log(`🔍 Signal Check: Every 2 seconds`);
        console.log(`📊 Data Points: 50 candles (1m timeframe)`);
        console.log("=".repeat(60) + "\n");

        // Main loop setiap 2 detik
        setInterval(async () => {
            if (isProcessing) {
                return;
            }
            isProcessing = true;

            try {
                // 1. Cek & tutup posisi jika profit target tercapai
                await checkAndClosePosition();

                // 2. Cek daily loss limit
                const maxDailyLoss = totalUSDT * db.maxDailyLossPercent / 100;
                if (db.dailyPnL < -maxDailyLoss) {
                    console.log(`\n⛔ DAILY LOSS LIMIT REACHED!`);
                    console.log(`   Daily PnL: ${db.dailyPnL.toFixed(2)} USDT`);
                    console.log(`   Max Allowed: -${maxDailyLoss.toFixed(2)} USDT`);
                    console.log(`   Trading paused for today`);
                    isProcessing = false;
                    return;
                }

                // 3. Cek cooling period
                if (db.activePosition) {
                    const timeSinceEntry = Date.now() - db.activePosition.entryTime;
                    if (timeSinceEntry < db.coolingPeriod) {
                        const remaining = Math.floor((db.coolingPeriod - timeSinceEntry)/1000);
                        if (remaining % 5 === 0) { // Log setiap 5 detik
                            console.log(`⏳ Cooling period: ${remaining}s remaining`);
                        }
                        isProcessing = false;
                        return;
                    }
                }

                // 4. Analisis sinyal baru
                const signal = await analyzeSignal();
                
                if (!signal.price) {
                    isProcessing = false;
                    return;
                }

                // 5. Jika tidak ada posisi aktif, cari sinyal entry
                if (!db.activePosition) {
                    if (signal.canLong) {
                        console.log(`\n🎯 LONG SIGNAL CONFIRMED!`);
                        console.log(`   Price: ${signal.price}`);
                        console.log(`   RSI: ${signal.rsi.toFixed(2)}`);
                        console.log(`   EMA5 > EMA10: ${signal.ema5.toFixed(6)} > ${signal.ema10.toFixed(6)}`);
                        await placeOrder("buy", signal.targetLong);
                    } 
                    else if (signal.canShort) {
                        console.log(`\n🎯 SHORT SIGNAL CONFIRMED!`);
                        console.log(`   Price: ${signal.price}`);
                        console.log(`   RSI: ${signal.rsi.toFixed(2)}`);
                        console.log(`   EMA5 < EMA10: ${signal.ema5.toFixed(6)} < ${signal.ema10.toFixed(6)}`);
                        await placeOrder("sell", signal.targetShort);
                    }
                }

            } catch (error) {
                console.error(`\n⚠️ Loop error:`, error.message);
            } finally {
                isProcessing = false;
            }
        }, 2000); // Loop setiap 2 detik

    } catch (error) {
        console.error("❌ Bot startup failed:", error.message);
        process.exit(1);
    }
})();