const shouldRunMainLoopTick = ({ isShuttingDown, isProcessing }) => {
    if (isShuttingDown) return false;
    if (isProcessing) return false;
    return true;
};

module.exports = {
    shouldRunMainLoopTick
};

