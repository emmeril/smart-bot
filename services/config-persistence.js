const createConfigPersistenceHelpers = ({ getConfigRow, withSqliteBusyRetry, Config, getDefaultConfig, hydrateConfig, serializeConfigForSave, logCreated = () => {} }) => {
    const loadPersistedConfig = async () => {
        const configRow = await getConfigRow();
        return configRow ? hydrateConfig(configRow.toJSON()) : null;
    };

    const ensureConfigRow = async () => {
        let configRow = await getConfigRow();
        if (configRow) return configRow;

        try {
            configRow = await withSqliteBusyRetry(() => Config.create({ id: 1, ...getDefaultConfig() }));
            logCreated();
            return configRow;
        } catch (error) {
            const retryRow = await getConfigRow();
            if (retryRow) return retryRow;
            throw error;
        }
    };

    const persistConfig = async (config) => {
        const serializedConfig = serializeConfigForSave(config);
        const createPayload = { ...serializedConfig };
        delete createPayload.id;

        if (config.id) {
            const [affectedRows] = await withSqliteBusyRetry(() => Config.update(serializedConfig, { where: { id: config.id } }));
            if (affectedRows > 0) return config.id;
        }

        const firstRow = await getConfigRow();
        if (firstRow) {
            config.id = firstRow.id;
            const [fallbackAffectedRows] = await withSqliteBusyRetry(() => Config.update(serializedConfig, { where: { id: firstRow.id } }));
            if (fallbackAffectedRows > 0) return firstRow.id;
        }

        const created = await withSqliteBusyRetry(() => Config.create(createPayload));
        config.id = created.id;
        return created.id;
    };

    return {
        loadPersistedConfig,
        ensureConfigRow,
        persistConfig
    };
};

module.exports = { createConfigPersistenceHelpers };
