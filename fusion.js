// bot.js (Enhanced Version with botv2.js Features)
require("dotenv").config();
const fs = require("fs");
const ccxt = require("ccxt");
const { SMA, EMA, RSI, ATR: ATR_IND } = require("technicalindicators");

// -------------------- ENHANCED CONFIG --------------------
const CONFIG = {
    dbPath: "./db.json",
    logPath: "./log.csv",
    checkInterval: 30000,
    minPositionAmount: 0.000001,
    safetyMargin: 0.001,
    maxRiskPerTrade: 0.02,
    atrMultiplier: 1.5,
    minRiskReward: 1.5,
    volatilityThreshold: 0.02,
    maxRetryAttempts: 3,
    retryDelay: 5000,
    marketConditions: {
        highVolatility: 0.05,
        lowVolatility: 0.01,
        extremeVolatility: 0.10
    }
};

let isProcessing = false;
let prevPosAmt = 0;
let marketAnalysis = {};

// -------------------- FILE INIT --------------------
if (!fs.existsSync(CONFIG.logPath)) {
    fs.writeFileSync(CONFIG.logPath, "timestamp,pair,type,entry,tp,sl,status,pnl,volatility,market_condition,r_r_ratio\n");
    console.log("📝 Log file created: log.csv");
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
        totalBalance: 100,
        tradingEnabled: true,
        performance: {
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            totalPnl: 0
        }
    };

console.log(`⚙️ Enhanced Bot Configuration:
- Pair: ${db.pair}
- Leverage: ${db.leverage}x
- Margin Mode: ${db.marginMode}
- USDT per Trade: ${db.usdtPerTrade}
- Total Balance: ${db.totalBalance?.toFixed(2) || '0.00'} USDT`);

// -------------------- ENHANCED EXCHANGE --------------------
const exchange = new ccxt.binance({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 
        defaultType: "future",
        adjustForTimeDifference: true
    },
});

// Enhanced error handling
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
        
        // Initialize balance
        const balance = await exchange.fetchBalance();
        db.totalBalance = balance.total?.USDT || 100;
        console.log(`💰 Total Balance: ${db.totalBalance.toFixed(2)} USDT`);
        saveDB();
    } catch (err) {
        console.error("❌ Failed to load markets:", err.message);
    }
})();

// -------------------- ENHANCED UTIL FUNCTIONS --------------------
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
        if (!price || price <= 0) throw new Error("Invalid price received");
        return price;
    }, "Fetch price");
};

// Dynamic position sizing from botv2.js
const calcDynamicQty = async (price, stopLossPrice, side) => {
    if (!price || price <= 0 || !stopLossPrice) {
        console.error("❌ Invalid parameters for quantity calculation");
        return 0;
    }
    
    try {
        const market = exchange.markets[db.pair];
        const prec = market?.precision?.amount ?? 3;
        const minQty = market?.limits?.amount?.min ?? 0;
        
        // Calculate risk-based position size
        const riskAmount = db.totalBalance * CONFIG.maxRiskPerTrade;
        const priceDistance = Math.abs(price - stopLossPrice);
        
        if (priceDistance <= 0) {
            console.error("❌ Invalid stop loss distance");
            return 0;
        }
        
        let qty = parseFloat((riskAmount / priceDistance).toFixed(prec));
        
        // Adjust based on volatility
        if (marketAnalysis.volatility === "high") {
            qty *= 0.7;
            console.log("📉 High volatility - reducing position size by 30%");
        } else if (marketAnalysis.volatility === "low") {
            qty *= 1.2;
            console.log("📈 Low volatility - increasing position size by 20%");
        } else if (marketAnalysis.volatility === "extreme") {
            qty *= 0.5;
            console.log("⚡ Extreme volatility - reducing position size by 50%");
        }
        
        // Cap position size to available balance
        const maxQtyByBalance = (db.totalBalance * 0.8) / price;
        qty = Math.min(qty, maxQtyByBalance);
        
        // Ensure minimum quantity requirement
        if (minQty > 0 && qty < minQty) {
            console.warn(`⚠️ Quantity ${qty} below minimum ${minQty}, adjusting`);
            qty = minQty;
        }
        
        const riskPercent = (priceDistance / price) * 100;
        console.log(`📐 Dynamic Quantity: ${qty} | Risk: ${riskPercent.toFixed(2)}% | Volatility: ${marketAnalysis.volatility}`);
        return qty;
    } catch (err) {
        console.error("❌ Quantity calculation failed:", err.message);
        return 0;
    }
};

const logSignal = (type, entry, tp, sl, status, pnl = null, volatility = "", marketCondition = "", rrRatio = "") => {
    const timestamp = new Date().toISOString();
    const entryStr = entry !== null && entry !== undefined ? formatPrice(entry) : "";
    const tpStr = tp !== null && tp !== undefined ? formatPrice(tp) : "";
    const slStr = sl !== null && sl !== undefined ? formatPrice(sl) : "";
    const pnlStr = pnl !== null && isFinite(pnl) ? Number(pnl).toFixed(6) : "";
    
    const line = `${timestamp},${db.pair},${type},${entryStr},${tpStr},${slStr},${status},${pnlStr},${volatility},${marketCondition},${rrRatio}\n`;
    fs.appendFileSync(CONFIG.logPath, line);
    console.log("📝 Enhanced signal logged to CSV");
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

// -------------------- ENHANCED MARKET ANALYSIS --------------------
const analyzeMarketConditions = (ohlcv) => {
    const closes = ohlcv.map(c => c[4]);
    const highs = ohlcv.map(c => c[2]);
    const lows = ohlcv.map(c => c[3]);
    
    if (closes.length < 20) {
        return { volatility: "unknown", marketCondition: "unknown", atr: 0, atrRatio: 0, trendStrength: 0 };
    }
    
    // Calculate volatility (ATR based)
    const atr = ATR_IND.calculate({
        high: highs.slice(-30),
        low: lows.slice(-30),
        close: closes.slice(-30),
        period: 14
    });
    
    const currentATR = atr[atr.length - 1] || 0;
    const currentPrice = closes[closes.length - 1];
    const atrRatio = currentATR / currentPrice;
    
    let volatility = "medium";
    if (atrRatio > CONFIG.marketConditions.extremeVolatility) {
        volatility = "extreme";
    } else if (atrRatio > CONFIG.marketConditions.highVolatility) {
        volatility = "high";
    } else if (atrRatio < CONFIG.marketConditions.lowVolatility) {
        volatility = "low";
    }
    
    // Calculate trend strength
    const ema20 = EMA.calculate({ period: 20, values: closes });
    const ema50 = EMA.calculate({ period: 50, values: closes });
    
    if (!ema20 || ema20.length === 0 || !ema50 || ema50.length === 0) {
        return { volatility, marketCondition: "unknown", atr: currentATR, atrRatio, trendStrength: 0 };
    }
    
    const trendStrength = Math.abs((ema20[ema20.length - 1] - ema50[ema50.length - 1]) / currentPrice);
    
    let marketCondition = "neutral";
    if (trendStrength > 0.03) marketCondition = "trending";
    else if (trendStrength < 0.01) marketCondition = "ranging";
    
    return {
        volatility,
        marketCondition,
        atr: currentATR,
        atrRatio,
        trendStrength
    };
};

// -------------------- TECHNICAL ANALYSIS (KEEPING BOT.JS LOGIC) --------------------
const analyzeSignal = async () => {
    console.log("🧠 Enhanced Technical analysis started...");
    
    try {
        const ohlcv = await withRetry(() => exchange.fetchOHLCV(db.pair, "15m", undefined, 200), "Fetch OHLCV");
        if (!ohlcv || ohlcv.length < 200) {
            console.warn("⚠️ Insufficient OHLCV data");
            return {};
        }

        const close = ohlcv.map(c => c[4]);
        const high = ohlcv.map(c => c[2]);
        const low = ohlcv.map(c => c[3]);

        // Analyze market conditions from botv2.js
        marketAnalysis = analyzeMarketConditions(ohlcv);
        
        // KEEP ORIGINAL BOT.JS LOGIC FOR SIGNALS
        // Moving Averages
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

        // PRESERVE ORIGINAL VALIDATION LOGIC
        if (isCrossedUp && isMA7AboveMA99 && isMA25AboveMA99) {
            canLong = true;
        }

        if (isCrossedDown && isMA7BelowMA99 && isMA25BelowMA99) {
            canShort = true;
        }

        // Support/Resistance Detection (Original bot.js logic)
        const findAdvancedSwingLevels = (highArr, lowArr, lookback = 10, minStrength = 2) => {
            const swingHighs = [];
            const swingLows = [];
            
            for (let i = lookback; i < highArr.length - lookback; i++) {
                let isSwingHigh = true;
                let isSwingLow = true;
                let strengthHigh = 0;
                let strengthLow = 0;
                
                for (let j = 1; j <= lookback; j++) {
                    if (highArr[i - j] > highArr[i]) isSwingHigh = false;
                    if (highArr[i + j] > highArr[i]) isSwingHigh = false;
                    
                    if (lowArr[i - j] < lowArr[i]) isSwingLow = false;
                    if (lowArr[i + j] < lowArr[i]) isSwingLow = false;
                    
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
            
            const groupLevels = (levels, threshold = 0.002) => {
                const groups = [];
                
                levels.sort((a, b) => a.price - b.price).forEach(level => {
                    const existingGroup = groups.find(g => 
                        Math.abs(g.price - level.price) / g.price < threshold
                    );
                    
                    if (existingGroup) {
                        existingGroup.members.push(level);
                        existingGroup.price = (existingGroup.price + level.price) / 2;
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
                resistance: groupLevels(swingHighs).slice(0, 3),
                support: groupLevels(swingLows).slice(0, 3)
            };
        };

        // ATR Calculation
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

        const advancedLevels = findAdvancedSwingLevels(high, low, 8, 3);
        const currentATR = calculateATR(high, low, close, 14).pop() || 0;
        
        const minDistance = currentATR * 0.5;
        
        const validResistance = advancedLevels.resistance
            .filter(level => level.price > price + minDistance)
            .sort((a, b) => a.price - b.price);
        
        const validSupport = advancedLevels.support
            .filter(level => level.price < price - minDistance)
            .sort((a, b) => b.price - a.price);

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

        // Enhanced risk/reward validation from botv2.js
        const longRiskReward = (targetLong - price) / (price - stopLossLong);
        const shortRiskReward = (price - targetShort) / (stopLossShort - price);
        
        // Adjust minimum R/R based on market conditions
        const minRR = marketAnalysis.volatility === "high" ? CONFIG.minRiskReward * 1.2 : 
                     marketAnalysis.volatility === "extreme" ? CONFIG.minRiskReward * 1.5 : CONFIG.minRiskReward;
        
        if (canLong && longRiskReward < minRR) {
            console.log(`⏸️ LONG rejected: Poor R/R ${longRiskReward.toFixed(2)} in ${marketAnalysis.volatility} volatility`);
            canLong = false;
        }
        
        if (canShort && shortRiskReward < minRR) {
            console.log(`⏸️ SHORT rejected: Poor R/R ${shortRiskReward.toFixed(2)} in ${marketAnalysis.volatility} volatility`);
            canShort = false;
        }

        // Check minimum volatility for trading
        if (marketAnalysis.atrRatio < CONFIG.volatilityThreshold) {
            console.log(`⏸️ Market too calm (volatility: ${(marketAnalysis.atrRatio * 100).toFixed(2)}%), skipping`);
            canLong = false;
            canShort = false;
        }

        console.log(`\n📊 Enhanced Analysis Results ${db.pair}
─────────────────────────────────────
📈 Long Signal: ${canLong ? "✅ VALID" : "❌ INVALID"}
📉 Short Signal: ${canShort ? "✅ VALID" : "❌ INVALID"}
─────────────────────────────────────
💰 Current Price: ${formatPrice(price)}
📊 Market Condition: ${marketAnalysis.marketCondition.toUpperCase()}
📈 Volatility: ${marketAnalysis.volatility.toUpperCase()} (${(marketAnalysis.atrRatio * 100).toFixed(2)}%)
📏 ATR: ${formatPrice(marketAnalysis.atr)}
─────────────────────────────────────
🎯 R/R Ratio: LONG ${longRiskReward.toFixed(2)}:1 | SHORT ${shortRiskReward.toFixed(2)}:1
─────────────────────────────────────`);

        return {
            canLong,
            canShort,
            targetLong,
            stopLossLong,
            targetShort,
            stopLossShort,
            price,
            marketCondition: marketAnalysis.marketCondition,
            volatility: marketAnalysis.volatility,
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

// -------------------- ENHANCED ORDER MANAGEMENT --------------------
const placeOrder = async (side, tp, sl) => {
    if (!db.tradingEnabled) {
        console.log("⏸️ Trading temporarily disabled");
        return;
    }

    console.log("🔍 Enhanced position checking...");
    
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

    if (db.activePosition) {
        console.log("⚠️ Active position in database, order cancelled");
        return;
    }

    const price = await getPrice();
    if (!price) {
        console.log("❌ Failed to get price, order cancelled");
        return;
    }

    const stopLossPrice = side === "buy" ? sl : tp;
    const qty = await calcDynamicQty(price, stopLossPrice, side);
    if (qty <= 0) {
        console.log("❌ Invalid quantity, order cancelled");
        return;
    }

    console.log(`➡️ ENHANCED ENTRY ${side.toUpperCase()}
- Dynamic Quantity: ${qty}
- Entry: ${formatPrice(price)}
- TP: ${formatPrice(tp)}
- SL: ${formatPrice(sl)}
- Volatility: ${marketAnalysis.volatility}
- Market Condition: ${marketAnalysis.marketCondition}`);

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
            openedAt: new Date().toISOString(),
            volatility: marketAnalysis.volatility,
            marketCondition: marketAnalysis.marketCondition,
            quantity: qty
        };
        
        // Update performance metrics
        db.performance.totalTrades = (db.performance.totalTrades || 0) + 1;
        saveDB();

        const rrRatio = side === "buy" ? 
            ((tp - price) / (price - sl)).toFixed(2) : 
            ((price - tp) / (sl - price)).toFixed(2);

        logSignal(
            side === "buy" ? "LONG" : "SHORT",
            price,
            tp,
            sl,
            "ORDER_PLACED",
            null,
            marketAnalysis.volatility,
            marketAnalysis.marketCondition,
            rrRatio
        );
        
    } catch (err) {
        console.error("❌ Order failed:", err.message);
        
        const rrRatio = side === "buy" ? 
            ((tp - price) / (price - sl)).toFixed(2) : 
            ((price - tp) / (sl - price)).toFixed(2);
            
        logSignal(
            side === "buy" ? "LONG" : "SHORT",
            price,
            tp,
            sl,
            "ORDER_FAILED",
            null,
            marketAnalysis.volatility,
            marketAnalysis.marketCondition,
            rrRatio
        );
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
            
            // Only update TP if it's higher (trailing)
            if (newTP > currentTP) {
                const maxTP = entryPrice * (1 + (CONFIG.maxRiskPerTrade * 5 / 100));
                newTP = Math.min(newTP, maxTP);
                console.log(`📈 Trailing TP up to: ${formatPrice(newTP)}`);
            } else {
                console.log("📌 New TP not higher than current, keeping current TP");
                newTP = currentTP;
            }
            
            // Only update SL if it's higher (safer)
            if (newSL > currentSL) {
                const minSlDistance = entryPrice * 0.002;
                if (newSL > entryPrice - minSlDistance) {
                    console.log("📌 New SL too close to entry, keeping current SL");
                    newSL = currentSL;
                } else {
                    console.log(`🛡️ Moving SL to safety: ${formatPrice(newSL)}`);
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
            
            // Only update TP if it's lower (trailing)
            if (newTP < currentTP) {
                const maxTP = entryPrice * (1 - (CONFIG.maxRiskPerTrade * 5 / 100));
                newTP = Math.max(newTP, maxTP);
                console.log(`📉 Trailing TP down to: ${formatPrice(newTP)}`);
            } else {
                console.log("📌 New TP not lower than current, keeping current TP");
                newTP = currentTP;
            }
            
            // Only update SL if it's lower (safer)
            if (newSL < currentSL) {
                const minSlDistance = entryPrice * 0.002;
                if (newSL < entryPrice + minSlDistance) {
                    console.log("📌 New SL too close to entry, keeping current SL");
                    newSL = currentSL;
                } else {
                    console.log(`🛡️ Moving SL to safety: ${formatPrice(newSL)}`);
                }
            } else {
                console.log("📌 New SL not safer than current, keeping current SL");
                newSL = currentSL;
            }
        }

        const tpChangePercent = Math.abs((newTP - currentTP) / currentTP * 100);
        const slChangePercent = Math.abs((newSL - currentSL) / currentSL * 100);
        
        const changeThreshold = marketAnalysis.volatility === "high" ? 0.5 : 
                              marketAnalysis.volatility === "low" ? 0.1 : 0.2;
        
        if (tpChangePercent < changeThreshold && slChangePercent < changeThreshold) {
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
        
        const rrRatio = side === "buy" ? 
            ((newTP - entryPrice) / (entryPrice - newSL)).toFixed(2) : 
            ((entryPrice - newTP) / (newSL - entryPrice)).toFixed(2);

        logSignal(
            side === "buy" ? "LONG" : "SHORT",
            entryPrice,
            newTP,
            newSL,
            "TP_SL_UPDATED",
            null,
            marketAnalysis.volatility,
            marketAnalysis.marketCondition,
            rrRatio
        );

    } catch (error) {
        console.error("❌ TP/SL update failed:", error.message);
    }
};

// -------------------- ENHANCED POSITION MANAGEMENT --------------------
const closePosition = async (reason, entryPrice = "N/A") => {
    console.log(`🚨 Closing position: ${reason}`);
    
    try {
        const { position } = await getPositionFromBalance();
        const qty = parseFloat(position?.positionAmt || "0");

        if (!isFinite(qty) || Math.abs(qty) <= CONFIG.minPositionAmount) {
            console.log("ℹ️ No position to close");
            
            if (db.activePosition) {
                const rrRatio = db.activePosition.side === "buy" ? 
                    ((db.activePosition.tp - db.activePosition.entryPrice) / (db.activePosition.entryPrice - db.activePosition.sl)).toFixed(2) : 
                    ((db.activePosition.entryPrice - db.activePosition.tp) / (db.activePosition.sl - db.activePosition.entryPrice)).toFixed(2);
                    
                logSignal(
                    db.activePosition.side === "buy" ? "LONG" : "SHORT",
                    db.activePosition.entryPrice,
                    db.activePosition.tp,
                    db.activePosition.sl,
                    "CLOSED_NO_POSITION",
                    null,
                    db.activePosition.volatility,
                    db.activePosition.marketCondition,
                    rrRatio
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

            if (entryPrice !== "N/A" && db.activePosition && isFinite(exitPrice)) {
                const { side: entrySide, quantity } = db.activePosition;
                const entryNum = Number(entryPrice);
                
                pnl = entrySide === "buy" ? 
                    (exitPrice - entryNum) * quantity : 
                    (entryNum - exitPrice) * quantity;
                
                if (pnl > 0) {
                    db.performance.winningTrades = (db.performance.winningTrades || 0) + 1;
                } else {
                    db.performance.losingTrades = (db.performance.losingTrades || 0) + 1;
                }
                db.performance.totalPnl = (db.performance.totalPnl || 0) + pnl;
            }

            const rrRatio = db.activePosition?.side === "buy" ? 
                ((db.activePosition.tp - db.activePosition.entryPrice) / (db.activePosition.entryPrice - db.activePosition.sl)).toFixed(2) : 
                ((db.activePosition.entryPrice - db.activePosition.tp) / (db.activePosition.sl - db.activePosition.entryPrice)).toFixed(2);

            logSignal(
                qty > 0 ? "LONG" : "SHORT",
                entryPrice,
                db.activePosition?.tp ?? "",
                db.activePosition?.sl ?? "",
                statusTag,
                pnl,
                db.activePosition?.volatility,
                db.activePosition?.marketCondition,
                rrRatio
            );
            
            console.log(`💰 PnL: ${pnl !== null ? pnl.toFixed(4) + ' USDT' : 'N/A'}`);
        }
    } catch (err) {
        console.error("❌ Close position failed:", err.message);
        
        const rrRatio = db.activePosition?.side === "buy" ? 
            ((db.activePosition.tp - db.activePosition.entryPrice) / (db.activePosition.entryPrice - db.activePosition.sl)).toFixed(2) : 
            ((db.activePosition.entryPrice - db.activePosition.tp) / (db.activePosition.sl - db.activePosition.entryPrice)).toFixed(2);
            
        logSignal(
            db.activePosition?.side === "buy" ? "LONG" : "SHORT",
            db.activePosition?.entryPrice,
            db.activePosition?.tp,
            db.activePosition?.sl,
            "CLOSE_FAILED",
            null,
            db.activePosition?.volatility,
            db.activePosition?.marketCondition,
            rrRatio
        );
    } finally {
        db.activePosition = null;
        saveDB();
    }
};

const checkPositionStatus = async () => {
    try {
        const { position } = await getPositionFromBalance();
        const amt = parseFloat(position?.positionAmt || "0");
        const amtSafe = isFinite(amt) ? amt : 0;

        if (prevPosAmt !== 0 && amtSafe === 0 && db.activePosition) {
            const side = prevPosAmt > 0 ? "LONG" : "SHORT";
            console.log(`📉 ${side} position closed externally`);
            
            const rrRatio = db.activePosition.side === "buy" ? 
                ((db.activePosition.tp - db.activePosition.entryPrice) / (db.activePosition.entryPrice - db.activePosition.sl)).toFixed(2) : 
                ((db.activePosition.entryPrice - db.activePosition.tp) / (db.activePosition.sl - db.activePosition.entryPrice)).toFixed(2);
            
            logSignal(
                side,
                db.activePosition.entryPrice,
                db.activePosition.tp,
                db.activePosition.sl,
                "CLOSED_EXTERNALLY",
                null,
                db.activePosition.volatility,
                db.activePosition.marketCondition,
                rrRatio
            );
            
            db.activePosition = null;
            saveDB();
        }

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
        console.log("🔄 Enhanced position sync...");
        
        const { position } = await getPositionFromBalance();
        const amt = parseFloat(position?.positionAmt || "0");
        const amtSafe = isFinite(amt) ? amt : 0;
        
        if (Math.abs(amtSafe) > CONFIG.minPositionAmount && !db.activePosition) {
            console.log("🔄 Recovering position state...");
            
            const currentPrice = await getPrice();
            if (!currentPrice) return;
            
            const side = amtSafe > 0 ? "buy" : "sell";
            const entryPrice = parseFloat(position?.entryPrice || currentPrice);
            const leverage = position?.leverage || db.leverage;
            const unrealizedPnl = parseFloat(position?.unrealizedProfit || 0);
            
            const signal = await analyzeSignal();
            
            let tp, sl;
            if (side === "buy") {
                tp = signal.targetLong || (entryPrice * 1.015);
                sl = signal.stopLossLong || (entryPrice * 0.985);
            } else {
                tp = signal.targetShort || (entryPrice * 0.985);
                sl = signal.stopLossShort || (entryPrice * 1.015);
            }
            
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
                recoveredAt: new Date().toISOString(),
                quantity: Math.abs(amtSafe),
                volatility: signal.volatility || "unknown",
                marketCondition: signal.marketCondition || "unknown"
            };
            
            saveDB();
            
            console.log("✅ Position recovered");
            console.log(`   ${side.toUpperCase()} | Entry: ${formatPrice(entryPrice)}`);
            console.log(`   TP: ${formatPrice(tp)} | SL: ${formatPrice(sl)}`);
            console.log(`   PnL: ${formatPrice(unrealizedPnl)} | Leverage: ${leverage}x`);
            
            const rrRatio = side === "buy" ? 
                ((tp - entryPrice) / (entryPrice - sl)).toFixed(2) : 
                ((entryPrice - tp) / (sl - entryPrice)).toFixed(2);
            
            logSignal(
                side === "buy" ? "LONG" : "SHORT",
                entryPrice,
                tp,
                sl,
                "POSITION_RECOVERED",
                unrealizedPnl,
                signal.volatility,
                signal.marketCondition,
                rrRatio
            );
        }
        
        if (db.activePosition && Math.abs(amtSafe) <= CONFIG.minPositionAmount) {
            console.log("🔄 Cleaning up orphaned position...");
            
            const rrRatio = db.activePosition.side === "buy" ? 
                ((db.activePosition.tp - db.activePosition.entryPrice) / (db.activePosition.entryPrice - db.activePosition.sl)).toFixed(2) : 
                ((db.activePosition.entryPrice - db.activePosition.tp) / (db.activePosition.sl - db.activePosition.entryPrice)).toFixed(2);
            
            logSignal(
                db.activePosition.side === "buy" ? "LONG" : "SHORT",
                db.activePosition.entryPrice,
                db.activePosition.tp,
                db.activePosition.sl,
                "CLEANED_ORPHANED",
                null,
                db.activePosition.volatility,
                db.activePosition.marketCondition,
                rrRatio
            );
            
            db.activePosition = null;
            saveDB();
            console.log("✅ Database cleaned");
        }
        
    } catch (err) {
        console.error("❌ Recovery error:", err.message);
    }
};

// -------------------- PERFORMANCE MONITORING --------------------
const showPerformance = () => {
    const perf = db.performance || {};
    const totalTrades = perf.totalTrades || 0;
    const winningTrades = perf.winningTrades || 0;
    const losingTrades = perf.losingTrades || 0;
    const totalPnl = perf.totalPnl || 0;
    
    if (totalTrades > 0) {
        const winRate = (winningTrades / totalTrades) * 100;
        const avgTrade = totalPnl / totalTrades;
        
        console.log(`\n📊 Performance Summary:
─────────────────────────────────────
📈 Total Trades: ${totalTrades}
✅ Winning Trades: ${winningTrades}
❌ Losing Trades: ${losingTrades}
🎯 Win Rate: ${winRate.toFixed(1)}%
💰 Total PnL: ${totalPnl.toFixed(4)} USDT
📊 Avg Trade: ${avgTrade.toFixed(4)} USDT
─────────────────────────────────────`);
    }
};

// -------------------- ENHANCED MAIN LOOP --------------------
setInterval(async () => {
    // Auto reload config
    try {
        const freshDb = JSON.parse(fs.readFileSync(CONFIG.dbPath));
        db.pair = freshDb.pair;
        db.leverage = freshDb.leverage; 
        db.marginMode = freshDb.marginMode;
        db.usdtPerTrade = freshDb.usdtPerTrade;
        db.tradingEnabled = freshDb.tradingEnabled !== undefined ? freshDb.tradingEnabled : true;
    } catch (error) {
        // Use existing config on error
    }

    if (isProcessing) {
        console.log("⏳ Skipping: Still processing...");
        return;
    }
    
    isProcessing = true;
    try {
        const now = new Date();
        
        await recoverPositionState();
        await checkPositionStatus();

        console.log("🔍 Enhanced signal analysis...");

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
            await new Promise(resolve => setTimeout(resolve, 15000));
        }

        const { position } = await getPositionFromBalance();
        const amt = parseFloat(position?.positionAmt || "0");
        const hasActiveBinancePositionAfterClose = isFinite(amt) && Math.abs(amt) > CONFIG.minPositionAmount;

        if (db.activePosition === null && !hasActiveBinancePositionAfterClose && db.tradingEnabled) {
            if (signal.canLong) {
                const isLongBreakout = signal.price > signal.targetLong;
                if (!isLongBreakout) {
                    console.log(`🚀 ENHANCED LONG Signal | TP: ${formatPrice(signal.targetLong)} | SL: ${formatPrice(signal.stopLossLong)}`);
                    db.lastLongEntryTime = now;
                    saveDB();
                    await placeOrder("buy", signal.targetLong, signal.stopLossLong);
                } else {
                    console.log(`⏸️ LONG Signal: Breakout detected, skipping`);
                }
            } else if (signal.canShort) {
                const isShortBreakout = signal.price < signal.targetShort;
                if (!isShortBreakout) {
                    console.log(`📉 ENHANCED SHORT Signal | TP: ${formatPrice(signal.targetShort)} | SL: ${formatPrice(signal.stopLossShort)}`);
                    db.lastShortEntryTime = now;
                    saveDB();
                    await placeOrder("sell", signal.targetShort, signal.stopLossShort);
                } else {
                    console.log(`⏸️ SHORT Signal: Breakout detected, skipping`);
                }
            } else {
                console.log("💤 No valid enhanced signals, waiting...");
            }
        }

        // Show performance periodically
        if (Math.random() < 0.1) {
            showPerformance();
        }
    } catch (err) {
        console.error("⚠️ Main loop error:", err.message);
    } finally {
        isProcessing = false;
    }
}, CONFIG.checkInterval);

// Start message
console.log("\n🤖 Enhanced Crypto Trading Bot Started!");
console.log("⚡ Features: Dynamic position sizing, Market condition analysis, Enhanced risk management");
console.log("📊 Technical: Multi-indicator analysis, Volatility adjustment, Advanced TP/SL management\n");

// Enhanced graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Enhanced shutdown sequence initiated...');
    
    try {
        const balance = await exchange.fetchBalance();
        const totalUSDT = balance.total?.USDT;
        console.log(`💰 Final Balance: ${totalUSDT ? totalUSDT.toFixed(2) : 'Unknown'} USDT`);
        
        showPerformance();
    } catch (err) {
        console.log('⚠️ Could not fetch final balance');
    }
    
    if (db.activePosition) {
        console.log('⚠️ Active position exists in database - monitoring stopped but position remains open');
    }
    
    console.log('👋 Bot shutdown completed');
    process.exit(0);
});
