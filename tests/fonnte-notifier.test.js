const test = require("node:test");
const assert = require("node:assert/strict");

const { createFonnteNotifierHelpers } = require("../services/fonnte-notifier");

test("buildCloseNotificationMessage formats TP alerts with trading details", () => {
    const helpers = createFonnteNotifierHelpers({
        token: "token-123",
        target: "6281234567890"
    });

    const message = helpers.buildCloseNotificationMessage({
        position: {
            side: "buy",
            entryPrice: 100,
            quantity: 2,
            strategy: "SPOT_GRID",
            symbol: "DOGE/USDT:USDT"
        },
        reason: "PROFIT_TARGET",
        exitPrice: 110,
        netProfitUSDT: 20,
        profitPercent: 10,
        closedAt: 1700000000000
    });

    assert.ok(message.includes("TP TERPENUHI"));
    assert.ok(message.includes("Pasangan: DOGE/USDT:USDT"));
    assert.ok(message.includes("Harga eksekusi: 110.0000"));
    assert.ok(message.includes("P/L: Profit +20.0000 USDT (+10.00%)"));
});

test("buildCloseNotificationMessage formats manual and sync-close alerts", () => {
    const helpers = createFonnteNotifierHelpers({
        token: "token-123",
        target: "6281234567890"
    });

    const manualMessage = helpers.buildCloseNotificationMessage({
        position: {
            side: "sell",
            entryPrice: 100,
            quantity: 1,
            strategy: "SPOT_GRID",
            symbol: "DOGE/USDT:USDT"
        },
        reason: "MANUAL_CLOSE",
        exitPrice: 99,
        netProfitUSDT: 1,
        profitPercent: 1,
        closedAt: 1700000000000
    });

    const syncMessage = helpers.buildCloseNotificationMessage({
        position: {
            side: "buy",
            entryPrice: 100,
            quantity: 1,
            strategy: "SPOT_GRID",
            symbol: "DOGE/USDT:USDT"
        },
        reason: "POSITION_SYNC_REMOVED",
        exitPrice: 101,
        netProfitUSDT: 1,
        profitPercent: 1,
        closedAt: 1700000000000
    });

    assert.ok(manualMessage.includes("CLOSE MANUAL"));
    assert.ok(manualMessage.includes("Alasan: Manual Close"));
    assert.ok(syncMessage.includes("POSISI HILANG DARI SYNC"));
    assert.ok(syncMessage.includes("Harga eksekusi estimasi"));
});

test("sendMessage posts a Fonnte payload with the expected headers and fields", async () => {
    const requests = [];
    const helpers = createFonnteNotifierHelpers({
        token: "token-123",
        target: "6281234567890",
        fetchImpl: async (url, options) => {
            requests.push({ url, options });
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ status: true })
            };
        }
    });

    const response = await helpers.sendMessage({ message: "test notification" });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.fonnte.com/send");
    assert.equal(requests[0].options.method, "POST");
    assert.equal(requests[0].options.headers.Authorization, "token-123");
    assert.equal(requests[0].options.body.get("target"), "6281234567890");
    assert.equal(requests[0].options.body.get("message"), "test notification");
    assert.equal(requests[0].options.body.get("countryCode"), "62");
    assert.equal(response.status, true);
});
