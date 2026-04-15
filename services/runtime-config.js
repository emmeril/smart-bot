const createRuntimeConfigHelpers = ({ defaultConfig }) => {
    const getDefaultConfig = () => ({
        ...defaultConfig,
        lastDailyReset: Date.now(),
        lastUpdated: Date.now()
    });

    return { getDefaultConfig };
};

module.exports = { createRuntimeConfigHelpers };
