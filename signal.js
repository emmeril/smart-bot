// signal.js (Real-time Scalping Version) - ISOLATED MARGIN
require("dotenv").config();
const fs = require("fs");
const ccxt = require("ccxt");
const { EMA, RSI } = require("technicalindicators");

// -------------------- CONFIG --------------------
const dbPath = "./db.json";
const logPath = "./log.csv";
let isProcessing = false;
let exchange = null;
let signalCount = 0;
let lastLogTime = Date.now();
let lastPnlLog = Date.now();

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
        pair: "DOGE/USDT:USDT",
        usdtPerTrade: 5,
        leverage: 75,
        targetProfitUSDT: 0.01,
        maxDailyLossPercent: 10,
        coolingPeriod: 3000,
        activePosition: null,
        dailyPnL: 0,
        dailyTrades: 0,
        marginMode: "isolated",
        monitoringInterval: 500,
        stopLossPercent: 50 
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

// -------------------- REAL-TIME PNL MONITORING --------------------
const startPnLMonitoring = async () => {
    console.log("📈 Starting real-time P&L monitoring...");
    
    setInterval(async () => {
        if (!db.activePosition) return;
        
        try {
            const currentPrice = await getPrice();
            if (!currentPrice) return;

            const { side, entryPrice, quantity, targetProfitUSDT } = db.activePosition;
            
            // Calculate real-time profit
            const profitUSDT = side === "buy" 
                ? (currentPrice - entryPrice) * quantity
                : (entryPrice - currentPrice) * quantity;
            
            // Calculate profit percentage
            const profitPercent = side === "buy" 
                ? ((currentPrice - entryPrice) / entryPrice * 100)
                : ((entryPrice - currentPrice) / entryPrice * 100);

            // Check profit target - CLOSE IMMEDIATELY if reached
            if (profitUSDT >= targetProfitUSDT) {
                console.log(`\n🚨 PROFIT TARGET HIT! Closing immediately...`);
                console.log(`   Profit: ${profitUSDT.toFixed(4)} USDT (Target: ${targetProfitUSDT} USDT)`);
                console.log(`   Price moved from ${entryPrice} to ${currentPrice}`);
                await closePosition("PROFIT_TARGET", profitUSDT, profitPercent);
                return;
            }
            
            // STOP LOSS: 50% dari usdtPerTrade
            const stopLossUSDT = -db.usdtPerTrade * (db.stopLossPercent / 100);
            if (profitUSDT <= stopLossUSDT) {
                console.log(`\n🚨 STOP LOSS HIT! Closing immediately...`);
                console.log(`   Loss: ${profitUSDT.toFixed(4)} USDT (Stop Loss: ${stopLossUSDT} USDT)`);
                console.log(`   Price moved from ${entryPrice} to ${currentPrice}`);
                console.log(`   Loss Percentage: ${(profitUSDT / db.usdtPerTrade * 100).toFixed(2)}%`);
                await closePosition("STOP_LOSS", profitUSDT, profitPercent);
                return;
            }
            
            // Display P&L status every 3 seconds
            const now = Date.now();
            if (now - lastPnlLog > 3000) {
                const timeInTrade = Math.floor((now - db.activePosition.entryTime) / 1000);
                const status = profitUSDT >= 0 ? "🟢" : "🔴";
                
                // Calculate distance to stop loss
                const distanceToStopLoss = stopLossUSDT - profitUSDT;
                
                console.log(`\n📊 REAL-TIME POSITION:`);
                console.log(`   ${status} P&L: ${profitUSDT.toFixed(4)} USDT (${profitPercent.toFixed(2)}%)`);
                console.log(`   Entry: ${entryPrice} | Current: ${currentPrice}`);
                console.log(`   Time: ${timeInTrade}s | Target: +${targetProfitUSDT} USDT`);
                console.log(`   Stop Loss: ${stopLossUSDT.toFixed(4)} USDT (${db.stopLossPercent}% of trade amount)`);
                console.log(`   Distance to Stop Loss: ${distanceToStopLoss.toFixed(4)} USDT`);
                
                lastPnlLog = now;
            }
            
        } catch (error) {
            console.error("❌ P&L monitoring error:", error.message);
        }
    }, db.monitoringInterval);
};

// -------------------- SIGNAL DETECTION --------------------
const analyzeSignal = async () => {
    try {
        signalCount++;
        const now = Date.now();
        
        // Log only every 5 seconds to reduce spam
        if (now - lastLogTime > 5000) {
            console.log(`\n📊 [SIGNAL #${signalCount}] Analyzing market...`);
            lastLogTime = now;
        }
        
        // Use 1m timeframe for fast scalping
        const ohlcv = await exchange.fetchOHLCV(db.pair, "1m", undefined, 50);
        
        if (ohlcv.length < 20) {
            console.log(`⚠️ Not enough OHLCV data: ${ohlcv.length} candles`);
            return {};
        }

        const close = ohlcv.map(c => c[4]);
        const currentPrice = close[close.length - 1];
        
        // EMA 5 & 10 for fast signals
        const ema5 = EMA.calculate({ values: close, period: 5 });
        const ema10 = EMA.calculate({ values: close, period: 10 });

        if (ema5.length < 2 || ema10.length < 2) {
            console.log(`⚠️ Not enough EMA data for comparison`);
            return {};
        }

        const currentEma5 = ema5[ema5.length - 1];
        const currentEma10 = ema10[ema10.length - 1];
        const prevEma5 = ema5[ema5.length - 2];
        const prevEma10 = ema10[ema10.length - 2];

        // RSI 7 for confirmation
        const rsi = RSI.calculate({ values: close, period: 7 });
        const currentRSI = rsi.length > 0 ? rsi[rsi.length - 1] : 50;

        // Signal detection
        const bullishCross = currentEma5 > currentEma10 && prevEma5 <= prevEma10;
        const bearishCross = currentEma5 < currentEma10 && prevEma5 >= prevEma10;

        // Display indicator values
        console.log("\n" + "=".repeat(50));
        console.log("📈 INDICATOR VALUES:");
        console.log(`   Current Price: ${currentPrice}`);
        console.log(`   EMA 5: ${currentEma5.toFixed(6)} (prev: ${prevEma5.toFixed(6)})`);
        console.log(`   EMA 10: ${currentEma10.toFixed(6)} (prev: ${prevEma10.toFixed(6)})`);
        console.log(`   RSI 7: ${currentRSI.toFixed(2)}`);
        console.log("");
        console.log("🎯 SIGNAL CONDITIONS:");
        console.log(`   EMA Crossover: ${bullishCross ? "BULLISH ↗️" : bearishCross ? "BEARISH ↘️" : "NO CROSS"}`);
        
        // Signal conditions
        const canLong = bullishCross && currentRSI > 40 && currentRSI < 75;
        const canShort = bearishCross && currentRSI < 60 && currentRSI > 25;
        
        console.log("");
        console.log("🚦 FINAL SIGNAL:");
        console.log(`   LONG Signal: ${canLong ? "✅ READY" : "❌ NOT READY"}`);
        console.log(`   SHORT Signal: ${canShort ? "✅ READY" : "❌ NOT READY"}`);
        console.log("=".repeat(50));

        return {
            canLong,
            canShort,
            price: currentPrice,
            rsi: currentRSI,
            ema5: currentEma5,
            ema10: currentEma10,
            hasSignal: bullishCross || bearishCross
        };
    } catch (error) {
        console.error("❌ Signal analysis failed:", error.message);
        return {};
    }
};

// -------------------- ORDER MANAGEMENT --------------------
const placeOrder = async (side, signalPrice) => {
    try {
        // Check if active position exists
        if (db.activePosition) {
            console.log("⚠️ Active position exists, skipping");
            return;
        }

        console.log(`\n🔄 [ORDER] Attempting to place ${side.toUpperCase()} order...`);
        
        // 1. Set margin mode to ISOLATED
        await setMarginMode();
        
        // 2. Set leverage
        await exchange.setLeverage(db.leverage, db.pair);
        
        // 3. Get current price for calculation
        const ticker = await exchange.fetchTicker(db.pair);
        const entryPrice = ticker.last;
        
        // Calculate quantity
        const qty = (db.usdtPerTrade * db.leverage) / entryPrice;
        const market = exchange.markets[db.pair];
        const precision = market?.precision?.amount || 3;
        const adjustedQty = parseFloat(qty.toFixed(precision));

        // Calculate target price based on profit USDT
        const targetProfitUSDT = db.targetProfitUSDT;
        let targetPrice;
        if (side === "buy") {
            targetPrice = entryPrice + (targetProfitUSDT / adjustedQty);
        } else {
            targetPrice = entryPrice - (targetProfitUSDT / adjustedQty);
        }
        
        // Round target price according to market precision
        const pricePrecision = market?.precision?.price || 8;
        targetPrice = parseFloat(targetPrice.toFixed(pricePrecision));

        // Calculate stop loss price
        const stopLossUSDT = -db.usdtPerTrade * (db.stopLossPercent / 100);
        let stopLossPrice;
        if (side === "buy") {
            stopLossPrice = entryPrice + (stopLossUSDT / adjustedQty);
        } else {
            stopLossPrice = entryPrice - (stopLossUSDT / adjustedQty);
        }
        stopLossPrice = parseFloat(stopLossPrice.toFixed(pricePrecision));

        console.log(`   📊 Order Details:`);
        console.log(`   - Amount: ${db.usdtPerTrade} USDT × ${db.leverage}x = ${(db.usdtPerTrade * db.leverage).toFixed(2)} USDT`);
        console.log(`   - Quantity: ${adjustedQty} ${db.pair.split('/')[0]}`);
        console.log(`   - Entry Price: ${entryPrice}`);
        console.log(`   - Target Profit: ${targetProfitUSDT} USDT`);
        console.log(`   - Target Price: ${targetPrice}`);
        console.log(`   - Stop Loss: ${stopLossUSDT} USDT (${db.stopLossPercent}%)`);
        console.log(`   - Stop Loss Price: ${stopLossPrice}`);

        // 4. Place order with isolated margin params
        const order = await exchange.createOrder(db.pair, "market", side, adjustedQty, undefined, {
            marginMode: "isolated"
        });
        
        // Save active position
        db.activePosition = {
            side: side,
            entryPrice: entryPrice,
            targetPrice: targetPrice,
            stopLossPrice: stopLossPrice,
            stopLossUSDT: stopLossUSDT,
            orderId: order.id,
            quantity: adjustedQty,
            entryTime: Date.now(),
            marginMode: "isolated",
            targetProfitUSDT: targetProfitUSDT
        };

        saveDB();
        logTrade(side, entryPrice, null, "OPEN");

        console.log(`\n✅ ORDER PLACED:`);
        console.log(`   Type: ${side.toUpperCase()}`);
        console.log(`   Entry: ${entryPrice}`);
        console.log(`   Target: ${targetPrice} (+${targetProfitUSDT} USDT)`);
        console.log(`   Stop Loss: ${stopLossPrice} (${stopLossUSDT} USDT)`);
        console.log(`   Order ID: ${order.id}`);
        console.log(`   Margin Mode: ISOLATED`);
        console.log(`   Time: ${new Date().toLocaleTimeString()}`);

    } catch (error) {
        console.error("❌ Order failed:", error.message);
    }
};

// -------------------- CLOSE POSITION --------------------
const closePosition = async (reason, profitUSDT, profitPercent) => {
    try {
        const { side, quantity, entryPrice } = db.activePosition;
        const closeSide = side === "buy" ? "sell" : "buy";
        
        console.log(`\n🔄 Closing position: ${side.toUpperCase()} -> ${closeSide.toUpperCase()}`);
        
        await exchange.createOrder(db.pair, "market", closeSide, quantity, undefined, {
            reduceOnly: true,
            marginMode: "isolated"
        });

        // Update daily PnL
        db.dailyPnL += profitUSDT;
        db.dailyTrades++;
        
        // Get exit price
        const exitPrice = await getPrice();
        
        // Log trade
        logTrade(side === "buy" ? "LONG" : "SHORT", entryPrice, exitPrice, "CLOSE", profitUSDT);
        
        console.log(`\n✅ POSITION CLOSED:`);
        console.log(`   Reason: ${reason}`);
        console.log(`   Side: ${side.toUpperCase()}`);
        console.log(`   Entry Price: ${entryPrice}`);
        console.log(`   Exit Price: ${exitPrice}`);
        console.log(`   P&L: ${profitUSDT.toFixed(4)} USDT (${profitPercent.toFixed(2)}%)`);
        console.log(`   Daily P&L: ${db.dailyPnL.toFixed(2)} USDT`);
        console.log(`   Daily Trades: ${db.dailyTrades}`);
        console.log(`   Time: ${new Date().toLocaleTimeString()}`);

        // Reset active position
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
        const line = `${timestamp},${db.pair},${side},${entry},${exit || ""},${status},${pnl.toFixed(4)},${db.leverage},ISOLATED,${db.stopLossPercent}\n`;
        
        if (!fs.existsSync(logPath)) {
            fs.writeFileSync(logPath, "timestamp,pair,side,entry,exit,status,pnl,leverage,margin_mode,stop_loss_percent\n");
        }
        
        fs.appendFileSync(logPath, line);
    } catch (error) {
        console.error("❌ Failed to log trade:", error.message);
    }
};

// -------------------- MAIN LOOP --------------------
(async () => {
    try {
        // Initialize exchange
        await initializeExchange();
        await setMarginMode();
        
        // Start real-time P&L monitoring
        startPnLMonitoring();
        
        // Get account balance
        const balance = await exchange.fetchBalance();
        const totalUSDT = balance.total?.USDT || 0;
        
        console.log("\n" + "=".repeat(70));
        console.log("🚀 REAL-TIME SCALPING BOT STARTED");
        console.log("=".repeat(70));
        console.log(`💰 Balance: ${totalUSDT.toFixed(2)} USDT`);
        console.log(`📊 Pair: ${db.pair}`);
        console.log(`🎯 Target Profit: ${db.targetProfitUSDT} USDT per trade`);
        console.log(`⚡ Leverage: ${db.leverage}x`);
        console.log(`🛡️ Margin Mode: ISOLATED`);
        console.log(`🛑 Stop Loss: ${db.stopLossPercent}% of trade amount (${(db.usdtPerTrade * db.stopLossPercent / 100).toFixed(2)} USDT)`);
        console.log(`📈 P&L Monitoring: ${db.monitoringInterval}ms interval`);
        console.log(`🔄 Signal Analysis: 2000ms interval`);
        console.log(`📊 Data Points: 50 candles (1m timeframe)`);
        console.log("=".repeat(70) + "\n");

        console.log("🔄 Initializing... Waiting for data...");
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Main loop for signal analysis (every 2 seconds)
        setInterval(async () => {
            if (isProcessing) {
                console.log("⏳ Still processing previous request...");
                return;
            }
            isProcessing = true;

            try {
                // Skip if there's an active position (P&L monitoring handles closing)
                if (db.activePosition) {
                    const timeInTrade = Math.floor((Date.now() - db.activePosition.entryTime) / 1000);
                    console.log(`⏳ Position active for ${timeInTrade}s, skipping new signals...`);
                    isProcessing = false;
                    return;
                }

                // Check daily loss limit
                const maxDailyLoss = totalUSDT * db.maxDailyLossPercent / 100;
                if (db.dailyPnL < -maxDailyLoss) {
                    console.log(`\n⛔ DAILY LOSS LIMIT REACHED!`);
                    console.log(`   Daily P&L: ${db.dailyPnL.toFixed(2)} USDT`);
                    console.log(`   Max Allowed: -${maxDailyLoss.toFixed(2)} USDT`);
                    console.log(`   Trading paused for today`);
                    isProcessing = false;
                    return;
                }

                // Check cooling period after last trade
                if (db.dailyTrades > 0) {
                    const lastTradeTime = fs.existsSync(logPath) ? 
                        fs.statSync(logPath).mtimeMs : 0;
                    const timeSinceLastTrade = Date.now() - lastTradeTime;
                    
                    if (timeSinceLastTrade < db.coolingPeriod) {
                        const remaining = Math.floor((db.coolingPeriod - timeSinceLastTrade) / 1000);
                        console.log(`⏳ Cooling period: ${remaining}s remaining`);
                        isProcessing = false;
                        return;
                    }
                }

                // Analyze signal
                const signal = await analyzeSignal();
                
                if (!signal.price) {
                    isProcessing = false;
                    return;
                }

                // Entry logic
                if (signal.canLong) {
                    console.log(`\n🎯 LONG SIGNAL CONFIRMED!`);
                    console.log(`   Price: ${signal.price}`);
                    console.log(`   RSI: ${signal.rsi.toFixed(2)}`);
                    console.log(`   EMA5 > EMA10: ${signal.ema5.toFixed(6)} > ${signal.ema10.toFixed(6)}`);
                    await placeOrder("buy", signal.price);
                } 
                else if (signal.canShort) {
                    console.log(`\n🎯 SHORT SIGNAL CONFIRMED!`);
                    console.log(`   Price: ${signal.price}`);
                    console.log(`   RSI: ${signal.rsi.toFixed(2)}`);
                    console.log(`   EMA5 < EMA10: ${signal.ema5.toFixed(6)} < ${signal.ema10.toFixed(6)}`);
                    await placeOrder("sell", signal.price);
                }

            } catch (error) {
                console.error(`\n⚠️ Loop error:`, error.message);
            } finally {
                isProcessing = false;
            }
        }, 2000); // Signal analysis every 2 seconds

    } catch (error) {
        console.error("❌ Bot startup failed:", error.message);
        process.exit(1);
    }
})();