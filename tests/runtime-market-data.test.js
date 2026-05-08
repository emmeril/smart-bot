const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createRuntimeMarketDataHelpers } = require("../services/runtime-market-data");

const createHelpers = (logPath) => createRuntimeMarketDataHelpers({
    getExchange: () => null,
    getDb: () => ({ pair: "BTC/USDT", gridTimeframe: "5m", marginMode: "spot", gridStopLossPercent: 1 }),
    getMetrics: () => ({ api: { ticker: 0, ohlcv: 0, balance: 0 } }),
    getBalanceCache: () => ({ totalUSDT: 0, availableUSDT: 0, lastUpdate: 0 }),
    setBalanceCache: () => {},
    getTickerCache: () => ({ price: 0, lastUpdate: 0 }),
    setTickerCache: () => {},
    getOhlcvCache: () => ({ key: "", data: [], lastUpdate: 0 }),
    setOhlcvCache: () => {},
    retry: async (fn) => fn(),
    toFiniteNumber: (value, fallback = 0) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    },
    ensureFileExists: () => {},
    logPath,
    getPrimaryActivePosition: () => null,
    setLastTradeAt: () => {},
    balanceCacheTtl: 1000,
    tickerCacheTtl: 1000,
    ohlcvCacheTtl: 1000,
    getExchangeClientOrderId: () => "",
    getOrderQuantity: () => 0,
    getOrderTriggerPrice: () => 0
});

const withTempLog = async (content, fn) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-market-data-"));
    const filePath = path.join(tempDir, "log.csv");
    fs.writeFileSync(filePath, content, "utf8");
    try {
        await fn(filePath);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
};

test("getLastTradeTimestampFromLog returns the newest valid timestamp from log tail", async () => {
    const older = "2026-05-01T00:00:00.000Z";
    const newest = "2026-05-08T12:00:00.000Z";
    await withTempLog(
        [
            "timestamp,pair,side,entry,exit,status,pnl,trade_mode,stop_loss_percent,strategy",
            `${older},BTC/USDT,BUY,1,2,PROFIT,1,SPOT,1,STRAT`,
            "invalid-line-without-date",
            `${newest},BTC/USDT,SELL,2,1,LOSS,-1,SPOT,1,STRAT`,
            ""
        ].join("\n"),
        async (filePath) => {
            const helpers = createHelpers(filePath);
            const timestamp = helpers.getLastTradeTimestampFromLog();
            assert.equal(timestamp, Date.parse(newest));
        }
    );
});

test("getLastTradeTimestampFromLog returns 0 when log has no valid trade timestamps", async () => {
    await withTempLog(
        "timestamp,pair,side,entry,exit,status,pnl,trade_mode,stop_loss_percent,strategy\nnot-a-date,row\n",
        async (filePath) => {
            const helpers = createHelpers(filePath);
            assert.equal(helpers.getLastTradeTimestampFromLog(), 0);
        }
    );
});

