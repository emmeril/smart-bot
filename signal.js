require("dotenv").config();
const fs = require("fs");
const path = require("path");
const ccxt = require("ccxt");
const { RSI, EMA } = require("technicalindicators");

// -------------------- CONFIG --------------------
const dbPath = "./db.json";
const logPath = "./log.csv";
let isProcessing = false;
let exchange = null;
let signalCount = 0;
let lastLogTime = Date.now();
let lastPnlLog = Date.now();
let lastConfigReload = Date.now();
let db = null;

// Trend data
let trendData = { ema: null, lastUpdate: 0, timeframe: "1h", period: 200 };

// -------------------- ENSURE FILE EXISTS --------------------
const ensureFileExists = (filePath, defaultContent = "{}") => {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, defaultContent, 'utf8');
            console.log(`✅ Created ${path.basename(filePath)} file`);
        }
        return true;
    } catch (error) {
        console.error(`❌ Failed to create ${path.basename(filePath)}:`, error.message);
        return false;
    }
};

// -------------------- DEFAULT CONFIG --------------------
const getDefaultConfig = () => {
    return {
        pair: "DOGE/USDT:USDT",
        usdtPerTrade: 10,
        leverage: 10,
        targetProfitUSDT: 1.0,
        targetDailyProfit: 2.0,
        maxDailyLossPercent: 10,
        maxTradesPerDay: 2,
        coolingPeriod: 3000,
        activePosition: null,
        dailyPnL: 0,
        dailyTrades: 0,
        marginMode: "isolated",
        monitoringInterval: 500,
        stopLossPercent: 10,
        breakoutPeriod: 20,               // periode untuk mencari resistance/support (jumlah candle)
        breakoutTimeframe: "5m",            // TIMEFRAME 5 MENIT
        minBreakoutStrength: 0.003,         // DIPERBESAR (0.3% dari range)
        volumePeriod: 20,
        minVolumeRatio: 2.0,                // DIPERBESAR (2x rata-rata)
        trendEnabled: true,
        trendTimeframe: "1h",
        trendPeriod: 200,
        lastDailyReset: Date.now(),
        lastUpdated: Date.now()
    };
};

// -------------------- INITIALIZE DB --------------------
const initializeDB = () => {
    try {
        ensureFileExists(dbPath, JSON.stringify(getDefaultConfig(), null, 2));
        if (fs.existsSync(dbPath)) {
            const data = fs.readFileSync(dbPath, 'utf8');
            if (!data || data.trim() === '') throw new Error("Empty DB");
            const parsedData = JSON.parse(data);
            const defaultConfig = getDefaultConfig();
            const validatedConfig = { ...defaultConfig, ...parsedData };
            Object.keys(defaultConfig).forEach(key => {
                if (!(key in validatedConfig) || validatedConfig[key] === undefined) {
                    validatedConfig[key] = defaultConfig[key];
                }
            });
            db = validatedConfig;
            console.log("✅ DB initialized successfully");
        } else {
            console.log("📝 Creating new DB file...");
            db = getDefaultConfig();
            fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
        }
        return true;
    } catch (error) {
        console.error("❌ Error initializing DB:", error.message);
        if (fs.existsSync(dbPath)) {
            const backupPath = `${dbPath}.backup.${Date.now()}`;
            fs.copyFileSync(dbPath, backupPath);
            console.log(`📦 Backup corrupted file: ${backupPath}`);
        }
        db = getDefaultConfig();
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
        console.log("✅ Created fresh config");
        return true;
    }
};

// -------------------- RELOAD CONFIG --------------------
const reloadConfig = () => {
    try {
        if (!db || !fs.existsSync(dbPath)) return false;
        const data = fs.readFileSync(dbPath, 'utf8');
        if (!data) return false;
        const freshConfig = JSON.parse(data);
        if (db.activePosition && !freshConfig.activePosition) {
            freshConfig.activePosition = db.activePosition;
        }
        if (db.dailyTrades > freshConfig.dailyTrades) {
            freshConfig.dailyPnL = db.dailyPnL;
            freshConfig.dailyTrades = db.dailyTrades;
        }
        Object.keys(freshConfig).forEach(key => db[key] = freshConfig[key]);
        return true;
    } catch (error) {
        console.error("❌ Failed to reload config:", error.message);
        return false;
    }
};

// -------------------- SYNC POSITION WITH EXCHANGE --------------------
const syncPositionWithExchange = async () => {
    try {
        if (!db || !exchange) return;
        console.log(`🔄 Sync: Checking positions for ${db.pair}...`);
        const positions = await exchange.fetchPositions();
        let openPosition = null;
        const normalizeSymbol = (symbol) => symbol.toUpperCase().trim();
        const dbPairNormalized = normalizeSymbol(db.pair);
        for (const position of positions) {
            if (normalizeSymbol(position.symbol) === dbPairNormalized && Math.abs(parseFloat(position.contracts || 0)) > 0) {
                openPosition = position;
                break;
            }
        }
        if (!openPosition) {
            if (db.activePosition) {
                console.log("⚠️ DB has activePosition but exchange doesn't. Resetting...");
                db.activePosition = null;
                saveDB();
            }
            return;
        }
        const contracts = parseFloat(openPosition.contracts || 0);
        const side = openPosition.side === 'long' ? 'buy' : 'sell';
        const entryPrice = parseFloat(openPosition.entryPrice || 0) || (await getPrice());
        if (!db.activePosition) {
            db.activePosition = {
                side: side,
                entryPrice: entryPrice,
                targetPrice: null,
                stopLossPrice: null,
                stopLossUSDT: db.usdtPerTrade * (db.stopLossPercent / 100),
                orderId: `SYNC_${Date.now()}`,
                quantity: Math.abs(contracts),
                entryTime: Date.now() - 300000,
                marginMode: "isolated",
                targetProfitUSDT: db.targetProfitUSDT
            };
            saveDB();
            console.log("✅ Created activePosition from exchange data");
        } else {
            if (db.activePosition.side !== side || Math.abs(db.activePosition.quantity - Math.abs(contracts)) > 0.001) {
                db.activePosition.side = side;
                db.activePosition.quantity = Math.abs(contracts);
                db.activePosition.entryPrice = entryPrice;
                saveDB();
                console.log("✅ Updated activePosition to match exchange");
            }
        }
    } catch (error) {
        console.error("❌ Sync position failed:", error.message);
    }
};

// -------------------- INIT EXCHANGE --------------------
const initializeExchange = async () => {
    try {
        exchange = new ccxt.binance({
            apiKey: process.env.API_KEY,
            secret: process.env.API_SECRET,
            options: { defaultType: "future" },
            enableRateLimit: true,
        });
        await exchange.loadMarkets();
        console.log("✅ Exchange connected");
        return exchange;
    } catch (error) {
        console.error("❌ Exchange connection failed:", error.message);
        throw error;
    }
};

// -------------------- SET MARGIN MODE --------------------
const setMarginMode = async () => {
    try {
        if (!db) return false;
        await exchange.setMarginMode("isolated", db.pair);
        console.log("✅ Margin mode set to: ISOLATED");
        return true;
    } catch (error) {
        if (!error.message.includes("No need to change margin mode")) {
            console.warn("⚠️ Margin mode warning:", error.message);
        }
        return false;
    }
};

// -------------------- UPDATE TREND EMA --------------------
const updateTrend = async () => {
    try {
        if (!exchange || !db) return;
        const timeframe = db.trendTimeframe || "1h";
        const period = db.trendPeriod || 200;
        const ohlcv = await exchange.fetchOHLCV(db.pair, timeframe, undefined, period + 10);
        if (ohlcv.length < period) {
            console.log(`⚠️ Not enough data for trend EMA (${ohlcv.length} < ${period})`);
            return;
        }
        const closes = ohlcv.map(c => c[4]);
        const ema = EMA.calculate({ values: closes, period });
        if (ema.length > 0) {
            trendData.ema = ema[ema.length - 1];
            trendData.lastUpdate = Date.now();
            console.log(`📈 Trend EMA${period} (${timeframe}): ${trendData.ema}`);
        }
    } catch (error) {
        console.error("❌ Failed to update trend:", error.message);
    }
};

// -------------------- BREAKOUT SIGNAL DETECTION (timeframe 5m, volume 2x, RSI diperketat) --------------------
const analyzeSignal = async () => {
    try {
        if (!db) return {};
        signalCount++;
        const now = Date.now();
        if (now - lastLogTime > 5000) {
            console.log(`\n📊 [SIGNAL #${signalCount}] Analyzing market for BREAKOUT (${db.breakoutTimeframe})...`);
            lastLogTime = now;
        }

        // Ambil OHLCV sesuai timeframe (5m)
        const ohlcv = await exchange.fetchOHLCV(db.pair, db.breakoutTimeframe, undefined, db.breakoutPeriod + 10 + db.volumePeriod);
        if (ohlcv.length < db.breakoutPeriod + 5) {
            console.log(`⚠️ Not enough OHLCV data: ${ohlcv.length} candles`);
            return {};
        }

        const close = ohlcv.map(c => c[4]);
        const high = ohlcv.map(c => c[2]);
        const low = ohlcv.map(c => c[3]);
        const volume = ohlcv.map(c => c[5]);

        const currentPrice = close[close.length - 1];
        const currentHigh = high[high.length - 1];
        const currentLow = low[low.length - 1];
        const currentVolume = volume[volume.length - 1];

        // Rata-rata volume periode sebelumnya (tanpa candle terakhir)
        const volumePeriod = db.volumePeriod;
        const avgVolume = volume.slice(-volumePeriod - 1, -1).reduce((a, b) => a + b, 0) / volumePeriod;

        // Resistance & support dari breakoutPeriod candle sebelumnya (tanpa candle terakhir)
        const lookbackPeriod = db.breakoutPeriod;
        const previousHighs = high.slice(-lookbackPeriod - 1, -1);
        const previousLows = low.slice(-lookbackPeriod - 1, -1);
        const resistance = Math.max(...previousHighs);
        const support = Math.min(...previousLows);
        const range = resistance - support;
        const breakoutThreshold = range * db.minBreakoutStrength;

        // RSI 7
        const rsi = RSI.calculate({ values: close, period: 7 });
        const currentRSI = rsi.length > 0 ? rsi[rsi.length - 1] : 50;

        // Breakout detection
        const bullishBreakout = currentHigh > resistance + breakoutThreshold;
        const bearishBreakout = currentLow < support - breakoutThreshold;

        // Filter volume (min 2x)
        const volumeOk = currentVolume > avgVolume * db.minVolumeRatio;

        console.log("\n" + "=".repeat(50));
        console.log("📈 BREAKOUT LEVELS (5m):");
        console.log(`   Current Price: ${currentPrice}`);
        console.log(`   Current Volume: ${currentVolume.toFixed(2)}`);
        console.log(`   Avg Volume (${volumePeriod}): ${avgVolume.toFixed(2)}`);
        console.log(`   Volume Ratio: ${(currentVolume / avgVolume).toFixed(2)}x (min ${db.minVolumeRatio}x)`);
        console.log(`   Resistance: ${resistance.toFixed(6)}`);
        console.log(`   Support: ${support.toFixed(6)}`);
        console.log(`   Range: ${range.toFixed(6)}`);
        console.log(`   Breakout Threshold: ±${breakoutThreshold.toFixed(6)} (${db.minBreakoutStrength*100}% of range)`);
        console.log(`   RSI 7: ${currentRSI.toFixed(2)}`);
        console.log("");
        console.log("🎯 BREAKOUT CONDITIONS:");
        console.log(`   Bullish Breakout: ${bullishBreakout ? "✅ ABOVE RESISTANCE" : "❌ NOT BROKEN"}`);
        console.log(`   Bearish Breakout: ${bearishBreakout ? "✅ BELOW SUPPORT" : "❌ NOT BROKEN"}`);
        console.log(`   Volume OK: ${volumeOk ? "✅" : "❌"}`);

        // RSI DIPERSEMPIT
        let canLong = bullishBreakout && currentRSI > 50 && currentRSI < 75 && volumeOk;
        let canShort = bearishBreakout && currentRSI > 25 && currentRSI < 50 && volumeOk;

        // Filter trend
        if (db.trendEnabled && trendData.ema) {
            if (currentPrice <= trendData.ema) canLong = false;
            if (currentPrice >= trendData.ema) canShort = false;
            console.log(`   Trend EMA: ${trendData.ema} → Long allowed: ${canLong}, Short allowed: ${canShort}`);
        }

        console.log("");
        console.log("🚦 FINAL SIGNAL:");
        console.log(`   LONG Signal: ${canLong ? "✅ CONFIRMED" : "❌ NOT CONFIRMED"}`);
        console.log(`   SHORT Signal: ${canShort ? "✅ CONFIRMED" : "❌ NOT CONFIRMED"}`);
        console.log("=".repeat(50));

        return {
            canLong,
            canShort,
            price: currentPrice,
            rsi: currentRSI,
            resistance,
            support,
            hasSignal: bullishBreakout || bearishBreakout
        };
    } catch (error) {
        console.error("❌ Breakout analysis failed:", error.message);
        return {};
    }
};

// -------------------- PLACE ORDER --------------------
const placeOrder = async (side, signalPrice) => {
    try {
        if (!db || db.activePosition) return;

        console.log(`\n🔄 [ORDER] Attempting to place ${side.toUpperCase()} order...`);
        await setMarginMode();
        await exchange.setLeverage(db.leverage, db.pair);

        const ticker = await exchange.fetchTicker(db.pair);
        const entryPrice = ticker.last;
        const qty = (db.usdtPerTrade * db.leverage) / entryPrice;
        const market = exchange.markets[db.pair];
        const precision = market?.precision?.amount || 3;
        const adjustedQty = parseFloat(qty.toFixed(precision));

        const targetProfitUSDT = db.targetProfitUSDT;
        let targetPrice;
        if (side === "buy") {
            targetPrice = entryPrice + (targetProfitUSDT / adjustedQty);
        } else {
            targetPrice = entryPrice - (targetProfitUSDT / adjustedQty);
        }
        const pricePrecision = market?.precision?.price || 8;
        targetPrice = parseFloat(targetPrice.toFixed(pricePrecision));

        const stopLossUSDT = -db.usdtPerTrade * (db.stopLossPercent / 100);
        let stopLossPrice;
        if (side === "buy") {
            stopLossPrice = entryPrice + (stopLossUSDT / adjustedQty);
        } else {
            stopLossPrice = entryPrice - (stopLossUSDT / adjustedQty);
        }
        stopLossPrice = parseFloat(stopLossPrice.toFixed(pricePrecision));

        console.log(`   📊 Order Details:`);
        console.log(`   - Amount: ${db.usdtPerTrade} USDT × ${db.leverage}x = ${(db.usdtPerTrade * db.leverage).toFixed(2)} USDT`);
        console.log(`   - Quantity: ${adjustedQty} ${db.pair.split('/')[0]}`);
        console.log(`   - Entry Price: ${entryPrice}`);
        console.log(`   - Target Profit: ${targetProfitUSDT} USDT (1:1 risk-reward)`);
        console.log(`   - Target Price: ${targetPrice}`);
        console.log(`   - Stop Loss: ${stopLossUSDT} USDT (${db.stopLossPercent}%)`);
        console.log(`   - Stop Loss Price: ${stopLossPrice}`);

        const order = await exchange.createOrder(db.pair, "market", side, adjustedQty, undefined, {
            marginMode: "isolated"
        });

        db.activePosition = {
            side: side,
            entryPrice: entryPrice,
            targetPrice: targetPrice,
            stopLossPrice: stopLossPrice,
            stopLossUSDT: stopLossUSDT,
            orderId: order.id,
            quantity: adjustedQty,
            entryTime: Date.now(),
            marginMode: "isolated",
            targetProfitUSDT: targetProfitUSDT
        };

        saveDB();
        logTrade(side, entryPrice, null, "OPEN");

        console.log(`\n✅ ORDER PLACED: ${side.toUpperCase()} at ${entryPrice}`);
    } catch (error) {
        console.error("❌ Order failed:", error.message);
    }
};

// -------------------- CLOSE POSITION --------------------
const closePosition = async (reason, profitUSDT, profitPercent) => {
    try {
        if (!db || !db.activePosition) return;
        const { side, quantity, entryPrice } = db.activePosition;
        const closeSide = side === "buy" ? "sell" : "buy";
        
        console.log(`\n🔄 Closing position...`);
        await exchange.createOrder(db.pair, "market", closeSide, quantity, undefined, {
            reduceOnly: true,
            marginMode: "isolated"
        });

        db.dailyPnL += profitUSDT;
        db.dailyTrades++;
        
        const exitPrice = await getPrice();
        logTrade(side === "buy" ? "LONG" : "SHORT", entryPrice, exitPrice, "CLOSE", profitUSDT);
        
        console.log(`\n✅ POSITION CLOSED: ${reason}`);
        console.log(`   P&L: ${profitUSDT.toFixed(4)} USDT (${profitPercent.toFixed(2)}%)`);
        console.log(`   Daily P&L: ${db.dailyPnL.toFixed(2)} USDT / ${db.dailyTrades} trades`);

        db.activePosition = null;
        saveDB();
    } catch (error) {
        console.error("❌ Close position failed:", error.message);
    }
};

// -------------------- UTILITY FUNCTIONS --------------------
const getPrice = async () => {
    try {
        const ticker = await exchange.fetchTicker(db.pair);
        return ticker.last;
    } catch (error) {
        console.error("❌ Failed to get price:", error.message);
        return null;
    }
};

const saveDB = () => {
    try {
        if (!db) return;
        ensureFileExists(dbPath, JSON.stringify(getDefaultConfig(), null, 2));
        db.lastUpdated = Date.now();
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
    } catch (error) {
        console.error("❌ Failed to save DB:", error.message);
    }
};

const logTrade = (side, entry, exit, status, pnl = 0) => {
    try {
        ensureFileExists(logPath, "timestamp,pair,side,entry,exit,status,pnl,leverage,margin_mode,stop_loss_percent,strategy\n");
        const timestamp = new Date().toISOString();
        const line = `${timestamp},${db.pair},${side},${entry},${exit || ""},${status},${pnl.toFixed(4)},${db.leverage},ISOLATED,${db.stopLossPercent},BREAKOUT_5M\n`;
        fs.appendFileSync(logPath, line);
    } catch (error) {
        console.error("❌ Failed to log trade:", error.message);
    }
};

// -------------------- REAL-TIME PNL MONITORING --------------------
const startPnLMonitoring = () => {
    console.log("📈 Starting real-time P&L monitoring...");
    setInterval(async () => {
        if (!db || !db.activePosition) return;
        const currentPrice = await getPrice();
        if (!currentPrice) return;

        const { side, entryPrice, quantity, targetProfitUSDT, entryTime } = db.activePosition;
        const profitUSDT = side === "buy" 
            ? (currentPrice - entryPrice) * quantity
            : (entryPrice - currentPrice) * quantity;
        const profitPercent = side === "buy" 
            ? ((currentPrice - entryPrice) / entryPrice * 100)
            : ((entryPrice - currentPrice) / entryPrice * 100);

        if (profitUSDT >= targetProfitUSDT) {
            console.log(`\n🚨 PROFIT TARGET HIT (+${targetProfitUSDT} USDT)! Closing...`);
            await closePosition("PROFIT_TARGET", profitUSDT, profitPercent);
            return;
        }

        const stopLossUSDT = -db.usdtPerTrade * (db.stopLossPercent / 100);
        if (profitUSDT <= stopLossUSDT) {
            console.log(`\n🚨 STOP LOSS HIT (${stopLossUSDT} USDT)! Closing...`);
            await closePosition("STOP_LOSS", profitUSDT, profitPercent);
            return;
        }

        if (Date.now() - lastPnlLog > 3000) {
            console.log(`\n📊 REAL-TIME P&L: ${profitUSDT.toFixed(4)} USDT (${profitPercent.toFixed(2)}%)`);
            lastPnlLog = Date.now();
        }
    }, db.monitoringInterval);
};

// -------------------- MAIN LOOP --------------------
(async () => {
    try {
        if (!initializeDB()) process.exit(1);
        await initializeExchange();
        await setMarginMode();
        await syncPositionWithExchange();
        await updateTrend();
        setInterval(updateTrend, 15 * 60 * 1000);

        startPnLMonitoring();

        const balance = await exchange.fetchBalance();
        const totalUSDT = balance.total?.USDT || 0;

        console.log("\n" + "=".repeat(70));
        console.log("🚀 BREAKOUT SCALPING BOT (5m, Volume 2x, RSI Ketat)");
        console.log("=".repeat(70));
        console.log(`💰 Balance: $${totalUSDT.toFixed(2)}`);
        console.log(`📊 Pair: ${db.pair}`);
        console.log(`🎯 Strategy: ${db.breakoutTimeframe} breakout (${db.breakoutPeriod}c) + Volume ${db.minVolumeRatio}x + RSI`);
        console.log(`🎯 Target per trade: $${db.targetProfitUSDT} | Stop loss: $${db.usdtPerTrade * db.stopLossPercent/100}`);
        console.log(`📈 Risk:Reward = 1:1`);
        console.log(`⚡ Leverage: ${db.leverage}x`);
        console.log(`📅 Daily target: $${db.targetDailyProfit} (max ${db.maxTradesPerDay} trades)`);
        console.log("=".repeat(70) + "\n");
        console.log("⏳ Bot akan berjalan minimal 30-50 trade tanpa perubahan setting untuk mengukur winrate asli.\n");

        // Main loop setiap 2 detik
        setInterval(async () => {
            if (isProcessing) return;
            isProcessing = true;

            try {
                reloadConfig();

                // Daily reset
                const now = Date.now();
                if (new Date(now).toDateString() !== new Date(db.lastDailyReset || 0).toDateString()) {
                    console.log("📅 Daily reset");
                    db.dailyPnL = 0;
                    db.dailyTrades = 0;
                    db.lastDailyReset = now;
                    saveDB();
                }

                // Cek target/loss harian
                const balance = await exchange.fetchBalance();
                const totalUSDT = balance.total?.USDT || 0;
                const maxDailyLoss = totalUSDT * db.maxDailyLossPercent / 100;

                if (db.dailyPnL >= db.targetDailyProfit) {
                    console.log(`🎯 Daily target reached: $${db.dailyPnL.toFixed(2)}. Trading paused.`);
                    isProcessing = false;
                    return;
                }
                if (db.dailyPnL <= -maxDailyLoss) {
                    console.log(`⛔ Daily loss limit reached: $${db.dailyPnL.toFixed(2)}. Trading paused.`);
                    isProcessing = false;
                    return;
                }
                if (db.dailyTrades >= db.maxTradesPerDay) {
                    console.log(`⏳ Max trades per day (${db.maxTradesPerDay}) reached.`);
                    isProcessing = false;
                    return;
                }

                if (db.activePosition) {
                    isProcessing = false;
                    return;
                }

                // Cek cooling period
                if (db.dailyTrades > 0) {
                    const lastTradeTime = fs.existsSync(logPath) ? fs.statSync(logPath).mtimeMs : 0;
                    if (Date.now() - lastTradeTime < db.coolingPeriod) {
                        isProcessing = false;
                        return;
                    }
                }

                const signal = await analyzeSignal();
                if (signal.canLong) await placeOrder("buy", signal.price);
                else if (signal.canShort) await placeOrder("sell", signal.price);

            } catch (error) {
                console.error("Loop error:", error.message);
            } finally {
                isProcessing = false;
            }
        }, 2000);

        // Sync posisi setiap 10 detik
        setInterval(async () => {
            await syncPositionWithExchange();
        }, 10000);

        // Input manual
        if (process.stdin.isTTY) {
            process.stdin.setEncoding('utf8');
            process.stdin.on('data', (input) => {
                const cmd = input.toString().trim().toLowerCase();
                if (cmd === 'sync') syncPositionWithExchange();
                else if (cmd === 'status') {
                    console.log(`\n📊 Status: Active=${!!db.activePosition}, Daily P&L=${db.dailyPnL.toFixed(2)} USDT, Trades=${db.dailyTrades}`);
                }
            });
        }

    } catch (error) {
        console.error("❌ Bot startup failed:", error.message);
        process.exit(1);
    }
})();
