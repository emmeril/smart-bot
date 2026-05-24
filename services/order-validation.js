const createOrderValidationHelpers = () => {
    const validateOrderSize = () => {
        return {
            valid: true,
            bypassed: true,
            warning: "[ORDER][INFO] Local pre-validation bypassed. Exchange will enforce final order rules."
        };
    };

    return {
        validateOrderSize
    };
};

module.exports = { createOrderValidationHelpers };
