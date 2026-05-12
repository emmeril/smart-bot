const express = require("express");
const path = require("path");

const createRuntimeDashboardHelpers = ({
    publicDir,
    toFiniteNumber,
    isDashboardAuthenticated,
    isDashboardLoginValid,
    setDashboardSessionCookie,
    clearDashboardSessionCookie,
    getIsShuttingDown,
    getDb,
    getExchange,
    getExchangeHealth,
    getExchangeRecoveryReason,
    buildDashboardPayload,
    buildLiveStatusPayload,
    applyDashboardConfigUpdate,
    resetDashboardConfig,
    removeDashboardPosition,
    refreshDashboardPositionProtection,
    cancelDashboardOrder,
    cancelDashboardOrderGroup
}) => {
    const loginAttempts = new Map();

    const normalizeClientAddress = (value) => {
        const address = String(value || "").trim();
        if (!address) return "unknown";
        return address.startsWith("::ffff:") ? address.slice(7) : address;
    };

    const getLoginRateLimitConfig = () => ({
        maxAttempts: Math.max(1, Math.trunc(toFiniteNumber(process.env.DASHBOARD_LOGIN_MAX_ATTEMPTS, 5))),
        windowMs: Math.max(1000, Math.trunc(toFiniteNumber(process.env.DASHBOARD_LOGIN_WINDOW_MS, 15 * 60 * 1000)))
    });

    const getLoginAttemptKey = (req) => normalizeClientAddress(req?.ip || req?.socket?.remoteAddress);

    const normalizeHostAlias = (value) => {
        const host = String(value || "").trim().toLowerCase();
        if (!host) return "";
        if (host === "::1" || host === "[::1]" || host === "localhost") return "127.0.0.1";
        if (host.startsWith("::ffff:")) return host.slice(7);
        return host;
    };

    const parseHostAndPort = (hostHeader) => {
        const input = String(hostHeader || "").trim();
        if (!input) return { host: "", port: "" };
        if (input.startsWith("[")) {
            const closingIndex = input.indexOf("]");
            if (closingIndex > 0) {
                const host = input.slice(1, closingIndex);
                const remainder = input.slice(closingIndex + 1);
                const port = remainder.startsWith(":") ? remainder.slice(1) : "";
                return { host, port };
            }
        }
        const separator = input.lastIndexOf(":");
        if (separator > -1 && input.indexOf(":") === separator) {
            return { host: input.slice(0, separator), port: input.slice(separator + 1) };
        }
        return { host: input, port: "" };
    };

    const parseOriginHostPort = (value) => {
        try {
            const parsed = new URL(String(value || "").trim());
            return {
                host: normalizeHostAlias(parsed.hostname),
                port: parsed.port || (parsed.protocol === "https:" ? "443" : "80")
            };
        } catch {
            return null;
        }
    };

    const isSameOriginRequest = (req) => {
        const hostHeader = req?.headers?.host;
        const sourceHeader = req?.headers?.origin || req?.headers?.referer;
        if (!hostHeader || !sourceHeader) return true;
        const requestHostPort = parseHostAndPort(hostHeader);
        const sourceHostPort = parseOriginHostPort(sourceHeader);
        if (!sourceHostPort) return false;
        return (
            normalizeHostAlias(requestHostPort.host) === sourceHostPort.host &&
            String(requestHostPort.port || "80") === String(sourceHostPort.port || "80")
        );
    };

    const sweepExpiredLoginAttempts = (now = Date.now()) => {
        const { windowMs } = getLoginRateLimitConfig();
        for (const [key, record] of loginAttempts.entries()) {
            if (!record || now - record.windowStart >= windowMs) {
                loginAttempts.delete(key);
            }
        }
    };

    const getLoginAttemptRecord = (req, now = Date.now()) => {
        sweepExpiredLoginAttempts(now);
        const { windowMs } = getLoginRateLimitConfig();
        const key = getLoginAttemptKey(req);
        const current = loginAttempts.get(key);

        if (!current || now - current.windowStart >= windowMs) {
            const fresh = { windowStart: now, failedAttempts: 0 };
            loginAttempts.set(key, fresh);
            return fresh;
        }

        return current;
    };

    const resetLoginAttempts = (req) => {
        loginAttempts.delete(getLoginAttemptKey(req));
    };

    const rejectLoginAttempt = (res, retryAfterSeconds) => {
        if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
            res.setHeader("Retry-After", String(Math.ceil(retryAfterSeconds)));
        }
        res.status(429).send("Too many login attempts. Please try again later.");
    };

    const requireDashboardAuth = (req, res, next) => {
        if (isDashboardAuthenticated(req)) return next();
        if (req.path.startsWith("/api")) {
            res.status(401).json({ ok: false, error: "Unauthorized" });
            return;
        }
        res.redirect("/login");
    };

    const requireSameOriginForStateChange = (req, res, next) => {
        if (isSameOriginRequest(req)) return next();
        res.status(403).send("Forbidden");
    };

    const createDashboardApp = () => {
        const app = express();
        app.disable("x-powered-by");
        app.use(express.json({ limit: "1mb" }));
        app.use(express.urlencoded({ extended: false }));

        app.get("/login", (req, res) => {
            if (isDashboardAuthenticated(req)) {
                res.redirect("/dashboard");
                return;
            }
            res.sendFile(path.join(publicDir, "login.html"));
        });

        app.post("/login", (req, res) => {
            const username = String(req.body?.username || "").trim();
            const password = String(req.body?.password || "");
            const now = Date.now();
            const { maxAttempts, windowMs } = getLoginRateLimitConfig();
            const loginRecord = getLoginAttemptRecord(req, now);

            if (loginRecord.failedAttempts >= maxAttempts) {
                const retryAfterSeconds = Math.max(1, Math.ceil((loginRecord.windowStart + windowMs - now) / 1000));
                rejectLoginAttempt(res, retryAfterSeconds);
                return;
            }

            if (isDashboardLoginValid(username, password)) {
                resetLoginAttempts(req);
                setDashboardSessionCookie(res, username);
                res.redirect("/dashboard");
                return;
            }

            loginRecord.failedAttempts += 1;
            res.redirect("/login?error=1");
        });

        app.post("/logout", requireSameOriginForStateChange, (req, res) => {
            clearDashboardSessionCookie(res);
            res.redirect("/login");
        });

        app.use(requireDashboardAuth);

        app.get("/", (req, res) => {
            res.sendFile(path.join(publicDir, "index.html"));
        });

        app.get("/dashboard", (req, res) => {
            res.sendFile(path.join(publicDir, "index.html"));
        });

        app.use(express.static(publicDir));

        app.get("/api/health", (req, res) => {
            const exchangeHealth = getExchangeHealth();
            res.json({
                ok: true,
                botRunning: !getIsShuttingDown(),
                databaseReady: Boolean(getDb()),
                exchangeReady: Boolean(getExchange()),
                exchangeHealthy: exchangeHealth.isHealthy,
                needsRecoverySync: exchangeHealth.needsRecoverySync,
                exchangeRecoveryReason: getExchangeRecoveryReason() || null,
                serverTime: Date.now()
            });
        });

        app.get("/api/config", (req, res) => {
            if (!getDb()) {
                res.status(503).json({ ok: false, error: "Config is not ready yet" });
                return;
            }
            res.json({ ok: true, ...buildDashboardPayload() });
        });

        app.get("/api/status", async (req, res) => {
            try {
                const payload = await buildLiveStatusPayload();
                if (!payload.ok) {
                    res.status(503).json(payload);
                    return;
                }
                res.json(payload);
            } catch (error) {
                res.status(500).json({ ok: false, error: error.message });
            }
        });

        app.put("/api/config", requireSameOriginForStateChange, async (req, res) => {
            try {
                const incoming = req.body && typeof req.body === "object" && req.body.config && typeof req.body.config === "object"
                    ? req.body.config
                    : req.body;
                const result = await applyDashboardConfigUpdate(incoming);
                res.json({ ok: true, message: "Konfigurasi berhasil disimpan", ...result });
            } catch (error) {
                res.status(400).json({ ok: false, error: error.message });
            }
        });

        app.post("/api/config/reset", requireSameOriginForStateChange, async (req, res) => {
            try {
                const result = await resetDashboardConfig();
                res.json({ ok: true, message: "Konfigurasi dikembalikan ke default", ...result });
            } catch (error) {
                res.status(400).json({ ok: false, error: error.message });
            }
        });

        app.post("/api/positions/:positionKey/remove", requireSameOriginForStateChange, async (req, res) => {
            try {
                const positionKey = String(req.params?.positionKey || "").trim().toUpperCase();
                if (!positionKey) {
                    res.status(400).json({ ok: false, error: "Position key is required" });
                    return;
                }
                if (typeof removeDashboardPosition !== "function") {
                    res.status(503).json({ ok: false, error: "Remove position is unavailable" });
                    return;
                }
                const result = await removeDashboardPosition(positionKey);
                if (!result?.ok) {
                    res.status(400).json({ ok: false, error: result?.error || "Failed to remove position" });
                    return;
                }
                res.json({ ok: true, message: result.message || `Posisi ${positionKey} diproses untuk ditutup` });
            } catch (error) {
                res.status(500).json({ ok: false, error: error.message });
            }
        });

        app.post("/api/positions/:positionKey/refresh-protection", requireSameOriginForStateChange, async (req, res) => {
            try {
                const positionKey = String(req.params?.positionKey || "").trim().toUpperCase();
                if (!positionKey) {
                    res.status(400).json({ ok: false, error: "Position key is required" });
                    return;
                }
                if (typeof refreshDashboardPositionProtection !== "function") {
                    res.status(503).json({ ok: false, error: "Refresh protection is unavailable" });
                    return;
                }
                const result = await refreshDashboardPositionProtection(positionKey);
                if (!result?.ok) {
                    res.status(400).json({ ok: false, error: result?.error || "Failed to refresh protection" });
                    return;
                }
                res.json({ ok: true, message: result.message || `Protection posisi ${positionKey} berhasil diperbarui` });
            } catch (error) {
                res.status(500).json({ ok: false, error: error.message });
            }
        });

        app.post("/api/orders/cancel", requireSameOriginForStateChange, async (req, res) => {
            try {
                if (typeof cancelDashboardOrder !== "function") {
                    res.status(503).json({ ok: false, error: "Cancel order is unavailable" });
                    return;
                }
                const orderType = String(req.body?.orderType || "").trim().toLowerCase();
                const clientOrderId = String(req.body?.clientOrderId || "").trim();
                const orderId = String(req.body?.orderId || "").trim();
                const result = await cancelDashboardOrder({ orderType, clientOrderId, orderId });
                if (!result?.ok) {
                    res.status(400).json({ ok: false, error: result?.error || "Failed to cancel order" });
                    return;
                }
                res.json({ ok: true, message: result.message || "Order berhasil dibatalkan" });
            } catch (error) {
                res.status(500).json({ ok: false, error: error.message });
            }
        });

        app.post("/api/orders/cancel-group", requireSameOriginForStateChange, async (req, res) => {
            try {
                if (typeof cancelDashboardOrderGroup !== "function") {
                    res.status(503).json({ ok: false, error: "Cancel order group is unavailable" });
                    return;
                }
                const orderType = String(req.body?.orderType || "").trim().toLowerCase();
                const result = await cancelDashboardOrderGroup(orderType);
                if (!result?.ok) {
                    res.status(400).json({ ok: false, error: result?.error || "Failed to cancel order group" });
                    return;
                }
                res.json({ ok: true, message: result.message || "Order grup berhasil dibatalkan" });
            } catch (error) {
                res.status(500).json({ ok: false, error: error.message });
            }
        });

        return app;
    };

    const resolveDashboardAddress = () => ({
        port: Math.max(1, Math.trunc(toFiniteNumber(process.env.DASHBOARD_PORT || process.env.PORT, 3000))),
        host: process.env.DASHBOARD_HOST || "127.0.0.1"
    });

    const startWebDashboard = async (existingServer = null) => {
        if (existingServer) return existingServer;
        const app = createDashboardApp();
        const { port, host } = resolveDashboardAddress();

        return await new Promise((resolve, reject) => {
            const server = app.listen(port, host, () => {
                console.log(`[WEB][INFO] Dashboard available at http://localhost:${port}`);
                resolve(server);
            });
            server.on("error", (error) => {
                reject(error);
            });
        });
    };

    return {
        requireDashboardAuth,
        createDashboardApp,
        resolveDashboardAddress,
        startWebDashboard
    };
};

module.exports = { createRuntimeDashboardHelpers };
