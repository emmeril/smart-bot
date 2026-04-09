# Smart Bot Futures Grid

Bot trading otomatis berbasis Node.js untuk Binance USDT-M Futures dengan strategi utama `futures_grid`. Proyek ini menggabungkan engine trading, sinkronisasi posisi exchange, penyimpanan konfigurasi di SQLite, dan dashboard web untuk memantau status bot serta mengubah parameter runtime tanpa perlu restart proses.

## Ringkasan

Bot ini dirancang untuk gaya trading grid yang adaptif:

- range grid dihitung dari candle historis sesuai timeframe aktif
- bot membuat ladder order `buy` dan `sell` di sekitar harga berjalan
- target profit dan stop loss bisa mengikuti level grid atau menyesuaikan ATR
- posisi dan order aktif di exchange disinkronkan kembali saat bot restart
- konfigurasi disimpan di database SQLite dan dapat diubah dari dashboard

Strategi yang tersedia saat ini adalah `futures_grid`.

## Fitur Utama

- Grid futures berbasis level harga dari candle terbaru
- Support `LONG` dan `SHORT`
- Support `isolated` dan `cross` margin
- Deteksi mode akun Binance Futures untuk menyesuaikan perilaku order
- Recovery state posisi aktif setelah restart
- Auto reload konfigurasi runtime dari database
- Dashboard web dengan login sesi
- Logging trade ke file CSV
- Perintah runtime dari terminal seperti `status`, `sync`, dan `help`

## Struktur Proyek

```text
.
|-- index.js
|-- package.json
|-- .env.example
|-- database.sqlite
|-- trades.csv
|-- log.csv
|-- config/
|-- db/
|-- public/
|   |-- index.html
|   `-- login.html
`-- services/
    |-- config-model.js
    |-- config-persistence.js
    |-- config-runtime.js
    |-- dashboard-config.js
    |-- dashboard-session.js
    |-- dashboard-status.js
    |-- database-config.js
    |-- exchange-position.js
    |-- grid-runtime.js
    |-- managed-orders.js
    |-- order-execution.js
    |-- position-lifecycle.js
    |-- position-state.js
    |-- runtime-scheduler.js
    |-- runtime-utils.js
    |-- trade-entry.js
    `-- trade-logic.js
```

## Kebutuhan

- Node.js 18 atau lebih baru
- Akun Binance Futures USDT-M
- API key Binance yang punya izin trading futures

Saran keamanan:

- jangan aktifkan izin withdraw pada API key
- mulai dari ukuran kecil atau akun uji terlebih dulu
- pastikan pahami risiko leverage dan futures sebelum bot dijalankan live

## Instalasi

Install dependency:

```bash
npm install
```

Buat file `.env` dari `.env.example`, lalu isi minimal:

```env
API_KEY=binance_api_key
API_SECRET=binance_api_secret
ADMIN_PHONE=
DASHBOARD_PORT=3000
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=ganti-password-aman
DASHBOARD_SESSION_SECRET=ganti-random-string-panjang
CONFIG_AUTO_RELOAD_INTERVAL_MS=5000
```

Keterangan env:

- `API_KEY`: API key Binance
- `API_SECRET`: API secret Binance
- `ADMIN_PHONE`: sudah disediakan di template env, tetapi bukan bagian utama alur README ini
- `DASHBOARD_PORT`: port dashboard web
- `DASHBOARD_USERNAME`: username login dashboard
- `DASHBOARD_PASSWORD`: password login dashboard
- `DASHBOARD_SESSION_SECRET`: secret untuk cookie sesi dashboard
- `CONFIG_AUTO_RELOAD_INTERVAL_MS`: interval pembacaan ulang konfigurasi dari database

Jika kredensial dashboard tidak diisi, aplikasi memakai default lokal:

- username `admin`
- password `admin123`

Default ini sebaiknya hanya dipakai untuk pengujian lokal.

## Menjalankan Bot

Jalankan:

```bash
node index.js
```

Saat proses aktif:

- engine trading berjalan dari `index.js`
- dashboard web aktif di `http://localhost:3000` atau sesuai `DASHBOARD_PORT`
- konfigurasi runtime dibaca dari SQLite
- bot akan mencoba sinkronisasi posisi dan order aktif dari exchange

## Perintah Runtime di Terminal

Ketika bot sedang berjalan, beberapa perintah berikut bisa diketik langsung di terminal proses:

```text
status
sync
help
```

Penjelasan singkat:

- `status`: menampilkan ringkasan runtime, posisi aktif, grid state, dan order terbuka
- `sync`: memaksa sinkronisasi ulang state lokal dengan exchange
- `help`: menampilkan daftar command runtime yang tersedia

## Dashboard Web

Dashboard tersedia setelah aplikasi berjalan.

URL default:

```text
http://localhost:3000
```

Fungsi dashboard:

- login dengan sesi berbasis cookie
- melihat status bot secara live
- melihat ringkasan posisi, daily PnL, dan order aktif
- mengubah konfigurasi yang disimpan ke SQLite
- menerapkan perubahan ke runtime tanpa restart proses

Beberapa field penting yang bisa diatur dari dashboard:

- `pair`
- `marginMode`
- `leverage`
- `monitoringInterval`
- `coolingPeriod`
- `gridOrderSizeUsdt`
- `gridTargetProfitUsdt`
- `gridStopLossPercent`
- `dailyProfitTargetUsdt`
- `dailyMaxLossPercent`
- `maxTradesPerDay`
- `gridLevels`
- `gridLookbackCandles`
- `gridRangePercent`
- `gridEntryBufferPercent`
- `gridTakeProfitLevels`
- `gridOrdersPerSide`
- `gridStopLossLevels`
- `gridTimeframe`
- `sessionStartUTC`
- `sessionEndUTC`
- `volumePeriod`
- `atrPeriod`
- `trailingEnabled`
- `trailingActivateATR`
- `trailingOffsetATR`
- `allowLong`
- `allowShort`

## Cara Kerja Strategi Grid

Secara umum strategi `futures_grid` di proyek ini bekerja seperti berikut:

1. Bot mengambil candle sesuai `gridTimeframe`.
2. Bot menghitung range grid dari data lookback dan parameter range.
3. Range dibagi menjadi beberapa level sesuai `gridLevels`.
4. Bot menyiapkan ladder order di bawah dan di atas harga sekarang.
5. Saat order tereksekusi, bot menyiapkan target profit dan stop loss berdasarkan aturan grid atau ATR.
6. Runtime terus memonitor posisi, trailing stop, order terbuka, batas harian, dan sesi trading.

Bot juga memakai filter tambahan seperti:

- filter jam trading berbasis UTC
- filter volume minimum
- batas profit harian
- batas loss harian
- batas jumlah trade per hari

## Konfigurasi Penting

Berikut parameter yang paling sering dipakai:

Contoh set konfigurasi dasar yang cukup aman untuk mulai uji kecil:

```text
pair=BTC/USDT:USDT
marginMode=isolated
leverage=10
gridOrderSizeUsdt=5
gridLevels=8
gridLookbackCandles=120
gridRangePercent=3.5
gridEntryBufferPercent=0.15
gridTakeProfitLevels=0
gridOrdersPerSide=2
gridStopLossLevels=0
gridTimeframe=5m
dailyProfitTargetUsdt=3
dailyMaxLossPercent=5
maxTradesPerDay=10
sessionStartUTC=0
sessionEndUTC=23
trailingEnabled=true
trailingActivateATR=1.2
trailingOffsetATR=0.6
allowLong=true
allowShort=true
```

Parameter berikut memang valid jika di-set `0`:

- `gridOrderSizeUsdt=0`: bot memakai mode ukuran order otomatis atau `FULL_AUTO`, lalu menghitung size efektif dari balance, leverage, dan minimum order exchange
- `gridTakeProfitLevels=0`: take profit memakai mode otomatis ke grid berikutnya
- `gridOrdersPerSide=0`: jumlah ladder order per sisi dihitung otomatis sesuai balance dan jumlah level grid
- `gridStopLossLevels=0`: stop loss grid memakai mode otomatis berbasis range atau ATR, bukan fixed step manual
- `coolingPeriod=0`: tidak ada jeda cooldown setelah trade
- `sessionStartUTC=0`: sesi mulai dari jam 00:00 UTC
- `sessionEndUTC=0`: sesi berakhir di jam 00:00 UTC; jika dipasangkan dengan `sessionStartUTC=0`, sesi efektif hanya melewati jam 00 UTC, jadi ini bukan mode "24 jam"

Contoh penggunaan nilai `0`:

```text
gridOrderSizeUsdt=0
gridTakeProfitLevels=0
gridOrdersPerSide=0
gridStopLossLevels=0
coolingPeriod=0
sessionStartUTC=0
sessionEndUTC=23
```

Catatan penting:

- `0` pada `gridOrderSizeUsdt`, `gridTakeProfitLevels`, `gridOrdersPerSide`, dan `gridStopLossLevels` berarti mode otomatis
- `0` pada `coolingPeriod` berarti nonaktif
- `0` pada `sessionStartUTC` atau `sessionEndUTC` hanyalah nilai jam UTC, bukan berarti filter sesi dimatikan
- parameter seperti `dailyProfitTargetUsdt`, `dailyMaxLossPercent`, `maxTradesPerDay`, `gridTargetProfitUsdt`, `gridStopLossPercent`, `gridLevels`, dan `gridRangePercent` tidak didesain untuk `0`

### General

- `strategy`: strategi aktif, saat ini `futures_grid`
- `pair`: simbol futures, contoh `DOGE/USDT:USDT`
- `marginMode`: `isolated` atau `cross`
- `leverage`: leverage futures
- `monitoringInterval`: jeda monitor runtime dalam milidetik
- `coolingPeriod`: jeda setelah trade sebelum evaluasi berikutnya

Example:

```text
strategy=futures_grid
pair=BTC/USDT:USDT
marginMode=isolated
leverage=10
monitoringInterval=500
coolingPeriod=3000
```

Contoh ini cocok untuk setup awal yang masih responsif, tapi belum terlalu agresif.

### Risk

- `gridOrderSizeUsdt`: nominal per order grid dalam USDT
- `gridTargetProfitUsdt`: target profit nominal
- `gridStopLossPercent`: stop loss persentase
- `dailyProfitTargetUsdt`: target profit harian sebelum pause
- `dailyMaxLossPercent`: batas rugi harian sebelum pause
- `maxTradesPerDay`: batas jumlah trade harian
- `autoTargetProfitEnabled`: aktifkan TP otomatis berbasis ATR
- `autoStopLossEnabled`: aktifkan SL otomatis berbasis ATR

Example:

```text
gridOrderSizeUsdt=5
gridTargetProfitUsdt=0.5
gridStopLossPercent=4
dailyProfitTargetUsdt=3
dailyMaxLossPercent=5
maxTradesPerDay=10
autoTargetProfitEnabled=true
autoStopLossEnabled=true
```

Contoh ini berarti setiap order grid memakai ukuran `5 USDT`, bot berhenti sementara jika profit harian sudah `3 USDT`, dan juga berhenti jika batas rugi harian tercapai.

### Grid

- `gridLevels`: jumlah level grid
- `gridLookbackCandles`: jumlah candle untuk membangun range
- `gridRangePercent`: lebar range grid
- `gridEntryBufferPercent`: buffer harga untuk entry
- `gridTakeProfitLevels`: offset TP dalam jumlah level grid
- `gridOrdersPerSide`: jumlah ladder order per sisi
- `gridStopLossLevels`: offset SL dalam langkah grid
- `gridTimeframe`: timeframe candle grid

Example:

```text
gridLevels=8
gridLookbackCandles=120
gridRangePercent=3.5
gridEntryBufferPercent=0.15
gridTakeProfitLevels=0
gridOrdersPerSide=2
gridStopLossLevels=0
gridTimeframe=5m
```

Arti contoh:

- `gridLevels=8` membagi range menjadi 8 level
- `gridLookbackCandles=120` memakai 120 candle terakhir untuk membentuk range
- `gridRangePercent=3.5` memberi lebar grid sekitar 3.5%
- `gridTakeProfitLevels=0` membiarkan runtime memakai mode TP otomatis ke grid berikutnya
- `gridStopLossLevels=0` membiarkan runtime menghitung SL otomatis

### Session dan Filter

- `sessionStartUTC`: jam mulai trading
- `sessionEndUTC`: jam akhir trading
- `volumePeriod`: periode perhitungan volume
- `minVolumeRatio`: rasio volume minimum
- `atrPeriod`: periode ATR

Example:

```text
sessionStartUTC=0
sessionEndUTC=23
volumePeriod=20
minVolumeRatio=1.3
atrPeriod=14
```

Contoh ini berarti bot aktif sepanjang hari UTC, memakai volume 20 candle sebagai pembanding, dan ATR 14 untuk perhitungan volatilitas.

### Trailing

- `trailingEnabled`: aktif atau nonaktif
- `trailingActivateATR`: ATR multiplier untuk mulai trailing
- `trailingOffsetATR`: ATR offset trailing stop

Example:

```text
trailingEnabled=true
trailingActivateATR=1.2
trailingOffsetATR=0.6
```

Contoh ini berarti trailing stop baru aktif setelah harga bergerak sejauh `1.2x ATR`, lalu stop mengikuti dengan jarak `0.6x ATR`.

### Direction

- `allowLong`: izinkan entry long
- `allowShort`: izinkan entry short

Example:

```text
allowLong=true
allowShort=false
```

Contoh ini cocok jika kamu hanya ingin bot mencari peluang `LONG` dan menonaktifkan entry `SHORT`.

## Penyimpanan Data

Project ini memakai SQLite sebagai penyimpanan lokal.

File penting:

- `database.sqlite`: menyimpan konfigurasi dan state runtime
- `trades.csv`: log transaksi
- `log.csv`: file log tambahan yang sudah ada di repo

Trade log di `trades.csv` berisi kolom seperti:

```text
timestamp,pair,side,entry,exit,status,pnl,leverage,margin_mode,stop_loss_percent,strategy
```

## Sinkronisasi dan Recovery

Salah satu bagian penting bot ini adalah sinkronisasi state lokal dengan exchange. Saat proses dijalankan ulang, bot akan berusaha:

- membaca posisi futures yang masih aktif
- memetakan order grid, take profit, dan stop loss yang masih terbuka
- memulihkan state lokal agar tidak membuka posisi ganda secara tidak sengaja

Ini penting untuk menjaga runtime tetap konsisten setelah crash, restart server, atau restart manual.

## Catatan Operasional

- Bot ini ditujukan untuk Binance Futures USDT-M.
- Pair futures harus sesuai format exchange yang didukung `ccxt`, misalnya `DOGE/USDT:USDT`.
- Timezone filter sesi memakai UTC, bukan WIB.
- Perubahan config dari dashboard tidak mengharuskan restart jika proses auto reload aktif.
- `gridOrderSizeUsdt` atau `gridOrdersPerSide` bernilai `0` dapat dipakai runtime untuk menghitung nilai efektif secara adaptif pada kondisi tertentu.

## Pengembangan

Jika ingin mengembangkan proyek ini:

```bash
npm install
node index.js
```

Lalu buka dashboard dan ubah parameter sambil memonitor output terminal.

## Testing

Project ini sekarang punya smoke test ringan berbasis `node:test` untuk menjaga area runtime yang paling sensitif.

Jalankan:

```bash
npm test
```

Jika PowerShell lokal memblokir `npm.ps1`, gunakan:

```bash
npm.cmd test
```

Smoke test saat ini mencakup:

- propagasi flag kegagalan fetch trigger order pada managed orders
- perhitungan TP/SL plan saat auto size aktif
- jalur emergency close ketika plan setelah fill tidak valid
- sinkronisasi posisi hasil recovery dari exchange
- partial close dan pemasangan ulang TP/SL
- filter ladder grid untuk `one-way` dan `hedge`

Test yang ada memang belum menggantikan integration test penuh dengan exchange, tetapi cukup berguna untuk menangkap regresi logika runtime sebelum bot dijalankan live.

Dependency utama:

- `ccxt`
- `dotenv`
- `express`
- `sequelize`
- `sqlite3`
- `technicalindicators`

## Disclaimer

Software ini berisiko tinggi jika dipakai pada akun real. Semua keputusan trading, kerugian, dan konsekuensi penggunaan sepenuhnya menjadi tanggung jawab pengguna. Lakukan pengujian bertahap dan pahami seluruh parameter sebelum dipakai untuk trading live.
