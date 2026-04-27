const clampNumber = (value, min, max) => Math.min(Math.max(value, min), max);

const toFiniteNumber = (value, fallback = NaN) => {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : fallback;
};

const mean = (values) => {
    const safeValues = values.filter((value) => Number.isFinite(value));
    if (safeValues.length === 0) return NaN;
    return safeValues.reduce((sum, value) => sum + value, 0) / safeValues.length;
};

const stdDev = (values) => {
    const safeValues = values.filter((value) => Number.isFinite(value));
    if (safeValues.length < 2) return NaN;
    const average = mean(safeValues);
    const variance = safeValues.reduce((sum, value) => sum + ((value - average) ** 2), 0) / safeValues.length;
    return Math.sqrt(variance);
};

const calcATR = (candles, period = 14) => {
    if (!Array.isArray(candles) || candles.length <= period) return Array.isArray(candles) ? Array(candles.length).fill(null) : [];
    const tr = Array(candles.length).fill(0);
    const atr = Array(candles.length).fill(null);

    for (let index = 1; index < candles.length; index += 1) {
        const currentHigh = toFiniteNumber(candles[index]?.[2], NaN);
        const currentLow = toFiniteNumber(candles[index]?.[3], NaN);
        const previousClose = toFiniteNumber(candles[index - 1]?.[4], NaN);
        if (!Number.isFinite(currentHigh) || !Number.isFinite(currentLow) || !Number.isFinite(previousClose)) continue;
        tr[index] = Math.max(
            currentHigh - currentLow,
            Math.abs(currentHigh - previousClose),
            Math.abs(currentLow - previousClose)
        );
    }

    let seed = 0;
    for (let index = 1; index <= period; index += 1) seed += tr[index];
    atr[period] = seed / period;

    for (let index = period + 1; index < candles.length; index += 1) {
        if (!Number.isFinite(atr[index - 1])) continue;
        atr[index] = ((atr[index - 1] * (period - 1)) + tr[index]) / period;
    }

    return atr;
};

const calcRollingMean = (values, period) => {
    const output = Array(values.length).fill(null);
    for (let index = period - 1; index < values.length; index += 1) {
        const window = values.slice(index - period + 1, index + 1);
        output[index] = mean(window);
    }
    return output;
};

const calcRollingStdDev = (values, period) => {
    const output = Array(values.length).fill(null);
    for (let index = period - 1; index < values.length; index += 1) {
        const window = values.slice(index - period + 1, index + 1);
        output[index] = stdDev(window);
    }
    return output;
};

const calcDrawdown = (returns) => {
    let equity = 0;
    let peak = 0;
    let maxDrawdown = 0;
    for (const tradeReturn of returns) {
        if (!Number.isFinite(tradeReturn)) continue;
        equity += tradeReturn;
        peak = Math.max(peak, equity);
        maxDrawdown = Math.max(maxDrawdown, peak - equity);
    }
    return maxDrawdown;
};

const calcProfitFactor = (returns) => {
    let grossProfit = 0;
    let grossLoss = 0;
    for (const tradeReturn of returns) {
        if (!Number.isFinite(tradeReturn)) continue;
        if (tradeReturn >= 0) grossProfit += tradeReturn;
        else grossLoss += Math.abs(tradeReturn);
    }
    if (grossLoss === 0) return grossProfit > 0 ? Infinity : 0;
    return grossProfit / grossLoss;
};

const buildLiquiditySnapshot = ({ orderBook = null, trades = [], currentPrice = NaN }) => {
    const bestBid = toFiniteNumber(orderBook?.bids?.[0]?.[0] ?? orderBook?.bids?.[0]?.price, NaN);
    const bestAsk = toFiniteNumber(orderBook?.asks?.[0]?.[0] ?? orderBook?.asks?.[0]?.price, NaN);
    const bidDepth = (orderBook?.bids || []).slice(0, 5).reduce((sum, level) => sum + Math.abs(toFiniteNumber(level?.[1] ?? level?.size, 0)), 0);
    const askDepth = (orderBook?.asks || []).slice(0, 5).reduce((sum, level) => sum + Math.abs(toFiniteNumber(level?.[1] ?? level?.size, 0)), 0);
    const spread = Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? Math.max(0, bestAsk - bestBid) : NaN;
    const spreadBps = Number.isFinite(spread) && Number.isFinite(currentPrice) && currentPrice > 0
        ? (spread / currentPrice) * 10000
        : NaN;
    const totalDepth = bidDepth + askDepth;
    const depthImbalance = totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0;

    const aggressiveBuyVolume = trades.reduce((sum, trade) => sum + (String(trade?.side || "").toLowerCase() === "buy" ? Math.abs(toFiniteNumber(trade?.size ?? trade?.amount, 0)) : 0), 0);
    const aggressiveSellVolume = trades.reduce((sum, trade) => sum + (String(trade?.side || "").toLowerCase() === "sell" ? Math.abs(toFiniteNumber(trade?.size ?? trade?.amount, 0)) : 0), 0);
    const totalAggressiveVolume = aggressiveBuyVolume + aggressiveSellVolume;
    const orderFlowImbalance = totalAggressiveVolume > 0 ? (aggressiveBuyVolume - aggressiveSellVolume) / totalAggressiveVolume : 0;

    const impactNotional = Math.max(1, totalAggressiveVolume * Math.max(1, currentPrice));
    const marketImpactBps = totalDepth > 0
        ? clampNumber((impactNotional / Math.max(totalDepth * Math.max(currentPrice, 1), 1)) * 10000, 0, 500)
        : 500;

    return {
        spreadBps,
        depthImbalance,
        orderFlowImbalance,
        marketImpactBps,
        bidDepth,
        askDepth
    };
};

const buildRegimeSnapshot = ({
    candles,
    atrPeriod = 14,
    meanWindow = 20,
    stdDevWindow = 20
}) => {
    if (!Array.isArray(candles) || candles.length === 0) {
        return {
            currentPrice: NaN,
            currentATR: NaN,
            currentStdDev: NaN,
            volatilityPercentile: NaN,
            zScore: NaN
        };
    }

    const close = candles.map((candle) => toFiniteNumber(candle?.[4], NaN));
    const atrSeries = calcATR(candles, atrPeriod);
    const rollingMean = calcRollingMean(close, meanWindow);
    const rollingStdDev = calcRollingStdDev(close, stdDevWindow);
    const currentIndex = close.length - 1;
    const currentPrice = close[currentIndex];
    const currentATR = atrSeries[currentIndex];
    const currentMean = rollingMean[currentIndex];
    const currentStdDev = rollingStdDev[currentIndex];
    const currentZScore = Number.isFinite(currentMean) && Number.isFinite(currentStdDev) && currentStdDev > 0
        ? (currentPrice - currentMean) / currentStdDev
        : NaN;

    const finiteAtr = atrSeries.filter((value) => Number.isFinite(value));
    const lowerAtrCount = finiteAtr.filter((value) => Number.isFinite(currentATR) && value <= currentATR).length;
    const volatilityPercentile = finiteAtr.length > 0 ? lowerAtrCount / finiteAtr.length : NaN;

    return {
        currentPrice,
        currentATR,
        currentMean,
        currentStdDev,
        zScore: currentZScore,
        volatilityPercentile,
        atrSeries,
        closeSeries: close
    };
};

const generateCandidateGrid = (overrides = {}) => {
    const tpAtrMultipliers = Array.isArray(overrides.tpAtrMultipliers) ? overrides.tpAtrMultipliers : [1, 1.25, 1.5, 2, 2.5, 3];
    const slAtrMultipliers = Array.isArray(overrides.slAtrMultipliers) ? overrides.slAtrMultipliers : [0.75, 1, 1.25, 1.5, 1.75, 2];
    const trailingActivateATR = Array.isArray(overrides.trailingActivateATR) ? overrides.trailingActivateATR : [1, 1.5, 2];
    const trailingOffsetATR = Array.isArray(overrides.trailingOffsetATR) ? overrides.trailingOffsetATR : [0.5, 0.75, 1];
    const candidates = [];

    for (const tpAtr of tpAtrMultipliers) {
        for (const slAtr of slAtrMultipliers) {
            if (tpAtr <= slAtr * 0.75) continue;
            for (const trailActivate of trailingActivateATR) {
                for (const trailOffset of trailingOffsetATR) {
                    if (trailOffset >= trailActivate) continue;
                    candidates.push({
                        tpAtr,
                        slAtr,
                        trailingActivateATR: trailActivate,
                        trailingOffsetATR: trailOffset
                    });
                }
            }
        }
    }

    return candidates;
};

const resolveDirectionalLevels = ({
    side,
    entryPrice,
    atr,
    candidate,
    regime,
    liquiditySnapshot
}) => {
    const sideSign = side === "short" ? -1 : 1;
    const volatilityMultiplier = clampNumber(
        Number.isFinite(regime?.volatilityPercentile)
            ? 0.8 + regime.volatilityPercentile
            : 1,
        0.75,
        1.8
    );
    const zScore = toFiniteNumber(regime?.zScore, 0);
    const meanReversionMultiplier = clampNumber(1 - (sideSign * zScore * 0.08), 0.75, 1.25);
    const spreadComponent = Number.isFinite(liquiditySnapshot?.spreadBps) ? liquiditySnapshot.spreadBps / 25 : 0;
    const impactComponent = Number.isFinite(liquiditySnapshot?.marketImpactBps) ? liquiditySnapshot.marketImpactBps / 80 : 0;
    const depthPenalty = 1 - Math.abs(toFiniteNumber(liquiditySnapshot?.depthImbalance, 0));
    const liquidityBuffer = clampNumber(1 + spreadComponent + impactComponent + depthPenalty * 0.1, 1, 2.5);
    const tpDistance = atr * candidate.tpAtr * volatilityMultiplier * meanReversionMultiplier;
    const slDistance = atr * candidate.slAtr * volatilityMultiplier * liquidityBuffer;

    return {
        tpDistance,
        slDistance,
        targetPrice: side === "short" ? entryPrice - tpDistance : entryPrice + tpDistance,
        stopPrice: side === "short" ? entryPrice + slDistance : entryPrice - slDistance,
        volatilityMultiplier,
        meanReversionMultiplier,
        liquidityBuffer
    };
};

const simulateTrade = ({
    candles,
    entryIndex,
    side = "long",
    candidate,
    atrSeries,
    regimeWindow = {},
    historicalLiquidity = []
}) => {
    if (!Array.isArray(candles) || candles.length === 0) return null;
    const normalizedSide = String(side).toLowerCase() === "sell" || String(side).toLowerCase() === "short" ? "short" : "long";
    const candle = candles[entryIndex];
    const entryPrice = toFiniteNumber(candle?.[4], NaN);
    const atr = toFiniteNumber(atrSeries?.[entryIndex], NaN);
    if (!Number.isFinite(entryPrice) || !Number.isFinite(atr) || atr <= 0) return null;

    const historySlice = candles.slice(Math.max(0, entryIndex - 50), entryIndex + 1);
    const regime = buildRegimeSnapshot({
        candles: historySlice,
        atrPeriod: regimeWindow.atrPeriod || 14,
        meanWindow: regimeWindow.meanWindow || 20,
        stdDevWindow: regimeWindow.stdDevWindow || 20
    });
    const liquiditySnapshot = historicalLiquidity[entryIndex] || {};
    const levels = resolveDirectionalLevels({
        side: normalizedSide,
        entryPrice,
        atr,
        candidate,
        regime,
        liquiditySnapshot
    });

    let stopPrice = levels.stopPrice;
    let maxFavorableExcursion = 0;
    let exitPrice = toFiniteNumber(candles[candles.length - 1]?.[4], entryPrice);
    let exitReason = "TIME_EXIT";
    let barsHeld = 0;
    let prematureStop = false;

    for (let index = entryIndex + 1; index < candles.length; index += 1) {
        const high = toFiniteNumber(candles[index]?.[2], NaN);
        const low = toFiniteNumber(candles[index]?.[3], NaN);
        const close = toFiniteNumber(candles[index]?.[4], NaN);
        if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) continue;
        barsHeld += 1;

        const favorableMove = normalizedSide === "long" ? high - entryPrice : entryPrice - low;
        maxFavorableExcursion = Math.max(maxFavorableExcursion, favorableMove);

        if (maxFavorableExcursion >= (candidate.trailingActivateATR * atr)) {
            const trailingOffset = candidate.trailingOffsetATR * atr;
            const trailingStop = normalizedSide === "long" ? close - trailingOffset : close + trailingOffset;
            stopPrice = normalizedSide === "long"
                ? Math.max(stopPrice, trailingStop)
                : Math.min(stopPrice, trailingStop);
        }

        const stopTriggered = normalizedSide === "long" ? low <= stopPrice : high >= stopPrice;
        const targetTriggered = normalizedSide === "long" ? high >= levels.targetPrice : low <= levels.targetPrice;

        if (stopTriggered && targetTriggered) {
            const stopDistance = Math.abs(entryPrice - stopPrice);
            const targetDistance = Math.abs(levels.targetPrice - entryPrice);
            if (stopDistance <= targetDistance) {
                exitPrice = stopPrice;
                exitReason = "STOP_LOSS";
            } else {
                exitPrice = levels.targetPrice;
                exitReason = "TAKE_PROFIT";
            }
            break;
        }

        if (stopTriggered) {
            exitPrice = stopPrice;
            exitReason = "STOP_LOSS";
            const futureWindow = candles.slice(index + 1, Math.min(candles.length, index + 6));
            prematureStop = futureWindow.some((futureCandle) => {
                const futureHigh = toFiniteNumber(futureCandle?.[2], NaN);
                const futureLow = toFiniteNumber(futureCandle?.[3], NaN);
                return normalizedSide === "long" ? futureHigh >= levels.targetPrice : futureLow <= levels.targetPrice;
            });
            break;
        }

        if (targetTriggered) {
            exitPrice = levels.targetPrice;
            exitReason = "TAKE_PROFIT";
            break;
        }
    }

    const pnl = normalizedSide === "long" ? exitPrice - entryPrice : entryPrice - exitPrice;
    return {
        entryIndex,
        entryPrice,
        exitPrice,
        barsHeld,
        pnl,
        returnOnRisk: Math.abs(entryPrice - stopPrice) > 0 ? pnl / Math.abs(entryPrice - stopPrice) : 0,
        exitReason,
        prematureStop,
        regime,
        liquiditySnapshot,
        levels
    };
};

const summarizeBacktestTrades = (trades, candidate) => {
    const returns = trades.map((trade) => trade.pnl);
    const wins = trades.filter((trade) => trade.pnl > 0);
    const losses = trades.filter((trade) => trade.pnl < 0);
    const profitFactor = calcProfitFactor(returns);
    const avgWin = wins.length > 0 ? mean(wins.map((trade) => trade.pnl)) : 0;
    const avgLoss = losses.length > 0 ? Math.abs(mean(losses.map((trade) => trade.pnl))) : 0;
    const rewardRisk = avgLoss > 0 ? avgWin / avgLoss : Infinity;
    const expectancy = mean(returns);
    const winRate = trades.length > 0 ? wins.length / trades.length : 0;
    const maxDrawdown = calcDrawdown(returns);
    const prematureStopRate = trades.length > 0 ? trades.filter((trade) => trade.prematureStop).length / trades.length : 0;
    const score = (
        (expectancy * 3) +
        (Math.min(profitFactor, 4) * 2) +
        (Math.min(rewardRisk, 4) * 1.5) +
        (winRate * 2) -
        (maxDrawdown * 1.5) -
        (prematureStopRate * 3)
    );

    return {
        candidate,
        trades,
        totalTrades: trades.length,
        winRate,
        profitFactor,
        expectancy,
        rewardRisk,
        avgWin,
        avgLoss,
        maxDrawdown,
        prematureStopRate,
        score
    };
};

const optimizeExitProfile = ({
    datasets = [],
    candidateOverrides = {},
    regimeWindow = {}
}) => {
    const candidates = generateCandidateGrid(candidateOverrides);
    const results = [];

    for (const candidate of candidates) {
        const simulatedTrades = [];
        for (const dataset of datasets) {
            const candles = Array.isArray(dataset?.candles) ? dataset.candles : [];
            const entries = Array.isArray(dataset?.entries) ? dataset.entries : [];
            const atrSeries = calcATR(candles, regimeWindow.atrPeriod || 14);
            const historicalLiquidity = Array.isArray(dataset?.historicalLiquidity) ? dataset.historicalLiquidity : [];

            for (const entry of entries) {
                const simulatedTrade = simulateTrade({
                    candles,
                    entryIndex: entry.entryIndex,
                    side: entry.side || dataset.side || "long",
                    candidate,
                    atrSeries,
                    regimeWindow,
                    historicalLiquidity
                });
                if (simulatedTrade) {
                    simulatedTrades.push({
                        ...simulatedTrade,
                        asset: dataset.asset || "UNKNOWN",
                        timeframe: dataset.timeframe || "UNKNOWN"
                    });
                }
            }
        }

        if (simulatedTrades.length > 0) results.push(summarizeBacktestTrades(simulatedTrades, candidate));
    }

    results.sort((left, right) => right.score - left.score);
    return {
        best: results[0] || null,
        leaderboard: results
    };
};

const resolveOptimalExit = ({
    side = "long",
    entryPrice,
    currentPrice,
    currentATR,
    optimizationResult,
    regime = {},
    liquiditySnapshot = {},
    orderFlow = {}
}) => {
    const candidate = optimizationResult?.best?.candidate || optimizationResult?.candidate || {
        tpAtr: 2,
        slAtr: 1.25,
        trailingActivateATR: 1.5,
        trailingOffsetATR: 0.75
    };
    const normalizedSide = String(side).toLowerCase() === "sell" || String(side).toLowerCase() === "short" ? "short" : "long";
    const directionalLevels = resolveDirectionalLevels({
        side: normalizedSide,
        entryPrice,
        atr: currentATR,
        candidate,
        regime,
        liquiditySnapshot
    });

    const flowImbalance = toFiniteNumber(orderFlow.orderFlowImbalance, liquiditySnapshot.orderFlowImbalance);
    const absorptionScore = toFiniteNumber(orderFlow.absorptionScore, 0);
    const shortHorizonAtr = Math.abs(toFiniteNumber(orderFlow.shortHorizonATR, currentATR));
    const mediumHorizonAtr = Math.abs(toFiniteNumber(orderFlow.mediumHorizonATR, currentATR));
    const volatilitySpikeRatio = mediumHorizonAtr > 0 ? shortHorizonAtr / mediumHorizonAtr : 1;
    const spikeProtectionFactor = (
        volatilitySpikeRatio >= 1.5 &&
        Math.abs(flowImbalance) >= 0.2 &&
        absorptionScore >= 0.5
    )
        ? clampNumber(1 + ((volatilitySpikeRatio - 1) * 0.35), 1, 1.75)
        : 1;

    const adjustedStopDistance = directionalLevels.slDistance * spikeProtectionFactor;
    const adjustedStopPrice = normalizedSide === "long"
        ? entryPrice - adjustedStopDistance
        : entryPrice + adjustedStopDistance;
    const targetPrice = directionalLevels.targetPrice;
    const reward = normalizedSide === "long" ? targetPrice - entryPrice : entryPrice - targetPrice;
    const risk = normalizedSide === "long" ? entryPrice - adjustedStopPrice : adjustedStopPrice - entryPrice;
    const rewardRiskRatio = risk > 0 ? reward / risk : Infinity;

    const trailingActivationPrice = normalizedSide === "long"
        ? entryPrice + (candidate.trailingActivateATR * currentATR)
        : entryPrice - (candidate.trailingActivateATR * currentATR);
    const trailingStopOffset = candidate.trailingOffsetATR * currentATR;
    const trailingStopPrice = normalizedSide === "long"
        ? Math.max(adjustedStopPrice, currentPrice - trailingStopOffset)
        : Math.min(adjustedStopPrice, currentPrice + trailingStopOffset);

    return {
        candidate,
        targetPrice,
        stopPrice: adjustedStopPrice,
        trailingActivationPrice,
        trailingStopPrice,
        rewardRiskRatio,
        volatilitySpikeRatio,
        spikeProtectionFactor,
        framework: {
            tpFormula: "TP_t = P_entry + s * (theta_tp * ATR_t * V_t * M_t)",
            slFormula: "SL_t = P_entry - s * (theta_sl * ATR_t * V_t * L_t * O_t)",
            variables: {
                s: normalizedSide === "long" ? 1 : -1,
                thetaTp: candidate.tpAtr,
                thetaSl: candidate.slAtr,
                volatilityMultiplier: directionalLevels.volatilityMultiplier,
                meanReversionMultiplier: directionalLevels.meanReversionMultiplier,
                liquidityBuffer: directionalLevels.liquidityBuffer,
                orderFlowProtection: spikeProtectionFactor
            }
        }
    };
};

module.exports = {
    calcATR,
    buildLiquiditySnapshot,
    buildRegimeSnapshot,
    generateCandidateGrid,
    optimizeExitProfile,
    resolveOptimalExit
};
