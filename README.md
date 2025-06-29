<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Smart Bot - Binance Futures AI Trading Bot</title>
  <style>
    body {
      font-family: "Segoe UI", sans-serif;
      line-height: 1.6;
      padding: 2rem;
      max-width: 800px;
      margin: auto;
      color: #333;
    }
    h1, h2 {
      color: #1e88e5;
    }
    code {
      background: #f5f5f5;
      padding: 2px 6px;
      border-radius: 4px;
    }
    pre {
      background: #f5f5f5;
      padding: 1rem;
      border-radius: 6px;
      overflow: auto;
    }
    .badge {
      display: inline-block;
      background: #4caf50;
      color: white;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      margin-left: 8px;
    }
  </style>
</head>
<body>
  <h1>🤖 Smart Bot Trading - Binance Futures</h1>
  <p><strong>Smart.js</strong> adalah bot trading <strong>Binance Futures</strong> yang bekerja otomatis berbasis kombinasi <em>technical indicators</em>, trailing stop, dan pengendalian risiko.</p>

  <h2>✨ Fitur Unggulan</h2>
  <ul>
    <li>📈 <strong>Auto Trading Long & Short</strong> secara bersamaan (Hedge Mode)</li>
    <li>🧠 <strong>AI-based Entry Rules</strong>: RSI, MACD, EMA20/50, ADX, Candlestick</li>
    <li>🎯 <strong>Trailing Stop Take Profit</strong> aktif saat profit &gt; 3%</li>
    <li>🛡️ <strong>Auto Stop Loss</strong> jika rugi 2%</li>
    <li>⏱️ <strong>Auto Cut Timeout</strong> jika posisi terlalu lama (default: 45–1440 menit)</li>
    <li>📊 <strong>Backtest Mode</strong> selama 30 hari dengan hasil log & PnL</li>
    <li>📤 <strong>Log Transaksi</strong> otomatis ke <code>log.csv</code></li>
    <li>📱 <strong>Notifikasi WhatsApp</strong> (via <code>whatsapp-web.js</code>)</li>
    <li>🧾 <strong>Control via WhatsApp</strong> seperti <code>!status</code>, <code>!leverage</code>, <code>!pair</code>, <code>!pnl</code></li>
    <li>⚙️ <strong>Mode Konservatif & Agresif</strong> untuk sinyal entry</li>
    <li>📆 <strong>Auto Pause Trading Saat Weekend</strong> (Sabtu & Minggu)</li>
  </ul>

  <h2>🚀 Cara Jalankan</h2>
  <pre><code>npm install
node smart.js            # mode live trading
node smart.js --backtest # mode backtest 30 hari
</code></pre>

  <h2>📟 WhatsApp Command List</h2>
  <ul>
    <li><code>!status</code> – Melihat status bot, posisi, floating PnL</li>
    <li><code>!pair DOGE/USDT:USDT</code> – Ganti pair</li>
    <li><code>!leverage 10 isolated</code> – Atur leverage & margin mode</li>
    <li><code>!balance 30</code> – Gunakan 30% dari saldo untuk entry</li>
    <li><code>!pnl</code> – Ringkasan profit & loss total</li>
    <li><code>!mode agresif</code> / <code>!mode konservatif</code> – Ganti strategi entry</li>
    <li><code>!maxhold 60</code> – Ubah batas waktu posisi terbuka (dalam menit)</li>
  </ul>

  <h2>📁 Struktur File</h2>
  <ul>
    <li><code>smart.js</code> – Bot utama</li>
    <li><code>db.json</code> – Penyimpanan status dan pengaturan</li>
    <li><code>log.csv</code> – Log transaksi lengkap (entry/exit, PnL)</li>
  </ul>

  <h2>🧠 Strategi Entry</h2>
  <p>Bot hanya akan entry jika semua indikator teknikal berikut terpenuhi:</p>
  <ul>
    <li>RSI <code>&lt; 35</code> untuk Long, <code>&gt; 65</code> untuk Short</li>
    <li>MACD Histogram mendukung arah</li>
    <li>EMA20 > EMA50 (Long) atau EMA20 &lt; EMA50 (Short)</li>
    <li>ADX &gt; 20</li>
    <li>Konfirmasi candle kuat (Bullish/Bearish)</li>
    <li><strong>(Opsional)</strong> Engulfing Pattern</li>
  </ul>

  <h2>🛡️ Manajemen Risiko</h2>
  <ul>
    <li>Stop loss otomatis jika harga turun lebih dari 2%</li>
    <li>Trailing TP aktif saat profit ≥ 3%</li>
    <li>Auto-close jika posisi terbuka terlalu lama (default 45–1440 menit)</li>
    <li>Loss limit per arah: max 3x berturut-turut</li>
    <li>Cooldown per arah setelah entry</li>
  </ul>

  <h2>📈 Backtest 30 Hari</h2>
  <p>Gunakan <code>--backtest</code> untuk simulasi performa 30 hari terakhir dan lihat hasilnya di <code>log.csv</code>. Terdapat info lengkap: Winrate, Net PnL, dan jumlah posisi.</p>

  <h2>🛠️ Teknologi</h2>
  <ul>
    <li><strong>ccxt</strong> – Binance API wrapper</li>
    <li><strong>technicalindicators</strong> – Indikator teknikal</li>
    <li><strong>whatsapp-web.js</strong> – WhatsApp bot</li>
    <li><strong>Node.js</strong> – Core runtime</li>
  </ul>

  <h2>📌 Disclaimer</h2>
  <p>Bot ini bersifat eksperimental. Gunakan di akun <strong>demo</strong> atau modal kecil. Tidak ada jaminan profit. Selalu pahami risiko trading futures.</p>

  <hr/>
  <p style="font-size: 0.9em; color: #777">Made with ❤️ by Hafri & ChatGPT</p>
</body>
</html>
