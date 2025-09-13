// backtest_simple.js
require("dotenv").config();
const ccxt = require("ccxt");
const { RSI, EMA, MACD, ADX } = require("technicalindicators");

// -------------------- CONFIG --------------------
const PAIR = "DOGE/USDT:USDT"; // Ganti sesuai pair yang ingin Anda tes
const TIME_FRAME = "15m";
const LOOKBACK_MONTHS = 6;

// -------------------- EXCHANGE --------------------
const exchange = new ccxt.binance({
  apiKey: process.env.API_KEY,
  secret: process.env.API_SECRET,
  options: { defaultType: "future" },
});

// -------------------- MAIN LOGIC --------------------
const runBacktest = async () => {
  console.log(`\n🧠 Memulai backtest untuk ${PAIR} selama ${LOOKBACK_MONTHS} bulan terakhir...`);

  // Ambil data OHLCV
  const now = exchange.milliseconds();
  const oneMonthAgo = now - 1000 * 60 * 60 * 24 * 30 * LOOKBACK_MONTHS;
  const ohlcv = await exchange.fetchOHLCV(PAIR, TIME_FRAME, oneMonthAgo);
  
  if (!ohlcv || ohlcv.length < 200) {
    return console.error("❌ Data: Data historis tidak cukup untuk backtest.");
  }
  
  const closePrices = ohlcv.map(c => c[4]);
  const highPrices = ohlcv.map(c => c[2]);
  const lowPrices = ohlcv.map(c => c[3]);
  
  let balance = 100;
  let position = null;
  let entryPrice = 0;
  let trades = [];
  
  for (let i = 200; i < ohlcv.length; i++) {
    const subsetClose = closePrices.slice(0, i);
    const subsetHigh = highPrices.slice(0, i);
    const subsetLow = lowPrices.slice(0, i);
    
    // Analisis Sinyal (sama dengan bot utama)
    const rsi = RSI.calculate({ values: subsetClose.slice(-50), period: 14 }).pop();
    const ema20 = EMA.calculate({ values: subsetClose.slice(-50), period: 20 }).pop();
    const ema50 = EMA.calculate({ values: subsetClose.slice(-50), period: 50 }).pop();
    const ma200 = EMA.calculate({ values: subsetClose, period: 200 }).pop();
    const macd = MACD.calculate({ values: subsetClose.slice(-50), fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }).pop();
    const adx = ADX.calculate({ close: subsetClose.slice(-50), high: subsetHigh.slice(-50), low: subsetLow.slice(-50), period: 14 }).pop();

    const price = subsetClose.at(-1);
    const prev = ohlcv[i - 1];
    const prev2 = ohlcv[i - 2];
    
    const isBullishEngulf = prev2[1] > prev2[4] && prev[1] < prev[4] && prev[1] < prev2[4] && prev[4] > prev2[1];
    const isBearishEngulf = prev2[1] < prev2[4] && prev[1] > prev[4] && prev[1] > prev2[4] && prev[4] < prev2[1];
    const isAboveMA200 = price > ma200;
    const isBelowMA200 = price < ma200;

    let scoreLong = 0;
    if (rsi < 35) scoreLong++;
    if (macd?.histogram > 0) scoreLong++;
    if (ema20 > ema50) scoreLong++;
    if (adx?.adx > 20) scoreLong++;
    if (isBullishEngulf) scoreLong += 2;
  
    let scoreShort = 0;
    if (rsi > 65) scoreShort++;
    if (macd?.histogram < 0) scoreShort++;
    if (ema20 < ema50) scoreShort++;
    if (adx?.adx > 20) scoreShort++;
    if (isBearishEngulf) scoreShort += 2;
  
    const canLong = scoreLong >= 3 && isAboveMA200;
    const canShort = scoreShort >= 3 && isBelowMA200;

    const targetLong = Math.max(...subsetHigh.slice(-10));
    const stopLossLong = Math.min(...subsetLow.slice(-5));
    const targetShort = Math.min(...subsetLow.slice(-10));
    const stopLossShort = Math.max(...subsetHigh.slice(-5));
    
    // Logika Simulasi Entry/Exit
    if (position === "long" && (price >= targetLong || price <= stopLossLong)) {
        const pnl = (price - entryPrice) / entryPrice;
        balance *= (1 + pnl);
        trades.push({ type: "long", pnl, exitType: price >= targetLong ? "TP" : "SL" });
        position = null;
    } else if (position === "short" && (price <= targetShort || price >= stopLossShort)) {
        const pnl = (entryPrice - price) / entryPrice;
        balance *= (1 + pnl);
        trades.push({ type: "short", pnl, exitType: price <= targetShort ? "TP" : "SL" });
        position = null;
    }

    if (!position) {
        if (canLong) {
            position = "long";
            entryPrice = price;
        } else if (canShort) {
            position = "short";
            entryPrice = price;
        }
    }
  }
  
  // Laporan Akhir
  const finalProfit = balance - 100;
  const winTrades = trades.filter(t => t.pnl > 0).length;
  const lossTrades = trades.filter(t => t.pnl <= 0).length;
  
  console.log(`\n\n===================================`);
  console.log(`📝 *LAPORAN BACKTEST*`);
  console.log(`===================================`);
  console.log(`- Pair: ${PAIR}`);
  console.log(`- Saldo Awal: $100`);
  console.log(`- Saldo Akhir: $${balance.toFixed(2)}`);
  console.log(`- Total Profit/Loss: $${finalProfit.toFixed(2)} (${(finalProfit).toFixed(2)}%)`);
  console.log(`- Total Trade: ${trades.length}`);
  console.log(`- Menang (Win): ${winTrades} (${((winTrades / trades.length) * 100).toFixed(2)}%)`);
  console.log(`- Kalah (Loss): ${lossTrades} (${((lossTrades / trades.length) * 100).toFixed(2)}%)`);
  console.log(`===================================`);
};

// Jalankan skrip
runBacktest();
