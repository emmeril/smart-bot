// =====================================================
// signal.js — Deteksi Posisi, TP/SL, dan Eksekusi Otomatis
// =====================================================
require("dotenv").config();
const fs = require("fs");
const ccxt = require("ccxt");
const { SMA } = require("technicalindicators");

// -------------------- CONFIG --------------------
const dbPath = "./db.json";
const logPath = "./log.csv";

// -------------------- FILE INIT --------------------
if (!fs.existsSync(logPath)) {
  fs.writeFileSync(logPath, "timestamp,pair,type,entry,tp,sl,status,pnl\n");
  console.log("📝 Log: File log.csv dibuat.");
}

const db = fs.existsSync(dbPath)
  ? JSON.parse(fs.readFileSync(dbPath))
  : {
      pair: "XRP/USDT:USDT",
      lastLongEntryTime: 0,
      lastShortEntryTime: 0,
      leverage: 10,
      marginMode: "ISOLATED",
      activePosition: null,
      usdtPerTrade: 5.1,
    };

let prevPosAmt = 0;

console.log(`⚙️ Konfigurasi Bot:
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
    console.log("✅ Exchange: Markets berhasil dimuat.");
  } catch (err) {
    console.error("❌ Gagal memuat markets:", err.message);
  }
})();

// -------------------- UTIL --------------------
const saveDB = () => fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

const formatPrice = (price, pair = db.pair) => {
  if (!price || !isFinite(price)) return "N/A";
  const market = exchange.markets[pair];
  let decimals = market?.precision?.price ?? 5;
  if (price < 1 && decimals < 5) decimals = 5;
  return price.toFixed(decimals);
};

const getPrice = async () => {
  try {
    const t = await exchange.fetchTicker(db.pair);
    console.log(`💰 Harga ${db.pair}: ${formatPrice(t.last)}`);
    return t.last;
  } catch (e) {
    console.error("❌ Gagal mengambil harga:", e.message);
    return null;
  }
};

const calcQty = (price) => {
  if (!price) return 0;
  const prec = exchange.markets[db.pair]?.precision?.amount ?? 3;
  const qty = parseFloat((db.usdtPerTrade / price).toFixed(prec));
  console.log(`📐 Kuantitas: ${qty} (${db.usdtPerTrade} USDT)`);
  return qty;
};

const logSignal = (type, entry, tp, sl, status, pnl = null) => {
  const line = `${new Date().toISOString()},${db.pair},${type},${entry ?? ""},${tp ?? ""},${sl ?? ""},${status},${isFinite(pnl) ? pnl.toFixed(6) : ""}\n`;
  fs.appendFileSync(logPath, line);
  console.log("📝 Log sinyal dicatat.");
};

const getMarketId = () => {
  try {
    return exchange.markets[db.pair]?.id || db.pair.replace("/", "").replace(":", "");
  } catch {
    return db.pair.replace("/", "").replace(":", "");
  }
};

const getPositionFromBalance = async () => {
  try {
    const bal = await exchange.fetchBalance();
    const marketId = getMarketId();
    const positions = bal.info?.positions || [];

    const norm = (s) => (s || "").toString().replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    const found = positions.find(
      (p) =>
        p.symbol === marketId ||
        p.contractCode === marketId ||
        norm(p.symbol) === norm(marketId) ||
        norm(p.contractCode) === norm(marketId)
    );

    return { balance: bal, position: found };
  } catch (err) {
    console.error("❌ Gagal ambil posisi:", err.message);
    return { balance: null, position: null };
  }
};

// -------------------- ORDER HANDLER --------------------
const placeOrder = async (side, tp, sl) => {
  console.log("🔍 Cek posisi aktif...");
  if (db.activePosition) return console.log("⚠️ Masih ada posisi terbuka, order dibatalkan.");

  const { position } = await getPositionFromBalance();
  const amt = parseFloat(position?.positionAmt || "0");
  if (Math.abs(amt) > 0) return console.log("⚠️ Posisi aktif di akun, order dibatalkan.");

  const price = await getPrice();
  if (!price) return console.log("❌ Gagal dapat harga, order dibatalkan.");

  const qty = calcQty(price);
  console.log(`➡️ ENTRY ${side.toUpperCase()} | Qty: ${qty} | Entry: ${formatPrice(price)} | TP: ${formatPrice(tp)} | SL: ${formatPrice(sl)}`);

  try {
    await exchange.setLeverage(db.leverage, db.pair);
    await exchange.setMarginMode(db.marginMode, db.pair);
  } catch (e) {
    console.warn("⚠️ Gagal set leverage/margin:", e.message);
  }

  try {
    const order = await exchange.createOrder(db.pair, "market", side, qty);
    db.activePosition = { side, entryPrice: price, tp, sl, orderId: order.id };
    saveDB();
    logSignal(side === "buy" ? "LONG" : "SHORT", price, tp, sl, "ORDER_PLACED");
  } catch (e) {
    console.error("❌ Gagal buat order:", e.message);
  }
};

const closePosition = async (reason, entryPrice = "N/A") => {
  console.log(`🚨 Menutup posisi: ${reason}`);
  try {
    const { position } = await getPositionFromBalance();
    const qty = parseFloat(position?.positionAmt || "0");
    if (!isFinite(qty) || qty === 0) return console.log("ℹ️ Tidak ada posisi aktif.");

    const side = qty > 0 ? "sell" : "buy";
    const amount = Math.abs(qty);
    await exchange.createOrder(db.pair, "market", side, amount, undefined, { reduceOnly: true });
    console.log(`✅ Posisi ditutup (${side}, ${amount}).`);

    const exitPrice = await getPrice();
    let pnl = null;
    if (entryPrice !== "N/A" && db.activePosition) {
      const { tp, sl, side: entrySide } = db.activePosition;
      const exitNum = /TP/i.test(reason)
        ? entrySide === "buy" ? tp : sl
        : /SL/i.test(reason)
        ? entrySide === "buy" ? sl : tp
        : exitPrice;
      pnl = (entrySide === "buy" ? exitNum - entryPrice : entryPrice - exitNum) * amount;
    }

    logSignal(qty > 0 ? "LONG" : "SHORT", entryPrice, db.activePosition?.tp, db.activePosition?.sl, reason, pnl);
  } catch (err) {
    console.error("❌ Gagal menutup posisi:", err.message);
  } finally {
    db.activePosition = null;
    saveDB();
  }
};

// -------------------- ANALISA TEKNIKAL --------------------
const analyzeSignal = async () => {
  console.log("🧠 Analisis teknikal...");
  const ohlcv = await exchange.fetchOHLCV(db.pair, "15m", undefined, 200);
  if (!ohlcv?.length) return {};

  const close = ohlcv.map((c) => c[4]);
  const high = ohlcv.map((c) => c[2]);
  const low = ohlcv.map((c) => c[3]);

  const ma7 = SMA.calculate({ values: close, period: 7 }).pop();
  const ma25 = SMA.calculate({ values: close, period: 25 }).pop();
  const ma99 = SMA.calculate({ values: close, period: 99 }).pop();
  const price = close.at(-1);

  const prevMA7 = SMA.calculate({ values: close.slice(0, -1), period: 7 }).pop();
  const prevMA25 = SMA.calculate({ values: close.slice(0, -1), period: 25 }).pop();

  const crossedUp = ma7 > ma25 && prevMA7 <= prevMA25;
  const crossedDown = ma7 < ma25 && prevMA7 >= prevMA25;
  const canLong = crossedUp && ma7 > ma99 && ma25 > ma99;
  const canShort = crossedDown && ma7 < ma99 && ma25 < ma99;

  const findSwingLevels = (highArr, lowArr, lookback) => {
    const highs = [], lows = [];
    for (let i = 2; i < lookback - 2; i++) {
      if (highArr[i] > highArr[i - 1] && highArr[i] > highArr[i + 1]) highs.push(highArr[i]);
      if (lowArr[i] < lowArr[i - 1] && lowArr[i] < lowArr[i + 1]) lows.push(lowArr[i]);
    }
    return {
      resistance: highs.length ? Math.max(...highs) : Math.max(...highArr),
      support: lows.length ? Math.min(...lows) : Math.min(...lowArr),
    };
  };

  const { support, resistance } = findSwingLevels(high.slice(-96), low.slice(-96), 96);

  console.log(`📊 ${db.pair} | LONG: ${canLong ? "✅" : "❌"} | SHORT: ${canShort ? "✅" : "❌"} | Price: ${formatPrice(price)}`);
  return { canLong, canShort, targetLong: resistance, stopLossLong: support, targetShort: support, stopLossShort: resistance, price };
};

// -------------------- MONITOR TP/SL --------------------
const checkPositionStatus = async () => {
  try {
    const { position } = await getPositionFromBalance();
    const amt = parseFloat(position?.positionAmt || "0");
    const prevSafe = isFinite(prevPosAmt) ? prevPosAmt : 0;

    if (prevSafe !== 0 && amt === 0) {
      console.log("📉 Posisi manual ditutup.");
      db.activePosition = null;
      saveDB();
    }

    if (db.activePosition && amt !== 0) {
      const { tp, sl, side, entryPrice } = db.activePosition;
      const currentPrice = await getPrice();
      if (!currentPrice) return;

      if (side === "buy") {
        if (currentPrice >= tp) return closePosition("TP tercapai", entryPrice);
        if (currentPrice <= sl) return closePosition("SL tercapai", entryPrice);
      } else {
        if (currentPrice <= tp) return closePosition("TP tercapai", entryPrice);
        if (currentPrice >= sl) return closePosition("SL tercapai", entryPrice);
      }
    }

    prevPosAmt = amt;
  } catch (err) {
    console.error("❌ Gagal cek posisi:", err.message);
  }
};

// -------------------- MAIN LOOP --------------------
setInterval(async () => {
  try {
    await checkPositionStatus();
    console.log("🔁 Loop utama berjalan...");

    const sig = await analyzeSignal();
    if (!sig.price) return console.log("⚠️ Tidak ada data harga.");

    let shouldExit = false;
    if (db.activePosition) {
      const curSide = db.activePosition.side;
      if ((curSide === "buy" && sig.canShort) || (curSide === "sell" && sig.canLong)) {
        shouldExit = true;
        await closePosition("Sinyal berbalik", db.activePosition.entryPrice);
        await new Promise((r) => setTimeout(r, 15000));
      }
    }

    const { position } = await getPositionFromBalance();
    const amt = parseFloat(position?.positionAmt || "0");
    if (!db.activePosition && Math.abs(amt) === 0) {
      if (sig.canLong && sig.price <= sig.targetLong)
        await placeOrder("buy", sig.targetLong, sig.stopLossLong);
      else if (sig.canShort && sig.price >= sig.targetShort)
        await placeOrder("sell", sig.targetShort, sig.stopLossShort);
      else console.log("💤 Tidak ada sinyal valid.");
    }
  } catch (e) {
    console.error("⚠️ Error loop utama:", e.message);
  }
}, 30000);
