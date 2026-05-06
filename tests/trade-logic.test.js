const test = require("node:test");
const assert = require("node:assert/strict");

const { createTradeLogicHelpers } = require("../services/trade-logic");

test("buildOrderPlan derives stop loss from actual position margin when auto size is enabled", () => {
    const db = {
        pair: "DOGE/USDT",
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

    assert.equal(orderPlan.stopLossUSDT, -10);
    assert.equal(orderPlan.stopLossPrice, 95);
    assert.equal(orderPlan.targetPrice, 100.25);
});

test("buildOrderPlan normalizes ATR stop distance and reward-risk target across assets", () => {
    const db = {
        pair: "BTC/USDT",
        gridOrderSizeUsdt: 0,
        gridTargetProfitUsdt: 0.5,
        gridStopLossPercent: 5,
        trailingEnabled: true,
        trailingActivateATR: 1.5,
        trailingOffsetATR: 0.75,
        autoTargetProfitEnabled: true,
        autoStopLossEnabled: true,
        stopLossAtrMultiplier: 1.5,
        stopLossMinPercent: 2,
        stopLossMaxPercent: 40,
        targetProfitAtrMultiplier: 1.2,
        targetProfitMinUsdt: 0.25,
        targetProfitMaxUsdt: 10,
        riskRewardRatio: 2
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

    const orderPlan = helpers.buildOrderPlan("buy", 100, 1, 2, {}, {});

    assert.equal(orderPlan.stopLossMode, "AUTO_ATR");
    assert.equal(orderPlan.targetProfitMode, "AUTO_RR_ATR");
    assert.equal(orderPlan.stopLossPrice, 95);
    assert.equal(orderPlan.targetPrice, 110);
    assert.equal(orderPlan.stopLossUSDT, -5);
    assert.equal(orderPlan.targetProfitUSDT, 10);
});

test("buildOrderPlan uses optimization context when provided by the live signal", () => {
    const db = {
        pair: "BTC/USDT:USDT",
        gridOrderSizeUsdt: 0,
        gridTargetProfitUsdt: 0.5,
        gridStopLossPercent: 5,
        trailingEnabled: true,
        trailingActivateATR: 1.5,
        trailingOffsetATR: 0.75,
        autoTargetProfitEnabled: true,
        autoStopLossEnabled: true,
        stopLossAtrMultiplier: 1.2,
        stopLossMinPercent: 2,
        stopLossMaxPercent: 40,
        targetProfitAtrMultiplier: 2,
        targetProfitMinUsdt: 0.25,
        targetProfitMaxUsdt: 10,
        riskRewardRatio: 2
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

    const orderPlan = helpers.buildOrderPlan("buy", 100, 1, 2, {}, {
        exitOptimization: {
            enabled: true,
            currentPrice: 101,
            candidate: {
                tpAtr: 2.5,
                slAtr: 1,
                trailingActivateATR: 1.8,
                trailingOffsetATR: 0.9
            },
            regime: {
                zScore: -0.5,
                volatilityPercentile: 0.7
            },
            liquiditySnapshot: {
                spreadBps: 8,
                depthImbalance: 0.15,
                marketImpactBps: 10
            },
            orderFlow: {
                orderFlowImbalance: 0.3,
                absorptionScore: 0.8,
                shortHorizonATR: 3,
                mediumHorizonATR: 2
            }
        }
    });

    assert.equal(orderPlan.stopLossMode, "OPTIMIZED_EXIT");
    assert.equal(orderPlan.targetProfitMode, "OPTIMIZED_EXIT");
    assert.ok(orderPlan.targetPrice > 100);
    assert.ok(orderPlan.stopLossPrice < 100);
    assert.ok(orderPlan.targetProfitUSDT > Math.abs(orderPlan.stopLossUSDT));
});
