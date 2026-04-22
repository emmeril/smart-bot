const test = require("node:test");
const assert = require("node:assert/strict");

const { createPnlTrackerHelpers } = require("../services/pnl-tracker");

test("syncDailyPnlWithExchange reconciles realized pnl and fees into the shared daily snapshot", async () => {
    const db = {
        pair: "DOGE/USDT:USDT",
        dailyPnL: 12,
        dailyTrades: 2,
        dailyPnlSource: "local",
        dailyPnlSyncedAt: 0,
        lastDailyReset: 1000
    };
    let saveCalls = 0;

    const helpers = createPnlTrackerHelpers({
        getDb: () => db,
        getExchange: () => ({
            has: { fetchMyTrades: true },
            fetchMyTrades: async () => ([
                { timestamp: 1500, info: { realizedPnl: "4.5", commission: "0.1" } },
                { timestamp: 1600, realizedPnl: 2, fee: { cost: 0.05 } }
            ])
        }),
        toFiniteNumber: (value, fallback = 0) => {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : fallback;
        },
        saveDB: async () => { saveCalls += 1; }
    });

    const snapshot = await helpers.syncDailyPnlWithExchange({ force: true });

    assert.ok(Math.abs(snapshot.dailyPnL - 6.35) < 1e-9);
    assert.equal(snapshot.dailyTrades, 2);
    assert.equal(snapshot.dailyPnlSource, "exchange");
    assert.ok(snapshot.dailyPnlSyncedAt > 0);
    assert.ok(Math.abs(db.dailyPnL - 6.35) < 1e-9);
    assert.equal(db.dailyTrades, 2);
    assert.equal(db.dailyPnlSource, "exchange");
    assert.equal(saveCalls, 1);
});

test("resetDailyPnlState clears the shared daily snapshot for a new day", async () => {
    const db = {
        dailyPnL: 8.5,
        dailyTrades: 3,
        dailyPnlSource: "exchange",
        dailyPnlSyncedAt: 123,
        lastDailyReset: 456
    };

    const helpers = createPnlTrackerHelpers({
        getDb: () => db,
        getExchange: () => null,
        toFiniteNumber: (value, fallback = 0) => {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : fallback;
        },
        saveDB: async () => {}
    });

    const snapshot = await helpers.resetDailyPnlState(999);

    assert.equal(snapshot.dailyPnL, 0);
    assert.equal(snapshot.dailyTrades, 0);
    assert.equal(snapshot.dailyPnlSource, "reset");
    assert.equal(snapshot.dailyPnlSyncedAt, 999);
    assert.equal(db.lastDailyReset, 999);
});
