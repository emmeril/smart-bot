# Binance-Style Futures Grid Bot

Bot trading otomatis Binance Futures berbasis Node.js dan `ccxt` dengan gaya kerja yang lebih mirip bot bawaan Binance, terutama mode Futures Grid yang netral dan adaptif.

## Strategi

Bot sekarang memakai pendekatan `Binance-style Futures Grid`:

- Membentuk range harga dari candle recent sesuai `gridLookbackCandles` pada `gridTimeframe`
- Membagi range menjadi beberapa level grid sesuai `gridLevels`
- `LONG` saat harga turun ke area grid bawah untuk entry mean reversion
- `SHORT` saat harga naik ke area grid atas untuk entry mean reversion
- Take profit diarahkan ke level grid berikutnya
- Bot memasang beberapa order `limit` buy dan sell sekaligus seperti ladder grid
- Stop loss dipasang beberapa langkah di luar level entry

Manajemen risiko inti tetap memakai engine posisi yang sudah ada: sinkronisasi posisi exchange, recovery state, dan monitoring real-time.

## Fitur Utama

- Analisis level grid otomatis `LONG` dan `SHORT`
- Ladder order `limit` buy/sell yang dibangun ulang otomatis
- Take profit dan stop loss berbasis level grid
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

Saat bot berjalan, kamu bisa ketik `status` di terminal untuk melihat posisi aktif serta order grid, TP, dan SL yang masih terbuka di exchange.

Dashboard web akan ikut aktif di port `3000` secara default. Buka:

```text
http://localhost:3000
```

Jika perlu, port bisa diganti lewat env `DASHBOARD_PORT`.
Dashboard sekarang juga dilindungi login. Set kredensial lewat:

```env
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=change-me-now
DASHBOARD_SESSION_SECRET=change-this-to-a-long-random-string
```

Kalau env belum diisi, default lokal yang dipakai adalah `admin` / `admin123`.
Bot juga melakukan auto reload konfigurasi dari SQLite setiap beberapa detik tanpa restart proses. Intervalnya bisa diatur lewat `CONFIG_AUTO_RELOAD_INTERVAL_MS`.

## Konfigurasi

Konfigurasi runtime disimpan di `database.sqlite` dan dapat dikelola lewat helper:

```bash
node scripts/config.js show
node scripts/config.js get leverage
node scripts/config.js set leverage 20
node scripts/config.js set pair BTC/USDT:USDT
node scripts/config.js set marginMode cross
node scripts/config.js set marginMode isolated
```

Default strategi yang dipakai:

- `strategy`: `futures_grid`
- `gridOrderSizeUsdt`: `1.5`
- `gridLevels`: `8`
- `gridLookbackCandles`: `120`
- `gridRangePercent`: `3.5`
- `gridTakeProfitLevels`: `1`
- `gridOrdersPerSide`: `1`
- `gridStopLossLevels`: `1.2`
- `gridTimeframe`: `5m`
- `marginMode`: `isolated`
- `dailyProfitTargetUsdt`: `1`
- `dailyMaxLossPercent`: `10`

Contoh pengaturan cepat:

```bash
node scripts/config.js set gridLevels 10
node scripts/config.js set gridOrdersPerSide 4
node scripts/config.js set gridRangePercent 4.5
node scripts/config.js set gridLookbackCandles 150
node scripts/config.js set dailyProfitTargetUsdt 3
node scripts/config.js set marginMode cross
```

`marginMode` hanya menerima `cross` atau `isolated`.

## Dashboard Web

Dashboard menyediakan edit cepat untuk:

- `pair`
- `strategy`
- `marginMode`
- `leverage`
- parameter grid
- parameter risiko harian
- trailing stop
- filter sesi

Perubahan dari dashboard langsung disimpan ke SQLite dan di-reload ke runtime bot.
Login dashboard memakai cookie sesi yang ditandatangani dan akan kedaluwarsa otomatis setelah beberapa jam.

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
- Saat ada posisi aktif, ladder grid tetap dijaga agar perilakunya lebih dekat ke bot grid Binance. Pada One-way Mode, order ladder disaring mengikuti sisi posisi aktif untuk menghindari reversal yang tidak disengaja.
- Pada Hedge Mode, bot mengirim `positionSide` sesuai dokumentasi Binance dan dapat menyimpan dua leg aktif lokal sekaligus: `LONG` dan `SHORT`.
- Pada One-way Mode, bot memakai perilaku single-position dengan `positionSide=BOTH` dan `reduceOnly` untuk penutupan posisi.

