const fs = require("fs");
const path = require("path");
const { sequelize, Config } = require("../services/database-config");

const PROFILE_ALIASES = {
    auto: "auto_spot_grid_dogeusdt",
    manual: "manual_spot_grid_dogeusdt"
};

const resolveProfileName = (rawName) => {
    const name = String(rawName || "auto").trim();
    return PROFILE_ALIASES[name] || name;
};

const main = async () => {
    const profileName = resolveProfileName(process.argv[2]);
    const profilesPath = path.join(__dirname, "..", "config", "trading-profiles.json");
    const profilesFile = JSON.parse(fs.readFileSync(profilesPath, "utf8"));
    const profile = profilesFile?.profiles?.[profileName];
    if (!profile?.config) {
        throw new Error(`Unknown trading profile '${profileName}'.`);
    }

    await sequelize.authenticate();
    let row = await Config.findOne({ order: [["id", "ASC"]] });
    if (!row) row = await Config.create(profile.config);
    const current = row.toJSON();
    if (current.activePosition) {
        throw new Error("Refusing to apply a profile while activePosition is not empty.");
    }

    const payload = {
        ...profile.config,
        activePosition: null,
        activeGridState: null,
        dailyPnL: current.dailyPnL || 0,
        dailyTrades: current.dailyTrades || 0,
        dailyPnlSource: current.dailyPnlSource || "local",
        dailyPnlSyncedAt: current.dailyPnlSyncedAt || 0,
        lastDailyReset: current.lastDailyReset || Date.now(),
        lastUpdated: Date.now()
    };

    await row.update(payload);
    console.log(`Applied trading profile '${profileName}' to Config#${row.id}.`);
    console.log("activeGridState cleared so the next cycle rebuilds the grid.");
};

main()
    .catch((error) => {
        console.error(error.message || error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close().catch(() => {});
    });
