require("dotenv").config();
const fs = require("fs");
const path = require("path");
const ccxt = require("ccxt");
const { RSI } = require("technicalindicators");

// -------------------- CONFIG --------------------
const dbPath = "./db.json";
const logPath = "./log.csv";
let isProcessing = false;
let exchange = null;
let signalCount = 0;
let lastLogTime = Date.now();
let lastPnlLog = Date.now();
let lastConfigReload = Date.now();

// Variabel db dideklarasikan tanpa inisialisasi langsung
let db = null;

// -------------------- ENSURE FILE EXISTS --------------------
const ensureFileExists = (filePath, defaultContent = "{}") => {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, defaultContent, 'utf8');
            console.log(`✅ Created ${path.basename(filePath)} file`);
            return true;
        }
        return true;
    } catch (error) {
        console.error(`❌ Failed to create ${path.basename(filePath)}:`, error.message);
        return false;
    }
};

// -------------------- DEFAULT CONFIG --------------------
const getDefaultConfig = () => {
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
        stopLossPercent: 50,
        breakoutPeriod: 20,
        minBreakoutStrength: 0.001,
        lastUpdated: Date.now()
    };
};

// -------------------- INITIALIZE DB --------------------
const initializeDB = () => {
    try {
        ensureFileExists(dbPath, JSON.stringify(getDefaultConfig(), null, 2));
        
        if (fs.existsSync(dbPath)) {
            const data = fs.readFileSync(dbPath, 'utf8');
            
            if (!data || data.trim() === '') {
                console.log("📝 DB file is empty, creating default config...");
                const defaultConfig = getDefaultConfig();
                fs.writeFileSync(dbPath, JSON.stringify(defaultConfig, null, 2));
                db = defaultConfig;
                return true;
            }
            
            const parsedData = JSON.parse(data);
            
            // Validate required fields
            const defaultConfig = getDefaultConfig();
            const validatedConfig = { ...defaultConfig, ...parsedData };
            
            // Ensure all required fields exist
            Object.keys(defaultConfig).forEach(key => {
                if (!(key in validatedConfig) || validatedConfig[key] === undefined) {
                    validatedConfig[key] = defaultConfig[key];
                }
            });
            
            db = validatedConfig;
            console.log("✅ DB initialized successfully");
            return true;
        } else {
            console.log("📝 Creating new DB file...");
            const defaultConfig = getDefaultConfig();
            fs.writeFileSync(dbPath, JSON.stringify(defaultConfig, null, 2));
            db = defaultConfig;
            return true;
        }
    } catch (error) {
        console.error("❌ Error initializing DB:", error.message);
        
        // Create backup of corrupted file
        if (fs.existsSync(dbPath)) {
            try {
                const backupPath = `${dbPath}.backup.${Date.now()}`;
                fs.copyFileSync(dbPath, backupPath);
                console.log(`📦 Created backup of corrupted file: ${backupPath}`);
            } catch (backupError) {
                console.error("❌ Failed to create backup:", backupError.message);
            }
        }
        
        // Create fresh config
        const defaultConfig = getDefaultConfig();
        fs.writeFileSync(dbPath, JSON.stringify(defaultConfig, null, 2));
        db = defaultConfig;
        console.log("✅ Created fresh config with default values");
        return true;
    }
};

// -------------------- RELOAD CONFIG --------------------
const reloadConfig = () => {
    try {
        if (!db) {
            console.error("❌ Cannot reload config: db not initialized");
            return false;
        }
        
        if (!fs.existsSync(dbPath)) {
            console.error("❌ DB file not found during reload");
            return false;
        }
        
        const data = fs.readFileSync(dbPath, 'utf8');
        if (!data || data.trim() === '') {
            console.error("❌ DB file is empty");
            return false;
        }
        
        const freshConfig = JSON.parse(data);
        
        // Preserve active position if it exists
        if (db.activePosition && !freshConfig.activePosition) {
            freshConfig.activePosition = db.activePosition;
        }
        
        // Preserve daily P&L if not reset
        if (db.dailyTrades > freshConfig.dailyTrades) {
            freshConfig.dailyPnL = db.dailyPnL;
            freshConfig.dailyTrades = db.dailyTrades;
        }
        
        const oldConfig = JSON.stringify({ ...db, activePosition: null, lastUpdated: null });
        const newConfig = JSON.stringify({ ...freshConfig, activePosition: null, lastUpdated: null });
        
        // Update db object
        Object.keys(freshConfig).forEach(key => {
            db[key] = freshConfig[key];
        });
        
        // Log only if significant change detected
        if (oldConfig !== newConfig && Date.now() - lastConfigReload > 5000) {
            console.log("🔄 Configuration reloaded from file");
            lastConfigReload = Date.now();
        }
        
        return true;
    } catch (error) {
        console.error("❌ Failed to reload config:", error.message);
        return false;
    }
};

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
        if (!db) {
            console.error("❌ Cannot set margin mode: db not initialized");
            return false;
        }
        
        await exchange.setMarginMode("isolated", db.pair);
        console.log("✅ Margin mode set to: ISOLATED");
        return true;
    } catch (error) {
        if (!error.message.includes("No need to change margin mode")) {
            console.warn("⚠️ Margin mode setting warning:", error.message);
        }
        return false;
    }
};

// -------------------- REAL-TIME PNL MONITORING --------------------
const startPnLMonitoring = async () => {
    if (!db) {
        console.error("❌ Cannot start P&L monitoring: db not initialized");
        return;
    }
    
    console.log("📈 Starting real-time P&L monitoring...");
    
    setInterval(async () => {
        try {
            // Create local copy to avoid race condition
            if (!db || !db.activePosition) return;
            
            const activePosition = db.activePosition;
            const currentPrice = await getPrice();
            if (!currentPrice) return;

            const { side, entryPrice, quantity, targetProfitUSDT, entryTime } = activePosition;
            
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
                const timeInTrade = Math.floor((now - entryTime) / 1000);
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

// -------------------- BREAKOUT SIGNAL DETECTION --------------------
const analyzeSignal = async () => {
    try {
        if (!db) {
            console.error("❌ Cannot analyze signal: db not initialized");
            return {};
        }
        
        signalCount++;
        const now = Date.now();
        
        // Log only every 5 seconds to reduce spam
        if (now - lastLogTime > 5000) {
            console.log(`\n📊 [SIGNAL #${signalCount}] Analyzing market for BREAKOUT...`);
            lastLogTime = now;
        }
        
        // Use 1m timeframe for fast scalping
        const ohlcv = await exchange.fetchOHLCV(db.pair, "1m", undefined, db.breakoutPeriod + 10);
        
        if (ohlcv.length < db.breakoutPeriod) {
            console.log(`⚠️ Not enough OHLCV data: ${ohlcv.length} candles`);
            return {};
        }

        const close = ohlcv.map(c => c[4]);
        const high = ohlcv.map(c => c[2]);
        const low = ohlcv.map(c => c[3]);
        
        const currentPrice = close[close.length - 1];
        const currentHigh = high[high.length - 1];
        const currentLow = low[low.length - 1];
        
        // Calculate breakout levels
        const lookbackPeriod = db.breakoutPeriod;
        
        // Get previous period highs and lows (excluding current candle)
        const previousHighs = high.slice(-lookbackPeriod - 1, -1);
        const previousLows = low.slice(-lookbackPeriod - 1, -1);
        
        const resistance = Math.max(...previousHighs);
        const support = Math.min(...previousLows);
        
        const range = resistance - support;
        const breakoutThreshold = range * db.minBreakoutStrength;
        
        // RSI 7 for confirmation
        const rsi = RSI.calculate({ values: close, period: 7 });
        const currentRSI = rsi.length > 0 ? rsi[rsi.length - 1] : 50;
        
        // Breakout detection
        const bullishBreakout = currentHigh > resistance + breakoutThreshold;
        const bearishBreakout = currentLow < support - breakoutThreshold;
        
        // Display breakout values
        console.log("\n" + "=".repeat(50));
        console.log("📈 BREAKOUT LEVELS:");
        console.log(`   Current Price: ${currentPrice}`);
        console.log(`   Current High: ${currentHigh}`);
        console.log(`   Current Low: ${currentLow}`);
        console.log(`   Resistance: ${resistance.toFixed(6)}`);
        console.log(`   Support: ${support.toFixed(6)}`);
        console.log(`   Range: ${range.toFixed(6)}`);
        console.log(`   Breakout Threshold: ±${breakoutThreshold.toFixed(6)}`);
        console.log(`   RSI 7: ${currentRSI.toFixed(2)}`);
        console.log("");
        console.log("🎯 BREAKOUT CONDITIONS:");
        console.log(`   Bullish Breakout: ${bullishBreakout ? "✅ ABOVE RESISTANCE" : "❌ NOT BROKEN"}`);
        console.log(`   Bearish Breakout: ${bearishBreakout ? "✅ BELOW SUPPORT" : "❌ NOT BROKEN"}`);
        
        // Signal conditions with RSI filter
        const canLong = bullishBreakout && currentRSI > 40 && currentRSI < 75;
        const canShort = bearishBreakout && currentRSI < 60 && currentRSI > 25;
        
        console.log("");
        console.log("🚦 FINAL SIGNAL:");
        console.log(`   LONG Signal: ${canLong ? "✅ BREAKOUT CONFIRMED" : "❌ NOT CONFIRMED"}`);
        console.log(`   SHORT Signal: ${canShort ? "✅ BREAKOUT CONFIRMED" : "❌ NOT CONFIRMED"}`);
        console.log("=".repeat(50));

        return {
            canLong,
            canShort,
            price: currentPrice,
            rsi: currentRSI,
            resistance,
            support,
            hasSignal: bullishBreakout || bearishBreakout
        };
    } catch (error) {
        console.error("❌ Breakout analysis failed:", error.message);
        return {};
    }
};

// -------------------- ORDER MANAGEMENT --------------------
const placeOrder = async (side, signalPrice) => {
    try {
        if (!db) {
            console.error("❌ Cannot place order: db not initialized");
            return;
        }

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
        if (!db) {
            console.error("❌ Cannot close position: db not initialized");
            return;
        }

        // Check if position still exists
        if (!db.activePosition) {
            console.log("⚠️ No active position to close");
            return;
        }

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
        if (!db) {
            console.error("❌ Cannot get price: db not initialized");
            return null;
        }
        
        const ticker = await exchange.fetchTicker(db.pair);
        return ticker.last;
    } catch (error) {
        console.error("❌ Failed to get price:", error.message);
        return null;
    }
};

const saveDB = () => {
    try {
        if (!db) {
            console.error("❌ Cannot save DB: db not initialized");
            return;
        }
        
        // Ensure file exists before writing
        ensureFileExists(dbPath, JSON.stringify(getDefaultConfig(), null, 2));
        
        // Add timestamp to track updates
        db.lastUpdated = Date.now();
        
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
    } catch (error) {
        console.error("❌ Failed to save DB:", error.message);
    }
};

const logTrade = (side, entry, exit, status, pnl = 0) => {
    try {
        if (!db) {
            console.error("❌ Cannot log trade: db not initialized");
            return;
        }
        
        // Ensure log file exists
        ensureFileExists(logPath, "timestamp,pair,side,entry,exit,status,pnl,leverage,margin_mode,stop_loss_percent,strategy\n");
        
        const timestamp = new Date().toISOString();
        const line = `${timestamp},${db.pair},${side},${entry},${exit || ""},${status},${pnl.toFixed(4)},${db.leverage},ISOLATED,${db.stopLossPercent},BREAKOUT\n`;
        
        fs.appendFileSync(logPath, line);
    } catch (error) {
        console.error("❌ Failed to log trade:", error.message);
    }
};

// -------------------- MAIN LOOP --------------------
(async () => {
    try {
        // Step 1: Initialize DB first
        console.log("🔄 Initializing configuration...");
        if (!initializeDB()) {
            console.error("❌ Failed to initialize DB, exiting...");
            process.exit(1);
        }
        
        // Step 2: Initialize exchange
        console.log("🔄 Connecting to exchange...");
        await initializeExchange();
        
        // Step 3: Set margin mode
        console.log("🔄 Setting margin mode...");
        await setMarginMode();
        
        // Step 4: Start real-time P&L monitoring
        console.log("🔄 Starting monitoring...");
        await startPnLMonitoring();
        
        // Get account balance
        const balance = await exchange.fetchBalance();
        const totalUSDT = balance.total?.USDT || 0;
        
        console.log("\n" + "=".repeat(70));
        console.log("🚀 REAL-TIME BREAKOUT SCALPING BOT STARTED");
        console.log("=".repeat(70));
        console.log(`💰 Balance: ${totalUSDT.toFixed(2)} USDT`);
        console.log(`📊 Pair: ${db.pair}`);
        console.log(`🎯 Strategy: BREAKOUT (${db.breakoutPeriod} period)`);
        console.log(`🎯 Target Profit: ${db.targetProfitUSDT} USDT per trade`);
        console.log(`⚡ Leverage: ${db.leverage}x`);
        console.log(`🛡️ Margin Mode: ISOLATED`);
        console.log(`🛑 Stop Loss: ${db.stopLossPercent}% of trade amount (${(db.usdtPerTrade * db.stopLossPercent / 100).toFixed(2)} USDT)`);
        console.log(`📈 P&L Monitoring: ${db.monitoringInterval}ms interval`);
        console.log(`🔄 Signal Analysis: 2000ms interval`);
        console.log(`🔄 Auto-reload Config: Enabled (every 2 seconds)`);
        console.log(`📁 Config File: ${dbPath}`);
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
                // 🔄 RELOAD CONFIGURATION EVERY 2 SECONDS
                reloadConfig();

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

                // Analyze breakout signal
                const signal = await analyzeSignal();
                
                if (!signal.price) {
                    isProcessing = false;
                    return;
                }

                // Entry logic
                if (signal.canLong) {
                    console.log(`\n🎯 BULLISH BREAKOUT CONFIRMED!`);
                    console.log(`   Price: ${signal.price} > Resistance: ${signal.resistance}`);
                    console.log(`   RSI: ${signal.rsi.toFixed(2)}`);
                    console.log(`   Breakout Strength: ${((signal.price - signal.resistance) / signal.resistance * 100).toFixed(2)}%`);
                    await placeOrder("buy", signal.price);
                } 
                else if (signal.canShort) {
                    console.log(`\n🎯 BEARISH BREAKOUT CONFIRMED!`);
                    console.log(`   Price: ${signal.price} < Support: ${signal.support}`);
                    console.log(`   RSI: ${signal.rsi.toFixed(2)}`);
                    console.log(`   Breakout Strength: ${((signal.support - signal.price) / signal.support * 100).toFixed(2)}%`);
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
