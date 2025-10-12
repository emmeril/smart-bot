// signal.js (Optimized Version)
require("dotenv").config();
const fs = require("fs");
const ccxt = require("ccxt");
const { SMA } = require("technicalindicators");

// -------------------- ENHANCED CONFIG --------------------
const CONFIG = {
    dbPath: "./db.json",
    logPath: "./log.csv",
    checkInterval: 30000,
    minOHLCVLength: 200,
    minChangeThreshold: 0.2,
    maxProfitPercent: 2.0,
    safetyMargin: 0.001,
    minPositionAmount: 0.000001
};

let isProcessing = false;
let exchangeInstance = null;

// -------------------- OPTIMIZED FILE INIT --------------------
const initializeFiles = () => {
    if (!fs.existsSync(CONFIG.logPath)) {
        fs.writeFileSync(CONFIG.logPath, "timestamp,pair,type,entry,tp,sl,status,pnl\n");
        console.log("📝 Log: File log.csv initialized");
    }
};

const loadDatabase = () => {
    if (fs.existsSync(CONFIG.dbPath)) {
        return JSON.parse(fs.readFileSync(CONFIG.dbPath));
    }
    
    const defaultDB = {
        pair: "XRP/USDT:USDT",
        lastLongEntryTime: 0,
        lastShortEntryTime: 0,
        leverage: 10,
        marginMode: "ISOLATED",
        activePosition: null,
        usdtPerTrade: 5.1,
        settings: {
            enableDynamicTPSL: true,
            enablePositionRecovery: true,
            enableBreakoutProtection: true
        }
    };
    
    fs.writeFileSync(CONFIG.dbPath, JSON.stringify(defaultDB, null, 2));
    return defaultDB;
};

let db = loadDatabase();

// -------------------- OPTIMIZED EXCHANGE INIT --------------------
const initializeExchange = async () => {
    if (exchangeInstance) return exchangeInstance;

    exchangeInstance = new ccxt.binance({
        apiKey: process.env.API_KEY,
        secret: process.env.API_SECRET,
        options: { 
            defaultType: "future",
            adjustForTimeDifference: true
        },
    });

    try {
        await exchangeInstance.loadMarkets();
        console.log("✅ Exchange: Markets loaded successfully");
        return exchangeInstance;
    } catch (err) {
        console.error("❌ Exchange: Failed to load markets", err.message);
        throw err;
    }
};

// -------------------- ENHANCED UTILITY FUNCTIONS --------------------
const saveDatabase = () => {
    try {
        if (db.activePosition) {
            // Clean up position data before saving
            const { entryPrice, tp, sl } = db.activePosition;
            db.activePosition.entryPrice = formatPrice(entryPrice);
            db.activePosition.tp = formatPrice(tp);
            db.activePosition.sl = formatPrice(sl);
        }
        fs.writeFileSync(CONFIG.dbPath, JSON.stringify(db, null, 2));
    } catch (error) {
        console.error("❌ Database: Failed to save", error.message);
    }
};

const formatPrice = (price, pair = db.pair) => {
    if (!price || !isFinite(price)) return "N/A";
    
    try {
        const market = exchangeInstance.markets[pair];
        let decimals = 5; // Default fallback
        
        if (market?.precision?.price !== undefined) {
            decimals = market.precision.price;
        } else {
            // Smart decimal detection based on price range
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
        
        decimals = Math.max(0, Math.min(8, decimals));
        return parseFloat(price.toFixed(decimals));
        
    } catch (err) {
        console.warn(`⚠️ Format: Error formatting price, using fallback:`, err.message);
        return parseFloat(price.toFixed(5));
    }
};

const getCurrentPrice = async (pair = db.pair) => {
    try {
        const ticker = await exchangeInstance.fetchTicker(pair);
        const price = ticker.last;
        console.log(`💰 Price: ${pair} = ${formatPrice(price)}`);
        return price;
    } catch (err) {
        console.error("❌ Price: Failed to fetch price", err.message);
        return null;
    }
};

const calculateQuantity = (price, pair = db.pair) => {
    if (!price) return 0;
    
    try {
        const market = exchangeInstance.markets[pair];
        const precision = market?.precision?.amount ?? 3;
        let quantity = db.usdtPerTrade / price;
        quantity = parseFloat(quantity.toFixed(precision));
        
        console.log(`📐 Quantity: ${quantity} (${db.usdtPerTrade} USDT)`);
        return quantity;
    } catch (err) {
        console.error("❌ Quantity: Calculation failed", err.message);
        return 0;
    }
};

const logSignal = (type, entry, tp, sl, status, pnl = null) => {
    try {
        const timestamp = new Date().toISOString();
        const entryStr = entry ?? "";
        const tpStr = tp ?? "";
        const slStr = sl ?? "";
        const pnlStr = pnl !== null && isFinite(pnl) ? Number(pnl).toFixed(6) : "";
        
        const line = `${timestamp},${db.pair},${type},${entryStr},${tpStr},${slStr},${status},${pnlStr}\n`;
        fs.appendFileSync(CONFIG.logPath, line);
        console.log("📝 Log: Signal recorded");
    } catch (err) {
        console.error("❌ Log: Failed to write log", err.message);
    }
};

// -------------------- ENHANCED POSITION MANAGEMENT --------------------
const getPositionInfo = async () => {
    try {
        const balance = await exchangeInstance.fetchBalance();
        const positions = balance.info?.positions || [];
        
        // Normalize symbol for comparison
        const normalizeSymbol = (symbol) => 
            (symbol || "").toString().replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
        
        const targetSymbol = normalizeSymbol(db.pair.replace("/", "").replace(":", ""));
        
        const position = positions.find(p => 
            normalizeSymbol(p.symbol) === targetSymbol || 
            normalizeSymbol(p.contractCode) === targetSymbol
        );

        return { 
            balance, 
            position,
            amount: parseFloat(position?.positionAmt || "0")
        };
    } catch (err) {
        console.error("❌ Position: Failed to fetch position info", err.message);
        return { balance: null, position: null, amount: 0 };
    }
};

const placeOrder = async (side, tp, sl) => {
    console.log(`🎯 Order: Attempting ${side.toUpperCase()} entry...`);
    
    // Enhanced pre-check
    if (db.activePosition) {
        console.log("⚠️ Order: Active position exists in DB, skipping");
        return;
    }

    try {
        const { amount } = await getPositionInfo();
        if (Math.abs(amount) > CONFIG.minPositionAmount) {
            console.log("⚠️ Order: Active position detected in exchange, skipping");
            return;
        }
    } catch (err) {
        console.warn("⚠️ Order: Failed to verify position before entry", err.message);
    }

    const price = await getCurrentPrice();
    if (!price) {
        console.log("❌ Order: No valid price, aborting");
        return;
    }

    const quantity = calculateQuantity(price);
    if (quantity <= 0) {
        console.log("❌ Order: Invalid quantity, aborting");
        return;
    }

    console.log(`➡️ Order: ENTRY ${side.toUpperCase()}
- Quantity: ${quantity}
- Entry: ${formatPrice(price)}
- TP: ${formatPrice(tp)}
- SL: ${formatPrice(sl)}`);

    try {
        // Configure exchange settings
        await Promise.all([
            exchangeInstance.setLeverage(db.leverage, db.pair),
            exchangeInstance.setMarginMode(db.marginMode, db.pair)
        ]);
        console.log("✅ Order: Exchange configured");
    } catch (err) {
        console.warn("⚠️ Order: Failed to configure exchange", err.message);
    }

    try {
        const order = await exchangeInstance.createOrder(db.pair, "market", side, quantity);
        console.log("✅ Order: Entry order placed successfully");

        db.activePosition = {
            side: side,
            entryPrice: price,
            tp: tp,
            sl: sl,
            orderId: order.id,
            openedAt: new Date().toISOString()
        };
        saveDatabase();

        logSignal(
            side === "buy" ? "LONG" : "SHORT",
            price,
            tp,
            sl,
            "ENTRY_ORDER_PLACED"
        );
        
        return order;
    } catch (err) {
        console.error("❌ Order: Failed to place order", err.message);
        return null;
    }
};

const closePosition = async (reason, entryPrice = "N/A") => {
    console.log(`🚨 Position: Closing position - ${reason}`);
    
    try {
        const { amount } = await getPositionInfo();
        
        if (!isFinite(amount) || Math.abs(amount) <= CONFIG.minPositionAmount) {
            console.log("ℹ️ Position: No active position to close");
            db.activePosition = null;
            saveDatabase();
            return;
        }

        const side = amount > 0 ? "sell" : "buy";
        const closeQuantity = Math.abs(amount);
        
        await exchangeInstance.createOrder(db.pair, "market", side, closeQuantity, undefined, {
            reduceOnly: true,
        });
        
        console.log(`✅ Position: Close order placed (${side}, ${closeQuantity})`);

        // Calculate PnL if possible
        let pnl = null;
        const exitPrice = await getCurrentPrice();
        let status = "CLOSED_MANUAL";

        if (reason.includes("TP")) status = "TP_REALIZED";
        else if (reason.includes("SL")) status = "SL_REALIZED";

        if (entryPrice !== "N/A" && db.activePosition && isFinite(exitPrice)) {
            try {
                const { side: entrySide } = db.activePosition;
                const entryNum = Number(entryPrice);
                const exitNum = Number(exitPrice);

                pnl = entrySide === "buy" ? 
                    (exitNum - entryNum) * closeQuantity : 
                    (entryNum - exitNum) * closeQuantity;
                    
            } catch (err) {
                console.warn("⚠️ PnL: Calculation failed", err.message);
            }
        }

        logSignal(
            amount > 0 ? "LONG" : "SHORT",
            entryPrice,
            db.activePosition?.tp ?? "",
            db.activePosition?.sl ?? "",
            status,
            pnl
        );

    } catch (err) {
        console.error("❌ Position: Failed to close position", err.message);
    } finally {
        db.activePosition = null;
        saveDatabase();
    }
};

// -------------------- ENHANCED TECHNICAL ANALYSIS --------------------
const analyzeSignal = async () => {
    console.log("🧠 Analysis: Running technical analysis...");
    
    try {
        const ohlcv = await exchangeInstance.fetchOHLCV(db.pair, "15m", undefined, CONFIG.minOHLCVLength);
        if (!ohlcv || ohlcv.length < CONFIG.minOHLCVLength) {
            console.warn("⚠️ Analysis: Insufficient OHLCV data");
            return {};
        }

        const closes = ohlcv.map(c => c[4]);
        const highs = ohlcv.map(c => c[2]);
        const lows = ohlcv.map(c => c[3]);

        const currentPrice = closes[closes.length - 1];

        // Moving Average Analysis
        const ma7 = SMA.calculate({ values: closes.slice(-100), period: 7 }).pop();
        const ma25 = SMA.calculate({ values: closes.slice(-100), period: 25 }).pop();
        const ma99 = SMA.calculate({ values: closes, period: 99 }).pop();

        const prevMA7 = SMA.calculate({ values: closes.slice(-101, -1), period: 7 }).pop();
        const prevMA25 = SMA.calculate({ values: closes.slice(-101, -1), period: 25 }).pop();

        const isCrossedUp = ma7 > ma25 && prevMA7 <= prevMA25;
        const isCrossedDown = ma7 < ma25 && prevMA7 >= prevMA25;

        // Enhanced Signal Logic
        const canLong = isCrossedUp && ma7 > ma99 && ma25 > ma99;
        const canShort = isCrossedDown && ma7 < ma99 && ma25 < ma99;

        // Advanced Support/Resistance
        const { resistance, support } = findAdvancedSwingLevels(highs, lows);
        const atr = calculateATR(highs, lows, closes);
        
        const minDistance = (atr * 0.5) || (currentPrice * 0.005);
        
        const nearestResistance = resistance
            .filter(level => level.price > currentPrice + minDistance)
            .sort((a, b) => a.price - b.price)[0]?.price || Math.max(...highs.slice(-96));
            
        const nearestSupport = support
            .filter(level => level.price < currentPrice - minDistance)
            .sort((a, b) => b.price - a.price)[0]?.price || Math.min(...lows.slice(-96));

        const result = {
            canLong,
            canShort,
            targetLong: nearestResistance,
            stopLossLong: nearestSupport,
            targetShort: nearestSupport,
            stopLossShort: nearestResistance,
            price: currentPrice,
            indicators: {
                ma7: formatPrice(ma7),
                ma25: formatPrice(ma25),
                ma99: formatPrice(ma99),
                atr: formatPrice(atr)
            }
        };

        logAnalysisResult(result, resistance, support);
        return result;

    } catch (err) {
        console.error("❌ Analysis: Technical analysis failed", err.message);
        return {};
    }
};

// Helper function for logging analysis results
const logAnalysisResult = (signal, resistanceLevels, supportLevels) => {
    console.log(`\n📊 Analysis Results ${db.pair}
-----------------------------------
📈 Long Signal: ${signal.canLong ? "✅ VALID" : "❌ INVALID"}
📉 Short Signal: ${signal.canShort ? "✅ VALID" : "❌ INVALID"}
-----------------------------------
💰 Current Price: ${formatPrice(signal.price)}
📊 MA7: ${signal.indicators.ma7} | MA25: ${signal.indicators.ma25} | MA99: ${signal.indicators.ma99}
📏 ATR: ${signal.indicators.atr}
-----------------------------------
🎯 Resistance Levels: ${resistanceLevels.slice(0, 3).map(l => formatPrice(l.price)).join(', ')}
🛡️ Support Levels: ${supportLevels.slice(0, 3).map(l => formatPrice(l.price)).join(', ')}
-----------------------------------
📈 Long Strategy:
- TP: ${formatPrice(signal.targetLong)} | SL: ${formatPrice(signal.stopLossLong)}
- R/R: ${((signal.targetLong - signal.price) / (signal.price - signal.stopLossLong)).toFixed(2)}
-----------------------------------
📉 Short Strategy:
- TP: ${formatPrice(signal.targetShort)} | SL: ${formatPrice(signal.stopLossShort)}  
- R/R: ${((signal.price - signal.targetShort) / (signal.stopLossShort - signal.price)).toFixed(2)}
-----------------------------------`);
};

// -------------------- ENHANCED POSITION MONITORING --------------------
const monitorPosition = async () => {
    try {
        const { amount } = await getPositionInfo();
        
        if (db.activePosition && Math.abs(amount) > CONFIG.minPositionAmount) {
            const { tp, sl, side, entryPrice } = db.activePosition;
            const currentPrice = await getCurrentPrice();
            
            if (!currentPrice) return;

            const shouldClose = 
                (side === "buy" && (currentPrice >= tp || currentPrice <= sl)) ||
                (side === "sell" && (currentPrice <= tp || currentPrice >= sl));

            if (shouldClose) {
                const reason = side === "buy" ? 
                    (currentPrice >= tp ? "TP reached" : "SL reached") :
                    (currentPrice <= tp ? "TP reached" : "SL reached");
                    
                await closePosition(reason, entryPrice);
            }
        }
    } catch (err) {
        console.error("❌ Monitor: Position monitoring failed", err.message);
    }
};

// -------------------- ENHANCED TP/SL UPDATE --------------------
const updateDynamicTPSL = async (signal) => {
    if (!db.activePosition || !db.settings.enableDynamicTPSL) return;

    try {
        const { side, entryPrice, tp: currentTP, sl: currentSL } = db.activePosition;
        let newTP, newSL;

        if (side === "buy") {
            newTP = signal.targetLong;
            newSL = signal.stopLossLong;
            
            // Profit protection
            const profitToCurrentTP = ((currentTP - entryPrice) / entryPrice) * 100;
            if (profitToCurrentTP >= 80 && newTP > currentTP) {
                console.log("🎯 TP/SL: Profit protection active, keeping current TP");
                newTP = currentTP;
            }
            
            // Safety checks
            if (newTP <= entryPrice || newSL >= entryPrice) return;
            if (newSL > currentSL) newSL = currentSL;
            
        } else if (side === "sell") {
            newTP = signal.targetShort;
            newSL = signal.stopLossShort;
            
            // Profit protection
            const profitToCurrentTP = ((entryPrice - currentTP) / entryPrice) * 100;
            if (profitToCurrentTP >= 80 && newTP < currentTP) {
                console.log("🎯 TP/SL: Profit protection active, keeping current TP");
                newTP = currentTP;
            }
            
            // Safety checks
            if (newTP >= entryPrice || newSL <= entryPrice) return;
            if (newSL < currentSL) newSL = currentSL;
        } else {
            return;
        }

        // Check for significant changes
        const tpChange = Math.abs((newTP - currentTP) / currentTP * 100);
        const slChange = Math.abs((newSL - currentSL) / currentSL * 100);
        
        if (tpChange < CONFIG.minChangeThreshold && slChange < CONFIG.minChangeThreshold) {
            console.log("ℹ️ TP/SL: Changes not significant, skipping update");
            return;
        }

        // Update position
        db.activePosition.tp = newTP;
        db.activePosition.sl = newSL;
        saveDatabase();

        console.log(`✅ TP/SL: Updated for ${side.toUpperCase()}`);
        console.log(`   TP: ${formatPrice(currentTP)} → ${formatPrice(newTP)} (${tpChange.toFixed(2)}%)`);
        console.log(`   SL: ${formatPrice(currentSL)} → ${formatPrice(newSL)} (${slChange.toFixed(2)}%)`);

        logSignal(
            side === "buy" ? "LONG" : "SHORT",
            entryPrice,
            newTP,
            newSL,
            "TP_SL_UPDATED"
        );

    } catch (error) {
        console.error("❌ TP/SL: Update failed", error.message);
    }
};

// -------------------- ENHANCED POSITION RECOVERY --------------------
const recoverPositionState = async () => {
    if (!db.settings.enablePositionRecovery) return;

    try {
        const { amount, position } = await getPositionInfo();
        
        // Scenario 1: Position in exchange but not in DB
        if (Math.abs(amount) > CONFIG.minPositionAmount && !db.activePosition) {
            console.log("🔄 Recovery: Recovering position state...");
            
            const currentPrice = await getCurrentPrice();
            const side = amount > 0 ? "buy" : "sell";
            const entryPrice = parseFloat(position?.entryPrice || currentPrice);
            
            const signal = await analyzeSignal();
            let tp, sl;

            if (side === "buy") {
                tp = signal.targetLong || (entryPrice * 1.015);
                sl = signal.stopLossLong || (entryPrice * 0.995);
            } else {
                tp = signal.targetShort || (entryPrice * 0.985);
                sl = signal.stopLossShort || (entryPrice * 1.005);
            }

            // Apply safety margins
            if (side === "buy") {
                tp *= (1 - CONFIG.safetyMargin);
                sl *= (1 + CONFIG.safetyMargin);
            } else {
                tp *= (1 + CONFIG.safetyMargin);
                sl *= (1 - CONFIG.safetyMargin);
            }

            db.activePosition = {
                side: side,
                entryPrice: entryPrice,
                tp: tp,
                sl: sl,
                orderId: "RECOVERED_" + Date.now(),
                recovered: true,
                recoveredAt: new Date().toISOString()
            };
            
            saveDatabase();
            console.log("✅ Recovery: Position recovered successfully");
        }

        // Scenario 2: Position in DB but not in exchange
        if (db.activePosition && Math.abs(amount) <= CONFIG.minPositionAmount) {
            console.log("🔄 Recovery: Cleaning up orphaned position...");
            db.activePosition = null;
            saveDatabase();
        }

    } catch (err) {
        console.error("❌ Recovery: Position recovery failed", err.message);
    }
};

// -------------------- OPTIMIZED MAIN LOOP --------------------
const mainTradingLoop = async () => {
    if (isProcessing) {
        console.log("⏳ Skip: Previous process still running");
        return;
    }
    
    isProcessing = true;
    
    try {
        // Reload configuration
        try {
            const freshConfig = JSON.parse(fs.readFileSync(CONFIG.dbPath));
            Object.assign(db, freshConfig);
        } catch (error) {
            // Continue with current config
        }

        console.log("🔍 Main: Starting trading cycle...");
        
        // Initialize exchange if needed
        if (!exchangeInstance) {
            await initializeExchange();
        }

        // Recovery and monitoring
        await recoverPositionState();
        await monitorPosition();

        // Signal analysis
        const signal = await analyzeSignal();
        if (!signal.price) {
            console.log("⚠️ Main: No valid signal, waiting...");
            return;
        }

        // Update TP/SL for open positions
        if (db.activePosition) {
            await updateDynamicTPSL(signal);
        }

        // Check for reverse signals
        if (db.activePosition) {
            const currentSide = db.activePosition.side;
            const shouldReverse = 
                (currentSide === "buy" && signal.canShort) ||
                (currentSide === "sell" && signal.canLong);

            if (shouldReverse) {
                console.log("🔄 Main: Reverse signal detected, closing position");
                await closePosition("Reverse signal", db.activePosition.entryPrice);
                await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for close
            }
        }

        // Enter new positions if no active position
        if (!db.activePosition) {
            const { amount } = await getPositionInfo();
            const hasExchangePosition = Math.abs(amount) > CONFIG.minPositionAmount;

            if (!hasExchangePosition) {
                if (signal.canLong) {
                    const isBreakout = signal.price > signal.targetLong;
                    if (!isBreakout || !db.settings.enableBreakoutProtection) {
                        console.log(`🚀 Main: Entering LONG position`);
                        await placeOrder("buy", signal.targetLong, signal.stopLossLong);
                    } else {
                        console.log("⏸️ Main: Breakout detected, skipping LONG");
                    }
                } else if (signal.canShort) {
                    const isBreakout = signal.price < signal.targetShort;
                    if (!isBreakout || !db.settings.enableBreakoutProtection) {
                        console.log(`📉 Main: Entering SHORT position`);
                        await placeOrder("sell", signal.targetShort, signal.stopLossShort);
                    } else {
                        console.log("⏸️ Main: Breakout detected, skipping SHORT");
                    }
                } else {
                    console.log("💤 Main: No valid entry signals");
                }
            }
        }

    } catch (err) {
        console.error("❌ Main: Trading cycle error", err.message);
    } finally {
        isProcessing = false;
    }
};

// -------------------- INITIALIZATION --------------------
const initializeBot = async () => {
    console.log("🤖 Trading Bot Initializing...");
    
    initializeFiles();
    await initializeExchange();
    
    console.log(`⚙️ Bot Configuration:
- Active Pair: ${db.pair}
- Leverage: ${db.leverage}x
- Margin Mode: ${db.marginMode}
- USDT per Trade: ${db.usdtPerTrade}
- Dynamic TP/SL: ${db.settings.enableDynamicTPSL ? '✅' : '❌'}
- Position Recovery: ${db.settings.enablePositionRecovery ? '✅' : '❌'}`);

    // Start main loop
    setInterval(mainTradingLoop, CONFIG.checkInterval);
    console.log(`🔄 Main loop started (${CONFIG.checkInterval / 1000}s interval)`);
    
    // Immediate first run
    setTimeout(mainTradingLoop, 2000);
};

// Start the bot
initializeBot().catch(console.error);

// Technical indicator functions (keep existing implementations)
const findAdvancedSwingLevels = (highArr, lowArr, lookback = 10, minStrength = 2) => {
    // ... (keep existing implementation)
};

const calculateATR = (highArr, lowArr, closeArr, period = 14) => {
    // ... (keep existing implementation)
};
