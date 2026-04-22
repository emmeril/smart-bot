const test = require("node:test");
const assert = require("node:assert/strict");

const { createVolatilityRiskHelpers } = require("../services/volatility-regime");

const toFiniteNumber = (value, fallback = NaN) => {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : fallback;
};

const calcATR = (highs, lows, closes, period) => {
    if (!Number.isFinite(period) || period <= 0 || closes.length <= period) return Array(closes.length).fill(null);
    const tr = Array(closes.length).fill(0);
    const atr = Array(closes.length).fill(null);
    for (let index = 1; index < closes.length; index += 1) {
        tr[index] = Math.max(
            highs[index] - lows[index],
            Math.abs(highs[index] - closes[index - 1]),
            Math.abs(lows[index] - closes[index - 1])
        );
    }
    let seed = 0;
    for (let index = 1; index <= period; index += 1) seed += tr[index];
    atr[period] = seed / period;
    for (let index = period + 1; index < closes.length; index += 1) {
        atr[index] = ((atr[index - 1] * (period - 1)) + tr[index]) / period;
    }
    return atr;
};

const buildCandles = ({ start = 100, count = 80, step = 1, range = 4 }) => (
    Array.from({ length: count }, (_, index) => {
        const price = start + (index * step);
        return [
            index * 60000,
            price - (step * 0.2),
            price + range,
            price - range,
            price,
            1000 + index
        ];
    })
);

test("resolveAdaptiveRiskOverrides widens trailing distance in elevated volatility regimes", async () => {
    const helper = createVolatilityRiskHelpers({
        toFiniteNumber,
        calcATR,
        fetchImpl: async () => ({
            ok: true,
            json: async () => ({
                chart: {
                    result: [{
                        timestamp: Array.from({ length: 180 }, (_, index) => 1700000000 + (index * 86400)),
                        indicators: {
                            quote: [{
                                open: Array.from({ length: 180 }, (_, index) => 100 + (index * 0.1)),
                                high: Array.from({ length: 180 }, (_, index) => 101 + (index * 0.1)),
                                low: Array.from({ length: 180 }, (_, index) => 99 + (index * 0.1)),
                                close: Array.from({ length: 180 }, (_, index) => 100 + (index * 0.1)),
                                volume: Array.from({ length: 180 }, () => 1000)
                            }]
                        }
                    }]
                }
            })
        })
    });

    const risk = await helper.resolveAdaptiveRiskOverrides({
        pair: "DOGE/USDT:USDT",
        timeframe: "5m",
        atrPeriod: 14,
        currentPrice: 150,
        currentATR: 8,
        localOhlcv: buildCandles({ start: 100, count: 120, step: 0.6, range: 10 }),
        baseActivateATR: 1.2,
        baseOffsetATR: 0.6
    });

    assert.equal(risk.trailingRiskModel, "ADAPTIVE_VOLATILITY");
    assert.ok(risk.trailingActivateATR > 1.2);
    assert.ok(risk.trailingOffsetATR > 0.6);
    assert.ok(risk.trailingActivateATR > risk.trailingOffsetATR);
});

test("resolveAdaptiveRiskOverrides falls back cleanly when there is not enough local data", async () => {
    const helper = createVolatilityRiskHelpers({
        toFiniteNumber,
        calcATR,
        fetchImpl: async () => {
            throw new Error("network unavailable");
        }
    });

    const risk = await helper.resolveAdaptiveRiskOverrides({
        pair: "DOGE/USDT:USDT",
        timeframe: "5m",
        atrPeriod: 14,
        currentPrice: NaN,
        currentATR: NaN,
        localOhlcv: [[1, 100, 101, 99, 100, 10]],
        baseActivateATR: 1.4,
        baseOffsetATR: 0.7
    });

    assert.equal(risk.trailingRiskModel, "STATIC_FALLBACK");
    assert.equal(risk.trailingActivateATR, 1.4);
    assert.equal(risk.trailingOffsetATR, 0.7);
});
