const test = require("node:test");
const assert = require("node:assert/strict");

const { createManagedOrdersHelpers } = require("../services/managed-orders");

test("fetchManagedOpenOrdersSnapshot preserves trigger-order fetch failures", async () => {
    const regularOrders = [
        {
            id: "grid-1",
            symbol: "DOGE/USDT:USDT",
            type: "limit",
            side: "buy",
            clientOrderId: "smartgrid_buy_1_100"
        },
        {
            id: "tp-1",
            symbol: "DOGE/USDT:USDT",
            type: "limit",
            side: "sell",
            clientOrderId: "smarttp_BOTH_sell_101"
        }
    ];

    const exchange = {
        fetchOpenOrders: async (_symbol, _since, _limit, params = {}) => {
            if (params && params.trigger) {
                throw new Error("trigger fetch unavailable");
            }
            return regularOrders;
        }
    };

    const helpers = createManagedOrdersHelpers({
        getExchange: () => exchange,
        getMetrics: () => ({ api: { orders: 0 } }),
        getDb: () => ({ pair: "DOGE/USDT:USDT" }),
        normalizeSymbol: (symbol) => String(symbol || "").toUpperCase(),
        getExchangeClientOrderId: (order) => String(order?.clientOrderId || ""),
        getOrderTriggerPrice: () => NaN,
        isGridEntryOrder: (order) => String(order?.clientOrderId || "").startsWith("smartgrid"),
        isTpReduceOnlyOrder: (order) => String(order?.clientOrderId || "").startsWith("smarttp"),
        isSlReduceOnlyOrder: (order) => String(order?.clientOrderId || "").startsWith("smartsl"),
        isTriggerManagedOrder: () => false,
        matchesOrderToTrackedPosition: () => false,
        getHasLoggedTriggerOrderFetchFallback: () => false,
        setHasLoggedTriggerOrderFetchFallback: () => {}
    });

    const snapshot = await helpers.fetchManagedOpenOrdersSnapshot();

    assert.equal(snapshot.triggerOrdersFetchFailed, true);
    assert.equal(snapshot.grid.length, 1);
    assert.equal(snapshot.tp.length, 1);
    assert.equal(snapshot.sl.length, 0);
});

test("fetchManagedOpenOrdersSnapshot retries Binance rate-limit responses", async () => {
    let regularCalls = 0;
    const exchange = {
        fetchOpenOrders: async (_symbol, _since, _limit, params = {}) => {
            if (params && params.trigger) return [];
            regularCalls += 1;
            if (regularCalls === 1) {
                const error = new Error('binance {"code":-1003,"msg":"Too much request weight used"}');
                error.status = 429;
                error.headers = { "Retry-After": "0.001" };
                throw error;
            }
            return [
                {
                    id: "grid-1",
                    symbol: "DOGE/USDT:USDT",
                    type: "limit",
                    side: "buy",
                    clientOrderId: "smartgrid_buy_1_100"
                }
            ];
        }
    };

    const helpers = createManagedOrdersHelpers({
        getExchange: () => exchange,
        getMetrics: () => ({ api: { orders: 0 } }),
        getDb: () => ({ pair: "DOGE/USDT:USDT" }),
        normalizeSymbol: (symbol) => String(symbol || "").toUpperCase(),
        getExchangeClientOrderId: (order) => String(order?.clientOrderId || ""),
        getOrderTriggerPrice: () => NaN,
        isGridEntryOrder: (order) => String(order?.clientOrderId || "").startsWith("smartgrid"),
        isTpReduceOnlyOrder: (order) => String(order?.clientOrderId || "").startsWith("smarttp"),
        isSlReduceOnlyOrder: (order) => String(order?.clientOrderId || "").startsWith("smartsl"),
        isTriggerManagedOrder: () => false,
        matchesOrderToTrackedPosition: () => false,
        getHasLoggedTriggerOrderFetchFallback: () => false,
        setHasLoggedTriggerOrderFetchFallback: () => {}
    });

    const snapshot = await helpers.fetchManagedOpenOrdersSnapshot();

    assert.equal(regularCalls, 2);
    assert.equal(snapshot.triggerOrdersFetchFailed, false);
    assert.equal(snapshot.grid.length, 1);
});
