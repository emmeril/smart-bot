// bot.js (Fully Cleaned and Organized Version)
require("dotenv").config();
const fs = require("fs");
const ccxt = require("ccxt");
const { SMA } = require("technicalindicators");

// ==================== CONFIGURATION ====================
const CONFIG = {
    dbPath: "./db.json",
    logPath: "./log.csv",
    maxRetries: 5,
    retryDelay: 10000,
    checkInterval: 10000,
    MIN_POSITION_AMOUNT: 0.000001,
    SAFETY_MARGIN: 0.001
};

// ==================== STATE MANAGEMENT ====================
let state = {
    isProcessing: false,
    exchange: null,
    connectionRetries: 0,
    prevPosAmt: 0,
    db: loadDB()
};

// ==================== INITIALIZATION ====================
function initializeFiles() {
    if (!fs.existsSync(CONFIG.logPath)) {
        fs.writeFileSync(CONFIG.logPath, "timestamp,pair,type,entry,tp,sl,status,pnl\n");
        console.log("📝 Log file created: log.csv");
    }
}

function loadDB() {
    try {
        if (fs.existsSync(CONFIG.dbPath)) {
            return JSON.parse(fs.readFileSync(CONFIG.dbPath));
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
}

// ==================== EXCHANGE MANAGEMENT ====================
async function initializeExchange() {
    try {
        if (state.exchange) {
            try {
                await state.exchange.fetchBalance();
                return state.exchange;
            } catch (e) {
                console.log("🔄 Connection lost, reinitializing...");
            }
        }

        state.exchange = new ccxt.binance({
            apiKey: process.env.API_KEY,
            secret: process.env.API_SECRET,
            options: { defaultType: "future" },
            timeout: 30000,
            enableRateLimit: true,
            recvWindow: 60000,
        });

        await state.exchange.loadMarkets();
        await state.exchange.fetchBalance();

        console.log("✅ Exchange connection initialized successfully");
        state.connectionRetries = 0;
        return state.exchange;
    } catch (error) {
        console.error(`❌ Exchange initialization failed (attempt ${state.connectionRetries + 1}/${CONFIG.maxRetries}):`, error.message);

        if (state.connectionRetries < CONFIG.maxRetries) {
            state.connectionRetries++;
            console.log(`🔄 Retrying in ${CONFIG.retryDelay/1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, CONFIG.retryDelay));
            return initializeExchange();
        } else {
            console.error("💥 Maximum connection retries reached. Please check your network and API credentials.");
            throw error;
        }
    }
}

// ==================== UTILITY FUNCTIONS ====================
function saveDB() {
    try {
        if (state.db.activePosition) {
            state.db.activePosition.entryPrice = formatPrice(state.db.activePosition.entryPrice);
            state.db.activePosition.tp = formatPrice(state.db.activePosition.tp);
            state.db.activePosition.sl = formatPrice(state.db.activePosition.sl);
        }
        fs.writeFileSync(CONFIG.dbPath, JSON.stringify(state.db, null, 2));
    } catch (error) {
        console.error("❌ Failed to save DB:", error.message);
    }
}

function formatPrice(price, pair = state.db.pair) {
    if (!price || !isFinite(price)) return "N/A";

    try {
        const market = state.exchange.markets[pair];
        if (!market) return parseFloat(price.toFixed(5));

        let decimals = market.precision?.price ?? 5;
        decimals = Math.max(0, Math.min(8, parseInt(decimals)));
        return parseFloat(price.toFixed(decimals));
    } catch (err) {
        return parseFloat(price.toFixed(5));
    }
}

async function safeApiCall(apiFunction, ...args) {
    try {
        if (!state.exchange) {
            await initializeExchange();
        }
        return await apiFunction.call(state.exchange, ...args);
    } catch (error) {
        if (error instanceof ccxt.NetworkError || error.message.includes('network') || error.message.includes('timeout')) {
            console.log("🌐 Network issue detected, reinitializing connection...");
            await initializeExchange();
            return await apiFunction.call(state.exchange, ...args);
        }
        throw error;
    }
}

function logSignal(type, entry, tp, sl, status, pnl = null) {
    try {
        const entryStr = entry ?? "";
        const tpStr = tp ?? "";
        const slStr = sl ?? "";
        const pnlStr = pnl !== null && isFinite(pnl) ? Number(pnl).toFixed(6) : "";
        const line = `${new Date().toISOString()},${state.db.pair},${type},${entryStr},${tpStr},${slStr},${status},${pnlStr}\n`;
        fs.appendFileSync(CONFIG.logPath, line);
        console.log("📝 Signal logged to CSV");
    } catch (error) {
        console.error("❌ Failed to log signal:", error.message);
    }
}

// ==================== PRICE & POSITION MANAGEMENT ====================
async function getPrice() {
    try {
        const ticker = await safeApiCall(state.exchange.fetchTicker, state.db.pair);
        console.log(`💰 Price ${state.db.pair}: ${formatPrice(ticker.last)}`);
        return ticker.last;
    } catch (err) {
        console.error("❌ Failed to fetch price:", err.message);
        return null;
    }
}

function calcQty(price) {
    if (!price) return 0;
    let qty = state.db.usdtPerTrade / price;
    const prec = state.exchange.markets[state.db.pair]?.precision?.amount ?? 3;
    qty = parseFloat(qty.toFixed(prec));
    console.log(`📐 Quantity: ${qty} (${state.db.usdtPerTrade} USDT)`);
    return qty;
}

async function getPositionFromBalance() {
    try {
        const balance = await safeApiCall(state.exchange.fetchBalance);
        const marketId = getMarketId();
        const positions = balance.info?.positions || [];

        const normalize = (str) => (str || "").toString().replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
        const found = positions.find(p =>
            normalize(p.symbol) === normalize(marketId) ||
            normalize(p.contractCode) === normalize(marketId)
        );

        return { balance, position: found };
    } catch (err) {
        console.error("❌ Failed to fetch position:", err.message);
        return { balance: null, position: null };
    }
}

function getMarketId() {
    try {
        const market = state.exchange.markets[state.db.pair];
        if (market?.id) return market.id;
    } catch (err) {}
    return state.db.pair.replace("/", "").replace(":", "");
}

// ==================== TECHNICAL ANALYSIS UTILITIES ====================
const TechnicalAnalysis = {
    calculateATR(highArr, lowArr, closeArr, period = 14) {
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
    },

    detectMultiTimeframeLevels(high, low, close, volume) {
        const levels = {
            strongResistance: [],
            strongSupport: [],
            weakResistance: [],
            weakSupport: []
        };

        const timeframes = [
            { period: 20, weight: 1.0, name: "short" },
            { period: 50, weight: 1.5, name: "medium" },
            { period: 96, weight: 2.0, name: "long" }
        ];

        timeframes.forEach(tf => {
            const sliceIndex = Math.max(0, high.length - tf.period);
            const highSlice = high.slice(sliceIndex);
            const lowSlice = low.slice(sliceIndex);
            const volumeSlice = volume.slice(sliceIndex);

            for (let i = 3; i < highSlice.length - 3; i++) {
                // Pivot High detection (Resistance)
                if (this.isPivotHigh(highSlice, i)) {
                    const level = this.createLevel(highSlice[i], tf, volumeSlice, i, "resistance");
                    level.touches > 1 ? levels.strongResistance.push(level) : levels.weakResistance.push(level);
                }

                // Pivot Low detection (Support)
                if (this.isPivotLow(lowSlice, i)) {
                    const level = this.createLevel(lowSlice[i], tf, volumeSlice, i, "support");
                    level.touches > 1 ? levels.strongSupport.push(level) : levels.weakSupport.push(level);
                }
            }
        });

        return levels;
    },

    isPivotHigh(data, index) {
        return data[index] > data[index-1] && 
               data[index] > data[index-2] &&
               data[index] > data[index+1] && 
               data[index] > data[index+2] &&
               data[index] === Math.max(...data.slice(index-2, index+3));
    },

    isPivotLow(data, index) {
        return data[index] < data[index-1] && 
               data[index] < data[index-2] &&
               data[index] < data[index+1] && 
               data[index] < data[index+2] &&
               data[index] === Math.min(...data.slice(index-2, index+3));
    },

    createLevel(price, timeframe, volumeSlice, index, type) {
        const level = {
            price,
            strength: timeframe.weight * (1 + (volumeSlice[index] / Math.max(...volumeSlice))),
            timeframe: timeframe.name,
            touches: 1,
            recency: index
        };

        // Count touches within proximity
        const checkRange = Math.min(index + 20, volumeSlice.length);
        for (let j = index + 1; j < checkRange; j++) {
            if (Math.abs(volumeSlice[j] - price) / price < 0.002) {
                level.touches++;
                level.strength += 0.5;
            }
        }

        return level;
    },

    calculateFibonacciLevels(high, low) {
        const recentHigh = Math.max(...high.slice(-50));
        const recentLow = Math.min(...low.slice(-50));
        const range = recentHigh - recentLow;

        return {
            fib236: recentHigh - range * 0.236,
            fib382: recentHigh - range * 0.382,
            fib500: recentHigh - range * 0.500,
            fib618: recentHigh - range * 0.618,
            fib786: recentHigh - range * 0.786
        };
    },

    calculateVolumeProfile(close, volume, high, low) {
        const priceLevels = {};
        const range = Math.max(...high.slice(-50)) - Math.min(...low.slice(-50));
        const bucketSize = range / 20;

        for (let i = 0; i < close.length; i++) {
            const bucket = Math.floor(close[i] / bucketSize) * bucketSize;
            priceLevels[bucket] = priceLevels[bucket] || { volume: 0, count: 0 };
            priceLevels[bucket].volume += volume[i];
            priceLevels[bucket].count++;
        }

        const volumes = Object.values(priceLevels).map(d => d.volume);
        const maxVolume = Math.max(...volumes);
        
        const highVolumeLevels = Object.entries(priceLevels)
            .filter(([_, data]) => data.volume > maxVolume * 0.7)
            .map(([price, data]) => ({
                price: parseFloat(price),
                volume: data.volume,
                strength: data.volume / maxVolume
            }))
            .sort((a, b) => b.volume - a.volume);

        return {
            pointOfControl: highVolumeLevels[0]?.price || close[close.length - 1],
            highVolumeNodes: highVolumeLevels.slice(0, 5)
        };
    }
};

// ==================== SUPPORT/RESISTANCE DETECTION ====================
function findAdvancedLevels(high, low, close, volume, price) {
    console.log("🔍 Starting advanced S/R detection...");
    
    const multiTFLevels = TechnicalAnalysis.detectMultiTimeframeLevels(high, low, close, volume);
    const fibLevels = TechnicalAnalysis.calculateFibonacciLevels(high, low);
    const volumeProfile = TechnicalAnalysis.calculateVolumeProfile(close, volume, high, low);

    return calculateFinalLevels(multiTFLevels, fibLevels, volumeProfile, price);
}

function calculateFinalLevels(multiTFLevels, fibLevels, volumeProfile, price) {
    const resistanceCandidates = [];
    const supportCandidates = [];

    // Add multi-timeframe levels
    [...multiTFLevels.strongResistance, ...multiTFLevels.weakResistance].forEach(level => {
        resistanceCandidates.push({
            price: level.price,
            confidence: level.strength * (level.touches > 1 ? 1.5 : 1.0),
            source: `pivot_${level.timeframe}`,
            touches: level.touches
        });
    });

    [...multiTFLevels.strongSupport, ...multiTFLevels.weakSupport].forEach(level => {
        supportCandidates.push({
            price: level.price,
            confidence: level.strength * (level.touches > 1 ? 1.5 : 1.0),
            source: `pivot_${level.timeframe}`,
            touches: level.touches
        });
    });

    // Add Fibonacci levels
    Object.entries(fibLevels).forEach(([level, fibPrice]) => {
        const targetArray = fibPrice > price ? resistanceCandidates : supportCandidates;
        targetArray.push({
            price: fibPrice,
            confidence: 1.2,
            source: `fib_${level}`,
            touches: 0
        });
    });

    // Add volume profile levels
    volumeProfile.highVolumeNodes.forEach(node => {
        const targetArray = node.price > price ? resistanceCandidates : supportCandidates;
        targetArray.push({
            price: node.price,
            confidence: node.strength * 2.0,
            source: 'volume_profile',
            touches: Math.round(node.strength * 10)
        });
    });

    const bestResistance = filterCandidates(resistanceCandidates, true, price);
    const bestSupport = filterCandidates(supportCandidates, false, price);

    return {
        resistance: bestResistance[0]?.price || null,
        support: bestSupport[0]?.price || null,
        allResistance: bestResistance,
        allSupport: bestSupport,
        volumePOC: volumeProfile.pointOfControl,
        fibLevels
    };
}

function filterCandidates(candidates, isResistance, price) {
    const groups = [];
    candidates.sort((a, b) => a.price - b.price);
    
    // Group nearby levels
    for (const candidate of candidates) {
        let grouped = false;
        for (const group of groups) {
            const avgPrice = group.reduce((sum, c) => sum + c.price, 0) / group.length;
            if (Math.abs(candidate.price - avgPrice) / avgPrice < 0.005) {
                group.push(candidate);
                grouped = true;
                break;
            }
        }
        if (!grouped) groups.push([candidate]);
    }

    // Select best candidate from each group and filter by distance
    return groups.map(group => 
        group.reduce((best, current) => {
            const currentScore = current.confidence * (1 + current.touches * 0.1);
            const bestScore = best.confidence * (1 + best.touches * 0.1);
            return currentScore > bestScore ? current : best;
        })
    )
    .filter(candidate => {
        const distance = isResistance ? 
            (candidate.price - price) / price : 
            (price - candidate.price) / price;
        return distance >= 0.002 && distance <= 0.03;
    })
    .sort((a, b) => {
        const scoreA = a.confidence * (1 + a.touches * 0.1);
        const scoreB = b.confidence * (1 + b.touches * 0.1);
        return scoreB - scoreA;
    });
}

// ==================== SIGNAL ANALYSIS ====================
async function analyzeSignal() {
    console.log("🧠 Advanced technical analysis started...");
    try {
        const ohlcv = await safeApiCall(state.exchange.fetchOHLCV, state.db.pair, "15m", undefined, 300);
        if (!ohlcv || ohlcv.length < 200) {
            console.warn("⚠️ Insufficient OHLCV data");
            return {};
        }

        const close = ohlcv.map(c => c[4]);
        const high = ohlcv.map(c => c[2]);
        const low = ohlcv.map(c => c[3]);
        const volume = ohlcv.map(c => c[5]);
        const price = close[close.length - 1];

        // Moving Averages Analysis
        const ma7 = SMA.calculate({ values: close.slice(-100), period: 7 }).pop();
        const ma25 = SMA.calculate({ values: close.slice(-100), period: 25 }).pop();
        const ma99 = SMA.calculate({ values: close, period: 99 }).pop();

        const prevMA7 = SMA.calculate({ values: close.slice(-101, -1), period: 7 }).pop();
        const prevMA25 = SMA.calculate({ values: close.slice(-101, -1), period: 25 }).pop();

        const isCrossedUp = ma7 > ma25 && prevMA7 <= prevMA25;
        const isCrossedDown = ma7 < ma25 && prevMA7 >= prevMA25;

        const isMA7AboveMA99 = ma7 > ma99;
        const isMA7BelowMA99 = ma7 < ma99;
        const isMA25AboveMA99 = ma25 > ma99;
        const isMA25BelowMA99 = ma25 < ma99;

        const canLong = isCrossedUp && isMA7AboveMA99 && isMA25AboveMA99;
        const canShort = isCrossedDown && isMA7BelowMA99 && isMA25BelowMA99;

        // ATR Calculation for risk management
        const currentATR = TechnicalAnalysis.calculateATR(high, low, close, 14).pop() || 0;

        // Advanced S/R Detection
        const advancedLevels = findAdvancedLevels(high, low, close, volume, price);
        
        let resistance = advancedLevels.resistance;
        let support = advancedLevels.support;

        // Fallback logic if advanced detection fails
        if (!resistance || !support) {
            console.log("🔄 Advanced S/R detection failed, using fallback...");
            const recentHigh = Math.max(...high.slice(-96));
            const recentLow = Math.min(...low.slice(-96));
            
            resistance = recentHigh + (currentATR * 0.5);
            support = recentLow - (currentATR * 0.5);
        }

        // Ensure minimum and maximum distance based on ATR
        const minDistance = currentATR * 0.8;
        const maxDistance = currentATR * 3;

        resistance = Math.min(Math.max(resistance, price + minDistance), price + maxDistance);
        support = Math.max(Math.min(support, price - minDistance), price - maxDistance);

        const targetLong = resistance;
        const stopLossLong = support;
        const targetShort = support;
        const stopLossShort = resistance;

        // Display analysis results
        console.log(`\n🎯 ADVANCED Analysis Results ${state.db.pair}
══════════════════════════════════════════════════
📈 Long Signal: ${canLong ? "✅ VALID" : "❌ INVALID"}
📉 Short Signal: ${canShort ? "✅ VALID" : "❌ INVALID"}
══════════════════════════════════════════════════
💰 Current Price: ${formatPrice(price)}
🎯 Resistance: ${formatPrice(resistance)} (${((resistance - price) / price * 100).toFixed(3)}%)
🛡️  Support: ${formatPrice(support)} (${((price - support) / price * 100).toFixed(3)}%)
📊 ATR: ${formatPrice(currentATR)} (${(currentATR/price*100).toFixed(3)}%)
══════════════════════════════════════════════════`);

        return { 
            canLong, 
            canShort, 
            targetLong, 
            stopLossLong, 
            targetShort, 
            stopLossShort, 
            price, 
            advancedLevels 
        };
    } catch (error) {
        console.error("❌ Advanced technical analysis failed:", error.message);
        return {};
    }
}

// ==================== ORDER MANAGEMENT ====================
async function placeOrder(side, tp, sl) {
    console.log("🔍 Checking for active positions...");
    
    // Check local database
    if (state.db.activePosition) {
        console.log("⚠️ Active position exists in DB, order cancelled");
        return;
    }

    // Check exchange position
    try {
        const { position } = await getPositionFromBalance();
        const amt = parseFloat(position?.positionAmt || "0");
        if (isFinite(amt) && Math.abs(amt) > 0) {
            console.log("⚠️ Active position detected on exchange, order cancelled");
            return;
        }
    } catch (err) {
        console.warn("⚠️ Failed to check live position:", err.message);
        return;
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
        await safeApiCall(state.exchange.setLeverage, state.db.leverage, state.db.pair);
        await safeApiCall(state.exchange.setMarginMode, state.db.marginMode, state.db.pair);
        console.log("✅ Leverage and margin mode set");
    } catch (err) {
        console.warn("⚠️ Failed to set leverage/margin:", err.message);
    }

    try {
        const order = await safeApiCall(state.exchange.createOrder, state.db.pair, "market", side, qty);
        console.log("✅ Market order created");

        state.db.activePosition = { 
            side, 
            entryPrice: price, 
            tp, 
            sl, 
            orderId: order.id 
        };
        saveDB();

        logSignal(side === "buy" ? "LONG" : "SHORT", price, tp, sl, "ORDER_PLACED");
    } catch (err) {
        console.error("❌ Order failed:", err.message);
    }
}

async function closePosition(reason, entryPrice = "N/A") {
    console.log(`🚨 Closing position: ${reason}`);
    try {
        const { position } = await getPositionFromBalance();
        const qty = parseFloat(position?.positionAmt || "0");

        if (!isFinite(qty) || Math.abs(qty) === 0) {
            console.log("ℹ️ No position to close");
        } else {
            const side = qty > 0 ? "sell" : "buy";
            const amount = Math.abs(qty);

            await safeApiCall(state.exchange.createOrder, state.db.pair, "market", side, amount, undefined, {
                reduceOnly: true,
            });
            console.log(`✅ Close order created (${side}, ${amount})`);

            // Calculate PnL if possible
            let pnl = null;
            let statusTag = "CLOSED_MANUAL";

            const isTP = /TP/i.test(reason);
            const isSL = /SL/i.test(reason);

            if (isTP) statusTag = "TP_REALIZED";
            else if (isSL) statusTag = "SL_REALIZED";

            if (entryPrice !== "N/A" && state.db.activePosition) {
                const { tp, sl, side: entrySide } = state.db.activePosition;
                try {
                    const entryNum = Number(entryPrice);
                    const closedQty = amount;

                    if (closedQty > 0) {
                        let exitNum;
                        if (isTP) exitNum = entrySide === "buy" ? tp : sl;
                        else if (isSL) exitNum = entrySide === "buy" ? sl : tp;
                        else {
                            const exitPrice = await getPrice();
                            if (isFinite(exitPrice)) exitNum = Number(exitPrice);
                        }

                        if (exitNum !== undefined) {
                            pnl = entrySide === "buy" ? 
                                (exitNum - entryNum) * closedQty : 
                                (entryNum - exitNum) * closedQty;
                        }
                    }
                } catch (err) {
                    console.warn("⚠️ PNL calculation failed:", err.message);
                }
            }

            logSignal(
                qty > 0 ? "LONG" : "SHORT",
                entryPrice,
                state.db.activePosition?.tp ?? "",
                state.db.activePosition?.sl ?? "",
                statusTag,
                pnl
            );
        }
    } catch (err) {
        console.error("❌ Close position failed:", err.message);
    } finally {
        state.db.activePosition = null;
        saveDB();
    }
}

// ==================== POSITION RECOVERY & MONITORING ====================
async function recoverPositionState() {
    try {
        console.log("🔄 Checking position sync...");

        const { position } = await getPositionFromBalance();
        const amt = parseFloat(position?.positionAmt || "0");
        const amtSafe = isFinite(amt) ? amt : 0;

        // Recovery needed: position exists on exchange but not in local DB
        if (Math.abs(amtSafe) > CONFIG.MIN_POSITION_AMOUNT && !state.db.activePosition) {
            await recoverPosition(amtSafe, position);
        }

        // Cleanup needed: position in local DB but not on exchange
        if (state.db.activePosition && Math.abs(amtSafe) <= CONFIG.MIN_POSITION_AMOUNT) {
            await cleanupPosition();
        }

        // Monitor active position
        if (state.db.activePosition && Math.abs(amtSafe) > CONFIG.MIN_POSITION_AMOUNT) {
            await monitorActivePosition();
        }

    } catch (err) {
        console.error("❌ Recovery error:", err.message);
    }
}

async function recoverPosition(amtSafe, position) {
    console.log("⚠️ Position recovery needed");

    const currentPrice = await getPrice();
    if (!currentPrice) return;

    const side = amtSafe > 0 ? "buy" : "sell";
    const entryPrice = parseFloat(position?.entryPrice || currentPrice);
    const leverage = position?.leverage || state.db.leverage;

    const signal = await analyzeSignal();
    let tp, sl;

    if (!signal?.price) {
        console.log("⚠️ Using fallback TP/SL");
        tp = side === "buy" ? entryPrice * 1.015 : entryPrice * 0.985;
        sl = side === "buy" ? entryPrice * 0.995 : entryPrice * 1.005;
    } else {
        tp = side === "buy" ? 
            (signal.targetLong || entryPrice * 1.015) : 
            (signal.targetShort || entryPrice * 0.985);
        sl = side === "buy" ? 
            (signal.stopLossLong || entryPrice * 0.995) : 
            (signal.stopLossShort || entryPrice * 1.005);
    }

    // Apply safety margins
    if (side === "buy") {
        tp *= (1 - CONFIG.SAFETY_MARGIN);
        sl *= (1 + CONFIG.SAFETY_MARGIN);
    } else {
        tp *= (1 + CONFIG.SAFETY_MARGIN);
        sl *= (1 - CONFIG.SAFETY_MARGIN);
    }

    // Ensure TP/SL are valid
    if (side === "buy") {
        if (tp <= entryPrice) tp = entryPrice * 1.015;
        if (sl >= entryPrice) sl = entryPrice * 0.995;
    } else {
        if (tp >= entryPrice) tp = entryPrice * 0.985;
        if (sl <= entryPrice) sl = entryPrice * 1.005;
    }

    // Calculate risk-reward ratio
    const rrRatio = side === "buy" ? 
        ((tp - entryPrice) / (entryPrice - sl)).toFixed(2) : 
        ((entryPrice - tp) / (sl - entryPrice)).toFixed(2);

    state.db.activePosition = {
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

async function cleanupPosition() {
    console.log("⚠️ Position cleanup needed");

    const side = state.db.activePosition.side === "buy" ? "LONG" : "SHORT";

    logSignal(
        side,
        state.db.activePosition.entryPrice,
        state.db.activePosition.tp,
        state.db.activePosition.sl,
        "CLOSED_EXTERNALLY"
    );

    state.db.activePosition = null;
    saveDB();
    console.log("✅ Database cleaned");
}

async function monitorActivePosition() {
    const currentPrice = await getPrice();
    if (!currentPrice) return;

    const { side, entryPrice, tp, sl } = state.db.activePosition;
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

async function checkPositionStatus() {
    try {
        const { position } = await getPositionFromBalance();
        const amt = parseFloat(position?.positionAmt || "0");
        const amtSafe = isFinite(amt) ? amt : 0;

        const prevSafe = isFinite(state.prevPosAmt) ? state.prevPosAmt : 0;
        if (prevSafe !== 0 && amtSafe === 0) {
            const side = prevSafe > 0 ? "LONG" : "SHORT";
            console.log(`📉 ${side} position closed`);
            state.db.activePosition = null;
            saveDB();
        }

        if (state.db.activePosition && amtSafe !== 0) {
            const { tp, sl, side, entryPrice } = state.db.activePosition;
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

        state.prevPosAmt = amtSafe;
    } catch (err) {
        console.error("❌ Position check failed:", err.message);
    }
}

// ==================== HEALTH CHECK ====================
async function healthCheck() {
    try {
        await initializeExchange();
        const balance = await safeApiCall(state.exchange.fetchBalance);
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
}

// ==================== MAIN LOOP ====================
async function mainLoop() {
    const health = await healthCheck();
    if (!health.healthy) {
        console.log("⚠️ Health check failed, skipping cycle...");
        state.isProcessing = false;
        return;
    }

    // Auto reload config
    try {
        const freshDb = loadDB();
        Object.assign(state.db, freshDb);
    } catch (error) {
        // Use existing config on error
    }

    if (state.isProcessing) {
        console.log("⏳ Skipping: Still processing...");
        return;
    }

    state.isProcessing = true;
    try {
        const now = new Date();
        
        // Position recovery and monitoring
        await recoverPositionState();
        await checkPositionStatus();

        console.log("🔍 Checking for new signals...");
        const signal = await analyzeSignal();
        if (!signal.price) {
            console.log("⚠️ Invalid signal, waiting...");
            return;
        }

        const hasBotPosition = state.db.activePosition !== null;
        let shouldExitCurrentPosition = false;

        // Check for signal reversal
        if (hasBotPosition) {
            const currentSide = state.db.activePosition.side;
            if (currentSide === "buy" && signal.canShort) {
                console.log("⚠️ SHORT signal detected, closing LONG");
                shouldExitCurrentPosition = true;
            } else if (currentSide === "sell" && signal.canLong) {
                console.log("⚠️ LONG signal detected, closing SHORT");
                shouldExitCurrentPosition = true;
            }
        }

        if (shouldExitCurrentPosition) {
            await closePosition("Signal reversal", state.db.activePosition.entryPrice);
            await new Promise(resolve => setTimeout(resolve, 10000));
        }

        const { position } = await getPositionFromBalance();
        const amt = parseFloat(position?.positionAmt || "0");
        const hasActiveBinancePositionAfterClose = isFinite(amt) && Math.abs(amt) > 0;

        // Enter new position if conditions are met
        if (!state.db.activePosition && !hasActiveBinancePositionAfterClose) {
            if (signal.canLong) {
                const isLongBreakout = signal.price > signal.targetLong;
                if (!isLongBreakout) {
                    console.log(`🚀 LONG Signal | TP: ${formatPrice(signal.targetLong)} | SL: ${formatPrice(signal.stopLossLong)}`);
                    state.db.lastLongEntryTime = now;
                    saveDB();
                    await placeOrder("buy", signal.targetLong, signal.stopLossLong);
                } else {
                    console.log(`⏸️ LONG Signal: Breakout detected, skipping`);
                }
            } else if (signal.canShort) {
                const isShortBreakout = signal.price < signal.targetShort;
                if (!isShortBreakout) {
                    console.log(`📉 SHORT Signal | TP: ${formatPrice(signal.targetShort)} | SL: ${formatPrice(signal.stopLossShort)}`);
                    state.db.lastShortEntryTime = now;
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
        state.isProcessing = false;
    }
}

// ==================== STARTUP ====================
initializeFiles();
console.log(`⚙️ Bot Configuration:
- Pair: ${state.db.pair}
- Leverage: ${state.db.leverage}x
- Margin Mode: ${state.db.marginMode}
- USDT per Trade: ${state.db.usdtPerTrade}`);

// Initialize connection and start main loop
(async () => {
    await initializeExchange();
    console.log("🚀 Bot started with advanced S/R detection");
    setInterval(mainLoop, CONFIG.checkInterval);
})();