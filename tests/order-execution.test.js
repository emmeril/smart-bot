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
        getDb: () => ({ pair: "DOGE/USDT:USDT", marginMode: "spot", ...(state.db || {}) }),
        isHedgeModeEnabled: () => isHedgeModeEnabled,
        toFiniteNumber: (value, fallback = NaN) => {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : fallback;
        },
        formatAmountToMarketPrecision: (_pair, amount) => amount,
        formatPriceToMarketPrecision: (_pair, price) => price,
        validateOrderSize: () => ({ valid: true }),
        getSignalParameters: () => state.signalParameters || ({
            gridLevels: 8,
            gridTakeProfitLevels: 1,
            gridStopLossLevels: 0,
            gridOrdersPerSide: 4,
            gridRangePercent: 5.2
        }),
        sanitizeGridState: (gridState) => gridState || null,
        findNearestGridLevelIndex: (_levels, entryPrice) => {
            if (typeof state.nearestGridIndex === "number") return state.nearestGridIndex;
            return entryPrice >= 0.1096 ? 6 : 5;
        },
        buildGridExitPlan: ({ entryIndex }) => {
            if (typeof state.buildGridExitPlan === "function") return state.buildGridExitPlan({ entryIndex });
            return entryIndex >= 6
                ? { targetPrice: 0.1111, stopLossPrice: 0.10606 }
                : { targetPrice: 0.11036, stopLossPrice: 0.10578 };
        },
        buildExchangeOrderParams: ({ side, reduceOnly = false, positionSide, closePosition = false } = {}) => ({
            side,
            reduceOnly,
            positionSide,
            closePosition
        }),
        getOrderPositionSide: (side) => {
            if (!isHedgeModeEnabled) return "BOTH";
            return side === "buy" ? "LONG" : "SHORT";
        },
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
        removeActivePositionByKey: (key) => {
            if (!state.activePositions) return;
            delete state.activePositions[key];
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
    assert.equal(state.activePositions.BOTH.side, "buy");
    assert.equal(state.activePositions.BOTH.entryPrice, 0.11);
    assert.equal(state.activePositions.BOTH.quantity, 10);
    assert.equal(state.activePositions.BOTH.positionSide, "BOTH");
    assert.equal(state.activePositions.BOTH.tpClientOrderId, "smarttp_old");
    assert.equal(state.activePositions.BOTH.slClientOrderId, "smartsl_old");
});

test("placeGridEntryOrder clears active spot position when filled SELL grid fully nets quantity", async () => {
    const state = {
        activePositions: {
            BOTH: {
                side: "buy",
                quantity: 10,
                entryPrice: 0.1,
                targetPrice: 0.12,
                stopLossPrice: 0.095,
                positionSide: "BOTH"
            }
        }
    };
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
            assert.equal(params.origClientOrderId, "smartgrid_sell_4_012");
            return {
                id: "filled-grid-sell-1",
                status: "closed",
                side: "sell",
                amount: 10,
                filled: 10,
                average: 0.12,
                timestamp: 12346,
                info: { status: "FILLED", clientOrderId: "smartgrid_sell_4_012" }
            };
        }
    });

    const adopted = await helpers.placeGridEntryOrder({
        side: "sell",
        price: 0.12,
        orderSizeUsdt: 1.2,
        targetPrice: 0.11,
        stopLossPrice: 0.125,
        clientOrderId: "smartgrid_sell_4_012"
    });

    assert.equal(adopted, true);
    assert.equal(createOrderCalls, 0);
    assert.equal(state.saveCount, 1);
    assert.equal(state.activePositions.BOTH, undefined);
});

test("placeGridEntryOrder recalculates scaled-in spot grid exits from active grid plan", async () => {
    const state = {
        db: {
            gridRecalculateExitsOnScaleIn: true,
            activeGridState: {
                lowerBound: 0.1044,
                upperBound: 0.1111,
                levels: [0.1044, 0.10578, 0.1068, 0.10782, 0.10883, 0.1096, 0.11036, 0.1111],
                step: 0.00076
            }
        },
        activePositions: {
            BOTH: {
                side: "buy",
                quantity: 24,
                entryPrice: 0.11036,
                targetPrice: 0.11661,
                stopLossPrice: 0.10771,
                stopLossUSDT: -0.0636,
                positionSide: "BOTH",
                trailingActivateATR: 1.2,
                trailingOffsetATR: 0.6
            }
        }
    };
    let fetchOrderCalls = 0;
    const helpers = createHelpers({
        state,
        createOrderImpl: async () => ({ id: "unexpected-new-grid-order" }),
        fetchOrderImpl: async (_id, _symbol, params = {}) => {
            fetchOrderCalls += 1;
            if (fetchOrderCalls === 1) throw new Error("Order does not exist.");
            assert.equal(params.origClientOrderId, "smartgrid_buy_5_01096");
            return {
                id: "filled-grid-2",
                status: "closed",
                side: "buy",
                amount: 10,
                filled: 10,
                average: 0.1096,
                timestamp: 12346,
                info: { status: "FILLED", clientOrderId: "smartgrid_buy_5_01096" }
            };
        }
    });

    const adopted = await helpers.placeGridEntryOrder({
        side: "buy",
        price: 0.1096,
        orderSizeUsdt: 1.096,
        targetPrice: 0.11036,
        stopLossPrice: 0.10578,
        clientOrderId: "smartgrid_buy_5_01096"
    });

    assert.equal(adopted, true);
    assert.equal(state.activePositions.BOTH.targetPrice, 0.1111);
    assert.equal(state.activePositions.BOTH.stopLossPrice, 0.10606);
    assert.ok(state.activePositions.BOTH.stopLossPrice < 0.10771);
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

test("placeGridEntryOrder serializes concurrent placement for the same clientOrderId", async () => {
    let createOrderCalls = 0;
    let maxInFlight = 0;
    let inFlight = 0;
    let openGridOrder = null;
    const helpers = createOrderExecutionHelpers({
        getExchange: () => ({
            markets: { "DOGE/USDT:USDT": {} },
            createOrder: async (_pair, _type, side, qty, price, params) => {
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                createOrderCalls += 1;
                await new Promise((resolve) => setTimeout(resolve, 25));
                const order = { id: `grid-order-${createOrderCalls}`, side, amount: qty, price, clientOrderId: params?.newClientOrderId, info: {} };
                openGridOrder = order;
                inFlight -= 1;
                return order;
            }
        }),
        getMetrics: () => ({ api: { orders: 0 } }),
        getDb: () => ({ pair: "DOGE/USDT:USDT", gridOrderSizeUsdt: 1.1 }),
        isHedgeModeEnabled: () => false,
        toFiniteNumber: (value, fallback = NaN) => {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : fallback;
        },
        formatAmountToMarketPrecision: (_pair, amount) => amount,
        formatPriceToMarketPrecision: (_pair, price) => price,
        validateOrderSize: () => ({ valid: true }),
        buildOrderPlan: () => ({}),
        buildExchangeOrderParams: ({ side } = {}) => ({ side }),
        getOrderPositionSide: (side) => side === "buy" ? "LONG" : "SHORT",
        getClosePositionSide: () => "BOTH",
        findOpenGridOrderByClientOrderId: async (clientOrderId) => (openGridOrder?.clientOrderId === clientOrderId ? openGridOrder : null),
        findOpenOrderByClientOrderId: async () => null,
        isDuplicateClientOrderIdError: (error) => String(error?.message || "").includes("duplicated"),
        cancelOrderByClientOrderId: async () => false,
        syncPositionWithExchange: async () => {},
        getExchangeClientOrderId: (order) => order?.clientOrderId || "",
        getTpClientOrderId: () => "smarttp_old",
        getSlClientOrderId: () => "smartsl_old",
        fetchOpenTpOrders: async () => [],
        fetchOpenSlOrders: async () => [],
        matchesOrderToTrackedPosition: () => true,
        getOrderQuantity: (order) => order?.amount,
        getOrderTriggerPrice: (order) => order?.stopPrice ?? NaN,
        isManagedOrderPriceMatch: (a, b) => a === b,
        getPositionSyncQtyTolerance: () => 0.001,
        fetchSpotBalances: async () => ({ USDT: { free: 100 }, DOGE: { free: 1000 } }),
        getActivePositionByKey: () => null,
        upsertActivePosition: () => {},
        saveDB: async () => {},
        cancelTpOrders: async () => {},
        cancelSlOrders: async () => {},
        buildReplacementClientOrderId: (clientOrderId) => `${clientOrderId}_new`
    });

    const orderPayload = {
        side: "buy",
        price: 0.11,
        orderSizeUsdt: 1.1,
        targetPrice: 0.12,
        stopLossPrice: 0.105,
        clientOrderId: "smartgrid_same_001"
    };

    const [left, right] = await Promise.all([
        helpers.placeGridEntryOrder(orderPayload),
        helpers.placeGridEntryOrder(orderPayload)
    ]);

    assert.equal(left, true);
    assert.equal(right, true);
    assert.equal(createOrderCalls, 1);
    assert.equal(maxInFlight, 1);
});

test("placeReduceOnlyTakeProfitOrder tolerates delayed duplicate visibility before replacement", async () => {
    let lookupCalls = 0;
    const delayedOrder = { id: "tp-delayed-1", clientOrderId: "smarttp_old", info: {} };
    const helpers = createOrderExecutionHelpers({
        getExchange: () => ({
            markets: { "DOGE/USDT:USDT": {} },
            createOrder: async () => { throw new Error("clientOrderId is duplicated"); }
        }),
        getMetrics: () => ({ api: { orders: 0 } }),
        getDb: () => ({ pair: "DOGE/USDT:USDT" }),
        isHedgeModeEnabled: () => false,
        toFiniteNumber: (value, fallback = NaN) => {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : fallback;
        },
        formatAmountToMarketPrecision: (_pair, amount) => amount,
        formatPriceToMarketPrecision: (_pair, price) => price,
        validateOrderSize: () => ({ valid: true }),
        buildOrderPlan: () => ({}),
        buildExchangeOrderParams: ({ side } = {}) => ({ side }),
        getOrderPositionSide: (side) => side === "buy" ? "LONG" : "SHORT",
        getClosePositionSide: () => "BOTH",
        findOpenGridOrderByClientOrderId: async () => null,
        findOpenOrderByClientOrderId: async () => {
            lookupCalls += 1;
            return lookupCalls >= 3 ? delayedOrder : null;
        },
        isDuplicateClientOrderIdError: (error) => String(error?.message || "").includes("duplicated"),
        cancelOrderByClientOrderId: async () => false,
        syncPositionWithExchange: async () => {},
        getExchangeClientOrderId: (order) => order?.clientOrderId || "",
        getTpClientOrderId: () => "smarttp_old",
        getSlClientOrderId: () => "smartsl_old",
        fetchOpenTpOrders: async () => [],
        fetchOpenSlOrders: async () => [],
        matchesOrderToTrackedPosition: () => true,
        getOrderQuantity: (order) => order?.amount,
        getOrderTriggerPrice: (order) => order?.stopPrice ?? NaN,
        isManagedOrderPriceMatch: (a, b) => a === b,
        getPositionSyncQtyTolerance: () => 0.001,
        fetchSpotBalances: async () => ({ USDT: { free: 100 }, DOGE: { free: 1000 } }),
        getActivePositionByKey: () => null,
        upsertActivePosition: () => {},
        saveDB: async () => {},
        cancelTpOrders: async () => {},
        cancelSlOrders: async () => {},
        buildReplacementClientOrderId: (clientOrderId) => `${clientOrderId}_new`
    });

    const reused = await helpers.placeReduceOnlyTakeProfitOrder({
        side: "buy",
        quantity: 10,
        targetPrice: 0.25,
        positionSide: "BOTH",
        tpClientOrderId: "smarttp_old"
    });

    assert.equal(reused?.id, "tp-delayed-1");
    assert.ok(lookupCalls >= 3);
});
