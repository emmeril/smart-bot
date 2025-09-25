/**
 * @fileoverview Trading bot using ccxt for Binance Futures, technical indicators, and WhatsApp-web.js.
 * @author Original code by [Original Author Name]
 * @version 2.0.0
 */

require("dotenv").config();
const fs = require("fs");
const ccxt = require("ccxt");
const { SMA } = require("technicalindicators");
const { Client, LocalAuth } = require("whatsapp-web.js");
const express = require("express");
const QRCode = require("qrcode");

// -------------------- CONFIGURATION --------------------
const app = express();
const dbPath = "./db.json";
const logPath = "./log.csv";
const serverPort = 7890;

const db = fs.existsSync(dbPath)
  ? JSON.parse(fs.readFileSync(dbPath, "utf8"))
  : {
      pair: "XRP/USDT:USDT",
      lastLongEntryTime: 0,
      lastShortEntryTime: 0,
      leverage: 10,
      marginMode: "ISOLATED",
      activePosition: null,
      usdtPerTrade: 5.1,
    };

let previousPositionAmount = 0;
let currentQR = null;
let isWhatsappReady = false;

// -------------------- INITIALIZATION & SETUP --------------------

// Initialize log file
if (!fs.existsSync(logPath)) {
  fs.writeFileSync(logPath, "timestamp,pair,type,entry,tp,sl,status,pnl\n");
  console.log("📝 Log: `log.csv` file created.");
}

// Log bot configuration
console.log("⚙️ Bot Configuration:");
console.log(`   - Active Pair: ${db.pair}`);
console.log(`   - Leverage: ${db.leverage}x`);
console.log(`   - Margin Mode: ${db.marginMode}`);
console.log(`   - USDT per Trade: ${db.usdtPerTrade}`);

// Initialize CCXT Exchange
const exchange = new ccxt.binance({
  apiKey: process.env.API_KEY,
  secret: process.env.API_SECRET,
  options: { defaultType: "future" },
});

// Load markets on startup
(async () => {
  try {
    await exchange.loadMarkets();
    console.log("✅ Exchange: Markets loaded successfully.");
  } catch (err) {
    console.error("❌ Exchange: Failed to load markets.", err.message);
  }
})();

// Initialize WhatsApp Client
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: process.env.PUPPETEER_PATH || "/usr/bin/chromium",
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  },
});

app.listen(serverPort, () =>
  console.log(
    `🟢 Server: QR server is active at http://localhost:${serverPort}/qr`
  )
);

client.on("qr", (qr) => {
  currentQR = qr;
  isWhatsappReady = false;
  console.log("📲 WhatsApp: New QR code is ready to be scanned.");
});

client.on("ready", () => {
  isWhatsappReady = true;
  currentQR = null;
  console.log("✅ WhatsApp: Connection successful.");
});

client.on("disconnected", (reason) => {
  console.log("❌ WhatsApp: Disconnected, bot shutting down.", reason);
  process.exit();
});

// -------------------- HELPER FUNCTIONS --------------------

/**
 * Saves the current state of the database to `db.json`.
 */
const saveDB = () => fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

/**
 * Sends a message via WhatsApp to the admin.
 * @param {string} text - The message to send.
 */
const sendMessage = async (text) => {
  try {
    const chats = await client.getChats();
    const adminChat = chats.find(
      (c) => !c.isGroup && c.id.user.includes(process.env.ADMIN_PHONE)
    );
    if (adminChat) {
      await adminChat.sendMessage(text);
      console.log("📤 WhatsApp: Message sent.", text.split("\n")[0] + "...");
    }
  } catch (err) {
    console.error("❌ WhatsApp: Failed to send message.", err.message);
  }
};

/**
 * Formats a price value to the correct precision for the trading pair.
 * @param {number} price - The price to format.
 * @param {string} pair - The trading pair symbol.
 * @returns {string} The formatted price string.
 */
const formatPrice = (price, pair = db.pair) => {
  if (!price || !isFinite(price)) return "N/A";
  const market = exchange.markets[pair];
  let decimals = market?.precision?.price ?? 5;
  if (decimals <= 0 || price < 1) decimals = 5;
  return price.toFixed(decimals);
};

/**
 * Fetches the current ticker price for the active trading pair.
 * @returns {Promise<number|null>} The last price, or null if an error occurs.
 */
const getPrice = async () => {
  try {
    const ticker = await exchange.fetchTicker(db.pair);
    console.log(`💰 Data: Price of ${db.pair} = ${formatPrice(ticker.last)}.`);
    return ticker.last;
  } catch (e) {
    console.error("❌ Data: Failed to fetch price.", e.message);
    return null;
  }
};

/**
 * Calculates the quantity of the asset to trade based on the configured USDT amount.
 * @param {number} price - The current price of the asset.
 * @returns {number} The calculated quantity.
 */
const calculateQuantity = (price) => {
  if (!price) return 0;
  let quantity = db.usdtPerTrade / price;
  const precision = exchange.markets[db.pair]?.precision?.amount ?? 3;
  quantity = parseFloat(quantity.toFixed(precision));
  console.log(
    `📐 Calculation: Quantity calculated: ${quantity} (${db.usdtPerTrade} USDT).`
  );
  return quantity;
};

/**
 * Logs a signal to the `log.csv` file.
 * @param {string} type - 'LONG' or 'SHORT'.
 * @param {number} entry - The entry price.
 * @param {number} tp - The Take Profit price.
 * @param {number} sl - The Stop Loss price.
 * @param {string} status - The status of the trade (e.g., 'ORDER_PLACED', 'TP_REALIZED').
 * @param {number|null} pnl - The PnL of the trade, if applicable.
 */
const logSignal = (type, entry, tp, sl, status, pnl = null) => {
  const entryStr = entry !== undefined && entry !== null ? entry : "";
  const tpStr = tp !== undefined && tp !== null ? tp : "";
  const slStr = sl !== undefined && sl !== null ? sl : "";
  const pnlStr = pnl !== null && isFinite(pnl) ? Number(pnl).toFixed(6) : "";
  const line = `${new Date().toISOString()},${db.pair},${type},${entryStr},${tpStr},${slStr},${status},${pnlStr}\n`;
  fs.appendFileSync(logPath, line);
  console.log("📝 Log: Signal recorded in `log.csv`.");
};

/**
 * Fetches the market ID for the current pair.
 * @returns {string} The market ID (e.g., "XRPUSDT").
 */
const getMarketId = () => {
  try {
    const market = exchange.markets[db.pair];
    if (market && market.id) return market.id;
  } catch (e) {
    // Ignore
  }
  return db.pair.replace("/", "").replace(":", "");
};

/**
 * Fetches the current position details from the exchange.
 * @returns {Promise<{balance: object|null, position: object|null}>}
 */
const getPositionFromBalance = async () => {
  try {
    const balance = await exchange.fetchBalance();
    const marketId = getMarketId();
    const positions = balance.info?.positions || [];
    const position = positions.find(
      (p) =>
        p.symbol === marketId ||
        p.contractCode === marketId ||
        (p.symbol && p.symbol.includes(marketId))
    );
    return { balance, position };
  } catch (err) {
    console.error("❌ Helper: Failed to get position from balance.", err.message);
    return { balance: null, position: null };
  }
};

// -------------------- WHATSAPP MESSAGE HANDLER --------------------
client.on("message", async (msg) => {
  if (!msg.from.includes(process.env.ADMIN_PHONE)) return;
  const [command, ...args] = msg.body.toLowerCase().split(" ");

  switch (command) {
    case "!pair":
      const newPair = args[0]?.toUpperCase();
      if (!newPair) {
        return msg.reply(
          "⚠️ Invalid format. Use: `!pair [SYMBOL]`, e.g., `!pair BTC/USDT:USDT`"
        );
      }
      db.pair = newPair;
      db.lastLongEntryTime = 0;
      db.lastShortEntryTime = 0;
      saveDB();
      console.log(`🔄 Command: Pair changed to ${db.pair}.`);
      msg.reply(`✅ Trading pair successfully changed to *${db.pair}*.`);
      break;

    case "!leverage":
      const newLeverage = parseInt(args[0]);
      const newMarginMode = args[1]?.toUpperCase();
      const validModes = ["ISOLATED", "CROSSED"];
      if (!newLeverage || newLeverage < 1 || newLeverage > 125) {
        return msg.reply(
          "⚠️ Invalid format. Use: `!leverage [1-125] [isolated/crossed]`"
        );
      }
      if (newMarginMode && !validModes.includes(newMarginMode)) {
        return msg.reply(
          `⚠️ Invalid margin mode. Options: *${validModes.join(" or ")}*.`
        );
      }
      db.leverage = newLeverage;
      if (newMarginMode) db.marginMode = newMarginMode;
      saveDB();
      let replyMsg = `✅ Settings updated successfully:\n\n*Leverage:* ${db.leverage}x`;
      if (newMarginMode) replyMsg += `\n*Margin Mode:* ${db.marginMode}`;
      console.log(
        `🔄 Command: Leverage/margin mode changed to ${db.leverage}x (${db.marginMode}).`
      );
      msg.reply(replyMsg);
      break;

    case "!order":
      const newAmount = parseFloat(args[0]);
      if (isNaN(newAmount) || newAmount <= 0) {
        return msg.reply(
          "⚠️ Invalid format. Use: `!order [AMOUNT]`, e.g., `!order 10.5`"
        );
      }
      db.usdtPerTrade = newAmount;
      saveDB();
      console.log(
        `🔄 Command: USDT per trade amount changed to ${db.usdtPerTrade}.`
      );
      msg.reply(
        `✅ USDT per trade amount successfully changed to *${db.usdtPerTrade} USDT*.`
      );
      break;

    case "!reset":
      db.activePosition = null;
      saveDB();
      console.log(`🔄 Command: Bot position status reset.`);
      msg.reply(
        "✅ Bot position status has been reset. The bot will now look for a new signal."
      );
      break;

    case "!pnl":
      try {
        if (!fs.existsSync(logPath)) {
          return msg.reply("ℹ️ Log file not found (`log.csv` does not exist).");
        }
        const raw = fs.readFileSync(logPath, "utf8");
        const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
        const dataLines = lines.slice(1);
        let tpCount = 0, slCount = 0;
        let tpSum = 0, slSum = 0;
        let netSum = 0;
        const recentTrades = [];

        dataLines.forEach((line) => {
          const parts = line.split(",");
          if (parts.length < 7) return;
          const status = parts[6]?.trim() || "";
          const pnl = parseFloat(parts[7]?.trim());
          if (isNaN(pnl)) return;

          if (/TP_REALIZED/i.test(status)) {
            tpCount++;
            tpSum += pnl;
          } else if (/SL_REALIZED/i.test(status)) {
            slCount++;
            slSum += pnl;
          }
          netSum += pnl;

          if (/TP_REALIZED|SL_REALIZED/i.test(status)) {
            recentTrades.push({ time: parts[0], status, pnl });
          }
        });

        const avgTp = tpCount ? tpSum / tpCount : 0;
        const avgSl = slCount ? slSum / slCount : 0;
        let reply = `📊 *PnL Summary*\n\n*TP (Realized):*\n${tpCount} trades\nTotal: ${tpSum.toFixed(4)} USDT\nAvg: ${avgTp.toFixed(4)} USDT\n*SL (Realized):*\n${slCount} trades\nTotal: ${slSum.toFixed(4)} USDT\nAvg: ${avgSl.toFixed(4)} USDT\n\n*Net PnL:* ${netSum >= 0 ? "+" : ""}${netSum.toFixed(4)} USDT`;

        if (recentTrades.length > 0) {
          const last5 = recentTrades.slice(-5).reverse();
          reply += `\n\n*Last 5 Realized Trades:*\n`;
          last5.forEach((trade) => {
            reply += `\n- ${trade.time.split("T")[0]} ${trade.status} PnL:${
              trade.pnl >= 0 ? "+" : ""
            }${trade.pnl.toFixed(4)} USDT`;
          });
        }
        await msg.reply(reply);
      } catch (e) {
        console.error("❌ Error with `!pnl` command:", e.message);
        await msg.reply("⚠️ An error occurred while calculating PnL.");
      }
      break;

    case "!status":
      try {
        const price = await getPrice();
        const balance = await exchange.fetchBalance();
        const usdt = balance.total.USDT;
        const binancePositions =
          balance.info?.positions?.filter(
            (p) => parseFloat(p.positionAmt) !== 0
          ) || [];

        let positionText = `*Open Positions on Binance:*`;
        if (binancePositions.length === 0) {
          positionText += `\n❌ No open positions on your account.`;
        } else {
          binancePositions.forEach((pos) => {
            const side = parseFloat(pos.positionAmt) > 0 ? "LONG" : "SHORT";
            positionText += `\n\n*Pair:* ${pos.symbol}\n*Type:* ${side}\n*PnL (Unrealized):* ${parseFloat(pos.unrealizedProfit).toFixed(2)} USDT`;
          });
        }

        const lastLong = db.lastLongEntryTime
          ? new Date(db.lastLongEntryTime).toLocaleString()
          : "N/A";
        const lastShort = db.lastShortEntryTime
          ? new Date(db.lastShortEntryTime).toLocaleString()
          : "N/A";

        let statusText = `📊 *Trading Bot Status*\n\n*Bot Pair:* ${db.pair}\n*Current Price:* ${formatPrice(price)}\n*USDT Balance:* ${usdt?.toFixed(2) || "N/A"} USDT\n*Leverage:* ${db.leverage}x (${db.marginMode})\n*USDT per Trade:* ${db.usdtPerTrade}\n*Last Signal:*\nLONG: ${lastLong}\nSHORT: ${lastShort}`;

        if (db.activePosition) {
          statusText += `\n\n*Position Monitored by Bot:*\n*Type:* ${db.activePosition.side.toUpperCase()}\n*Entry:* ${formatPrice(db.activePosition.entryPrice)}\n*TP:* ${db.activePosition.tp ? formatPrice(db.activePosition.tp) : "N/A"}\n*SL:* ${db.activePosition.sl ? formatPrice(db.activePosition.sl) : "N/A"}`;
        } else {
          statusText += `\n\n*Position Monitored by Bot:*\n❌ No position is being monitored by the bot.`;
        }

        statusText += `\n\n${positionText}`;
        await msg.reply(statusText);
        console.log("📤 WhatsApp: Status report sent.");
      } catch (err) {
        console.error("❌ WhatsApp: Failed to get status.", err.message);
        await msg.reply("⚠️ An error occurred while fetching bot status.");
      }
      break;
  }
});

// -------------------- TRADING LOGIC --------------------

/**
 * Performs technical analysis to generate trading signals.
 * @returns {Promise<object>} An object containing signal validity, price, TP, and SL levels.
 */
const analyzeSignal = async () => {
  console.log("🧠 Analysis: Performing technical analysis...");
  const ohlcv = await exchange.fetchOHLCV(db.pair, "15m", undefined, 200);
  if (!ohlcv || ohlcv.length < 200) {
    console.warn("⚠️ Analysis: Not enough OHLCV data, waiting...");
    return {};
  }
  const close = ohlcv.map((c) => c[4]);
  const high = ohlcv.map((c) => c[2]);
  const low = ohlcv.map((c) => c[3]);

  // Calculate SMAs
  const ma7 = SMA.calculate({ values: close.slice(-100), period: 7 }).pop();
  const ma25 = SMA.calculate({ values: close.slice(-100), period: 25 }).pop();
  const ma99 = SMA.calculate({ values: close, period: 99 }).pop();
  const price = close.at(-1);

  // Check for SMA crossovers
  const previousMA7 = SMA.calculate({ values: close.slice(-101, -1), period: 7 }).pop();
  const previousMA25 = SMA.calculate({ values: close.slice(-101, -1), period: 25 }).pop();
  const isCrossedUp = ma7 > ma25 && previousMA7 <= previousMA25;
  const isCrossedDown = ma7 < ma25 && previousMA7 >= previousMA25;
  const isPriceAboveMA99 = price > ma99;
  const isPriceBelowMA99 = price < ma99;

  let canLong = isCrossedUp && isPriceAboveMA99;
  let canShort = isCrossedDown && isPriceBelowMA99;

  // Calculate TP and SL levels based on recent highs/lows
  const targetLong = Math.max(...high.slice(-16));
  const stopLossLong = Math.min(...low.slice(-16));
  const targetShort = Math.min(...low.slice(-16));
  const stopLossShort = Math.max(...high.slice(-16));

  const longOffset = targetLong - stopLossLong;
  const shortOffset = stopLossShort - targetShort;
  const midPriceLong = (targetLong + stopLossLong) / 2;
  const midPriceShort = (targetShort + stopLossShort) / 2;

  console.log(`\n📊 *Analysis Result for ${db.pair}*`);
  console.log(`  - Long Signal: ${canLong ? "✅ VALID" : "❌ NOT VALID"}`);
  console.log(`  - Short Signal: ${canShort ? "✅ VALID" : "❌ NOT VALID"}`);
  console.log(`  --- Indicator Details ---`);
  console.log(`  - SMA Crossover: ${isCrossedUp ? "✅ MA7 Crossed Up MA25" : isCrossedDown ? "✅ MA7 Crossed Down MA25" : "❌ None"}`);
  console.log(`  - Price vs MA99: ${isPriceAboveMA99 ? "✅ Price is above MA99 (Uptrend)" : "❌ Price is below MA99 (Downtrend)"}`);
  console.log(`  - Current Price: ${formatPrice(price)}`);
  console.log(`  - Long Target: ${formatPrice(targetLong)}`);
  console.log(`  - Long Stop Loss: ${formatPrice(stopLossLong)}`);
  console.log(`  - Short Target: ${formatPrice(targetShort)}`);
  console.log(`  - Short Stop Loss: ${formatPrice(stopLossShort)}`);
  console.log(`  ---`);

  return {
    canLong,
    canShort,
    targetLong,
    stopLossLong,
    targetShort,
    stopLossShort,
    longOffset,
    shortOffset,
    midPriceLong,
    midPriceShort,
    price,
  };
};

/**
 * Places a market order on the exchange.
 * @param {string} side - 'buy' or 'sell'.
 * @param {number} tp - The Take Profit price.
 * @param {number} sl - The Stop Loss price.
 * @param {number} offset - The dynamic offset for trailing SL.
 * @param {number} targetEntryPrice - The price to check against before entry.
 */
const placeOrder = async (side, tp, sl, offset, targetEntryPrice) => {
  console.log("🔍 Order: Checking for active position...");
  if (db.activePosition) {
    console.log("⚠️ Order: Active position already monitored, order canceled.");
    await sendMessage(
      `⚠️ ${db.pair}: Active position is being monitored. ${side} order canceled.`
    );
    return;
  }
  try {
    const { position } = await getPositionFromBalance();
    const amount = parseFloat(position?.positionAmt || "0");
    if (isFinite(amount) && Math.abs(amount) > 0) {
      console.log("⚠️ Order: Active position detected on account. Order canceled.");
      await sendMessage(
        `⚠️ ${db.pair}: Active position detected on account. ${side} order canceled.`
      );
      return;
    }
  } catch (e) {
    console.warn("⚠️ Order: Failed to check live position before entry.", e.message);
  }

  const price = await getPrice();
  if (!price) {
    console.log("❌ Order: Failed to get price, order canceled.");
    return;
  }
  let isEntryConditionMet = false;
  if ((side === "buy" && price <= targetEntryPrice) || (side === "sell" && price >= targetEntryPrice)) {
    isEntryConditionMet = true;
  }
  if (!isEntryConditionMet) {
    console.log(`⚠️ Order: Entry condition not met for ${side}. Current price ${formatPrice(price)} is not on the desired side of the target entry ${formatPrice(targetEntryPrice)}. Order canceled.`);
    return;
  }

  const quantity = calculateQuantity(price);
  console.log(`➡️ Order: ENTRY ${side.toUpperCase()}\n- Qty: ${quantity}\n- Entry Price: ${formatPrice(price)}\n- TP: ${formatPrice(tp)}\n- SL: ${formatPrice(sl)}`);

  try {
    await exchange.setLeverage(db.leverage, db.pair);
    await exchange.setMarginMode(db.marginMode, db.pair);
    console.log("✅ Order: Leverage and margin mode set successfully.");
    const order = await exchange.createOrder(db.pair, "market", side, quantity);
    console.log("✅ Order: Market order created successfully.");

    db.activePosition = {
      side,
      entryPrice: price,
      tp,
      sl,
      offset,
      orderId: order.id,
    };
    saveDB();

    await sendMessage(`✅ *Order Submitted!*
*Pair:* ${db.pair}
*Type:* ${side.toUpperCase()}
*Entry:* ${formatPrice(price)}
*TP:* ${formatPrice(tp)}
*SL:* ${formatPrice(sl)}
*Leverage:* ${db.leverage}x
*Note:* TP & SL will be monitored by the bot.`);

    logSignal(side === "buy" ? "LONG" : "SHORT", price, tp, sl, "ORDER_PLACED_MONITOR_BY_BOT");
  } catch (e) {
    console.error("❌ Order: Failed to create order.", e.message);
    await sendMessage(`❌ *Failed to Create Order!*
*Pair:* ${db.pair}
*Type:* ${side.toUpperCase()}
*Error Message:* ${e.message}`);
  }
};

/**
 * Closes the active position on the exchange.
 * @param {string} reason - The reason for closing the position (e.g., 'TP reached', 'SL reached').
 * @param {number|string} [entryPrice='N/A'] - The entry price of the closed position.
 */
const closePosition = async (reason, entryPrice = "N/A") => {
  console.log(`🚨 Position: Closing position due to ${reason}.`);
  try {
    const { position } = await getPositionFromBalance();
    const quantity = parseFloat(position?.positionAmt || "0");
    if (!isFinite(quantity) || Math.abs(quantity) === 0) {
      console.log("ℹ️ Position: No position to close (quantity is zero).");
      return;
    }
    const side = quantity > 0 ? "sell" : "buy";
    const amount = Math.abs(quantity);
    await exchange.createOrder(db.pair, "market", side, amount, undefined, { reduceOnly: true });
    console.log(`✅ Position: Close order created successfully (side=${side}, amount=${amount}).`);
    const exitPrice = await getPrice();
    let pnl = null;
    if (entryPrice !== "N/A" && isFinite(exitPrice) && isFinite(entryPrice)) {
      const entryNum = Number(entryPrice);
      const exitNum = Number(exitPrice);
      if (side === "sell") {
        pnl = (exitNum - entryNum) * amount;
      } else {
        pnl = (entryNum - exitNum) * amount;
      }
    }
    let message = `📉 *Position Closed!*
*Pair:* ${db.pair}
*Reason:* ${reason}
*Entry Price:* ${formatPrice(entryPrice)}
*Exit Price:* ${formatPrice(exitPrice)}`;
    if (pnl !== null && isFinite(pnl)) {
      message += `\n*PnL (est):* ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} USDT`;
    }
    await sendMessage(message);
    let statusTag = "CLOSED_MANUAL";
    if (/TP/i.test(reason)) statusTag = "TP_REALIZED";
    if (/SL/i.test(reason)) statusTag = "SL_REALIZED";
    logSignal(quantity > 0 ? "LONG" : "SHORT", entryPrice, db.activePosition?.tp, db.activePosition?.sl, statusTag, pnl);
  } catch (err) {
    console.error("❌ Position: Failed to close position.", err.message);
    await sendMessage(`❌ *Failed to Close Position!*
*Pair:* ${db.pair}
*Reason:* ${reason}
*Error Message:* ${err.message}`);
  } finally {
    db.activePosition = null;
    saveDB();
  }
};

/**
 * Checks the status of the active position for TP/SL triggers and manual closures.
 */
const checkPositionStatus = async () => {
  try {
    const { position } = await getPositionFromBalance();
    const amount = parseFloat(position?.positionAmt || "0");
    const amountSafe = isFinite(amount) ? amount : 0;
    const previousAmountSafe = isFinite(previousPositionAmount) ? previousPositionAmount : 0;

    // Detect manual or external position closure
    if (previousAmountSafe !== 0 && amountSafe === 0) {
      const side = previousAmountSafe > 0 ? "LONG" : "SHORT";
      await sendMessage(`📉 *${side} Position Closed!*
*Pair:* ${db.pair}
*Exit Price:* (check on Binance)`);
      console.log(`📉 ${side} position on ${db.pair} has been closed.`);
      db.activePosition = null;
      saveDB();
    }

    // Internal monitoring for TP/SL from database
    if (db.activePosition && amountSafe !== 0) {
      const { tp, sl, side, entryPrice, offset } = db.activePosition;
      const currentPrice = await getPrice();
      if (!currentPrice) return;

      // Trailing Stop Loss logic
      let newSL = sl;
      if (side === "buy") {
        newSL = Math.max(sl, currentPrice - offset);
      } else if (side === "sell") {
        newSL = Math.min(sl, currentPrice + offset);
      }

      // Update SL if it has trailed
      if (newSL !== sl) {
        db.activePosition.sl = newSL;
        saveDB();
        await sendMessage(
          `📈 Trailing SL updated for ${side.toUpperCase()} position!\n*New SL:* ${formatPrice(newSL)}`
        );
      }

      // Check for TP/SL triggers
      if (
        (side === "buy" && currentPrice >= tp) ||
        (side === "sell" && currentPrice <= tp)
      ) {
        await closePosition("TP reached", entryPrice);
      } else if (
        (side === "buy" && currentPrice <= newSL) ||
        (side === "sell" && currentPrice >= newSL)
      ) {
        await closePosition("SL reached", entryPrice);
      }
    }
    previousPositionAmount = amountSafe;
  } catch (err) {
    console.error("❌ Position: Failed to check position status.", err.message);
  }
};

// -------------------- MAIN LOOP --------------------
setInterval(async () => {
  try {
    const { position } = await getPositionFromBalance();
    const amount = parseFloat(position?.positionAmt || "0");
    const hasActiveBinancePosition = isFinite(amount) && Math.abs(amount) > 0;
    await checkPositionStatus();
    console.log("🔍 Main Loop: Checking for new signals...");

    const signal = await analyzeSignal();
    if (!signal.price) {
      console.log("⚠️ Analysis: Invalid signal, waiting...");
      return;
    }

    const hasBotPosition = db.activePosition !== null;
    let shouldExitCurrentPosition = false;

    // Swing logic: check if the current position should be closed due to a reverse signal
    if (hasBotPosition) {
      const currentSide = db.activePosition.side;
      if ((currentSide === "buy" && signal.canShort) || (currentSide === "sell" && signal.canLong)) {
        console.log("⚠️ Signal: Reverse signal is valid, closing active position.");
        shouldExitCurrentPosition = true;
      }
    }

    // Execute position closure for a swing trade
    if (shouldExitCurrentPosition) {
      await closePosition("Reverse signal", db.activePosition.entryPrice);
      // Wait a moment to ensure the previous position is fully closed
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    // Re-check position status after a potential closure
    const { position: updatedPosition } = await getPositionFromBalance();
    const updatedAmount = parseFloat(updatedPosition?.positionAmt || "0");
    const hasActiveBinancePositionAfterClose = isFinite(updatedAmount) && Math.abs(updatedAmount) > 0;

    // Open a new position only if no active position exists
    if (db.activePosition === null && !hasActiveBinancePositionAfterClose) {
      if (signal.canLong) {
        console.log("🚀 Signal: Valid LONG signal and bot is ready. Placing order.");
        db.lastLongEntryTime = new Date().getTime();
        saveDB();
        await placeOrder(
          "buy",
          signal.targetLong,
          signal.stopLossLong,
          signal.longOffset,
          signal.midPriceLong
        );
      } else if (signal.canShort) {
        console.log("📉 Signal: Valid SHORT signal and bot is ready. Placing order.");
        db.lastShortEntryTime = new Date().getTime();
        saveDB();
        await placeOrder(
          "sell",
          signal.targetShort,
          signal.stopLossShort,
          signal.shortOffset,
          signal.midPriceShort
        );
      } else {
        console.log("💤 Signal: No valid signal found. Waiting...");
      }
    } else if (db.activePosition !== null) {
      // Update TP/SL and offset if a position is already active
      console.log("➡️ Active position detected. Checking for TP/SL and offset updates.");
      if (signal.price) {
        const { side } = db.activePosition;
        let newSL, newTP, newOffset;
        if (side === "buy") {
          newSL = signal.stopLossLong;
          newTP = signal.targetLong;
          newOffset = signal.longOffset;
        } else if (side === "sell") {
          newSL = signal.stopLossShort;
          newTP = signal.targetShort;
          newOffset = signal.shortOffset;
        }
        if (newSL !== db.activePosition.sl || newTP !== db.activePosition.tp || newOffset !== db.activePosition.offset) {
          console.log("✅ Signal: New TP/SL/Offset detected! Updating database.");
          db.activePosition.sl = newSL;
          db.activePosition.tp = newTP;
          db.activePosition.offset = newOffset;
          saveDB();
        } else {
          console.log("✔️ Signal: No changes to TP/SL/Offset. No updates needed.");
        }
      } else {
        console.log("⚠️ Analysis: Invalid signal. Cannot update TP/SL/Offset.");
      }
    }
  } catch (e) {
    console.error("⚠️ Loop: An error occurred in the main loop.", e.message);
    console.error(e.stack);
  }
}, 10000); // 10-second interval