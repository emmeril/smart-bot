const createPositionStateHelpers = ({ getDb, isLegacySinglePosition, toPositionMapKey, getTrackedPositionSideLabel, isSameTrackedPosition }) => {
    const getActivePositionsMap = (rawActivePosition = getDb()?.activePosition) => {
        if (!rawActivePosition || typeof rawActivePosition !== "object") return {};
        if (isLegacySinglePosition(rawActivePosition)) {
            const key = toPositionMapKey("BOTH");
            return { [key]: rawActivePosition };
        }
        const map = {};
        Object.entries(rawActivePosition).forEach(([key, value]) => {
            if (value && typeof value === "object") map[toPositionMapKey(key)] = value;
        });
        return map;
    };

    const getPositionMapKeys = (positionsMap) => Object.keys(positionsMap || {});
    const getPositionMapCount = (positionsMap) => getPositionMapKeys(positionsMap).length;
    const getPositionMapSignature = (positionsMap) => getPositionMapKeys(positionsMap).sort().join(",");
    const getActivePositionEntries = () => Object.entries(getActivePositionsMap());
    const getActivePositionsList = () => Object.values(getActivePositionsMap());
    const hasAnyActivePosition = () => getPositionMapCount(getActivePositionsMap()) > 0;
    const getActivePositionByKey = (key) => getActivePositionsMap()[toPositionMapKey(key)] || null;
    const getPrimaryActivePosition = () => getActivePositionsList()[0] || null;

    const setActivePositionsMap = (positionsMap) => {
        const entries = Object.entries(positionsMap || {}).filter(([, value]) => value && typeof value === "object");
        const nextDb = getDb();
        if (!nextDb) return;
        if (entries.length === 0) {
            nextDb.activePosition = null;
            return;
        }
        nextDb.activePosition = Object.fromEntries(entries);
    };

    const upsertActivePosition = (position) => {
        const map = getActivePositionsMap();
        const key = toPositionMapKey(position?.positionSide || getTrackedPositionSideLabel(position));
        map[key] = position;
        setActivePositionsMap(map);
    };

    const removeActivePositionByKey = (key) => {
        const map = getActivePositionsMap();
        delete map[toPositionMapKey(key)];
        setActivePositionsMap(map);
    };

    const mergeTrackedPositions = (currentPositionsMap, nextPositionsMap) => {
        if (getPositionMapCount(currentPositionsMap) > 0 && getPositionMapCount(nextPositionsMap) === 0) {
            return currentPositionsMap;
        }

        const mergedPositionsMap = { ...nextPositionsMap };
        Object.entries(currentPositionsMap).forEach(([key, currentPosition]) => {
            const nextPosition = mergedPositionsMap[key];
            if (!nextPosition) mergedPositionsMap[key] = currentPosition;
            else if (isSameTrackedPosition(currentPosition, nextPosition)) mergedPositionsMap[key] = { ...nextPosition, ...currentPosition };
        });
        return getPositionMapCount(mergedPositionsMap) > 0 ? mergedPositionsMap : null;
    };

    return {
        getActivePositionsMap,
        getPositionMapKeys,
        getPositionMapCount,
        getPositionMapSignature,
        getActivePositionEntries,
        getActivePositionsList,
        hasAnyActivePosition,
        getActivePositionByKey,
        getPrimaryActivePosition,
        setActivePositionsMap,
        upsertActivePosition,
        removeActivePositionByKey,
        mergeTrackedPositions
    };
};

module.exports = { createPositionStateHelpers };
