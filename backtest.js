require("dotenv").config();
const ccxt = require("ccxt");
const { RSI, EMA, MACD, ADX } = require("technicalindicators");

// -------------------- KONFIGURASI BACKTEST --------------------
const PAIR = "XRP/USDT:USDT"; // Ganti sesuai pair yang ingin Anda tes
const TIME_FRAME = "15m";
const LOOKBACK_MONTHS = 6; // Ubah durasi backtest
const INITIAL_BALANCE = 100; // Saldo awal simulasi
const COOLDOWN_MINUTES = 5;

// -------------------- EXCHANGE & UTILITAS --------------------
const exchange = new ccxt.binance({
  apiKey: process.env.API_KEY,
  secret: process.env.API_SECRET,
  options: { defaultType: "future" },
});

const formatPrice = (price, pair = PAIR) => {
  if (typeof price !== "number" || !isFinite(price)) return "N/A";
  const market = exchange.markets[pair];
  let decimals = market?.precision?.price ?? 5;
  if (price < 1 && decimals < 5) decimals = 5;
  if (decimals <= 0) decimals = 5;
  return price.toFixed(decimals);
};

const mins = (ms) => ms / 1000 / 60;

// -------------------- ANALISIS SINYAL (LOGIKA ASLI ANDA) --------------------
const analyzeHistoricalSignal = (ohlcvData) => {
  const close = ohlcvData.map((c) => c[4]);
  const high = ohlcvData.map((c) => c[2]);
  const low = ohlcvData.map((c) => c[3]);

  if (close.length < 200) {
    return {};
  }

  const rsi = RSI.calculate({ values: close.slice(-50), period: 14 }).pop();
  const ema20 = EMA.calculate({ values: close.slice(-50), period: 20 }).pop();
  const ema50 = EMA.calculate({ values: close.slice(-50), period: 50 }).pop();
  const ma200 = EMA.calculate({ values: close, period: 200 }).pop();
  const macd = MACD.calculate({ values: close.slice(-50), fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }).pop();
  const adx = ADX.calculate({ close: close.slice(-50), high: high.slice(-50), low: low.slice(-50), period: 14 }).pop();

  const price = close.at(-1);
  const prevCandle = ohlcvData.at(-2);
  const prevPrevCandle = ohlcvData.at(-3);

  const candleBody = Math.abs(prevCandle[4] - prevCandle[1]);
  const candleRange = prevCandle[2] - prevCandle[3];
  const isStrongCandle = candleBody / candleRange >= 0.4;
  const candleUp = prevCandle[4] > prevCandle[1];
  const candleDown = prevCandle[4] < prevCandle[1];

  const isBullishEngulfing =
    prevPrevCandle[1] > prevPrevCandle[4] &&
    prevCandle[1] < prevCandle[4] &&
    prevCandle[1] < prevPrevCandle[4] &&
    prevCandle[4] > prevPrevCandle[1];

  const isBearishEngulfing =
    prevPrevCandle[1] < prevPrevCandle[4] &&
    prevCandle[1] > prevCandle[4] &&
    prevCandle[1] > prevPrevCandle[4] &&
    prevCandle[4] < prevCandle[1];

  let scoreLong = 0;
  if (isFinite(rsi) && rsi < 35) scoreLong++;
  if (isFinite(macd?.histogram) && macd?.histogram > 0) scoreLong++;
  if (isFinite(ema20) && isFinite(ema50) && ema20 > ema50) scoreLong++;
  if (isFinite(adx?.adx) && adx?.adx > 20) scoreLong++;
  if (isStrongCandle && candleUp) scoreLong++;
  if (isBullishEngulfing) scoreLong += 2;

  let scoreShort = 0;
  if (isFinite(rsi) && rsi > 65) scoreShort++;
  if (isFinite(macd?.histogram) && macd?.histogram < 0) scoreShort++;
  if (isFinite(ema20) && isFinite(ema50) && ema20 < ema50) scoreShort++;
  if (isFinite(adx?.adx) && adx?.adx > 20) scoreShort++;
  if (isStrongCandle && candleDown) scoreShort++;
  if (isBearishEngulfing) scoreShort += 2;

  const high10 = Math.max(...high.slice(-10));
  const low10 = Math.min(...low.slice(-10));

  const targetLong = high10;
  const stopLossLong = Math.min(...low.slice(-5));
  const targetShort = low10;
  const stopLossShort = Math.max(...high.slice(-5));

  const canLong = scoreLong >= 3 && isFinite(price) && isFinite(ma200) && price > ma200 && isBullishEngulfing;
  const canShort = scoreShort >= 3 && isFinite(price) && isFinite(ma200) && price < ma200 && isBearishEngulfing;

  return { canLong, canShort, targetLong, stopLossLong, targetShort, stopLossShort, price };
};

// -------------------- FUNGSI BACKTESTING UTAMA --------------------
const runBacktest = async () => {
  console.log(`\n🧠 Memulai backtest untuk ${PAIR} selama ${LOOKBACK_MONTHS} bulan terakhir...`);

  const now = exchange.milliseconds();
  const oneMonthAgo = now - 1000 * 60 * 60 * 24 * 30 * LOOKBACK_MONTHS;
  
  // Ambil semua data historis
  const ohlcv = await exchange.fetchOHLCV(PAIR, TIME_FRAME, oneMonthAgo);
  
  if (!ohlcv || ohlcv.length < 200) {
    return console.error("❌ Data: Data historis tidak cukup untuk backtest.");
  }
  
  let balance = INITIAL_BALANCE;
  let position = null;
  let entryPrice = 0;
  let trades = [];
  let lastEntryTime = 0;
  
  for (let i = 200; i < ohlcv.length; i++) {
    const historicalSubset = ohlcv.slice(0, i + 1);
    const currentTime = ohlcv[i][0];
    
    const sig = analyzeHistoricalSignal(historicalSubset);
    
    // Logika simulasi
    if (position === "long" && (sig.price >= sig.targetLong || sig.price <= sig.stopLossLong)) {
        const pnl = (sig.price - entryPrice) / entryPrice;
        balance *= (1 + pnl);
        trades.push({ type: "long", pnl, exitType: sig.price >= sig.targetLong ? "TP" : "SL" });
        position = null;
        console.log(`[EXIT] ${new Date(currentTime).toISOString()} | PnL: ${(pnl*100).toFixed(2)}% | Balance: $${balance.toFixed(2)}`);
    } else if (position === "short" && (sig.price <= sig.targetShort || sig.price >= sig.stopLossShort)) {
        const pnl = (entryPrice - sig.price) / entryPrice;
        balance *= (1 + pnl);
        trades.push({ type: "short", pnl, exitType: sig.price <= sig.targetShort ? "TP" : "SL" });
        position = null;
        console.log(`[EXIT] ${new Date(currentTime).toISOString()} | PnL: ${(pnl*100).toFixed(2)}% | Balance: $${balance.toFixed(2)}`);
    }

    if (!position && mins(currentTime - lastEntryTime) >= COOLDOWN_MINUTES) {
        if (sig.canLong) {
            position = "long";
            entryPrice = sig.price;
            lastEntryTime = currentTime;
            console.log(`[ENTRY] ${new Date(currentTime).toISOString()} | LONG @ $${formatPrice(entryPrice)}`);
        } else if (sig.canShort) {
            position = "short";
            entryPrice = sig.price;
            lastEntryTime = currentTime;
            console.log(`[ENTRY] ${new Date(currentTime).toISOString()} | SHORT @ $${formatPrice(entryPrice)}`);
        }
    }
  }
  
  // Tampilkan laporan akhir
  const finalProfit = balance - INITIAL_BALANCE;
  const winTrades = trades.filter(t => t.pnl > 0).length;
  const lossTrades = trades.filter(t => t.pnl <= 0).length;
  
  console.log(`\n\n===================================`);
  console.log(`📝 *LAPORAN BACKTEST*`);
  console.log(`===================================`);
  console.log(`- Pair: ${PAIR}`);
  console.log(`- Periode: ${LOOKBACK_MONTHS} bulan terakhir`);
  console.log(`- Saldo Awal: $${INITIAL_BALANCE}`);
  console.log(`- Saldo Akhir: $${balance.toFixed(2)}`);
  console.log(`- Total Profit/Loss: $${finalProfit.toFixed(2)} (${(finalProfit).toFixed(2)}%)`);
  console.log(`- Total Trade: ${trades.length}`);
  console.log(`- Menang (Win): ${winTrades} (${((winTrades / trades.length) * 100).toFixed(2)}%)`);
  console.log(`- Kalah (Loss): ${lossTrades} (${((lossTrades / trades.length) * 100).toFixed(2)}%)`);
  console.log(`===================================`);
};

// Jalankan skrip
(async () => {
    try {
      await exchange.loadMarkets();
      runBacktest();
    } catch (err) {
      console.error("❌ Exchange: Gagal memuat markets.", err.message);
    }
})();
