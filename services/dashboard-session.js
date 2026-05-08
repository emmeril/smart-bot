const crypto = require("crypto");

const createDashboardSessionHelpers = ({ username, password, sessionSecret, sessionCookieName, sessionTtlMs, isProduction }) => {
    const parseCookies = (cookieHeader) => {
        const cookies = {};
        if (!cookieHeader || typeof cookieHeader !== "string") return cookies;
        cookieHeader.split(";").forEach((part) => {
            const index = part.indexOf("=");
            if (index <= 0) return;
            const key = part.slice(0, index).trim();
            const value = part.slice(index + 1).trim();
            if (!key) return;
            try {
                cookies[key] = decodeURIComponent(value);
            } catch {
                cookies[key] = value;
            }
        });
        return cookies;
    };

    const safeBufferEqual = (leftValue, rightValue) => {
        const left = Buffer.from(String(leftValue));
        const right = Buffer.from(String(rightValue));
        if (left.length !== right.length) return false;
        return crypto.timingSafeEqual(left, right);
    };

    const createDashboardSessionToken = (sessionUsername) => {
        const payload = Buffer.from(JSON.stringify({ u: sessionUsername, iat: Date.now() }), "utf8").toString("base64url");
        const signature = crypto.createHmac("sha256", sessionSecret).update(payload).digest("hex");
        return `${payload}.${signature}`;
    };

    const verifyDashboardSessionToken = (token) => {
        if (!token || typeof token !== "string") return null;
        const segments = token.split(".");
        if (segments.length !== 2) return null;
        const [payload, signature] = segments;
        if (!payload || !signature) return null;
        const expected = crypto.createHmac("sha256", sessionSecret).update(payload).digest("hex");
        if (!safeBufferEqual(signature, expected)) return null;
        try {
            const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
            if (!parsed || parsed.u !== username) return null;
            const issuedAt = Number(parsed.iat);
            const now = Date.now();
            if (!Number.isFinite(issuedAt)) return null;
            if (issuedAt > now) return null;
            if (now - issuedAt > sessionTtlMs) return null;
            return { username: parsed.u, issuedAt };
        } catch {
            return null;
        }
    };

    const getDashboardSession = (req) => {
        const cookies = parseCookies(req.headers.cookie || "");
        return verifyDashboardSessionToken(cookies[sessionCookieName]);
    };

    const isDashboardAuthenticated = (req) => Boolean(getDashboardSession(req));

    const isDashboardLoginValid = (candidateUsername, candidatePassword) => (
        String(candidateUsername || "").trim() === username &&
        String(candidatePassword || "") === password
    );

    const buildDashboardSessionCookie = (value, maxAgeSeconds) => {
        const parts = [
            `${sessionCookieName}=${encodeURIComponent(value)}`,
            "HttpOnly",
            "SameSite=Strict",
            "Path=/",
            `Max-Age=${maxAgeSeconds}`
        ];
        if (isProduction) parts.push("Secure");
        return parts.join("; ");
    };

    const setDashboardSessionCookie = (res, sessionUsername) => {
        const token = createDashboardSessionToken(sessionUsername);
        res.setHeader("Set-Cookie", buildDashboardSessionCookie(token, Math.floor(sessionTtlMs / 1000)));
    };

    const clearDashboardSessionCookie = (res) => {
        res.setHeader("Set-Cookie", buildDashboardSessionCookie("", 0));
    };

    return {
        isDashboardAuthenticated,
        isDashboardLoginValid,
        setDashboardSessionCookie,
        clearDashboardSessionCookie
    };
};

module.exports = { createDashboardSessionHelpers };
