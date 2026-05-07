const createOrderValidationHelpers = ({ toFiniteNumber }) => {
    const toNumber = (value, fallback = NaN) => {
        if (typeof toFiniteNumber === "function") return toFiniteNumber(value, fallback);
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    };

    const getSymbolFilters = (market) => Array.isArray(market?.info?.filters) ? market.info.filters : [];

    const getFilter = (market, filterType) => {
        const normalizedType = String(filterType || "").toUpperCase();
        return getSymbolFilters(market).find((filter) => String(filter?.filterType || "").toUpperCase() === normalizedType) || null;
    };

    const isEnabledPositive = (value) => Number.isFinite(value) && value > 0;

    const isStepAligned = (value, step) => {
        if (!isEnabledPositive(step)) return true;
        if (!Number.isFinite(value)) return false;
        const quotient = value / step;
        return Math.abs(quotient - Math.round(quotient)) <= 1e-8;
    };

    const validateRange = ({ label, value, min, max }) => {
        if (isEnabledPositive(min) && value < min) {
            return `${label} ${value} is below exchange minimum ${min}. Order skipped.`;
        }
        if (isEnabledPositive(max) && value > max) {
            return `${label} ${value} is above exchange maximum ${max}. Order skipped.`;
        }
        return null;
    };

    const validateQuantityFilter = (market, quantity, filterType) => {
        const filter = getFilter(market, filterType);
        const minQty = toNumber(filter?.minQty, toNumber(market?.limits?.amount?.min, NaN));
        const maxQty = toNumber(filter?.maxQty, toNumber(market?.limits?.amount?.max, NaN));
        const stepSize = toNumber(filter?.stepSize, NaN);
        const rangeError = validateRange({ label: "Quantity", value: quantity, min: minQty, max: maxQty });
        if (rangeError) return `${filterType} ${rangeError}`;
        if (!isStepAligned(quantity, stepSize)) {
            return `Quantity ${quantity} does not follow ${filterType} stepSize ${stepSize}. Order skipped.`;
        }
        return null;
    };

    const validatePriceFilter = (market, referencePrice) => {
        const filter = getFilter(market, "PRICE_FILTER");
        const minPrice = toNumber(filter?.minPrice, toNumber(market?.limits?.price?.min, NaN));
        const maxPrice = toNumber(filter?.maxPrice, toNumber(market?.limits?.price?.max, NaN));
        const tickSize = toNumber(filter?.tickSize, NaN);
        const rangeError = validateRange({ label: "Price", value: referencePrice, min: minPrice, max: maxPrice });
        if (rangeError) return rangeError;
        if (!isStepAligned(referencePrice, tickSize)) {
            return `Price ${referencePrice} does not follow PRICE_FILTER tickSize ${tickSize}. Order skipped.`;
        }
        return null;
    };

    const validateNotional = (market, notional) => {
        const minNotionalFilter = getFilter(market, "MIN_NOTIONAL");
        const notionalFilter = getFilter(market, "NOTIONAL");
        const minNotional = toNumber(
            notionalFilter?.minNotional,
            toNumber(minNotionalFilter?.minNotional, toNumber(market?.limits?.cost?.min, NaN))
        );
        const maxNotional = toNumber(notionalFilter?.maxNotional, toNumber(market?.limits?.cost?.max, NaN));
        if (isEnabledPositive(minNotional) && notional < minNotional) {
            return `Order notional ${notional.toFixed(6)} is below exchange minimum ${minNotional}. Order skipped.`;
        }
        if (isEnabledPositive(maxNotional) && notional > maxNotional) {
            return `Order notional ${notional.toFixed(6)} is above exchange maximum ${maxNotional}. Order skipped.`;
        }
        return null;
    };

    const validateOrderSize = (market, quantity, referencePrice, options = {}) => {
        const orderType = String(options.orderType || "").toUpperCase();
        if (!market || !Number.isFinite(referencePrice) || referencePrice <= 0) {
            return { valid: false, reason: "[ORDER][ERROR] Invalid market or reference price." };
        }
        if (!Number.isFinite(quantity) || quantity <= 0) {
            return { valid: false, reason: "[ORDER][ERROR] Invalid order quantity after precision adjustment." };
        }

        const priceError = validatePriceFilter(market, referencePrice);
        if (priceError) return { valid: false, reason: `[ORDER][ERROR] ${priceError}` };

        const lotSizeError = validateQuantityFilter(market, quantity, "LOT_SIZE");
        if (lotSizeError) return { valid: false, reason: `[ORDER][ERROR] ${lotSizeError}` };

        if (orderType === "MARKET") {
            const marketLotSize = getFilter(market, "MARKET_LOT_SIZE");
            if (marketLotSize) {
                const marketLotSizeError = validateQuantityFilter(market, quantity, "MARKET_LOT_SIZE");
                if (marketLotSizeError) return { valid: false, reason: `[ORDER][ERROR] ${marketLotSizeError}` };
            }
        }

        const notional = quantity * referencePrice;
        const notionalError = validateNotional(market, notional);
        if (notionalError) return { valid: false, reason: `[ORDER][ERROR] ${notionalError}` };
        return { valid: true };
    };

    return {
        validateOrderSize
    };
};

module.exports = { createOrderValidationHelpers };
