const createRuntimeConfigHelpers = ({ defaultConfig }) => {
    const getDefaultConfig = () => {
        const now = Date.now();
        return {
            ...defaultConfig,
            lastDailyReset: now,
            lastUpdated: now
        };
    };

    return { getDefaultConfig };
};

module.exports = { createRuntimeConfigHelpers };
