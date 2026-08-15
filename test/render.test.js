// Render-layer tests for Torn Overseer Chain Watch.
//
// SCOPE — worth being precise about, because it's easy to over-trust these:
//
//   jsdom has NO layout engine. It computes no widths and applies no CSS, so it could not
//   have caught the PDA button-overlap; only a real browser can. Anything about how things
//   LOOK still needs a human on a phone.
//
//   What it does cover is the class of bug that lives in how the panel REBUILDS itself —
//   a background poll wiping a half-typed form, <details> snapping shut, a card rendering
//   when it has nothing to show, a name going through unescaped. Every one of those
//   shipped to members, and none of them is visible to `node --check` or the pure tests.
//
// The module is required WITHOUT a DOM (so it exports rather than booting), then a jsdom
// document is attached to the globals afterwards. The render functions resolve `document`
// at call time, so they pick it up.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");

const cw = require("../Torn-Overseer-Chain-Watch.user.js");

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  url: "https://www.torn.com/",
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
// Node 24 defines `navigator` as a getter-only global, so it can't be reassigned. The
// panel only reaches for navigator.vibrate / wakeLock, both optional-chained.
Object.defineProperty(global, "navigator", { value: dom.window.navigator, configurable: true });

const panel = () => document.getElementById("tocw");
const html = () => panel()?.innerHTML ?? "";

function resetState() {
  Object.assign(cw.state, {
    loading: false, error: null, notice: null,
    watch: null, signup: null, chain: null, attacks: null,
    liveSource: null, settingsOpen: false, focus: false, hidden: false, collapsed: false,
    chainConfirmedAt: null, scheduleConfirmedAt: Date.now(),
    tornRoster: null, rosterAt: null, slotAction: null, scheduleOpen: false,
    settingsExpandConnection: false, connectionWasOpen: false,
    tornFailCount: 0, chainSummary: null,
  });
  try { localStorage.clear(); } catch { /* ignore */ }
}

// --- The form-wipe bug: a poll must not rebuild an open form --------------------------

test("a background render leaves an open settings form untouched", () => {
  resetState();
  cw.state.settingsOpen = true;
  cw.render();

  const key = document.getElementById("tocw-set-torn-key");
  assert.ok(key, "settings should be on screen");
  key.value = "half-typed-key";          // stand-in for a member mid-edit
  const before = panel().innerHTML;

  cw.render({ background: true });        // what the poll loop does every few seconds

  assert.equal(panel().innerHTML, before, "a background render must not rebuild the form");
  assert.equal(
    document.getElementById("tocw-set-torn-key").value,
    "half-typed-key",
    "in-progress typing must survive the poll — this is the bug members reported",
  );
});

test("an interaction-driven render still rebuilds the settings form", () => {
  resetState();
  cw.state.settingsOpen = true;
  cw.render();
  document.getElementById("tocw-set-torn-key").value = "scratch";

  cw.render(); // no background flag => a real interaction

  assert.equal(
    document.getElementById("tocw-set-torn-key").value, "",
    "a deliberate re-render should reset to stored values",
  );
});

test("Connection & setup stays open across a rebuild, and opens itself with no key", () => {
  resetState();
  cw.state.settingsOpen = true;
  cw.render();

  const details = document.getElementById("tocw-conn-details");
  assert.ok(details, "the connection section should exist");
  assert.equal(details.open, true, "with no key set, the key field must not be hidden away");

  // Simulate the member having a key, then collapsing it themselves.
  cw.state.connectionWasOpen = true;
  cw.render();
  assert.equal(document.getElementById("tocw-conn-details").open, true, "remembered open state survives");
});

// --- Cards that should not render at all ----------------------------------------------

test("a needs_verification signup payload renders no shifts card", () => {
  // It used to draw an empty sheet under "Signups are closed for this chain", which is
  // not what is happening — the caller just isn't verified yet.
  resetState();
  cw.state.signup = { event: { title: "Chain Night", phase: "open" }, needs_verification: true };
  assert.equal(cw.renderSignupShifts(), "");
});

test("the key gate appears with no key and names what it unlocks", () => {
  resetState();
  const gate = cw.renderKeyGate();
  assert.match(gate, /Torn API key/i);
  assert.match(gate, /tocw-key-setup/, "must offer the button that opens Settings");
});

test("the panel badges NO KEY rather than implying a working keyless mode", () => {
  resetState();
  cw.render();
  assert.match(html(), /NO KEY/, "should not claim CACHED or SITE SYNC without a key");
  assert.doesNotMatch(html(), /SITE SYNC/);
});

// --- Escaping -------------------------------------------------------------------------

test("a hostile member name is escaped everywhere it is rendered", () => {
  resetState();
  const nasty = '<img src=x onerror=alert(1)>';
  cw.state.tornRoster = { 111: { name: nasty, status: "Online" } };
  const shift = {
    id: 1,
    shift_start: new Date(Date.now() - 3600e3).toISOString(),
    shift_end: new Date(Date.now() + 3600e3).toISOString(),
    watcher_id: 111, watcher_name: nasty, watcher_online_status: "Online",
  };
  const out = cw.renderSlot(shift, "main", { player_id: 999, can_manage: true }, false);
  assert.doesNotMatch(out, /<img/, "the name must be escaped, not injected");
  assert.match(out, /&lt;img/);
});

// --- Structure the CSS depends on -----------------------------------------------------

test("a filled slot renders the who/actions containers the layout relies on", () => {
  resetState();
  const shift = {
    id: 1,
    shift_start: new Date().toISOString(),
    shift_end: new Date(Date.now() + 3600e3).toISOString(),
    watcher_id: 111, watcher_name: "Alice", watcher_online_status: "Online",
  };
  const out = cw.renderSlot(shift, "main", { player_id: 999, can_manage: true }, false);
  assert.match(out, /tocw-slot__who/);
  assert.match(out, /tocw-slot__actions/);
  // The status WORD is tagged separately so narrow screens can drop it without losing
  // the dot; if this class goes away the mobile rule silently stops applying.
  assert.match(out, /tocw-slot__status/);
});

test("a manager sees assign/clear/lock and a member does not", () => {
  resetState();
  const shift = {
    id: 1,
    shift_start: new Date().toISOString(),
    shift_end: new Date(Date.now() + 3600e3).toISOString(),
    watcher_id: 111, watcher_name: "Alice", watcher_online_status: "Online",
  };
  const asManager = cw.renderSlot(shift, "main", { player_id: 999, can_manage: true }, false);
  assert.match(asManager, /data-tocw-action="assign"/);
  assert.match(asManager, /data-tocw-action="lock"/);

  const asMember = cw.renderSlot(shift, "main", { player_id: 999, can_manage: false }, false);
  assert.doesNotMatch(asMember, /data-tocw-action="assign"/);
  assert.doesNotMatch(asMember, /data-tocw-action="lock"/);
  assert.doesNotMatch(asMember, /data-tocw-action="clear"/, "not their slot, so no Leave either");
});

test("a member CAN leave their own slot", () => {
  resetState();
  const shift = {
    id: 1,
    shift_start: new Date().toISOString(),
    shift_end: new Date(Date.now() + 3600e3).toISOString(),
    watcher_id: 111, watcher_name: "Alice", watcher_online_status: "Online",
  };
  const own = cw.renderSlot(shift, "main", { player_id: 111, can_manage: false }, false);
  assert.match(own, /data-tocw-action="clear"/);
  assert.match(own, />Leave</, "labelled Leave, not Clear, when it's your own");
});

test("a read-only (finalized) sheet offers no actions at all", () => {
  resetState();
  const shift = {
    id: 1,
    shift_start: new Date().toISOString(),
    shift_end: new Date(Date.now() + 3600e3).toISOString(),
    watcher_id: 111, watcher_name: "Alice", watcher_online_status: "Online",
  };
  const out = cw.renderSlot(shift, "main", { player_id: 999, can_manage: true }, true);
  assert.doesNotMatch(out, /data-tocw-action/);
});

// --- The inline roster picker (replaces window.prompt) --------------------------------

test("rosterList prefers our own roster and sorts by name", () => {
  resetState();
  cw.state.tornRoster = {
    222: { name: "bob", status: "Idle" },
    111: { name: "Alice", status: "Online" },
  };
  const list = cw.rosterList();
  assert.deepEqual(list.map((m) => m.name), ["Alice", "bob"]);
});

test("filterRoster matches on name substring and on id prefix", () => {
  const list = [
    { id: 111, name: "Alice", status: null },
    { id: 2345, name: "Bob", status: null },
  ];
  assert.deepEqual(cw.filterRoster(list, "ali").map((m) => m.id), [111]);
  assert.deepEqual(cw.filterRoster(list, "LIC").map((m) => m.id), [111], "case-insensitive");
  assert.deepEqual(cw.filterRoster(list, "23").map((m) => m.id), [2345], "id prefix");
  assert.equal(cw.filterRoster(list, "").length, 2);
});

test("the assign picker lists the roster instead of asking for an exact name", () => {
  resetState();
  cw.state.tornRoster = { 111: { name: "Alice", status: "Online" }, 222: { name: "Bob", status: "Idle" } };
  cw.state.watch = {
    shifts: [{
      id: 7,
      shift_start: "2026-08-14T12:00:00.000Z",
      shift_end: "2026-08-14T13:00:00.000Z",
      watcher_id: null,
    }],
  };
  cw.state.slotAction = { kind: "assign", shiftId: 7, role: "main", query: "", error: null, busy: false };
  const out = cw.renderSlotActionForm();
  assert.match(out, /data-tocw-pick="111"/);
  assert.match(out, /data-tocw-pick="222"/);
  assert.match(out, /12:00–13:00 TCT/, "says which slot is being filled");

  cw.state.slotAction.query = "bo";
  const filtered = cw.renderSlotActionForm();
  assert.doesNotMatch(filtered, /data-tocw-pick="111"/);
  assert.match(filtered, /data-tocw-pick="222"/);
});

test("an unknown player ID can still be assigned when the roster is unavailable", () => {
  resetState();
  cw.state.tornRoster = null;
  cw.state.watch = { shifts: [{ id: 7, shift_start: "2026-08-14T12:00:00.000Z", shift_end: "2026-08-14T13:00:00.000Z" }] };
  cw.state.slotAction = { kind: "assign", shiftId: 7, role: "main", query: "987654", error: null, busy: false };
  const out = cw.renderSlotActionForm();
  assert.match(out, /data-tocw-pick="987654"/, "typing a bare ID must remain a way through");
});

test("the clear confirmation names the person and the slot", () => {
  resetState();
  cw.state.tornRoster = { 111: { name: "Alice", status: "Online" } };
  cw.state.watch = {
    shifts: [{
      id: 7,
      shift_start: "2026-08-14T12:00:00.000Z",
      shift_end: "2026-08-14T13:00:00.000Z",
      watcher_id: 111, watcher_name: "Alice",
    }],
  };
  cw.state.slotAction = { kind: "clear", shiftId: 7, role: "main", query: "", error: null, busy: false };
  const out = cw.renderSlotActionForm();
  assert.match(out, /Alice/, 'a bare "Clear this slot?" never said who');
  assert.match(out, /12:00–13:00 TCT/);
  assert.match(out, /tocw-slot-confirm/);
});

// --- Profile links --------------------------------------------------------------------

test("watcher names link to their Torn profile", () => {
  resetState();
  cw.state.tornRoster = { 111: { name: "Alice", status: "Online" } };
  const out = cw.renderSlot(
    {
      id: 1,
      shift_start: new Date().toISOString(),
      shift_end: new Date(Date.now() + 3600e3).toISOString(),
      watcher_id: 111, watcher_name: "ID 111", watcher_online_status: null,
    },
    "main", { player_id: 999, can_manage: false }, false,
  );
  assert.match(out, /profiles\.php\?XID=111/);
  assert.match(out, />Alice</, "the locally-fetched roster resolves the ID placeholder");
});

// --- Online status: the panel must not accuse a watcher it can't vouch for -------------

// A live chain with one in-progress shift, which is what puts the "Current watcher" card
// and its offline alert on screen.
function liveChainWithWatcher(payloadStatus) {
  resetState();
  cw.state.chain = { active: true, current: 40, timeout: 200, fetchedAt: Date.now(), start: Math.floor(Date.now() / 1000) - 600 };
  cw.state.chainConfirmedAt = Date.now();
  cw.state.liveSource = "torn";
  cw.state.watch = {
    event: { title: "Chain Night", status: "published", starts_at: new Date(Date.now() - 600e3).toISOString() },
    viewer: { player_id: 999, can_manage: false },
    shifts: [{
      id: 1,
      shift_start: new Date(Date.now() - 1800e3).toISOString(),
      shift_end: new Date(Date.now() + 1800e3).toISOString(),
      watcher_id: 111, watcher_name: "Alice", watcher_online_status: payloadStatus,
    }],
  };
}

test("an unknown online status does not render as offline", () => {
  // The backend serves no roster to an identity-only session, so the flag is null — which
  // the panel used to compare `!== "Online"` and announce as the watcher being away.
  liveChainWithWatcher(null);
  cw.render();
  assert.match(html(), /Alice/, "the watcher card should be on screen");
  assert.doesNotMatch(html(), /not online/, "no reading is not evidence of absence");
  assert.match(html(), /Unknown/, "say we don't know instead");
});

test("the watcher card and the offline alert cannot disagree", () => {
  // Exactly what members saw: the card said Online — resolved from our own roster fetch —
  // while the alert underneath said the watcher was not online, because it read the raw
  // payload flag (null) instead. One fact, two code paths, two answers. Both now go
  // through statusInfo with the same arguments, so the pair can't come apart again.
  liveChainWithWatcher(null);
  cw.state.tornRoster = { 111: { name: "Alice", status: "Online" } };
  cw.state.rosterAt = Date.now();
  cw.render();

  assert.match(html(), /Online/, "our roster resolves them as online");
  assert.doesNotMatch(html(), /not online/, "so the alert must not contradict the card");
});

test("a confirmed offline status is still called out", () => {
  liveChainWithWatcher("Offline");
  cw.state.scheduleConfirmedAt = Date.now();
  cw.render();
  assert.match(html(), /is Offline, not online/, "a fresh reading may still raise the alarm");
});

test("a watcher who is actively hitting is never shown as offline", () => {
  liveChainWithWatcher("Offline");
  cw.state.scheduleConfirmedAt = Date.now() - 60e3;
  cw.state.attacks = { leaderboard: [], last: null, error: null, hitAt: { 111: Math.floor(Date.now() / 1000) - 4 } };
  cw.render();
  assert.doesNotMatch(html(), /not online/, "a hit that just landed outranks a minute-old roster");
});

// --- Times that must keep moving between polls ----------------------------------------

test("relative times tick without a rebuild", () => {
  // "Last attack … ago" was baked into the HTML, so it only moved when a poll rebuilt the
  // panel — advancing in 3-second jumps and sitting frozen in between.
  liveChainWithWatcher("Online");
  const ts = Math.floor(Date.now() / 1000) - 5;
  cw.state.attacks = { leaderboard: [], error: null, hitAt: {}, last: { attackerId: 111, attackerName: "Alice", defenderName: "Foe", timestamp: ts } };
  cw.render();

  const span = panel().querySelector("[data-tocw-since]");
  assert.ok(span, "the elapsed time needs an anchor tick() can find");
  assert.equal(span.textContent, "00:05");

  span.setAttribute("data-tocw-since", String(ts - 7)); // stand in for 7s passing
  cw.tickRelativeTimes(panel());
  assert.equal(span.textContent, "00:12", "tick rewrites it in place, no rebuild");
});
