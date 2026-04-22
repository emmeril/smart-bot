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
    resetDashboardConfig
}) => {
    const loginAttemptWindowMs = Math.max(1000, Math.trunc(toFiniteNumber(process.env.DASHBOARD_LOGIN_WINDOW_MS, 5 * 60 * 1000)));
    const loginAttemptLimit = Math.max(1, Math.trunc(toFiniteNumber(process.env.DASHBOARD_LOGIN_MAX_ATTEMPTS, 10)));
    const rateLimitState = new Map();

    const getRequestIp = (req) => String(req.ip || req.socket?.remoteAddress || "unknown");

    const pruneRateLimitState = (now) => {
        for (const [key, value] of rateLimitState.entries()) {
            if (now - value.windowStart >= loginAttemptWindowMs) rateLimitState.delete(key);
        }
    };

    const applyLoginRateLimit = (req, res) => {
        const now = Date.now();
        pruneRateLimitState(now);
        const key = getRequestIp(req);
        const current = rateLimitState.get(key);
        if (!current || now - current.windowStart >= loginAttemptWindowMs) {
            rateLimitState.set(key, { count: 1, windowStart: now });
            return false;
        }

        current.count += 1;
        if (current.count > loginAttemptLimit) {
            const retryAfterSec = Math.max(1, Math.ceil((loginAttemptWindowMs - (now - current.windowStart)) / 1000));
            res.setHeader("Retry-After", String(retryAfterSec));
            res.status(429).json({ ok: false, error: "Too many login attempts. Please try again later." });
            return true;
        }
        return false;
    };

    const clearLoginRateLimit = (req) => {
        rateLimitState.delete(getRequestIp(req));
    };

    const isSameOriginRequest = (req) => {
        const originHeader = String(req.headers.origin || "").trim();
        if (!originHeader) return true;
        try {
            const origin = new URL(originHeader);
            const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
            const protocol = forwardedProto || (req.secure ? "https" : "http");
            const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
            if (!host) return false;
            return origin.protocol === `${protocol}:` && origin.host === host;
        } catch {
            return false;
        }
    };

    const requireSameOrigin = (req, res, next) => {
        if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
            next();
            return;
        }
        if (isSameOriginRequest(req)) {
            next();
            return;
        }
        res.status(403).json({ ok: false, error: "Cross-origin request rejected" });
    };

    const attachSecurityHeaders = (req, res, next) => {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("Referrer-Policy", "no-referrer");
        if (req.secure) {
            res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
        }
        next();
    };

    const requireDashboardAuth = (req, res, next) => {
        if (isDashboardAuthenticated(req)) return next();
        if (req.path.startsWith("/api")) {
            res.status(401).json({ ok: false, error: "Unauthorized" });
            return;
        }
        res.redirect("/login");
    };

    const createDashboardApp = () => {
        const app = express();
        app.disable("x-powered-by");
        app.set("trust proxy", String(process.env.DASHBOARD_TRUST_PROXY || "").toLowerCase() === "true");
        app.use((req, res, next) => {
            req.requestTime = Date.now();
            next();
        });
        app.use(attachSecurityHeaders);
        app.use(express.json({ limit: "1mb" }));
        app.use(express.urlencoded({ extended: false, limit: "1mb" }));
        app.use(requireSameOrigin);
        app.use((error, req, res, next) => {
            if (error && (error.type === "entity.parse.failed" || error instanceof SyntaxError)) {
                res.status(400).json({ ok: false, error: "Invalid JSON body" });
                return;
            }
            next(error);
        });

        app.get("/login", (req, res) => {
            if (isDashboardAuthenticated(req)) {
                res.redirect("/dashboard");
                return;
            }
            res.setHeader("Cache-Control", "no-store");
            res.sendFile(path.join(publicDir, "login.html"));
        });

        app.post("/login", (req, res) => {
            if (applyLoginRateLimit(req, res)) return;
            const username = String(req.body?.username || "").trim();
            const password = String(req.body?.password || "");
            if (isDashboardLoginValid(username, password)) {
                clearLoginRateLimit(req);
                setDashboardSessionCookie(res, username);
                res.redirect("/dashboard");
                return;
            }
            res.redirect("/login?error=1");
        });

        app.post("/logout", (req, res) => {
            clearDashboardSessionCookie(res);
            res.redirect("/login");
        });

        app.use(requireDashboardAuth);

        app.get("/", (req, res) => {
            res.setHeader("Cache-Control", "no-store");
            res.sendFile(path.join(publicDir, "index.html"));
        });

        app.get("/dashboard", (req, res) => {
            res.setHeader("Cache-Control", "no-store");
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

        app.put("/api/config", async (req, res) => {
            try {
                if (!req.body || typeof req.body !== "object" || Object.keys(req.body).length === 0) {
                    res.status(400).json({ ok: false, error: "Invalid request body" });
                    return;
                }
                const incoming = req.body && typeof req.body === "object" && req.body.config && typeof req.body.config === "object"
                    ? req.body.config
                    : req.body;
                if (!incoming || typeof incoming !== "object" || Object.keys(incoming).length === 0) {
                    res.status(400).json({ ok: false, error: "Invalid config object" });
                    return;
                }
                const result = await applyDashboardConfigUpdate(incoming);
                res.json({ ok: true, message: "Konfigurasi berhasil disimpan", ...result });
            } catch (error) {
                res.status(400).json({ ok: false, error: error.message });
            }
        });

        app.post("/api/config/reset", async (req, res) => {
            try {
                const result = await resetDashboardConfig();
                res.json({ ok: true, message: "Konfigurasi dikembalikan ke default", ...result });
            } catch (error) {
                res.status(400).json({ ok: false, error: error.message });
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
