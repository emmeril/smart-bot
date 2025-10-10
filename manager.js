const fs = require("fs");
const readline = require("readline");

const dbPath = "./db.json";

// Helper untuk baca DB
const readDB = () => {
    if (!fs.existsSync(dbPath)) {
        console.log("❌ DB tidak ditemukan! Pastikan bot sudah pernah dijalankan.");
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(dbPath));
    } catch (error) {
        console.log("❌ Error membaca DB:", error.message);
        return null;
    }
};

// Helper untuk tulis DB
const writeDB = (db) => {
    try {
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
        return true;
    } catch (error) {
        console.log("❌ Error menulis DB:", error.message);
        return false;
    }
};

// Buat interface input
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));

// ✅ VALIDATION FUNCTIONS untuk setting yang dipakai bot
const validators = {
    // Validasi pair format
    pair: (input) => {
        if (!input) return "❌ Pair tidak boleh kosong!";
        if (!input.includes("/") || !input.includes("USDT")) {
            return "❌ Format pair harus: SYMBOL/USDT:USDT (contoh: DOGE/USDT:USDT)";
        }
        return true;
    },
    
    // Validasi leverage
    leverage: (input) => {
        const leverage = parseInt(input);
        if (isNaN(leverage)) return "❌ Leverage harus angka!";
        if (leverage < 1 || leverage > 125) return "❌ Leverage harus 1-125!";
        return true;
    },
    
    // Validasi USDT per trade
    usdtPerTrade: (input) => {
        const amount = parseFloat(input);
        if (isNaN(amount)) return "❌ USDT harus angka!";
        if (amount < 5) return "❌ Minimal 5 USDT per trade!";
        if (amount > 1000) return "❌ Maksimal 1000 USDT per trade!";
        return true;
    },
    
    // Validasi margin mode
    marginMode: (input) => {
        const mode = input.toUpperCase();
        if (mode !== "ISOLATED" && mode !== "CROSSED") {
            return "❌ Pilih: ISOLATED atau CROSSED!";
        }
        return true;
    },
    
    // Validasi konfirmasi
    confirmation: (input) => {
        const answer = input.toLowerCase();
        if (answer !== 'y' && answer !== 'n') {
            return "❌ Jawab 'y' untuk Ya atau 'n' untuk Tidak!";
        }
        return true;
    },
    
    // Validasi menu choice
    menuChoice: (input) => {
        const choice = parseInt(input);
        if (isNaN(choice) || choice < 0 || choice > 5) {
            return "❌ Pilih menu 0-5!";
        }
        return true;
    }
};

// ✅ SAFE INPUT FUNCTION dengan retry
const safeInput = async (prompt, validator, maxRetries = 3) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const input = await question(prompt);
        const validation = validator(input);
        
        if (validation === true) {
            return input;
        }
        
        console.log(validation);
        
        if (attempt === maxRetries) {
            console.log("❌ Terlalu banyak percobaan gagal!");
            return null;
        }
        
        console.log(`🔄 Percobaan ${attempt + 1}/${maxRetries}...`);
    }
};

// ✅ SAFE CONFIRMATION
const safeConfirm = async (message) => {
    const answer = await safeInput(`${message} (y/n): `, validators.confirmation);
    return answer === 'y';
};

// Main config manager
const configManager = async () => {
    console.log("🎛️  TRADING BOT CONFIG MANAGER");
    console.log("=================================");
    
    let db = readDB();
    if (!db) {
        rl.close();
        return;
    }

    let exit = false;
    
    while (!exit) {
        console.log("\n" + "=".repeat(50));
        console.log("📊 KONFIGURASI SAAT INI:");
        console.log("-".repeat(50));
        console.log(`1. Pair: ${db.pair}`);
        console.log(`2. Leverage: ${db.leverage}x`);
        console.log(`3. USDT per Trade: ${db.usdtPerTrade}`);
        console.log(`4. Margin Mode: ${db.marginMode}`);
        
        // Menu options - HANYA YANG DIPAKAI BOT
        console.log("\n📝 PILIH OPSI:");
        console.log("1. Ganti Trading Pair");
        console.log("2. Atur Leverage & USDT");
        console.log("3. Atur Margin Mode");
        console.log("4. Lihat Status Trading");
        console.log("5. Reset Bot (Emergency)");
        console.log("0. Keluar");
        
        const choice = await safeInput("\nPilih menu (0-5): ", validators.menuChoice);
        if (!choice) continue;
        
        switch (choice) {
            case "1":
                await changePair(db);
                break;
            case "2":
                await changeLeverageAndUsdt(db);
                break;
            case "3":
                await changeMarginMode(db);
                break;
            case "4":
                showTradingStatus(db);
                break;
            case "5":
                await resetBot(db);
                break;
            case "0":
                console.log("👋 Keluar dari config manager...");
                exit = true;
                break;
        }
        
        // Refresh DB setelah perubahan
        if (!exit) {
            const refreshedDb = readDB();
            if (refreshedDb) db = refreshedDb;
        }
    }
    
    rl.close();
};

// Fungsi ganti pair
const changePair = async (db) => {
    console.log("\n🎯 GANTI TRADING PAIR");
    console.log("Contoh: DOGE/USDT:USDT, XRP/USDT:USDT, BTC/USDT:USDT");
    
    const newPair = await safeInput("Masukkan pair baru: ", validators.pair);
    if (!newPair) return;
    
    const confirmed = await safeConfirm(`Yakin ganti pair dari ${db.pair} ke ${newPair}?`);
    if (confirmed) {
        db.pair = newPair;
        if (writeDB(db)) {
            console.log("✅ Pair berhasil diupdate!");
            console.log("💡 Restart bot untuk apply perubahan pair!");
        }
    } else {
        console.log("❌ Update dibatalkan.");
    }
};

// Fungsi ganti leverage & USDT per trade
const changeLeverageAndUsdt = async (db) => {
    console.log("\n🎯 ATUR LEVERAGE & USDT PER TRADE");
    console.log(`Saat ini: Leverage ${db.leverage}x, USDT: ${db.usdtPerTrade}`);
    
    const newLeverage = await safeInput("Masukkan leverage (1-125): ", validators.leverage);
    if (!newLeverage) return;
    
    const newUsdt = await safeInput("Masukkan USDT per trade: ", validators.usdtPerTrade);
    if (!newUsdt) return;
    
    const confirmed = await safeConfirm(`Yakin ganti leverage dari ${db.leverage}x ke ${newLeverage}x dan USDT dari ${db.usdtPerTrade} ke ${newUsdt}?`);
    if (confirmed) {
        db.leverage = parseInt(newLeverage);
        db.usdtPerTrade = parseFloat(newUsdt);
        if (writeDB(db)) {
            console.log("✅ Leverage & USDT per trade berhasil diupdate!");
        }
    } else {
        console.log("❌ Update dibatalkan.");
    }
};

// Fungsi ganti margin mode
const changeMarginMode = async (db) => {
    console.log("\n🎯 ATUR MARGIN MODE");
    console.log(`Saat ini: ${db.marginMode}`);
    console.log("\n📚 Penjelasan Margin Mode:");
    console.log("- ISOLATED: Margin terpisah per posisi (LEBIH AMAN)");
    console.log("- CROSSED: Margin dipakai bersama semua posisi");
    console.log("\n💡 Recommended: ISOLATED untuk risk management lebih baik");
    
    const newMode = await safeInput("Masukkan margin mode (ISOLATED/CROSSED): ", validators.marginMode);
    if (!newMode) return;
    
    const confirmed = await safeConfirm(`Yakin ganti margin mode dari ${db.marginMode} ke ${newMode.toUpperCase()}?`);
    if (confirmed) {
        db.marginMode = newMode.toUpperCase();
        if (writeDB(db)) {
            console.log("✅ Margin mode berhasil diupdate!");
        }
    } else {
        console.log("❌ Update dibatalkan.");
    }
};

// Fungsi lihat status trading
const showTradingStatus = (db) => {
    console.log("\n📊 STATUS TRADING:");
    console.log("-".repeat(50));
    
    // Status posisi aktif
    if (db.activePosition) {
        console.log("🔴 POSISI AKTIF:");
        console.log(`- Side: ${db.activePosition.side.toUpperCase()}`);
        console.log(`- Entry: ${db.activePosition.entryPrice}`);
        console.log(`- TP: ${db.activePosition.tp}`);
        console.log(`- SL: ${db.activePosition.sl}`);
        console.log(`- Order ID: ${db.activePosition.orderId}`);
    } else {
        console.log("🟢 TIDAK ADA POSISI AKTIF");
    }
    
    console.log("\n⚙️ SETTING AKTIF:");
    console.log(`- Pair: ${db.pair}`);
    console.log(`- Leverage: ${db.leverage}x`);
    console.log(`- USDT/Trade: ${db.usdtPerTrade}`);
    console.log(`- Margin Mode: ${db.marginMode}`);
};

// Fungsi reset bot emergency
const resetBot = async (db) => {
    console.log("\n🚨 RESET BOT - EMERGENCY ONLY!");
    console.log("Tindakan ini untuk:");
    console.log("- Hapus posisi aktif dari memory bot");
    console.log("- Reset jika bot error/stuck");
    console.log("⚠️  Tidak menutup posisi di exchange!");
    
    const confirmed = await safeConfirm("Yakin ingin reset bot?");
    if (confirmed) {
        db.activePosition = null;
        db.prevPosAmt = 0;
        if (writeDB(db)) {
            console.log("✅ Bot berhasil direset!");
            console.log("🔄 Restart bot untuk memulai fresh.");
        }
    } else {
        console.log("❌ Reset dibatalkan.");
    }
};

// Handle CTRL+C gracefully
rl.on('SIGINT', () => {
    console.log("\n👋 Keluar dari config manager...");
    rl.close();
    process.exit(0);
});

// Jalankan manager
if (require.main === module) {
    configManager();
}

module.exports = { configManager };
