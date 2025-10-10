require("dotenv").config();
const fs = require("fs");
const readline = require("readline");
const ccxt = require("ccxt");

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

// ✅ INIT EXCHANGE untuk cek balance
const initExchange = () => {
    try {
        return new ccxt.binance({
            apiKey: process.env.API_KEY,
            secret: process.env.API_SECRET,
            options: { defaultType: "future" },
        });
    } catch (error) {
        console.log("❌ Gagal init exchange:", error.message);
        return null;
    }
};

// ✅ FUNGSI CEK BALANCE
const checkBalance = async () => {
    console.log("\n💰 CEK BALANCE BINANCE...");
    
    const exchange = initExchange();
    if (!exchange) {
        console.log("❌ Tidak bisa akses exchange. Cek API Key & Secret.");
        return;
    }

    try {
        await exchange.loadMarkets();
        const balance = await exchange.fetchBalance();
        
        console.log("\n📊 BALANCE FUTURES:");
        console.log("-".repeat(50));
        
        // Total Balance
        const totalWalletBalance = balance.total?.USDT || 0;
        const availableBalance = balance.free?.USDT || 0;
        
        console.log(`💵 Total Wallet Balance: ${totalWalletBalance.toFixed(2)} USDT`);
        console.log(`🆓 Available Balance: ${availableBalance.toFixed(2)} USDT`);
        console.log(`🔒 Used Balance: ${(totalWalletBalance - availableBalance).toFixed(2)} USDT`);
        
        // Position info
        const positions = balance.info?.positions || [];
        const activePositions = positions.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        
        console.log(`\n📈 Active Positions: ${activePositions.length}`);
        
        if (activePositions.length > 0) {
            console.log("\n🔍 DETAIL POSISI:");
            activePositions.forEach(pos => {
                const symbol = pos.symbol;
                const amount = parseFloat(pos.positionAmt);
                const entryPrice = parseFloat(pos.entryPrice);
                const unrealizedPnl = parseFloat(pos.unrealizedProfit);
                const leverage = parseFloat(pos.leverage) || 1;
                const side = amount > 0 ? "LONG" : "SHORT";
                
                console.log(`- ${symbol} [${side}]:`);
                console.log(`  Amount: ${Math.abs(amount)} | Entry: ${entryPrice}`);
                console.log(`  PnL: ${unrealizedPnl.toFixed(4)} USDT | Leverage: ${leverage}x`);
                console.log(`  Margin: ${(Math.abs(amount) * entryPrice / leverage).toFixed(2)} USDT`);
            });
        } else {
            console.log("✅ Tidak ada posisi aktif");
        }
        
        // Account info
        const accountInfo = balance.info || {};
        console.log(`\n⚙️  ACCOUNT INFO:`);
        console.log(`- Total Asset: ${accountInfo.totalWalletBalance || 'N/A'} USDT`);
        console.log(`- Available Balance: ${accountInfo.availableBalance || 'N/A'} USDT`);
        console.log(`- Max Withdraw: ${accountInfo.maxWithdrawAmount || 'N/A'} USDT`);
        
        return balance;
        
    } catch (error) {
        console.log("❌ Gagal fetch balance:", error.message);
        if (error.message.includes('API-key') || error.message.includes('signature')) {
            console.log("💡 Cek API Key & Secret di file .env");
        } else if (error.message.includes('network')) {
            console.log("💡 Cek koneksi internet");
        }
        return null;
    }
};

// ✅ VALIDATION FUNCTIONS 
const validators = {
    pair: (input) => {
        if (!input) return "❌ Pair tidak boleh kosong!";
        if (!input.includes("/") || !input.includes("USDT")) {
            return "❌ Format pair harus: SYMBOL/USDT:USDT (contoh: DOGE/USDT:USDT)";
        }
        return true;
    },
    
    leverage: (input) => {
        const leverage = parseInt(input);
        if (isNaN(leverage)) return "❌ Leverage harus angka!";
        if (leverage < 1 || leverage > 125) return "❌ Leverage harus 1-125!";
        return true;
    },
    
    usdtPerTrade: (input) => {
        const amount = parseFloat(input);
        if (isNaN(amount)) return "❌ USDT harus angka!";
        if (amount < 5) return "❌ Minimal 5 USDT per trade!";
        if (amount > 1000) return "❌ Maksimal 1000 USDT per trade!";
        return true;
    },
    
    marginMode: (input) => {
        const mode = input.toUpperCase();
        if (mode !== "ISOLATED" && mode !== "CROSSED") {
            return "❌ Pilih: ISOLATED atau CROSSED!";
        }
        return true;
    },
    
    confirmation: (input) => {
        const answer = input.toLowerCase();
        if (answer !== 'y' && answer !== 'n') {
            return "❌ Jawab 'y' untuk Ya atau 'n' untuk Tidak!";
        }
        return true;
    },
    
    menuChoice: (input) => {
        const choice = parseInt(input);
        if (isNaN(choice) || choice < 0 || choice > 6) {
            return "❌ Pilih menu 0-6!";
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
        
        // Menu options
        console.log("\n📝 PILIH OPSI:");
        console.log("1. Ganti Trading Pair");
        console.log("2. Atur Leverage & USDT");
        console.log("3. Atur Margin Mode");
        console.log("4. 💰 Cek Balance Binance");
        console.log("5. Lihat Status Trading");
        console.log("6. Reset Bot (Emergency)");
        console.log("0. Keluar");
        
        const choice = await safeInput("\nPilih menu (0-6): ", validators.menuChoice);
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
                await checkBalance();
                break;
            case "5":
                showTradingStatus(db);
                break;
            case "6":
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
        
        // Hitung PnL unrealized
        const currentTime = new Date().toISOString();
        const entryTime = db.activePosition.entryTime || currentTime;
        console.log(`- Entry Time: ${entryTime}`);
    } else {
        console.log("🟢 TIDAK ADA POSISI AKTIF");
    }
    
    // Statistics
    console.log("\n📈 STATISTICS:");
    console.log(`- Long: ${db.winCountLong || 0}W / ${db.lossCountLong || 0}L`);
    console.log(`- Short: ${db.winCountShort || 0}W / ${db.lossCountShort || 0}L`);
    console.log(`- Total Profit: ${db.totalProfit || 0} USDT`);
    console.log(`- Total Loss: ${db.totalLoss || 0} USDT`);
    
    const netProfit = (db.totalProfit || 0) + (db.totalLoss || 0);
    const winRateLong = db.winCountLong + db.lossCountLong > 0 ? 
        (db.winCountLong / (db.winCountLong + db.lossCountLong) * 100).toFixed(1) : 0;
    const winRateShort = db.winCountShort + db.lossCountShort > 0 ? 
        (db.winCountShort / (db.winCountShort + db.lossCountShort) * 100).toFixed(1) : 0;
        
    console.log(`- Net Profit: ${netProfit.toFixed(6)} USDT`);
    console.log(`- Win Rate Long: ${winRateLong}%`);
    console.log(`- Win Rate Short: ${winRateShort}%`);
    
    console.log("\n⚙️ SETTING AKTIF:");
    console.log(`- Pair: ${db.pair}`);
    console.log(`- Leverage: ${db.leverage}x`);
    console.log(`- USDT/Trade: ${db.usdtPerTrade}`);
    console.log(`- Margin Mode: ${db.marginMode}`);
    
    if (db.lastLongEntryTime && db.lastLongEntryTime !== 0) {
        console.log(`- Last Long Entry: ${new Date(db.lastLongEntryTime).toLocaleString()}`);
    }
    if (db.lastShortEntryTime && db.lastShortEntryTime !== 0) {
        console.log(`- Last Short Entry: ${new Date(db.lastShortEntryTime).toLocaleString()}`);
    }
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

module.exports = { configManager, checkBalance };
