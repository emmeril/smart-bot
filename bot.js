// signal.js (Cleaned Version)
require("dotenv").config();
const fs = require("fs");
const ccxt = require("ccxt");
const { SMA } = require("technicalindicators");

// -------------------- CONFIG --------------------
const dbPath = "./db.json";
const logPath = "./log.csv";
let isProcessing = false;

// -------------------- FILE INIT --------------------
if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, "timestamp,pair,type,entry,tp,sl,status,pnl\n");
    console.log("📝 Log file created: log.csv");
}

const db = fs.existsSync(dbPath) ?
    JSON.parse(fs.readFileSync(dbPath)) : {
        pair: "XRP/USDT:USDT",
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
    options: { defaultType: "future" },
});

(async () => {
    try {
        await exchange.loadMarkets();
        console.log("✅ Markets loaded successfully");
    } catch (err) {
        console.error("❌ Failed to load markets:", err.message);
    }
})();

// -------------------- UTIL FUNCTIONS --------------------
const saveDB = () => {
    if (db.activePosition) {
        db.activePosition.entryPrice = formatPrice(db.activePosition.entryPrice);
        db.activePosition.tp = formatPrice(db.activePosition.tp);
        db.activePosition.sl = formatPrice(db.activePosition.sl);
    }
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
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
        const ticker = await exchange.fetchTicker(db.pair);
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
    const entryStr = entry !== undefined && entry !== null ? entry : "";
    const tpStr = tp !== undefined && tp !== null ? tp : "";
    const slStr = sl !== undefined && sl !== null ? sl : "";
    const pnlStr = pnl !== null && isFinite(pnl) ? Number(pnl).toFixed(6) : "";
    const line = `${new Date().toISOString()},${db.pair},${type},${entryStr},${tpStr},${slStr},${status},${pnlStr}\n`;
    fs.appendFileSync(logPath, line);
    console.log("📝 Signal logged to CSV");
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
        const balance = await exchange.fetchBalance();
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

    const qty = calcQty(price);
    console.log(`➡️ ENTRY ${side.toUpperCase()}
- Quantity: ${qty}
- Entry: ${formatPrice(price)}
- TP: ${formatPrice(tp)}
- SL: ${formatPrice(sl)}`);

    try {
        await exchange.setLeverage(db.leverage, db.pair);
        await exchange.setMarginMode(db.marginMode, db.pair);
        console.log("✅ Leverage and margin mode set");
    } catch (err) {
        console.warn("⚠️ Failed to set leverage/margin:", err.message);
    }

    try {
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
    }
};

// -------------------- TECHNICAL ANALYSIS --------------------
const analyzeSignal = async () => {
    console.log("🧠 Technical analysis started...");
    const ohlcv = await exchange.fetchOHLCV(db.pair, "15m", undefined, 200);
    if (!ohlcv || ohlcv.length < 200) {
        console.warn("⚠️ Insufficient OHLCV data");
        return {};
    }

    const close = ohlcv.map(c => c[4]);
    const high = ohlcv.map(c => c[2]);
    const low = ohlcv.map(c => c[3]);

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

    if (isCrossedUp && isMA7AboveMA99 && isMA25AboveMA99) {
        canLong = true;
    }

    if (isCrossedDown && isMA7BelowMA99 && isMA25BelowMA99) {
        canShort = true;
    }

    // Support/Resistance Detection
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

    // Analysis Results
    console.log(`\n📊 Analysis Results ${db.pair}
─────────────────────────────────────
📈 Long Signal: ${canLong ? "✅ VALID" : "❌ INVALID"}
📉 Short Signal: ${canShort ? "✅ VALID" : "❌ INVALID"}
─────────────────────────────────────
💰 Current Price: ${formatPrice(price)}
🎯 Resistance: ${formatPrice(resistance)}
🛡️ Support: ${formatPrice(support)}
📊 ATR: ${formatPrice(currentATR)}
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

// -------------------- DYNAMIC TP/SL UPDATE --------------------
const updateTPSLForOpenPosition = async (signal) => {
    if (!db.activePosition) return;
    
    try {
        console.log("🔄 Checking TP/SL updates...");
        
        const { side, entryPrice, tp: currentTP, sl: currentSL } = db.activePosition;
        let newTP, newSL;

        if (side === "buy") {
            newTP = signal.targetLong;
            newSL = signal.stopLossLong;
            
            const profitToCurrentTP = (currentTP - entryPrice) / entryPrice * 100;
            const profitToNewTP = (newTP - entryPrice) / entryPrice * 100;
            
            if (profitToCurrentTP >= 0.8 && newTP > currentTP) {
                console.log(`🎯 Keeping current TP (${profitToCurrentTP.toFixed(2)}% profit)`);
                newTP = currentTP;
            }
            
            if (newTP <= entryPrice || newSL >= entryPrice) {
                console.log("⚠️ Invalid TP/SL levels for LONG");
                return;
            }
            
            if (newSL > currentSL) {
                console.log("🛡️ Keeping safer SL for LONG");
                newSL = currentSL;
            }
            
        } else if (side === "sell") {
            newTP = signal.targetShort;
            newSL = signal.stopLossShort;
            
            const profitToCurrentTP = (entryPrice - currentTP) / entryPrice * 100;
            const profitToNewTP = (entryPrice - newTP) / entryPrice * 100;
            
            if (profitToCurrentTP >= 0.8 && newTP < currentTP) {
                console.log(`🎯 Keeping current TP (${profitToCurrentTP.toFixed(2)}% profit)`);
                newTP = currentTP;
            }
            
            if (newTP >= entryPrice || newSL <= entryPrice) {
                console.log("⚠️ Invalid TP/SL levels for SHORT");
                return;
            }
            
            if (newSL < currentSL) {
                console.log("🛡️ Keeping safer SL for SHORT");
                newSL = currentSL;
            }
        } else {
            return;
        }

        // Limit maximum TP distance
        const maxProfitPercent = 2.0;
        let currentPrice = signal.price;
        
        if (side === "buy") {
            const maxTP = entryPrice * (1 + maxProfitPercent / 100);
            if (newTP > maxTP) {
                console.log(`📏 Limiting TP to ${formatPrice(maxTP)}`);
                newTP = maxTP;
            }
        } else if (side === "sell") {
            const maxTP = entryPrice * (1 - maxProfitPercent / 100);
            if (newTP < maxTP) {
                console.log(`📏 Limiting TP to ${formatPrice(maxTP)}`);
                newTP = maxTP;
            }
        }

        const tpChangePercent = Math.abs((newTP - currentTP) / currentTP * 100);
        const slChangePercent = Math.abs((newSL - currentSL) / currentSL * 100);
        
        const minChangeThreshold = 0.2;
        
        if (tpChangePercent < minChangeThreshold && slChangePercent < minChangeThreshold) {
            console.log("ℹ️ No significant changes");
            return;
        }

        db.activePosition.tp = newTP;
        db.activePosition.sl = newSL;
        saveDB();

        console.log(`✅ TP/SL Updated for ${side.toUpperCase()}:`);
        console.log(`   Entry: ${formatPrice(entryPrice)}`);
        console.log(`   TP: ${formatPrice(currentTP)} → ${formatPrice(newTP)}`);
        console.log(`   SL: ${formatPrice(currentSL)} → ${formatPrice(newSL)}`);
        
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

// -------------------- POSITION RECOVERY --------------------
const recoverPositionState = async () => {
    try {
        console.log("🔄 Checking position sync...");
        
        const { position } = await getPositionFromBalance();
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
                const { side, entryPrice, tp, sl, recovered } = db.activePosition;
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

// -------------------- MAIN LOOP --------------------
let prevPosAmt = 0;

setInterval(async () => {
    // Auto reload config
    try {
        const freshDb = JSON.parse(fs.readFileSync(dbPath));
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

        // Update TP/SL for open positions
        if (db.activePosition) {
            await updateTPSLForOpenPosition(signal);
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
            await new Promise(resolve => setTimeout(resolve, 15000));
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
    } catch (err) {
        console.error("⚠️ Main loop error:", err.message);
    } finally {
        isProcessing = false;
    }
}, 30000);
