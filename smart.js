// bot.js (Optimized Version)
require("dotenv").config();
const fs = require("fs");
const ccxt = require("ccxt");
const { SMA } = require("technicalindicators");

// -------------------- CONFIGURATION --------------------
const CONFIG = {
    dbPath: "./db.json",
    logPath: "./log.csv",
    checkInterval: 30000,
    minPositionAmount: 0.000001,
    safetyMargin: 0.001,
    maxProfitPercent: 2.0,
    minChangeThreshold: 0.2,
    maxRetryAttempts: 3,
    retryDelay: 5000
};

let isProcessing = false;
let prevPosAmt = 0;

// Initialize files
if (!fs.existsSync(CONFIG.logPath)) {
    fs.writeFileSync(CONFIG.logPath, "timestamp,pair,type,entry,tp,sl,status,pnl,reason\n");
}

const db = fs.existsSync(CONFIG.dbPath) ? 
    JSON.parse(fs.readFileSync(CONFIG.dbPath)) : {
        pair: "XRP/USDT:USDT",
        lastLongEntryTime: 0,
        lastShortEntryTime: 0,
        leverage: 10,
        marginMode: "ISOLATED",
        activePosition: null,
        usdtPerTrade: 5.1,
    };

console.log(`⚙️ Bot Configuration:
- Pair: ${db.pair}
- Leverage: ${db.leverage}x
- Margin Mode: ${db.marginMode}
- USDT per Trade: ${db.usdtPerTrade}`);

// -------------------- EXCHANGE SETUP --------------------
const exchange = new ccxt.binance({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 
        defaultType: "future",
        adjustForTimeDifference: true
    },
});

// Enhanced error handling with retry mechanism
const withRetry = async (fn, context = "operation", retries = CONFIG.maxRetryAttempts) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            console.error(`❌ ${context} attempt ${attempt} failed:`, error.message);
            if (attempt === retries) throw error;
            await new Promise(resolve => setTimeout(resolve, CONFIG.retryDelay * attempt));
        }
    }
};

(async () => {
    try {
        await withRetry(() => exchange.loadMarkets(), "Load markets");
        console.log("✅ Markets loaded successfully");
    } catch (err) {
        console.error("❌ Failed to load markets after retries:", err.message);
        process.exit(1);
    }
})();

// -------------------- UTILITY FUNCTIONS --------------------
const saveDB = () => {
    if (db.activePosition) {
        db.activePosition.entryPrice = formatPrice(db.activePosition.entryPrice);
        db.activePosition.tp = formatPrice(db.activePosition.tp);
        db.activePosition.sl = formatPrice(db.activePosition.sl);
    }
    fs.writeFileSync(CONFIG.dbPath, JSON.stringify(db, null, 2));
};

const formatPrice = (price, pair = db.pair) => {
    if (!price || !isFinite(price)) return "N/A";
    
    try {
        const market = exchange.markets[pair];
        let decimals = market?.precision?.price ?? 5;
        decimals = Math.max(0, Math.min(8, parseInt(decimals) || 5));
        return parseFloat(price.toFixed(decimals));
    } catch (err) {
        return parseFloat(price.toFixed(5));
    }
};

const getPrice = async () => {
    return await withRetry(async () => {
        const ticker = await exchange.fetchTicker(db.pair);
        const price = ticker.last;
        console.log(`💰 Price ${db.pair}: ${formatPrice(price)}`);
        return price;
    }, "Fetch price");
};

const calcQty = (price) => {
    if (!price || price <= 0) {
        console.error("❌ Invalid price for quantity calculation");
        return 0;
    }
    
    try {
        const market = exchange.markets[db.pair];
        const prec = market?.precision?.amount ?? 3;
        const minQty = market?.limits?.amount?.min ?? 0;
        
        let qty = parseFloat((db.usdtPerTrade / price).toFixed(prec));
        
        // Ensure minimum quantity requirement
        if (minQty > 0 && qty < minQty) {
            console.warn(`⚠️ Quantity ${qty} below minimum ${minQty}, adjusting`);
            qty = minQty;
        }
        
        console.log(`📐 Quantity: ${qty} (${db.usdtPerTrade} USDT)`);
        return qty;
    } catch (err) {
        console.error("❌ Quantity calculation failed:", err.message);
        return 0;
    }
};

const logSignal = (type, entry, tp, sl, status, pnl = null, reason = "") => {
    const entryStr = entry ?? "";
    const tpStr = tp ?? "";
    const slStr = sl ?? "";
    const pnlStr = pnl !== null && isFinite(pnl) ? Number(pnl).toFixed(6) : "";
    const reasonStr = reason ? `,${reason}` : "";
    const line = `${new Date().toISOString()},${db.pair},${type},${entryStr},${tpStr},${slStr},${status},${pnlStr}${reasonStr}\n`;
    fs.appendFileSync(CONFIG.logPath, line);
    console.log("📝 Signal logged to CSV");
};

const getPositionFromBalance = async () => {
    return await withRetry(async () => {
        const balance = await exchange.fetchBalance();
        const positions = balance.info?.positions || [];
        const marketId = db.pair.replace("/", "").replace(":", "");
        
        const normalize = (str) => (str || "").toString().replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
        const position = positions.find(p => 
            normalize(p.symbol) === normalize(marketId) || 
            normalize(p.contractCode) === normalize(marketId)
        );

        return { balance, position };
    }, "Fetch position");
};

// -------------------- ENHANCED TP/SL UPDATE --------------------
const updateTPSLForOpenPosition = async (signal) => {
    if (!db.activePosition) return;
    
    try {
        console.log("🔄 Checking TP/SL updates...");
        
        const { side, entryPrice, tp: currentTP, sl: currentSL } = db.activePosition;
        let newTP = side === "buy" ? signal.targetLong : signal.targetShort;
        let newSL = side === "buy" ? signal.stopLossLong : signal.stopLossShort;

        // Validate new levels
        if (side === "buy") {
            if (newTP <= entryPrice || newSL >= entryPrice) {
                console.log("⚠️ Invalid TP/SL levels for LONG, keeping current");
                return;
            }
            
            // Only update TP if it's higher than current TP (trailing)
            if (newTP <= currentTP) {
                console.log("📌 New TP not higher than current, keeping current TP");
                newTP = currentTP;
            }
            
            // Only update SL if it's higher than current SL (safer)
            if (newSL <= currentSL) {
                console.log("📌 New SL not safer than current, keeping current SL");
                newSL = currentSL;
            }
            
        } else if (side === "sell") {
            if (newTP >= entryPrice || newSL <= entryPrice) {
                console.log("⚠️ Invalid TP/SL levels for SHORT, keeping current");
                return;
            }
            
            // Only update TP if it's lower than current TP (trailing)
            if (newTP >= currentTP) {
                console.log("📌 New TP not lower than current, keeping current TP");
                newTP = currentTP;
            }
            
            // Only update SL if it's lower than current SL (safer)
            if (newSL >= currentSL) {
                console.log("📌 New SL not safer than current, keeping current SL");
                newSL = currentSL;
            }
        }

        // Apply maximum profit limit
        if (side === "buy") {
            const maxTP = entryPrice * (1 + CONFIG.maxProfitPercent / 100);
            newTP = Math.min(newTP, maxTP);
        } else {
            const maxTP = entryPrice * (1 - CONFIG.maxProfitPercent / 100);
            newTP = Math.max(newTP, maxTP);
        }

        const tpChangePercent = Math.abs((newTP - currentTP) / currentTP * 100);
        const slChangePercent = Math.abs((newSL - currentSL) / currentSL * 100);
        
        if (tpChangePercent < CONFIG.minChangeThreshold && slChangePercent < CONFIG.minChangeThreshold) {
            console.log("ℹ️ No significant TP/SL changes detected");
            return;
        }

        db.activePosition.tp = newTP;
        db.activePosition.sl = newSL;
        saveDB();

        console.log(`✅ TP/SL Updated for ${side.toUpperCase()}:`);
        console.log(`   Entry: ${formatPrice(entryPrice)}`);
        console.log(`   TP: ${formatPrice(currentTP)} → ${formatPrice(newTP)} (${tpChangePercent.toFixed(2)}%)`);
        console.log(`   SL: ${formatPrice(currentSL)} → ${formatPrice(newSL)} (${slChangePercent.toFixed(2)}%)`);
        
        logSignal(
            side === "buy" ? "LONG" : "SHORT",
            entryPrice,
            newTP,
            newSL,
            "TP_SL_UPDATED"
        );

    } catch (error) {
        console.error("❌ TP/SL update failed:", error.message);
    }
};

// -------------------- ENHANCED ORDER MANAGEMENT --------------------
const placeOrder = async (side, tp, sl) => {
    console.log("🔍 Checking for active positions...");
    
    // Comprehensive position check
    try {
        const { position } = await getPositionFromBalance();
        const amt = parseFloat(position?.positionAmt || "0");
        
        if (isFinite(amt) && Math.abs(amt) > CONFIG.minPositionAmount) {
            console.log(`⚠️ Active position detected (${amt}), order cancelled`);
            return;
        }
    } catch (err) {
        console.warn("⚠️ Failed to check live position:", err.message);
    }

    // Database position check
    if (db.activePosition) {
        console.log("⚠️ Active position in database, order cancelled");
        return;
    }

    const price = await getPrice();
    if (!price) {
        console.log("❌ Failed to get price, order cancelled");
        return;
    }

    const qty = calcQty(price);
    if (qty <= 0) {
        console.log("❌ Invalid quantity, order cancelled");
        return;
    }

    console.log(`➡️ ENTRY ${side.toUpperCase()}
- Quantity: ${qty}
- Entry: ${formatPrice(price)}
- TP: ${formatPrice(tp)}
- SL: ${formatPrice(sl)}`);

    try {
        await withRetry(async () => {
            await exchange.setLeverage(db.leverage, db.pair);
            await exchange.setMarginMode(db.marginMode, db.pair);
        }, "Set leverage/margin");
        
        console.log("✅ Leverage and margin mode set");
    } catch (err) {
        console.warn("⚠️ Failed to set leverage/margin:", err.message);
    }

    try {
        const order = await withRetry(
            () => exchange.createOrder(db.pair, "market", side, qty),
            "Create order"
        );
        
        console.log(`✅ Market order created (ID: ${order.id})`);

        db.activePosition = {
            side: side,
            entryPrice: price,
            tp: tp,
            sl: sl,
            orderId: order.id,
            openedAt: new Date().toISOString()
        };
        saveDB();

        logSignal(
            side === "buy" ? "LONG" : "SHORT",
            price,
            tp,
            sl,
            "ORDER_PLACED"
        );
    } catch (err) {
        console.error("❌ Order failed:", err.message);
        logSignal(
            side === "buy" ? "LONG" : "SHORT",
            price,
            tp,
            sl,
            "ORDER_FAILED",
            null,
            err.message
        );
    }
};

const closePosition = async (reason, entryPrice = "N/A") => {
    console.log(`🚨 Closing position: ${reason}`);
    
    try {
        const { position } = await getPositionFromBalance();
        const qty = parseFloat(position?.positionAmt || "0");

        if (!isFinite(qty) || Math.abs(qty) <= CONFIG.minPositionAmount) {
            console.log("ℹ️ No position to close");
            
            // Clean up database even if no position found
            if (db.activePosition) {
                logSignal(
                    db.activePosition.side === "buy" ? "LONG" : "SHORT",
                    db.activePosition.entryPrice,
                    db.activePosition.tp,
                    db.activePosition.sl,
                    "CLOSED_NO_POSITION",
                    null,
                    reason
                );
            }
        } else {
            const side = qty > 0 ? "sell" : "buy";
            const amount = Math.abs(qty);
            
            await withRetry(
                () => exchange.createOrder(db.pair, "market", side, amount, undefined, {
                    reduceOnly: true,
                }),
                "Close position"
            );
            
            console.log(`✅ Close order created (${side}, ${amount})`);

            const exitPrice = await getPrice();
            let pnl = null;
            let statusTag = "CLOSED_MANUAL";

            const isTP = /TP/i.test(reason);
            const isSL = /SL/i.test(reason);

            if (isTP) statusTag = "TP_REALIZED";
            else if (isSL) statusTag = "SL_REALIZED";

            // Calculate PnL if we have valid data
            if (entryPrice !== "N/A" && db.activePosition && isFinite(exitPrice)) {
                const { side: entrySide } = db.activePosition;
                const entryNum = Number(entryPrice);
                
                pnl = entrySide === "buy" ? 
                    (exitPrice - entryNum) * amount : 
                    (entryNum - exitPrice) * amount;
            }

            logSignal(
                qty > 0 ? "LONG" : "SHORT",
                entryPrice,
                db.activePosition?.tp ?? "",
                db.activePosition?.sl ?? "",
                statusTag,
                pnl,
                reason
            );
        }
    } catch (err) {
        console.error("❌ Close position failed:", err.message);
        logSignal(
            db.activePosition?.side === "buy" ? "LONG" : "SHORT",
            db.activePosition?.entryPrice,
            db.activePosition?.tp,
            db.activePosition?.sl,
            "CLOSE_FAILED",
            null,
            err.message
        );
    } finally {
        db.activePosition = null;
        saveDB();
    }
};

// -------------------- ENHANCED TECHNICAL ANALYSIS --------------------
const analyzeSignal = async () => {
    console.log("🧠 Technical analysis started...");
    
    try {
        const ohlcv = await withRetry(
            () => exchange.fetchOHLCV(db.pair, "15m", undefined, 200),
            "Fetch OHLCV"
        );
        
        if (!ohlcv || ohlcv.length < 100) {
            console.warn("⚠️ Insufficient OHLCV data");
            return {};
        }

        const close = ohlcv.map(c => c[4]);
        const high = ohlcv.map(c => c[2]);
        const low = ohlcv.map(c => c[3]);

        // Enhanced Moving Average Analysis
        const ma7 = SMA.calculate({ values: close.slice(-50), period: 7 });
        const ma25 = SMA.calculate({ values: close.slice(-50), period: 25 });
        const ma99 = SMA.calculate({ values: close.slice(-100), period: 99 });

        const currentMA7 = ma7[ma7.length - 1];
        const currentMA25 = ma25[ma25.length - 1];
        const currentMA99 = ma99[ma99.length - 1];

        const prevMA7 = ma7[ma7.length - 2];
        const prevMA25 = ma25[ma25.length - 2];

        const price = close[close.length - 1];

        const isCrossedUp = currentMA7 > currentMA25 && prevMA7 <= prevMA25;
        const isCrossedDown = currentMA7 < currentMA25 && prevMA7 >= prevMA25;

        let canLong = false;
        let canShort = false;

        const isMA7AboveMA99 = currentMA7 > currentMA99;
        const isMA7BelowMA99 = currentMA7 < currentMA99;
        const isMA25AboveMA99 = currentMA25 > currentMA99;
        const isMA25BelowMA99 = currentMA25 < currentMA99;

        // Enhanced signal logic with trend confirmation
        if (isCrossedUp && isMA7AboveMA99 && isMA25AboveMA99) {
            // Additional confirmation: price above MA25
            canLong = price > currentMA25;
        }

        if (isCrossedDown && isMA7BelowMA99 && isMA25BelowMA99) {
            // Additional confirmation: price below MA25
            canShort = price < currentMA25;
        }

        // Enhanced Support/Resistance Detection
        const findSwingLevels = (highArr, lowArr, lookback = 10, minStrength = 2) => {
            const swingHighs = [];
            const swingLows = [];
            
            for (let i = lookback; i < highArr.length - lookback; i++) {
                let isSwingHigh = true;
                let isSwingLow = true;
                
                for (let j = 1; j <= lookback; j++) {
                    if (highArr[i - j] >= highArr[i]) isSwingHigh = false;
                    if (highArr[i + j] >= highArr[i]) isSwingHigh = false;
                    
                    if (lowArr[i - j] <= lowArr[i]) isSwingLow = false;
                    if (lowArr[i + j] <= lowArr[i]) isSwingLow = false;
                }
                
                if (isSwingHigh) {
                    swingHighs.push({ price: highArr[i], index: i });
                }
                
                if (isSwingLow) {
                    swingLows.push({ price: lowArr[i], index: i });
                }
            }
            
            // Group nearby levels
            const groupLevels = (levels, threshold = 0.002) => {
                const groups = [];
                
                levels.sort((a, b) => a.price - b.price).forEach(level => {
                    const existingGroup = groups.find(g => 
                        Math.abs(g.price - level.price) / g.price < threshold
                    );
                    
                    if (existingGroup) {
                        existingGroup.members.push(level);
                        existingGroup.strength++;
                    } else {
                        groups.push({
                            price: level.price,
                            strength: 1,
                            members: [level]
                        });
                    }
                });
                
                return groups.sort((a, b) => b.strength - a.strength);
            };
            
            return {
                resistance: groupLevels(swingHighs).slice(0, 3),
                support: groupLevels(swingLows).slice(0, 3)
            };
        };

        // ATR Calculation for dynamic stop loss
        const calculateATR = (highArr, lowArr, closeArr, period = 14) => {
            const tr = [];
            for (let i = 1; i < highArr.length; i++) {
                const tr1 = highArr[i] - lowArr[i];
                const tr2 = Math.abs(highArr[i] - closeArr[i - 1]);
                const tr3 = Math.abs(lowArr[i] - closeArr[i - 1]);
                tr.push(Math.max(tr1, tr2, tr3));
            }
            
            if (tr.length < period) return 0;
            
            const atr = [];
            for (let i = period - 1; i < tr.length; i++) {
                const slice = tr.slice(i - period + 1, i + 1);
                atr.push(slice.reduce((a, b) => a + b) / period);
            }
            
            return atr.length > 0 ? atr[atr.length - 1] : 0;
        };

        const swingLevels = findSwingLevels(high, low, 8, 2);
        const currentATR = calculateATR(high, low, close, 14);
        
        // Dynamic level calculation with ATR
        const atrMultiplier = 1.5;
        const minDistance = currentATR * atrMultiplier;
        
        const nearestResistance = swingLevels.resistance.length > 0 ? 
            swingLevels.resistance[0].price : price * 1.02;
        const nearestSupport = swingLevels.support.length > 0 ? 
            swingLevels.support[0].price : price * 0.98;

        const targetLong = nearestResistance;
        const stopLossLong = Math.min(nearestSupport, price - minDistance);
        const targetShort = nearestSupport;
        const stopLossShort = Math.max(nearestResistance, price + minDistance);

        console.log(`\n📊 Analysis Results ${db.pair}
─────────────────────────────────────
📈 Long Signal: ${canLong ? "✅ VALID" : "❌ INVALID"}
📉 Short Signal: ${canShort ? "✅ VALID" : "❌ INVALID"}
─────────────────────────────────────
💰 Current Price: ${formatPrice(price)}
📊 MA7: ${formatPrice(currentMA7)} | MA25: ${formatPrice(currentMA25)}
🎯 Resistance: ${formatPrice(nearestResistance)}
🛡️ Support: ${formatPrice(nearestSupport)}
📏 ATR: ${formatPrice(currentATR)}
─────────────────────────────────────`);

        return {
            canLong,
            canShort,
            targetLong,
            stopLossLong,
            targetShort,
            stopLossShort,
            price,
        };
    } catch (error) {
        console.error("❌ Technical analysis failed:", error.message);
        return {};
    }
};

// -------------------- ENHANCED POSITION MONITORING --------------------
const checkPositionStatus = async () => {
    try {
        const { position } = await getPositionFromBalance();
        const amt = parseFloat(position?.positionAmt || "0");
        const amtSafe = isFinite(amt) ? amt : 0;

        // Handle position closure detection
        if (prevPosAmt !== 0 && amtSafe === 0 && db.activePosition) {
            const side = prevPosAmt > 0 ? "LONG" : "SHORT";
            console.log(`📉 ${side} position closed externally`);
            
            logSignal(
                side,
                db.activePosition.entryPrice,
                db.activePosition.tp,
                db.activePosition.sl,
                "CLOSED_EXTERNALLY"
            );
            
            db.activePosition = null;
            saveDB();
        }

        // Monitor active position for TP/SL
        if (db.activePosition && Math.abs(amtSafe) > CONFIG.minPositionAmount) {
            const { tp, sl, side, entryPrice } = db.activePosition;
            const currentPrice = await getPrice();
            if (!currentPrice) return;

            if (side === "buy") {
                if (currentPrice >= tp) await closePosition("TP hit", entryPrice);
                else if (currentPrice <= sl) await closePosition("SL hit", entryPrice);
            } else if (side === "sell") {
                if (currentPrice <= tp) await closePosition("TP hit", entryPrice);
                else if (currentPrice >= sl) await closePosition("SL hit", entryPrice);
            }
        }

        prevPosAmt = amtSafe;
    } catch (err) {
        console.error("❌ Position check failed:", err.message);
    }
};

// -------------------- ENHANCED POSITION RECOVERY --------------------
const recoverPositionState = async () => {
    try {
        console.log("🔄 Checking position sync...");
        
        const { position } = await getPositionFromBalance();
        const amt = parseFloat(position?.positionAmt || "0");
        const amtSafe = isFinite(amt) ? amt : 0;
        
        // Recovery needed: Exchange has position but database doesn't
        if (Math.abs(amtSafe) > CONFIG.minPositionAmount && !db.activePosition) {
            console.log("🔄 Recovering position state...");
            
            const currentPrice = await getPrice();
            if (!currentPrice) return;
            
            const side = amtSafe > 0 ? "buy" : "sell";
            const entryPrice = parseFloat(position?.entryPrice || currentPrice);
            const leverage = position?.leverage || db.leverage;
            const unrealizedPnl = parseFloat(position?.unrealizedProfit || 0);
            
            // Get current market analysis for TP/SL
            const signal = await analyzeSignal();
            
            let tp, sl;
            if (side === "buy") {
                tp = signal.targetLong || (entryPrice * 1.015);
                sl = signal.stopLossLong || (entryPrice * 0.985);
            } else {
                tp = signal.targetShort || (entryPrice * 0.985);
                sl = signal.stopLossShort || (entryPrice * 1.015);
            }
            
            // Validate and adjust levels
            if (side === "buy") {
                if (tp <= entryPrice) tp = entryPrice * 1.02;
                if (sl >= entryPrice) sl = entryPrice * 0.98;
            } else {
                if (tp >= entryPrice) tp = entryPrice * 0.98;
                if (sl <= entryPrice) sl = entryPrice * 1.02;
            }
            
            db.activePosition = {
                side: side,
                entryPrice: entryPrice,
                tp: tp,
                sl: sl,
                orderId: "RECOVERED_" + Date.now(),
                recovered: true,
                unrealizedPnl: unrealizedPnl,
                recoveredAt: new Date().toISOString()
            };
            
            saveDB();
            
            console.log("✅ Position recovered");
            console.log(`   ${side.toUpperCase()} | Entry: ${formatPrice(entryPrice)}`);
            console.log(`   TP: ${formatPrice(tp)} | SL: ${formatPrice(sl)}`);
            console.log(`   PnL: ${formatPrice(unrealizedPnl)} | Leverage: ${leverage}x`);
            
            logSignal(
                side === "buy" ? "LONG" : "SHORT",
                entryPrice,
                tp,
                sl,
                "POSITION_RECOVERED",
                unrealizedPnl
            );
        }
        
        // Cleanup needed: Database has position but exchange doesn't
        if (db.activePosition && Math.abs(amtSafe) <= CONFIG.minPositionAmount) {
            console.log("🔄 Cleaning up orphaned position...");
            
            logSignal(
                db.activePosition.side === "buy" ? "LONG" : "SHORT",
                db.activePosition.entryPrice,
                db.activePosition.tp,
                db.activePosition.sl,
                "CLEANED_ORPHANED"
            );
            
            db.activePosition = null;
            saveDB();
            console.log("✅ Database cleaned");
        }
        
    } catch (err) {
        console.error("❌ Recovery error:", err.message);
    }
};

// -------------------- ENHANCED MAIN LOOP --------------------
const mainLoop = async () => {
    if (isProcessing) {
        console.log("⏳ Skipping: Still processing...");
        return;
    }
    
    isProcessing = true;
    try {
        // Reload configuration
        try {
            const freshDb = JSON.parse(fs.readFileSync(CONFIG.dbPath));
            Object.assign(db, freshDb);
        } catch (error) {
            console.log("⚠️ Using cached configuration");
        }

        const now = new Date();
        
        await recoverPositionState();
        await checkPositionStatus();

        console.log("🔍 Checking for new signals...");

        const signal = await analyzeSignal();
        if (!signal.price) {
            console.log("⚠️ Invalid signal, waiting...");
            return;
        }

        // Update TP/SL for open positions
        if (db.activePosition) {
            await updateTPSLForOpenPosition(signal);
        }

        const hasBotPosition = db.activePosition !== null;
        let shouldExitCurrentPosition = false;

        // Check for signal reversal
        if (hasBotPosition) {
            const currentSide = db.activePosition.side;
            if (currentSide === "buy" && signal.canShort) {
                console.log("🔄 SHORT signal detected, closing LONG");
                shouldExitCurrentPosition = true;
            } else if (currentSide === "sell" && signal.canLong) {
                console.log("🔄 LONG signal detected, closing SHORT");
                shouldExitCurrentPosition = true;
            }
        }

        if (shouldExitCurrentPosition) {
            await closePosition("Signal reversal", db.activePosition.entryPrice);
            // Wait for position to close
            await new Promise(resolve => setTimeout(resolve, 10000));
        }

        // Check if we can enter new position
        const { position } = await getPositionFromBalance();
        const amt = parseFloat(position?.positionAmt || "0");
        const hasActivePosition = isFinite(amt) && Math.abs(amt) > CONFIG.minPositionAmount;

        if (!hasActivePosition) {
            if (signal.canLong) {
                // Additional confirmation for long entry
                const isGoodLongEntry = signal.price > signal.stopLossLong && 
                                      signal.targetLong > signal.price * 1.005;
                
                if (isGoodLongEntry) {
                    console.log(`🚀 LONG Signal | TP: ${formatPrice(signal.targetLong)} | SL: ${formatPrice(signal.stopLossLong)}`);
                    db.lastLongEntryTime = now.getTime();
                    saveDB();
                    await placeOrder("buy", signal.targetLong, signal.stopLossLong);
                } else {
                    console.log(`⏸️ LONG Signal: Poor risk/reward, skipping`);
                }
            } else if (signal.canShort) {
                // Additional confirmation for short entry
                const isGoodShortEntry = signal.price < signal.stopLossShort && 
                                       signal.targetShort < signal.price * 0.995;
                
                if (isGoodShortEntry) {
                    console.log(`📉 SHORT Signal | TP: ${formatPrice(signal.targetShort)} | SL: ${formatPrice(signal.stopLossShort)}`);
                    db.lastShortEntryTime = now.getTime();
                    saveDB();
                    await placeOrder("sell", signal.targetShort, signal.stopLossShort);
                } else {
                    console.log(`⏸️ SHORT Signal: Poor risk/reward, skipping`);
                }
            } else {
                console.log("💤 No valid signals, waiting...");
            }
        }
    } catch (err) {
        console.error("⚠️ Main loop error:", err.message);
    } finally {
        isProcessing = false;
    }
};

// Start the bot
console.log("🤖 Trading bot started...");
setInterval(mainLoop, CONFIG.checkInterval);

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('🛑 Shutting down gracefully...');
    if (db.activePosition) {
        console.log('⚠️ Active position exists, monitoring will stop but position remains open');
    }
    process.exit(0);
});
