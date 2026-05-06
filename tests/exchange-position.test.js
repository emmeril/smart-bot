const test = require("node:test");
const assert = require("node:assert/strict");

const { createExchangePositionHelpers } = require("../services/exchange-position");

test("buildSyncedActivePosition preserves existing exit plan when quantity and entry are unchanged", () => {
    const helpers = createExchangePositionHelpers({
        isHedgeModeEnabled: () => false,
        toFiniteNumber: (value, fallback) => {
            const numericValue = Number(value);
            return Number.isFinite(numericValue) ? numericValue : fallback;
        },
        normalizeSymbol: (symbol) => String(symbol || "").toUpperCase(),
        formatPriceToMarketPrecision: (_pair, price) => Number(Number(price).toFixed(4)),
        getExchangeClientOrderId: (order) => String(order?.clientOrderId || ""),
        getDb: () => ({
            pair: "DOGE/USDT:USDT",
            marginMode: "isolated",
            trailingEnabled: true,
            trailingActivateATR: 1.2,
            trailingOffsetATR: 0.6,
            gridTargetProfitUsdt: 0.5,
            gridStopLossPercent: 5,
            autoTargetProfitEnabled: false,
            autoStopLossEnabled: false,
            activeGridState: null
        }),
        getSignalParameters: () => ({ gridLevels: 8, gridTakeProfitLevels: 0, gridStopLossLevels: 0 }),
        sanitizeGridState: () => null,
        findNearestGridLevelIndex: () => 0,
        buildGridExitPlan: () => ({ targetPrice: 120, stopLossPrice: 90 }),
        getPositionSyncQtyTolerance: () => 0.001,
        getPositionSyncEntryTolerancePct: () => 0.05
    });

    const existingPosition = {
        side: "buy",
        positionSide: "BOTH",
        quantity: 2,
        entryPrice: 100,
        targetPrice: 111,
        stopLossPrice: 96,
        targetProfitUSDT: 22,
        stopLossUSDT: -8,
        strategy: "SPOT_GRID",
        trailingEnabled: false,
        trailingActivateATR: 2,
        trailingOffsetATR: 1,
        atrAtEntry: 1.5,
        highestSinceEntry: 108,
        lowestSinceEntry: 99,
        entryTime: 1234567890
    };

    const synced = helpers.buildSyncedActivePosition(
        {
            symbol: "DOGE/USDT:USDT",
            side: "long",
            contracts: 2,
            entryPrice: 100,
            markPrice: 105,
            unrealizedPnl: 10
        },
        100,
        existingPosition,
        105
    );

    assert.equal(synced.targetPrice, 111);
    assert.equal(synced.stopLossPrice, 96);
    assert.equal(synced.targetProfitUSDT, 22);
    assert.equal(synced.stopLossUSDT, -8);
    assert.equal(synced.trailingEnabled, false);
    assert.equal(synced.trailingActivateATR, 2);
    assert.equal(synced.trailingOffsetATR, 1);
    assert.equal(synced.strategy, "SPOT_GRID");
});

test("shouldRefreshSyncedPosition returns true when quantity changes beyond sync tolerance", () => {
    const helpers = createExchangePositionHelpers({
        isHedgeModeEnabled: () => false,
        toFiniteNumber: (value, fallback) => {
            const numericValue = Number(value);
            return Number.isFinite(numericValue) ? numericValue : fallback;
        },
        normalizeSymbol: (symbol) => String(symbol || "").toUpperCase(),
        formatPriceToMarketPrecision: (_pair, price) => Number(Number(price).toFixed(4)),
        getExchangeClientOrderId: (order) => String(order?.clientOrderId || ""),
        getDb: () => ({
            pair: "DOGE/USDT:USDT",
            marginMode: "isolated"
        }),
        getSignalParameters: () => ({ gridLevels: 8, gridTakeProfitLevels: 0, gridStopLossLevels: 0 }),
        sanitizeGridState: () => null,
        findNearestGridLevelIndex: () => 0,
        buildGridExitPlan: () => ({ targetPrice: 120, stopLossPrice: 90 }),
        getPositionSyncQtyTolerance: () => 0.001,
        getPositionSyncEntryTolerancePct: () => 0.05
    });

    const activePosition = {
        side: "buy",
        positionSide: "BOTH",
        quantity: 2,
        entryPrice: 100
    };

    const nextPosition = {
        side: "buy",
        positionSide: "BOTH",
        quantity: 1.8,
        entryPrice: 100
    };

    assert.equal(helpers.shouldRefreshSyncedPosition(activePosition, nextPosition), true);
    assert.equal(helpers.isSameTrackedPosition(activePosition, nextPosition), false);
});
