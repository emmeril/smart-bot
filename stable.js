// bot.js (Fixed Price Monitoring Version)
require("dotenv").config();
const fs = require("fs");
const ccxt = require("ccxt");
const { SMA } = require("technicalindicators");
const WebSocket = require('ws');

// -------------------- CONFIG --------------------
const dbPath = "./db.json";
const logPath = "./log.csv";
const config = {
    loopInterval: 15000,
    healthCheckInterval: 30000,
    maxRetries: 3,
    requestTimeout: 10000,
    enableWebSocket: true,
    logLevel: "info"
};

let isProcessing = false;

// -------------------- WEBSOCKET PRICE MONITOR --------------------
class PriceMonitor {
    constructor() {
        this.currentPrice = null;
        this.ws = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.lastUpdateTime = null;
    }

    connect() {
        try {
            const symbol = this.getSymbolForWebSocket();
            console.log(`🔗 Connecting WebSocket for: ${symbol}`);
            this.ws = new WebSocket(`wss://fstream.binance.com/ws/${symbol}@ticker`);
            
            this.ws.on('open', () => {
                console.log("✅ WebSocket connected for real-time price");
                this.isConnected = true;
                this.reconnectAttempts = 0;
            });

            this.ws.on('message', (data) => {
                try {
                    const parsed = JSON.parse(data);
                    this.currentPrice = parseFloat(parsed.c);
                    this.lastUpdateTime = Date.now();
                } catch (err) {
                    console.error("❌ WebSocket parse error:", err.message);
                }
            });

            this.ws.on('close', () => {
                console.log("🔌 WebSocket disconnected");
                this.isConnected = false;
                this.handleReconnect();
            });

            this.ws.on('error', (err) => {
                console.error("❌ WebSocket error:", err.message);
                this.isConnected = false;
            });

        } catch (err) {
            console.error("❌ WebSocket connection failed:", err.message);
            this.handleReconnect();
        }
    }

    getSymbolForWebSocket() {
        // Format: dogeusdt untuk futures
        return db.pair.split('/')[0].toLowerCase() + 'usdt';
    }

    handleReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`🔄 Reconnecting WebSocket (attempt ${this.reconnectAttempts})...`);
            setTimeout(() => this.connect(), 3000);
        } else {
            console.error("❌ Max reconnection attempts reached");
        }
    }

    getPrice() {
        // Jika WebSocket stuck, return null untuk force REST API
        if (this.lastUpdateTime && Date.now() - this.lastUpdateTime > 30000) {
            console.log("⚠️ WebSocket data stale");
            this.isConnected = false;
            return null;
        }
        return this.currentPrice;
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
        }
    }
}

// Initialize WebSocket
const priceMonitor = new PriceMonitor();

// -------------------- FILE INIT --------------------
if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, "timestamp,pair,type,entry,tp,sl,status,pnl\n");
    console.log("📝 Log file created: log.csv");
}

let db = fs.existsSync(dbPath) ?
    JSON.parse(fs.readFileSync(dbPath)) : {
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

// -------------------- EXCHANGE --------------------
const exchange = new ccxt.binance({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 
        defaultType: "future",
        adjustForTimeDifference: true,
        recvWindow: 60000,
    },
    timeout: config.requestTimeout,
    enableRateLimit: true,
});

// Initialize exchange
(async () => {
    try {
        await exchange.loadMarkets();
        console.log("✅ Markets loaded successfully");
        
        if (config.enableWebSocket) {
            setTimeout(() => priceMonitor.connect(), 2000);
        }
    } catch (err) {
        console.error("❌ Failed to load markets:", err.message);
    }
})();

// -------------------- UTIL FUNCTIONS --------------------
const saveDB = () => {
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
};

const formatPrice = (price, pair = db.pair) => {
    if (!price || !isFinite(price)) return "N/A";
    try {
        const market = exchange.markets[pair];
        let decimals = market?.precision?.price ?? 5;
        return parseFloat(price.toFixed(decimals));
    } catch (err) {
        return parseFloat(price.toFixed(5));
    }
};

// **FIXED: Harga REAL-TIME untuk semua keperluan**
const getPrice = async () => {
    let price = null;
    
    // Priority 1: WebSocket
    if (config.enableWebSocket && priceMonitor.isConnected) {
        price = priceMonitor.getPrice();
        if (price) {
            return price;
        }
    }

    // Priority 2: REST API
    try {
        const ticker = await exchange.fetchTicker(db.pair);
        price = ticker.last;
        console.log(`💰 Price ${db.pair}: ${formatPrice(price)}`);
        return price;
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
    return qty;
};

const logSignal = (type, entry, tp, sl, status, pnl = null) => {
    const entryStr = entry !== undefined && entry !== null ? entry : "";
    const tpStr = tp !== undefined && tp !== null ? tp : "";
    const slStr = sl !== undefined && sl !== null ? sl : "";
    const pnlStr = pnl !== null && isFinite(pnl) ? Number(pnl).toFixed(6) : "";
    const line = `${new Date().toISOString()},${db.pair},${type},${entryStr},${tpStr},${slStr},${status},${pnlStr}\n`;
    fs.appendFileSync(logPath, line);
    console.log("📝 Signal logged to CSV");
};

const getPositionFromBalance = async () => {
    try {
        const balance = await exchange.fetchBalance();
        const positions = balance.info?.positions || [];
        const symbol = db.pair.replace('/', '').replace('USDT:USDT', 'USDT');
        
        const position = positions.find(p => 
            p.symbol === symbol || p.symbol === symbol.replace('USDT', '')
        );

        return { balance, position };
    } catch (err) {
        console.error("❌ Failed to fetch position:", err.message);
        return { balance: null, position: null };
    }
};

// -------------------- ORDER MANAGEMENT --------------------
const placeOrder = async (side, tp, sl) => {
    if (db.activePosition) {
        console.log("⚠️ Active position exists, order cancelled");
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
        await exchange.setLeverage(db.leverage, db.pair);
        await exchange.setMarginMode(db.marginMode, db.pair);
        
        const order = await exchange.createOrder(db.pair, "market", side, qty);
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
            
            await exchange.createOrder(db.pair, "market", side, amount, undefined, {
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

            // PnL Calculation
            if (entryPrice !== "N/A" && db.activePosition && exitPrice) {
                const { side: entrySide } = db.activePosition;
                const entryNum = parseFloat(entryPrice);
                const exitNum = parseFloat(exitPrice);
                
                if (entrySide === "buy") {
                    pnl = (exitNum - entryNum) * amount;
                } else {
                    pnl = (entryNum - exitNum) * amount;
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

// -------------------- TECHNICAL ANALYSIS --------------------
const analyzeSignal = async () => {
    console.log("🧠 Technical analysis started...");
    try {
        const ohlcv = await exchange.fetchOHLCV(db.pair, "15m", undefined, 100);
        
        if (!ohlcv || ohlcv.length < 50) {
            console.warn("⚠️ Insufficient OHLCV data");
            return {};
        }

        const close = ohlcv.map(c => c[4]);
        const high = ohlcv.map(c => c[2]);
        const low = ohlcv.map(c => c[3]);

        // Moving Averages
        const ma7 = SMA.calculate({ values: close, period: 7 }).pop();
        const ma25 = SMA.calculate({ values: close, period: 25 }).pop();
        const ma50 = SMA.calculate({ values: close, period: 50 }).pop();

        const price = close[close.length - 1];

        // Previous values for crossover detection
        const prevMA7 = SMA.calculate({ values: close.slice(0, -1), period: 7 }).pop();
        const prevMA25 = SMA.calculate({ values: close.slice(0, -1), period: 25 }).pop();

        const isCrossedUp = ma7 > ma25 && prevMA7 <= prevMA25;
        const isCrossedDown = ma7 < ma25 && prevMA7 >= prevMA25;

        let canLong = false;
        let canShort = false;

        // Trend detection
        const isUptrend = ma7 > ma50 && ma25 > ma50;
        const isDowntrend = ma7 < ma50 && ma25 < ma50;

        if (isCrossedUp && isUptrend) {
            canLong = true;
        }

        if (isCrossedDown && isDowntrend) {
            canShort = true;
        }

        // Support/Resistance
        const recentHigh = Math.max(...high.slice(-20));
        const recentLow = Math.min(...low.slice(-20));
        
        // ATR for volatility
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
            
            return atr.pop() || 0;
        };

        const atr = calculateATR(high, low, close, 14);
        
        // TP/SL based on ATR
        const atrMultiplier = 2;
        const targetLong = price + (atr * atrMultiplier);
        const stopLossLong = price - (atr * atrMultiplier);
        const targetShort = price - (atr * atrMultiplier);
        const stopLossShort = price + (atr * atrMultiplier);

        console.log(`\n📊 Analysis Results ${db.pair}
─────────────────────────────────────
📈 Long Signal: ${canLong ? "✅ VALID" : "❌ INVALID"}
📉 Short Signal: ${canShort ? "✅ VALID" : "❌ INVALID"}
─────────────────────────────────────
💰 Current Price: ${formatPrice(price)}
🎯 Resistance: ${formatPrice(recentHigh)}
🛡️ Support: ${formatPrice(recentLow)}
📊 ATR: ${formatPrice(atr)}
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
    } catch (err) {
        console.error("❌ Technical analysis failed:", err.message);
        return {};
    }
};

// **FIXED: POSITION MONITORING dengan harga REAL-TIME**
const checkPositionStatus = async () => {
    try {
        if (!db.activePosition) return;

        // **PERBAIKAN PENTING: Gunakan harga REAL-TIME, bukan harga dari position**
        const currentPrice = await getPrice();
        if (!currentPrice) return;

        const { tp, sl, side, entryPrice } = db.activePosition;

        console.log(`📊 Position Check: ${side.toUpperCase()} | Current: ${formatPrice(currentPrice)} | TP: ${formatPrice(tp)} | SL: ${formatPrice(sl)}`);

        if (side === "buy") {
            if (currentPrice >= tp) {
                console.log("🎯 TP Hit for LONG position");
                await closePosition("TP hit", entryPrice);
            } else if (currentPrice <= sl) {
                console.log("🛑 SL Hit for LONG position");
                await closePosition("SL hit", entryPrice);
            }
        } else if (side === "sell") {
            if (currentPrice <= tp) {
                console.log("🎯 TP Hit for SHORT position");
                await closePosition("TP hit", entryPrice);
            } else if (currentPrice >= sl) {
                console.log("🛑 SL Hit for SHORT position");
                await closePosition("SL hit", entryPrice);
            }
        }
    } catch (err) {
        console.error("❌ Position check failed:", err.message);
    }
};

// -------------------- TP/SL UPDATE --------------------
const updateTPSLForOpenPosition = async (signal) => {
    if (!db.activePosition || !signal.price) return;
    
    try {
        console.log("🔄 Checking TP/SL updates...");
        
        const { side, entryPrice, tp: currentTP, sl: currentSL } = db.activePosition;
        let newTP = currentTP;
        let newSL = currentSL;

        const priceChangeThreshold = 0.5; // 0.5% change minimum untuk update

        if (side === "buy") {
            // Untuk LONG, hanya update jika signal memberikan level yang lebih baik
            if (signal.targetLong > currentTP) {
                const improvement = ((signal.targetLong - currentTP) / currentTP * 100);
                if (improvement >= priceChangeThreshold) {
                    newTP = signal.targetLong;
                    console.log(`📈 Improving LONG TP: ${formatPrice(currentTP)} → ${formatPrice(newTP)} (${improvement.toFixed(2)}%)`);
                }
            }
            
            if (signal.stopLossLong > currentSL) {
                const improvement = ((signal.stopLossLong - currentSL) / currentSL * 100);
                if (improvement >= priceChangeThreshold) {
                    newSL = signal.stopLossLong;
                    console.log(`🛡️ Improving LONG SL: ${formatPrice(currentSL)} → ${formatPrice(newSL)} (${improvement.toFixed(2)}%)`);
                }
            }
            
        } else if (side === "sell") {
            // Untuk SHORT, hanya update jika signal memberikan level yang lebih baik
            if (signal.targetShort < currentTP) {
                const improvement = ((currentTP - signal.targetShort) / currentTP * 100);
                if (improvement >= priceChangeThreshold) {
                    newTP = signal.targetShort;
                    console.log(`📉 Improving SHORT TP: ${formatPrice(currentTP)} → ${formatPrice(newTP)} (${improvement.toFixed(2)}%)`);
                }
            }
            
            if (signal.stopLossShort < currentSL) {
                const improvement = ((currentSL - signal.stopLossShort) / currentSL * 100);
                if (improvement >= priceChangeThreshold) {
                    newSL = signal.stopLossShort;
                    console.log(`🛡️ Improving SHORT SL: ${formatPrice(currentSL)} → ${formatPrice(newSL)} (${improvement.toFixed(2)}%)`);
                }
            }
        }

        // Only update if there are meaningful changes
        if (newTP !== currentTP || newSL !== currentSL) {
            db.activePosition.tp = newTP;
            db.activePosition.sl = newSL;
            saveDB();

            console.log(`✅ TP/SL Updated for ${side.toUpperCase()}:`);
            console.log(`   TP: ${formatPrice(currentTP)} → ${formatPrice(newTP)}`);
            console.log(`   SL: ${formatPrice(currentSL)} → ${formatPrice(newSL)}`);
            
            logSignal(
                side === "buy" ? "LONG" : "SHORT",
                entryPrice,
                newTP,
                newSL,
                "TP_SL_UPDATED"
            );
        } else {
            console.log("ℹ️ No meaningful TP/SL changes needed");
        }

    } catch (error) {
        console.error("❌ TP/SL update failed:", error.message);
    }
};

// **FIXED: POSITION RECOVERY dengan harga REAL-TIME**
const recoverPositionState = async () => {
    try {
        const { position } = await getPositionFromBalance();
        const amt = parseFloat(position?.positionAmt || "0");
        const MIN_POSITION_AMOUNT = 0.000001;
        
        // Recovery needed
        if (Math.abs(amt) > MIN_POSITION_AMOUNT && !db.activePosition) {
            console.log("⚠️ Position recovery needed");
            
            // **PERBAIKAN: Gunakan harga REAL-TIME untuk recovery**
            const currentPrice = await getPrice();
            if (!currentPrice) return;
            
            const side = amt > 0 ? "buy" : "sell";
            const entryPrice = parseFloat(position?.entryPrice || currentPrice);
            
            // Simple TP/SL calculation for recovery
            const riskRewardRatio = 1.5;
            let tp, sl;
            
            if (side === "buy") {
                tp = currentPrice * 1.015; // 1.5% TP dari harga CURRENT
                sl = currentPrice * 0.985; // 1.5% SL dari harga CURRENT
            } else {
                tp = currentPrice * 0.985; // 1.5% TP dari harga CURRENT  
                sl = currentPrice * 1.015; // 1.5% SL dari harga CURRENT
            }
            
            db.activePosition = { 
                side, 
                entryPrice, 
                tp, 
                sl, 
                orderId: "RECOVERED_" + Date.now(),
                recovered: true 
            };
            
            saveDB();
            console.log("✅ Position recovered with CURRENT market prices");
        }
        
        // **FIXED: POSITION MONITOR dengan harga REAL-TIME**
        if (db.activePosition) {
            const currentPrice = await getPrice();
            if (currentPrice) {
                const { side, entryPrice, tp, sl } = db.activePosition;
                
                // **PERBAIKAN: Hitung PnL dengan harga REAL-TIME**
                const unrealizedPnl = side === "buy" ? 
                    (currentPrice - entryPrice) : 
                    (entryPrice - currentPrice);
                const pnlPercent = (unrealizedPnl / entryPrice * 100).toFixed(2);
                
                // Determine position status
                let status = "🟢 NORMAL";
                if (side === "buy") {
                    if (currentPrice >= tp * 0.995) status = "🟡 NEAR TP";
                    if (currentPrice <= sl * 1.005) status = "🔴 NEAR SL";
                } else {
                    if (currentPrice <= tp * 1.005) status = "🟡 NEAR TP";
                    if (currentPrice >= sl * 0.995) status = "🔴 NEAR SL";
                }
                
                const pnlEmoji = unrealizedPnl >= 0 ? "💹" : "🔻";
                
                console.log(`\n📊 Position Monitor
   ${side.toUpperCase()} | ${status}
   Entry: ${formatPrice(entryPrice)} | Current: ${formatPrice(currentPrice)}
   TP: ${formatPrice(tp)} | SL: ${formatPrice(sl)}
   ${pnlEmoji} PnL: ${formatPrice(unrealizedPnl)} (${pnlPercent}%)`);
            }
        }
        
    } catch (err) {
        console.error("❌ Recovery error:", err.message);
    }
};

// -------------------- MAIN TRADING LOGIC --------------------
const executeTradingCycle = async () => {
    if (isProcessing) {
        console.log("⏳ Skipping: Still processing...");
        return;
    }
    
    isProcessing = true;
    
    try {
        // Reload config
        try {
            const freshDb = JSON.parse(fs.readFileSync(dbPath));
            Object.assign(db, freshDb);
        } catch (error) {
            // Use existing config
        }

        // Position recovery & monitoring
        await recoverPositionState();
        await checkPositionStatus();

        // Get current signal
        console.log("🔍 Checking for new signals...");
        const signal = await analyzeSignal();
        
        if (!signal.price) {
            console.log("⚠️ No valid signal data");
            return;
        }

        // Update TP/SL for open positions
        if (db.activePosition) {
            await updateTPSLForOpenPosition(signal);
        }

        // Check for new entry signals
        if (!db.activePosition) {
            if (signal.canLong) {
                console.log(`🚀 LONG Signal | TP: ${formatPrice(signal.targetLong)} | SL: ${formatPrice(signal.stopLossLong)}`);
                await placeOrder("buy", signal.targetLong, signal.stopLossLong);
            } else if (signal.canShort) {
                console.log(`📉 SHORT Signal | TP: ${formatPrice(signal.targetShort)} | SL: ${formatPrice(signal.stopLossShort)}`);
                await placeOrder("sell", signal.targetShort, signal.stopLossShort);
            } else {
                console.log("💤 No valid entry signals");
            }
        }
        
    } catch (err) {
        console.error("⚠️ Trading cycle error:", err.message);
    } finally {
        isProcessing = false;
    }
};

// -------------------- START BOT --------------------
console.log("✅ Bot started with REAL-TIME price monitoring");
console.log(`🔄 Loop interval: ${config.loopInterval/1000} seconds`);
console.log(`🔗 WebSocket: ${config.enableWebSocket ? 'ENABLED' : 'DISABLED'}`);

// Main loop
setInterval(executeTradingCycle, config.loopInterval);

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🔴 Shutting down gracefully...');
    priceMonitor.disconnect();
    process.exit(0);
});