const test = require("node:test");
const assert = require("node:assert/strict");

const { createOrderExecutionHelpers } = require("../services/order-execution");

const createHelpers = ({ createOrderImpl, isHedgeModeEnabled = false } = {}) => {
    const exchange = {
        markets: {
            "DOGE/USDT:USDT": {}
        },
        createOrder: createOrderImpl
    };

    return createOrderExecutionHelpers({
        getExchange: () => exchange,
        getMetrics: () => ({ api: { orders: 0 } }),
        getDb: () => ({ pair: "DOGE/USDT:USDT", leverage: 10 }),
        isHedgeModeEnabled: () => isHedgeModeEnabled,
        toFiniteNumber: (value, fallback = NaN) => {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : fallback;
        },
        formatAmountToMarketPrecision: (_pair, amount) => amount,
        formatPriceToMarketPrecision: (_pair, price) => price,
        validateOrderSize: () => ({ valid: true }),
        buildExchangeOrderParams: ({ side, reduceOnly = false, positionSide, closePosition = false } = {}) => ({
            side,
            reduceOnly,
            positionSide,
            closePosition
        }),
        getOrderPositionSide: (side) => side === "buy" ? "LONG" : "SHORT",
        getClosePositionSide: (position) => position.positionSide || "BOTH",
        findOpenGridOrderByClientOrderId: async () => null,
        findOpenOrderByClientOrderId: async () => null,
        isDuplicateClientOrderIdError: (error) => String(error?.message || "").includes("duplicated"),
        cancelOrderByClientOrderId: async () => false,
        syncPositionWithExchange: async () => {},
        getExchangeClientOrderId: (order) => order?.clientOrderId || order?.info?.clientOrderId || order?.info?.origClientOrderId || "",
        getTpClientOrderId: () => "smarttp_old",
        getSlClientOrderId: () => "smartsl_old",
        fetchOpenTpOrders: async () => [],
        fetchOpenSlOrders: async () => [],
        matchesOrderToTrackedPosition: () => true,
        getOrderQuantity: (order) => order?.amount,
        getOrderTriggerPrice: (order) => order?.stopPrice ?? order?.info?.stopPrice ?? NaN,
        isManagedOrderPriceMatch: (a, b) => a === b,
        getPositionSyncQtyTolerance: () => 0.001,
        upsertActivePosition: () => {},
        saveDB: async () => {},
        cancelTpOrders: async () => {},
        cancelSlOrders: async () => {},
        buildReplacementClientOrderId: (clientOrderId) => `${clientOrderId}_new`
    });
};

test("placeReduceOnlyTakeProfitOrder preserves replacement clientOrderId when exchange response omits it", async () => {
    let attempts = 0;
    const helpers = createHelpers({
        createOrderImpl: async (_pair, _type, _side, _qty, _price, params) => {
            attempts += 1;
            if (attempts === 1) {
                const error = new Error("clientOrderId is duplicated");
                throw error;
            }
            assert.equal(params.newClientOrderId, "smarttp_old_new");
            return { id: "tp-order-1", info: {} };
        }
    });

    const order = await helpers.placeReduceOnlyTakeProfitOrder({
        side: "buy",
        quantity: 10,
        targetPrice: 0.25,
        positionSide: "BOTH",
        tpClientOrderId: "smarttp_old"
    });

    assert.equal(order.clientOrderId, "smarttp_old_new");
    assert.equal(order.info.clientOrderId, "smarttp_old_new");
    assert.equal(order.info.origClientOrderId, "smarttp_old_new");
});

test("placeReduceOnlyStopLossOrder preserves replacement clientOrderId when exchange response omits it", async () => {
    let attempts = 0;
    const helpers = createHelpers({
        createOrderImpl: async (_pair, _type, _side, _qty, _price, params) => {
            attempts += 1;
            if (attempts === 1) {
                const error = new Error("clientOrderId is duplicated");
                throw error;
            }
            assert.equal(params.newClientOrderId, "smartsl_old_new");
            return { id: "sl-order-1", info: {} };
        }
    });

    const order = await helpers.placeReduceOnlyStopLossOrder({
        side: "buy",
        quantity: 10,
        stopLossPrice: 0.2,
        positionSide: "BOTH",
        slClientOrderId: "smartsl_old"
    });

    assert.equal(order.clientOrderId, "smartsl_old_new");
    assert.equal(order.info.clientOrderId, "smartsl_old_new");
    assert.equal(order.info.origClientOrderId, "smartsl_old_new");
});
