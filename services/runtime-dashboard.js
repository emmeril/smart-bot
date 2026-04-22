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
                const incoming = req.body && typeof req.body === "object" && req.body.config && typeof req.body.config === "object"
                    ? req.body.config
                    : req.body;
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
