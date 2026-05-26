# Smart Bot

Automated crypto trading bot berbasis Node.js untuk Binance Spot, dengan strategi utama `spot_grid`, dashboard web, penyimpanan konfigurasi SQLite, dan dukungan AI trade filter Gemini.

## Kenapa Proyek Ini Menarik

- Trading engine berjalan otomatis dari `index.js`
- Strategi spot grid adaptif berbasis candle historis
- State posisi, order, dan konfigurasi disimpan lokal di SQLite
- Dashboard web untuk memantau status dan mengubah parameter runtime tanpa restart
- Dukungan notifikasi WhatsApp via Fonnte
- Opsi AI filter untuk review sinyal dan grid order
- Ada smoke test untuk menjaga area runtime yang sensitif

## Fitur Utama

- `spot_grid` sebagai strategi inti
- Mode spot murni via `ccxt`
- Recovery state posisi dan order setelah restart
- Auto reload konfigurasi runtime dari database
- Dashboard login berbasis sesi cookie
- Logging trade ke `trades.csv`
- Perintah runtime di terminal: `status`, `sync`, `help`
- Integrasi AI filter menggunakan Gemini

## Ringkasan Alur Kerja

1. Bot membaca konfigurasi dari SQLite.
2. Bot mengambil market data dan menghitung sinyal.
3. Grid order disusun sesuai parameter aktif.
4. Posisi dan order dimonitor terus-menerus.
5. Saat kondisi berubah, runtime menyesuaikan TP/SL, trailing, dan recovery state.

## Persyaratan

- Node.js 18 atau lebih baru
- Akun Binance Spot
- API key Binance dengan izin trading spot

## Instalasi

```bash
npm install
```

Buat file `.env` dari `.env.example`, lalu isi minimal:

```env
API_KEY=binance_api_key
API_SECRET=binance_api_secret
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=change-this-password
DASHBOARD_SESSION_SECRET=long-random-secret
```

Jika variabel dashboard tidak diisi, default lokal yang dipakai adalah:

- username: `admin`
- password: `admin123`
- host dashboard: `127.0.0.1`
- port dashboard: `3000`

## Menjalankan Aplikasi

```bash
node index.js
```

Setelah aktif:

- dashboard tersedia di `http://localhost:3000`
- bot mulai memantau exchange
- konfigurasi runtime bisa dibaca ulang dari SQLite

## Script Tersedia

```bash
npm test
npm run preflight
npm run config:auto
npm run config:manual
```

Kegunaan script:

- `npm test`: menjalankan smoke test
- `npm run preflight`: preflight live checks
- `npm run config:auto`: menerapkan profil trading auto
- `npm run config:manual`: menerapkan profil trading manual

## Dashboard Web

Dashboard berjalan di:

```text
http://localhost:3000
```

Fitur dashboard:

- login dengan sesi cookie
- lihat status bot, posisi, order, dan ringkasan PnL
- ubah konfigurasi yang tersimpan di SQLite
- simpan perubahan tanpa restart proses
- batalkan order atau hapus posisi dari panel

## Konfigurasi Penting

File `.env.example` sudah menyiapkan variabel utama seperti:

- `API_KEY`
- `API_SECRET`
- `AI_PROVIDER`
- `GEMINI_API_KEY`
- `GEMINI_API_KEYS`
- `AI_SIGNAL_FILTER_ENABLED`
- `FONNTE_TOKEN`
- `FONNTE_TARGET`
- `DASHBOARD_PORT`
- `DASHBOARD_USERNAME`
- `DASHBOARD_PASSWORD`
- `DASHBOARD_SESSION_SECRET`
- `CONFIG_AUTO_RELOAD_INTERVAL_MS`

Beberapa nilai default penting:

- `AI_PROVIDER=gemini`
- `GEMINI_MODEL=gemini-2.5-flash-lite`
- `DASHBOARD_HOST=127.0.0.1`
- `CONFIG_AUTO_RELOAD_INTERVAL_MS=5000`

## Data dan Penyimpanan

Project ini menyimpan data lokal di:

- `database.sqlite` untuk konfigurasi dan state runtime
- `trades.csv` untuk log transaksi

## Struktur Proyek

```text
.
|-- index.js
|-- package.json
|-- .env.example
|-- database.sqlite
|-- trades.csv
|-- public/
|-- services/
|-- scripts/
|-- tests/
|-- config/
|-- database/
|-- db/
`-- templates/
```

## Cara Kerja Strategi `spot_grid`

- bot membaca candle sesuai `gridTimeframe`
- range grid dihitung dari data historis
- level grid dibagi sesuai `gridLevels`
- buy ladder dipasang di bawah harga berjalan
- sell ladder dipasang di atas harga berjalan
- TP/SL dapat mengikuti grid atau ATR
- trailing stop bisa aktif sesuai konfigurasi

## Keamanan dan Operasional

- jangan aktifkan izin withdraw pada API key
- mulai dari ukuran kecil dulu
- pahami risiko trading live sebelum dipakai di akun real
- timezone filter sesi memakai UTC
- default dashboard sebaiknya tetap di `127.0.0.1` untuk penggunaan lokal

## Testing

```bash
npm test
```

Smoke test yang tersedia membantu memeriksa area penting seperti:

- review AI trade filter
- validasi grid order
- sync dan recovery runtime
- shutdown behavior
- mutex dan scheduler

## Disclaimer

Software ini berisiko tinggi bila dijalankan pada akun real. Semua keputusan trading dan konsekuensi penggunaan berada di tanggung jawab pengguna. Gunakan test bertahap dan pahami setiap parameter sebelum live.
