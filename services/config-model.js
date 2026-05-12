const createConfigModelHelpers = ({
    sequelize,
    Config,
    booleanConfigKeys,
    defaultConfig,
    validMarginModes,
    withSqliteBusyRetry,
    getDefaultConfig,
    toFiniteNumber,
    clamp,
    isLegacySinglePosition,
    toPositionMapKey
}) => {
    const safeParseJSON = (value, fallback = null) => {
        if (value === undefined || value === null || value === "") return fallback;
        if (typeof value === "object") return value;
        if (typeof value !== "string") return fallback;
        try { return JSON.parse(value); } catch { return fallback; }
    };

    const normalizeActivePositionState = (activePosition) => {
        const parsed = safeParseJSON(activePosition, null);
        if (!parsed || typeof parsed !== "object") return null;
        if (isLegacySinglePosition(parsed)) {
            const legacyKey = toPositionMapKey("BOTH");
            return { [legacyKey]: parsed };
        }

        const normalizedEntries = Object.entries(parsed)
            .filter(([, value]) => value && typeof value === "object")
            .map(([key, value]) => [toPositionMapKey(key), value]);
        return normalizedEntries.length > 0 ? Object.fromEntries(normalizedEntries) : null;
    };

    const normalizeConfig = (config) => {
        const defaults = getDefaultConfig();
        if (!config || typeof config !== "object") return { ...defaults };

        const normalized = { ...defaults };
        Object.keys(config).forEach((key) => {
            const isKnownConfigKey = Object.prototype.hasOwnProperty.call(defaults, key);
            if (isKnownConfigKey || key === "id" || key === "breakoutTimeframe") {
                normalized[key] = config[key];
            }
        });
        const numericRules = {
            gridOrderSizeUsdt: { min: 0, allowZero: true },
            gridTargetProfitUsdt: { min: 0, allowZero: false },
            maxTradesPerDay: { min: 0, allowZero: false, integer: true },
            coolingPeriod: { min: 0, allowZero: true, integer: true }, monitoringInterval: { min: 200, allowZero: false, integer: true },
            gridStopLossPercent: { min: 0, allowZero: false }, gridLevels: { min: 0, allowZero: true, integer: true },
            gridLookbackCandles: { min: 20, allowZero: false, integer: true }, gridRangePercent: { min: 0, allowZero: true },
            gridEntryBufferPercent: { min: 0, allowZero: true }, gridTakeProfitLevels: { min: 0, allowZero: true, integer: true },
            gridOrdersPerSide: { min: 0, allowZero: true, integer: true },
            gridStopLossLevels: { min: 0, allowZero: true }, sessionStartUTC: { min: 0, allowZero: true, integer: true },
            sessionEndUTC: { min: 0, allowZero: true, integer: true }, volumePeriod: { min: 2, allowZero: false, integer: true },
            minVolumeRatio: { min: 1, allowZero: false },
            atrPeriod: { min: 2, allowZero: false, integer: true },
            riskRewardRatio: { min: 0.5, allowZero: false },
            targetProfitAtrMultiplier: { min: 0.1, allowZero: false },
            targetProfitMinUsdt: { min: 0, allowZero: true },
            targetProfitMaxUsdt: { min: 0, allowZero: true },
            stopLossAtrMultiplier: { min: 0.05, allowZero: false },
            stopLossMinPercent: { min: 0, allowZero: true },
            stopLossMaxPercent: { min: 0, allowZero: true },
            trailingActivateATR: { min: 0.2, allowZero: false },
            trailingOffsetATR: { min: 0.1, allowZero: false },
            entryRsiPeriod: { min: 2, allowZero: false, integer: true },
            entryRsiLongThreshold: { min: 1, allowZero: false },
            entryRsiShortThreshold: { min: 50, allowZero: false },
            entryAdxPeriod: { min: 2, allowZero: false, integer: true },
            entryAdxMax: { min: 5, allowZero: false },
            entryBbPeriod: { min: 5, allowZero: false, integer: true },
            entryBbStdDev: { min: 1, allowZero: false },
            entryBbLongThreshold: { min: 0, allowZero: true },
            entryBbShortThreshold: { min: 0.5, allowZero: false }
        };

        Object.entries(numericRules).forEach(([key, rule]) => {
            const rawValue = normalized[key];
            const hasValue = rawValue !== undefined && rawValue !== null && rawValue !== "";
            if (!hasValue) { normalized[key] = defaults[key]; return; }
            const value = Number(rawValue);
            const normalizedValue = rule.integer ? Math.trunc(value) : value;
            const invalidNumber = !Number.isFinite(value);
            const invalidZero = !rule.allowZero && normalizedValue === 0;
            const belowMin = normalizedValue < rule.min;
            if (invalidNumber || invalidZero || belowMin) {
                console.warn(`[CONFIG][WARN] Invalid config '${key}' (${normalized[key]}). Using default ${defaults[key]}.`);
                normalized[key] = defaults[key];
                return;
            }
            normalized[key] = normalizedValue;
        });

        if (normalized.gridLevels !== 0 && normalized.gridLevels < 4) {
            console.warn(`[CONFIG][WARN] Invalid config 'gridLevels' (${normalized.gridLevels}). Using default ${defaults.gridLevels}.`);
            normalized.gridLevels = defaults.gridLevels;
        }

        const isValidTimeframe = (value) => typeof value === "string" && /^[1-9]\d*[mhdwM]$/.test(value.trim());
        const rawPair = typeof normalized.pair === "string" ? normalized.pair.trim() : "";
        normalized.pair = rawPair || defaults.pair;
        const rawStrategy = typeof normalized.strategy === "string" ? normalized.strategy.trim().toLowerCase() : "";
        normalized.strategy = rawStrategy === "spot_grid" ? "spot_grid" : defaults.strategy;
        normalized.marginMode = defaults.marginMode;
        const rawGridTimeframe = typeof normalized.gridTimeframe === "string"
            ? normalized.gridTimeframe
            : normalized.breakoutTimeframe;
        normalized.gridTimeframe = isValidTimeframe(rawGridTimeframe) ? rawGridTimeframe.trim() : defaults.gridTimeframe;
        delete normalized.breakoutTimeframe;
        normalized.activePosition = normalizeActivePositionState(normalized.activePosition);
        if (typeof normalized.activeGridState === "string") {
            normalized.activeGridState = safeParseJSON(normalized.activeGridState, null);
        } else if (!normalized.activeGridState || typeof normalized.activeGridState !== "object") {
            normalized.activeGridState = null;
        }

        const normalizeBoolean = (key) => {
            if (typeof normalized[key] === "boolean") return;
            if (typeof normalized[key] === "string") {
                const parsed = normalized[key].trim().toLowerCase();
                if (parsed === "true" || parsed === "1") normalized[key] = true;
                else if (parsed === "false" || parsed === "0") normalized[key] = false;
                else normalized[key] = defaults[key];
            } else if (typeof normalized[key] === "number") {
                normalized[key] = normalized[key] === 1;
            } else {
                normalized[key] = defaults[key];
            }
        };

        booleanConfigKeys.forEach(normalizeBoolean);
        normalized.dailyPnL = toFiniteNumber(normalized.dailyPnL, defaults.dailyPnL);
        normalized.dailyTrades = Math.max(0, Math.trunc(toFiniteNumber(normalized.dailyTrades, defaults.dailyTrades)));
        normalized.dailyPnlSource = typeof normalized.dailyPnlSource === "string" && normalized.dailyPnlSource.trim()
            ? normalized.dailyPnlSource.trim().toLowerCase()
            : defaults.dailyPnlSource;
        normalized.dailyPnlSyncedAt = toFiniteNumber(normalized.dailyPnlSyncedAt, defaults.dailyPnlSyncedAt);
        normalized.lastDailyReset = toFiniteNumber(normalized.lastDailyReset, defaults.lastDailyReset);
        normalized.lastUpdated = toFiniteNumber(normalized.lastUpdated, defaults.lastUpdated);
        if (normalized.id !== undefined && normalized.id !== null && normalized.id !== "") {
            normalized.id = Math.max(0, Math.trunc(toFiniteNumber(normalized.id, 0)));
        }
        normalized.sessionStartUTC = clamp(Math.trunc(toFiniteNumber(normalized.sessionStartUTC, defaults.sessionStartUTC)), 0, 23);
        normalized.sessionEndUTC = clamp(Math.trunc(toFiniteNumber(normalized.sessionEndUTC, defaults.sessionEndUTC)), 0, 23);
        const gridLevelsCap = normalized.gridLevels > 0 ? normalized.gridLevels : Math.max(defaults.gridLevels, 18);
        normalized.gridTakeProfitLevels = clamp(normalized.gridTakeProfitLevels, 0, Math.max(1, gridLevelsCap - 1));
        normalized.gridOrdersPerSide = clamp(normalized.gridOrdersPerSide, 0, Math.max(1, gridLevelsCap - 1));
        normalized.entryRsiLongThreshold = clamp(normalized.entryRsiLongThreshold, 1, 49);
        normalized.entryRsiShortThreshold = clamp(normalized.entryRsiShortThreshold, 51, 99);
        normalized.entryAdxMax = clamp(normalized.entryAdxMax, 5, 80);
        normalized.entryBbLongThreshold = clamp(normalized.entryBbLongThreshold, 0, 0.49);
        normalized.entryBbShortThreshold = clamp(normalized.entryBbShortThreshold, 0.51, 1);

        return normalized;
    };

    const hydrateConfig = (config) => {
        const hydrated = { ...config };
        if (hydrated.gridOrderSizeUsdt === undefined && hydrated.usdtPerTrade !== undefined) hydrated.gridOrderSizeUsdt = hydrated.usdtPerTrade;
        delete hydrated.usdtPerTrade;
        if (hydrated.gridTargetProfitUsdt === undefined && hydrated.targetProfitUSDT !== undefined) hydrated.gridTargetProfitUsdt = hydrated.targetProfitUSDT;
        delete hydrated.targetProfitUSDT;
        if (hydrated.autoTargetProfitEnabled === undefined && hydrated.autoTpEnabled !== undefined) hydrated.autoTargetProfitEnabled = hydrated.autoTpEnabled;
        delete hydrated.autoTpEnabled;
        if (hydrated.autoStopLossEnabled === undefined && hydrated.autoSlEnabled !== undefined) hydrated.autoStopLossEnabled = hydrated.autoSlEnabled;
        delete hydrated.autoSlEnabled;
        if (hydrated.gridStopLossPercent === undefined && hydrated.stopLossPercent !== undefined) hydrated.gridStopLossPercent = hydrated.stopLossPercent;
        delete hydrated.stopLossPercent;
        if (hydrated.gridTimeframe === undefined && typeof hydrated.breakoutTimeframe === "string") hydrated.gridTimeframe = hydrated.breakoutTimeframe;
        delete hydrated.breakoutTimeframe;
        hydrated.activePosition = normalizeActivePositionState(hydrated.activePosition);
        hydrated.activeGridState = safeParseJSON(hydrated.activeGridState, null);
        return normalizeConfig(hydrated);
    };

    const serializeConfigForSave = (config) => ({
        ...config,
        activePosition: config.activePosition ? JSON.stringify(config.activePosition) : null,
        activeGridState: config.activeGridState ? JSON.stringify(config.activeGridState) : null,
        lastUpdated: Date.now()
    });

    const getConfigRow = async () => withSqliteBusyRetry(() => Config.findOne());
    const obsoleteConfigColumns = ["autoRiskEnabled", "atrTargetMult", "atrStopMult", ["leve", "rage"].join("")];

    const ensureConfigSchema = async () => {
        await withSqliteBusyRetry(() => sequelize.sync());
        const tableInfo = await withSqliteBusyRetry(() => sequelize.query("PRAGMA table_info('Configs');", { type: sequelize.QueryTypes.SELECT }));
        const columnNames = new Set(tableInfo.map((column) => String(column.name)));

        const addColumnIfMissing = async ({ column, sql, legacyCopySql = null }) => {
            if (columnNames.has(column)) return;
            await withSqliteBusyRetry(() => sequelize.query(sql));
            if (legacyCopySql) await withSqliteBusyRetry(() => sequelize.query(legacyCopySql));
            console.log(`[CONFIG][INFO] Added config column: ${column}`);
        };

        await addColumnIfMissing({
            column: "gridOrderSizeUsdt",
            sql: "ALTER TABLE Configs ADD COLUMN gridOrderSizeUsdt FLOAT DEFAULT 1.5;",
            legacyCopySql: columnNames.has("usdtPerTrade")
                ? "UPDATE Configs SET gridOrderSizeUsdt = COALESCE(usdtPerTrade, 1.5) WHERE gridOrderSizeUsdt IS NULL OR gridOrderSizeUsdt = '';"
                : null
        });
        await addColumnIfMissing({
            column: "gridTargetProfitUsdt",
            sql: "ALTER TABLE Configs ADD COLUMN gridTargetProfitUsdt FLOAT DEFAULT 0.5;",
            legacyCopySql: columnNames.has("targetProfitUSDT")
                ? "UPDATE Configs SET gridTargetProfitUsdt = COALESCE(targetProfitUSDT, 0.5) WHERE gridTargetProfitUsdt IS NULL OR gridTargetProfitUsdt = '';"
                : null
        });
        await addColumnIfMissing({
            column: "gridStopLossPercent",
            sql: "ALTER TABLE Configs ADD COLUMN gridStopLossPercent FLOAT DEFAULT 5;",
            legacyCopySql: columnNames.has("stopLossPercent")
                ? "UPDATE Configs SET gridStopLossPercent = COALESCE(stopLossPercent, 5) WHERE gridStopLossPercent IS NULL OR gridStopLossPercent = '';"
                : null
        });
        await addColumnIfMissing({
            column: "autoStopLossEnabled",
            sql: "ALTER TABLE Configs ADD COLUMN autoStopLossEnabled BOOLEAN DEFAULT 1;",
            legacyCopySql: columnNames.has("autoSlEnabled")
                ? "UPDATE Configs SET autoStopLossEnabled = COALESCE(autoSlEnabled, 1) WHERE autoStopLossEnabled IS NULL OR autoStopLossEnabled = '';"
                : null
        });
        await addColumnIfMissing({ column: "stopLossAtrMultiplier", sql: "ALTER TABLE Configs ADD COLUMN stopLossAtrMultiplier FLOAT DEFAULT 1.6;" });
        await addColumnIfMissing({ column: "stopLossMinPercent", sql: "ALTER TABLE Configs ADD COLUMN stopLossMinPercent FLOAT DEFAULT 2.5;" });
        await addColumnIfMissing({ column: "stopLossMaxPercent", sql: "ALTER TABLE Configs ADD COLUMN stopLossMaxPercent FLOAT DEFAULT 10;" });
        await addColumnIfMissing({
            column: "autoTargetProfitEnabled",
            sql: "ALTER TABLE Configs ADD COLUMN autoTargetProfitEnabled BOOLEAN DEFAULT 1;",
            legacyCopySql: columnNames.has("autoTpEnabled")
                ? "UPDATE Configs SET autoTargetProfitEnabled = COALESCE(autoTpEnabled, 1) WHERE autoTargetProfitEnabled IS NULL OR autoTargetProfitEnabled = '';"
                : null
        });
         await addColumnIfMissing({ column: "gridRecalculateExitsOnScaleIn", sql: "ALTER TABLE Configs ADD COLUMN gridRecalculateExitsOnScaleIn BOOLEAN DEFAULT 1;" });
         await addColumnIfMissing({ column: "targetProfitAtrMultiplier", sql: "ALTER TABLE Configs ADD COLUMN targetProfitAtrMultiplier FLOAT DEFAULT 2.4;" });
         await addColumnIfMissing({ column: "targetProfitMinUsdt", sql: "ALTER TABLE Configs ADD COLUMN targetProfitMinUsdt FLOAT DEFAULT 0.25;" });
         await addColumnIfMissing({ column: "targetProfitMaxUsdt", sql: "ALTER TABLE Configs ADD COLUMN targetProfitMaxUsdt FLOAT DEFAULT 5;" });
         await addColumnIfMissing({ column: "syncExchangePnl", sql: "ALTER TABLE Configs ADD COLUMN syncExchangePnl BOOLEAN DEFAULT 0;" });
        await addColumnIfMissing({
            column: "gridTimeframe",
            sql: "ALTER TABLE Configs ADD COLUMN gridTimeframe VARCHAR(255) DEFAULT '5m';",
            legacyCopySql: columnNames.has("breakoutTimeframe")
                ? "UPDATE Configs SET gridTimeframe = COALESCE(breakoutTimeframe, '5m') WHERE gridTimeframe IS NULL OR gridTimeframe = '';"
                : null
        });
        await addColumnIfMissing({ column: "activeGridState", sql: "ALTER TABLE Configs ADD COLUMN activeGridState TEXT DEFAULT NULL;" });
        await addColumnIfMissing({ column: "dailyPnlSource", sql: "ALTER TABLE Configs ADD COLUMN dailyPnlSource VARCHAR(255) DEFAULT 'local';" });
        await addColumnIfMissing({ column: "dailyPnlSyncedAt", sql: "ALTER TABLE Configs ADD COLUMN dailyPnlSyncedAt BIGINT DEFAULT 0;" });
        await addColumnIfMissing({ column: "strategy", sql: "ALTER TABLE Configs ADD COLUMN strategy VARCHAR(255) DEFAULT 'spot_grid';" });
        await addColumnIfMissing({ column: "sessionStartUTC", sql: "ALTER TABLE Configs ADD COLUMN sessionStartUTC INTEGER DEFAULT 0;" });
        await addColumnIfMissing({ column: "sessionEndUTC", sql: "ALTER TABLE Configs ADD COLUMN sessionEndUTC INTEGER DEFAULT 23;" });
        await addColumnIfMissing({ column: "volumePeriod", sql: "ALTER TABLE Configs ADD COLUMN volumePeriod INTEGER DEFAULT 20;" });
        await addColumnIfMissing({ column: "minVolumeRatio", sql: "ALTER TABLE Configs ADD COLUMN minVolumeRatio FLOAT DEFAULT 1.3;" });
        await addColumnIfMissing({ column: "atrPeriod", sql: "ALTER TABLE Configs ADD COLUMN atrPeriod INTEGER DEFAULT 14;" });
        await addColumnIfMissing({ column: "riskRewardRatio", sql: "ALTER TABLE Configs ADD COLUMN riskRewardRatio FLOAT DEFAULT 1.6;" });
        await addColumnIfMissing({ column: "trailingEnabled", sql: "ALTER TABLE Configs ADD COLUMN trailingEnabled BOOLEAN DEFAULT 1;" });
        await addColumnIfMissing({ column: "trailingActivateATR", sql: "ALTER TABLE Configs ADD COLUMN trailingActivateATR FLOAT DEFAULT 1.5;" });
        await addColumnIfMissing({ column: "trailingOffsetATR", sql: "ALTER TABLE Configs ADD COLUMN trailingOffsetATR FLOAT DEFAULT 0.75;" });
        await addColumnIfMissing({ column: "entryRsiPeriod", sql: "ALTER TABLE Configs ADD COLUMN entryRsiPeriod INTEGER DEFAULT 14;" });
        await addColumnIfMissing({ column: "entryRsiLongThreshold", sql: "ALTER TABLE Configs ADD COLUMN entryRsiLongThreshold FLOAT DEFAULT 40;" });
        await addColumnIfMissing({ column: "entryRsiShortThreshold", sql: "ALTER TABLE Configs ADD COLUMN entryRsiShortThreshold FLOAT DEFAULT 60;" });
        await addColumnIfMissing({ column: "entryAdxPeriod", sql: "ALTER TABLE Configs ADD COLUMN entryAdxPeriod INTEGER DEFAULT 14;" });
        await addColumnIfMissing({ column: "entryAdxMax", sql: "ALTER TABLE Configs ADD COLUMN entryAdxMax FLOAT DEFAULT 32;" });
        await addColumnIfMissing({ column: "entryBbPeriod", sql: "ALTER TABLE Configs ADD COLUMN entryBbPeriod INTEGER DEFAULT 20;" });
        await addColumnIfMissing({ column: "entryBbStdDev", sql: "ALTER TABLE Configs ADD COLUMN entryBbStdDev FLOAT DEFAULT 2;" });
        await addColumnIfMissing({ column: "entryBbLongThreshold", sql: "ALTER TABLE Configs ADD COLUMN entryBbLongThreshold FLOAT DEFAULT 0.2;" });
        await addColumnIfMissing({ column: "entryBbShortThreshold", sql: "ALTER TABLE Configs ADD COLUMN entryBbShortThreshold FLOAT DEFAULT 0.8;" });

        for (const obsoleteColumn of obsoleteConfigColumns) {
            if (!columnNames.has(obsoleteColumn)) continue;
            try {
                await withSqliteBusyRetry(() => sequelize.query(`ALTER TABLE Configs DROP COLUMN ${obsoleteColumn};`));
                console.log(`[CONFIG][INFO] Dropped obsolete config column: ${obsoleteColumn}`);
            } catch (error) {
                console.warn(`[CONFIG][WARN] Could not drop obsolete config column ${obsoleteColumn}: ${error.message}`);
            }
        }
    };

    return {
        safeParseJSON,
        normalizeActivePositionState,
        normalizeConfig,
        hydrateConfig,
        serializeConfigForSave,
        getConfigRow,
        ensureConfigSchema
    };
};

module.exports = { createConfigModelHelpers };
