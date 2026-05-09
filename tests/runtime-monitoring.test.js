const test = require("node:test");
const assert = require("node:assert/strict");

const { createRuntimeMonitoringHelpers } = require("../services/runtime-monitoring");

test("shutdown waits for in-flight grid sync before closing resources", async () => {
    let isShuttingDown = false;
    let isSyncingGridOrders = true;
    const callOrder = [];

    setTimeout(() => {
        isSyncingGridOrders = false;
    }, 250);

    const helpers = createRuntimeMonitoringHelpers({
        getDb: () => ({}),
        toFiniteNumber: (value, fallback = 0) => {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : fallback;
        },
        configureRecurringTask: () => {},
        getPnLMonitorTimer: () => null,
        setPnLMonitorTimer: () => {},
        getCurrentPnLMonitoringInterval: () => 0,
        setCurrentPnLMonitoringInterval: () => {},
        getIsMonitoringPnL: () => false,
        setIsMonitoringPnL: () => {},
        hasAnyActivePosition: () => false,
        getIsClosingPosition: () => false,
        getIsSyncingPosition: () => false,
        getIsPlacingOrder: () => false,
        getIsSyncingGridOrders: () => isSyncingGridOrders,
        getPrice: async () => null,
        fetchManagedOpenOrdersSnapshot: async () => ({}),
        getActivePositionEntries: () => [],
        snapshotPositionRuntimeState: () => ({}),
        updateActivePositionExtremes: () => {},
        applyTrailingStopUpdate: () => {},
        didPositionRuntimeStateChange: () => false,
        upsertActivePosition: () => {},
        maybePersistActivePositionRuntimeState: async () => {},
        ensureReduceOnlyStopLossOrder: async () => {},
        calculatePositionPnL: () => ({}),
        evaluatePositionExit: () => ({ shouldClose: false }),
        closePosition: async () => {},
        maybeLogPositionPnL: () => {},
        getPositionSyncTimer: () => null,
        setPositionSyncTimer: () => {},
        getCurrentPositionSyncInterval: () => 0,
        setCurrentPositionSyncInterval: () => {},
        syncPositionWithExchange: async () => {},
        saveDB: async () => { callOrder.push("saveDB"); },
        sleep: async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)),
        clearRuntimeTimers: () => { callOrder.push("clearRuntimeTimers"); },
        closeWebServer: async () => { callOrder.push("closeWebServer"); },
        clearWebServer: () => { callOrder.push("clearWebServer"); },
        closeSequelize: async () => { callOrder.push("closeSequelize"); },
        getWebServer: () => null,
        getIsShuttingDown: () => isShuttingDown,
        setIsShuttingDown: (value) => { isShuttingDown = value; },
        getIsPlacingOrderState: () => false,
        getIsClosingPositionState: () => false,
        unregisterRuntimeCommands: () => { callOrder.push("unregisterRuntimeCommands"); },
        exitProcess: () => { callOrder.push("exitProcess"); }
    });

    const startedAt = Date.now();
    await helpers.shutdown("TEST");
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs >= 200, "shutdown should wait until grid sync clears");
    assert.deepEqual(callOrder, [
        "unregisterRuntimeCommands",
        "clearRuntimeTimers",
        "saveDB",
        "closeSequelize",
        "exitProcess"
    ]);
});
