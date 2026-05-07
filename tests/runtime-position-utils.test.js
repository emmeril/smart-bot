const test = require("node:test");
const assert = require("node:assert/strict");

const { createRuntimePositionUtils } = require("../services/runtime-position-utils");

test("fetchOpenExchangePositions skips futures position endpoint in spot mode", async () => {
    let fetchPositionsCalled = false;
    const helpers = createRuntimePositionUtils({
        getDb: () => ({ pair: "DOGE/USDT", marginMode: "spot" }),
        getExchange: () => ({
            options: { defaultType: "spot" },
            fetchPositions: async () => {
                fetchPositionsCalled = true;
                throw new Error("fetchPositions should not be called for spot mode");
            }
        }),
        getMetrics: () => ({ api: { positions: 0 } }),
        isHedgeModeEnabled: () => false,
        getOrderPositionSide: () => "BOTH",
        normalizeSymbol: (symbol) => String(symbol || "").toUpperCase(),
        getExchangePositionContracts: () => 0,
        toFiniteNumber: (value, fallback = NaN) => {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : fallback;
        },
        saveDB: async () => {},
        getLastPositionRuntimePersistAt: () => 0,
        setLastPositionRuntimePersistAt: () => {},
        positionRuntimePersistTtl: 2000,
        getPrice: async () => 100,
        getActivePositionEntries: () => [],
        fetchManagedOpenOrdersSnapshot: async () => ({ grid: [], tp: [], sl: [] }),
        getGridRuntimeSummary: () => ({
            presetName: "universal",
            gridLevelsMode: "MANUAL",
            effectiveGridLevels: 8,
            gridRangeMode: "MANUAL",
            effectiveGridRangePercent: 4,
            gridEntryBufferMode: "MANUAL",
            effectiveGridEntryBufferPercent: 0.1,
            slotLabel: "N/A",
            ladderLabel: "0 buy / 0 sell",
            ordersMode: "MANUAL",
            effectiveOrdersPerSide: 0,
            configuredOrdersPerSideCap: 0,
            sizeMode: "MANUAL",
            effectiveOrderSizeUsdt: 5,
            minOrderSizeUsdt: 5,
            availableUsdtLabel: "100.00",
            hasLockedGrid: false
        }),
        getExchangeRecoveryReason: () => "",
        getAccountPositionMode: () => ({ label: "SPOT" }),
        getIsPlacingOrder: () => false,
        getIsClosingPosition: () => false,
        getIsSyncingPosition: () => false,
        getIsSyncingGridOrders: () => false,
        getExchangeHealth: () => ({ isHealthy: true, needsRecoverySync: false }),
        getLastTradeAt: () => 0,
        formatStatusTimestamp: () => "N/A",
        printStatusLine: () => {},
        printOrderSample: () => {},
        printPositionLine: () => {}
    });

    const positions = await helpers.fetchOpenExchangePositions();

    assert.deepEqual(positions, []);
    assert.equal(fetchPositionsCalled, false);
});
