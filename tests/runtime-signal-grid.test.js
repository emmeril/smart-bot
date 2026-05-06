const test = require("node:test");
const assert = require("node:assert/strict");

const { createRuntimeSignalGridHelpers } = require("../services/runtime-signal-grid");

const createHelpers = ({
    fetchOpenExchangePositionsImpl,
    getActivePositionsListImpl = () => [],
    placeGridEntryOrderImpl = async () => true,
    cancelGridOrdersImpl = async () => {}
} = {}) => {
    let syncing = false;
    const state = {
        placeCalls: 0,
        cancelCalls: 0
    };

    const helpers = createRuntimeSignalGridHelpers({
        getDb: () => ({ strategy: "spot_grid", pair: "DOGE/USDT:USDT" }),
        getAccountPositionMode: () => ({ label: "ONE_WAY" }),
        getExchange: () => ({ markets: { "DOGE/USDT:USDT": {} } }),
        getIsSyncingGridOrders: () => syncing,
        setIsSyncingGridOrders: (value) => { syncing = value; },
        getLastGridSyncLogAt: () => 0,
        setLastGridSyncLogAt: () => {},
        getLastGridExposureLogAt: () => 0,
        setLastGridExposureLogAt: () => {},
        getLastGridExposureLogKey: () => "",
        setLastGridExposureLogKey: () => {},
        getLastGridSizingSkipLogAt: () => 0,
        setLastGridSizingSkipLogAt: () => {},
        getLastGridSizingSkipReason: () => "",
        setLastGridSizingSkipReason: () => {},
        getGridSizingStateLogCache: () => new Map(),
        signalDetailLogTtl: 10000,
        gridSyncLogTtl: 10000,
        gridSizingSkipLogTtl: 10000,
        gridSizingStateLogTtl: 10000,
        toFiniteNumber: (value, fallback = NaN) => {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : fallback;
        },
        clamp: (value, min, max) => Math.min(Math.max(value, min), max),
        resolveEffectiveGridTakeProfitLevels: () => 1,
        resolveEffectiveGridStopLossSteps: () => 1,
        sanitizeGridState: (state) => state,
        createLockedGridState: (snapshot) => snapshot,
        buildGridExitPlan: () => ({ targetPrice: 101, stopLossPrice: 99, stopLossSteps: 1 }),
        isDirectionalOrderPlanValid: () => true,
        getSignalParameters: () => ({
            neededCandles: 3,
            gridOrderSizeUsdt: 5,
            gridOrdersPerSide: 1,
            gridLevels: 4
        }),
        getOHLCV: async () => [[1], [2], [3]],
        buildSignalSnapshot: () => ({
            currentPrice: 100,
            invalidAtr: false
        }),
        evaluateCrossoverSignal: () => ({}),
        getSignalCount: () => 0,
        setSignalCount: () => {},
        getMetrics: () => ({
            signals: { analyzed: 0, crossoverDetected: 0, longConfirmed: 0, shortConfirmed: 0 }
        }),
        getLastLogTime: () => Date.now(),
        setLastLogTime: () => {},
        getLastSignalDetailLogAt: () => Date.now(),
        setLastSignalDetailLogAt: () => {},
        buildRiskOverrides: () => ({}),
        resolveEffectiveGridOrderSizeUsdt: () => ({ orderSizeUsdt: 5, mode: "MANUAL" }),
        resolveEffectiveGridOrdersPerSide: () => ({ count: 1, maxConfigured: 1, mode: "MANUAL", reason: "" }),
        fetchOpenGridOrders: async () => [],
        cancelDuplicateManagedOrders: async (orders) => orders,
        cancelGridOrders: async (orders, reason) => {
            state.cancelCalls += 1;
            await cancelGridOrdersImpl(orders, reason);
        },
        getAvailableUSDTBalance: async () => 100,
        maybeLogGridSizingStateExternal: null,
        fetchOpenExchangePositions: async () => await fetchOpenExchangePositionsImpl(),
        getActivePositionsList: () => getActivePositionsListImpl(),
        resolveActiveGridState: async () => ({
            lowerBound: 95,
            upperBound: 105,
            referencePrice: 100,
            levels: [95, 97.5, 100, 102.5, 105],
            step: 2.5
        }),
        buildGridEntryOrders: () => [{ side: "buy", clientOrderId: "smartgrid_buy_1_100", price: 100 }],
        filterGridOrdersForActiveExposure: (orders) => orders,
        getExchangeClientOrderId: (order) => order.clientOrderId,
        placeGridEntryOrder: async (order) => {
            state.placeCalls += 1;
            return await placeGridEntryOrderImpl(order);
        },
        isHedgeModeEnabled: () => false,
        hasAnyActivePosition: () => false,
        getActivePositionByKey: () => null,
        placeOrder: async () => {}
    });

    return { helpers, state };
};

test("syncGridOrders aborts when exposure changes during planning", async () => {
    let fetchCalls = 0;
    const { helpers, state } = createHelpers({
        fetchOpenExchangePositionsImpl: async () => {
            fetchCalls += 1;
            return fetchCalls === 1 ? [] : [{ side: "buy", contracts: 1 }];
        }
    });

    await helpers.syncGridOrders();

    assert.equal(state.cancelCalls, 0);
    assert.equal(state.placeCalls, 0);
});

test("syncGridOrders places ladder orders when exposure remains stable", async () => {
    const { helpers, state } = createHelpers({
        fetchOpenExchangePositionsImpl: async () => []
    });

    await helpers.syncGridOrders();

    assert.equal(state.cancelCalls, 0);
    assert.equal(state.placeCalls, 1);
});
