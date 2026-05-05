const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { createDashboardSessionHelpers } = require("../services/dashboard-session");

test("isDashboardLoginValid accepts trimmed username and exact password", () => {
    const helpers = createDashboardSessionHelpers({
        username: "admin",
        password: "secret123",
        sessionSecret: "test-secret",
        sessionCookieName: "sess",
        sessionTtlMs: 1000,
        isProduction: false
    });

    assert.equal(helpers.isDashboardLoginValid(" admin ", "secret123"), true);
    assert.equal(helpers.isDashboardLoginValid("admin", "wrong"), false);
    assert.equal(helpers.isDashboardLoginValid("wrong", "secret123"), false);
});

test("isDashboardAuthenticated rejects malformed tokens with extra segments", () => {
    const sessionSecret = "test-secret";
    const helpers = createDashboardSessionHelpers({
        username: "admin",
        password: "secret123",
        sessionSecret,
        sessionCookieName: "sess",
        sessionTtlMs: 1000,
        isProduction: false
    });

    const payload = Buffer.from(JSON.stringify({ u: "admin", iat: Date.now() }), "utf8").toString("base64url");
    const signature = crypto.createHmac("sha256", sessionSecret).update(payload).digest("hex");
    const malformedToken = `${payload}.${signature}.extra`;
    const req = { headers: { cookie: `sess=${encodeURIComponent(malformedToken)}` } };

    assert.equal(helpers.isDashboardAuthenticated(req), false);
});

test("isDashboardAuthenticated rejects tokens issued in the future", () => {
    const sessionSecret = "test-secret";
    const helpers = createDashboardSessionHelpers({
        username: "admin",
        password: "secret123",
        sessionSecret,
        sessionCookieName: "sess",
        sessionTtlMs: 1000,
        isProduction: false
    });

    const payload = Buffer.from(JSON.stringify({ u: "admin", iat: Date.now() + 60_000 }), "utf8").toString("base64url");
    const signature = crypto.createHmac("sha256", sessionSecret).update(payload).digest("hex");
    const token = `${payload}.${signature}`;
    const req = { headers: { cookie: `sess=${encodeURIComponent(token)}` } };

    assert.equal(helpers.isDashboardAuthenticated(req), false);
});
