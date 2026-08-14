// Unit tests for Torn Overseer Chain Watch.
//
// Scope is deliberate: the pure logic, not the UI. Every bug that actually reached members
// lived in this layer — a payload shape only half-handled, a stale snapshot presented as
// live, a countdown corrected in the wrong direction. `node --check` catches none of that.
//
// Run with:  node --test test/
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const cw = require("../Torn-Overseer-Chain-Watch.user.js");

const nowSec = () => Math.floor(Date.now() / 1000);

// The module holds a single `state` object; reset the parts a test touches so the tests
// stay order-independent.
function resetState() {
  Object.assign(cw.state, {
    watch: null,
    signup: null,
    chain: null,
    attacks: null,
    liveSource: null,
    chainConfirmedAt: null,
    scheduleConfirmedAt: Date.now(),
    chainDeadline: null,
    chainRunHits: null,
  });
}

// --- parseChain: the countdown, and where it comes from -------------------------------

test("parseChain treats timeout as seconds remaining", () => {
  const c = cw.parseChain({ chain: { current: 50, timeout: 240, max: 100 } }, null);
  assert.equal(c.active, true);
  assert.equal(c.current, 50);
  assert.equal(c.timeout, 240);
});

test("parseChain is inactive with no chain running", () => {
  assert.equal(cw.parseChain({ chain: { current: 0, timeout: 0 } }, null).active, false);
});

test("parseChain does NOT trust chain.end until it is seen to track a hit", () => {
  // The arithmetic check alone is circular: the clock offset is derived from
  // (end - timeout), so validating (end - timeout) against it returns zero by
  // construction and would accept a long-stale `end` on the very first poll.
  cw.resetClockSamplesForTests();
  const end = nowSec() + 240;
  const c = cw.parseChain({ chain: { id: 1, current: 50, timeout: 240, end } }, null);
  assert.notEqual(c.timeSource, "chain.end", "one reading proves nothing about end");
  assert.equal(c.deadlineLocalMs, null);
  assert.ok(Math.abs(c.timeout - 240) <= 1, "the anchored countdown is still correct");
});

test("chain.end is adopted once a landed hit moves it", () => {
  cw.resetClockSamplesForTests();
  const t = nowSec();
  // Two reads of the same chain with a hit between them, and `end` pushed out with it.
  cw.parseChain({ chain: { id: 9, current: 50, timeout: 240, end: t + 240 } }, null);
  const after = cw.parseChain({ chain: { id: 9, current: 51, timeout: 300, end: t + 300 } }, null);
  assert.equal(after.endTracks, true);
  assert.equal(after.timeSource, "chain.end");
  assert.ok(after.deadlineLocalMs != null);
});

test("a static chain.end is rejected even though the arithmetic looks perfect", () => {
  // This is the case the old check waved through: end fixed at chainStart+300 while the
  // chain runs on. (end - timeout) still lands exactly on "now" by construction.
  cw.resetClockSamplesForTests();
  const t = nowSec();
  const staticEnd = t - 1500; // chain started 30 min ago; end never moved
  cw.parseChain({ chain: { id: 11, current: 50, timeout: 240, end: staticEnd } }, null);
  const after = cw.parseChain({ chain: { id: 11, current: 51, timeout: 300, end: staticEnd } }, null);
  assert.equal(after.endTracks, false, "a hit landed and end did not move");
  assert.notEqual(after.timeSource, "chain.end");
  assert.equal(after.deadlineLocalMs, null, "must not count down to a stale instant");
});

test("end behaviour is never inferred across two different chains", () => {
  // A new chain moves current and end together, which would look like tracking.
  cw.resetClockSamplesForTests();
  const t = nowSec();
  cw.parseChain({ chain: { id: 1, current: 400, timeout: 200, end: t + 200 } }, null);
  const newChain = cw.parseChain({ chain: { id: 2, current: 3, timeout: 280, end: t + 280 } }, null);
  assert.equal(newChain.endTracks, null, "a different chain id proves nothing");
});

test("parseChain rejects end=0 and the 2^30 schema placeholder", () => {
  cw.resetClockSamplesForTests();
  for (const end of [0, 1073741824]) {
    const c = cw.parseChain({ chain: { id: 1, current: 50, timeout: 240, end } }, null);
    assert.notEqual(c.timeSource, "chain.end", `end=${end} should not be trusted`);
  }
});

test("parseChain subtracts cache staleness rather than adding it", () => {
  // A stale response OVERSTATES the time left; the correction must shorten the countdown.
  const fresh = cw.parseChain({ chain: { current: 50, timeout: 240 } }, null);
  const stale = cw.parseChain({ chain: { current: 50, timeout: 240 } }, { sec: 25, source: "age" });
  assert.equal(stale.timeout, 215);
  assert.ok(stale.timeout < fresh.timeout, "staleness must reduce, never extend, the timer");
});

test("parseChain carries Torn's chain id through", () => {
  assert.equal(cw.parseChain({ chain: { current: 5, timeout: 100, id: 987 } }, null).id, 987);
});

// --- Response freshness headers --------------------------------------------------------

test("parseResponseMeta reads Age and Date, and rejects nonsense", () => {
  const m = cw.parseResponseMeta("HTTP/1.1 200 OK\r\ndate: Fri, 14 Aug 2026 10:00:00 GMT\r\nage: 17\r\n");
  assert.equal(m.ageSec, 17);
  assert.ok(m.serverNowMs > 0);
  assert.equal(cw.parseResponseMeta("age: 99999").ageSec, null); // out of range
  assert.deepEqual(cw.parseResponseMeta(""), { ageSec: null, serverNowMs: null });
});

test("stalenessFromMeta prefers the Age header", () => {
  const r = cw.stalenessFromMeta({ ageSec: 12, serverNowMs: Date.now() }, Date.now());
  assert.equal(r.source, "age");
  assert.equal(r.sec, 12);
});

// --- Clock skew ------------------------------------------------------------------------

test("server clock offset recovers skew and ignores cache age and latency", () => {
  cw.resetClockSamplesForTests(); // the ring is shared module state
  const SKEW = 47; // this member's clock runs 47s fast
  const deadline = 1800000300;
  for (const [cacheAge, latency] of [[12, 0.4], [0, 0.2], [30, 1.1]]) {
    const genServer = deadline - 240 - cacheAge;
    const timeout = deadline - genServer;
    const recvLocal = genServer + cacheAge + SKEW + latency;
    cw.noteServerClock(deadline, timeout, recvLocal);
  }
  const off = cw.serverClockOffsetSec();
  assert.ok(Math.abs(off - SKEW) < 1.5, `expected ~${SKEW}s, got ${off}`);
});

// --- Both payload shapes: the token-mode bug that made the panel look desynced ---------

const SESSION_PAYLOAD = {
  shifts: [
    {
      id: 1,
      shift_start: new Date(Date.now() - 3600e3).toISOString(),
      shift_end: new Date(Date.now() + 3600e3).toISOString(),
      watcher_id: 111, watcher_name: "Alice", watcher_online_status: "Online",
    },
    {
      id: 2,
      shift_start: new Date(Date.now() + 3600e3).toISOString(),
      shift_end: new Date(Date.now() + 7200e3).toISOString(),
      watcher_id: 222, watcher_name: "Bob", watcher_online_status: "Offline",
    },
  ],
};

const TOKEN_PAYLOAD = {
  shifts: [
    {
      id: 1,
      shift_start: new Date(Date.now() - 3600e3).toISOString(),
      shift_end: new Date(Date.now() + 3600e3).toISOString(),
      main: { watcher_id: 111, watcher_name: "Alice", online_status: "Online", filled: true },
    },
    {
      id: 2,
      shift_start: new Date(Date.now() + 3600e3).toISOString(),
      shift_end: new Date(Date.now() + 7200e3).toISOString(),
      main: { watcher_id: 222, watcher_name: "Bob", online_status: "Offline", filled: true },
    },
  ],
};

test("currentAndNextShift resolves the session payload", () => {
  resetState();
  cw.state.watch = SESSION_PAYLOAD;
  const { current, next } = cw.currentAndNextShift();
  assert.equal(current.watcher_name, "Alice");
  assert.equal(next.watcher_name, "Bob");
});

test("currentAndNextShift resolves the TOKEN payload — the regression that shipped", () => {
  // refreshAll nulls state.watch in token mode. Reading only state.watch.shifts left every
  // link-mode viewer staring at "No watcher assigned" on a fully staffed sheet.
  resetState();
  cw.state.signup = TOKEN_PAYLOAD;
  const { current, next } = cw.currentAndNextShift();
  assert.ok(current, "token mode must resolve a current watcher");
  assert.equal(current.watcher_name, "Alice");
  assert.equal(current.watcher_online_status, "Online");
  assert.equal(next.watcher_name, "Bob");
});

test("normalizedShifts and coverageGaps handle both shapes", () => {
  resetState();
  cw.state.watch = SESSION_PAYLOAD;
  assert.equal(cw.normalizedShifts().length, 2);
  assert.equal(cw.coverageGaps().length, 0);

  resetState();
  cw.state.signup = TOKEN_PAYLOAD;
  assert.equal(cw.normalizedShifts().length, 2);
  assert.equal(cw.coverageGaps().length, 0);

  resetState();
  cw.state.watch = { shifts: [{ ...SESSION_PAYLOAD.shifts[1], watcher_id: null }] };
  assert.equal(cw.coverageGaps().length, 1, "an unassigned future shift is a gap");
});

// --- Handoff: don't assert "not online" off old data ----------------------------------

test("handoffStatus reports unknown rather than risk when the roster is stale", () => {
  resetState();
  const start = new Date(Date.now() - 3600e3).toISOString();
  const end = new Date(Date.now() + 60e3).toISOString(); // ends in 1 min → inside the warn window
  cw.state.watch = {
    shifts: [
      { id: 1, shift_start: start, shift_end: end, watcher_id: 111, watcher_name: "Alice", watcher_online_status: "Online" },
      {
        id: 2, shift_start: end, shift_end: new Date(Date.now() + 3600e3).toISOString(),
        watcher_id: 222, watcher_name: "Bob", watcher_online_status: "Offline",
      },
    ],
  };

  cw.state.scheduleConfirmedAt = Date.now();
  assert.equal(cw.handoffStatus().state, "risk", "fresh data may assert Bob is offline");

  cw.state.scheduleConfirmedAt = Date.now() - 10 * 60e3;
  const stale = cw.handoffStatus();
  assert.equal(stale.state, "unknown", "stale data must not claim Bob is offline");
  assert.equal(stale.stale, true);
});

test("handoffStatus still reports a genuine gap on stale data", () => {
  resetState();
  const end = new Date(Date.now() + 60e3).toISOString();
  cw.state.watch = {
    shifts: [{
      id: 1, shift_start: new Date(Date.now() - 3600e3).toISOString(), shift_end: end,
      watcher_id: 111, watcher_name: "Alice", watcher_online_status: "Online",
    }],
  };
  cw.state.scheduleConfirmedAt = Date.now() - 10 * 60e3;
  assert.equal(cw.handoffStatus().state, "gap", "an empty slot is a fact, not a claim");
});

// --- Staleness -------------------------------------------------------------------------

test("chainStaleness flags a snapshot nothing has confirmed recently", () => {
  resetState();
  cw.state.chain = cw.parseChain({ chain: { current: 50, timeout: 240 } }, null);
  cw.state.liveSource = "torn";

  cw.state.chainConfirmedAt = Date.now();
  assert.equal(cw.chainStaleness().stale, false);

  cw.state.chainConfirmedAt = Date.now() - 60e3;
  assert.equal(cw.chainStaleness().stale, true, "a minute-old chain read is stale");
});

test("the backend cache path gets a looser staleness bar than the direct read", () => {
  resetState();
  cw.state.chain = cw.parseChain({ chain: { current: 50, timeout: 240 } }, null);
  cw.state.chainConfirmedAt = Date.now() - 45e3;
  cw.state.liveSource = "torn";
  assert.equal(cw.chainStaleness().stale, true);
  cw.state.liveSource = "cache";
  assert.equal(cw.chainStaleness().stale, false, "the cache path refreshes more slowly by design");
});

// --- Warm-up ---------------------------------------------------------------------------

test("chainWarmup is true below 10 hits and false at or above", () => {
  resetState();
  cw.state.chain = { active: true, current: 1 };
  assert.equal(cw.chainWarmup(), true);
  cw.state.chain = { active: true, current: 9 };
  assert.equal(cw.chainWarmup(), true);
  cw.state.chain = { active: true, current: 10 };
  assert.equal(cw.chainWarmup(), false, "10 hits is a chain, not warm-up");
  cw.state.chain = { active: false, current: 0 };
  assert.equal(cw.chainWarmup(), false);
});

// --- Deadline estimate -----------------------------------------------------------------

test("noteChainTimer keeps the tightest bound and a hit resets the run", () => {
  resetState();
  cw.state.chain = { active: true, current: 20 };
  cw.noteChainHits(20);
  cw.noteChainTimer(300);
  const loose = cw.state.chainDeadline;
  cw.noteChainTimer(280); // a fresher, tighter reading
  assert.ok(cw.state.chainDeadline < loose, "a tighter bound must win");
  cw.noteChainTimer(295); // a staler, looser reading
  assert.ok(cw.state.chainDeadline < loose, "a looser bound must be ignored");

  cw.noteChainHits(21); // a hit landed → previous bounds describe a dead run
  assert.equal(cw.state.chainDeadline, null);
});

// --- chainRemaining source precedence --------------------------------------------------

test("chainRemaining prefers the absolute deadline over the decaying timeout", () => {
  resetState();
  cw.state.chain = {
    active: true, current: 50,
    deadlineLocalMs: Date.now() + 200e3,
    timeout: 999,                       // deliberately wrong
    fetchedAt: Date.now() - 500e3,      // deliberately ancient
  };
  assert.ok(Math.abs(cw.chainRemaining() - 200) <= 1, `expected ~200s, got ${cw.chainRemaining()}`);
});

test("chainRemaining never goes negative once the deadline passes", () => {
  resetState();
  cw.state.chain = { active: true, current: 50, deadlineLocalMs: Date.now() - 60e3, fetchedAt: Date.now() };
  assert.equal(cw.chainRemaining(), 0);
});

// --- Schedule form validation ----------------------------------------------------------

test("validateSchedule accepts a good entry and rejects each bad field", () => {
  const ok = cw.validateSchedule("Chain Night", "2026-08-14 20:00", "6");
  assert.equal(ok.error, undefined);
  assert.equal(ok.value.title, "Chain Night");
  assert.equal(ok.value.duration_hours, 6);
  assert.ok(ok.value.starts_at.endsWith("Z"), "start must be stored as UTC ISO");

  assert.ok(cw.validateSchedule("", "2026-08-14 20:00", "6").error, "empty title");
  assert.ok(cw.validateSchedule("X", "not a date", "6").error, "bad start");
  assert.ok(cw.validateSchedule("X", "garbage", "6").error, "lenient Date parser must not yield year 2000");
  assert.ok(cw.validateSchedule("X", "2026-02-31 20:00", "6").error, "calendar-invalid date must not roll into March");
  assert.ok(cw.validateSchedule("X", "2026-08-14 20:00", "0").error, "0 hours");
  assert.ok(cw.validateSchedule("X", "2026-08-14 20:00", "25").error, "25 hours");
  assert.ok(cw.validateSchedule("X", "2026-08-14 20:00", "2.5").error, "fractional hours");
});

test("parseTctInput reads bare times as UTC and rejects junk outright", () => {
  assert.equal(cw.parseTctInput("2026-08-14 20:00"), "2026-08-14T20:00:00.000Z");
  // Regression: new Date("garbage:00Z") returns 1 Jan 2000 in V8, so the shape has to be
  // validated before Date ever sees it.
  for (const bad of ["garbage", "not a date", "", "   ", "2026-02-31 20:00", "2026-13-45 99:99"]) {
    assert.equal(cw.parseTctInput(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

// --- Small pure helpers ----------------------------------------------------------------

test("parseTargetIds dedupes, orders and ignores junk", () => {
  assert.deepEqual(cw.parseTargetIds("123, 456\n789"), [123, 456, 789]);
  assert.deepEqual(cw.parseTargetIds("123,123,456"), [123, 456]);
  assert.deepEqual(cw.parseTargetIds("https://www.torn.com/profiles.php?XID=4321"), [4321]);
  assert.deepEqual(cw.parseTargetIds(""), []);
});

test("parseThresholds sorts descending and drops out-of-range values", () => {
  assert.deepEqual(cw.parseThresholds("10,60,30", null), [60, 30, 10]);
  assert.deepEqual(cw.parseThresholds("0,-5,99999", null), null);
  assert.deepEqual(cw.parseThresholds("", [60]), [60]);
});

test("validHttpUrl allows only http(s)", () => {
  assert.equal(cw.validHttpUrl("https://torn.com/x"), "https://torn.com/x");
  assert.equal(cw.validHttpUrl("javascript:alert(1)"), "");
  assert.equal(cw.validHttpUrl("data:text/html,x"), "");
  assert.equal(cw.validHttpUrl(""), "");
});

test("compareVersions orders correctly — the handshake that disabled everyone's actions", () => {
  assert.equal(cw.compareVersions("0.18.0", "0.20.0"), -1);
  assert.equal(cw.compareVersions("0.21.0", "0.21.0"), 0);
  assert.equal(cw.compareVersions("0.21.0", "0.9.0"), 1);
  assert.equal(cw.compareVersions("1.0", "1.0.0"), 0);
});

test("extractSignupToken pulls the token out of a link or passes one through", () => {
  assert.equal(cw.extractSignupToken("https://host/chain/e/abc123"), "abc123");
  assert.equal(cw.extractSignupToken("abc123"), "abc123");
  assert.equal(cw.extractSignupToken(""), "");
});

test("nextBonus and duration format as the panel expects", () => {
  assert.deepEqual(cw.nextBonus(7), { target: 10, toGo: 3 });
  assert.deepEqual(cw.nextBonus(10), { target: 25, toGo: 15 });
  assert.equal(cw.nextBonus(100000), null);
  assert.equal(cw.duration(65), "01:05");
  assert.equal(cw.duration(-5), "00:00");
  assert.equal(cw.duration(3700), "1h 01m");
});

// --- Leaderboard windowing -------------------------------------------------------------

test("parseAttacks keeps faction hits inside the chain window and drops the rest", () => {
  const t = nowSec();
  const roster = new Set([111, 222]);
  const raw = {
    attacks: [
      { attacker_id: 111, attacker_name: "Alice", defender_name: "X", respect_gain: 3, timestamp_ended: t - 10 },
      { attacker_id: 222, attacker_name: "Bob", defender_name: "Y", respect_gain: 5, timestamp_ended: t - 20 },
      { attacker_id: 111, attacker_name: "Alice", defender_name: "Z", respect_gain: 4, timestamp_ended: t - 30 },
      { attacker_id: 999, attacker_name: "Enemy", defender_name: "Us", respect_gain: 9, timestamp_ended: t - 5 },
      { attacker_id: 111, attacker_name: "Alice", defender_name: "Old", respect_gain: 7, timestamp_ended: t - 9999 },
      { attacker_id: 0, attacker_name: "Stealth", defender_name: "Q", respect_gain: 1, timestamp_ended: t - 12 },
    ],
  };
  const out = cw.parseAttacks(raw, 111, t - 600, roster);
  const names = out.leaderboard.map((r) => r.name);
  assert.ok(!names.includes("Enemy"), "incoming enemy hits must be excluded");
  assert.equal(out.mine.hits, 2, "the previous chain's hit is outside the window");
  const alice = out.leaderboard.find((r) => r.name === "Alice");
  assert.equal(alice.hits, 2);
  assert.equal(alice.respect, 7);
  assert.equal(out.last.attackerName, "Alice", "most recent in-window hit");
});

// --- Backend fallback shape ------------------------------------------------------------

test("serverLiveChain converts the backend block and claims no absolute deadline", () => {
  const c = cw.serverLiveChain({
    live_chain: { chain: { current: 42, timeout: 180, max: 90, start: 1700000000 }, fetched_at: new Date().toISOString() },
  });
  assert.equal(c.active, true);
  assert.equal(c.current, 42);
  assert.equal(c.start, 1700000000, "start must survive so the leaderboard window is right");
  assert.equal(c.deadlineLocalMs, null);
  assert.equal(cw.serverLiveChain({}), null);
});

// --- Name resolution: the backend can't do it for an identity-only session -------------
// chain-watch's loadRoster returns [] when the session carries no key and its 25s roster
// cache is cold, so decorateShifts falls back to the stored "ID <n>". We hold the key
// locally, so the panel resolves names itself.

test("parseRoster reads the v2 array and the legacy id-keyed object", () => {
  const v2 = cw.parseRoster({ members: [{ id: 111, name: "Alice", last_action: { status: "Online" } }] });
  assert.equal(v2[111].name, "Alice");
  assert.equal(v2[111].status, "Online");

  const legacy = cw.parseRoster({ members: { 222: { id: 222, name: "Bob", last_action: { status: "Idle" } } } });
  assert.equal(legacy[222].name, "Bob");

  assert.equal(cw.parseRoster({ members: [] }), null);
  assert.equal(cw.parseRoster({}), null);
});

test("rosterName prefers our own roster over an ID placeholder", () => {
  resetState();
  cw.state.tornRoster = null;
  assert.equal(cw.rosterName(111, "ID 111"), "ID 111", "nothing to resolve with yet");

  cw.state.tornRoster = { 111: { name: "Alice", status: "Online" } };
  assert.equal(cw.rosterName(111, "ID 111"), "Alice");
  assert.equal(cw.rosterName(999, "ID 999"), "ID 999", "unknown id keeps the fallback");
});

test("rosterName ignores a payload name that is itself an ID placeholder", () => {
  resetState();
  cw.state.tornRoster = { 111: { name: "Alice", status: "Online" } };
  cw.state.watch = { roster: [{ id: 111, name: "ID 111" }] };
  assert.equal(cw.rosterName(111, "ID 111"), "Alice");
});

test("rosterStatus fills in an online status the backend left null", () => {
  resetState();
  cw.state.tornRoster = { 111: { name: "Alice", status: "Online" } };
  assert.equal(cw.rosterStatus(111, null), "Online");
  assert.equal(cw.rosterStatus(111, "Idle"), "Idle", "a real payload value still wins");
});

test("profileLink builds a Torn profile link and escapes the name", () => {
  const html = cw.profileLink(111, 'A<b>"x"');
  assert.ok(html.includes("profiles.php?XID=111"));
  assert.ok(!html.includes("<b>"), "name must be escaped");
  assert.equal(cw.profileLink(0, "Nobody"), "Nobody", "no id → plain text, not a broken link");
});

test("absentMembers carries the player id through on both payload shapes", () => {
  resetState();
  cw.state.watch = {
    absences: [
      { player_id: 111, player_name: "ID 111", cleared_at: null },
      { player_id: 222, player_name: "Bob", cleared_at: "2026-01-01T00:00:00Z" },
    ],
  };
  const session = cw.absentMembers();
  assert.equal(session.length, 1, "cleared absences are excluded");
  assert.equal(session[0].id, 111, "the id must survive — this is what was being dropped");

  resetState();
  cw.state.signup = { absent: [{ id: 333, name: "Carol" }] };
  assert.equal(cw.absentMembers()[0].id, 333);
});

// --- allShifts: the one place the two payload shapes are reconciled --------------------
// Five functions each re-derived this branch and two got it wrong (currentAndNextShift
// read only the session shape; absentMembers dropped the player id). It lives here now,
// so these tests guard the single point of failure rather than five copies of it.

test("allShifts yields the same normalized rows from either payload shape", () => {
  const start = new Date(Date.now() - 3600e3).toISOString();
  const end = new Date(Date.now() + 3600e3).toISOString();

  resetState();
  cw.state.watch = {
    shifts: [{
      id: 4, shift_start: start, shift_end: end,
      watcher_id: 111, watcher_name: "Alice", watcher_online_status: "Online", locked: true,
      backup_watcher_id: 222, backup_watcher_name: "Bob", backup_watcher_online_status: "Idle",
    }],
  };
  const fromSession = cw.allShifts();

  resetState();
  cw.state.signup = {
    shifts: [{
      id: 4, shift_start: start, shift_end: end,
      main: { watcher_id: 111, watcher_name: "Alice", online_status: "Online", filled: true, locked: true },
      backup: { watcher_id: 222, watcher_name: "Bob", online_status: "Idle", filled: true },
    }],
  };
  const fromToken = cw.allShifts();

  assert.deepEqual(fromToken, fromSession, "both shapes must normalize identically");
  assert.equal(fromSession[0].main.name, "Alice");
  assert.equal(fromSession[0].backup.id, 222);
  assert.equal(fromSession[0].main.locked, true);
});

test("allShifts treats an unassigned slot as unfilled in both shapes", () => {
  const start = new Date().toISOString();
  const end = new Date(Date.now() + 3600e3).toISOString();

  resetState();
  cw.state.watch = { shifts: [{ id: 1, shift_start: start, shift_end: end, watcher_id: null }] };
  assert.equal(cw.allShifts()[0].main.filled, false);
  assert.equal(cw.coverageGaps().length, 1);

  resetState();
  cw.state.signup = { shifts: [{ id: 1, shift_start: start, shift_end: end, main: { filled: false } }] };
  assert.equal(cw.allShifts()[0].main.filled, false);
  assert.equal(cw.coverageGaps().length, 1);
});

test("a signup slot marked filled counts as covered even with the id redacted", () => {
  // The signup payload can report `filled` without exposing who — inferring from the id
  // alone would call a staffed slot an unmanned gap and fire the coverage alarm.
  resetState();
  cw.state.signup = {
    shifts: [{
      id: 1,
      shift_start: new Date().toISOString(),
      shift_end: new Date(Date.now() + 3600e3).toISOString(),
      main: { filled: true },
    }],
  };
  assert.equal(cw.allShifts()[0].main.filled, true);
  assert.equal(cw.coverageGaps().length, 0, "a filled-but-anonymous slot is not a gap");
});

test("viewerShifts finds both main and backup holdings in either shape", () => {
  const start = new Date(Date.now() + 3600e3).toISOString();
  const end = new Date(Date.now() + 7200e3).toISOString();

  resetState();
  cw.state.watch = {
    viewer: { player_id: 111 },
    shifts: [{ id: 1, shift_start: start, shift_end: end, watcher_id: 111, backup_watcher_id: 222 }],
  };
  assert.equal(cw.allShifts()[0].main.id, 111);
  assert.equal(cw.allShifts()[0].backup.id, 222);

  resetState();
  cw.state.signup = {
    viewer: { player_id: 222 },
    shifts: [{ id: 1, shift_start: start, shift_end: end, main: { watcher_id: 111 }, backup: { watcher_id: 222 } }],
  };
  assert.equal(cw.allShifts()[0].backup.id, 222);
});

test("coversAt is inclusive of the start and exclusive of the end", () => {
  const s = { start: "2026-08-14T12:00:00.000Z", end: "2026-08-14T13:00:00.000Z" };
  const at = (iso) => new Date(iso).getTime();
  assert.equal(cw.coversAt(s, at("2026-08-14T12:00:00.000Z")), true, "starts count");
  assert.equal(cw.coversAt(s, at("2026-08-14T12:30:00.000Z")), true);
  assert.equal(cw.coversAt(s, at("2026-08-14T13:00:00.000Z")), false, "the end belongs to the next slot");
  assert.equal(cw.coversAt(s, at("2026-08-14T11:59:59.000Z")), false);
});

// --- Leaderboard accuracy -------------------------------------------------------------
// Two independent faults made this board wrong in the field: the faction-member filter
// was built from the backend roster (empty for an identity-only session, so it silently
// became a no-op and enemies who hit US were listed as our top hitters), and every attack
// row was counted as a chain hit including losses and escapes, which never extend a chain.

test("incoming enemy attacks are excluded when the roster is known", () => {
  const t = nowSec();
  const raw = { attacks: [
    { attacker_id: 111, attacker_name: "Alice", defender_name: "Enemy", respect_gain: 4, timestamp_ended: t - 10, chain: 51 },
    { attacker_id: 999, attacker_name: "EnemyGuy", defender_name: "Bob", respect_gain: 9, timestamp_ended: t - 20, chain: 0 },
  ] };
  const out = cw.parseAttacks(raw, 111, t - 600, new Set([111, 222]));
  assert.deepEqual(out.leaderboard.map((r) => r.name), ["Alice"]);
  assert.equal(out.last.attackerName, "Alice", "the last attack must be OURS, not theirs");
});

test("attacks that did not extend the chain are not counted as hits", () => {
  const t = nowSec();
  const raw = { attacks: [
    { attacker_id: 111, attacker_name: "Alice", defender_name: "A", respect_gain: 4, timestamp_ended: t - 10, chain: 51 },
    { attacker_id: 111, attacker_name: "Alice", defender_name: "B", respect_gain: 0, timestamp_ended: t - 20, chain: 0, result: "Lost" },
    { attacker_id: 111, attacker_name: "Alice", defender_name: "C", respect_gain: 0, timestamp_ended: t - 30, result: "Escape" },
  ] };
  const out = cw.parseAttacks(raw, 111, t - 600, new Set([111]));
  assert.equal(out.leaderboard[0].hits, 1, "only the hit with chain > 0 counts");
  assert.equal(out.mine.hits, 1, "and your own total must match");
});

test("a row with no chain field and an ordinary result still counts", () => {
  // Only POSITIVE evidence of a miss should exclude a row — a shape change must not
  // silently empty the board.
  const t = nowSec();
  const raw = { attacks: [
    { attacker_id: 111, attacker_name: "Alice", defender_name: "A", respect_gain: 4, timestamp_ended: t - 10, result: "Mugged" },
    { attacker_id: 111, attacker_name: "Alice", defender_name: "B", respect_gain: 4, timestamp_ended: t - 20 },
  ] };
  const out = cw.parseAttacks(raw, 111, t - 600, new Set([111]));
  assert.equal(out.leaderboard[0].hits, 2);
});

test("parseAttacks reports how many hits the sample actually covers", () => {
  // Torn returns ~100 attacks, so on a long chain this is a recent window, not the whole
  // chain — the card says so rather than showing totals that look simply wrong.
  const t = nowSec();
  const raw = { attacks: [
    { attacker_id: 111, attacker_name: "Alice", defender_name: "A", respect_gain: 4, timestamp_ended: t - 10, chain: 51 },
    { attacker_id: 222, attacker_name: "Bob", defender_name: "B", respect_gain: 3, timestamp_ended: t - 20, chain: 50 },
  ] };
  assert.equal(cw.parseAttacks(raw, 111, t - 600, new Set([111, 222])).counted, 2);
});

// --- The leaderboard window --------------------------------------------------------
// Reported from a live chain: a warm-up at 2/10 hits (both from one player) showed 5-10
// faction members each with multiple hits, then corrected itself seconds later. The
// window was computed from state.chain BEFORE the chain fetch resolved, so on the poll
// where a chain begins it saw the previous (null) chain and fell back to a rolling 4h.

test("the window follows a running chain, not the clock", () => {
  const start = nowSec() - 120;
  assert.equal(
    cw.leaderboardWindowStart({ active: true, start }), start,
    "a live chain must window to its own start",
  );
});

test("the window falls back to a rolling 4h only when no chain is running", () => {
  const fourHoursAgo = nowSec() - 4 * 3600;
  for (const chain of [null, { active: false, start: 0 }, { active: true, start: 0 }]) {
    const got = cw.leaderboardWindowStart(chain);
    assert.ok(Math.abs(got - fourHoursAgo) <= 2, `expected ~4h ago for ${JSON.stringify(chain)}`);
  }
});

test("a chain that just began windows to itself, not to four hours of history", () => {
  // The exact reported state: warm-up, 2 hits, chain started seconds ago.
  const start = nowSec() - 30;
  const chain = { active: true, current: 2, start };
  const win = cw.leaderboardWindowStart(chain);

  const raw = { attacks: [
    { attacker_id: 111, attacker_name: "Alice", defender_name: "A", respect_gain: 4, timestamp_ended: start + 5, chain: 1 },
    { attacker_id: 111, attacker_name: "Alice", defender_name: "B", respect_gain: 4, timestamp_ended: start + 20, chain: 2 },
    // Everything below is from BEFORE this chain and must not appear.
    { attacker_id: 222, attacker_name: "Bob", defender_name: "C", respect_gain: 3, timestamp_ended: start - 600, chain: 40 },
    { attacker_id: 333, attacker_name: "Carol", defender_name: "D", respect_gain: 3, timestamp_ended: start - 3000, chain: 12 },
  ] };
  const out = cw.parseAttacks(raw, 111, win, new Set([111, 222, 333]));
  assert.deepEqual(out.leaderboard.map((r) => r.name), ["Alice"]);
  assert.equal(out.leaderboard[0].hits, 2, "must match the chain counter, not the last 4h");
  assert.equal(out.counted, 2);
});

test("factionMemberIds prefers our own roster and falls back to the payload's", () => {
  resetState();
  cw.state.tornRoster = { 111: { name: "Alice" }, 222: { name: "Bob" } };
  assert.deepEqual([...cw.factionMemberIds()].sort((a, b) => a - b), [111, 222]);

  resetState();
  cw.state.tornRoster = null;
  cw.state.watch = { roster: [{ id: 333, name: "Carol" }] };
  assert.deepEqual([...cw.factionMemberIds()], [333]);

  resetState();
  cw.state.tornRoster = null;
  assert.equal(cw.factionMemberIds().size, 0, "no roster => no filter, rather than a wrong one");
});
