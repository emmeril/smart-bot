const test = require("node:test");
const assert = require("node:assert/strict");

const { createRuntimeDashboardHelpers } = require("../services/runtime-dashboard");

const buildHelpers = () => createRuntimeDashboardHelpers({
    publicDir: process.cwd(),
    toFiniteNumber: (value, fallback = 0) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    },
    isDashboardAuthenticated: () => false,
    isDashboardLoginValid: () => false,
    setDashboardSessionCookie: () => {},
    clearDashboardSessionCookie: () => {},
    getIsShuttingDown: () => false,
    getDb: () => ({}),
    getExchange: () => ({}),
    getExchangeHealth: () => ({ isHealthy: true, needsRecoverySync: false }),
    getExchangeRecoveryReason: () => "",
    buildDashboardPayload: () => ({}),
    buildLiveStatusPayload: async () => ({ ok: true }),
    applyDashboardConfigUpdate: async () => ({}),
    resetDashboardConfig: async () => ({})
});

test("resolveDashboardAddress defaults to localhost instead of all interfaces", () => {
    const previousHost = process.env.DASHBOARD_HOST;
    delete process.env.DASHBOARD_HOST;

    const helpers = buildHelpers();
    assert.equal(helpers.resolveDashboardAddress().host, "127.0.0.1");

    if (previousHost === undefined) delete process.env.DASHBOARD_HOST;
    else process.env.DASHBOARD_HOST = previousHost;
});

test("login route rate limits repeated failed attempts", async () => {
    const previousLimit = process.env.DASHBOARD_LOGIN_MAX_ATTEMPTS;
    const previousWindow = process.env.DASHBOARD_LOGIN_WINDOW_MS;
    process.env.DASHBOARD_LOGIN_MAX_ATTEMPTS = "2";
    process.env.DASHBOARD_LOGIN_WINDOW_MS = "60000";

    const helpers = buildHelpers();
    const app = helpers.createDashboardApp();
    const server = await new Promise((resolve) => {
        const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });

    try {
        const { port } = server.address();
        const attempt = async () => await fetch(`http://127.0.0.1:${port}/login`, {
            method: "POST",
            headers: {
                "content-type": "application/json"
            },
            body: JSON.stringify({ username: "admin", password: "wrong" }),
            redirect: "manual"
        });

        assert.equal((await attempt()).status, 302);
        assert.equal((await attempt()).status, 302);
        const blocked = await attempt();
        assert.equal(blocked.status, 429);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        if (previousLimit === undefined) delete process.env.DASHBOARD_LOGIN_MAX_ATTEMPTS;
        else process.env.DASHBOARD_LOGIN_MAX_ATTEMPTS = previousLimit;
        if (previousWindow === undefined) delete process.env.DASHBOARD_LOGIN_WINDOW_MS;
        else process.env.DASHBOARD_LOGIN_WINDOW_MS = previousWindow;
    }
});

test("same-origin protection allows loopback host aliases for logout forms", async () => {
    const helpers = createRuntimeDashboardHelpers({
        publicDir: process.cwd(),
        toFiniteNumber: (value, fallback = 0) => {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : fallback;
        },
        isDashboardAuthenticated: () => true,
        isDashboardLoginValid: () => false,
        setDashboardSessionCookie: () => {},
        clearDashboardSessionCookie: () => {},
        getIsShuttingDown: () => false,
        getDb: () => ({}),
        getExchange: () => ({}),
        getExchangeHealth: () => ({ isHealthy: true, needsRecoverySync: false }),
        getExchangeRecoveryReason: () => "",
        buildDashboardPayload: () => ({}),
        buildLiveStatusPayload: async () => ({ ok: true }),
        applyDashboardConfigUpdate: async () => ({}),
        resetDashboardConfig: async () => ({})
    });

    const app = helpers.createDashboardApp();
    const server = await new Promise((resolve) => {
        const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });

    try {
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}/logout`, {
            method: "POST",
            headers: {
                referer: `http://localhost:${port}/dashboard`
            },
            redirect: "manual"
        });

        assert.equal(response.status, 302);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});
