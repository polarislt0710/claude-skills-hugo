// Aggregator so `node --test tests/` works on Node builds whose test runner
// does not accept a bare directory argument. Individual files still run via
// `node --test tests/*.test.mjs`.
import "./config.test.mjs";
import "./classify.test.mjs";
import "./state-locator.test.mjs";
import "./check.test.mjs";
import "./reap.test.mjs";
import "./watch.test.mjs";
import "./deny-scan.test.mjs";
import "./dispatch.test.mjs";
import "./race.test.mjs";
