const createOrderValidationHelpers = ({ toFiniteNumber: providedToFiniteNumber } = {}) => {
    const toFiniteNumber = typeof providedToFiniteNumber === "function"
        ? providedToFiniteNumber
        : ((value, fallback = NaN) => {
            const number = Number(value);
            return Number.isFinite(number) ? number : fallback;
        });

    const getFilters = (market) => Array.isArray(market?.info?.filters) ? market.info.filters : [];
    const getFilter = (market, type) => getFilters(market).find((filter) => (
        String(filter?.filterType || "").toUpperCase() === String(type || "").toUpperCase()
    )) || null;
    const firstFinite = (...values) => {
        for (const value of values) {
            const number = toFiniteNumber(value, NaN);
            if (Number.isFinite(number)) return number;
        }
        return NaN;
    };
    const isAlignedToStep = (value, step, min = 0) => {
        if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return true;
        const base = Number.isFinite(min) && min > 0 ? min : 0;
        const units = (value - base) / step;
        return Math.abs(units - Math.round(units)) <= 1e-8;
    };

    const resolveAmountRules = (market) => {
        const lotSize = getFilter(market, "LOT_SIZE");
        const marketLotSize = getFilter(market, "MARKET_LOT_SIZE");
        return {
            min: firstFinite(lotSize?.minQty, marketLotSize?.minQty, market?.limits?.amount?.min),
            max: firstFinite(lotSize?.maxQty, marketLotSize?.maxQty, market?.limits?.amount?.max),
            step: firstFinite(lotSize?.stepSize, marketLotSize?.stepSize)
        };
    };

    const resolvePriceRules = (market) => {
        const priceFilter = getFilter(market, "PRICE_FILTER");
        return {
            min: firstFinite(priceFilter?.minPrice, market?.limits?.price?.min),
            max: firstFinite(priceFilter?.maxPrice, market?.limits?.price?.max),
            tick: firstFinite(priceFilter?.tickSize)
        };
    };

    const resolveNotionalRules = (market) => {
        const minNotional = getFilter(market, "MIN_NOTIONAL");
        const notional = getFilter(market, "NOTIONAL");
        return {
            min: firstFinite(notional?.minNotional, minNotional?.minNotional, market?.limits?.cost?.min),
            max: firstFinite(notional?.maxNotional, market?.limits?.cost?.max)
        };
    };

    const invalid = (reason) => ({ valid: false, ok: false, reason });

    const validateOrderSize = (market, quantity, price, options = {}) => {
        const orderType = String(options?.orderType || "LIMIT").toUpperCase();
        const amount = toFiniteNumber(quantity, NaN);
        const referencePrice = toFiniteNumber(price, NaN);
        const symbol = market?.symbol ? ` ${market.symbol}` : "";

        if (!Number.isFinite(amount) || amount <= 0) {
            return invalid(`[ORDER][ERROR] Invalid${symbol} quantity ${quantity}.`);
        }
        if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
            return invalid(`[ORDER][ERROR] Invalid${symbol} ${orderType} reference price ${price}.`);
        }

        const amountRules = resolveAmountRules(market);
        if (Number.isFinite(amountRules.min) && amountRules.min > 0 && amount < amountRules.min) {
            return invalid(`[ORDER][ERROR] ${symbol.trim() || "Order"} quantity ${amount} is below minQty ${amountRules.min}.`);
        }
        if (Number.isFinite(amountRules.max) && amountRules.max > 0 && amount > amountRules.max) {
            return invalid(`[ORDER][ERROR] ${symbol.trim() || "Order"} quantity ${amount} is above maxQty ${amountRules.max}.`);
        }
        if (!isAlignedToStep(amount, amountRules.step, amountRules.min)) {
            return invalid(`[ORDER][ERROR] ${symbol.trim() || "Order"} quantity ${amount} is not aligned to stepSize ${amountRules.step}.`);
        }

        if (orderType !== "MARKET") {
            const priceRules = resolvePriceRules(market);
            if (Number.isFinite(priceRules.min) && priceRules.min > 0 && referencePrice < priceRules.min) {
                return invalid(`[ORDER][ERROR] ${symbol.trim() || "Order"} price ${referencePrice} is below minPrice ${priceRules.min}.`);
            }
            if (Number.isFinite(priceRules.max) && priceRules.max > 0 && referencePrice > priceRules.max) {
                return invalid(`[ORDER][ERROR] ${symbol.trim() || "Order"} price ${referencePrice} is above maxPrice ${priceRules.max}.`);
            }
            if (!isAlignedToStep(referencePrice, priceRules.tick, priceRules.min)) {
                return invalid(`[ORDER][ERROR] ${symbol.trim() || "Order"} price ${referencePrice} is not aligned to tickSize ${priceRules.tick}.`);
            }
        }

        const notional = amount * referencePrice;
        const notionalRules = resolveNotionalRules(market);
        if (Number.isFinite(notionalRules.min) && notionalRules.min > 0 && notional < notionalRules.min) {
            return invalid(`[ORDER][ERROR] ${symbol.trim() || "Order"} notional ${notional} is below minNotional ${notionalRules.min}.`);
        }
        if (Number.isFinite(notionalRules.max) && notionalRules.max > 0 && notional > notionalRules.max) {
            return invalid(`[ORDER][ERROR] ${symbol.trim() || "Order"} notional ${notional} is above maxNotional ${notionalRules.max}.`);
        }

        return {
            valid: true,
            ok: true,
            reason: null,
            notional,
            rules: {
                amount: amountRules,
                notional: notionalRules,
                price: orderType === "MARKET" ? null : resolvePriceRules(market)
            }
        };
    };

    return {
        validateOrderSize
    };
};

module.exports = { createOrderValidationHelpers };
