const DASHBOARD_CANCEL_REASON_SINGLE = "DASHBOARD_CANCEL";
const DASHBOARD_CANCEL_REASON_GROUP = "DASHBOARD_CANCEL_GROUP";
const DASHBOARD_INVALID_ORDER_TYPE_ERROR = "Tipe order tidak valid. Gunakan grid, tp, atau sl.";
const DASHBOARD_INVALID_ORDER_GROUP_TYPE_ERROR = "Tipe grup order tidak valid. Gunakan grid, tp, atau sl.";
const DASHBOARD_ORDER_NOT_FOUND_ERROR = "Order tidak ditemukan atau sudah tertutup.";

const createDashboardOrderHelpers = ({
    fetchManagedOpenOrdersSnapshot,
    getExchangeClientOrderId,
    cancelGridOrders,
    cancelTpOrders,
    cancelSlOrders
}) => {
    const orderTypeConfig = {
        grid: { collectionKey: "grid", label: "GRID", cancelOrders: cancelGridOrders },
        tp: { collectionKey: "tp", label: "TP", cancelOrders: cancelTpOrders },
        sl: { collectionKey: "sl", label: "SL", cancelOrders: cancelSlOrders }
    };

    const normalizeOrderType = (orderType) => String(orderType || "").toLowerCase();
    const getOrderTypeConfig = (orderType) => orderTypeConfig[normalizeOrderType(orderType)] || null;

    const getManagedOrdersByType = (openOrders, config) => {
        if (!config) return [];
        return openOrders?.[config.collectionKey] || [];
    };

    const findManagedOrder = (orders, { clientOrderId, orderId }) => {
        return orders.find((order) => {
            const currentClientOrderId = String(getExchangeClientOrderId(order) || "");
            const currentOrderId = String(order?.id || "");
            return (
                (clientOrderId && currentClientOrderId === clientOrderId)
                || (orderId && currentOrderId === orderId)
            );
        });
    };

    const cancelDashboardOrder = async ({ orderType, clientOrderId, orderId }) => {
        const config = getOrderTypeConfig(orderType);
        if (!config) {
            return { ok: false, error: DASHBOARD_INVALID_ORDER_TYPE_ERROR };
        }

        const openOrders = await fetchManagedOpenOrdersSnapshot();
        const sourceOrders = getManagedOrdersByType(openOrders, config);
        const targetOrder = findManagedOrder(sourceOrders, { clientOrderId, orderId });

        if (!targetOrder) {
            return { ok: false, error: DASHBOARD_ORDER_NOT_FOUND_ERROR };
        }

        await config.cancelOrders([targetOrder], DASHBOARD_CANCEL_REASON_SINGLE);

        const reference = getExchangeClientOrderId(targetOrder) || targetOrder.id || "order";
        return { ok: true, message: `Order ${reference} berhasil dibatalkan.` };
    };

    const cancelDashboardOrderGroup = async (orderType) => {
        const config = getOrderTypeConfig(orderType);
        if (!config) {
            return { ok: false, error: DASHBOARD_INVALID_ORDER_GROUP_TYPE_ERROR };
        }

        const openOrders = await fetchManagedOpenOrdersSnapshot();
        const sourceOrders = getManagedOrdersByType(openOrders, config);
        if (sourceOrders.length === 0) {
            return { ok: false, error: `Tidak ada order ${config.label} terbuka.` };
        }

        await config.cancelOrders(sourceOrders, DASHBOARD_CANCEL_REASON_GROUP);

        return { ok: true, message: `${sourceOrders.length} order ${config.label} berhasil dibatalkan.` };
    };

    return {
        cancelDashboardOrder,
        cancelDashboardOrderGroup
    };
};

module.exports = { createDashboardOrderHelpers };
