# Binance Futures Auto Trading Bot

Bot trading otomatis Binance Futures berbasis Node.js dan `ccxt` dengan fokus pada strategi sederhana, stabil, dan mudah dipantau.

## Strategi

Bot menggunakan analisis teknis otomatis berbasis:

- `SMA(7)`
- `SMA(25)`
- `SMA(99)`

Aturan sinyal:

- `LONG`: `SMA(7)` menembus ke atas `SMA(25)` dan keduanya berada di atas `SMA(99)`.
- `SHORT`: `SMA(7)` menembus ke bawah `SMA(25)` dan keduanya berada di bawah `SMA(99)`.

Manajemen risiko dan exit tetap menggunakan ATR untuk stop loss, target, dan trailing stop.

## Fitur Utama

- Analisis sinyal otomatis `LONG` dan `SHORT`
- Entry market otomatis
- ATR-based stop loss, take profit, dan trailing stop
- Sinkronisasi posisi aktif dengan exchange
- Recovery state setelah restart
- Konfigurasi tersimpan di SQLite
- Logging transaksi ke CSV

## Struktur Proyek

```text
.
|-- index.js
|-- backtest.js
|-- scripts/
|   `-- config.js
|-- database.sqlite
|-- trades.csv
|-- .env
`-- package.json
```

## Instalasi

```bash
npm install
```

Buat file `.env`:

```env
API_KEY=your_api_key_here
API_SECRET=your_api_secret_here
```

## Menjalankan Bot

```bash
node index.js
```

## Konfigurasi

Konfigurasi runtime disimpan di `database.sqlite` dan dapat dikelola lewat helper:

```bash
node scripts/config.js show
node scripts/config.js get leverage
node scripts/config.js set leverage 20
node scripts/config.js set pair BTC/USDT:USDT
```

Default strategi yang dipakai:

- `strategy`: `sma_crossover`
- `fastEMAPeriod`: `7`
- `slowEMAPeriod`: `25`
- `trendEMAPeriod`: `99`

Catatan: nama key config masih memakai nama historis `fastEMAPeriod`, `slowEMAPeriod`, dan `trendEMAPeriod` untuk menjaga kompatibilitas data lama, tetapi logika runtime sekarang membaca nilai tersebut sebagai `SMA 7/25/99`.

## Logging

Riwayat transaksi disimpan di `trades.csv`.

Contoh kolom:

```text
timestamp,pair,side,entry,exit,status,pnl,leverage,margin_mode,stop_loss_percent,strategy
```

## Backtest

```bash
npm run backtest
```

Script lain yang tersedia:

- `npm run backtest:grid`
- `npm run backtest:approve`
- `npm run backtest:auto`
- `npm run backtest:risk`
- `npm run backtest:sensitivity`

## Catatan

- Gunakan Binance Futures USDT-M.
- Sangat disarankan uji dulu di akun testnet atau akun kecil.
- Jangan aktifkan izin withdraw pada API key.
- Bot sekarang mendeteksi mode akun Binance Futures saat startup dan menyesuaikan parameter order untuk One-way atau Hedge Mode.
- Pada Hedge Mode, bot mengirim `positionSide` sesuai dokumentasi Binance dan dapat menyimpan dua leg aktif lokal sekaligus: `LONG` dan `SHORT`.
- Pada One-way Mode, bot memakai perilaku single-position dengan `positionSide=BOTH` dan `reduceOnly` untuk penutupan posisi.
