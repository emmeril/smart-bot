require("dotenv").config();

const {
    sequelize,
    Config,
    BOOLEAN_CONFIG_KEYS,
    VALID_MARGIN_MODES,
    DEFAULT_CONFIG,
    DASHBOARD_USERNAME,
    DASHBOARD_PASSWORD,
    DASHBOARD_SESSION_SECRET
} = require("../services/database-config");
const { createConfigModelHelpers } = require("../services/config-model");
const { createConfigPersistenceHelpers } = require("../services/config-persistence");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const toFiniteNumber = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const isLegacySinglePosition = (value) => value && typeof value === "object" && !Array.isArray(value) && ("entryPrice" in value || "quantity" in value || "side" in value);
const toPositionMapKey = (positionSide) => {
    const normalized = String(positionSide || "").toUpperCase();
    if (normalized === "LONG" || normalized === "BUY") return "LONG";
    if (normalized === "SHORT" || normalized === "SELL") return "SHORT";
    return "BOTH";
};
const withSqliteBusyRetry = async (fn, { attempts = 5, delayMs = 150 } = {}) => {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            const message = String(error?.message || error);
            const isBusy = message.includes("SQLITE_BUSY") || message.includes("database is locked");
            if (!isBusy || attempt === attempts - 1) throw error;
            await sleep(delayMs);
        }
    }
    throw lastError;
};

const splitKeyList = (value) => String(value || "")
    .split(/[\n,;]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

const uniqueStrings = (values) => {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        const normalized = String(value || "").trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
};

const collectGeminiApiKeys = () => {
    const envIndexedKeys = Object.entries(process.env)
        .filter(([key]) => /^GEMINI_API_KEY_\d+$/.test(key))
        .sort(([leftKey], [rightKey]) => Number.parseInt(leftKey.split("_").pop(), 10) - Number.parseInt(rightKey.split("_").pop(), 10))
        .flatMap(([, value]) => splitKeyList(value));

    return uniqueStrings([
        ...splitKeyList(process.env.GEMINI_API_KEYS),
        ...splitKeyList(process.env.GEMINI_API_KEY),
        ...envIndexedKeys
    ]);
};

const {
    hydrateConfig,
    normalizeConfig,
    ensureConfigSchema
} = createConfigModelHelpers({
    sequelize,
    Config,
    booleanConfigKeys: BOOLEAN_CONFIG_KEYS,
    defaultConfig: DEFAULT_CONFIG,
    validMarginModes: VALID_MARGIN_MODES,
    withSqliteBusyRetry,
    getDefaultConfig: () => DEFAULT_CONFIG,
    toFiniteNumber,
    clamp,
    isLegacySinglePosition,
    toPositionMapKey
});

const {
    ensureConfigRow
} = createConfigPersistenceHelpers({
    getConfigRow: async () => await withSqliteBusyRetry(() => Config.findOne()),
    withSqliteBusyRetry,
    Config,
    getDefaultConfig: () => DEFAULT_CONFIG,
    hydrateConfig,
    serializeConfigForSave: (config) => ({ ...config, lastUpdated: Date.now() }),
    logCreated: () => console.log("[DB][INFO] Created missing config row")
});

const formatValue = (value) => {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
};

const pushIssue = (bucket, level, message) => bucket.push({ level, message });

const checkEnv = () => {
    const issues = [];
    const apiKey = String(process.env.API_KEY || "").trim();
    const apiSecret = String(process.env.API_SECRET || "").trim();
    const dashboardHost = String(process.env.DASHBOARD_HOST || "127.0.0.1").trim();
    const dashboardPort = Math.max(1, Math.trunc(toFiniteNumber(process.env.DASHBOARD_PORT || process.env.PORT, 3000)));
    const fonnteEnabled = String(process.env.FONNTE_NOTIFICATIONS_ENABLED || "").trim().toLowerCase() === "true";
    const fonnteToken = String(process.env.FONNTE_TOKEN || "").trim();
    const fonnteTarget = String(process.env.FONNTE_TARGET || process.env.ADMIN_PHONE || "").trim();
    const aiFilterEnabled = String(process.env.AI_SIGNAL_FILTER_ENABLED || "").trim().toLowerCase() === "true";
    const geminiApiKeys = collectGeminiApiKeys();

    if (!apiKey) pushIssue(issues, "fail", "API_KEY is missing.");
    if (!apiSecret) pushIssue(issues, "fail", "API_SECRET is missing.");
    if (apiKey && apiSecret && apiKey === apiSecret) pushIssue(issues, "fail", "API_KEY and API_SECRET are identical.");

    if (!String(DASHBOARD_USERNAME || "").trim() || DASHBOARD_USERNAME === "admin") {
        pushIssue(issues, "warn", "Dashboard username is default or empty.");
    }
    if (!String(DASHBOARD_PASSWORD || "").trim() || DASHBOARD_PASSWORD === "admin123") {
        pushIssue(issues, "warn", "Dashboard password is default or empty.");
    }
    if (!String(DASHBOARD_SESSION_SECRET || "").trim() || DASHBOARD_SESSION_SECRET === "smart-bot-dashboard-secret") {
        pushIssue(issues, "warn", "Dashboard session secret is default or empty.");
    }

    if (dashboardHost === "0.0.0.0") {
        pushIssue(issues, "warn", "Dashboard host is 0.0.0.0; keep it private unless you need external access.");
    }
    if (dashboardPort < 1024) {
        pushIssue(issues, "warn", `Dashboard port ${dashboardPort} is privileged; confirm this is intentional.`);
    }

    if (fonnteEnabled && (!fonnteToken || !fonnteTarget)) {
        pushIssue(issues, "warn", "Fonnte notifications are enabled but token or target is missing.");
    }

    if (aiFilterEnabled && geminiApiKeys.length === 0) {
        pushIssue(issues, "warn", "AI signal filter is enabled but no Gemini API key is configured.");
    }
    if (aiFilterEnabled && geminiApiKeys.length === 1) {
        pushIssue(issues, "warn", "AI signal filter has only one Gemini API key configured; add backup keys to reduce quota interruptions.");
    }

    return issues;
};

const checkConfig = (config) => {
    const issues = [];
    const criticalKeys = [
        "strategy",
        "pair",
        "marginMode",
        "gridTimeframe",
        "gridLevels",
        "gridLookbackCandles",
        "gridRangePercent",
        "gridEntryBufferPercent",
        "gridTakeProfitLevels",
        "gridOrdersPerSide",
        "gridStopLossLevels",
        "sessionStartUTC",
        "sessionEndUTC",
        "volumePeriod",
        "minVolumeRatio",
        "atrPeriod",
        "riskRewardRatio",
        "trailingEnabled",
        "autoStopLossEnabled",
        "autoTargetProfitEnabled",
        "monitoringInterval",
        "coolingPeriod",
        "maxTradesPerDay"
    ];

    const raw = config || {};
    const normalized = normalizeConfig(raw);
    for (const key of criticalKeys) {
        if (formatValue(raw[key]) === formatValue(normalized[key])) continue;
        const level = ["strategy", "pair", "marginMode", "gridTimeframe", "gridLevels"].includes(key) ? "fail" : "warn";
        pushIssue(issues, level, `Config '${key}' was normalized from ${formatValue(raw[key])} to ${formatValue(normalized[key])}.`);
    }

    if (normalized.marginMode !== "spot") {
        pushIssue(issues, "fail", `Unsupported marginMode '${normalized.marginMode}'.`);
    }
    if (normalized.strategy !== "spot_grid") {
        pushIssue(issues, "fail", `Unsupported strategy '${normalized.strategy}'.`);
    }
    if (!/^.+\/.+$/.test(String(normalized.pair || ""))) {
        pushIssue(issues, "fail", `Pair '${normalized.pair}' is not in BASE/QUOTE format.`);
    }
    if (normalized.sessionStartUTC === normalized.sessionEndUTC) {
        pushIssue(issues, "warn", "sessionStartUTC and sessionEndUTC are equal; trading window may be effectively closed except at one hour.");
    }
    if (normalized.coolingPeriod > 0 && normalized.monitoringInterval > normalized.coolingPeriod) {
        pushIssue(issues, "warn", "monitoringInterval is longer than coolingPeriod; reaction time may feel sluggish.");
    }

    return { issues, normalized };
};

const printIssues = (label, issues) => {
    if (!issues.length) {
        console.log(`[${label}][OK] No issues found.`);
        return;
    }
    for (const issue of issues) {
        const tag = issue.level === "fail" ? "ERROR" : "WARN";
        console.log(`[${label}][${tag}] ${issue.message}`);
    }
};

const main = async () => {
    const summary = { fail: [], warn: [] };
    const envIssues = checkEnv();
    const hasEnvFailures = envIssues.some((issue) => issue.level === "fail");
    summary.fail.push(...envIssues.filter((issue) => issue.level === "fail"));
    summary.warn.push(...envIssues.filter((issue) => issue.level === "warn"));

    console.log("[PREFLIGHT][INFO] Checking local database...");
    await sequelize.authenticate();
    await ensureConfigSchema();
    const configRow = await ensureConfigRow();
    const rawConfig = configRow.toJSON();
    const { issues: configIssues, normalized } = checkConfig(hydrateConfig(rawConfig));
    summary.fail.push(...configIssues.filter((issue) => issue.level === "fail"));
    summary.warn.push(...configIssues.filter((issue) => issue.level === "warn"));

    if (rawConfig.activePosition) {
        summary.warn.push({ level: "warn", message: "activePosition is not empty. The bot will try to recover existing exposure on startup." });
    }
    if (rawConfig.activeGridState) {
        summary.warn.push({ level: "warn", message: "activeGridState is present. The next cycle may resume or rebuild ladder state." });
    }

    if (hasEnvFailures || summary.fail.length > 0) {
        printIssues("PREFLIGHT", summary.fail);
        printIssues("PREFLIGHT", summary.warn);
        console.log("[PREFLIGHT][FAIL] Live preflight failed.");
        process.exitCode = 1;
        return;
    }

    if (summary.warn.length > 0) printIssues("PREFLIGHT", summary.warn);
    else console.log("[PREFLIGHT][OK] No issues found.");
    console.log("[PREFLIGHT][PASS] Preflight checks passed.");
    console.log(`[PREFLIGHT][INFO] Runtime config pair=${normalized.pair}, strategy=${normalized.strategy}, mode=${normalized.marginMode}`);
};

main()
    .catch((error) => {
        console.error("[PREFLIGHT][ERROR]", error.message || error);
        if (error?.stack) console.error(error.stack);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close().catch(() => {});
    });
