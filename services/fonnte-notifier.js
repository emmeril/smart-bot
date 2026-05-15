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
        if (normalized === "OPEN") return { code: "OPEN", label: "Posisi Dibuka" };
        if (normalized === "PARTIAL_CLOSE") return { code: "PARTIAL_CLOSE", label: "Posisi Ditutup Sebagian" };
        if (normalized === "TP_SL_UPDATED") return { code: "TP_SL_UPDATED", label: "Proteksi TP/SL Diperbarui" };
        return { code: normalized || "UPDATE", label: "Update Posisi" };
    };

    const resolvePartialCloseLabel = (reason) => {
        const normalized = String(reason || "").toUpperCase();
        if (normalized.includes("TP") || normalized.includes("PROFIT")) return "TP PARSIAL";
        if (normalized.includes("SL") || normalized.includes("STOP_LOSS")) return "SL PARSIAL";
        return "PARTIAL CLOSE";
    };

    const resolveProtectionUpdateReasonLabel = (reason) => {
        const raw = String(reason || "").trim();
        const normalized = raw.toUpperCase();
        if (!normalized) return null;
        if (normalized.includes("OCO_SYNCED")) return "Order OCO sudah sinkron dengan data exchange.";
        if (normalized.includes("OCO_REPLACED")) return "Order OCO diganti agar sesuai target TP/SL terbaru.";
        if (normalized.includes("OCO_ADOPTED")) return "Order OCO existing diadopsi sebagai proteksi aktif.";
        if (normalized.includes("TP_SYNCED")) return "Order TP sudah sinkron dengan data exchange.";
        if (normalized.includes("TP_REPLACED")) return "Order TP diganti agar sesuai target terbaru.";
        if (normalized.includes("TP_ADOPTED")) return "Order TP existing diadopsi sebagai proteksi aktif.";
        if (normalized.includes("SL_SYNCED")) return "Order SL sudah sinkron dengan data exchange.";
        if (normalized.includes("SL_REPLACED")) return "Order SL diganti agar sesuai target terbaru.";
        if (normalized.includes("SL_ADOPTED")) return "Order SL existing diadopsi sebagai proteksi aktif.";
        return raw;
    };

    const buildCloseNotificationMessage = ({
        position,
        reason,
        exitPrice,
        netProfitUSDT,
        profitPercent,
        closedAt,
        closeFillSnapshot,
        order
    }) => {
        const closeReason = resolveCloseReason(reason);
        const closeLabel = closeReason.code === "TP" || closeReason.code === "SL"
            ? `${closeReason.code} FULL TERPENUHI`
            : closeReason.code === "MANUAL"
                ? "CLOSE MANUAL"
                : closeReason.code === "SPOT_OCO"
                    ? "SPOT OCO TERDETEKSI FILLED"
                    : closeReason.code === "EXCHANGE_FILLED"
                        ? "EXIT EXCHANGE TERDETEKSI FILLED"
                : closeReason.code === "DUST"
                    ? "AUTO DUST CLEANUP"
                : closeReason.code === "SYNC"
                    ? "POSISI HILANG DARI SYNC"
                    : "POSISI DITUTUP";
        const executionLabel = closeReason.code === "SYNC"
            || closeReason.code === "DUST"
            || closeReason.code === "SPOT_OCO"
            || closeReason.code === "EXCHANGE_FILLED"
            ? "Harga eksekusi estimasi"
            : "Harga eksekusi";
        const detailLabel = closeReason.code === "SYNC"
            ? "Posisi tidak ditemukan saat sinkronisasi"
            : closeReason.code === "DUST"
                ? "Posisi dibersihkan otomatis karena qty di bawah minimum lot exchange"
                : closeReason.code === "SPOT_OCO"
                    ? "Order OCO spot tidak lagi terbuka dan posisi dianggap sudah tertutup di exchange"
                    : closeReason.code === "EXCHANGE_FILLED"
                        ? "Close order ditolak karena posisi sudah tertutup di exchange, lalu diselaraskan lokal"
            : closeReason.label;

        const entryPrice = Number(position?.entryPrice);
        const positionQty = Number(position?.quantity);
        const closeQtyFromSnapshot = Number(closeFillSnapshot?.quantity);
        const closeQtyFromOrder = Number(order?.filled ?? order?.amount ?? order?.info?.executedQty ?? order?.info?.origQty);
        const closeQuantity = Number.isFinite(closeQtyFromSnapshot) && closeQtyFromSnapshot > 0
            ? closeQtyFromSnapshot
            : (Number.isFinite(closeQtyFromOrder) && closeQtyFromOrder > 0 ? closeQtyFromOrder : positionQty);
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
            `Qty: ${formatNumber(closeQuantity, 6)}`,
            `P/L: ${pnlLabel} ${formatSignedNumber(netProfitUSDT)} USDT (${formatSignedNumber(profitPercent, 2)}%)`,
            `Waktu: ${formatTime(closedAt)}`,
            `Alasan: ${detailLabel}`
        ].join("\n");
    };

    const buildTradeUpdateMessage = ({
        event,
        position,
        entryPrice,
        exitPrice,
        quantity,
        realizedPnlUSDT,
        realizedPnlPercent,
        reason,
        occurredAt
    }) => {
        const tradeEvent = resolveTradeEvent(event);
        const side = getSideLabel(position || { side: String(position?.side || "").toLowerCase() });
        const symbol = String(position?.symbol || position?.pair || process.env.TRADING_PAIR || "").trim();
        const strategy = String(position?.strategy || "N/A").trim();
        const eventTime = Number.isFinite(Number(occurredAt)) ? Number(occurredAt) : Date.now();
        const hasRealizedPnl = Number.isFinite(Number(realizedPnlUSDT));
        const pnlValue = Number(realizedPnlUSDT);
        const pnlLabel = hasRealizedPnl && pnlValue >= 0 ? "Profit" : "Loss";

        const resolvedEventTitle = tradeEvent.code === "PARTIAL_CLOSE"
            ? resolvePartialCloseLabel(reason)
            : tradeEvent.label;
        const lines = [
            `*UPDATE TRADE: ${resolvedEventTitle.toUpperCase()}*`,
            `Pasangan: ${symbol || "N/A"}`,
            `Sisi: ${side}`,
            `Strategi: ${strategy}`,
            `Harga entry: ${formatNumber(entryPrice)}`
        ];

        if (Number.isFinite(Number(exitPrice))) {
            lines.push(`Harga eksekusi: ${formatNumber(exitPrice)}`);
        }

        if (Number.isFinite(Number(quantity))) {
            lines.push(`Qty: ${formatNumber(quantity, 6)}`);
        }

        if (hasRealizedPnl) {
            lines.push(`Realized P/L: ${pnlLabel} ${formatSignedNumber(realizedPnlUSDT)} USDT (${formatSignedNumber(realizedPnlPercent, 2)}%)`);
        }

        const rawReason = String(reason || "").trim();
        if (rawReason) {
            const reasonLabel = tradeEvent.code === "TP_SL_UPDATED"
                ? (resolveProtectionUpdateReasonLabel(rawReason) || rawReason)
                : rawReason;
            lines.push(`Alasan: ${reasonLabel}`);
        }

        lines.push(`Waktu: ${formatTime(eventTime)}`);
        return lines.join("\n");
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
        reason,
        exitPrice,
        netProfitUSDT,
        profitPercent,
        closedAt,
        closeFillSnapshot,
        order
    }) => {
        const message = buildCloseNotificationMessage({
            position,
            reason,
            exitPrice,
            netProfitUSDT,
            profitPercent,
            closedAt,
            closeFillSnapshot,
            order
        });

        try {
            const dedupeKey = [
                "CLOSE",
                String(position?.symbol || position?.pair || "").trim().toUpperCase(),
                getSideLabel(position),
                String(reason || "").trim().toUpperCase(),
                formatNumber(position?.entryPrice),
                formatNumber(exitPrice),
                formatNumber(position?.quantity, 6),
                formatSignedNumber(netProfitUSDT),
                formatSignedNumber(profitPercent, 2)
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
        exitPrice,
        quantity,
        realizedPnlUSDT,
        realizedPnlPercent,
        reason,
        occurredAt
    }) => {
        const message = buildTradeUpdateMessage({
            event,
            position,
            entryPrice,
            exitPrice,
            quantity,
            realizedPnlUSDT,
            realizedPnlPercent,
            reason,
            occurredAt
        });

        try {
            const dedupeKey = [
                "TRADE_UPDATE",
                String(event || "").trim().toUpperCase(),
                String(position?.symbol || position?.pair || "").trim().toUpperCase(),
                getSideLabel(position),
                formatNumber(entryPrice),
                formatNumber(exitPrice),
                formatNumber(quantity, 6),
                formatSignedNumber(realizedPnlUSDT),
                formatSignedNumber(realizedPnlPercent, 2),
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
        buildCloseNotificationMessage,
        buildTradeUpdateMessage,
        sendMessage,
        notifyPositionClosed,
        notifyTradeUpdate
    };
};

module.exports = { createFonnteNotifierHelpers };
