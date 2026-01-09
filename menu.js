// menu.js - Interactive Configuration Menu
const fs = require('fs');
const readline = require('readline');

const dbPath = "./db.json";

// -------------------- LOAD CONFIG --------------------
const loadDB = () => {
    try {
        if (fs.existsSync(dbPath)) {
            return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        }
    } catch (error) {
        console.warn("⚠️ Failed to load DB, using default config");
    }

    return {
         pair: "DOGE/USDT:USDT",
        usdtPerTrade: 0.2,
        leverage: 50,
        targetProfitUSDT: 0.01,
        maxDailyLossPercent: 50,
        coolingPeriod: 3000,
        activePosition: null,
        dailyPnL: 0,
        dailyTrades: 0,
        marginMode: "isolated",
        monitoringInterval: 500,
        stopLossPercent: 50,
        breakoutPeriod: 20,
        minBreakoutStrength: 0.001
    };
};

// -------------------- SAVE CONFIG --------------------
const saveDB = (config) => {
    try {
        fs.writeFileSync(dbPath, JSON.stringify(config, null, 2));
        console.log(`✅ Configuration saved to ${dbPath}`);
        return true;
    } catch (error) {
        console.error("❌ Failed to save configuration:", error.message);
        return false;
    }
};

// -------------------- DISPLAY CURRENT CONFIG --------------------
const displayConfig = (config) => {
    console.clear();
    console.log("=".repeat(70));
    console.log("🤖 REAL-TIME BREAKOUT SCALPING BOT - CONFIGURATION MENU");
    console.log("=".repeat(70));
    console.log("\n📊 CURRENT CONFIGURATION:");
    console.log("=".repeat(40));
    
    const configDisplay = {
        "1. Trading Pair": config.pair,
        "2. USDT per Trade": `${config.usdtPerTrade} USDT`,
        "3. Leverage": `${config.leverage}x`,
        "4. Target Profit per Trade": `${config.targetProfitUSDT} USDT`,
        "5. Max Daily Loss %": `${config.maxDailyLossPercent}%`,
        "6. Cooling Period (ms)": `${config.coolingPeriod}ms`,
        "7. Monitoring Interval (ms)": `${config.monitoringInterval}ms`,
        "8. Stop Loss %": `${config.stopLossPercent}%`,
        "9. Breakout Period": `${config.breakoutPeriod} candles`,
        "10. Min Breakout Strength": config.minBreakoutStrength,
        "11. Margin Mode": config.marginMode,
        "12. Daily P&L": `${config.dailyPnL.toFixed(2)} USDT`,
        "13. Daily Trades": config.dailyTrades
    };

    Object.entries(configDisplay).forEach(([key, value]) => {
        console.log(`   ${key}: ${value}`);
    });

    console.log("=".repeat(40));
    console.log("\n📈 ACTIVE POSITION:");
    if (config.activePosition) {
        const pos = config.activePosition;
        const timeInTrade = Math.floor((Date.now() - pos.entryTime) / 1000);
        console.log(`   ✅ ACTIVE - ${pos.side.toUpperCase()} @ ${pos.entryPrice}`);
        console.log(`      Quantity: ${pos.quantity}`);
        console.log(`      Target: ${pos.targetPrice} (+${pos.targetProfitUSDT} USDT)`);
        console.log(`      Stop Loss: ${pos.stopLossPrice}`);
        console.log(`      Time in trade: ${timeInTrade}s`);
    } else {
        console.log("   ⏳ No active position");
    }
    console.log("=".repeat(70));
};

// -------------------- MENU OPTIONS --------------------
const menuOptions = [
    "Exit",
    "Change Trading Pair",
    "Change USDT per Trade",
    "Change Leverage",
    "Change Target Profit per Trade",
    "Change Max Daily Loss %",
    "Change Cooling Period",
    "Change Monitoring Interval",
    "Change Stop Loss %",
    "Change Breakout Period",
    "Change Min Breakout Strength",
    "Reset Daily P&L & Trades",
    "Force Close Position",
    "Reload Configuration from File",
    "View Log File"
];

// -------------------- INPUT VALIDATION --------------------
const validateNumber = (input, min, max, isInteger = false) => {
    const num = isInteger ? parseInt(input) : parseFloat(input);
    if (isNaN(num)) return { valid: false, message: "Invalid number" };
    if (min !== undefined && num < min) return { valid: false, message: `Must be at least ${min}` };
    if (max !== undefined && num > max) return { valid: false, message: `Must be at most ${max}` };
    return { valid: true, value: num };
};

// -------------------- CONFIGURATION UPDATERS --------------------
const updateConfig = async (rl, config, option) => {
    switch(option) {
        case 1:
            rl.question("Enter new trading pair (e.g., BTC/USDT:USDT): ", (pair) => {
                if (pair && pair.includes('/')) {
                    config.pair = pair;
                    if (saveDB(config)) {
                        console.log(`✅ Trading pair updated to: ${pair}`);
                    }
                } else {
                    console.log("❌ Invalid pair format. Example: BTC/USDT:USDT");
                }
                rl.prompt();
            });
            break;

        case 2:
            rl.question(`Enter USDT per trade (current: ${config.usdtPerTrade}): `, (input) => {
                const result = validateNumber(input, 1, 1000);
                if (result.valid) {
                    config.usdtPerTrade = result.value;
                    if (saveDB(config)) {
                        console.log(`✅ USDT per trade updated to: ${result.value}`);
                    }
                } else {
                    console.log(`❌ ${result.message}`);
                }
                rl.prompt();
            });
            break;

        case 3:
            rl.question(`Enter leverage (1-100, current: ${config.leverage}): `, (input) => {
                const result = validateNumber(input, 1, 100, true);
                if (result.valid) {
                    config.leverage = result.value;
                    if (saveDB(config)) {
                        console.log(`✅ Leverage updated to: ${result.value}x`);
                    }
                } else {
                    console.log(`❌ ${result.message}`);
                }
                rl.prompt();
            });
            break;

        case 4:
            rl.question(`Enter target profit per trade (USDT, current: ${config.targetProfitUSDT}): `, (input) => {
                const result = validateNumber(input, 0.001, 100);
                if (result.valid) {
                    config.targetProfitUSDT = result.value;
                    if (saveDB(config)) {
                        console.log(`✅ Target profit updated to: ${result.value} USDT`);
                    }
                } else {
                    console.log(`❌ ${result.message}`);
                }
                rl.prompt();
            });
            break;

        case 5:
            rl.question(`Enter max daily loss % (1-50, current: ${config.maxDailyLossPercent}): `, (input) => {
                const result = validateNumber(input, 1, 50);
                if (result.valid) {
                    config.maxDailyLossPercent = result.value;
                    if (saveDB(config)) {
                        console.log(`✅ Max daily loss updated to: ${result.value}%`);
                    }
                } else {
                    console.log(`❌ ${result.message}`);
                }
                rl.prompt();
            });
            break;

        case 6:
            rl.question(`Enter cooling period in milliseconds (1000-60000, current: ${config.coolingPeriod}): `, (input) => {
                const result = validateNumber(input, 1000, 60000, true);
                if (result.valid) {
                    config.coolingPeriod = result.value;
                    if (saveDB(config)) {
                        console.log(`✅ Cooling period updated to: ${result.value}ms`);
                    }
                } else {
                    console.log(`❌ ${result.message}`);
                }
                rl.prompt();
            });
            break;

        case 7:
            rl.question(`Enter monitoring interval in milliseconds (100-5000, current: ${config.monitoringInterval}): `, (input) => {
                const result = validateNumber(input, 100, 5000, true);
                if (result.valid) {
                    config.monitoringInterval = result.value;
                    if (saveDB(config)) {
                        console.log(`✅ Monitoring interval updated to: ${result.value}ms`);
                    }
                } else {
                    console.log(`❌ ${result.message}`);
                }
                rl.prompt();
            });
            break;

        case 8:
            rl.question(`Enter stop loss % (1-100, current: ${config.stopLossPercent}): `, (input) => {
                const result = validateNumber(input, 1, 100);
                if (result.valid) {
                    config.stopLossPercent = result.value;
                    if (saveDB(config)) {
                        console.log(`✅ Stop loss updated to: ${result.value}%`);
                    }
                } else {
                    console.log(`❌ ${result.message}`);
                }
                rl.prompt();
            });
            break;

        case 9:
            rl.question(`Enter breakout period (5-100, current: ${config.breakoutPeriod}): `, (input) => {
                const result = validateNumber(input, 5, 100, true);
                if (result.valid) {
                    config.breakoutPeriod = result.value;
                    if (saveDB(config)) {
                        console.log(`✅ Breakout period updated to: ${result.value} candles`);
                    }
                } else {
                    console.log(`❌ ${result.message}`);
                }
                rl.prompt();
            });
            break;

        case 10:
            rl.question(`Enter min breakout strength (0.0001-0.1, current: ${config.minBreakoutStrength}): `, (input) => {
                const result = validateNumber(input, 0.0001, 0.1);
                if (result.valid) {
                    config.minBreakoutStrength = result.value;
                    if (saveDB(config)) {
                        console.log(`✅ Min breakout strength updated to: ${result.value}`);
                    }
                } else {
                    console.log(`❌ ${result.message}`);
                }
                rl.prompt();
            });
            break;

        case 11:
            rl.question("Are you sure you want to reset daily P&L and trade count? (yes/no): ", (answer) => {
                if (answer.toLowerCase() === 'yes') {
                    config.dailyPnL = 0;
                    config.dailyTrades = 0;
                    if (saveDB(config)) {
                        console.log("✅ Daily P&L and trade count reset to zero");
                    }
                } else {
                    console.log("❌ Reset cancelled");
                }
                rl.prompt();
            });
            break;

        case 12:
            if (config.activePosition) {
                rl.question("⚠️ WARNING: Force closing position may result in loss. Continue? (yes/no): ", (answer) => {
                    if (answer.toLowerCase() === 'yes') {
                        config.activePosition = null;
                        if (saveDB(config)) {
                            console.log("✅ Position marked for closure (bot will close on next check)");
                        }
                    } else {
                        console.log("❌ Force close cancelled");
                    }
                    rl.prompt();
                });
            } else {
                console.log("❌ No active position to close");
                rl.prompt();
            }
            break;

        case 13:
            const freshConfig = loadDB();
            Object.assign(config, freshConfig);
            console.log("✅ Configuration reloaded from file");
            displayConfig(config);
            rl.prompt();
            break;

        case 14:
            try {
                const logContent = fs.readFileSync('./log.csv', 'utf8');
                console.log("\n" + "=".repeat(70));
                console.log("📄 TRADE LOG (Last 10 entries):");
                console.log("=".repeat(70));
                const lines = logContent.trim().split('\n');
                const lastLines = lines.slice(-10);
                lastLines.forEach(line => console.log(line));
                console.log("=".repeat(70));
            } catch (error) {
                console.log("❌ No log file found or error reading log");
            }
            rl.prompt();
            break;
    }
};

// -------------------- MAIN MENU --------------------
const mainMenu = () => {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '\n📝 Enter option number (0 to exit, h for help): '
    });

    let config = loadDB();

    // Auto-reload config every 2 seconds
    const autoReload = setInterval(() => {
        const freshConfig = loadDB();
        // Merge without overwriting display-specific values
        const { dailyPnL, dailyTrades, activePosition, ...otherConfig } = freshConfig;
        Object.assign(config, otherConfig);
        
        // Only update position if it's different
        if (JSON.stringify(config.activePosition) !== JSON.stringify(activePosition)) {
            config.activePosition = activePosition;
        }
        
        // Update P&L and trades
        config.dailyPnL = dailyPnL;
        config.dailyTrades = dailyTrades;
    }, 2000);

    console.clear();
    displayConfig(config);

    console.log("\n📋 MENU OPTIONS:");
    menuOptions.forEach((option, index) => {
        console.log(`   ${index}. ${option}`);
    });

    rl.prompt();

    rl.on('line', (line) => {
        const input = line.trim().toLowerCase();
        
        if (input === '0' || input === 'exit' || input === 'quit') {
            console.log("👋 Exiting menu... Bot continues running.");
            clearInterval(autoReload);
            rl.close();
            return;
        }

        if (input === 'h' || input === 'help') {
            displayConfig(config);
            console.log("\n📋 MENU OPTIONS:");
            menuOptions.forEach((option, index) => {
                console.log(`   ${index}. ${option}`);
            });
            rl.prompt();
            return;
        }

        const option = parseInt(input);
        if (isNaN(option) || option < 0 || option >= menuOptions.length) {
            console.log(`❌ Invalid option. Enter 0-${menuOptions.length-1} or 'h' for help`);
            rl.prompt();
            return;
        }

        if (option === 0) {
            console.log("👋 Exiting menu... Bot continues running.");
            clearInterval(autoReload);
            rl.close();
            return;
        }

        updateConfig(rl, config, option);
    });

    rl.on('close', () => {
        clearInterval(autoReload);
        console.log("\n🔄 Menu closed. Bot configuration auto-reload stopped.");
        process.exit(0);
    });
};

// -------------------- START MENU --------------------
if (require.main === module) {
    console.log("🔧 Loading interactive configuration menu...");
    console.log("📢 Note: This menu runs alongside the trading bot.");
    console.log("   Changes are automatically loaded by the bot every 2 seconds.\n");
    
    setTimeout(() => {
        mainMenu();
    }, 1000);
}

module.exports = { loadDB, saveDB };