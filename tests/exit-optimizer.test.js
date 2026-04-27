const test = require("node:test");
const assert = require("node:assert/strict");

const {
    buildLiquiditySnapshot,
    buildRegimeSnapshot,
    optimizeExitProfile,
    resolveOptimalExit
} = require("../services/exit-optimizer");

const buildTrendCandles = ({
    start = 100,
    count = 120,
    drift = 0.4,
    noise = 0.3
}) => (
    Array.from({ length: count }, (_, index) => {
        const close = start + (index * drift) + (Math.sin(index / 4) * noise);
        return [
            index * 60000,
            close - 0.2,
            close + 0.8,
            close - 0.8,
            close,
            1000 + (index * 5)
        ];
    })
);

test("optimizeExitProfile finds a profitable TP/SL candidate across datasets", () => {
    const fastTrend = buildTrendCandles({ start: 100, count: 120, drift: 0.45, noise: 0.15 });
    const slowTrend = buildTrendCandles({ start: 50, count: 140, drift: 0.2, noise: 0.1 });

    const result = optimizeExitProfile({
        datasets: [
            {
                asset: "BTC/USDT",
                timeframe: "5m",
                candles: fastTrend,
                entries: [{ entryIndex: 20, side: "long" }, { entryIndex: 45, side: "long" }, { entryIndex: 70, side: "long" }]
            },
            {
                asset: "ETH/USDT",
                timeframe: "15m",
                candles: slowTrend,
                entries: [{ entryIndex: 25, side: "long" }, { entryIndex: 60, side: "long" }, { entryIndex: 95, side: "long" }]
            }
        ],
        candidateOverrides: {
            tpAtrMultipliers: [1, 1.5, 2, 2.5],
            slAtrMultipliers: [0.75, 1, 1.25],
            trailingActivateATR: [1, 1.5],
            trailingOffsetATR: [0.5, 0.75]
        }
    });

    assert.ok(result.best);
    assert.ok(result.best.totalTrades >= 6);
    assert.ok(result.best.profitFactor > 1);
    assert.ok(result.best.rewardRisk > 1);
});

test("resolveOptimalExit widens the stop during liquidity-stressed volatility spikes", () => {
    const candles = buildTrendCandles({ start: 100, count: 60, drift: 0.1, noise: 0.6 });
    const regime = buildRegimeSnapshot({ candles, atrPeriod: 14, meanWindow: 20, stdDevWindow: 20 });
    const liquiditySnapshot = buildLiquiditySnapshot({
        currentPrice: 105,
        orderBook: {
            bids: [[104.9, 10], [104.8, 8]],
            asks: [[105.1, 2], [105.2, 2]]
        },
        trades: [
            { side: "buy", size: 8 },
            { side: "buy", size: 6 },
            { side: "sell", size: 2 }
        ]
    });

    const calm = resolveOptimalExit({
        side: "long",
        entryPrice: 100,
        currentPrice: 105,
        currentATR: regime.currentATR,
        optimizationResult: { candidate: { tpAtr: 2, slAtr: 1.2, trailingActivateATR: 1.5, trailingOffsetATR: 0.75 } },
        regime,
        liquiditySnapshot,
        orderFlow: {
            orderFlowImbalance: 0.1,
            absorptionScore: 0.2,
            shortHorizonATR: regime.currentATR,
            mediumHorizonATR: regime.currentATR
        }
    });

    const stressed = resolveOptimalExit({
        side: "long",
        entryPrice: 100,
        currentPrice: 105,
        currentATR: regime.currentATR,
        optimizationResult: { candidate: { tpAtr: 2, slAtr: 1.2, trailingActivateATR: 1.5, trailingOffsetATR: 0.75 } },
        regime,
        liquiditySnapshot,
        orderFlow: {
            orderFlowImbalance: 0.45,
            absorptionScore: 0.8,
            shortHorizonATR: regime.currentATR * 2,
            mediumHorizonATR: regime.currentATR
        }
    });

    assert.ok(stressed.stopPrice < calm.stopPrice);
    assert.ok(stressed.spikeProtectionFactor > 1);
    assert.ok(stressed.rewardRiskRatio < calm.rewardRiskRatio);
});
