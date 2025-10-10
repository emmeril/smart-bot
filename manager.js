const fs = require("fs");
const readline = require("readline");
const ccxt = require("ccxt");  // ✅ IMPORT CCXT

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
        
        // Position info
        const positions = balance.info?.positions || [];
        const activePositions = positions.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        
        console.log(`📈 Active Positions: ${activePositions.length}`);
        
        if (activePositions.length > 0) {
            console.log("\n🔍 DETAIL POSISI:");
            activePositions.forEach(pos => {
                const symbol = pos.symbol;
                const amount = parseFloat(pos.positionAmt);
                const entryPrice = parseFloat(pos.entryPrice);
                const unrealizedPnl = parseFloat(pos.unrealizedProfit);
                
                console.log(`- ${symbol}: ${amount} (Entry: ${entryPrice}) | PnL: ${unrealizedPnl.toFixed(4)} USDT`);
            });
        }
        
        // Account info
        const accountInfo = balance.info || {};
        console.log(`\n⚙️  ACCOUNT INFO:`);
        console.log(`- Margin Mode: ${accountInfo.marginType || 'N/A'}`);
        console.log(`- Leverage: ${accountInfo.leverage || 'N/A'}x`);
        
        return balance;
        
    } catch (error) {
        console.log("❌ Gagal fetch balance:", error.message);
        if (error.message.includes('API-key')) {
            console.log("💡 Cek API Key & Secret di file .env");
        }
        return null;
    }
};

// ✅ VALIDATION FUNCTIONS 
const validators = {
    // ... (validators yang sama seperti sebelumnya)
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
        
        // Menu options - TAMBAH CEK BALANCE
        console.log("\n📝 PILIH OPSI:");
        console.log("1. Ganti Trading Pair");
        console.log("2. Atur Leverage & USDT");
        console.log("3. Atur Margin Mode");
        console.log("4. 🔍 Cek Balance Binance");  // ✅ NEW
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
            case "4":  // ✅ NEW - CEK BALANCE
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

// ... (fungsi-fungsi lainnya tetap sama: changePair, changeLeverageAndUsdt, changeMarginMode, showTradingStatus, resetBot)

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
