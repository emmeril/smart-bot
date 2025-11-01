// signal.js (Advanced Multi-Timeframe & Momentum Confirmation Version)
require("dotenv").config();
const fs = require("fs");
const ccxt = require("ccxt");
const { SMA, RSI, EMA, MACD, Stochastic, OBV, WilliamsR, CCI, MFI, ATR } = require("technicalindicators");

// -------------------- CONFIG --------------------
const dbPath = "./db.json";
const logPath = "./log.csv";
let isProcessing = false;
let exchange = null;
let connectionRetries = 0;
const MAX_RETRIES = 5;
const RETRY_DELAY = 10000;

// -------------------- SIGNAL CONFIRMATION SYSTEM --------------------
let signalConfirmation = {
    pendingReversal: false,
    reversalDirection: null,
    confirmationCount: 0,
    requiredConfirmations: 2,
    firstSignalTime: null,
    lastSignalPrice: null,
    signalsHistory: []
};

// -------------------- MULTI TIMEFRAME ANALYSIS --------------------
const analyzeMultiTimeframe = async () => {
    console.log("⏰ Multi-timeframe analysis started...");
    
    try {
        const timeframes = ['5m', '15m', '1h'];
        const results = {};
        
        for (const tf of timeframes) {
            const ohlcv = await safeApiCall(exchange.fetchOHLCV, db.pair, tf, undefined, 100);
            if (!ohlcv || ohlcv.length < 50) continue;
            
            const close = ohlcv.map(c => c[4]);
            const high = ohlcv.map(c => c[2]);
            const low = ohlcv.map(c => c[3]);
            const volume = ohlcv.map(c => c[5]);
            
            // Technical indicators for each timeframe
            const rsi = RSI.calculate({ values: close, period: 14 });
            const maFast = SMA.calculate({ values: close, period: 9 });
            const maSlow = SMA.calculate({ values: close, period: 21 });
            const macd = MACD.calculate({
                values: close,
                fastPeriod: 12,
                slowPeriod: 26,
                signalPeriod: 9
            });
            
            const currentRSI = rsi[rsi.length - 1];
            const currentMAFast = maFast[maFast.length - 1];
            const currentMASlow = maSlow[maSlow.length - 1];
            const currentMACD = macd[macd.length - 1];
            
            // Trend analysis
            const trend = currentMAFast > currentMASlow ? 'bullish' : 'bearish';
            const momentum = currentMACD && currentMACD.histogram > 0 ? 'bullish' : 'bearish';
            const rsiStrength = currentRSI > 50 ? 'bullish' : 'bearish';
            
            results[tf] = {
                trend,
                momentum,
                rsiStrength,
                rsi: currentRSI,
                maFast: currentMAFast,
                maSlow: currentMASlow,
                macdHistogram: currentMACD ? currentMACD.histogram : 0
            };
        }
        
        return results;
    } catch (error) {
        console.error("❌ Multi-timeframe analysis failed:", error.message);
        return {};
    }
};

// -------------------- MOMENTUM ACCELERATION DETECTION --------------------
const detectMomentumAcceleration = async (priceData) => {
    try {
        const { close, high, low, volume } = priceData;
        
        // Velocity Calculation (Rate of Change)
        const roc5 = ((close[close.length - 1] - close[close.length - 6]) / close[close.length - 6]) * 100;
        const roc10 = ((close[close.length - 1] - close[close.length - 11]) / close[close.length - 11]) * 100;
        
        // Acceleration (Change in ROC)
        const acceleration = roc5 - roc10;
        
        // Volume Momentum
        const volumeSMA = SMA.calculate({ values: volume, period: 20 });
        const currentVolume = volume[volume.length - 1];
        const avgVolume = volumeSMA[volumeSMA.length - 1];
        const volumeRatio = currentVolume / avgVolume;
        
        // Price Velocity (instantaneous momentum)
        const priceVelocity = ((close[close.length - 1] - close[close.length - 3]) / close[close.length - 3]) * 100;
        
        // Momentum Strength Score
        const momentumScore = (
            (Math.abs(roc5) * 0.4) +
            (Math.abs(acceleration) * 0.3) +
            (Math.min(volumeRatio, 3) * 0.2) + // Cap volume ratio at 3x
            (Math.abs(priceVelocity) * 0.1)
        );
        
        const isAcceleratingUp = acceleration > 0.1 && roc5 > 0.2 && priceVelocity > 0.05;
        const isAcceleratingDown = acceleration < -0.1 && roc5 < -0.2 && priceVelocity < -0.05;
        
        return {
            acceleration,
            roc5,
            roc10,
            volumeRatio,
            priceVelocity,
            momentumScore,
            isAcceleratingUp,
            isAcceleratingDown,
            strength: momentumScore
        };
    } catch (error) {
        console.error("❌ Momentum detection failed:", error.message);
        return {};
    }
};

// -------------------- ADVANCED MOMENTUM INDICATORS --------------------
const calculateAdvancedMomentum = (priceData) => {
    const { close, high, low, volume } = priceData;
    
    // Williams %R
    const williamsR = WilliamsR.calculate({
        high: high.slice(-14),
        low: low.slice(-14),
        close: close.slice(-14),
        period: 14
    });
    
    // CCI (Commodity Channel Index)
    const cci = CCI.calculate({
        high: high.slice(-20),
        low: low.slice(-20),
        close: close.slice(-20),
        period: 20
    });
    
    // MFI (Money Flow Index)
    const mfi = MFI.calculate({
        high: high.slice(-14),
        low: low.slice(-14),
        close: close.slice(-14),
        volume: volume.slice(-14),
        period: 14
    });
    
    // OBV (On Balance Volume)
    const obv = OBV.calculate({
        close: close.slice(-30),
        volume: volume.slice(-30)
    });
    
    const currentWilliamsR = williamsR[williamsR.length - 1];
    const currentCCI = cci[cci.length - 1];
    const currentMFI = mfi[mfi.length - 1];
    const currentOBV = obv[obv.length - 1];
    const prevOBV = obv[obv.length - 2];
    
    // Momentum Consensus
    const bullishSignals = [
        currentWilliamsR < -20, // Not overbought
        currentCCI > 0,         // Bullish CCI
        currentMFI > 50,        // Bullish money flow
        currentOBV > prevOBV    // Rising OBV
    ].filter(Boolean).length;
    
    const bearishSignals = [
        currentWilliamsR > -80, // Not oversold
        currentCCI < 0,         // Bearish CCI
        currentMFI < 50,        // Bearish money flow
        currentOBV < prevOBV    // Falling OBV
    ].filter(Boolean).length;
    
    return {
        williamsR: currentWilliamsR,
        cci: currentCCI,
        mfi: currentMFI,
        obv: currentOBV,
        obvTrend: currentOBV > prevOBV ? 'rising' : 'falling',
        momentumConsensus: {
            bullish: bullishSignals,
            bearish: bearishSignals,
            totalSignals: 4
        }
    };
};

// -------------------- SMART SIGNAL VALIDATION --------------------
const validateSignalWithAdvancedFilters = async (baseSignal) => {
    console.log("🔍 Advanced signal validation started...");
    
    try {
        const multiTF = await analyzeMultiTimeframe();
        const momentum = await detectMomentumAcceleration(baseSignal.priceData);
        const advancedMomentum = calculateAdvancedMomentum(baseSignal.priceData);
        
        // Multi-timeframe consensus
        const tfBullish = Object.values(multiTF).filter(tf => 
            tf.trend === 'bullish' && tf.momentum === 'bullish'
        ).length;
        
        const tfBearish = Object.values(multiTF).filter(tf => 
            tf.trend === 'bearish' && tf.momentum === 'bearish'
        ).length;
        
        const multiTFStrength = tfBullish - tfBearish;
        
        // Momentum filters
        const momentumStrength = momentum.strength || 0;
        const isStrongMomentum = momentumStrength > 0.5;
        
        // Advanced momentum consensus
        const momentumBullish = advancedMomentum.momentumConsensus.bullish;
        const momentumBearish = advancedMomentum.momentumConsensus.bearish;
        const momentumScore = momentumBullish - momentumBearish;
        
        // Final validation scores
        const longValidationScore = (
            (multiTFStrength * 0.4) +
            (momentumScore * 0.3) +
            (isStrongMomentum && momentum.isAcceleratingUp ? 0.3 : 0)
        );
        
        const shortValidationScore = (
            (multiTFStrength * -0.4) +
            (momentumScore * -0.3) +
            (isStrongMomentum && momentum.isAcceleratingDown ? 0.3 : 0)
        );
        
        const isValidLong = baseSignal.canLong && longValidationScore >= db.advancedFeatures.minValidationScore;
        const isValidShort = baseSignal.canShort && shortValidationScore >= db.advancedFeatures.minValidationScore;
        
        console.log(`🎯 Advanced Validation Results:
   MultiTF Strength: ${multiTFStrength}
   Momentum Score: ${momentumScore}
   Momentum Strength: ${momentumStrength.toFixed(3)}
   Long Validation: ${longValidationScore.toFixed(3)} ${isValidLong ? '✅' : '❌'}
   Short Validation: ${shortValidationScore.toFixed(3)} ${isValidShort ? '✅' : '❌'}`);
        
        return {
            ...baseSignal,
            canLong: isValidLong,
            canShort: isValidShort,
            validationScores: {
                long: longValidationScore,
                short: shortValidationScore,
                multiTF: multiTFStrength,
                momentum: momentumScore,
                acceleration: momentumStrength
            },
            multiTimeframe: multiTF,
            momentumData: momentum,
            advancedMomentum: advancedMomentum
        };
        
    } catch (error) {
        console.error("❌ Advanced validation failed:", error.message);
        return baseSignal;
    }
};

// -------------------- CONNECTION MANAGEMENT --------------------
const initializeExchange = async () => {
    try {
        if (exchange) {
            try {
                await exchange.fetchBalance();
                return exchange;
            } catch (e) {
                console.log("🔄 Connection lost, reinitializing...");
            }
        }

        exchange = new ccxt.binance({
            apiKey: process.env.API_KEY,
            secret: process.env.API_SECRET,
            options: { defaultType: "future" },
            timeout: 30000,
            enableRateLimit: true,
            recvWindow: 60000,
        });

        await exchange.loadMarkets();
        await exchange.fetchBalance();

        console.log("✅ Exchange connection initialized successfully");
        connectionRetries = 0;
        return exchange;
    } catch (error) {
        console.error(`❌ Exchange initialization failed (attempt ${connectionRetries + 1}/${MAX_RETRIES}):`, error.message);

        if (connectionRetries < MAX_RETRIES) {
            connectionRetries++;
            console.log(`🔄 Retrying in ${RETRY_DELAY/1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            return initializeExchange();
        } else {
            console.error("💥 Maximum connection retries reached. Please check your network and API credentials.");
            throw error;
        }
    }
};

// -------------------- FILE INIT --------------------
if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, "timestamp,pair,type,entry,tp,sl,status,pnl\n");
    console.log("📝 Log file created: log.csv");
}

const loadDB = () => {
    try {
        if (fs.existsSync(dbPath)) {
            return JSON.parse(fs.readFileSync(dbPath));
        }
    } catch (error) {
        console.warn("⚠️ Failed to load DB, using default config:", error.message);
    }

    return {
        pair: "XRP/USDT:USDT",
        lastLongEntryTime: 0,
        lastShortEntryTime: 0,
        leverage: 10,
        marginMode: "ISOLATED",
        activePosition: null,
        usdtPerTrade: 5.1,
        useDynamicPositionSizing: true,
        positionSizePercentage: 90,
        signalConfirmation: {
            enabled: true,
            requiredConfirmations: 2,
            maxConfirmationTime: 300000
        },
        advancedFeatures: {
            multiTimeframeAnalysis: true,
            momentumAcceleration: true,
            advancedValidation: true,
            minValidationScore: 0.3
        }
    };
};

let db = loadDB();

// -------------------- SIGNAL CONFIRMATION MANAGEMENT --------------------
const updateSignalConfirmation = (newDirection, currentPrice) => {
    const now = Date.now();
    
    if (signalConfirmation.reversalDirection !== newDirection) {
        signalConfirmation = {
            pendingReversal: true,
            reversalDirection: newDirection,
            confirmationCount: 1,
            requiredConfirmations: db.signalConfirmation.requiredConfirmations,
            firstSignalTime: now,
            lastSignalPrice: currentPrice,
            signalsHistory: [{
                direction: newDirection,
                price: currentPrice,
                timestamp: now
            }]
        };
        console.log(`🔄 New reversal signal detected: ${newDirection.toUpperCase()} | Confirmations: 1/${signalConfirmation.requiredConfirmations}`);
        return false;
    }
    
    signalConfirmation.confirmationCount++;
    signalConfirmation.lastSignalPrice = currentPrice;
    signalConfirmation.signalsHistory.push({
        direction: newDirection,
        price: currentPrice,
        timestamp: now
    });
    
    console.log(`🔄 Reversal signal confirmed: ${newDirection.toUpperCase()} | Confirmations: ${signalConfirmation.confirmationCount}/${signalConfirmation.requiredConfirmations}`);
    
    if (signalConfirmation.confirmationCount >= signalConfirmation.requiredConfirmations) {
        console.log(`✅ REVERSAL CONFIRMED: ${newDirection.toUpperCase()} - Proceeding with position change`);
        return true;
    }
    
    if (now - signalConfirmation.firstSignalTime > db.signalConfirmation.maxConfirmationTime) {
        console.log(`⏰ Reversal confirmation timeout - Resetting confirmation system`);
        resetSignalConfirmation();
        return false;
    }
    
    return false;
};

const resetSignalConfirmation = () => {
    signalConfirmation = {
        pendingReversal: false,
        reversalDirection: null,
        confirmationCount: 0,
        requiredConfirmations: db.signalConfirmation.requiredConfirmations,
        firstSignalTime: null,
        lastSignalPrice: null,
        signalsHistory: []
    };
};

const checkSignalConsistency = () => {
    if (signalConfirmation.signalsHistory.length < 2) return true;
    
    const recentSignals = signalConfirmation.signalsHistory.slice(-3);
    const directions = recentSignals.map(s => s.direction);
    const allSameDirection = directions.every(d => d === directions[0]);
    
    if (!allSameDirection) {
        console.log("⚠️ Signal inconsistency detected - Resetting confirmation");
        resetSignalConfirmation();
        return false;
    }
    
    return true;
};

// -------------------- DYNAMIC POSITION SIZING --------------------
const calculateDynamicPositionSize = async () => {
    try {
        if (!db.useDynamicPositionSizing) {
            console.log(`⚙️ Using fixed position size: ${db.usdtPerTrade} USDT`);
            return db.usdtPerTrade;
        }

        const balance = await safeApiCall(exchange.fetchBalance);
        const totalUSDT = balance.total?.USDT || 0;
        
        if (totalUSDT <= 0) {
            console.warn("⚠️ Balance is zero or negative, using fixed position size");
            return db.usdtPerTrade;
        }

        const dynamicSize = totalUSDT * (db.positionSizePercentage / 100);
        
        const minTradeSize = 1;
        const finalSize = Math.max(dynamicSize, minTradeSize);
        
        console.log(`💰 Dynamic Position Sizing:
   Total Balance: ${totalUSDT.toFixed(2)} USDT
   Percentage: ${db.positionSizePercentage}%
   Calculated Size: ${finalSize.toFixed(2)} USDT`);

        return finalSize;
    } catch (error) {
        console.error("❌ Failed to calculate dynamic position size, using fixed:", error.message);
        return db.usdtPerTrade;
    }
};

console.log(`⚙️ Bot Configuration:
- Pair: ${db.pair}
- Leverage: ${db.leverage}x
- Margin Mode: ${db.marginMode}
- Position Sizing: ${db.useDynamicPositionSizing ? `Dynamic (${db.positionSizePercentage}% of balance)` : `Fixed (${db.usdtPerTrade} USDT)`}
- Signal Confirmation: ${db.signalConfirmation.enabled ? `Enabled (${db.signalConfirmation.requiredConfirmations} confirmations)` : 'Disabled'}
- Advanced Features: ${db.advancedFeatures.advancedValidation ? 'Enabled' : 'Disabled'}`);

// -------------------- STABLE API CALLS --------------------
const safeApiCall = async (apiFunction, ...args) => {
    try {
        if (!exchange) {
            await initializeExchange();
        }
        return await apiFunction.call(exchange, ...args);
    } catch (error) {
        if (error instanceof ccxt.NetworkError || error.message.includes('network') || error.message.includes('timeout')) {
            console.log("🌐 Network issue detected, reinitializing connection...");
            await initializeExchange();
            return await apiFunction.call(exchange, ...args);
        }
        throw error;
    }
};

// -------------------- UTIL FUNCTIONS --------------------
const saveDB = () => {
    try {
        if (db.activePosition) {
            db.activePosition.entryPrice = formatPrice(db.activePosition.entryPrice);
            db.activePosition.tp = formatPrice(db.activePosition.tp);
            db.activePosition.sl = formatPrice(db.activePosition.sl);
        }
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
    } catch (error) {
        console.error("❌ Failed to save DB:", error.message);
    }
};

const formatPrice = (price, pair = db.pair) => {
    if (!price || !isFinite(price)) return "N/A";

    try {
        const market = exchange.markets[pair];
        if (!market) return parseFloat(price.toFixed(5));

        let decimals = market.precision?.price;

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

        decimals = Math.max(0, Math.min(8, parseInt(decimals) || 5));
        return parseFloat(price.toFixed(decimals));

    } catch (err) {
        return parseFloat(price.toFixed(5));
    }
};

// -------------------- BALANCE DISPLAY FUNCTION --------------------
const displayBalance = async () => {
    try {
        const balance = await safeApiCall(exchange.fetchBalance);
        const totalUSDT = balance.total?.USDT || 0;
        const freeUSDT = balance.free?.USDT || 0;
        const usedUSDT = balance.used?.USDT || 0;
        
        console.log(`💰 Balance Summary:
   Total: ${totalUSDT.toFixed(2)} USDT
   Free: ${freeUSDT.toFixed(2)} USDT
   Used: ${usedUSDT.toFixed(2)} USDT`);
        
        return { totalUSDT, freeUSDT, usedUSDT };
    } catch (error) {
        console.error("❌ Failed to fetch balance:", error.message);
        return null;
    }
};

const getPrice = async () => {
    try {
        const ticker = await safeApiCall(exchange.fetchTicker, db.pair);
        console.log(`💰 Price ${db.pair}: ${formatPrice(ticker.last)}`);
        return ticker.last;
    } catch (err) {
        console.error("❌ Failed to fetch price:", err.message);
        return null;
    }
};

const calcQty = async (price) => {
    if (!price) return 0;
    
    const currentUsdtPerTrade = await calculateDynamicPositionSize();
    
    let qty = currentUsdtPerTrade / price;
    const prec = exchange.markets[db.pair]?.precision?.amount ?? 3;
    qty = parseFloat(qty.toFixed(prec));
    console.log(`📐 Quantity: ${qty} (${currentUsdtPerTrade.toFixed(2)} USDT)`);
    return qty;
};

const logSignal = (type, entry, tp, sl, status, pnl = null) => {
    try {
        const entryStr = entry !== undefined && entry !== null ? entry : "";
        const tpStr = tp !== undefined && tp !== null ? tp : "";
        const slStr = sl !== undefined && sl !== null ? sl : "";
        const pnlStr = pnl !== null && isFinite(pnl) ? Number(pnl).toFixed(6) : "";
        const line = `${new Date().toISOString()},${db.pair},${type},${entryStr},${tpStr},${slStr},${status},${pnlStr}\n`;
        fs.appendFileSync(logPath, line);
        console.log("📝 Signal logged to CSV");
    } catch (error) {
        console.error("❌ Failed to log signal:", error.message);
    }
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
        const balance = await safeApiCall(exchange.fetchBalance);
        const marketId = getMarketId();
        const positions = balance.info?.positions || [];

        const normalize = (str) => (str || "").toString().replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
        const found = positions.find(p =>
            normalize(p.symbol) === normalize(marketId) ||
            normalize(p.contractCode) === normalize(marketId)
        );

        return {
            balance,
            position: found
        };
    } catch (err) {
        console.error("❌ Failed to fetch position:", err.message);
        return {
            balance: null,
            position: null
        };
    }
};

// -------------------- ENHANCED SUPPORT & RESISTANCE DETECTION --------------------
const findEnhancedLevels = (high, low, close, volume, price) => {
    console.log("🔍 Starting enhanced S/R detection...");
    
    const detectDynamicLevels = () => {
        const levels = {
            strongResistance: [],
            strongSupport: [],
            weakResistance: [],
            weakSupport: []
        };

        const timeframes = [
            { period: 15, weight: 1.0, name: "very_short" },
            { period: 30, weight: 1.3, name: "short" },
            { period: 50, weight: 1.6, name: "medium" },
            { period: 75, weight: 2.0, name: "long" }
        ];

        timeframes.forEach(tf => {
            const sliceIndex = Math.max(0, high.length - tf.period);
            const highSlice = high.slice(sliceIndex);
            const lowSlice = low.slice(sliceIndex);
            const closeSlice = close.slice(sliceIndex);
            const volumeSlice = volume.slice(sliceIndex);

            for (let i = 3; i < highSlice.length - 3; i++) {
                if (highSlice[i] > highSlice[i-1] && highSlice[i] > highSlice[i-2] &&
                    highSlice[i] > highSlice[i+1] && highSlice[i] > highSlice[i+2] &&
                    highSlice[i] === Math.max(...highSlice.slice(i-2, i+3))) {
                    
                    const levelStrength = tf.weight * 
                        (1 + (volumeSlice[i] / Math.max(1, Math.max(...volumeSlice))) * 
                        (1 + (i / highSlice.length)));

                    const level = {
                        price: highSlice[i],
                        strength: levelStrength,
                        timeframe: tf.name,
                        touches: 1,
                        recency: i
                    };
                    
                    for (let j = i + 1; j < Math.min(i + 15, highSlice.length); j++) {
                        if (Math.abs(highSlice[j] - highSlice[i]) / highSlice[i] < 0.0015) {
                            level.touches++;
                            level.strength += 0.3;
                        }
                    }
                    
                    if (level.touches >= 1 && level.strength > 1.5) {
                        levels.strongResistance.push(level);
                    } else {
                        levels.weakResistance.push(level);
                    }
                }

                if (lowSlice[i] < lowSlice[i-1] && lowSlice[i] < lowSlice[i-2] &&
                    lowSlice[i] < lowSlice[i+1] && lowSlice[i] < lowSlice[i+2] &&
                    lowSlice[i] === Math.min(...lowSlice.slice(i-2, i+3))) {
                    
                    const levelStrength = tf.weight * 
                        (1 + (volumeSlice[i] / Math.max(1, Math.max(...volumeSlice))) * 
                        (1 + (i / lowSlice.length)));

                    const level = {
                        price: lowSlice[i],
                        strength: levelStrength,
                        timeframe: tf.name,
                        touches: 1,
                        recency: i
                    };
                    
                    for (let j = i + 1; j < Math.min(i + 15, lowSlice.length); j++) {
                        if (Math.abs(lowSlice[j] - lowSlice[i]) / lowSlice[i] < 0.0015) {
                            level.touches++;
                            level.strength += 0.3;
                        }
                    }
                    
                    if (level.touches >= 1 && level.strength > 1.5) {
                        levels.strongSupport.push(level);
                    } else {
                        levels.weakSupport.push(level);
                    }
                }
            }
        });

        return levels;
    };

    const calculateDynamicFibonacci = () => {
        const recentHigh = Math.max(...high.slice(-30));
        const recentLow = Math.min(...low.slice(-30));
        const range = recentHigh - recentLow;

        return {
            fib236: recentHigh - range * 0.236,
            fib382: recentHigh - range * 0.382,
            fib500: recentHigh - range * 0.500,
            fib618: recentHigh - range * 0.618,
            fib786: recentHigh - range * 0.786
        };
    };

    const calculateEnhancedVolumeProfile = () => {
        const priceLevels = {};
        const range = Math.max(...high.slice(-30)) - Math.min(...low.slice(-30));
        const bucketSize = range / 15;

        for (let i = Math.max(0, close.length - 100); i < close.length; i++) {
            const bucket = Math.floor(close[i] / bucketSize) * bucketSize;
            if (!priceLevels[bucket]) {
                priceLevels[bucket] = { volume: 0, count: 0 };
            }
            priceLevels[bucket].volume += volume[i];
            priceLevels[bucket].count++;
        }

        const highVolumeLevels = Object.entries(priceLevels)
            .filter(([_, data]) => data.volume > Math.max(...Object.values(priceLevels).map(d => d.volume)) * 0.6)
            .map(([price, data]) => ({
                price: parseFloat(price),
                volume: data.volume,
                strength: data.volume / Math.max(...Object.values(priceLevels).map(d => d.volume))
            }))
            .sort((a, b) => b.volume - a.volume);

        return {
            pointOfControl: highVolumeLevels[0]?.price || price,
            highVolumeNodes: highVolumeLevels.slice(0, 8)
        };
    };

    const detectTrendStructure = () => {
        const structure = {
            higherHighs: [],
            lowerLows: [],
            consolidationZones: []
        };

        for (let i = 8; i < high.length - 4; i++) {
            const windowHigh = high.slice(i - 4, i + 4);
            const windowLow = low.slice(i - 4, i + 4);
            
            if (high[i] === Math.max(...windowHigh)) {
                structure.higherHighs.push({
                    price: high[i],
                    index: i
                });
            }
            
            if (low[i] === Math.min(...windowLow)) {
                structure.lowerLows.push({
                    price: low[i],
                    index: i
                });
            }
        }

        const priceChanges = [];
        for (let i = 1; i < close.length; i++) {
            priceChanges.push(Math.abs(close[i] - close[i-1]) / close[i-1]);
        }
        
        const volatility = priceChanges.reduce((a, b) => a + b, 0) / priceChanges.length;
        const lowVolatilityThreshold = volatility * 0.4;

        for (let i = 15; i < close.length - 8; i++) {
            const recentVolatility = priceChanges.slice(i - 8, i).reduce((a, b) => a + b, 0) / 8;
            if (recentVolatility < lowVolatilityThreshold) {
                const zoneHigh = Math.max(...high.slice(i - 8, i));
                const zoneLow = Math.min(...low.slice(i - 8, i));
                
                if ((zoneHigh - zoneLow) / zoneLow < volatility * 1.5) {
                    structure.consolidationZones.push({
                        high: zoneHigh,
                        low: zoneLow,
                        midpoint: (zoneHigh + zoneLow) / 2
                    });
                }
            }
        }

        return structure;
    };

    const dynamicLevels = detectDynamicLevels();
    const fibLevels = calculateDynamicFibonacci();
    const volumeProfile = calculateEnhancedVolumeProfile();
    const trendStructure = detectTrendStructure();

    const calculateOptimalLevels = () => {
        const resistanceCandidates = [];
        const supportCandidates = [];

        [...dynamicLevels.strongResistance, ...dynamicLevels.weakResistance].forEach(level => {
            const score = level.strength * (level.touches > 1 ? 1.8 : 1.0) * (1 + (level.recency / 100));
            resistanceCandidates.push({
                price: level.price,
                confidence: score,
                source: `pivot_${level.timeframe}`,
                touches: level.touches,
                recency: level.recency
            });
        });

        [...dynamicLevels.strongSupport, ...dynamicLevels.weakSupport].forEach(level => {
            const score = level.strength * (level.touches > 1 ? 1.8 : 1.0) * (1 + (level.recency / 100));
            supportCandidates.push({
                price: level.price,
                confidence: score,
                source: `pivot_${level.timeframe}`,
                touches: level.touches,
                recency: level.recency
            });
        });

        Object.entries(fibLevels).forEach(([level, fibPrice]) => {
            const distance = Math.abs(fibPrice - price) / price;
            const fibWeight = distance < 0.02 ? 1.5 : 1.2;
            
            if (fibPrice > price) {
                resistanceCandidates.push({
                    price: fibPrice,
                    confidence: fibWeight,
                    source: `fib_${level}`,
                    touches: 0,
                    recency: 50
                });
            } else {
                supportCandidates.push({
                    price: fibPrice,
                    confidence: fibWeight,
                    source: `fib_${level}`,
                    touches: 0,
                    recency: 50
                });
            }
        });

        volumeProfile.highVolumeNodes.forEach(node => {
            const distance = Math.abs(node.price - price) / price;
            const volumeWeight = node.strength * (distance < 0.015 ? 2.5 : 1.8);
            
            if (node.price > price) {
                resistanceCandidates.push({
                    price: node.price,
                    confidence: volumeWeight,
                    source: 'volume_profile',
                    touches: Math.round(node.strength * 8)
                });
            } else {
                supportCandidates.push({
                    price: node.price,
                    confidence: volumeWeight,
                    source: 'volume_profile',
                    touches: Math.round(node.strength * 8)
                });
            }
        });

        trendStructure.higherHighs.forEach(hh => {
            if (hh.price > price) {
                resistanceCandidates.push({
                    price: hh.price,
                    confidence: 1.4,
                    source: 'trend_structure',
                    touches: 1
                });
            }
        });

        trendStructure.lowerLows.forEach(ll => {
            if (ll.price < price) {
                supportCandidates.push({
                    price: ll.price,
                    confidence: 1.4,
                    source: 'trend_structure',
                    touches: 1
                });
            }
        });

        const filterAndGroupCandidates = (candidates, isResistance) => {
            const groups = [];
            candidates.sort((a, b) => a.price - b.price);
            
            for (const candidate of candidates) {
                let grouped = false;
                for (const group of groups) {
                    const avgPrice = group.reduce((sum, c) => sum + c.price, 0) / group.length;
                    if (Math.abs(candidate.price - avgPrice) / avgPrice < 0.003) {
                        group.push(candidate);
                        grouped = true;
                        break;
                    }
                }
                if (!grouped) {
                    groups.push([candidate]);
                }
            }

            return groups.map(group => {
                return group.reduce((best, current) => {
                    const currentScore = current.confidence * (1 + current.touches * 0.15);
                    const bestScore = best.confidence * (1 + best.touches * 0.15);
                    return currentScore > bestScore ? current : best;
                });
            })
            .filter(candidate => {
                const distance = isResistance ? 
                    (candidate.price - price) / price : 
                    (price - candidate.price) / price;
                return distance >= 0.001 && distance <= 0.04;
            })
            .sort((a, b) => {
                const scoreA = a.confidence * (1 + a.touches * 0.15);
                const scoreB = b.confidence * (1 + b.touches * 0.15);
                return scoreB - scoreA;
            })
            .slice(0, 5);
        };

        const bestResistance = filterAndGroupCandidates(resistanceCandidates, true);
        const bestSupport = filterAndGroupCandidates(supportCandidates, false);

        const optimalResistance = bestResistance.length > 0 ? 
            bestResistance[0].price : price * 1.02;
            
        const optimalSupport = bestSupport.length > 0 ? 
            bestSupport[0].price : price * 0.98;

        return {
            resistance: optimalResistance,
            support: optimalSupport,
            allResistance: bestResistance,
            allSupport: bestSupport,
            volumePOC: volumeProfile.pointOfControl,
            fibLevels: fibLevels,
            trendStructure: trendStructure
        };
    };

    return calculateOptimalLevels();
};

// -------------------- ENHANCED TECHNICAL ANALYSIS --------------------
const analyzeEnhancedSignal = async () => {
    console.log("🧠 Enhanced technical analysis started...");
    try {
        const ohlcv = await safeApiCall(exchange.fetchOHLCV, db.pair, "5m", undefined, 200);
        if (!ohlcv || ohlcv.length < 100) {
            console.warn("⚠️ Insufficient OHLCV data");
            return {};
        }

        const close = ohlcv.map(c => c[4]);
        const high = ohlcv.map(c => c[2]);
        const low = ohlcv.map(c => c[3]);
        const volume = ohlcv.map(c => c[5]);
        const price = close[close.length - 1];

        const priceData = { close, high, low, volume };

        // Basic indicators (existing logic)
        const maFast = SMA.calculate({ values: close.slice(-50), period: 5 });
        const maMedium = SMA.calculate({ values: close.slice(-50), period: 13 });
        const maSlow = SMA.calculate({ values: close.slice(-50), period: 21 });

        const currentMAFast = maFast[maFast.length - 1];
        const currentMAMedium = maMedium[maMedium.length - 1];
        const currentMASlow = maSlow[maSlow.length - 1];

        const prevMAFast = maFast[maFast.length - 2];
        const prevMAMedium = maMedium[maMedium.length - 2];
        const prevMASlow = maSlow[maSlow.length - 2];

        const rsi = RSI.calculate({ values: close.slice(-50), period: 14 });
        const currentRSI = rsi[rsi.length - 1];

        const isUptrend = currentMAFast > currentMAMedium && currentMAMedium > currentMASlow;
        const isDowntrend = currentMAFast < currentMAMedium && currentMAMedium < currentMASlow;

        const isFastCrossAboveMedium = currentMAFast > currentMAMedium && prevMAFast <= prevMAMedium;
        const isFastCrossBelowMedium = currentMAFast < currentMAMedium && prevMAFast >= prevMAMedium;

        const priceAboveAllMAs = price > currentMAFast && price > currentMAMedium && price > currentMASlow;
        const priceBelowAllMAs = price < currentMAFast && price < currentMAMedium && price < currentMASlow;

        let canLong = false;
        let canShort = false;

        if ((isFastCrossAboveMedium || (isUptrend && priceAboveAllMAs)) && 
            currentRSI > 45 && currentRSI < 75) {
            canLong = true;
        }

        if ((isFastCrossBelowMedium || (isDowntrend && priceBelowAllMAs)) && 
            currentRSI < 55 && currentRSI > 25) {
            canShort = true;
        }

        // Enhanced Levels (existing logic)
        const enhancedLevels = findEnhancedLevels(high, low, close, volume, price);
        
        let resistance = enhancedLevels.resistance;
        let support = enhancedLevels.support;

        if (!resistance || !support) {
            console.log("🔄 Enhanced S/R detection failed, using dynamic fallback...");
            const recentHigh = Math.max(...high.slice(-50));
            const recentLow = Math.min(...low.slice(-50));
            
            // Calculate ATR for dynamic levels
            const atr = ATR.calculate({
                high: high.slice(-14),
                low: low.slice(-14),
                close: close.slice(-14),
                period: 14
            });
            const currentATR = atr[atr.length - 1] || (recentHigh - recentLow) * 0.1;
            
            resistance = recentHigh + (currentATR * 0.3);
            support = recentLow - (currentATR * 0.3);
        }

        const atr = ATR.calculate({
            high: high.slice(-14),
            low: low.slice(-14),
            close: close.slice(-14),
            period: 14
        });
        const currentATR = atr[atr.length - 1] || 0;

        const minDistance = currentATR * 0.6;
        const maxDistance = currentATR * 2.5;

        if (resistance - price < minDistance) {
            resistance = price + minDistance;
        }
        if (price - support < minDistance) {
            support = price - minDistance;
        }

        if (resistance - price > maxDistance) {
            resistance = price + maxDistance;
        }
        if (price - support > maxDistance) {
            support = price - maxDistance;
        }

        const targetLong = resistance;
        const stopLossLong = Math.min(support, price - (currentATR * 0.8));
        const targetShort = support;
        const stopLossShort = Math.max(resistance, price + (currentATR * 0.8));

        const baseSignal = {
            canLong,
            canShort,
            targetLong,
            stopLossLong,
            targetShort,
            stopLossShort,
            price,
            enhancedLevels,
            rsi: currentRSI,
            maFast: currentMAFast,
            maMedium: currentMAMedium,
            priceData
        };

        // Apply advanced validation if enabled
        if (db.advancedFeatures.advancedValidation) {
            return await validateSignalWithAdvancedFilters(baseSignal);
        }

        return baseSignal;

    } catch (error) {
        console.error("❌ Enhanced technical analysis failed:", error.message);
        return {};
    }
};

// -------------------- ORDER MANAGEMENT --------------------
const placeOrder = async (side, tp, sl) => {
    console.log("🔍 Checking for active positions...");
    if (db.activePosition) {
        console.log("⚠️ Active position exists, order cancelled");
        return;
    }

    try {
        const { position } = await getPositionFromBalance();
        const amt = parseFloat(position?.positionAmt || "0");
        if (isFinite(amt) && Math.abs(amt) > 0) {
            console.log("⚠️ Active position detected, order cancelled");
            return;
        }
    } catch (err) {
        console.warn("⚠️ Failed to check live position:", err.message);
    }

    const price = await getPrice();
    if (!price) {
        console.log("❌ Failed to get price, order cancelled");
        return;
    }

    const qty = await calcQty(price);
    console.log(`➡️ ENTRY ${side.toUpperCase()}
- Quantity: ${qty}
- Entry: ${formatPrice(price)}
- TP: ${formatPrice(tp)}
- SL: ${formatPrice(sl)}`);

    try {
        await safeApiCall(exchange.setLeverage, db.leverage, db.pair);
        await safeApiCall(exchange.setMarginMode, db.marginMode, db.pair);
        console.log("✅ Leverage and margin mode set");
    } catch (err) {
        console.warn("⚠️ Failed to set leverage/margin:", err.message);
    }

    try {
        const order = await safeApiCall(exchange.createOrder, db.pair, "market", side, qty);
        console.log("✅ Market order created");

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
            "ORDER_PLACED"
        );
    } catch (err) {
        console.error("❌ Order failed:", err.message);
    }
};

const closePosition = async (reason, entryPrice = "N/A") => {
    console.log(`🚨 Closing position: ${reason}`);
    try {
        const { position } = await getPositionFromBalance();
        const qty = parseFloat(position?.positionAmt || "0");

        if (!isFinite(qty) || Math.abs(qty) === 0) {
            console.log("ℹ️ No position to close");
        } else {
            const side = qty > 0 ? "sell" : "buy";
            const amount = Math.abs(qty);

            await safeApiCall(exchange.createOrder, db.pair, "market", side, amount, undefined, {
                reduceOnly: true,
            });
            console.log(`✅ Close order created (${side}, ${amount})`);

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
                            console.warn("⚠️ PNL: Exit price not found");
                            return;
                        }

                        const pnlGross = entrySide === "buy" ?
                            (exitNum - entryNum) :
                            (entryNum - exitNum);
                        pnl = pnlGross * closedQty;
                    }
                } catch (err) {
                    console.warn("⚠️ PNL calculation failed:", err.message);
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
        console.error("❌ Close position failed:", err.message);
    } finally {
        db.activePosition = null;
        saveDB();
        resetSignalConfirmation();
    }
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
            console.log(`📉 ${side} position closed`);
            db.activePosition = null;
            saveDB();
            resetSignalConfirmation();
        }

        if (db.activePosition && amtSafe !== 0) {
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
        const MIN_POSITION_AMOUNT = 0.000001;
        const amtSafe = isFinite(amt) ? amt : 0;

        if (Math.abs(amtSafe) > MIN_POSITION_AMOUNT && !db.activePosition) {
            console.log("⚠️ Position recovery needed");

            const currentPrice = await getPrice();
            if (!currentPrice) return;

            const side = amtSafe > 0 ? "buy" : "sell";
            const entryPrice = parseFloat(position?.entryPrice || currentPrice);
            const leverage = position?.leverage || db.leverage;

            const signal = await analyzeEnhancedSignal();
            let tp, sl;

            if (!signal || !signal.price) {
                console.log("⚠️ Using fallback TP/SL");
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

            const SAFETY_MARGIN = 0.001;
            if (side === "buy") {
                tp = tp * (1 - SAFETY_MARGIN);
                sl = sl * (1 + SAFETY_MARGIN);
            } else {
                tp = tp * (1 + SAFETY_MARGIN);
                sl = sl * (1 - SAFETY_MARGIN);
            }

            if (side === "buy") {
                if (tp <= entryPrice) tp = entryPrice * 1.015;
                if (sl >= entryPrice) sl = entryPrice * 0.995;
            } else {
                if (tp >= entryPrice) tp = entryPrice * 0.985;
                if (sl <= entryPrice) sl = entryPrice * 1.005;
            }

            let rrRatio;
            if (side === "buy") {
                rrRatio = ((tp - entryPrice) / (entryPrice - sl)).toFixed(2);
            } else {
                rrRatio = ((entryPrice - tp) / (sl - entryPrice)).toFixed(2);
            }

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

            console.log("✅ Position recovered");
            console.log(`   ${side.toUpperCase()} | Entry: ${formatPrice(entryPrice)}`);
            console.log(`   TP: ${formatPrice(tp)} | SL: ${formatPrice(sl)}`);
            console.log(`   RR: ${rrRatio} | Leverage: ${leverage}x`);

            logSignal(
                side === "buy" ? "LONG" : "SHORT",
                entryPrice,
                tp,
                sl,
                "POSITION_RECOVERED"
            );
        }

        if (db.activePosition && Math.abs(amtSafe) <= MIN_POSITION_AMOUNT) {
            console.log("⚠️ Position cleanup needed");

            const side = db.activePosition.side === "buy" ? "LONG" : "SHORT";

            logSignal(
                side,
                db.activePosition.entryPrice,
                db.activePosition.tp,
                db.activePosition.sl,
                "CLOSED_EXTERNALLY"
            );

            db.activePosition = null;
            saveDB();
            resetSignalConfirmation();
            console.log("✅ Database cleaned");
        }

        if (db.activePosition && Math.abs(amtSafe) > MIN_POSITION_AMOUNT) {
            const currentPrice = await getPrice();
            if (currentPrice) {
                const { side, entryPrice, tp, sl } = db.activePosition;
                const unrealizedPnl = side === "buy" ? currentPrice - entryPrice : entryPrice - currentPrice;
                const pnlPercent = (unrealizedPnl / entryPrice * 100).toFixed(2);

                let status = "🟢 NORMAL";
                let warning = "";

                if (side === "buy") {
                    if (currentPrice >= tp * 0.998) {
                        status = "🟡 NEAR TP";
                        warning = " - Near Take Profit!";
                    } else if (currentPrice <= sl * 1.002) {
                        status = "🔴 NEAR SL";
                        warning = " - Near Stop Loss!";
                    }
                } else {
                    if (currentPrice <= tp * 1.002) {
                        status = "🟡 NEAR TP";
                        warning = " - Near Take Profit!";
                    } else if (currentPrice >= sl * 0.998) {
                        status = "🔴 NEAR SL";
                        warning = " - Near Stop Loss!";
                    }
                }

                const pnlEmoji = unrealizedPnl >= 0 ? "💹" : "🔻";

                console.log("\n📊 Position Monitor");
                console.log(`   ${side.toUpperCase()} | ${status}${warning}`);
                console.log(`   Entry: ${formatPrice(entryPrice)} | Current: ${formatPrice(currentPrice)}`);
                console.log(`   TP: ${formatPrice(tp)} | SL: ${formatPrice(sl)}`);
                console.log(`   ${pnlEmoji} PnL: ${formatPrice(unrealizedPnl)} (${pnlPercent}%)`);
            }
        }

    } catch (err) {
        console.error("❌ Recovery error:", err.message);
    }
};

// -------------------- CONNECTION HEALTH CHECK --------------------
const healthCheck = async () => {
    try {
        await initializeExchange();
        const balance = await safeApiCall(exchange.fetchBalance);
        const price = await getPrice();

        return {
            healthy: true,
            exchange: 'connected',
            balance: !!balance,
            price: !!price,
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        console.error("❌ Health check failed:", error.message);
        return {
            healthy: false,
            exchange: 'disconnected',
            error: error.message,
            timestamp: new Date().toISOString()
        };
    }
};

// -------------------- REVERSAL SIGNAL MANAGEMENT --------------------
const handleReversalSignal = async (signal) => {
    if (!db.signalConfirmation.enabled) {
        return true;
    }

    const hasBotPosition = db.activePosition !== null;
    if (!hasBotPosition) {
        resetSignalConfirmation();
        return false;
    }

    const currentSide = db.activePosition.side;
    let reversalDirection = null;

    if (currentSide === "buy" && signal.canShort) {
        reversalDirection = "short";
    } else if (currentSide === "sell" && signal.canLong) {
        reversalDirection = "long";
    }

    if (!reversalDirection) {
        if (signalConfirmation.pendingReversal) {
            console.log("🔄 Reversal signal disappeared - Resetting confirmation");
            resetSignalConfirmation();
        }
        return false;
    }

    const isConfirmed = updateSignalConfirmation(reversalDirection, signal.price);
    
    if (!checkSignalConsistency()) {
        return false;
    }

    if (isConfirmed) {
        console.log(`✅ REVERSAL CONFIRMED: Closing ${currentSide.toUpperCase()} and preparing for ${reversalDirection.toUpperCase()}`);
        await closePosition(`Reversal to ${reversalDirection} confirmed`, db.activePosition.entryPrice);
        resetSignalConfirmation();
        return true;
    }

    return false;
};

// -------------------- MAIN LOOP --------------------
let prevPosAmt = 0;

(async () => {
    await initializeExchange();
    
    console.log("\n💰 Initial Account Balance:");
    await displayBalance();
    
    const initialPositionSize = await calculateDynamicPositionSize();
    console.log(`📊 Initial Position Size: ${initialPositionSize.toFixed(2)} USDT`);
    
    console.log("\n🚀 Bot started with ADVANCED MULTI-TIMEFRAME & MOMENTUM DETECTION");
})();

setInterval(async () => {
    const health = await healthCheck();
    if (!health.healthy) {
        console.log("⚠️ Health check failed, skipping cycle...");
        isProcessing = false;
        return;
    }

    try {
        const freshDb = loadDB();
        db.pair = freshDb.pair;
        db.leverage = freshDb.leverage;
        db.marginMode = freshDb.marginMode;
        db.usdtPerTrade = freshDb.usdtPerTrade;
        db.useDynamicPositionSizing = freshDb.useDynamicPositionSizing;
        db.positionSizePercentage = freshDb.positionSizePercentage;
        db.signalConfirmation = freshDb.signalConfirmation;
        db.advancedFeatures = freshDb.advancedFeatures;
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

        console.log("🔍 Checking for new signals...");

        const signal = await analyzeEnhancedSignal();
        if (!signal.price) {
            console.log("⚠️ Invalid signal, waiting...");
            return;
        }

        // Display advanced analysis results
        if (db.advancedFeatures.advancedValidation && signal.validationScores) {
            console.log(`🎯 Signal Validation Scores:
   Long: ${signal.validationScores.long.toFixed(3)} ${signal.canLong ? '✅' : '❌'}
   Short: ${signal.validationScores.short.toFixed(3)} ${signal.canShort ? '✅' : '❌'}
   MultiTF: ${signal.validationScores.multiTF}
   Momentum: ${signal.validationScores.momentum}
   Acceleration: ${signal.validationScores.acceleration.toFixed(3)}`);
        }

        // Handle reversal signals dengan konfirmasi
        const reversalHandled = await handleReversalSignal(signal);
        if (reversalHandled) {
            console.log("🔄 Reversal processed, waiting for next cycle...");
            return;
        }

        // Jika sedang menunggu konfirmasi reversal, skip entry baru
        if (signalConfirmation.pendingReversal) {
            console.log(`⏳ Waiting for reversal confirmation (${signalConfirmation.confirmationCount}/${signalConfirmation.requiredConfirmations})...`);
            return;
        }

        const { position } = await getPositionFromBalance();
        const amt = parseFloat(position?.positionAmt || "0");
        const hasActiveBinancePositionAfterClose = isFinite(amt) && Math.abs(amt) > 0;

        if (db.activePosition === null && !hasActiveBinancePositionAfterClose) {
            if (signal.canLong) {
                const isLongBreakout = signal.price > signal.targetLong;
                if (!isLongBreakout) {
                    console.log(`🚀 LONG Signal | TP: ${formatPrice(signal.targetLong)} | SL: ${formatPrice(signal.stopLossLong)}`);
                    db.lastLongEntryTime = now;
                    saveDB();
                    await placeOrder("buy", signal.targetLong, signal.stopLossLong);
                } else {
                    console.log(`⏸️ LONG Signal: Breakout detected, skipping`);
                }
            } else if (signal.canShort) {
                const isShortBreakout = signal.price < signal.targetShort;
                if (!isShortBreakout) {
                    console.log(`📉 SHORT Signal | TP: ${formatPrice(signal.targetShort)} | SL: ${formatPrice(signal.stopLossShort)}`);
                    db.lastShortEntryTime = now;
                    saveDB();
                    await placeOrder("sell", signal.targetShort, signal.stopLossShort);
                } else {
                    console.log(`⏸️ SHORT Signal: Breakout detected, skipping`);
                }
            } else {
                console.log("💤 No valid signals, waiting...");
            }
        }

        if (Math.floor(Date.now() / 10000) % 5 === 0) {
            console.log("\n💰 Periodic Balance Update:");
            await displayBalance();
            const currentPositionSize = await calculateDynamicPositionSize();
            console.log(`📊 Current Position Size: ${currentPositionSize.toFixed(2)} USDT`);
            
            if (signalConfirmation.pendingReversal) {
                console.log(`🔄 Signal Confirmation: ${signalConfirmation.confirmationCount}/${signalConfirmation.requiredConfirmations} for ${signalConfirmation.reversalDirection.toUpperCase()}`);
            }
        }
    } catch (err) {
        console.error("⚠️ Main loop error:", err.message);
    } finally {
        isProcessing = false;
    }
}, 10000);
