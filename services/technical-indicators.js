const createTechnicalIndicatorHelpers = ({ toFiniteNumber, calcATR }) => {
    const normalizePeriod = (period, fallback, minimum = 1) => (
        Math.max(minimum, Math.trunc(toFiniteNumber(period, fallback)))
    );

    const calcSMA = (values, period) => {
        const numericPeriod = normalizePeriod(period, 1);
        const output = Array(values.length).fill(null);
        let rollingSum = 0;
        for (let index = 0; index < values.length; index += 1) {
            const value = toFiniteNumber(values[index], NaN);
            rollingSum += Number.isFinite(value) ? value : 0;
            if (index >= numericPeriod) {
                const trailingValue = toFiniteNumber(values[index - numericPeriod], NaN);
                rollingSum -= Number.isFinite(trailingValue) ? trailingValue : 0;
            }
            if (index >= numericPeriod - 1) output[index] = rollingSum / numericPeriod;
        }
        return output;
    };

    const calcEMA = (values, period) => {
        const numericPeriod = normalizePeriod(period, 1);
        const multiplier = 2 / (numericPeriod + 1);
        const output = Array(values.length).fill(null);
        const seed = calcSMA(values, numericPeriod);
        let previous = seed[numericPeriod - 1];
        if (!Number.isFinite(previous)) return output;
        output[numericPeriod - 1] = previous;
        for (let index = numericPeriod; index < values.length; index += 1) {
            const value = toFiniteNumber(values[index], NaN);
            if (!Number.isFinite(value)) continue;
            previous = ((value - previous) * multiplier) + previous;
            output[index] = previous;
        }
        return output;
    };

    const calcRSI = (values, period) => {
        const numericPeriod = normalizePeriod(period, 14, 2);
        const output = Array(values.length).fill(null);
        if (values.length <= numericPeriod) return output;

        let gains = 0;
        let losses = 0;
        for (let index = 1; index <= numericPeriod; index += 1) {
            const change = toFiniteNumber(values[index], NaN) - toFiniteNumber(values[index - 1], NaN);
            if (!Number.isFinite(change)) return output;
            if (change >= 0) gains += change;
            else losses += Math.abs(change);
        }

        let averageGain = gains / numericPeriod;
        let averageLoss = losses / numericPeriod;
        output[numericPeriod] = averageLoss === 0 ? 100 : 100 - (100 / (1 + (averageGain / averageLoss)));
        for (let index = numericPeriod + 1; index < values.length; index += 1) {
            const change = toFiniteNumber(values[index], NaN) - toFiniteNumber(values[index - 1], NaN);
            if (!Number.isFinite(change)) continue;
            const gain = change > 0 ? change : 0;
            const loss = change < 0 ? Math.abs(change) : 0;
            averageGain = ((averageGain * (numericPeriod - 1)) + gain) / numericPeriod;
            averageLoss = ((averageLoss * (numericPeriod - 1)) + loss) / numericPeriod;
            output[index] = averageLoss === 0 ? 100 : 100 - (100 / (1 + (averageGain / averageLoss)));
        }
        return output;
    };

    const calcStdDev = (values, period) => {
        const numericPeriod = normalizePeriod(period, 20, 2);
        const output = Array(values.length).fill(null);
        for (let index = numericPeriod - 1; index < values.length; index += 1) {
            const window = values.slice(index - numericPeriod + 1, index + 1).map((value) => toFiniteNumber(value, NaN));
            if (window.some((value) => !Number.isFinite(value))) continue;
            const mean = window.reduce((sum, value) => sum + value, 0) / window.length;
            const variance = window.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / window.length;
            output[index] = Math.sqrt(variance);
        }
        return output;
    };

    const calcBollingerBands = (values, period, stdDevMultiplier) => {
        const basis = calcSMA(values, period);
        const stdDev = calcStdDev(values, period);
        const upper = Array(values.length).fill(null);
        const lower = Array(values.length).fill(null);
        for (let index = 0; index < values.length; index += 1) {
            if (!Number.isFinite(basis[index]) || !Number.isFinite(stdDev[index])) continue;
            upper[index] = basis[index] + (stdDev[index] * stdDevMultiplier);
            lower[index] = basis[index] - (stdDev[index] * stdDevMultiplier);
        }
        return { basis, upper, lower };
    };

    const calcMACD = (values, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) => {
        const fast = calcEMA(values, fastPeriod);
        const slow = calcEMA(values, slowPeriod);
        const macd = values.map((_, index) => (
            Number.isFinite(fast[index]) && Number.isFinite(slow[index]) ? fast[index] - slow[index] : null
        ));
        const signal = calcEMA(macd.map((value) => toFiniteNumber(value, NaN)), signalPeriod);
        const histogram = macd.map((value, index) => (
            Number.isFinite(value) && Number.isFinite(signal[index]) ? value - signal[index] : null
        ));
        return { macd, signal, histogram };
    };

    const calcADX = (high, low, close, period) => {
        const numericPeriod = normalizePeriod(period, 14, 2);
        const output = Array(close.length).fill(null);
        if (close.length <= numericPeriod * 2) return output;

        const tr = Array(close.length).fill(0);
        const plusDm = Array(close.length).fill(0);
        const minusDm = Array(close.length).fill(0);

        for (let index = 1; index < close.length; index += 1) {
            const upMove = high[index] - high[index - 1];
            const downMove = low[index - 1] - low[index];
            tr[index] = Math.max(
                high[index] - low[index],
                Math.abs(high[index] - close[index - 1]),
                Math.abs(low[index] - close[index - 1])
            );
            plusDm[index] = upMove > downMove && upMove > 0 ? upMove : 0;
            minusDm[index] = downMove > upMove && downMove > 0 ? downMove : 0;
        }

        let smoothedTr = 0;
        let smoothedPlusDm = 0;
        let smoothedMinusDm = 0;
        for (let index = 1; index <= numericPeriod; index += 1) {
            smoothedTr += tr[index];
            smoothedPlusDm += plusDm[index];
            smoothedMinusDm += minusDm[index];
        }

        const dxValues = Array(close.length).fill(null);
        for (let index = numericPeriod; index < close.length; index += 1) {
            if (index > numericPeriod) {
                smoothedTr = smoothedTr - (smoothedTr / numericPeriod) + tr[index];
                smoothedPlusDm = smoothedPlusDm - (smoothedPlusDm / numericPeriod) + plusDm[index];
                smoothedMinusDm = smoothedMinusDm - (smoothedMinusDm / numericPeriod) + minusDm[index];
            }
            if (smoothedTr <= 0) continue;
            const plusDi = (smoothedPlusDm / smoothedTr) * 100;
            const minusDi = (smoothedMinusDm / smoothedTr) * 100;
            const diSum = plusDi + minusDi;
            dxValues[index] = diSum === 0 ? 0 : (Math.abs(plusDi - minusDi) / diSum) * 100;
        }

        let adxSeed = 0;
        let seedCount = 0;
        for (let index = numericPeriod; index < (numericPeriod * 2); index += 1) {
            if (Number.isFinite(dxValues[index])) {
                adxSeed += dxValues[index];
                seedCount += 1;
            }
        }
        if (seedCount !== numericPeriod) return output;

        output[(numericPeriod * 2) - 1] = adxSeed / numericPeriod;
        for (let index = numericPeriod * 2; index < close.length; index += 1) {
            if (!Number.isFinite(dxValues[index]) || !Number.isFinite(output[index - 1])) continue;
            output[index] = ((output[index - 1] * (numericPeriod - 1)) + dxValues[index]) / numericPeriod;
        }
        return output;
    };

    const extractOhlcvSeries = (ohlcv) => ({
        open: ohlcv.map((candle) => candle[1]),
        high: ohlcv.map((candle) => candle[2]),
        low: ohlcv.map((candle) => candle[3]),
        close: ohlcv.map((candle) => candle[4]),
        volume: ohlcv.map((candle) => candle[5])
    });

    const getAverageVolume = (volume, lastIndex, volumePeriod) => {
        const recentVolumes = volume.slice(Math.max(0, lastIndex - volumePeriod), lastIndex);
        const denominator = Math.max(recentVolumes.length, 1);
        return recentVolumes.reduce((sum, value) => sum + value, 0) / denominator;
    };

    const getCurrentAtr = (high, low, close, atrPeriod, lastIndex) => {
        const atrSeries = calcATR(high, low, close, atrPeriod);
        return atrSeries[lastIndex];
    };

    const getSignalSnapshotContext = (ohlcv, params) => {
        const { open, high, low, close, volume } = extractOhlcvSeries(ohlcv);
        const lastIndex = close.length - 2;
        const currentOpen = open[lastIndex];
        const currentPrice = close[lastIndex];
        const currentVolume = volume[lastIndex];
        const avgVolume = getAverageVolume(volume, lastIndex, params.volumePeriod);
        const volumeRatio = currentVolume / (avgVolume || 1);
        const hourUTC = new Date(ohlcv[lastIndex][0]).getUTCHours();
        const currentATR = getCurrentAtr(high, low, close, params.atrPeriod, lastIndex);
        const currentNatrPercent = Number.isFinite(currentATR) && Number.isFinite(currentPrice) && currentPrice > 0
            ? (currentATR / currentPrice) * 100
            : NaN;
        const rsiSeries = calcRSI(close, params.entryRsiPeriod || 14);
        const currentRsi = rsiSeries[lastIndex];
        const adxSeries = calcADX(high, low, close, params.entryAdxPeriod || 14);
        const currentAdx = adxSeries[lastIndex];
        const bollinger = calcBollingerBands(close, params.entryBbPeriod || 20, params.entryBbStdDev || 2);
        const bbBasis = bollinger.basis[lastIndex];
        const bbUpper = bollinger.upper[lastIndex];
        const bbLower = bollinger.lower[lastIndex];
        const stdDevSeries = calcStdDev(close, params.entryBbPeriod || 20);
        const currentStdDev = stdDevSeries[lastIndex];
        const bbWidth = Number.isFinite(bbUpper) && Number.isFinite(bbLower) && Number.isFinite(bbBasis) && bbBasis !== 0
            ? (bbUpper - bbLower) / bbBasis
            : NaN;
        const bbPercentB = Number.isFinite(bbUpper) && Number.isFinite(bbLower) && bbUpper !== bbLower
            ? (currentPrice - bbLower) / (bbUpper - bbLower)
            : NaN;
        const macd = calcMACD(close);
        const macdHistogram = macd.histogram[lastIndex];

        return {
            open,
            high,
            low,
            close,
            volume,
            lastIndex,
            currentOpen,
            currentPrice,
            currentVolume,
            avgVolume,
            volumeRatio,
            hourUTC,
            currentATR,
            currentNatrPercent,
            currentRsi,
            currentAdx,
            currentStdDev,
            bbBasis,
            bbUpper,
            bbLower,
            bbWidth,
            bbPercentB,
            macdHistogram
        };
    };

    return {
        calcSMA,
        calcEMA,
        calcRSI,
        calcStdDev,
        calcBollingerBands,
        calcMACD,
        calcADX,
        extractOhlcvSeries,
        getAverageVolume,
        getCurrentAtr,
        getSignalSnapshotContext
    };
};

module.exports = { createTechnicalIndicatorHelpers };
