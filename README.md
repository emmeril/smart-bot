# 🧠 Binance Futures Auto Trading Bot (Stabilized Connection Version)

Bot ini adalah sistem **trading otomatis untuk Binance Futures** berbasis **Node.js** menggunakan library **ccxt**.  
Bot ini memiliki koneksi stabil, manajemen posisi otomatis (TP/SL), auto recovery setelah restart, serta analisis teknikal cerdas menggunakan **Moving Average (MA) crossover** dan **ATR-based Support & Resistance**.

---

## 🚀 Fitur Utama

✅ **Koneksi Stabil & Otomatis Reconnect**  
- Mendeteksi koneksi terputus dan melakukan reinitialisasi hingga 5 kali percobaan.

✅ **Analisis Teknis Otomatis**  
- Berdasarkan kombinasi SMA(7), SMA(25), dan SMA(99).  
- Mendeteksi potensi sinyal **LONG** dan **SHORT**.

✅ **Smart Support & Resistance Detection**  
- Menggunakan ATR (Average True Range) dan analisa pola candle untuk menentukan **TP (Take Profit)** & **SL (Stop Loss)** yang realistis.

✅ **Manajemen Posisi Otomatis**
- Entry Market (LONG/SHORT)
- Otomatis menutup posisi jika sinyal berbalik
- TP dan SL otomatis
- Auto recovery posisi setelah restart bot

✅ **Auto Logging**
- Semua order dan sinyal disimpan di file `log.csv`
- Posisi aktif dan konfigurasi disimpan di `db.json`

✅ **Health & Safety**
- Auto health check setiap loop
- Skip siklus jika koneksi API bermasalah

---

## ⚙️ Instalasi

### 1. Clone / Download Repository
```bash
git clone https://github.com/emmeril/smart-bot.git
cd smart-bot
```

*(Jika kamu hanya punya file `bot.js`, cukup simpan file ini di folder tersendiri misalnya `/root/bot/`)*

---

### 2. Install Dependensi
```bash
npm install ccxt technicalindicators dotenv
```

---

### 3. Buat File `.env`
Buat file `.env` di direktori yang sama dengan `bot.js` dan isi dengan API key Binance kamu:

```
API_KEY=your_api_key_here
API_SECRET=your_api_secret_here
```

> ⚠️ Gunakan **API Key Binance Futures (USDT-M)**  
> Pastikan **tidak mengaktifkan hak withdraw (penarikan)** demi keamanan.

---

### 4. Jalankan Bot Secara Manual
```bash
node bot.js
```

Jika berhasil, kamu akan melihat log seperti:
```
✅ Exchange connection initialized successfully
🚀 Bot started with stabilized connection
🧠 Technical analysis started...
```

---

## 📁 Struktur File

```
.
├── bot.js             # Script utama bot
├── db.json            # Database lokal (config & posisi aktif)
├── log.csv            # Riwayat sinyal dan transaksi
├── package.json
└── .env               # API key Binance
```

---

## 🧩 Penjelasan Konfigurasi (`db.json`)

Contoh isi file:
```json
{
  "pair": "DOGE/USDT:USDT",
  "leverage": 10,
  "marginMode": "ISOLATED",
  "usdtPerTrade": 5.1,
  "activePosition": null
}
```

| Parameter | Fungsi |
|------------|---------|
| `pair` | Pair yang diperdagangkan (misal `DOGE/USDT:USDT`) |
| `leverage` | Leverage Futures yang digunakan |
| `marginMode` | Mode margin: `ISOLATED` atau `CROSSED` |
| `usdtPerTrade` | Jumlah USDT per transaksi |
| `activePosition` | Diset otomatis oleh bot saat posisi aktif |

---

## 🧮 Contoh Log (`log.csv`)

```
timestamp,pair,type,entry,tp,sl,status,pnl
2025-10-19T14:35:22.100Z,DOGE/USDT:USDT,LONG,0.2425,0.2458,0.2401,ORDER_PLACED,
2025-10-19T15:10:01.100Z,DOGE/USDT:USDT,LONG,0.2425,0.2458,0.2401,TP_REALIZED,0.0016
```

---

## ⚡ Jalankan Bot 24 Jam dengan PM2

PM2 membantu bot tetap hidup walau server reboot, crash, atau disconnect internet.

### 1. Install PM2
```bash
npm install -g pm2
```

### 2. Jalankan Bot via PM2
```bash
pm2 start bot.js --name binance-bot
```

### 3. Simpan Konfigurasi PM2 Agar Auto Start Saat Reboot
```bash
pm2 save
pm2 startup
```

Ikuti instruksi yang muncul di terminal (biasanya akan memberi satu baris `sudo env ...` untuk dijalankan).

### 4. Cek Status Bot
```bash
pm2 list
```

### 5. Melihat Log Bot
```bash
pm2 logs binance-bot
```

### 6. Restart / Hentikan Bot
```bash
pm2 restart binance-bot
pm2 stop binance-bot
```

---

## 🔄 Rotasi Log Otomatis (Opsional)

Untuk mencegah file log membesar terlalu besar, aktifkan rotasi log:
```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 5
pm2 save
```

---

## 🧭 Tips Penggunaan

- Gunakan akun **Binance Testnet** untuk uji coba pertama kali.  
  Testnet URL: https://testnet.binancefuture.com  
  Kamu bisa membuat API Key di testnet.

- Gunakan VPS (Virtual Private Server) dengan koneksi stabil 24/7.  
- Gunakan Node.js versi **v18 ke atas**.  
- Jangan ubah interval loop (`10000ms`) agar tidak melanggar rate limit Binance.

---

## 🧩 Fungsi Utama dalam Kode

| Fungsi | Keterangan |
|---------|------------|
| `initializeExchange()` | Membuat koneksi ccxt ke Binance dan memastikan API aktif |
| `safeApiCall()` | Wrapper aman untuk pemanggilan API dengan retry otomatis |
| `analyzeSignal()` | Analisa teknikal: SMA crossover + ATR |
| `placeOrder()` | Membuka posisi baru (LONG / SHORT) |
| `closePosition()` | Menutup posisi (TP, SL, reversal signal) |
| `recoverPositionState()` | Pulihkan posisi aktif saat bot restart |
| `checkPositionStatus()` | Monitoring posisi aktif |
| `healthCheck()` | Mengecek koneksi Binance sebelum setiap siklus |
| `logSignal()` | Menyimpan data ke `log.csv` |
| `saveDB()` | Menyimpan konfigurasi dan status posisi ke `db.json` |

---

## 🔒 Keamanan

- Jangan pernah mempublikasikan file `.env` Anda.  
- Gunakan API Key tanpa izin **withdraw**.  
- Jalankan bot di server pribadi (jangan di public PC).  
- Gunakan firewall dan IP whitelist di Binance API bila memungkinkan.

---

## 🧠 Strategi Trading yang Digunakan

- **Sinyal Long:** SMA(7) menembus ke atas SMA(25) dan keduanya berada di atas SMA(99).  
- **Sinyal Short:** SMA(7) menembus ke bawah SMA(25) dan keduanya berada di bawah SMA(99).  
- ATR (Average True Range) digunakan untuk mengukur volatilitas dan menentukan jarak aman antara Support & Resistance.  
- SL dan TP disesuaikan secara dinamis berdasarkan volatilitas pasar.

---

## 🧾 Contoh Output Terminal

```
✅ Exchange connection initialized successfully
⚙️ Bot Configuration:
- Pair: DOGE/USDT:USDT
- Leverage: 10x
- Margin Mode: ISOLATED
- USDT per Trade: 5.1

🧠 Technical analysis started...
📊 ATR Detected: 0.00128
🎯 Using LOW volatility settings: 0.30% - 1.50%
✅ Found reasonable resistance: 0.2431
✅ Found reasonable support: 0.2411
🚀 LONG Signal | TP: 0.2431 | SL: 0.2411
✅ Market order created
📝 Signal logged to CSV
```


