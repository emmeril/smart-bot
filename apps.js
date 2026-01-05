// signal.js (Advanced Support & Resistance Version - Optimized & Auto-Leverage)
require("dotenv").config();
const fs = require("fs");
const ccxt = require("ccxt");
const { SMA, RSI, EMA, ATR } = require("technicalindicators");

// -------------------- CONFIG --------------------
const dbPath = "./db.json";
const logPath = "./log.csv";
const performancePath = "./performance.json";
let isProcessing = false;
let exchange = null;
let connectionRetries = 0;
const MAX_RETRIES = 5;
const RETRY_DELAY = 10000;
let dailyPnL = 0;
let tradeCount = 0;

// -------------------- LOAD PERFORMANCE DATA --------------------
const loadPerformanceData = () => {
    try {
        if (fs.existsSync(performancePath)) {
            const data = JSON.parse(fs.readFileSync(performancePath));
            // Reset daily PnL jika hari baru
            const today = new Date().toDateString();
            if (data.lastReset !== today) {
                data.dailyPnL = 0;
                data.dailyTrades = 0;
                data.lastReset = today;
                fs.writeFileSync(performancePath, JSON.stringify(data, null, 2));
            }
            return data;
        }
    } catch (error) {
        console.warn("⚠️ Failed to load performance data:", error.message);
    }
    
    return {
        totalPnL: 0,
        dailyPnL: 0,
        totalTrades: 0,
        dailyTrades: 0,
        winRate: 0,
        lastReset: new Date().toDateString()
    };
};

let performance = loadPerformanceData();

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
    fs.writeFileSync(logPath, "timestamp,pair,type,entry,tp,sl,status,pnl,leverage,balance\n");
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
        marginMode: "ISOLATED",
        activePosition: null,
        usdtPerTrade: 1, // Default 1 USDT untuk trading dengan saldo kecil
        useDynamicPositionSizing: true,
        positionSizePercentage: 90,
        maxDailyLossPercent: 10, // Maksimal kerugian harian 10%
        minRRRatio: 1.8, // Minimal Risk:Reward 1:1.8
        useTrailingStop: true,
        trailingStopPercent: 0.5, // Trailing stop 0.5%
        usePyramidEntry: true, // Entry bertahap
        maxPyramidEntries: 3,
        pyramidDistancePercent: 0.3, // Jarak entry bertahap 0.3%
        coolingPeriod: 60000, // 1 menit cooling period setelah loss
        lastTradeResult: null, // 'win' atau 'loss'
        lastTradeTime: 0
    };
};

let db = loadDB();

// -------------------- DYNAMIC LEVERAGE CALCULATION --------------------
const calculateOptimalLeverage = async (balance) => {
    try {
        const totalUSDT = balance.total?.USDT || 0;
        
        // Logika leverage berdasarkan balance
        let leverage;
        if (totalUSDT <= 10) {
            leverage = 50; // Untuk balance <= 10 USDT, gunakan leverage tinggi
        } else if (totalUSDT <= 50) {
            leverage = 30; // Untuk balance <= 50 USDT
        } else if (totalUSDT <= 100) {
            leverage = 20; // Untuk balance <= 100 USDT
        } else if (totalUSDT <= 500) {
            leverage = 15; // Untuk balance <= 500 USDT
        } else if (totalUSDT <= 1000) {
            leverage = 10; // Untuk balance <= 1000 USDT
        } else {
            leverage = 5; // Untuk balance > 1000 USDT
        }
        
        // Ambil info market untuk cek leverage maksimal
        const market = exchange.markets[db.pair];
        const maxLeverage = market?.limits?.leverage?.max || 125;
        
        // Pastikan leverage tidak melebihi maksimal
        leverage = Math.min(leverage, maxLeverage);
        
        // Pastikan leverage minimal 5x
        leverage = Math.max(leverage, 5);
        
        console.log(`💰 Dynamic Leverage: ${leverage}x (Balance: ${totalUSDT.toFixed(2)} USDT)`);
        return leverage;
    } catch (error) {
        console.error("❌ Failed to calculate optimal leverage, using default 10x:", error.message);
        return 10;
    }
};

// -------------------- DYNAMIC POSITION SIZING DENGAN LEVERAGE --------------------
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

        // Hitung leverage optimal
        const leverage = await calculateOptimalLeverage(balance);
        
        // Hitung size dengan mempertimbangkan leverage dan risk management
        const riskPercent = Math.min(2, db.positionSizePercentage); // Maksimal risk 2% per trade
        const baseSize = totalUSDT * (riskPercent / 100);
        
        // Adjust dengan leverage (tapi jangan berlebihan)
        const leveragedSize = baseSize * Math.min(leverage / 10, 3); // Batasi pengaruh leverage
        
        const minTradeSize = 1; // Minimal 1 USDT
        const maxTradeSize = totalUSDT * 0.3; // Maksimal 30% dari balance
        
        let finalSize = Math.max(leveragedSize, minTradeSize);
        finalSize = Math.min(finalSize, maxTradeSize);
        
        // Cek daily loss limit
        const dailyLossLimit = totalUSDT * (db.maxDailyLossPercent / 100);
        if (performance.dailyPnL < -dailyLossLimit) {
            console.warn(`⚠️ Daily loss limit reached (${db.maxDailyLossPercent}%), reducing position size`);
            finalSize = finalSize * 0.5; // Kurangi size menjadi 50%
        }
        
        console.log(`💰 Dynamic Position Sizing:
   Total Balance: ${totalUSDT.toFixed(2)} USDT
   Risk Percentage: ${riskPercent}%
   Leverage: ${leverage}x
   Calculated Size: ${finalSize.toFixed(2)} USDT
   Daily PnL: ${performance.dailyPnL.toFixed(2)} USDT`);

        return finalSize;
    } catch (error) {
        console.error("❌ Failed to calculate dynamic position size, using fixed:", error.message);
        return db.usdtPerTrade;
    }
};

console.log(`⚙️ Bot Configuration:
- Pair: ${db.pair}
- Margin Mode: ${db.marginMode}
- Position Sizing: ${db.useDynamicPositionSizing ? `Dynamic (${db.positionSizePercentage}% of balance with auto-leverage)` : `Fixed (${db.usdtPerTrade} USDT)`}
- Max Daily Loss: ${db.maxDailyLossPercent}%
- Min R:R Ratio: ${db.minRRRatio}
- Trailing Stop: ${db.useTrailingStop ? `Enabled (${db.trailingStopPercent}%)` : 'Disabled'}
- Pyramid Entry: ${db.usePyramidEntry ? `Enabled (max ${db.maxPyramidEntries} entries)` : 'Disabled'}`);

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

const savePerformanceData = () => {
    try {
        fs.writeFileSync(performancePath, JSON.stringify(performance, null, 2));
    } catch (error) {
        console.error("❌ Failed to save performance data:", error.message);
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
        
        // Hitung leverage optimal
        const leverage = await calculateOptimalLeverage(balance);
        
        console.log(`💰 Balance Summary:
   Total: ${totalUSDT.toFixed(2)} USDT
   Free: ${freeUSDT.toFixed(2)} USDT
   Used: ${usedUSDT.toFixed(2)} USDT
   Optimal Leverage: ${leverage}x
   Daily PnL: ${performance.dailyPnL.toFixed(2)} USDT (${(performance.dailyPnL / totalUSDT * 100).toFixed(2)}%)
   Win Rate: ${(performance.winRate * 100).toFixed(1)}%`);
        
        return { totalUSDT, freeUSDT, usedUSDT, leverage };
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

const calcQty = async (price, leverage = null) => {
    if (!price) return 0;
    
    const currentUsdtPerTrade = await calculateDynamicPositionSize();
    
    // Jika leverage diberikan, adjust quantity
    if (leverage) {
        const adjustedTradeSize = currentUsdtPerTrade * leverage;
        let qty = adjustedTradeSize / price;
        const prec = exchange.markets[db.pair]?.precision?.amount ?? 3;
        qty = parseFloat(qty.toFixed(prec));
        
        // Pastikan tidak melebihi max position size exchange
        const market = exchange.markets[db.pair];
        if (market?.limits?.amount?.max && qty > market.limits.amount.max) {
            qty = market.limits.amount.max;
        }
        
        console.log(`📐 Quantity: ${qty} (${currentUsdtPerTrade.toFixed(2)} USDT × ${leverage}x leverage)`);
        return qty;
    }
    
    let qty = currentUsdtPerTrade / price;
    const prec = exchange.markets[db.pair]?.precision?.amount ?? 3;
    qty = parseFloat(qty.toFixed(prec));
    console.log(`📐 Quantity: ${qty} (${currentUsdtPerTrade.toFixed(2)} USDT)`);
    return qty;
};

const logSignal = (type, entry, tp, sl, status, pnl = null, leverage = null) => {
    try {
        const entryStr = entry !== undefined && entry !== null ? entry : "";
        const tpStr = tp !== undefined && tp !== null ? tp : "";
        const slStr = sl !== undefined && sl !== null ? sl : "";
        const pnlStr = pnl !== null && isFinite(pnl) ? Number(pnl).toFixed(6) : "";
        const leverageStr = leverage !== null && leverage !== undefined ? leverage : "";
        
        const balance = performance.totalPnL + 100; // Asumsi starting balance 100
        const balanceStr = balance.toFixed(2);
        
        const line = `${new Date().toISOString()},${db.pair},${type},${entryStr},${tpStr},${slStr},${status},${pnlStr},${leverageStr},${balanceStr}\n`;
        fs.appendFileSync(logPath, line);
        console.log("📝 Signal logged to CSV");
        
        // Update performance data jika trade selesai
        if (status.includes('REALIZED') || status.includes('CLOSED')) {
            if (pnl !== null && isFinite(pnl)) {
                performance.totalPnL += pnl;
                performance.dailyPnL += pnl;
                performance.totalTrades++;
                performance.dailyTrades++;
                
                if (pnl > 0) {
                    const wins = performance.winRate * (performance.totalTrades - 1);
                    performance.winRate = (wins + 1) / performance.totalTrades;
                } else {
                    const wins = performance.winRate * (performance.totalTrades - 1);
                    performance.winRate = wins / performance.totalTrades;
                }
                
                savePerformanceData();
                
                // Update last trade result
                db.lastTradeResult = pnl > 0 ? 'win' : 'loss';
                db.lastTradeTime = Date.now();
                saveDB();
            }
        }
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

        // Multiple timeframe analysis
        const ohlcv15m = await safeApiCall(exchange.fetchOHLCV, db.pair, "15m", undefined, 100);
        const close15m = ohlcv15m.map(c => c[4]);
        
        const maFast5 = SMA.calculate({ values: close.slice(-50), period: 5 });
        const maMedium5 = SMA.calculate({ values: close.slice(-50), period: 13 });
        const maSlow5 = SMA.calculate({ values: close.slice(-50), period: 21 });
        const maMedium15 = SMA.calculate({ values: close15m.slice(-50), period: 13 });

        const currentMAFast = maFast5[maFast5.length - 1];
        const currentMAMedium = maMedium5[maMedium5.length - 1];
        const currentMASlow = maSlow5[maSlow5.length - 1];
        const currentMAMedium15 = maMedium15[maMedium15.length - 1];

        const prevMAFast = maFast5[maFast5.length - 2];
        const prevMAMedium = maMedium5[maMedium5.length - 2];
        const prevMASlow = maSlow5[maSlow5.length - 2];

        const rsi = RSI.calculate({ values: close.slice(-50), period: 14 });
        const currentRSI = rsi[rsi.length - 1];

        // Stochastic RSI
        const stochRSI = (currentRSI - Math.min(...rsi.slice(-14))) / 
                        (Math.max(...rsi.slice(-14)) - Math.min(...rsi.slice(-14))) * 100;

        // Volume analysis
        const avgVolume = volume.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const currentVolume = volume[volume.length - 1];
        const volumeRatio = currentVolume / avgVolume;

        const isUptrend = currentMAFast > currentMAMedium && currentMAMedium > currentMASlow;
        const isDowntrend = currentMAFast < currentMAMedium && currentMAMedium < currentMASlow;

        const isFastCrossAboveMedium = currentMAFast > currentMAMedium && prevMAFast <= prevMAMedium;
        const isFastCrossBelowMedium = currentMAFast < currentMAMedium && prevMAFast >= prevMAMedium;

        const priceAboveAllMAs = price > currentMAFast && price > currentMAMedium && price > currentMASlow;
        const priceBelowAllMAs = price < currentMAFast && price < currentMAMedium && price < currentMASlow;

        // Higher timeframe confirmation
        const higherTFBullish = price > currentMAMedium15;
        const higherTFBearish = price < currentMAMedium15;

        let canLong = false;
        let canShort = false;
        let signalStrength = 0;

        // Long conditions dengan konfirmasi lebih ketat
        if ((isFastCrossAboveMedium || (isUptrend && priceAboveAllMAs)) && 
            currentRSI > 45 && currentRSI < 70 &&
            stochRSI > 20 && stochRSI < 80 &&
            volumeRatio > 1.2 && // Volume konfirmasi
            higherTFBullish) {
            canLong = true;
            signalStrength = 0.7 + (volumeRatio > 1.5 ? 0.2 : 0) + (stochRSI > 50 ? 0.1 : 0);
        }

        // Short conditions dengan konfirmasi lebih ketat
        if ((isFastCrossBelowMedium || (isDowntrend && priceBelowAllMAs)) && 
            currentRSI < 55 && currentRSI > 30 &&
            stochRSI > 20 && stochRSI < 80 &&
            volumeRatio > 1.2 && // Volume konfirmasi
            higherTFBearish) {
            canShort = true;
            signalStrength = 0.7 + (volumeRatio > 1.5 ? 0.2 : 0) + (stochRSI < 50 ? 0.1 : 0);
        }

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

        const currentATR = calculateATR(high, low, close, 14).pop() || 0;

        const enhancedLevels = findEnhancedLevels(high, low, close, volume, price);
        
        let resistance = enhancedLevels.resistance;
        let support = enhancedLevels.support;

        if (!resistance || !support) {
            console.log("🔄 Enhanced S/R detection failed, using dynamic fallback...");
            const recentHigh = Math.max(...high.slice(-50));
            const recentLow = Math.min(...low.slice(-50));
            
            resistance = recentHigh + (currentATR * 0.3);
            support = recentLow - (currentATR * 0.3);
        }

        // Adjust dengan signal strength
        const strengthMultiplier = 1 + (signalStrength * 0.3);
        
        const minDistance = currentATR * 0.6 * strengthMultiplier;
        const maxDistance = currentATR * 2.5 * strengthMultiplier;

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

        // Hitung Risk:Reward Ratio
        const riskLong = price - support;
        const rewardLong = resistance - price;
        const rrRatioLong = rewardLong / riskLong;

        const riskShort = resistance - price;
        const rewardShort = price - support;
        const rrRatioShort = rewardShort / riskShort;

        // Adjust TP/SL untuk memenuhi min RR ratio
        let targetLong = resistance;
        let stopLossLong = support;
        let targetShort = support;
        let stopLossShort = resistance;

        if (rrRatioLong < db.minRRRatio && canLong) {
            // Adjust untuk memenuhi RR ratio
            const requiredReward = riskLong * db.minRRRatio;
            targetLong = price + requiredReward;
            console.log(`📊 Adjusted Long TP for better RR: ${formatPrice(targetLong)} (RR: ${db.minRRRatio})`);
        }

        if (rrRatioShort < db.minRRRatio && canShort) {
            // Adjust untuk memenuhi RR ratio
            const requiredReward = riskShort * db.minRRRatio;
            targetShort = price - requiredReward;
            console.log(`📊 Adjusted Short TP for better RR: ${formatPrice(targetShort)} (RR: ${db.minRRRatio})`);
        }

        console.log(`\n🎯 ENHANCED Analysis Results ${db.pair}
══════════════════════════════════════════════════
📈 Long Signal: ${canLong ? `✅ VALID (Strength: ${signalStrength.toFixed(2)})` : "❌ INVALID"}
📉 Short Signal: ${canShort ? `✅ VALID (Strength: ${signalStrength.toFixed(2)})` : "❌ INVALID"}
══════════════════════════════════════════════════
💰 Current Price: ${formatPrice(price)}
📊 RSI: ${currentRSI ? currentRSI.toFixed(2) : "N/A"}
📊 Stoch RSI: ${stochRSI ? stochRSI.toFixed(2) : "N/A"}
📊 Volume Ratio: ${volumeRatio ? volumeRatio.toFixed(2) : "N/A"}x
🎯 Resistance: ${formatPrice(resistance)} (${((resistance - price) / price * 100).toFixed(3)}%)
🛡️  Support: ${formatPrice(support)} (${((price - support) / price * 100).toFixed(3)}%)
📈 MA Fast: ${formatPrice(currentMAFast)}
📈 MA Medium: ${formatPrice(currentMAMedium)}
📈 MA Slow: ${formatPrice(currentMASlow)}
📈 MA 15m: ${formatPrice(currentMAMedium15)}
📊 ATR: ${formatPrice(currentATR)} (${(currentATR/price*100).toFixed(3)}%)
📊 RR Ratio Long: ${rrRatioLong.toFixed(2)} | Short: ${rrRatioShort.toFixed(2)}
══════════════════════════════════════════════════
📊 Volume POC: ${formatPrice(enhancedLevels.volumePOC)}
🔍 Detected R Levels: ${enhancedLevels.allResistance?.length || 0}
🔍 Detected S Levels: ${enhancedLevels.allSupport?.length || 0}
══════════════════════════════════════════════════`);

        if (enhancedLevels.allResistance && enhancedLevels.allResistance.length > 0) {
            console.log("📈 Top Resistance Levels:");
            enhancedLevels.allResistance.slice(0, 3).forEach(level => {
                console.log(`   - ${formatPrice(level.price)} (conf: ${level.confidence.toFixed(2)})`);
            });
        }

        if (enhancedLevels.allSupport && enhancedLevels.allSupport.length > 0) {
            console.log("📉 Top Support Levels:");
            enhancedLevels.allSupport.slice(0, 3).forEach(level => {
                console.log(`   - ${formatPrice(level.price)} (conf: ${level.confidence.toFixed(2)})`);
            });
        }

        return {
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
            signalStrength,
            volumeRatio,
            rrRatioLong,
            rrRatioShort
        };
    } catch (error) {
        console.error("❌ Enhanced technical analysis failed:", error.message);
        return {};
    }
};

// -------------------- TRAILING STOP MANAGEMENT --------------------
const updateTrailingStop = async (currentPrice) => {
    if (!db.activePosition || !db.useTrailingStop) return;

    const { side, entryPrice, sl, tp } = db.activePosition;
    const trailPercent = db.trailingStopPercent / 100;

    if (side === "buy") {
        // Untuk long position, naikkan stop loss jika harga naik
        const newTrailingSL = currentPrice * (1 - trailPercent);
        if (newTrailingSL > sl && newTrailingSL < currentPrice) {
            db.activePosition.sl = newTrailingSL;
            saveDB();
            console.log(`📈 Trailing SL updated: ${formatPrice(sl)} → ${formatPrice(newTrailingSL)}`);
        }
    } else {
        // Untuk short position, turunkan stop loss jika harga turun
        const newTrailingSL = currentPrice * (1 + trailPercent);
        if (newTrailingSL < sl && newTrailingSL > currentPrice) {
            db.activePosition.sl = newTrailingSL;
            saveDB();
            console.log(`📉 Trailing SL updated: ${formatPrice(sl)} → ${formatPrice(newTrailingSL)}`);
        }
    }
};

// -------------------- PYRAMID ENTRY MANAGEMENT --------------------
const checkPyramidEntry = async (signal) => {
    if (!db.usePyramidEntry || !db.activePosition) return false;

    const { side, entryPrice, pyramidEntries = 1 } = db.activePosition;
    const currentPrice = await getPrice();
    
    if (!currentPrice) return false;

    // Cek apakah sudah mencapai maksimal entries
    if (pyramidEntries >= db.maxPyramidEntries) {
        console.log("⏹️ Maximum pyramid entries reached");
        return false;
    }

    // Cek jarak dari entry terakhir
    const distancePercent = Math.abs(currentPrice - entryPrice) / entryPrice * 100;
    
    if (distancePercent >= db.pyramidDistancePercent) {
        console.log(`🎯 Pyramid entry opportunity: ${distancePercent.toFixed(2)}% from last entry`);
        
        // Place additional order
        const positionSize = await calculateDynamicPositionSize();
        const adjustedSize = positionSize * 0.5; // Gunakan 50% dari size normal untuk pyramid
        
        try {
            const qty = await calcQty(currentPrice);
            const adjustedQty = qty * 0.5;
            
            await safeApiCall(exchange.createOrder, db.pair, "market", side, adjustedQty);
            
            // Update active position
            const totalQty = (db.activePosition.quantity || qty) + adjustedQty;
            const avgEntryPrice = ((db.activePosition.entryPrice * (db.activePosition.quantity || qty)) + 
                                 (currentPrice * adjustedQty)) / totalQty;
            
            db.activePosition.entryPrice = avgEntryPrice;
            db.activePosition.quantity = totalQty;
            db.activePosition.pyramidEntries = pyramidEntries + 1;
            saveDB();
            
            console.log(`✅ Pyramid entry #${pyramidEntries + 1} placed at ${formatPrice(currentPrice)}`);
            return true;
        } catch (error) {
            console.error("❌ Pyramid entry failed:", error.message);
            return false;
        }
    }
    
    return false;
};

// -------------------- ORDER MANAGEMENT --------------------
const placeOrder = async (side, tp, sl) => {
    // Cek cooling period setelah loss
    if (db.lastTradeResult === 'loss' && Date.now() - db.lastTradeTime < db.coolingPeriod) {
        const remainingTime = Math.ceil((db.coolingPeriod - (Date.now() - db.lastTradeTime)) / 1000);
        console.log(`⏳ Cooling period active (${remainingTime}s remaining after loss)`);
        return;
    }

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

    // Dapatkan leverage optimal
    const balance = await safeApiCall(exchange.fetchBalance);
    const leverage = await calculateOptimalLeverage(balance);
    
    const qty = await calcQty(price, leverage);
    console.log(`➡️ ENTRY ${side.toUpperCase()}
- Quantity: ${qty}
- Entry: ${formatPrice(price)}
- TP: ${formatPrice(tp)}
- SL: ${formatPrice(sl)}
- Leverage: ${leverage}x`);

    try {
        await safeApiCall(exchange.setLeverage, leverage, db.pair);
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
            quantity: qty,
            leverage: leverage,
            pyramidEntries: 1
        };
        saveDB();

        logSignal(
            side === "buy" ? "LONG" : "SHORT",
            price,
            tp,
            sl,
            "ORDER_PLACED",
            null,
            leverage
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
                const { tp, sl, side: entrySide, leverage } = db.activePosition;
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
                        pnl = pnlGross * closedQty * leverage;
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
                pnl,
                db.activePosition?.leverage
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
        const { position } = await getPositionFromBalance();
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
            const { tp, sl, side, entryPrice } = db.activePosition;
            const currentPrice = await getPrice();
            if (!currentPrice) return;

            // Update trailing stop
            await updateTrailingStop(currentPrice);

            // Cek pyramid entry
            await checkPyramidEntry();

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
            const leverage = position?.leverage || 10;

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
                recoveredAt: new Date().toISOString(),
                leverage: leverage
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
                "POSITION_RECOVERED",
                null,
                leverage
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
                "CLOSED_EXTERNALLY",
                null,
                db.activePosition.leverage
            );

            db.activePosition = null;
            saveDB();
            console.log("✅ Database cleaned");
        }

        if (db.activePosition && Math.abs(amtSafe) > MIN_POSITION_AMOUNT) {
            const currentPrice = await getPrice();
            if (currentPrice) {
                const { side, entryPrice, tp, sl, leverage } = db.activePosition;
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
                console.log(`   ${pnlEmoji} PnL: ${formatPrice(unrealizedPnl * leverage)} (${pnlPercent}%)`);
                console.log(`   Leverage: ${leverage}x | Unrealized: ${formatPrice(unrealizedPnl)}`);
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

(async () => {
    await initializeExchange();
    
    console.log("\n💰 Initial Account Balance:");
    await displayBalance();
    
    const initialPositionSize = await calculateDynamicPositionSize();
    console.log(`📊 Initial Position Size: ${initialPositionSize.toFixed(2)} USDT`);
    
    console.log("\n🚀 Bot started with ENHANCED S/R detection, DYNAMIC LEVERAGE & POSITION SIZING");
    
    // Tampilkan performance
    console.log(`\n📈 Performance Summary:
   Total PnL: ${performance.totalPnL.toFixed(2)} USDT
   Daily PnL: ${performance.dailyPnL.toFixed(2)} USDT
   Total Trades: ${performance.totalTrades}
   Daily Trades: ${performance.dailyTrades}
   Win Rate: ${(performance.winRate * 100).toFixed(1)}%`);
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
        db.marginMode = freshDb.marginMode;
        db.usdtPerTrade = freshDb.usdtPerTrade;
        db.useDynamicPositionSizing = freshDb.useDynamicPositionSizing;
        db.positionSizePercentage = freshDb.positionSizePercentage;
        db.maxDailyLossPercent = freshDb.maxDailyLossPercent;
        db.minRRRatio = freshDb.minRRRatio;
        db.useTrailingStop = freshDb.useTrailingStop;
        db.trailingStopPercent = freshDb.trailingStopPercent;
        db.usePyramidEntry = freshDb.usePyramidEntry;
        db.maxPyramidEntries = freshDb.maxPyramidEntries;
        db.pyramidDistancePercent = freshDb.pyramidDistancePercent;
        db.coolingPeriod = freshDb.coolingPeriod;
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

        const hasBotPosition = db.activePosition !== null;
        let shouldExitCurrentPosition = false;

        if (hasBotPosition) {
            const currentSide = db.activePosition.side;
            if (currentSide === "buy" && signal.canShort && signal.signalStrength > 0.8) {
                console.log("⚠️ STRONG SHORT signal detected, closing LONG");
                shouldExitCurrentPosition = true;
            } else if (currentSide === "sell" && signal.canLong && signal.signalStrength > 0.8) {
                console.log("⚠️ STRONG LONG signal detected, closing SHORT");
                shouldExitCurrentPosition = true;
            }
        }

        if (shouldExitCurrentPosition) {
            await closePosition("Signal reversal", db.activePosition.entryPrice);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        const { position } = await getPositionFromBalance();
        const amt = parseFloat(position?.positionAmt || "0");
        const hasActiveBinancePositionAfterClose = isFinite(amt) && Math.abs(amt) > 0;

        if (db.activePosition === null && !hasActiveBinancePositionAfterClose) {
            // Cek daily loss limit
            const balance = await safeApiCall(exchange.fetchBalance);
            const totalUSDT = balance.total?.USDT || 0;
            const dailyLossLimit = totalUSDT * (db.maxDailyLossPercent / 100);
            
            if (performance.dailyPnL < -dailyLossLimit) {
                console.log(`⛔ Daily loss limit reached (${db.maxDailyLossPercent}%), skipping trades`);
                return;
            }

            if (signal.canLong && signal.signalStrength > 0.6 && signal.rrRatioLong >= db.minRRRatio) {
                const isLongBreakout = signal.price > signal.targetLong;
                if (!isLongBreakout) {
                    console.log(`🚀 LONG Signal | TP: ${formatPrice(signal.targetLong)} | SL: ${formatPrice(signal.stopLossLong)} | RR: ${signal.rrRatioLong.toFixed(2)}`);
                    db.lastLongEntryTime = now;
                    saveDB();
                    await placeOrder("buy", signal.targetLong, signal.stopLossLong);
                } else {
                    console.log(`⏸️ LONG Signal: Breakout detected, skipping`);
                }
            } else if (signal.canShort && signal.signalStrength > 0.6 && signal.rrRatioShort >= db.minRRRatio) {
                const isShortBreakout = signal.price < signal.targetShort;
                if (!isShortBreakout) {
                    console.log(`📉 SHORT Signal | TP: ${formatPrice(signal.targetShort)} | SL: ${formatPrice(signal.stopLossShort)} | RR: ${signal.rrRatioShort.toFixed(2)}`);
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
            const balanceInfo = await displayBalance();
            const currentPositionSize = await calculateDynamicPositionSize();
            console.log(`📊 Current Position Size: ${currentPositionSize.toFixed(2)} USDT`);
            
            // Update performance display
            console.log(`📈 Performance Update:
   Daily PnL: ${performance.dailyPnL.toFixed(2)} USDT
   Daily Trades: ${performance.dailyTrades}
   Win Rate: ${(performance.winRate * 100).toFixed(1)}%`);
        }
    } catch (err) {
        console.error("⚠️ Main loop error:", err.message);
    } finally {
        isProcessing = false;
    }
}, 10000);