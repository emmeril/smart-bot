const test = require("node:test");
const assert = require("node:assert/strict");

const { createTechnicalIndicatorHelpers } = require("../services/technical-indicators");

const toFiniteNumber = (value, fallback) => {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : fallback;
};

const calcATR = (high, low, close, period) => {
    const output = Array(close.length).fill(null);
    for (let index = Number(period); index < close.length; index += 1) {
        output[index] = high[index] - low[index];
    }
    return output;
};

const helpers = createTechnicalIndicatorHelpers({ toFiniteNumber, calcATR });

test("technical indicators calculate rolling averages and bands", () => {
    assert.deepEqual(helpers.calcSMA([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);

    const ema = helpers.calcEMA([1, 2, 3, 4], 2);
    assert.equal(ema[1], 1.5);
    assert.equal(Number(ema[3].toFixed(4)), 3.5);

    const bands = helpers.calcBollingerBands([1, 2, 3, 4], 2, 2);
    assert.deepEqual(bands.basis, [null, 1.5, 2.5, 3.5]);
    assert.equal(bands.upper[3], 4.5);
    assert.equal(bands.lower[3], 2.5);
});

test("technical indicators expose a complete signal snapshot context", () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    const candles = Array.from({ length: 35 }, (_, index) => {
        const open = 100 + index;
        return [
            start + (index * 60_000),
            open,
            open + 3,
            open - 2,
            open + 1,
            1000 + (index * 10)
        ];
    });

    const snapshot = helpers.getSignalSnapshotContext(candles, {
        atrPeriod: 14,
        volumePeriod: 5,
        entryRsiPeriod: 14,
        entryAdxPeriod: 14,
        entryBbPeriod: 20,
        entryBbStdDev: 2
    });

    assert.equal(snapshot.lastIndex, 33);
    assert.equal(snapshot.currentPrice, 134);
    assert.equal(snapshot.currentATR, 5);
    assert.equal(snapshot.currentNatrPercent, (5 / 134) * 100);
    assert.ok(Number.isFinite(snapshot.currentRsi));
    assert.ok(Number.isFinite(snapshot.bbWidth));
    assert.ok(Number.isFinite(snapshot.macdHistogram));
});
