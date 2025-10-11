// bot.js (Fixed Version)
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
    retryDelay: 5000,
    maxSRDeviation: 0.10 // Maximum 10% deviation for S/R levels
};

let isProcessing = false;
let prevPosAmt = 0;

// Initialize files
if (!fs.existsSync(CONFIG.logPath)) {
    fs.writeFileSync(CONFIG.logPath, "timestamp,pair,type,entry,tp,sl,status,pnl,reason\n");
}

const db = fs.existsSync(CONFIG.dbPath) ? 
    JSON.parse(fs.readFileSync(CONFIG.dbPath)) : {
        pair: "DOGE/USDT:USDT",
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

// -------------------- ENHANCED TECHNICAL ANALYSIS --------------------
const calculateATR = (highArr, lowArr, closeArr, period = 14) => {
    if (highArr.length < period + 1) return 0;
    
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
    
    return atr.length > 0 ? atr[atr.length - 1] : 0;
};

const findRealisticSwingLevels = (highArr, lowArr, currentPrice, lookback = 8) => {
    const swingHighs = [];
    const swingLows = [];
    
    // Find swing highs and lows
    for (let i = lookback; i < highArr.length - lookback; i++) {
        let isSwingHigh = true;
        let isSwingLow = true;
        
        for (let j = 1; j <= lookback; j++) {
            if (highArr[i - j] > highArr[i]) isSwingHigh = false;
            if (highArr[i + j] > highArr[i]) isSwingHigh = false;
            
            if (lowArr[i - j] < lowArr[i]) isSwingLow = false;
            if (lowArr[i + j] < lowArr[i]) isSwingLow = false;
        }
        
        if (isSwingHigh) {
            swingHighs.push({
                price: highArr[i],
                distance: Math.abs(highArr[i] - currentPrice) / currentPrice
            });
        }
        
        if (isSwingLow) {
            swingLows.push({
                price: lowArr[i],
                distance: Math.abs(lowArr[i] - currentPrice) / currentPrice
            });
        }
    }
    
    // Find nearest realistic levels with maximum deviation
    const nearestResistance = swingHighs
        .filter(level => level.price > currentPrice && level.distance <= CONFIG.maxSRDeviation)
        .sort((a, b) => a.price - b.price)[0]; // Get lowest resistance above price
    
    const nearestSupport = swingLows
        .filter(level => level.price < currentPrice && level.distance <= CONFIG.maxSRDeviation)
        .sort((a, b) => b.price - a.price)[0]; // Get highest support below price
    
    // Fallback: if no realistic levels found, use ATR-based levels
    const atr = calculateATR(highArr, lowArr, Array(highArr.length).fill(currentPrice), 14) || (currentPrice * 0.02);
    
    return {
        resistance: nearestResistance?.price || (currentPrice + (atr * 2)),
        support: nearestSupport?.price || (currentPrice - (atr * 2))
    };
};

const analyzeSignal = async () => {
    console.log("🧠 Technical analysis started...");
    
    try {
        // Fetch OHLCV data with better timeframe for volatile pairs
        const ohlcv = await withRetry(
            () => exchange.fetchOHLCV(db.pair, "15m", undefined, 100),
            "Fetch OHLCV"
        );
        
        // Validate data quality
        if (!ohlcv || ohlcv.length < 50) {
            console.warn("⚠️ Insufficient OHLCV data");
            return {};
        }

        // Check data freshness
        const lastCandleTime = ohlcv[ohlcv.length - 1][0];
        const currentTime = Date.now();
        const timeDiff = currentTime - lastCandleTime;
        
        if (timeDiff > 20 * 60 * 1000) { // 20 minutes
            console.warn("⚠️ OHLCV data might be stale");
        }

        const close = ohlcv.map(c => c[4]);
        const high = ohlcv.map(c => c[2]);
        const low = ohlcv.map(c => c[3]);
        const price = close[close.length - 1];

        // Enhanced Moving Average Analysis with better periods for crypto
        const maPeriods = { fast: 7, medium: 15, slow: 50 };
        const maFast = SMA.calculate({ values: close, period: maPeriods.fast }).pop();
        const maMedium = SMA.calculate({ values: close, period: maPeriods.medium }).pop();
        const maSlow = SMA.calculate({ values: close, period: maPeriods.slow }).pop();

        // Previous values for crossover detection
        const prevMAFast = SMA.calculate({ 
            values: close.slice(0, -1), 
            period: maPeriods.fast 
        }).pop();
        const prevMAMedium = SMA.calculate({ 
            values: close.slice(0, -1), 
            period: maPeriods.medium 
        }).pop();

        // Validate MA differences are significant
        const minMADiff = price * 0.001; // Minimal 0.1% difference
        const hasValidMADiff = Math.abs(maFast - maMedium) > minMADiff;
        
        // Enhanced signal logic with trend confirmation
        const isFastAboveMedium = maFast > maMedium;
        const isMediumAboveSlow = maMedium > maSlow;
        const isFastBelowMedium = maFast < maMedium;
        const isMediumBelowSlow = maMedium < maSlow;
        
        // Crossover detection
        const isGoldenCross = isFastAboveMedium && prevMAFast <= prevMAMedium;
        const isDeathCross = isFastBelowMedium && prevMAFast >= prevMAMedium;

        let canLong = false;
        let canShort = false;

        if (hasValidMADiff) {
            // Long: Golden cross in uptrend, price above fast MA
            canLong = (isGoldenCross || isFastAboveMedium) && isMediumAboveSlow && price > maFast;
            
            // Short: Death cross in downtrend, price below fast MA  
            canShort = (isDeathCross || isFastBelowMedium) && isMediumBelowSlow && price < maFast;
        }

        // Enhanced Support/Resistance with realistic bounds
        const swingLevels = findRealisticSwingLevels(high, low, price, 6);
        const currentATR = calculateATR(high, low, close, 14) || (price * 0.015);

        // Apply maximum deviation bounds to S/R levels
        const boundedResistance = Math.min(
            swingLevels.resistance,
            price * (1 + CONFIG.maxSRDeviation)
        );
        const boundedSupport = Math.max(
            swingLevels.support,
            price * (1 - CONFIG.maxSRDeviation)
        );

        // Calculate TP/SL with ATR-based minimum distances
        const atrMultiplier = 1.5;
        const minDistance = currentATR * atrMultiplier;
        
        const targetLong = Math.max(boundedResistance, price + minDistance);
        const stopLossLong = Math.min(boundedSupport, price - minDistance);
        const targetShort = Math.min(boundedSupport, price - minDistance);
        const stopLossShort = Math.max(boundedResistance, price + minDistance);

        // Validate TP/SL levels are practical
        const longRiskReward = (targetLong - price) / (price - stopLossLong);
        const shortRiskReward = (price - targetShort) / (stopLossShort - price);
        
        const minRiskReward = 1.2; // Minimum 1.2:1 risk/reward
        
        if (canLong && longRiskReward < minRiskReward) {
            console.log(`⏸️ LONG signal rejected: Poor R/R ratio ${longRiskReward.toFixed(2)}`);
            canLong = false;
        }
        
        if (canShort && shortRiskReward < minRiskReward) {
            console.log(`⏸️ SHORT signal rejected: Poor R/R ratio ${shortRiskReward.toFixed(2)}`);
            canShort = false;
        }

        console.log(`\n📊 Enhanced Analysis ${db.pair}
─────────────────────────────────────
📈 Long Signal: ${canLong ? "✅ VALID" : "❌ INVALID"} ${!hasValidMADiff ? "(low MA diff)" : ""}
📉 Short Signal: ${canShort ? "✅ VALID" : "❌ INVALID"} ${!hasValidMADiff ? "(low MA diff)" : ""}
─────────────────────────────────────
💰 Current Price: ${formatPrice(price)}
📊 MA${maPeriods.fast}: ${formatPrice(maFast)} | MA${maPeriods.medium}: ${formatPrice(maMedium)}
🎯 Resistance: ${formatPrice(boundedResistance)} ${boundedResistance !== swingLevels.resistance ? "(BOUNDED)" : ""}
🛡️ Support: ${formatPrice(boundedSupport)} ${boundedSupport !== swingLevels.support ? "(BOUNDED)" : ""}
📏 ATR: ${formatPrice(currentATR)} (${(currentATR/price*100).toFixed(2)}%)
📊 R/R Ratio: LONG ${longRiskReward.toFixed(2)}:1 | SHORT ${shortRiskReward.toFixed(2)}:1
─────────────────────────────────────`);

        return {
            canLong,
            canShort,
            targetLong,
            stopLossLong,
            targetShort,
            stopLossShort,
            price,
            dataQuality: hasValidMADiff ? "GOOD" : "POOR",
            riskReward: {
                long: longRiskReward,
                short: shortRiskReward
            }
        };
        
    } catch (error) {
        console.error("❌ Technical analysis failed:", error.message);
        return {};
    }
};

// -------------------- ENHANCED TP/SL UPDATE --------------------
const updateTPSLForOpenPosition = async (signal) => {
    if (!db.activePosition || !signal.price) return;
    
    try {
        console.log("🔄 Checking TP/SL updates...");
        
        const { side, entryPrice, tp: currentTP, sl: currentSL } = db.activePosition;
        let newTP = side === "buy" ? signal.targetLong : signal.targetShort;
        let newSL = side === "buy" ? signal.stopLossLong : signal.stopLossShort;

        // Validate new levels are safe and logical
        if (side === "buy") {
            if (newTP <= entryPrice || newSL >= entryPrice) {
                console.log("⚠️ Invalid TP/SL levels for LONG, keeping current");
                return;
            }
            
            // Only update TP if it's higher (trailing) and not too aggressive
            if (newTP > currentTP) {
                const maxTP = entryPrice * (1 + CONFIG.maxProfitPercent / 100);
                newTP = Math.min(newTP, maxTP);
            } else {
                console.log("📌 New TP not higher than current, keeping current TP");
                newTP = currentTP;
            }
            
            // Only update SL if it's higher (safer)
            if (newSL > currentSL) {
                // Don't move SL too close to current price
                const minSlDistance = entryPrice * 0.002; // 0.2% minimum
                if (newSL > entryPrice - minSlDistance) {
                    console.log("📌 New SL too close to entry, keeping current SL");
                    newSL = currentSL;
                }
            } else {
                console.log("📌 New SL not safer than current, keeping current SL");
                newSL = currentSL;
            }
            
        } else if (side === "sell") {
            if (newTP >= entryPrice || newSL <= entryPrice) {
                console.log("⚠️ Invalid TP/SL levels for SHORT, keeping current");
                return;
            }
            
            // Only update TP if it's lower (trailing) and not too aggressive
            if (newTP < currentTP) {
                const maxTP = entryPrice * (1 - CONFIG.maxProfitPercent / 100);
                newTP = Math.max(newTP, maxTP);
            } else {
                console.log("📌 New TP not lower than current, keeping current TP");
                newTP = currentTP;
            }
            
            // Only update SL if it's lower (safer)
            if (newSL < currentSL) {
                // Don't move SL too close to current price
                const minSlDistance = entryPrice * 0.002; // 0.2% minimum
                if (newSL < entryPrice + minSlDistance) {
                    console.log("📌 New SL too close to entry, keeping current SL");
                    newSL = currentSL;
                }
            } else {
                console.log("📌 New SL not safer than current, keeping current SL");
                newSL = currentSL;
            }
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

// -------------------- ORDER MANAGEMENT --------------------
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

// -------------------- POSITION MONITORING --------------------
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

// -------------------- POSITION RECOVERY --------------------
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
        if (!signal.price || signal.dataQuality === "POOR") {
            console.log("⏸️ Poor data quality, skipping signal evaluation");
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
                                      signal.targetLong > signal.price * 1.005 &&
                                      signal.riskReward.long >= 1.2;
                
                if (isGoodLongEntry) {
                    console.log(`🚀 LONG Signal | TP: ${formatPrice(signal.targetLong)} | SL: ${formatPrice(signal.stopLossLong)}`);
                    db.lastLongEntryTime = now.getTime();
                    saveDB();
                    await placeOrder("buy", signal.targetLong, signal.stopLossLong);
                } else {
                    console.log(`⏸️ LONG Signal: Poor risk/reward (${signal.riskReward.long.toFixed(2)}:1), skipping`);
                }
            } else if (signal.canShort) {
                // Additional confirmation for short entry
                const isGoodShortEntry = signal.price < signal.stopLossShort && 
                                       signal.targetShort < signal.price * 0.995 &&
                                       signal.riskReward.short >= 1.2;
                
                if (isGoodShortEntry) {
                    console.log(`📉 SHORT Signal | TP: ${formatPrice(signal.targetShort)} | SL: ${formatPrice(signal.stopLossShort)}`);
                    db.lastShortEntryTime = now.getTime();
                    saveDB();
                    await placeOrder("sell", signal.targetShort, signal.stopLossShort);
                } else {
                    console.log(`⏸️ SHORT Signal: Poor risk/reward (${signal.riskReward.short.toFixed(2)}:1), skipping`);
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
mainLoop(); // Run immediately once
setInterval(mainLoop, CONFIG.checkInterval);

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('🛑 Shutting down gracefully...');
    if (db.activePosition) {
        console.log('⚠️ Active position exists, monitoring will stop but position remains open');
    }
    process.exit(0);
});
