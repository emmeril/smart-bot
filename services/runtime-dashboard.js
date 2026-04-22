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
        app.set("trust proxy", 1);
        app.use((req, res, next) => {
            req.requestTime = Date.now();
            next();
        });
        app.use(express.json({ limit: "1mb", verify: (req, res, buf) => {
            try {
                JSON.parse(buf.toString());
            } catch (e) {
                throw new Error("Invalid JSON");
            }
        } }));
        app.use(express.urlencoded({ extended: false, limit: "1mb" }));

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
            if (isDashboardLoginValid(username, password)) {
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

        app.use((req, res, next) => {
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.setHeader("X-Frame-Options", "DENY");
            res.setHeader("X-XSS-Protection", "1; mode=block");
            res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
            next();
        });

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

        app.use(express.static(publicDir));
        return app;
    };

    const resolveDashboardAddress = () => ({
        port: Math.max(1, Math.trunc(toFiniteNumber(process.env.DASHBOARD_PORT || process.env.PORT, 3000))),
        host: process.env.DASHBOARD_HOST || "0.0.0.0"
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
