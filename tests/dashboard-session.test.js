const test = require("node:test");
const assert = require("node:assert/strict");

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
