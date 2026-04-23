const DEFAULT_FONNTE_ENDPOINT = "https://api.fonnte.com/send";

const createFonnteNotifierHelpers = ({
    fetchImpl = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null,
    token = process.env.FONNTE_TOKEN || "",
    target = process.env.FONNTE_TARGET || process.env.ADMIN_PHONE || "",
    endpoint = process.env.FONNTE_ENDPOINT || DEFAULT_FONNTE_ENDPOINT,
    countryCode = process.env.FONNTE_COUNTRY_CODE || "62",
    enabled = process.env.FONNTE_NOTIFICATIONS_ENABLED
} = {}) => {
    let sendQueue = Promise.resolve();

    const normalizeTargetList = (value) => (
        String(value || "")
            .split(",")
            .map((item) => String(item || "").trim())
            .filter(Boolean)
            .join(",")
    );

    const normalizedTarget = normalizeTargetList(target);
    const isEnabled = () => Boolean(token && normalizedTarget && String(enabled || "1").toLowerCase() !== "false");

    const formatNumber = (value, digits = 4) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return "N/A";
        return numeric.toFixed(digits);
    };

    const formatSignedNumber = (value, digits = 4) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return "N/A";
        return `${numeric >= 0 ? "+" : ""}${numeric.toFixed(digits)}`;
    };

    const formatTime = (value) => {
        const timestamp = Number(value);
        const date = new Date(Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now());
        try {
            return new Intl.DateTimeFormat("id-ID", {
                timeZone: "Asia/Jakarta",
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false
            }).format(date);
        } catch {
            return date.toISOString();
        }
    };

    const resolveCloseReason = (reason) => {
        const normalized = String(reason || "").toUpperCase();
        if (normalized.includes("PROFIT_TARGET")) return { code: "TP", label: "Take Profit" };
        if (normalized.includes("STOP_LOSS")) return { code: "SL", label: "Stop Loss" };
        if (normalized.includes("MANUAL")) return { code: "MANUAL", label: "Manual Close" };
        if (normalized.includes("MISSING") || normalized.includes("SYNC_REMOVED")) return { code: "SYNC", label: "Position Missing from Sync" };
        return { code: "CLOSE", label: normalized || "Close" };
    };

    const getSideLabel = (position) => (String(position?.side || "").toLowerCase() === "buy" ? "LONG" : "SHORT");

    const buildCloseNotificationMessage = ({
        position,
        reason,
        exitPrice,
        netProfitUSDT,
        profitPercent,
        closedAt
    }) => {
        const closeReason = resolveCloseReason(reason);
        const closeLabel = closeReason.code === "TP" || closeReason.code === "SL"
            ? `${closeReason.code} TERPENUHI`
            : closeReason.code === "MANUAL"
                ? "CLOSE MANUAL"
                : closeReason.code === "SYNC"
                    ? "POSISI HILANG DARI SYNC"
                    : "POSISI DITUTUP";
        const executionLabel = closeReason.code === "SYNC" ? "Harga eksekusi estimasi" : "Harga eksekusi";
        const detailLabel = closeReason.code === "SYNC"
            ? "Posisi tidak ditemukan saat sinkronisasi"
            : closeReason.label;

        const entryPrice = Number(position?.entryPrice);
        const quantity = Number(position?.quantity);
        const symbol = String(position?.symbol || position?.pair || process.env.TRADING_PAIR || "").trim();
        const strategy = String(position?.strategy || "N/A").trim();
        const side = getSideLabel(position);
        const pnlValue = Number(netProfitUSDT);
        const pnlLabel = Number.isFinite(pnlValue) && pnlValue >= 0 ? "Profit" : "Loss";

        return [
            `*${closeLabel}*`,
            `Pasangan: ${symbol || "N/A"}`,
            `Sisi: ${side}`,
            `Strategi: ${strategy}`,
            `Harga entry: ${formatNumber(entryPrice)}`,
            `${executionLabel}: ${formatNumber(exitPrice)}`,
            `Qty: ${formatNumber(quantity, 6)}`,
            `P/L: ${pnlLabel} ${formatSignedNumber(netProfitUSDT)} USDT (${formatSignedNumber(profitPercent, 2)}%)`,
            `Waktu: ${formatTime(closedAt)}`,
            `Alasan: ${detailLabel}`
        ].join("\n");
    };

    const postMessage = async (payload) => {
        if (!fetchImpl) {
            throw new Error("No fetch implementation available for Fonnte requests");
        }

        const response = await fetchImpl(endpoint, {
            method: "POST",
            headers: {
                Authorization: token
            },
            body: payload
        });

        const rawText = await response.text();
        let parsed = rawText;
        try {
            parsed = rawText ? JSON.parse(rawText) : null;
        } catch {
            // Keep the raw response text when the gateway does not return JSON.
        }

        if (!response.ok) {
            const detail = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
            throw new Error(`Fonnte HTTP ${response.status}: ${detail || "request failed"}`);
        }

        return parsed;
    };

    const sendMessage = async ({ target: messageTarget = normalizedTarget, message }) => {
        if (!isEnabled()) {
            return { ok: false, skipped: true, reason: "Fonnte is not configured" };
        }

        const normalizedMessageTarget = normalizeTargetList(messageTarget);
        if (!normalizedMessageTarget || !String(message || "").trim()) {
            return { ok: false, skipped: true, reason: "Missing target or message" };
        }

        const formData = new URLSearchParams();
        formData.set("target", normalizedMessageTarget);
        formData.set("message", String(message));
        formData.set("countryCode", String(countryCode || "62"));
        formData.set("typing", "false");
        formData.set("preview", "true");
        formData.set("sequence", "true");

        return await postMessage(formData);
    };

    const sendQueuedMessage = (payload) => {
        sendQueue = sendQueue
            .catch(() => {})
            .then(() => sendMessage(payload));
        return sendQueue;
    };

    const notifyPositionClosed = async ({
        position,
        reason,
        exitPrice,
        netProfitUSDT,
        profitPercent,
        closedAt
    }) => {
        const message = buildCloseNotificationMessage({
            position,
            reason,
            exitPrice,
            netProfitUSDT,
            profitPercent,
            closedAt
        });

        try {
            const result = await sendQueuedMessage({ message });
            return { ok: true, result };
        } catch (error) {
            console.warn(`[FONNTE][WARN] Failed to send WhatsApp notification: ${error.message}`);
            return { ok: false, skipped: false, error: error.message };
        }
    };

    return {
        isEnabled,
        normalizeTargetList,
        formatTime,
        buildCloseNotificationMessage,
        sendMessage,
        notifyPositionClosed
    };
};

module.exports = { createFonnteNotifierHelpers };
