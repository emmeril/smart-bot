require("dotenv").config();
const fs = require("fs");
const path = require("path");
const ccxt = require("ccxt");
const { RSI, EMA } = require("technicalindicators");
const { Sequelize, DataTypes } = require('sequelize');

// -------------------- DATABASE SETUP --------------------
const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: path.join(__dirname, 'database.sqlite'),
    logging: false
});

const Config = sequelize.define('Config', {
    pair: { type: DataTypes.STRING, defaultValue: "DOGE/USDT:USDT" },
    usdtPerTrade: { type: DataTypes.FLOAT, defaultValue: 10 },
    leverage: { type: DataTypes.INTEGER, defaultValue: 10 },
    targetProfitUSDT: { type: DataTypes.FLOAT, defaultValue: 0.5 },        // diubah
    targetDailyProfit: { type: DataTypes.FLOAT, defaultValue: 1.0 },        // diubah
    maxDailyLossPercent: { type: DataTypes.FLOAT, defaultValue: 10 },
    maxTradesPerDay: { type: DataTypes.INTEGER, defaultValue: 3 },          // diubah
    coolingPeriod: { type: DataTypes.INTEGER, defaultValue: 3000 },
    activePosition: { type: DataTypes.TEXT, defaultValue: null },
    dailyPnL: { type: DataTypes.FLOAT, defaultValue: 0 },
    dailyTrades: { type: DataTypes.INTEGER, defaultValue: 0 },
    marginMode: { type: DataTypes.STRING, defaultValue: "isolated" },
    monitoringInterval: { type: DataTypes.INTEGER, defaultValue: 500 },
    stopLossPercent: { type: DataTypes.FLOAT, defaultValue: 5 },            // diubah
    breakoutPeriod: { type: DataTypes.INTEGER, defaultValue: 20 },
    breakoutTimeframe: { type: DataTypes.STRING, defaultValue: "5m" },
    minBreakoutStrength: { type: DataTypes.FLOAT, defaultValue: 0.003 },
    volumePeriod: { type: DataTypes.INTEGER, defaultValue: 20 },
    minVolumeRatio: { type: DataTypes.FLOAT, defaultValue: 2.0 },
    trendEnabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    trendTimeframe: { type: DataTypes.STRING, defaultValue: "1h" },
    trendPeriod: { type: DataTypes.INTEGER, defaultValue: 200 },
    lastDailyReset: { type: DataTypes.BIGINT, defaultValue: Date.now() },
    lastUpdated: { type: DataTypes.BIGINT, defaultValue: Date.now() }
}, { timestamps: false });

// -------------------- GLOBAL VARIABLES --------------------
let isProcessing = false;
let exchange = null;
let signalCount = 0;
let lastLogTime = Date.now();
let lastPnlLog = Date.now();
const logPath = path.join(__dirname, 'trades.csv');
let db = null;

// Trend data
let trendData = { ema: null, lastUpdate: 0, timeframe: "1h", period: 200 };

// -------------------- ENSURE LOG FILE EXISTS --------------------
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

const safeParseJSON = (value, fallback = null) => {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
};

// -------------------- DEFAULT CONFIG --------------------
const getDefaultConfig = () => ({
    pair: "DOGE/USDT:USDT",
    usdtPerTrade: 10,
    leverage: 10,
    targetProfitUSDT: 0.5,          // diubah
    targetDailyProfit: 1.0,          // diubah
    maxDailyLossPercent: 10,
    maxTradesPerDay: 3,              // diubah
    coolingPeriod: 3000,
    activePosition: null,
    dailyPnL: 0,
    dailyTrades: 0,
    marginMode: "isolated",
    monitoringInterval: 500,
    stopLossPercent: 5,              // diubah
    breakoutPeriod: 20,
    breakoutTimeframe: "5m",
    minBreakoutStrength: 0.003,
    volumePeriod: 20,
    minVolumeRatio: 2.0,
    trendEnabled: true,
    trendTimeframe: "1h",
    trendPeriod: 200,
    lastDailyReset: Date.now(),
    lastUpdated: Date.now()
});

// -------------------- INITIALIZE DATABASE --------------------
const initializeDB = async () => {
    try {
        await sequelize.sync();
        console.log("✅ Database synced");

        let configRow = await Config.findOne();
        if (!configRow) {
            configRow = await Config.create(getDefaultConfig());
            console.log("📝 Created new config row");
        }

        db = configRow.toJSON();
        db.activePosition = safeParseJSON(db.activePosition, null);

        console.log("✅ DB initialized successfully");
        return true;
    } catch (error) {
        console.error("❌ Error initializing DB:", error.message);
        db = getDefaultConfig();
        return true;
    }
};

// -------------------- RELOAD CONFIG FROM DB --------------------
const reloadConfig = async () => {
    try {
        if (!db) return false;
        const configRow = await Config.findOne();
        if (!configRow) return false;

        const freshConfig = configRow.toJSON();
        freshConfig.activePosition = safeParseJSON(freshConfig.activePosition, null);

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

// -------------------- SAVE DB TO DATABASE --------------------
const saveDB = async () => {
    try {
        if (!db) return;
        const toSave = { ...db };
        toSave.activePosition = toSave.activePosition ? JSON.stringify(toSave.activePosition) : null;
        toSave.lastUpdated = Date.now();

        const whereClause = db.id ? { id: db.id } : {};
        await Config.update(toSave, { where: whereClause });
    } catch (error) {
        console.error("❌ Failed to save DB:", error.message);
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
                await saveDB();
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
            await saveDB();
            console.log("✅ Created activePosition from exchange data");
        } else {
            if (db.activePosition.side !== side || Math.abs(db.activePosition.quantity - Math.abs(contracts)) > 0.001) {
                db.activePosition.side = side;
                db.activePosition.quantity = Math.abs(contracts);
                db.activePosition.entryPrice = entryPrice;
                await saveDB();
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

// -------------------- BREAKOUT SIGNAL DETECTION --------------------
const analyzeSignal = async () => {
    try {
        if (!db) return {};
        signalCount++;
        const now = Date.now();
        if (now - lastLogTime > 5000) {
            console.log(`\n📊 [SIGNAL #${signalCount}] Analyzing market for BREAKOUT (${db.breakoutTimeframe})...`);
            lastLogTime = now;
        }

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

        const volumePeriod = db.volumePeriod;
        const avgVolume = volume.slice(-volumePeriod - 1, -1).reduce((a, b) => a + b, 0) / volumePeriod;
        const safeAvgVolume = avgVolume > 0 ? avgVolume : Number.EPSILON;

        const lookbackPeriod = db.breakoutPeriod;
        const previousHighs = high.slice(-lookbackPeriod - 1, -1);
        const previousLows = low.slice(-lookbackPeriod - 1, -1);
        const resistance = Math.max(...previousHighs);
        const support = Math.min(...previousLows);
        const range = resistance - support;
        const breakoutThreshold = range * db.minBreakoutStrength;

        const rsi = RSI.calculate({ values: close, period: 7 });
        const currentRSI = rsi.length > 0 ? rsi[rsi.length - 1] : 50;

        const bullishBreakout = currentHigh > resistance + breakoutThreshold;
        const bearishBreakout = currentLow < support - breakoutThreshold;
        const volumeOk = currentVolume > safeAvgVolume * db.minVolumeRatio;

        console.log("\n" + "=".repeat(50));
        console.log("📈 BREAKOUT LEVELS (5m):");
        console.log(`   Current Price: ${currentPrice}`);
        console.log(`   Current Volume: ${currentVolume.toFixed(2)}`);
        console.log(`   Avg Volume (${volumePeriod}): ${avgVolume.toFixed(2)}`);
        console.log(`   Volume Ratio: ${(currentVolume / safeAvgVolume).toFixed(2)}x (min ${db.minVolumeRatio}x)`);
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

        let canLong = bullishBreakout && currentRSI > 50 && currentRSI < 75 && volumeOk;
        let canShort = bearishBreakout && currentRSI > 25 && currentRSI < 50 && volumeOk;

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

        return { canLong, canShort, price: currentPrice, rsi: currentRSI, resistance, support, hasSignal: bullishBreakout || bearishBreakout };
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
        const entryPrice = Number(signalPrice) > 0 ? signalPrice : ticker.last;
        const qty = (db.usdtPerTrade * db.leverage) / entryPrice;
        const market = exchange.markets[db.pair];
        const precision = market?.precision?.amount || 3;
        const adjustedQty = parseFloat(qty.toFixed(precision));
        if (!Number.isFinite(adjustedQty) || adjustedQty <= 0) {
            console.error("❌ Invalid order quantity after precision adjustment.");
            return;
        }

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

        await saveDB();
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
        await saveDB();
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

        const { side, entryPrice, quantity, targetProfitUSDT } = db.activePosition;
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
        if (!(await initializeDB())) process.exit(1);

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
        

        setInterval(async () => {
            if (isProcessing) return;
            isProcessing = true;

            try {
                await reloadConfig();

                const now = Date.now();
                if (new Date(now).toDateString() !== new Date(db.lastDailyReset || 0).toDateString()) {
                    console.log("📅 Daily reset");
                    db.dailyPnL = 0;
                    db.dailyTrades = 0;
                    db.lastDailyReset = now;
                    await saveDB();
                }

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

        setInterval(async () => {
            await syncPositionWithExchange();
        }, 10000);

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
