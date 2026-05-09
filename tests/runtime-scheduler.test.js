const test = require("node:test");
const assert = require("node:assert/strict");

const { createRuntimeSchedulerHelpers } = require("../services/runtime-scheduler");

test("configureRecurringTask prevents overlapping async ticks", async () => {
    let timer = null;
    let interval = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    let callCount = 0;

    const helpers = createRuntimeSchedulerHelpers({
        initializeExchange: async () => {},
        detectPositionMode: async () => {},
        setMarginMode: async () => {},
        syncPositionWithExchange: async () => {},
        startPnLMonitoring: () => {},
        startPositionSync: () => {},
        startMetricsReporting: () => {},
        startConfigAutoReload: () => {},
        shutdown: async () => {}
    });

    const callback = async () => {
        inFlight += 1;
        callCount += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight -= 1;
    };

    helpers.configureRecurringTask(
        timer,
        interval,
        5,
        "[TEST] interval: ",
        callback,
        (value) => { timer = value; },
        (value) => { interval = value; }
    );

    await new Promise((resolve) => setTimeout(resolve, 120));
    clearInterval(timer);

    assert.ok(callCount >= 2, "callback should run multiple times");
    assert.equal(maxInFlight, 1, "callback ticks must not overlap");
});
