// signal.js (Simple Scalping Version - Profit Kecil, Tanpa Stop Loss)
require("dotenv").config();
const fs = require("fs");
const ccxt = require("ccxt");
const { SMA, RSI } = require("technicalindicators");

// -------------------- CONFIG SEDERHANA --------------------
const dbPath = "./db.json";
const logPath = "./log.csv";
let isProcessing = false;
let exchange = null;

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
        dailyTrades: 0             
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

// -------------------- SIMPLE SIGNAL DETECTION --------------------
const analyzeSignal = async () => {
    try {
        // Gunakan timeframe 1m untuk scalping cepat
        const ohlcv = await exchange.fetchOHLCV(db.pair, "1m", undefined, 20);
        if (ohlcv.length < 15) return {};

        const close = ohlcv.map(c => c[4]);
        const currentPrice = close[close.length - 1];

        // EMA 5 & 10 untuk sinyal cepat
        const ema5 = SMA.calculate({ values: close.slice(-10), period: 5 });
        const ema10 = SMA.calculate({ values: close.slice(-10), period: 10 });

        if (ema5.length < 2 || ema10.length < 2) return {};

        const currentEma5 = ema5[ema5.length - 1];
        const currentEma10 = ema10[ema10.length - 1];
        const prevEma5 = ema5[ema5.length - 2];
        const prevEma10 = ema10[ema10.length - 2];

        // RSI 7 untuk konfirmasi
        const rsi = RSI.calculate({ values: close.slice(-15), period: 7 });
        const currentRSI = rsi[rsi.length - 1] || 50;

        // Sinyal sederhana
        const bullishCross = currentEma5 > currentEma10 && prevEma5 <= prevEma10;
        const bearishCross = currentEma5 < currentEma10 && prevEma5 >= prevEma10;

        // Target profit kecil (0.3%)
        const targetProfit = db.targetProfitPercent / 100;
        const targetLong = currentPrice * (1 + targetProfit);
        const targetShort = currentPrice * (1 - targetProfit);

        return {
            canLong: bullishCross && currentRSI > 40 && currentRSI < 75,
            canShort: bearishCross && currentRSI < 60 && currentRSI > 25,
            price: currentPrice,
            targetLong,
            targetShort,
            rsi: currentRSI
        };
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

        // Set leverage
        await exchange.setLeverage(db.leverage, db.pair);
        
        // Hitung quantity
        const qty = (db.usdtPerTrade * db.leverage) / db.activePosition.price;
        const market = exchange.markets[db.pair];
        const precision = market?.precision?.amount || 3;
        const adjustedQty = parseFloat(qty.toFixed(precision));

        // Place order
        const order = await exchange.createOrder(db.pair, "market", side, adjustedQty);
        
        // Simpan posisi aktif
        db.activePosition = {
            side: side,
            entryPrice: db.activePosition.price,
            targetPrice: targetPrice,
            orderId: order.id,
            quantity: adjustedQty,
            entryTime: Date.now()
        };

        saveDB();
        logTrade(side, db.activePosition.price, targetPrice, "OPEN");

        console.log(`✅ ${side.toUpperCase()} order placed at ${db.activePosition.price}`);
        console.log(`🎯 Target: ${targetPrice} (${db.targetProfitPercent}% profit)`);

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
            
            await closePosition("PROFIT_TARGET", profitPercent);
        }
        // TUTUP JIKAN SUDAH LEWAT 1 MENIT (safety)
        else if (Date.now() - db.activePosition.entryTime > 60000) {
            await closePosition("TIMEOUT", profitPercent);
        }
        // TAMPILKAN STATUS
        else {
            const status = profitPercent >= 0 ? "🟢" : "🔴";
            console.log(`${status} Position: ${profitPercent.toFixed(2)}% | Target: ${db.targetProfitPercent}%`);
        }

    } catch (error) {
        console.error("❌ Position check failed:", error.message);
    }
};

const closePosition = async (reason, profitPercent) => {
    try {
        const { side, quantity, entryPrice } = db.activePosition;
        const closeSide = side === "buy" ? "sell" : "buy";
        
        await exchange.createOrder(db.pair, "market", closeSide, quantity, undefined, {
            reduceOnly: true
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
        
        console.log(`✅ Position closed: ${reason}`);
        console.log(`💰 PnL: ${pnl.toFixed(4)} USDT (${profitPercent.toFixed(2)}%)`);
        console.log(`📊 Daily PnL: ${db.dailyPnL.toFixed(2)} USDT`);

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
        const line = `${timestamp},${db.pair},${side},${entry},${exit},${status},${pnl.toFixed(4)},${db.leverage}\n`;
        
        if (!fs.existsSync(logPath)) {
            fs.writeFileSync(logPath, "timestamp,pair,side,entry,exit,status,pnl,leverage\n");
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
        
        const balance = await exchange.fetchBalance();
        const totalUSDT = balance.total?.USDT || 0;
        
        console.log("\n" + "=".repeat(50));
        console.log("🚀 SIMPLE SCALPING BOT STARTED");
        console.log("=".repeat(50));
        console.log(`💰 Balance: ${totalUSDT.toFixed(2)} USDT`);
        console.log(`📊 Pair: ${db.pair}`);
        console.log(`🎯 Target Profit: ${db.targetProfitPercent}% per trade`);
        console.log(`⚡ Leverage: ${db.leverage}x`);
        console.log(`📈 Strategy: Quick scalping, NO STOP LOSS`);
        console.log("=".repeat(50) + "\n");

        // Main loop setiap 2 detik
        setInterval(async () => {
            if (isProcessing) return;
            isProcessing = true;

            try {
                // 1. Cek & tutup posisi jika profit target tercapai
                await checkAndClosePosition();

                // 2. Cek daily loss limit
                if (db.dailyPnL < -(totalUSDT * db.maxDailyLossPercent / 100)) {
                    console.log("⛔ Daily loss limit reached, pausing trading");
                    isProcessing = false;
                    return;
                }

                // 3. Cek cooling period
                if (db.activePosition) {
                    const timeSinceEntry = Date.now() - db.activePosition.entryTime;
                    if (timeSinceEntry < db.coolingPeriod) {
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
                        console.log(`📈 LONG signal detected at ${signal.price}`);
                        await placeOrder("buy", signal.targetLong);
                    } 
                    else if (signal.canShort) {
                        console.log(`📉 SHORT signal detected at ${signal.price}`);
                        await placeOrder("sell", signal.targetShort);
                    }
                }

            } catch (error) {
                console.error("⚠️ Loop error:", error.message);
            } finally {
                isProcessing = false;
            }
        }, 2000); // Loop setiap 2 detik

    } catch (error) {
        console.error("❌ Bot startup failed:", error.message);
        process.exit(1);
    }
})();