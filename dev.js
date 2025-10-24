// signal.js (Enhanced Speed & Accuracy Version)
require("dotenv").config();
const fs = require("fs");
const ccxt = require("ccxt");
const {
    SMA
} = require("technicalindicators");

// -------------------- CONFIG --------------------
const dbPath = "./db.json";
const logPath = "./log.csv";
let isProcessing = false;
let exchange = null;
let connectionRetries = 0;
const MAX_RETRIES = 5;
const RETRY_DELAY = 10000; // 10 seconds

// -------------------- CONNECTION MANAGEMENT --------------------
const initializeExchange = async () => {
    try {
        if (exchange) {
            try {
                await exchange.fetchBalance();
                return exchange; // Connection is still valid
            } catch (e) {
                console.log("🔄 Connection lost, reinitializing...");
            }
        }

        exchange = new ccxt.binance({
            apiKey: process.env.API_KEY,
            secret: process.env.API_SECRET,
            options: {
                defaultType: "future"
            },
            timeout: 30000,
            enableRateLimit: true,
            recvWindow: 60000,
        });

        // Test connection
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
    };
};

let db = loadDB();

console.log(`⚙️ Bot Configuration:
- Pair: ${db.pair}
- Leverage: ${db.leverage}x
- Margin Mode: ${db.marginMode}
- USDT per Trade: ${db.usdtPerTrade}`);

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
            // Retry once after reconnection
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

const calcQty = (price) => {
    if (!price) return 0;
    let qty = db.usdtPerTrade / price;
    const prec = exchange.markets[db.pair]?.precision?.amount ?? 3;
    qty = parseFloat(qty.toFixed(prec));
    console.log(`📐 Quantity: ${qty} (${db.usdtPerTrade} USDT)`);
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

// -------------------- ATR CALCULATION --------------------
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

// -------------------- ENHANCED SUPPORT & RESISTANCE DETECTION --------------------
const findAdvancedLevels = (high, low, close, volume, price) => {
    console.log("🔍 Starting enhanced S/R detection...");
    
    // OPTIMIZED MULTI-TIMEFRAME ANALYSIS
    const detectMultiTimeframeLevels = () => {
        const levels = {
            strongResistance: [],
            strongSupport: [],
            weakResistance: [],
            weakSupport: []
        };

        // Timeframe yang lebih pendek untuk respons lebih cepat
        const timeframes = [
            { period: 15, weight: 1.2, name: "very_short" },  // 3.75 jam
            { period: 30, weight: 1.5, name: "short" },       // 7.5 jam
            { period: 60, weight: 1.8, name: "medium" }       // 15 jam
        ];

        timeframes.forEach(tf => {
            if (high.length < tf.period) return;
            
            const sliceIndex = Math.max(0, high.length - tf.period);
            const highSlice = high.slice(sliceIndex);
            const lowSlice = low.slice(sliceIndex);
            const volumeSlice = volume.slice(sliceIndex);

            // OPTIMIZED PIVOT DETECTION dengan toleransi lebih longgar
            for (let i = 2; i < highSlice.length - 2; i++) {
                // Resistance detection dengan kriteria lebih sederhana
                if (highSlice[i] >= highSlice[i-1] && highSlice[i] >= highSlice[i-2] &&
                    highSlice[i] >= highSlice[i+1] && highSlice[i] >= highSlice[i+2]) {
                    
                    const level = {
                        price: highSlice[i],
                        strength: tf.weight * (1 + (volumeSlice[i] / (Math.max(...volumeSlice) || 1))),
                        timeframe: tf.name,
                        touches: 1
                    };
                    
                    // Quick touch detection
                    for (let j = Math.max(0, i-10); j < Math.min(i+10, highSlice.length); j++) {
                        if (j !== i && Math.abs(highSlice[j] - highSlice[i]) / highSlice[i] < 0.003) {
                            level.touches++;
                            level.strength += 0.3;
                        }
                    }
                    
                    if (level.touches > 1 || level.strength > 1.5) {
                        levels.strongResistance.push(level);
                    } else {
                        levels.weakResistance.push(level);
                    }
                }

                // Support detection dengan kriteria lebih sederhana
                if (lowSlice[i] <= lowSlice[i-1] && lowSlice[i] <= lowSlice[i-2] &&
                    lowSlice[i] <= lowSlice[i+1] && lowSlice[i] <= lowSlice[i+2]) {
                    
                    const level = {
                        price: lowSlice[i],
                        strength: tf.weight * (1 + (volumeSlice[i] / (Math.max(...volumeSlice) || 1))),
                        timeframe: tf.name,
                        touches: 1
                    };
                    
                    // Quick touch detection
                    for (let j = Math.max(0, i-10); j < Math.min(i+10, lowSlice.length); j++) {
                        if (j !== i && Math.abs(lowSlice[j] - lowSlice[i]) / lowSlice[i] < 0.003) {
                            level.touches++;
                            level.strength += 0.3;
                        }
                    }
                    
                    if (level.touches > 1 || level.strength > 1.5) {
                        levels.strongSupport.push(level);
                    } else {
                        levels.weakSupport.push(level);
                    }
                }
            }
        });

        return levels;
    };

    // SIMPLIFIED FIBONACCI CALCULATION
    const calculateFibonacciLevels = () => {
        const recentHigh = Math.max(...high.slice(-30));
        const recentLow = Math.min(...low.slice(-30));
        const range = recentHigh - recentLow;

        return {
            fib382: recentHigh - range * 0.382,
            fib500: recentHigh - range * 0.500,
            fib618: recentHigh - range * 0.618
        };
    };

    // OPTIMIZED VOLUME PROFILE
    const calculateVolumeProfile = () => {
        const recentPrices = close.slice(-50);
        const recentVolume = volume.slice(-50);
        
        if (recentPrices.length === 0) return { pointOfControl: price, highVolumeNodes: [] };

        const priceMin = Math.min(...recentPrices);
        const priceMax = Math.max(...recentPrices);
        const range = priceMax - priceMin;
        const bucketSize = range / 10 || price * 0.01;

        const priceLevels = {};
        
        for (let i = 0; i < recentPrices.length; i++) {
            const bucket = Math.floor(recentPrices[i] / bucketSize) * bucketSize;
            if (!priceLevels[bucket]) {
                priceLevels[bucket] = { volume: 0, count: 0 };
            }
            priceLevels[bucket].volume += recentVolume[i];
            priceLevels[bucket].count++;
        }

        const highVolumeLevels = Object.entries(priceLevels)
            .map(([price, data]) => ({
                price: parseFloat(price),
                volume: data.volume,
                strength: data.volume / Math.max(...Object.values(priceLevels).map(d => d.volume))
            }))
            .sort((a, b) => b.volume - a.volume)
            .slice(0, 3);

        return {
            pointOfControl: highVolumeLevels[0]?.price || price,
            highVolumeNodes: highVolumeLevels
        };
    };

    // EXECUTE ANALYSES
    const multiTFLevels = detectMultiTimeframeLevels();
    const fibLevels = calculateFibonacciLevels();
    const volumeProfile = calculateVolumeProfile();

    // COMBINE WITH PRIORITIZATION
    const calculateFinalLevels = () => {
        const resistanceCandidates = [];
        const supportCandidates = [];

        // Prioritize recent strong levels
        [...multiTFLevels.strongResistance, ...multiTFLevels.weakResistance].forEach(level => {
            resistanceCandidates.push({
                price: level.price,
                confidence: level.strength,
                source: `pivot_${level.timeframe}`,
                recency: level.timeframe === "very_short" ? 1.2 : 1.0
            });
        });

        [...multiTFLevels.strongSupport, ...multiTFLevels.weakSupport].forEach(level => {
            supportCandidates.push({
                price: level.price,
                confidence: level.strength,
                source: `pivot_${level.timeframe}`,
                recency: level.timeframe === "very_short" ? 1.2 : 1.0
            });
        });

        // Add Fibonacci with moderate priority
        Object.values(fibLevels).forEach(fibPrice => {
            if (fibPrice > price) {
                resistanceCandidates.push({
                    price: fibPrice,
                    confidence: 1.3,
                    source: 'fibonacci',
                    recency: 1.0
                });
            } else {
                supportCandidates.push({
                    price: fibPrice,
                    confidence: 1.3,
                    source: 'fibonacci',
                    recency: 1.0
                });
            }
        });

        // Add volume profile with high priority
        volumeProfile.highVolumeNodes.forEach(node => {
            if (node.price > price) {
                resistanceCandidates.push({
                    price: node.price,
                    confidence: node.strength * 1.8,
                    source: 'volume_profile',
                    recency: 1.1
                });
            } else {
                supportCandidates.push({
                    price: node.price,
                    confidence: node.strength * 1.8,
                    source: 'volume_profile',
                    recency: 1.1
                });
            }
        });

        // SELECT BEST CANDIDATES dengan prioritas kecepatan
        const selectBestLevel = (candidates, isResistance) => {
            if (candidates.length === 0) return null;

            // Beri skor berdasarkan confidence dan recency
            const scoredCandidates = candidates.map(candidate => {
                const baseScore = candidate.confidence * candidate.recency;
                const distance = isResistance ? 
                    (candidate.price - price) / price : 
                    (price - candidate.price) / price;
                
                // Prioritaskan level yang tidak terlalu jauh (1% - 5%)
                const distanceScore = distance >= 0.01 && distance <= 0.05 ? 1.5 : 1.0;
                
                return {
                    ...candidate,
                    score: baseScore * distanceScore
                };
            });

            // Urutkan berdasarkan skor dan ambil yang terbaik
            scoredCandidates.sort((a, b) => b.score - a.score);
            return scoredCandidates[0]?.price || null;
        };

        const bestResistance = selectBestLevel(resistanceCandidates, true);
        const bestSupport = selectBestLevel(supportCandidates, false);

        return {
            resistance: bestResistance,
            support: bestSupport,
            allResistance: resistanceCandidates,
            allSupport: supportCandidates,
            volumePOC: volumeProfile.pointOfControl
        };
    };

    return calculateFinalLevels();
};

// -------------------- ENHANCED TECHNICAL ANALYSIS --------------------
const analyzeSignal = async () => {
    console.log("🧠 Enhanced technical analysis started...");
    try {
        const ohlcv = await safeApiCall(exchange.fetchOHLCV, db.pair, "15m", undefined, 200);
        if (!ohlcv || ohlcv.length < 100) {
            console.warn("⚠️ Insufficient OHLCV data");
            return {};
        }

        const close = ohlcv.map(c => c[4]);
        const high = ohlcv.map(c => c[2]);
        const low = ohlcv.map(c => c[3]);
        const volume = ohlcv.map(c => c[5]);
        const price = close.at(-1);

        // 1. FASTER MOVING AVERAGES WITH OPTIMIZED PERIODS
        const maFast = SMA.calculate({
            values: close.slice(-50),
            period: 5
        });
        const maMedium = SMA.calculate({
            values: close.slice(-50),
            period: 15
        });
        const maSlow = SMA.calculate({
            values: close.slice(-100),
            period: 50
        });

        const currentMAFast = maFast.pop();
        const currentMAMedium = maMedium.pop();
        const currentMASlow = maSlow.pop();
        
        const prevMAFast = maFast.pop();
        const prevMAMedium = maMedium.pop();

        // 2. ENHANCED CROSSOVER DETECTION
        const isFastAboveMedium = currentMAFast > currentMAMedium;
        const wasFastBelowMedium = prevMAFast <= prevMAMedium;
        const isFastAboveSlow = currentMAFast > currentMASlow;
        const isMediumAboveSlow = currentMAMedium > currentMASlow;

        const isFastBelowMedium = currentMAFast < currentMAMedium;
        const wasFastAboveMedium = prevMAFast >= prevMAMedium;
        const isFastBelowSlow = currentMAFast < currentMASlow;
        const isMediumBelowSlow = currentMAMedium < currentMASlow;

        // 3. MOMENTUM CONFIRMATION
        const priceChange1 = ((close[close.length-1] - close[close.length-2]) / close[close.length-2]) * 100;
        const priceChange2 = ((close[close.length-1] - close[close.length-3]) / close[close.length-3]) * 100;
        const avgPriceChange = (priceChange1 + priceChange2) / 2;

        // 4. VOLUME CONFIRMATION
        const currentVolume = volume[volume.length-1];
        const avgVolume = volume.slice(-20).reduce((a, b) => a + b) / 20;
        const volumeSpike = currentVolume > avgVolume * 1.2;

        // 5. ENHANCED SIGNAL CONDITIONS
        let canLong = false;
        let canShort = false;

        // Long conditions - lebih responsif
        if (isFastAboveMedium && (wasFastBelowMedium || isFastAboveSlow)) {
            const momentumBullish = avgPriceChange > 0 || volumeSpike;
            const trendAligned = isMediumAboveSlow || isFastAboveSlow;
            
            if (momentumBullish && trendAligned) {
                canLong = true;
            }
        }

        // Short conditions - lebih responsif  
        if (isFastBelowMedium && (wasFastAboveMedium || isFastBelowSlow)) {
            const momentumBearish = avgPriceChange < 0 || volumeSpike;
            const trendAligned = isMediumBelowSlow || isFastBelowSlow;
            
            if (momentumBearish && trendAligned) {
                canShort = true;
            }
        }

        // 6. DYNAMIC SUPPORT/RESISTANCE WITH IMPROVED REACTIVITY
        const advancedLevels = findAdvancedLevels(high, low, close, volume, price);
        
        let resistance = advancedLevels.resistance;
        let support = advancedLevels.support;

        // Fallback dengan logika yang lebih agresif
        if (!resistance || !support) {
            const recentHigh = Math.max(...high.slice(-30)); // Window lebih pendek
            const recentLow = Math.min(...low.slice(-30));
            const volatility = Math.abs(recentHigh - recentLow) / price;
            
            resistance = recentHigh * (1 - volatility * 0.1);
            support = recentLow * (1 + volatility * 0.1);
        }

        // 7. OPTIMIZED RISK MANAGEMENT dengan jarak yang lebih ketat
        const atr = calculateATR(high, low, close, 10).pop() || (price * 0.005);
        
        // Target dan stop loss yang lebih agresif
        const targetLong = resistance;
        const stopLossLong = Math.min(support, price - (atr * 1.2));
        
        const targetShort = support;
        const stopLossShort = Math.max(resistance, price + (atr * 1.2));

        // Validasi level yang masuk akal
        const validateLevel = (level, current, isTarget) => {
            if (!level || !isFinite(level)) return current * (isTarget ? 1.01 : 0.99);
            
            const minDistance = atr * 0.5;
            const maxDistance = atr * 2.5;
            const distance = Math.abs(level - current);
            
            if (distance < minDistance) {
                return current + (isTarget ? minDistance : -minDistance);
            }
            if (distance > maxDistance) {
                return current + (isTarget ? maxDistance : -maxDistance);
            }
            return level;
        };

        const validatedTargetLong = validateLevel(targetLong, price, true);
        const validatedStopLossLong = validateLevel(stopLossLong, price, false);
        const validatedTargetShort = validateLevel(targetShort, price, false);
        const validatedStopLossShort = validateLevel(stopLossShort, price, true);

        // 8. ENHANCED ANALYSIS RESULTS
        console.log(`\n🎯 ENHANCED Analysis Results ${db.pair}
══════════════════════════════════════════════════
📈 Long Signal: ${canLong ? "✅ VALID" : "❌ INVALID"}
📉 Short Signal: ${canShort ? "✅ VALID" : "❌ INVALID"}
══════════════════════════════════════════════════
💰 Current Price: ${formatPrice(price)}
📊 MA Fast: ${formatPrice(currentMAFast)} | MA Med: ${formatPrice(currentMAMedium)}
📊 MA Slow: ${formatPrice(currentMASlow)}
📈 Momentum: ${avgPriceChange.toFixed(3)}%
📊 Volume: ${volumeSpike ? "📈 SPIKE" : "Normal"}
══════════════════════════════════════════════════
🎯 Resistance: ${formatPrice(validatedTargetLong)} (${((validatedTargetLong - price) / price * 100).toFixed(3)}%)
🛡️ Support: ${formatPrice(validatedTargetShort)} (${((price - validatedTargetShort) / price * 100).toFixed(3)}%)
⚡ ATR: ${formatPrice(atr)} (${(atr/price*100).toFixed(3)}%)
══════════════════════════════════════════════════`);

        return {
            canLong,
            canShort,
            targetLong: validatedTargetLong,
            stopLossLong: validatedStopLossLong,
            targetShort: validatedTargetShort,
            stopLossShort: validatedStopLossShort,
            price,
            advancedLevels,
            momentum: avgPriceChange,
            volumeSpike
        };
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
        const {
            position
        } = await getPositionFromBalance();
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

    const qty = calcQty(price);
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
        const {
            position
        } = await getPositionFromBalance();
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
                const {
                    tp,
                    sl,
                    side: entrySide
                } = db.activePosition;
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
    }
};

// -------------------- POSITION MONITORING --------------------
const checkPositionStatus = async () => {
    try {
        const {
            position
        } = await getPositionFromBalance();
        const amt = parseFloat(position?.positionAmt || "0");
        const amtSafe = isFinite(amt) ? amt : 0;

        const prevSafe = isFinite(prevPosAmt) ? prevPosAmt : 0;
        if (prevSafe !== 0 && amtSafe === 0) {
            const side = prevSafe > 0 ? "LONG" : "SHORT";
            console.log(`📉 ${side} position closed`);
            db.activePosition = null;
            saveDB();
        }

        if (db.activePosition && amtSafe !== 0) {
            const {
                tp,
                sl,
                side,
                entryPrice
            } = db.activePosition;
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

        const {
            position
        } = await getPositionFromBalance();
        const amt = parseFloat(position?.positionAmt || "0");
        const MIN_POSITION_AMOUNT = 0.000001;
        const amtSafe = isFinite(amt) ? amt : 0;

        // Recovery needed
        if (Math.abs(amtSafe) > MIN_POSITION_AMOUNT && !db.activePosition) {
            console.log("⚠️ Position recovery needed");

            const currentPrice = await getPrice();
            if (!currentPrice) return;

            const side = amtSafe > 0 ? "buy" : "sell";
            const entryPrice = parseFloat(position?.entryPrice || currentPrice);
            const leverage = position?.leverage || db.leverage;

            const signal = await analyzeSignal();
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

        // Cleanup needed
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
            console.log("✅ Database cleaned");
        }

        // Position monitoring
        if (db.activePosition && Math.abs(amtSafe) > MIN_POSITION_AMOUNT) {
            const currentPrice = await getPrice();
            if (currentPrice) {
                const {
                    side,
                    entryPrice,
                    tp,
                    sl
                } = db.activePosition;
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

// -------------------- MAIN LOOP --------------------
let prevPosAmt = 0;

// Initialize connection on startup
(async () => {
    await initializeExchange();
    console.log("🚀 Bot started with enhanced speed & accuracy detection");
})();

setInterval(async () => {
    // Health check first
    const health = await healthCheck();
    if (!health.healthy) {
        console.log("⚠️ Health check failed, skipping cycle...");
        isProcessing = false;
        return;
    }

    // Auto reload config
    try {
        const freshDb = loadDB();
        db.pair = freshDb.pair;
        db.leverage = freshDb.leverage;
        db.marginMode = freshDb.marginMode;
        db.usdtPerTrade = freshDb.usdtPerTrade;
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

        const signal = await analyzeSignal();
        if (!signal.price) {
            console.log("⚠️ Invalid signal, waiting...");
            return;
        }

        const hasBotPosition = db.activePosition !== null;
        let shouldExitCurrentPosition = false;

        if (hasBotPosition) {
            const currentSide = db.activePosition.side;
            if (currentSide === "buy" && signal.canShort) {
                console.log("⚠️ SHORT signal detected, closing LONG");
                shouldExitCurrentPosition = true;
            } else if (currentSide === "sell" && signal.canLong) {
                console.log("⚠️ LONG signal detected, closing SHORT");
                shouldExitCurrentPosition = true;
            }
        }

        if (shouldExitCurrentPosition) {
            await closePosition("Signal reversal", db.activePosition.entryPrice);
            await new Promise(resolve => setTimeout(resolve, 10000));
        }

        const {
            position
        } = await getPositionFromBalance();
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
    } catch (err) {
        console.error("⚠️ Main loop error:", err.message);
    } finally {
        isProcessing = false;
    }
}, 10000);