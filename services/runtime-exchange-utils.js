const createRuntimeExchangeUtils = ({ toFiniteNumber }) => {
    const getErrorPayload = (error) => String(error?.message || error || "");

    const buildReplacementClientOrderId = (baseClientOrderId) => {
        const base = String(baseClientOrderId || "smartord").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 28);
        const suffix = Date.now().toString(36).slice(-7);
        return `${base}_${suffix}`.slice(0, 36);
    };

    const extractExchangeErrorCode = (error) => {
        const directCode = toFiniteNumber(error?.code, NaN);
        if (Number.isFinite(directCode)) return directCode;
        const payload = getErrorPayload(error);
        const match = payload.match(/"code"\s*:\s*(-?\d+)/);
        return match ? Number(match[1]) : NaN;
    };

    const isExchangeTimestampError = (error) => {
        const payload = getErrorPayload(error);
        const code = extractExchangeErrorCode(error);
        return code === -1021 || /timestamp.*ahead of the server's time|timestamp for this request was/i.test(payload);
    };

    const isDuplicateClientOrderIdError = (error) => {
        const payload = getErrorPayload(error);
        const code = extractExchangeErrorCode(error);
        return code === -4116 ||
            (code === -2010 && /duplicate order sent/i.test(payload)) ||
            /clientorderid is duplicated|duplicated|duplicate order sent/i.test(payload);
    };

    const getExchangeClientOrderId = (order) => (
        String(order?.clientOrderId || order?.info?.clientOrderId || order?.info?.origClientOrderId || "")
    );

    return {
        buildReplacementClientOrderId,
        extractExchangeErrorCode,
        isExchangeTimestampError,
        isDuplicateClientOrderIdError,
        getExchangeClientOrderId
    };
};

module.exports = { createRuntimeExchangeUtils };
