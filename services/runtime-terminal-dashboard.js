const util = require("util");

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

const createRuntimeTerminalDashboardHelpers = ({
    getDb,
    getMetrics,
    getBalanceCache,
    getTickerCache,
    getGridRuntimeSummary,
    getAccountPositionMode,
    getExchangeHealth,
    getExchangeRecoveryReason,
    getIsPlacingOrder,
    getIsClosingPosition,
    getIsSyncingPosition,
    getIsSyncingGridOrders,
    getIsMonitoringPnL,
    getLastTradeAt,
    formatStatusTimestamp,
    getActivePositionEntries,
    calculatePositionPnL,
    fetchManagedOpenOrdersSnapshot,
    formatOrderSummary,
    toFiniteNumber
}) => {
    let renderTimer = null;
    let ordersTimer = null;
    let latestManagedOrders = { grid: [], tp: [], sl: [], triggerOrdersFetchFailed: false };
    let lastOrdersRefreshAt = 0;
    let consoleRestore = null;
    let isRendering = false;
    let isRefreshingOrders = false;
    let resizeHandler = null;
    const logBuffer = [];
    const MAX_LOG_LINES = 200;
    const RENDER_INTERVAL_MS = 1000;
    const ORDERS_REFRESH_INTERVAL_MS = 5000;

    const stripAnsi = (value) => String(value || "").replace(ANSI_PATTERN, "");
    const visibleLength = (value) => stripAnsi(value).length;
    const repeat = (char, count) => char.repeat(Math.max(0, count));

    const clipText = (value, width) => {
        if (width <= 0) return "";
        const text = stripAnsi(value);
        if (text.length <= width) return text.padEnd(width, " ");
        if (width <= 3) return text.slice(0, width);
        return `${text.slice(0, width - 3)}...`;
    };

    const padLine = (value, width) => {
        const clipped = clipText(value, width);
        const padding = Math.max(0, width - visibleLength(clipped));
        return clipped + repeat(" ", padding);
    };

    const normalizeLines = (value) => String(value ?? "")
        .split(/\r?\n/)
        .map((line) => stripAnsi(line).trimEnd())
        .filter((line) => line.length > 0);

    const appendLog = (level, args) => {
        const prefix = {
            info: "[INFO]",
            warn: "[WARN]",
            error: "[ERROR]",
            debug: "[DEBUG]",
            log: "[LOG]"
        }[level] || "[LOG]";
        const rendered = util.format(...args);
        const lines = normalizeLines(rendered);
        if (lines.length === 0) {
            logBuffer.push(`${prefix} `);
        } else {
            lines.forEach((line) => logBuffer.push(`${prefix} ${line}`));
        }
        while (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
    };

    const installConsoleCapture = () => {
        if (consoleRestore || !process.stdout.isTTY) return;
        const originals = {
            log: console.log.bind(console),
            info: console.info.bind(console),
            warn: console.warn.bind(console),
            error: console.error.bind(console),
            debug: console.debug.bind(console)
        };

        ["log", "info", "warn", "error", "debug"].forEach((level) => {
            console[level] = (...args) => {
                appendLog(level, args);
                requestRender();
            };
        });

        consoleRestore = () => {
            console.log = originals.log;
            console.info = originals.info;
            console.warn = originals.warn;
            console.error = originals.error;
            console.debug = originals.debug;
        };
    };

    const restoreConsole = () => {
        if (!consoleRestore) return;
        consoleRestore();
        consoleRestore = null;
    };

    const createBox = (title, lines, width, height) => {
        const innerWidth = Math.max(1, width - 2);
        const normalizedTitle = clipText(` ${title} `, innerWidth);
        const titlePadding = Math.max(0, innerWidth - visibleLength(normalizedTitle));
        const top = `+${normalizedTitle}${repeat("-", titlePadding)}+`;
        const body = [];
        const safeLines = Array.isArray(lines) ? lines : [];
        const contentHeight = Math.max(0, height - 2);
        for (let index = 0; index < contentHeight; index++) {
            body.push(`|${padLine(safeLines[index] || "", innerWidth)}|`);
        }
        return [top, ...body, `+${repeat("-", innerWidth)}+`];
    };

    const joinColumns = (leftLines, rightLines, leftWidth, rightWidth, gap = 1) => {
        const total = Math.max(leftLines.length, rightLines.length);
        const out = [];
        for (let index = 0; index < total; index++) {
            out.push(`${padLine(leftLines[index] || "", leftWidth)}${repeat(" ", gap)}${padLine(rightLines[index] || "", rightWidth)}`);
        }
        return out;
    };

    const formatNumber = (value, digits = 2, fallback = "N/A") => (
        Number.isFinite(value) ? Number(value).toFixed(digits) : fallback
    );

    const formatSigned = (value, digits = 2) => {
        if (!Number.isFinite(value)) return "N/A";
        const sign = value > 0 ? "+" : "";
        return `${sign}${Number(value).toFixed(digits)}`;
    };

    const formatAgeLabel = (timestamp) => {
        if (!Number.isFinite(timestamp) || timestamp <= 0) return "N/A";
        const ageSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
        if (ageSeconds < 60) return `${ageSeconds}s ago`;
        const minutes = Math.floor(ageSeconds / 60);
        const seconds = ageSeconds % 60;
        if (minutes < 60) return `${minutes}m ${seconds}s ago`;
        const hours = Math.floor(minutes / 60);
        return `${hours}h ${minutes % 60}m ago`;
    };

    const buildSummaryLines = () => {
        const db = getDb();
        const balanceCache = getBalanceCache();
        const tickerCache = getTickerCache();
        const metrics = getMetrics();
        const exchangeHealth = getExchangeHealth();
        const accountPositionMode = getAccountPositionMode();
        const gridSummary = getGridRuntimeSummary(tickerCache.price, latestManagedOrders);
        const apiTotal = metrics.api.ticker + metrics.api.ohlcv + metrics.api.balance + metrics.api.positions + metrics.api.orders;
        const gridLevelsLabel = gridSummary.gridLevelsMode === "AUTO"
            ? `AUTO ${gridSummary.effectiveGridLevels}`
            : String(gridSummary.effectiveGridLevels);
        const gridRangeLabel = gridSummary.gridRangeMode === "AUTO"
            ? `AUTO ${gridSummary.effectiveGridRangePercent}%`
            : `${gridSummary.effectiveGridRangePercent}%`;

        return [
            `Pair         ${db?.pair || "N/A"}`,
            `Strategy     ${String(db?.strategy || "futures_grid").toUpperCase()}  ${db?.gridTimeframe || "N/A"}`,
            `Profile      ${String(gridSummary.presetName || "N/A").toUpperCase()}  mode=${accountPositionMode?.label || "UNKNOWN"}`,
            `Price        ${formatNumber(tickerCache.price, 4)}  cache=${formatAgeLabel(tickerCache.lastUpdate)}`,
            `Balance      total ${formatNumber(balanceCache.totalUSDT, 2)} USDT  free ${formatNumber(balanceCache.availableUSDT, 2)} USDT`,
            `Grid         levels ${gridLevelsLabel}  range ${gridRangeLabel}  slot ${gridSummary.slotLabel}`,
            `Orders       grid ${latestManagedOrders.grid.length}  tp ${latestManagedOrders.tp.length}  sl ${latestManagedOrders.sl.length}`,
            `Exchange     ${exchangeHealth.isHealthy ? "HEALTHY" : "DEGRADED"}  recovery=${exchangeHealth.needsRecoverySync ? "Y" : "N"}`,
            `Recovery     ${getExchangeRecoveryReason() || "-"}`,
            `Runtime      place=${getIsPlacingOrder() ? "Y" : "N"} close=${getIsClosingPosition() ? "Y" : "N"} pos=${getIsSyncingPosition() ? "Y" : "N"} grid=${getIsSyncingGridOrders() ? "Y" : "N"} pnl=${getIsMonitoringPnL() ? "Y" : "N"}`,
            `Daily        pnl ${formatSigned(toFiniteNumber(db?.dailyPnL, 0), 2)} USDT  trades ${Math.max(0, Math.trunc(toFiniteNumber(db?.dailyTrades, 0)))}`,
            `Last Trade   ${formatStatusTimestamp(getLastTradeAt())}`
        ];
    };

    const buildPositionLines = () => {
        const tickerCache = getTickerCache();
        const activeEntries = getActivePositionEntries();
        if (activeEntries.length === 0) return ["No active positions."];

        const lines = [];
        for (const [positionKey, position] of activeEntries.slice(0, 6)) {
            const pnlState = Number.isFinite(tickerCache.price) ? calculatePositionPnL(position, tickerCache.price) : null;
            const displayProfitUSDT = Number.isFinite(pnlState?.displayProfitUSDT) ? pnlState.displayProfitUSDT : pnlState?.netProfitUSDT;
            const displayProfitPercent = Number.isFinite(pnlState?.displayProfitPercent) ? pnlState.displayProfitPercent : pnlState?.profitPercent;
            lines.push(`[${positionKey}] ${String(position.side || "").toUpperCase()} qty=${formatNumber(position.quantity, 4)} entry=${formatNumber(position.entryPrice, 4)}`);
            lines.push(`  tp=${formatNumber(position.targetPrice, 4)} sl=${formatNumber(position.stopLossPrice, 4)} pnl=${formatSigned(displayProfitUSDT, 4)} (${formatSigned(displayProfitPercent, 2)}%)`);
            lines.push(`  strat=${position.strategy || "N/A"} tpId=${position.tpClientOrderId || "-"} slId=${position.slClientOrderId || "-"}`);
        }
        return lines;
    };

    const buildOrdersLines = () => {
        const lines = [];
        const groups = [
            ["GRID", latestManagedOrders.grid],
            ["TP", latestManagedOrders.tp],
            ["SL", latestManagedOrders.sl]
        ];
        groups.forEach(([label, orders]) => {
            lines.push(`${label} ${orders.length} order(s)`);
            if (!orders.length) {
                lines.push("  -");
                return;
            }
            orders.slice(0, 3).forEach((order) => lines.push(`  ${formatOrderSummary(order, label)}`));
        });
        if (latestManagedOrders.triggerOrdersFetchFailed) {
            lines.push("Trigger order fetch fallback active.");
        }
        return lines;
    };

    const buildMetricsLines = () => {
        const metrics = getMetrics();
        const elapsedSec = Math.max(1, Math.round((Date.now() - metrics.windowStart) / 1000));
        const apiTotal = metrics.api.ticker + metrics.api.ohlcv + metrics.api.balance + metrics.api.positions + metrics.api.orders;
        const closedTrades = Math.max(0, metrics.trades.closed);
        const winRate = closedTrades > 0 ? ((metrics.trades.wins / closedTrades) * 100).toFixed(1) : "0.0";
        return [
            `Window       ${elapsedSec}s`,
            `API Total    ${apiTotal}`,
            `Ticker       ${metrics.api.ticker}`,
            `OHLCV        ${metrics.api.ohlcv}`,
            `Balance      ${metrics.api.balance}`,
            `Positions    ${metrics.api.positions}`,
            `Orders       ${metrics.api.orders}`,
            `Signals      ${metrics.signals.analyzed}`,
            `Crossovers   ${metrics.signals.crossoverDetected}`,
            `Long Ready   ${metrics.signals.longConfirmed}`,
            `Short Ready  ${metrics.signals.shortConfirmed}`,
            `Trades O/C   ${metrics.trades.opened}/${metrics.trades.closed}`,
            `Wins/Loss    ${metrics.trades.wins}/${metrics.trades.losses}`,
            `Win Rate     ${winRate}%`,
            `Orders Sync  ${formatAgeLabel(lastOrdersRefreshAt)}`
        ];
    };

    const buildLogLines = (width, desiredRows) => {
        const lines = [];
        for (let index = logBuffer.length - 1; index >= 0 && lines.length < desiredRows; index--) {
            const rawLine = logBuffer[index];
            if (visibleLength(rawLine) <= width) {
                lines.unshift(rawLine);
                continue;
            }
            const chunks = [];
            let remaining = stripAnsi(rawLine);
            while (remaining.length > 0) {
                chunks.unshift(remaining.slice(Math.max(0, remaining.length - width)));
                remaining = remaining.slice(0, Math.max(0, remaining.length - width));
            }
            for (let chunkIndex = chunks.length - 1; chunkIndex >= 0 && lines.length < desiredRows; chunkIndex--) {
                lines.unshift(chunks[chunkIndex]);
            }
        }
        return lines.slice(-desiredRows);
    };

    const buildScreen = () => {
        const columns = Math.max(80, process.stdout.columns || 120);
        const rows = Math.max(26, process.stdout.rows || 40);
        const gap = 1;
        const leftWidth = Math.max(38, Math.floor((columns - gap) * 0.56));
        const rightWidth = Math.max(28, columns - leftWidth - gap);
        const contentRows = rows - 1;
        const topHeight = Math.max(10, Math.floor(contentRows * 0.38));
        const bottomHeight = Math.max(8, contentRows - topHeight);
        const halfTopHeight = topHeight;
        const rightTopHeight = Math.max(8, Math.floor((topHeight - 1) / 2));
        const rightBottomHeight = Math.max(8, topHeight - rightTopHeight);

        const header = padLine(`SMART BOT TERMINAL DASHBOARD  ${new Date().toISOString()}  commands: status | sync | help | Ctrl+C exit`, columns);
        const leftTop = createBox("Summary", buildSummaryLines(), leftWidth, halfTopHeight);
        const rightTop = createBox("Metrics", buildMetricsLines(), rightWidth, rightTopHeight);
        const rightBottom = createBox("Orders", buildOrdersLines(), rightWidth, rightBottomHeight);
        const topRows = joinColumns(leftTop, [...rightTop, ...rightBottom], leftWidth, rightWidth, gap);

        const leftBottomHeight = bottomHeight;
        const rightBottomHeightFull = bottomHeight;
        const bottomLeft = createBox("Positions", buildPositionLines(), leftWidth, leftBottomHeight);
        const bottomRight = createBox("Recent Logs", buildLogLines(rightWidth - 2, Math.max(1, rightBottomHeightFull - 2)), rightWidth, rightBottomHeightFull);
        const bottomRows = joinColumns(bottomLeft, bottomRight, leftWidth, rightWidth, gap);

        return [header, ...topRows, ...bottomRows].slice(0, rows);
    };

    const render = () => {
        if (!process.stdout.isTTY || isRendering) return;
        isRendering = true;
        try {
            const screen = buildScreen().join("\n");
            process.stdout.write("\u001b[?25l\u001b[H\u001b[2J");
            process.stdout.write(screen);
        } finally {
            isRendering = false;
        }
    };

    const requestRender = () => {
        if (!process.stdout.isTTY) return;
        render();
    };

    const refreshOrdersSnapshot = async () => {
        if (isRefreshingOrders) return;
        isRefreshingOrders = true;
        try {
            latestManagedOrders = await fetchManagedOpenOrdersSnapshot();
            lastOrdersRefreshAt = Date.now();
        } catch (error) {
            appendLog("warn", [`[TUI] Failed to refresh order snapshot: ${error.message}`]);
        } finally {
            isRefreshingOrders = false;
            requestRender();
        }
    };

    const start = async () => {
        if (!process.stdout.isTTY) return false;
        installConsoleCapture();
        appendLog("info", ["Terminal dashboard enabled"]);
        await refreshOrdersSnapshot();
        renderTimer = setInterval(() => requestRender(), RENDER_INTERVAL_MS);
        ordersTimer = setInterval(async () => { await refreshOrdersSnapshot(); }, ORDERS_REFRESH_INTERVAL_MS);
        if (typeof process.stdout.on === "function") {
            resizeHandler = () => requestRender();
            process.stdout.on("resize", resizeHandler);
        }
        requestRender();
        return true;
    };

    const stop = () => {
        if (renderTimer) {
            clearInterval(renderTimer);
            renderTimer = null;
        }
        if (ordersTimer) {
            clearInterval(ordersTimer);
            ordersTimer = null;
        }
        if (resizeHandler) {
            if (typeof process.stdout.off === "function") process.stdout.off("resize", resizeHandler);
            else if (typeof process.stdout.removeListener === "function") process.stdout.removeListener("resize", resizeHandler);
            resizeHandler = null;
        }
        restoreConsole();
        if (process.stdout.isTTY) {
            process.stdout.write("\u001b[2J\u001b[H\u001b[?25h");
        }
    };

    return {
        start,
        stop,
        requestRender,
        buildScreen,
        appendLog
    };
};

module.exports = { createRuntimeTerminalDashboardHelpers };
