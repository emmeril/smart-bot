# 📈 Crypto Trading Bot (Binance Futures + WhatsApp Control)

Bot trading otomatis untuk **Binance Futures** dengan integrasi **WhatsApp Web** sebagai panel kontrol.  
Menggunakan strategi **MA Crossover (7 vs 25) dengan filter MA99**, trailing stop otomatis, serta pencatatan PnL ke log.

---

## 🚀 Fitur Utama
- ✅ **Integrasi Binance Futures** via [ccxt](https://github.com/ccxt/ccxt)  
- ✅ **Kontrol Bot via WhatsApp** (ubah pair, leverage, order size, reset, status, rekap PnL)  
- ✅ **Manajemen Posisi**
  - Entry hanya jika tidak ada posisi aktif (bot/akun)
  - Close otomatis jika TP/SL tercapai
  - Trailing Stop Loss dengan offset dinamis
  - Swing posisi (close posisi lama jika sinyal berbalik)  
- ✅ **Strategi Analisis**
  - Sinyal LONG: MA7 cross up MA25 + harga di atas MA99
  - Sinyal SHORT: MA7 cross down MA25 + harga di bawah MA99
  - TP/SL dari high/low 16 candle terakhir (TF 15m)
- ✅ **Logging**
  - Semua order tercatat di `log.csv`
  - Rekap PnL bisa ditarik lewat WhatsApp (`!pnl`)

---

## ⚙️ Instalasi

### 1. Clone Repo
```bash
git clone https://github.com/username/crypto-trading-bot.git
cd crypto-trading-bot
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Konfigurasi Environment
Buat file `.env`:
```env
API_KEY=your_binance_api_key
API_SECRET=your_binance_api_secret
ADMIN_PHONE=628xxxxxx   # Nomor WhatsApp admin
PUPPETEER_PATH=/usr/bin/chromium  # Sesuaikan path Chromium
```

### 4. Jalankan Bot
```bash
node done.js
```

---

## 📱 Perintah WhatsApp
Kirim pesan dari nomor admin ke WhatsApp bot:

- `!pair BTC/USDT:USDT` → Ganti pair trading  
- `!leverage 20 isolated` → Set leverage & margin mode  
- `!order 10` → Set jumlah USDT per trade  
- `!reset` → Reset status posisi bot  
- `!pnl` → Lihat rekap profit/loss  
- `!status` → Cek saldo, posisi aktif, TP/SL, dan status bot  

---

## 📊 Log & Database
- **db.json** → Menyimpan state bot (pair, leverage, posisi aktif, dll)  
- **log.csv** → Menyimpan riwayat order, TP/SL, PnL

Format `log.csv`:
```csv
timestamp,pair,type,entry,tp,sl,status,pnl
2025-09-26T08:20:10.123Z,XRP/USDT:USDT,LONG,0.521,0.540,0.510,TP_REALIZED,0.920000
```

---

## 🧠 Catatan
- PnL yang ditampilkan adalah **estimasi** (belum memperhitungkan fee Binance).  
- Strategi bawaan masih sederhana (MA crossover), sebaiknya dipadukan dengan filter RSI/MACD/ADX.  
- Loop utama jalan tiap **10 detik** → bisa diubah sesuai kebutuhan.  
- Pastikan server punya Chromium/Chrome agar WhatsApp Web bisa jalan.  

---

## 📜 Lisensi
MIT License  
