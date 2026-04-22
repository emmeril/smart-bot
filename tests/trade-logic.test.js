const test = require("node:test");
const assert = require("node:assert/strict");

const { createTradeLogicHelpers } = require("../services/trade-logic");

test("buildOrderPlan derives stop loss from actual position margin when auto size is enabled", () => {
    const db = {
        pair: "DOGE/USDT:USDT",
        leverage: 10,
        gridOrderSizeUsdt: 0,
        gridTargetProfitUsdt: 0.5,
        gridStopLossPercent: 5,
        trailingEnabled: true,
        trailingActivateATR: 1.2,
        trailingOffsetATR: 0.6,
        autoTargetProfitEnabled: false,
        autoStopLossEnabled: false
    };

    const helpers = createTradeLogicHelpers({
        getDb: () => db,
        toFiniteNumber: (value, fallback) => {
            const numericValue = Number(value);
            return Number.isFinite(numericValue) ? numericValue : fallback;
        },
        formatPriceToMarketPrecision: (_pair, price) => Number(Number(price).toFixed(4)),
        matchesOrderToTrackedPosition: () => false,
        getLastPnlLog: () => 0,
        setLastPnlLog: () => {},
        calcATR: () => []
    });

    const orderPlan = helpers.buildOrderPlan("buy", 100, 2, NaN, {}, {});

    assert.equal(orderPlan.stopLossUSDT, -1);
    assert.equal(orderPlan.stopLossPrice, 99.5);
    assert.equal(orderPlan.targetPrice, 100.25);
});
