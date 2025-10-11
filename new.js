// bot.js (Complete Optimized Version for All Crypto Markets)
require("dotenv").config();
const fs = require("fs");
const ccxt = require("ccxt");
const { SMA, EMA, RSI, ATR: ATR_IND } = require("technicalindicators");

// -------------------- ENHANCED CONFIGURATION --------------------
const CONFIG = {
    dbPath: "./db.json",
    logPath: "./log.csv",
    checkInterval: 30000,
    minPositionAmount: 0.000001,
    safetyMargin: 0.001,
    maxRiskPerTrade: 0.02, // Max 2% risk per trade
    maxPortfolioRisk: 0.10, // Max 10% total portfolio risk
    atrMultiplier: 1.5,
    minRiskReward: 1.5,
    volatilityThreshold: 0.02, // Minimum 2% volatility for trading
    maxRetryAttempts: 3,
    retryDelay: 5000,
    trendConfirmationPeriods: 3,
    marketConditions: {
        highVolatility: 0.05, // 5%+ ATR/Price ratio
        lowVolatility: 0.01,  // 1% ATR/Price ratio
        extremeVolatility: 0.10 // 10%+ ATR/Price ratio
    },
    maxSRDeviation: 0.10
};

let isProcessing = false;
let prevPosAmt = 0;
let marketAnalysis = {};

// Initialize files
if (!fs.existsSync(CONFIG.logPath)) {
    fs.writeFileSync(CONFIG.logPath, "timestamp,pair,type,entry,tp,sl,status,pnl,reason,volatility,market_condition,r_r_ratio\n");
}

const db = fs.existsSync(CONFIG.dbPath) ? 
    JSON.parse(fs.readFileSync(CONFIG.dbPath)) : {
        pair: "DOGE/USDT:USDT",
        leverage: 10,
        marginMode: "ISOLATED",
        activePosition: null,
        usdtPerTrade: 5.1,
        totalBalance: 100,
        riskMode: "dynamic",
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
- Risk Mode: ${db.riskMode}
- Max Risk/Trade: ${CONFIG.maxRiskPerTrade * 100}%
- Total Balance: ${db.totalBalance?.toFixed(2) || '0.00'} USDT`);

// -------------------- EXCHANGE SETUP --------------------
const exchange = new ccxt.binance({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 
        defaultType: "future",
        adjustForTimeDifference: true
    },
});

// Enhanced error handling with circuit breaker
const withRetry = async (fn, context = "operation", retries = CONFIG.maxRetryAttempts) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            console.error(`❌ ${context} attempt ${attempt} failed:`, error.message);
            if (attempt === retries) {
                if (error.message.includes('rate limit') || error.message.includes('busy')) {
                    console.log('⏳ Rate limit hit, extending delay...');
                    await new Promise(resolve => setTimeout(resolve, CONFIG.retryDelay * 2));
                }
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, CONFIG.retryDelay * attempt));
        }
    }
};

// Initialize exchange
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
        console.error("❌ Failed to load markets after retries:", err.message);
        process.exit(1);
    }
})();

// -------------------- ENHANCED UTILITY FUNCTIONS --------------------
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

// Dynamic position sizing based on volatility and risk
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
            qty *= 0.7; // Reduce position size in high volatility
            console.log("📉 High volatility - reducing position size by 30%");
        } else if (marketAnalysis.volatility === "low") {
            qty *= 1.2; // Increase position size in low volatility
            console.log("📈 Low volatility - increasing position size by 20%");
        } else if (marketAnalysis.volatility === "extreme") {
            qty *= 0.5; // Drastically reduce in extreme volatility
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

const logSignal = (type, entry, tp, sl, status, pnl = null, reason = "", volatility = "", marketCondition = "", rrRatio = "") => {
    const timestamp = new Date().toISOString();
    const entryStr = entry !== null && entry !== undefined ? formatPrice(entry) : "";
    const tpStr = tp !== null && tp !== undefined ? formatPrice(tp) : "";
    const slStr = sl !== null && sl !== undefined ? formatPrice(sl) : "";
    const pnlStr = pnl !== null && isFinite(pnl) ? Number(pnl).toFixed(6) : "";
    
    const line = `${timestamp},${db.pair},${type},${entryStr},${tpStr},${slStr},${status},${pnlStr},${reason},${volatility},${marketCondition},${rrRatio}\n`;
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

// -------------------- ADVANCED MARKET ANALYSIS --------------------
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

const calculateEnhancedLevels = (highs, lows, closes, currentPrice) => {
    if (highs.length < 20 || lows.length < 20) {
        // Fallback levels if insufficient data
        const atr = marketAnalysis.atr || (currentPrice * 0.02);
        return {
            majorResistance: currentPrice + (atr * 2),
            majorSupport: currentPrice - (atr * 2),
            immediateResistance: currentPrice + (atr * 1),
            immediateSupport: currentPrice - (atr * 1),
            fibLevels: {
                resistance1: currentPrice + (atr * 1.5),
                resistance2: currentPrice + (atr * 2.5),
                support1: currentPrice - (atr * 1.5),
                support2: currentPrice - (atr * 2.5)
            }
        };
    }
    
    // Use multiple timeframe analysis
    const pivotHigh = Math.max(...highs.slice(-20));
    const pivotLow = Math.min(...lows.slice(-20));
    
    // Dynamic support/resistance based on recent price action
    const recentHigh = Math.max(...highs.slice(-10));
    const recentLow = Math.min(...lows.slice(-10));
    
    // Fibonacci levels for more realistic targets
    const range = recentHigh - recentLow;
    const fibLevels = {
        resistance1: currentPrice + range * 0.382,
        resistance2: currentPrice + range * 0.618,
        support1: currentPrice - range * 0.382,
        support2: currentPrice - range * 0.618
    };
    
    return {
        majorResistance: pivotHigh,
        majorSupport: pivotLow,
        immediateResistance: recentHigh,
        immediateSupport: recentLow,
        fibLevels
    };
};

const analyzeSignal = async () => {
    console.log("🧠 Advanced Technical analysis started...");
    
    try {
        // Fetch multiple timeframe data
        const [ohlcv15m, ohlcv1h] = await Promise.all([
            withRetry(() => exchange.fetchOHLCV(db.pair, "15m", undefined, 100), "Fetch OHLCV 15m"),
            withRetry(() => exchange.fetchOHLCV(db.pair, "1h", undefined, 50), "Fetch OHLCV 1h")
        ]);
        
        if (!ohlcv15m || ohlcv15m.length < 50 || !ohlcv1h || ohlcv1h.length < 20) {
            console.warn("⚠️ Insufficient OHLCV data");
            return {};
        }

        const close15m = ohlcv15m.map(c => c[4]);
        const high15m = ohlcv15m.map(c => c[2]);
        const low15m = ohlcv15m.map(c => c[3]);
        const price = close15m[close15m.length - 1];

        // Analyze market conditions
        marketAnalysis = analyzeMarketConditions(ohlcv15m);
        
        // Multi-timeframe trend analysis
        const close1h = ohlcv1h.map(c => c[4]);
        
        const ema9_15m = EMA.calculate({ period: 9, values: close15m });
        const ema21_15m = EMA.calculate({ period: 21, values: close15m });
        const ema50_15m = EMA.calculate({ period: 50, values: close15m });
        const ema9_1h = EMA.calculate({ period: 9, values: close1h });
        const ema21_1h = EMA.calculate({ period: 21, values: close1h });
        
        const rsi15m = RSI.calculate({ period: 14, values: close15m });
        
        // Validate indicator calculations
        if (!ema9_15m || !ema21_15m || !ema50_15m || !rsi15m) {
            console.warn("⚠️ Indicator calculation failed");
            return {};
        }
        
        const currentEma9_15m = ema9_15m[ema9_15m.length - 1];
        const currentEma21_15m = ema21_15m[ema21_15m.length - 1];
        const currentEma50_15m = ema50_15m[ema50_15m.length - 1];
        const currentEma9_1h = ema9_1h ? ema9_1h[ema9_1h.length - 1] : currentEma9_15m;
        const currentEma21_1h = ema21_1h ? ema21_1h[ema21_1h.length - 1] : currentEma21_15m;
        const currentRsi = rsi15m[rsi15m.length - 1];

        // Enhanced trend confirmation
        const isUptrend15m = currentEma9_15m > currentEma21_15m && currentEma21_15m > currentEma50_15m;
        const isDowntrend15m = currentEma9_15m < currentEma21_15m && currentEma21_15m < currentEma50_15m;
        const isUptrend1h = currentEma9_1h > currentEma21_1h;
        const isDowntrend1h = currentEma9_1h < currentEma21_1h;

        // Multi-timeframe alignment
        const trendAlignedLong = isUptrend15m && isUptrend1h;
        const trendAlignedShort = isDowntrend15m && isDowntrend1h;

        // RSI with market condition adjustment
        const rsiOverbought = currentRsi > (marketAnalysis.volatility === "high" ? 65 : 70);
        const rsiOversold = currentRsi < (marketAnalysis.volatility === "high" ? 35 : 30);

        let canLong = false;
        let canShort = false;

        // Enhanced entry logic with multiple confirmations
        if (trendAlignedLong && !rsiOverbought && price > currentEma9_15m) {
            canLong = true;
        }

        if (trendAlignedShort && !rsiOversold && price < currentEma9_15m) {
            canShort = true;
        }

        // Calculate enhanced levels
        const levels = calculateEnhancedLevels(high15m, low15m, close15m, price);
        
        // Dynamic TP/SL based on market conditions and volatility
        const baseDistance = marketAnalysis.atr * CONFIG.atrMultiplier;
        const volatilityMultiplier = marketAnalysis.volatility === "high" ? 1.3 : 
                                   marketAnalysis.volatility === "low" ? 0.7 : 
                                   marketAnalysis.volatility === "extreme" ? 2.0 : 1.0;

        const minDistance = baseDistance * volatilityMultiplier;
        
        // Use Fibonacci levels for more realistic targets
        const targetLong = Math.max(levels.immediateResistance, levels.fibLevels.resistance1, price + minDistance);
        const stopLossLong = Math.min(levels.immediateSupport, levels.fibLevels.support1, price - minDistance);
        const targetShort = Math.min(levels.immediateSupport, levels.fibLevels.support1, price - minDistance);
        const stopLossShort = Math.max(levels.immediateResistance, levels.fibLevels.resistance1, price + minDistance);

        // Enhanced risk/reward validation
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

        console.log(`\n📊 Advanced Market Analysis ${db.pair}
─────────────────────────────────────
📈 Long Signal: ${canLong ? "✅ VALID" : "❌ INVALID"}
📉 Short Signal: ${canShort ? "✅ VALID" : "❌ INVALID"}
─────────────────────────────────────
💰 Current Price: ${formatPrice(price)}
📊 Market Condition: ${marketAnalysis.marketCondition.toUpperCase()}
📈 Volatility: ${marketAnalysis.volatility.toUpperCase()} (${(marketAnalysis.atrRatio * 100).toFixed(2)}%)
📏 ATR: ${formatPrice(marketAnalysis.atr)}
📊 Trend Strength: ${(marketAnalysis.trendStrength * 100).toFixed(2)}%
📊 RSI: ${currentRsi ? currentRsi.toFixed(2) : 'N/A'}
─────────────────────────────────────
🎯 R/R Ratio: LONG ${longRiskReward.toFixed(2)}:1 | SHORT ${shortRiskReward.toFixed(2)}:1
🔄 Multi-TF Alignment: ${trendAlignedLong ? "LONG" : trendAlignedShort ? "SHORT" : "MIXED"}
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
            },
            dataQuality: "GOOD"
        };
        
    } catch (error) {
        console.error("❌ Technical analysis failed:", error.message);
        return {};
    }
};

// -------------------- ENHANCED RISK MANAGEMENT --------------------
const shouldEnterTrade = (signal, positionType) => {
    if (!db.tradingEnabled) {
        console.log("⏸️ Trading temporarily disabled");
        return false;
    }

    // Check market conditions
    if (signal.volatility === "extreme") {
        console.log("⏸️ Extreme volatility, skipping trade");
        return false;
    }

    // Check if we have recent losses (simple drawdown control)
    try {
        if (fs.existsSync(CONFIG.logPath)) {
            const recentLogs = fs.readFileSync(CONFIG.logPath, 'utf8').split('\n').slice(-10);
            const recentLosses = recentLogs.filter(line => 
                line.includes('SL_REALIZED') || line.includes('CLOSE_FAILED')
            ).length;
            
            if (recentLosses >= 3) {
                console.log(`⏸️ ${recentLosses} recent losses, cooling down...`);
                return false;
            }
        }
    } catch (err) {
        console.log("⚠️ Could not check recent performance");
    }

    return true;
};

// -------------------- ENHANCED ORDER MANAGEMENT --------------------
const placeOrder = async (side, tp, sl) => {
    if (!shouldEnterTrade(marketAnalysis, side)) {
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

    const tpPercent = ((Math.abs(tp - price) / price) * 100).toFixed(2);
    const slPercent = ((Math.abs(sl - price) / price) * 100).toFixed(2);

    console.log(`➡️ ENHANCED ENTRY ${side.toUpperCase()}
- Dynamic Quantity: ${qty}
- Entry: ${formatPrice(price)}
- TP: ${formatPrice(tp)} (${tpPercent}%)
- SL: ${formatPrice(sl)} (${slPercent}%)
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
            "",
            marketAnalysis.volatility,
            marketAnalysis.marketCondition,
            rrRatio
        );
        
        // Update balance
        try {
            const balance = await exchange.fetchBalance();
            db.totalBalance = balance.total?.USDT || db.totalBalance;
            saveDB();
        } catch (err) {
            console.warn("⚠️ Could not update balance:", err.message);
        }
        
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
            err.message,
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
                const maxTP = entryPrice * (1 + (CONFIG.maxRiskPerTrade * 5 / 100)); // Max 5x risk as reward
                newTP = Math.min(newTP, maxTP);
                console.log(`📈 Trailing TP up to: ${formatPrice(newTP)}`);
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
                // Don't move SL too close to current price
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
        
        // Use dynamic threshold based on volatility
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
            "",
            marketAnalysis.volatility,
            marketAnalysis.marketCondition,
            rrRatio
        );

    } catch (error) {
        console.error("❌ TP/SL update failed:", error.message);
    }
};

// -------------------- POSITION MONITORING --------------------
const closePosition = async (reason, entryPrice = "N/A") => {
    console.log(`🚨 Closing position: ${reason}`);
    
    try {
        const { position } = await getPositionFromBalance();
        const qty = parseFloat(position?.positionAmt || "0");

        if (!isFinite(qty) || Math.abs(qty) <= CONFIG.minPositionAmount) {
            console.log("ℹ️ No position to close");
            
            // Clean up database even if no position found
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
                    reason,
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

            // Calculate PnL if we have valid data
            if (entryPrice !== "N/A" && db.activePosition && isFinite(exitPrice)) {
                const { side: entrySide, quantity } = db.activePosition;
                const entryNum = Number(entryPrice);
                
                pnl = entrySide === "buy" ? 
                    (exitPrice - entryNum) * quantity : 
                    (entryNum - exitPrice) * quantity;
                
                // Update performance metrics
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
                reason,
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
            err.message,
            db.activePosition?.volatility,
            db.activePosition?.marketCondition,
            rrRatio
        );
    } finally {
        db.activePosition = null;
        saveDB();
        
        // Update balance after closing position
        try {
            const balance = await exchange.fetchBalance();
            db.totalBalance = balance.total?.USDT || db.totalBalance;
            saveDB();
        } catch (err) {
            console.warn("⚠️ Could not update balance after close:", err.message);
        }
    }
};

const checkPositionStatus = async () => {
    try {
        const { position } = await getPositionFromBalance();
        const amt = parseFloat(position?.positionAmt || "0");
        const amtSafe = isFinite(amt) ? amt : 0;

        // Handle position closure detection
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
                "External closure",
                db.activePosition.volatility,
                db.activePosition.marketCondition,
                rrRatio
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
                "Auto-recovery",
                signal.volatility,
                signal.marketCondition,
                rrRatio
            );
        }
        
        // Cleanup needed: Database has position but exchange doesn't
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
                "Orphan cleanup",
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
        console.log(`\n⏰ Cycle started: ${now.toLocaleString()}`);
        
        await recoverPositionState();
        await checkPositionStatus();

        console.log("🔍 Enhanced signal analysis...");

        const signal = await analyzeSignal();
        if (!signal.price || signal.dataQuality !== "GOOD") {
            console.log("⏸️ Poor data quality or no signal, skipping");
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

        if (!hasActivePosition && db.tradingEnabled) {
            if (signal.canLong) {
                // Additional confirmation for long entry
                const isGoodLongEntry = signal.price > signal.stopLossLong && 
                                      signal.targetLong > signal.price * 1.005 &&
                                      signal.riskReward.long >= CONFIG.minRiskReward;
                
                if (isGoodLongEntry) {
                    console.log(`🚀 ENHANCED LONG Signal | TP: ${formatPrice(signal.targetLong)} | SL: ${formatPrice(signal.stopLossLong)}`);
                    await placeOrder("buy", signal.targetLong, signal.stopLossLong);
                } else {
                    console.log(`⏸️ LONG Signal: Poor risk/reward (${signal.riskReward.long.toFixed(2)}:1), skipping`);
                }
            } else if (signal.canShort) {
                // Additional confirmation for short entry
                const isGoodShortEntry = signal.price < signal.stopLossShort && 
                                       signal.targetShort < signal.price * 0.995 &&
                                       signal.riskReward.short >= CONFIG.minRiskReward;
                
                if (isGoodShortEntry) {
                    console.log(`📉 ENHANCED SHORT Signal | TP: ${formatPrice(signal.targetShort)} | SL: ${formatPrice(signal.stopLossShort)}`);
                    await placeOrder("sell", signal.targetShort, signal.stopLossShort);
                } else {
                    console.log(`⏸️ SHORT Signal: Poor risk/reward (${signal.riskReward.short.toFixed(2)}:1), skipping`);
                }
            } else {
                console.log("💤 No valid enhanced signals, waiting...");
            }
        }
        
        // Show performance periodically
        if (Math.random() < 0.1) { // 10% chance each cycle
            showPerformance();
        }
    } catch (err) {
        console.error("⚠️ Main loop error:", err.message);
        
        // Circuit breaker for repeated errors
        if (err.message.includes('rate limit') || err.message.includes('busy')) {
            console.log('🚦 Circuit breaker: Increasing interval temporarily');
            await new Promise(resolve => setTimeout(resolve, CONFIG.checkInterval * 2));
        }
    } finally {
        isProcessing = false;
        console.log(`♻️ Cycle completed in ${(new Date() - startTime) / 1000}s\n`);
    }
};

// Start the enhanced bot
console.log("\n🤖 Enhanced Crypto Trading Bot Started!");
console.log("📊 Features: Multi-timeframe analysis, Dynamic position sizing, Market condition adaptation");
console.log("⚡ Risk Management: Dynamic volatility adjustment, Portfolio risk control");
console.log("🔧 Technical: EMA/RSI/ATR analysis, Fibonacci levels, Trend confirmation\n");

let startTime = new Date();
mainLoop(); // Run immediately once
setInterval(() => {
    startTime = new Date();
    mainLoop();
}, CONFIG.checkInterval);

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

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});
