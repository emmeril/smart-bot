const DEFAULT_FONNTE_ENDPOINT = "https://api.fonnte.com/send";

const createFonnteNotifierHelpers = ({
    fetchImpl = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null,
    token = process.env.FONNTE_TOKEN || "",
    target = process.env.FONNTE_TARGET || process.env.ADMIN_PHONE || "",
    endpoint = process.env.FONNTE_ENDPOINT || DEFAULT_FONNTE_ENDPOINT,
    countryCode = process.env.FONNTE_COUNTRY_CODE || "62",
    enabled = process.env.FONNTE_NOTIFICATIONS_ENABLED,
    protectionUpdatesEnabled = process.env.FONNTE_NOTIFY_PROTECTION_UPDATES
} = {}) => {
    let sendQueue = Promise.resolve();
    const recentMessageMap = new Map();
    const DEDUPE_WINDOW_MS = 120000;


    const normalizeTargetList = (value) => (
        String(value || "")
            .split(",")
            .map((item) => String(item || "").trim())
            .filter(Boolean)
            .join(",")
    );

    const normalizedTarget = normalizeTargetList(target);
    const isEnabled = () => Boolean(token && normalizedTarget && String(enabled || "1").toLowerCase() !== "false");
    const shouldNotifyProtectionUpdates = () => String(protectionUpdatesEnabled || "false").toLowerCase() === "true";

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
        if (normalized.includes("SPOT_OCO_")) return { code: "SPOT_OCO", label: "Posisi terdeteksi sudah tertutup oleh OCO spot (sinkronisasi)." };
        if (normalized.includes("EXCHANGE_FILLED_")) return { code: "EXCHANGE_FILLED", label: "Posisi terdeteksi sudah tertutup di exchange (recovery)." };
        if (normalized.includes("PROFIT_TARGET") || normalized === "TP" || normalized.includes("_TP")) return { code: "TP", label: "Take Profit tercapai." };
        if (normalized.includes("STOP_LOSS") || normalized === "SL" || normalized.includes("_SL")) return { code: "SL", label: "Stop Loss terkena." };
        if (normalized.includes("MANUAL")) return { code: "MANUAL", label: "Posisi ditutup manual." };
        if (normalized.includes("DUST")) return { code: "DUST", label: "Posisi kecil dibersihkan otomatis (di bawah minimum lot)." };
        if (normalized.includes("MISSING") || normalized.includes("SYNC_REMOVED")) return { code: "SYNC", label: "Posisi lokal hilang saat sinkronisasi." };
        return { code: "CLOSE", label: normalized ? `Posisi ditutup (${normalized}).` : "Posisi ditutup." };
    };

    const getSideLabel = (position) => {
        const side = String(position?.side || "").toLowerCase().trim();
        if (side === "buy" || side === "long") return "LONG";
        if (side === "sell" || side === "short") return "SHORT";
        return "N/A";
    };

    const resolveTradeEvent = (event) => {
        const normalized = String(event || "").toUpperCase().trim();
        if (normalized === "OPEN") return { code: "OPEN", title: "POSISI LOCAL AKTIF" };
        if (normalized === "GRID_FILLED") return { code: "GRID_FILLED", title: "POSISI LOCAL AKTIF UPDATE" };
        if (normalized === "PARTIAL_CLOSE") return { code: "PARTIAL_CLOSE", title: "POSISI LOCAL AKTIF UPDATE" };
        if (normalized === "TP_SL_UPDATED") return { code: "TP_SL_UPDATED", title: "POSISI LOCAL AKTIF UPDATE" };
        if (normalized === "PROTECTION_BLOCKED") return { code: "PROTECTION_BLOCKED", title: "POSISI LOCAL AKTIF UPDATE" };
        return { code: normalized || "UPDATE", title: "POSISI LOCAL AKTIF UPDATE" };
    };

    const buildPositionSnapshotMessage = ({ title, position, entryPrice, quantity, targetPrice, stopLossPrice }) => {
        const symbol = String(position?.symbol || position?.pair || process.env.TRADING_PAIR || "").trim();
        return [
            title,
            `Pair : ${symbol || "N/A"}`,
            `Harga Masuk: ${formatNumber(entryPrice)}`,
            `Kuantitas: ${formatNumber(quantity, 6)}`,
            `Target: ${formatNumber(targetPrice)}`,
            `Stop Loss : ${formatNumber(stopLossPrice)}`
        ].join("\n");
    };

    const buildCloseNotificationMessage = ({
        position,
        netProfitUSDT,
        totalAccumulatedPnlUSDT
    }) => {
        const symbol = String(position?.symbol || position?.pair || process.env.TRADING_PAIR || "").trim();
        return [
            "POSISI LOCAL CLOSED",
            `Pair : ${symbol || "N/A"}`,
            `Harga Masuk: ${formatNumber(position?.entryPrice)}`,
            `PnL saat closed : ${formatSignedNumber(netProfitUSDT)} USDT`,
            `PnL total Terealisasi : ${formatSignedNumber(totalAccumulatedPnlUSDT)} USDT`
        ].join("\n");
    };

    const buildTradeUpdateMessage = ({
        event,
        position,
        entryPrice,
        quantity,
    }) => {
        const tradeEvent = resolveTradeEvent(event);
        const resolvedEntryPrice = Number.isFinite(Number(entryPrice)) ? Number(entryPrice) : Number(position?.entryPrice);
        const resolvedQuantity = Number.isFinite(Number(quantity)) ? Number(quantity) : Number(position?.quantity);
        const resolvedTargetPrice = Number(position?.targetPrice);
        const resolvedStopLossPrice = Number(position?.stopLossPrice);
        const message = buildPositionSnapshotMessage({
            title: tradeEvent.title,
            position,
            entryPrice: resolvedEntryPrice,
            quantity: resolvedQuantity,
            targetPrice: resolvedTargetPrice,
            stopLossPrice: resolvedStopLossPrice
        });
        return message;
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

    const normalizeMessageForDedupe = (message) => (
        String(message || "")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line && !line.toLowerCase().startsWith("waktu:"))
            .join("\n")
    );

    const shouldSkipDuplicateMessage = ({ target: messageTarget = normalizedTarget, message, dedupeKey }) => {
        const normalizedMessageTarget = normalizeTargetList(messageTarget);
        const normalizedMessage = normalizeMessageForDedupe(message);
        if (!normalizedMessageTarget || !normalizedMessage) return false;

        const now = Date.now();
        for (const [key, timestamp] of recentMessageMap.entries()) {
            if (now - timestamp > DEDUPE_WINDOW_MS) recentMessageMap.delete(key);
        }

        const resolvedDedupeKey = `${normalizedMessageTarget}::${String(dedupeKey || normalizedMessage)}`;
        const lastSentAt = recentMessageMap.get(resolvedDedupeKey);
        if (Number.isFinite(lastSentAt) && now - lastSentAt <= DEDUPE_WINDOW_MS) {
            return true;
        }

        recentMessageMap.set(resolvedDedupeKey, now);
        return false;
    };

    const sendQueuedMessage = (payload) => {
        sendQueue = sendQueue
            .catch(() => {})
            .then(() => {
                if (shouldSkipDuplicateMessage(payload)) {
                    return { ok: true, skipped: true, reason: "Duplicate message suppressed" };
                }
                return sendMessage(payload);
            });
        return sendQueue;
    };

    const notifyPositionClosed = async ({
        position,
        netProfitUSDT,
        totalAccumulatedPnlUSDT
    }) => {
        const message = buildCloseNotificationMessage({
            position,
            netProfitUSDT,
            totalAccumulatedPnlUSDT
        });

        try {
            const dedupeKey = [
                "CLOSE",
                String(position?.symbol || position?.pair || "").trim().toUpperCase(),
                getSideLabel(position),
                formatNumber(position?.entryPrice),
                formatNumber(position?.quantity, 6),
                formatSignedNumber(netProfitUSDT),
                formatSignedNumber(totalAccumulatedPnlUSDT)
            ].join("|");
            const result = await sendQueuedMessage({ message, dedupeKey });
            return { ok: true, result };
        } catch (error) {
            console.warn(`[FONNTE][WARN] Failed to send WhatsApp notification: ${error.message}`);
            return { ok: false, skipped: false, error: error.message };
        }
    };

    const notifyTradeUpdate = async ({
        event,
        position,
        entryPrice,
        quantity,
        reason
    }) => {
        const normalizedEvent = String(event || "").toUpperCase().trim();
        const allowedTradeEvents = new Set(["OPEN", "GRID_FILLED", "PARTIAL_CLOSE", "PROTECTION_BLOCKED"]);
        if (shouldNotifyProtectionUpdates()) allowedTradeEvents.add("TP_SL_UPDATED");

        if (!allowedTradeEvents.has(normalizedEvent)) {
            return { ok: true, skipped: true, reason: `Unsupported trade update event: ${normalizedEvent || "UNKNOWN"}` };
        }

        const message = buildTradeUpdateMessage({
            event,
            position,
            entryPrice,
            quantity
        });

        try {
            const dedupeKey = [
                "TRADE_UPDATE",
                String(event || "").trim().toUpperCase(),
                String(position?.symbol || position?.pair || "").trim().toUpperCase(),
                getSideLabel(position),
                formatNumber(entryPrice),
                formatNumber(quantity, 6),
                String(reason || "").trim().toUpperCase()
            ].join("|");
            const result = await sendQueuedMessage({ message, dedupeKey });
            return { ok: true, result };
        } catch (error) {
            console.warn(`[FONNTE][WARN] Failed to send trade update notification: ${error.message}`);
            return { ok: false, skipped: false, error: error.message };
        }
    };

    return {
        isEnabled,
        normalizeTargetList,
        formatTime,
        buildPositionSnapshotMessage,
        buildCloseNotificationMessage,
        buildTradeUpdateMessage,
        sendMessage,
        notifyPositionClosed,
        notifyTradeUpdate
    };
};

module.exports = { createFonnteNotifierHelpers };
