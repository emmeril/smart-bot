const test = require("node:test");
const assert = require("node:assert/strict");

const { createOrderExecutionHelpers } = require("../services/order-execution");

const createHelpers = ({ createOrderImpl, fetchOrderImpl, isHedgeModeEnabled = false, state = {} } = {}) => {
    const exchange = {
        markets: {
            "DOGE/USDT:USDT": {}
        },
        createOrder: createOrderImpl,
        fetchOrder: fetchOrderImpl,
        privatePostOrderOco: async (params) => {
            const tpOrder = {
                id: "tp-order-oco",
                amount: Number(params.quantity),
                price: Number(params.price),
                side: String(params.side).toLowerCase(),
                clientOrderId: params.limitClientOrderId,
                info: { clientOrderId: params.limitClientOrderId, origClientOrderId: params.limitClientOrderId }
            };
            const slOrder = {
                id: "sl-order-oco",
                amount: Number(params.quantity),
                stopPrice: Number(params.stopPrice),
                side: String(params.side).toLowerCase(),
                clientOrderId: params.stopClientOrderId,
                info: { clientOrderId: params.stopClientOrderId, origClientOrderId: params.stopClientOrderId, stopPrice: params.stopPrice }
            };
            state.openTpOrders = [tpOrder];
            state.openSlOrders = [slOrder];
            return {
                orderReports: [
                    { orderId: tpOrder.id, clientOrderId: tpOrder.clientOrderId, type: "LIMIT_MAKER", side: params.side, origQty: params.quantity, price: params.price },
                    { orderId: slOrder.id, clientOrderId: slOrder.clientOrderId, type: "STOP_LOSS_LIMIT", side: params.side, origQty: params.quantity, stopPrice: params.stopPrice }
                ]
            };
        }
    };

    return createOrderExecutionHelpers({
        getExchange: () => exchange,
        getMetrics: () => ({ api: { orders: 0 } }),
        getDb: () => ({ pair: "DOGE/USDT:USDT" }),
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
        fetchOpenTpOrders: async () => state.openTpOrders || [],
        fetchOpenSlOrders: async () => state.openSlOrders || [],
        matchesOrderToTrackedPosition: () => true,
        getOrderQuantity: (order) => order?.amount,
        getOrderTriggerPrice: (order) => order?.stopPrice ?? order?.info?.stopPrice ?? NaN,
        isManagedOrderPriceMatch: (a, b) => a === b,
        getPositionSyncQtyTolerance: () => 0.001,
        fetchSpotBalances: async () => ({ USDT: { free: 100 }, DOGE: { free: 1000 } }),
        getActivePositionByKey: (key) => state.activePositions?.[key] || null,
        upsertActivePosition: (position) => {
            state.activePositions = state.activePositions || {};
            state.activePositions[position.positionSide] = position;
        },
        saveDB: async () => { state.saveCount = (state.saveCount || 0) + 1; },
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

test("placeGridEntryOrder adopts a filled spot grid order into activePosition", async () => {
    const state = {};
    let createOrderCalls = 0;
    let fetchOrderCalls = 0;
    const helpers = createHelpers({
        state,
        createOrderImpl: async () => {
            createOrderCalls += 1;
            return { id: "unexpected-new-grid-order" };
        },
        fetchOrderImpl: async (_id, _symbol, params = {}) => {
            fetchOrderCalls += 1;
            if (fetchOrderCalls === 1) throw new Error("Order does not exist.");
            assert.equal(params.origClientOrderId, "smartgrid_buy_4_011");
            return {
                id: "filled-grid-1",
                status: "closed",
                side: "buy",
                amount: 10,
                filled: 10,
                average: 0.11,
                timestamp: 12345,
                info: { status: "FILLED", clientOrderId: "smartgrid_buy_4_011" }
            };
        }
    });

    const adopted = await helpers.placeGridEntryOrder({
        side: "buy",
        price: 0.11,
        orderSizeUsdt: 1.1,
        targetPrice: 0.12,
        stopLossPrice: 0.105,
        clientOrderId: "smartgrid_buy_4_011"
    });

    assert.equal(adopted, true);
    assert.equal(createOrderCalls, 0);
    assert.equal(state.saveCount, 3);
    assert.equal(state.activePositions.LONG.side, "buy");
    assert.equal(state.activePositions.LONG.entryPrice, 0.11);
    assert.equal(state.activePositions.LONG.quantity, 10);
    assert.equal(state.activePositions.LONG.positionSide, "LONG");
    assert.equal(state.activePositions.LONG.tpClientOrderId, "smarttp_old");
    assert.equal(state.activePositions.LONG.slClientOrderId, "smartsl_old");
});

test("ensureReduceOnlyTakeProfitOrder serializes concurrent OCO sync for the same spot position", async () => {
    const openTpOrders = [];
    const openSlOrders = [];
    let ocoCalls = 0;
    const serializedHelpers = createOrderExecutionHelpers({
        getExchange: () => ({
            markets: {
                "DOGE/USDT": { id: "DOGEUSDT" },
                "DOGE/USDT:USDT": { id: "DOGEUSDT" }
            },
            privatePostOrderOco: async (params) => {
                ocoCalls += 1;
                await new Promise((resolve) => setImmediate(resolve));
                const tpOrder = {
                    id: `tp-order-${ocoCalls}`,
                    amount: Number(params.quantity),
                    price: Number(params.price),
                    side: String(params.side).toLowerCase(),
                    clientOrderId: params.limitClientOrderId,
                    info: { clientOrderId: params.limitClientOrderId, origClientOrderId: params.limitClientOrderId }
                };
                const slOrder = {
                    id: `sl-order-${ocoCalls}`,
                    amount: Number(params.quantity),
                    stopPrice: Number(params.stopPrice),
                    side: String(params.side).toLowerCase(),
                    clientOrderId: params.stopClientOrderId,
                    info: { clientOrderId: params.stopClientOrderId, origClientOrderId: params.stopClientOrderId, stopPrice: params.stopPrice }
                };
                openTpOrders.push(tpOrder);
                openSlOrders.push(slOrder);
                return {
                    orderListId: `oco-${ocoCalls}`,
                    listClientOrderId: params.listClientOrderId,
                    orderReports: [
                        { orderId: tpOrder.id, clientOrderId: tpOrder.clientOrderId, type: "LIMIT_MAKER", side: params.side, origQty: params.quantity, price: params.price },
                        { orderId: slOrder.id, clientOrderId: slOrder.clientOrderId, type: "STOP_LOSS_LIMIT", side: params.side, origQty: params.quantity, stopPrice: params.stopPrice }
                    ]
                };
            }
        }),
        getMetrics: () => ({ api: { orders: 0 } }),
        getDb: () => ({ pair: "DOGE/USDT:USDT", marginMode: "spot" }),
        isHedgeModeEnabled: () => false,
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
        findOpenOrderByClientOrderId: async (clientOrderId) => [...openTpOrders, ...openSlOrders].find((order) => order.clientOrderId === clientOrderId) || null,
        isDuplicateClientOrderIdError: (error) => String(error?.message || "").includes("duplicated"),
        cancelOrderByClientOrderId: async () => false,
        syncPositionWithExchange: async () => {},
        getExchangeClientOrderId: (order) => order?.clientOrderId || order?.info?.clientOrderId || order?.info?.origClientOrderId || "",
        getTpClientOrderId: () => "smarttp_same",
        getSlClientOrderId: () => "smartsl_old",
        fetchOpenTpOrders: async () => openTpOrders,
        fetchOpenSlOrders: async () => openSlOrders,
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

    const position = {
        side: "buy",
        quantity: 10,
        targetPrice: 0.25,
        stopLossPrice: 0.2,
        positionSide: "BOTH",
        tpClientOrderId: "smarttp_same",
        slClientOrderId: "smartsl_same"
    };

    await Promise.all([
        serializedHelpers.ensureReduceOnlyTakeProfitOrder("BOTH", position),
        serializedHelpers.ensureReduceOnlyTakeProfitOrder("BOTH", position)
    ]);

    assert.equal(ocoCalls, 1);
    assert.equal(openTpOrders.length, 1);
    assert.equal(openSlOrders.length, 1);
});
