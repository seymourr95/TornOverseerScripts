// ==UserScript==
// @name         Torn Overseer Chain Watch
// @namespace    torn-overseer
// @version      0.25.0
// @description  Watcher-focused chain HUD: zero-lag live drop timer + hits from Torn, opt-in drop/shift alarms (sound/vibrate/flash), active + your-slot highlight, shift signup. Read-only — never attacks for you.
// @author       OverSeerFulgrim, BreadHerring
// @license      MIT
// @supportURL   https://github.com/OverSeerFulgrim/TornOverseerScripts/issues
// @downloadURL  https://raw.githubusercontent.com/OverSeerFulgrim/TornOverseerScripts/main/Torn-Overseer-Chain-Watch.user.js
// @updateURL    https://raw.githubusercontent.com/OverSeerFulgrim/TornOverseerScripts/main/Torn-Overseer-Chain-Watch.user.js
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_notification
// @connect      ijolgywtybadfuvyopeg.supabase.co
// @connect      api.torn.com
// @run-at       document-end
// ==/UserScript==

(function () {
  "use strict";

  // Under Node (the unit tests) there is no window/document. The pure logic below — chain
  // parsing, freshness maths, shift resolution — is where the bugs that reached members
  // actually lived, and none of it needs a DOM. Guarding the two browser-only touchpoints
  // (this load-once latch, and boot() at the very bottom) makes that logic testable while
  // staying completely inert in the userscript itself.
  const IS_BROWSER = typeof window !== "undefined" && typeof document !== "undefined";
  if (IS_BROWSER) {
    if (window.__tornOverseerChainWatchLoaded) return;
    window.__tornOverseerChainWatchLoaded = true;
  }

  // Read the version from the userscript header via GM_info so it can NEVER drift from
  // @version again (it silently sat at 0.18.0 through two releases, which made the
  // backend's min_script_version handshake declare up-to-date users "out of date" and
  // disable their actions). The literal is only a fallback for hosts without GM_info.
  const VERSION =
    (typeof GM_info === "object" && GM_info && GM_info.script && typeof GM_info.script.version === "string"
      ? GM_info.script.version
      : "") || "0.25.0";
  const UPDATE_URL = "https://raw.githubusercontent.com/OverSeerFulgrim/TornOverseerScripts/main/Torn-Overseer-Chain-Watch.user.js";
  // The Overseer web app host — used for the "open the site to publish" deep-link and the
  // manual paste-a-link placeholder in Settings. (The script no longer runs on the site;
  // signup links are bound by pasting them in Settings, not auto-captured.)
  const OVERSEER_HOST = "torn-overseer-v2.pages.dev";
  const DEFAULT_FUNCTIONS_URL = "https://ijolgywtybadfuvyopeg.supabase.co/functions/v1";
  const DEFAULT_ANON_KEY = "sb_publishable_Kz_QcUJAD6wzEdCEr6FbSg_3TO5JXek";
  const PDA_API_KEY = "###PDA-APIKEY###";
  const COMMENT = "TornOverseerChainWatch";
  const BONUS_MILESTONES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];

  // Live-data polling cadence. While a chain is live the HUD is fetched STRAIGHT from
  // Torn (member key) so the hit count + drop timer match torn.com with no backend lag;
  // between chains it eases off, and while hidden it barely ticks.
  const LIVE_POLL_MS = 3000;
  const IDLE_POLL_MS = 20000;
  const HIDDEN_POLL_MS = 60000;
  // Torn allows 100 req/min per ACCOUNT — not per key, so issuing a second key buys
  // nothing. That one budget is shared with every window this script runs in AND every
  // other script the member uses, whatever key each holds. A flat 3s chain poll spent
  // 20/min of it around the clock, most of it on nothing: the drop timer counts down
  // locally between polls anyway, so re-confirming it every 3s only buys something near
  // the drop. Above RELAXED_ABOVE_SEC we ease off; inside it we go back to full speed.
  //
  // The handover point carries real margin on purpose. A relaxed reading can overstate the
  // time left by nearly a full poll interval (~10s), and we then wait another interval
  // before re-reading — so the switch has to happen ~20s of truth before it matters. At
  // 120s, fast polling resumes with ~100s genuinely left, comfortably clear of the highest
  // default alarm threshold (60s). This is the margin that keeps PDA honest, since PDA has
  // no sidebar countdown to fall back on.
  const LIVE_POLL_RELAXED_MS = 10000;
  const RELAXED_ABOVE_SEC = 120;
  const ATTACKS_MIN_INTERVAL = 10000;
  const SCHEDULE_MIN_INTERVAL = 25000;
  // Faction roster, fetched with the member's OWN key. This exists because the backend
  // can no longer resolve names for us: since v0.20.0 the script's session is identity-only
  // (no key stored server-side), and the backend's roster cache has a 25s TTL — so unless
  // some keyed caller happened to refresh it in the last 25 seconds, the payload comes back
  // with an empty roster and every name degrades to "ID 12345" with an unknown online dot.
  // We hold the key locally, so we can just resolve names ourselves. Rosters change slowly.
  const ROSTER_MIN_INTERVAL = 300000;
  // How long a chain snapshot may go unconfirmed before the panel stops presenting it as
  // live truth. Past this the HUD is badged STALE and says why, instead of quietly showing
  // a frozen hit count next to a countdown that keeps running. The Torn path re-confirms
  // every LIVE_POLL_MS so 30s unconfirmed means it's broken; the backend fallback only
  // refreshes on the throttled schedule poll, so it needs a looser bar not to flap.
  const CHAIN_STALE_MS = 30000;
  const CHAIN_STALE_CACHE_MS = 70000;
  // Backoff for consecutive failed direct-Torn reads, so a rate-limited or broken key is
  // not hammered every 3s (which is what keeps it rate-limited).
  const TORN_BACKOFF_MS = [0, 3000, 8000, 20000, 45000];
  // Notices are EVENTS ("shift claimed", "drops in 10s — HIT NOW"), not conditions, but
  // nothing expired them: only a manual Refresh cleared state.notice, so an alarm's text
  // sat in the panel long after it stopped being true. Errors are exempt — refreshAll
  // clears and re-derives those every poll, so they self-heal.
  const NOTICE_TTL_MS = 20000;

  // Watcher alarms: default seconds-to-drop at which to sound off (once each, per chain
  // run); user-overridable in Settings. Plus how early to warn before your own shift.
  const DEFAULT_DROP_THRESHOLDS = [60, 30, 10];
  const SHIFT_WARN_SECS = 300; // 5-minute heads-up before your shift
  // Online status arrives on the throttled schedule poll, so it can be much older than the
  // chain data. Past this the panel stops ASSERTING whether the next watcher is online —
  // "they aren't online" is a claim worth being sure of before it wakes someone up.
  const SCHEDULE_STALE_MS = 120000;
  const PACE_MIN_WINDOW_SEC = 10; // don't compute a hit/min pace off too short a sample
  const HANDOFF_WARN_SECS = 600; // start nagging about the next watcher 10m before your shift ends

  const STORE = {
    tornKey: "tocw_torn_key",
    functionsUrl: "tocw_functions_url",
    anonKey: "tocw_anon_key",
    sessionToken: "tocw_session_token",
    signupToken: "tocw_signup_token",
    claimSecret: "tocw_claim_secret",
    signupIdentity: "tocw_signup_identity",
    collapsed: "tocw_collapsed",
    hidden: "tocw_hidden",
    position: "tocw_position",
    size: "tocw_size",
    launcherPos: "tocw_launcher_pos",
    alarm: "tocw_alarm",
    alarmSound: "tocw_alarm_sound",
    alarmVibrate: "tocw_alarm_vibrate",
    alarmFlash: "tocw_alarm_flash",
    alarmNotify: "tocw_alarm_notify",
    alarmThresholds: "tocw_alarm_thresholds",
    wakeLock: "tocw_wakelock",
    focus: "tocw_focus",
    alarmVolume: "tocw_alarm_volume",
    alarmTone: "tocw_alarm_tone",
    chainGoal: "tocw_chain_goal",
    hitUrl: "tocw_hit_url",
    autoFocus: "tocw_auto_focus",
    alarmVoice: "tocw_alarm_voice",
    celebrate: "tocw_celebrate",
    targetIds: "tocw_target_ids",
    targetIndex: "tocw_target_index",
  };

  // Secrets must live in the userscript manager's per-script GM storage ONLY — never
  // in page (torn.com) localStorage, which the site's own scripts can read. If GM
  // storage is unavailable we refuse to persist them rather than leak to the page.
  // The signup token is a capability (posted in faction chat, but still) and the claim
  // secret proves ownership of a slot, so both are GM-only too.
  const SECRET_KEYS = new Set([STORE.tornKey, STORE.sessionToken, STORE.signupToken, STORE.claimSecret]);

  function hasGmStorage() {
    return typeof GM_getValue === "function" && typeof GM_setValue === "function";
  }

  const state = {
    loading: false,
    error: null,
    notice: null,
    watch: null,
    signup: null,
    chain: null,
    attacks: null,
    fetchedAt: null,
    // Where the live chain HUD/leaderboard currently come from: "torn" (zero-lag,
    // direct from the member key), "cache" (Overseer fallback), or null (nothing yet).
    liveSource: null,
    settingsOpen: false,
    scriptTooOld: false,
    collapsed: readBool(STORE.collapsed, false),
    // Fully hidden: only the "TO" launcher shows. Distinct from collapsed (which
    // keeps a compact header). Needed on mobile PDA where the panel fills the screen.
    hidden: readBool(STORE.hidden, false),
    // Watcher alarms (opt-in). Each output channel is independently toggleable.
    alarm: readBool(STORE.alarm, false),
    alarmSound: readBool(STORE.alarmSound, true),
    alarmVibrate: readBool(STORE.alarmVibrate, true),
    alarmFlash: readBool(STORE.alarmFlash, true),
    alarmNotify: readBool(STORE.alarmNotify, false),
    alarmVolume: clampVolume(readNumber(STORE.alarmVolume, 0.3)),
    alarmTone: readString(STORE.alarmTone, "beep") || "beep",
    // Keep the screen awake while on watch (mobile/PDA) so the drop alarm can fire.
    wakeLockEnabled: readBool(STORE.wakeLock, true),
    // Compact "on watch" view: giant drop timer + hits + HIT button, nothing else.
    focus: readBool(STORE.focus, false),
    // Personal PREFERENCES (raw; "" / 0 = "inherit the faction default"). The effective
    // value used everywhere is eff*() = your value ?? the faction's ?? the built-in.
    thresholdsPref: readString(STORE.alarmThresholds, ""),
    chainGoalPref: Math.max(0, Math.round(readNumber(STORE.chainGoal, 0))),
    hitUrlPref: readString(STORE.hitUrl, ""),
    // Your rotating attack list: player ids the HIT button cycles through (one per
    // click). targetIndex is where you are in the loop, persisted across page loads.
    targetIds: parseTargetIds(readString(STORE.targetIds, "")),
    targetIndex: Math.max(0, Math.round(readNumber(STORE.targetIndex, 0))),
    // Faction-wide watcher defaults from the backend get payload (migration 0098), or
    // null. Leadership sets these once so every member's panel adopts them.
    factionConfig: null,
    // Auto-enter focus mode while you're the active watcher; speak drop alerts (TTS);
    // flash + chime when a chain-bonus milestone lands.
    autoFocus: readBool(STORE.autoFocus, true),
    alarmVoice: readBool(STORE.alarmVoice, false),
    celebrate: readBool(STORE.celebrate, true),
    // Fire-once bookkeeping so an alarm sounds at each threshold only once per chain
    // run / shift (cleared when the drop timer resets on a fresh hit, or the chain ends).
    firedDrop: new Set(),
    firedShift: new Set(),
    // When the schedule payload (shifts, roster, online status) last loaded successfully.
    scheduleConfirmedAt: null,
    // Faction roster resolved from OUR key: { [playerId]: { name, status } }. Plain object
    // (not a Map) so it survives the JSON round-trip through the cross-tab shared snapshot.
    tornRoster: null,
    // Inline "schedule a chain" form (replaces three chained window.prompt calls). Held in
    // state so a background poll re-rendering the panel can't wipe what's been typed.
    scheduleOpen: false,
    scheduleForm: { title: "", start: "", hours: "6", error: null },
    // "Connection & setup" is a <details>. Its open/closed state lives here so a rebuild
    // can't snap it shut, and so the key gate can send a member straight into it.
    settingsExpandConnection: false,
    connectionWasOpen: false,
    // Inline assign/clear for a shift slot (replaces window.prompt / window.confirm).
    slotAction: null,
    lastRemaining: null,
    // Consecutive direct-Torn chain failures — used to hint at missing faction API access.
    tornFailCount: 0,
    // When the chain snapshot on screen was last CONFIRMED by a successful read (Torn or
    // the backend cache), and the error from the most recent failed read. Without these
    // a failed poll silently left the last chain on screen — still badged LIVE, hits
    // frozen, timer counting down off a dead anchor — until the page was reloaded.
    chainConfirmedAt: null,
    chainStaleError: null,
    // When the drop timer / hit count were last re-anchored to torn.com's own chain bar
    // (see syncChainFromSidebar) — a free truth source that needs no API call. Desktop
    // offers both; the mobile/PDA bar carries the hit count only, no countdown.
    sidebarSyncedAt: null,
    sidebarHitsSyncedAt: null,
    // Best (tightest) estimate of the wall-clock ms at which the chain drops, plus the hit
    // count that estimate belongs to. See noteChainTimer — this is what makes the countdown
    // exact without polling harder, which is the only lever a userscript actually has.
    chainDeadline: null,
    chainRunHits: null,
    // Set when Torn answers with error code 5 (too many requests for this key), which
    // happens when several torn.com windows each run their own 3s poll on one key.
    rateLimited: false,
    // Per-chain lifecycle bookkeeping (post-chain summary, bonus celebration, auto-focus).
    // lastChainId is Torn's own id for the chain run the accumulators below belong to.
    lastChainId: null,
    wasChainActive: false,
    wasOnWatch: false,
    chainPeak: 0,
    chainYourHits: 0,
    chainYourRespect: 0,
    chainSeenTs: new Set(),
    lastBonusPassed: 0,
    chainSummary: null,
  };

  // Parse a free-form list of player ids ("123, 456\n789" / profile links) into a
  // deduped ordered array of positive ints.
  function parseTargetIds(raw) {
    const out = [];
    const seen = new Set();
    for (const m of String(raw || "").matchAll(/\d{1,10}/g)) {
      const n = parseInt(m[0], 10);
      if (Number.isInteger(n) && n > 0 && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
    return out;
  }

  function readNumber(key, fallback) {
    const n = Number(gmGet(key, fallback));
    return Number.isFinite(n) ? n : fallback;
  }

  function clampVolume(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.3;
  }

  // The HIT button href is user-set — only allow http(s) (never javascript:/data:).
  // Returns the normalized URL, or "" when nothing usable is set (the caller uses the
  // empty string to mean "no target configured" rather than sending you somewhere random).
  function validHttpUrl(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
    try {
      const u = new URL(s);
      if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    } catch {
      /* not a URL */
    }
    return "";
  }

  // Parse a "60,30,10" thresholds string into a sorted-desc list of positive ints.
  // Returns the fallback when nothing valid is given (fallback may be null → null).
  function parseThresholds(raw, fallback) {
    const parts = String(raw || "")
      .split(/[\s,]+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isInteger(n) && n > 0 && n <= 3600);
    const uniq = [...new Set(parts)].sort((a, b) => b - a);
    return uniq.length ? uniq : (fallback ? fallback.slice() : null);
  }

  // Clean a faction-supplied threshold array (from watch_config) the same way.
  function cleanThresholdArray(arr) {
    if (!Array.isArray(arr)) return null;
    const nums = arr.map((n) => Math.trunc(Number(n))).filter((n) => Number.isFinite(n) && n > 0 && n <= 3600);
    const uniq = [...new Set(nums)].sort((a, b) => b - a);
    return uniq.length ? uniq : null;
  }

  // Thresholds + goal are effective = YOUR preference (if set) ?? the FACTION default ??
  // the built-in. The HIT target URL is PER-MEMBER only (it depends on your own stats),
  // and there's NO sensible universal default — so it's just your value, or "" (unset),
  // in which case the button prompts you to set one instead of linking somewhere wrong.
  function effHitUrl() {
    return validHttpUrl(state.hitUrlPref);
  }
  function effThresholds() {
    return parseThresholds(state.thresholdsPref, null)
      || cleanThresholdArray(state.factionConfig?.drop_thresholds)
      || DEFAULT_DROP_THRESHOLDS.slice();
  }
  function effGoal() {
    if (state.chainGoalPref > 0) return state.chainGoalPref;
    const fac = Math.trunc(Number(state.factionConfig?.chain_goal)) || 0;
    return fac > 0 ? fac : 0;
  }

  function gmGet(key, fallback) {
    try {
      if (typeof GM_getValue === "function") return GM_getValue(key, fallback);
    } catch {
      /* ignore */
    }
    // Secrets are NEVER read from page localStorage — a value there would be a leak,
    // not a source of truth. Non-secret UI prefs may still fall back to localStorage.
    if (SECRET_KEYS.has(key)) return fallback;
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  // Returns true if the value was persisted. A secret is written to GM storage only;
  // if GM storage is missing we return false (caller surfaces it) rather than writing
  // the secret to page-readable localStorage.
  function gmSet(key, value) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(key, value);
        return true;
      }
    } catch {
      /* ignore */
    }
    if (SECRET_KEYS.has(key)) return false;
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  // One-time migration: if a previous version stashed a secret in page localStorage,
  // move it into GM storage and scrub it from the page as soon as GM storage exists.
  function migrateSecretsFromLocalStorage() {
    if (!hasGmStorage()) return;
    for (const key of SECRET_KEYS) {
      let raw;
      try {
        raw = localStorage.getItem(key);
      } catch {
        continue;
      }
      if (raw == null) continue;
      try {
        const existing = GM_getValue(key, "");
        if (!existing) GM_setValue(key, JSON.parse(raw));
        localStorage.removeItem(key);
      } catch {
        /* ignore a malformed legacy value */
      }
    }
  }

  function readString(key, fallback = "") {
    const value = gmGet(key, fallback);
    return typeof value === "string" ? value : fallback;
  }

  function readBool(key, fallback) {
    const value = gmGet(key, fallback);
    return typeof value === "boolean" ? value : fallback;
  }

  function readPosition() {
    const value = gmGet(STORE.position, null);
    if (!value || typeof value !== "object") return null;
    const left = Number(value.left);
    const top = Number(value.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { left, top };
  }

  function clampPosition(left, top, width = 260, height = 120) {
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const maxTop = Math.max(margin, window.innerHeight - height - margin);
    return {
      left: Math.min(Math.max(margin, left), maxLeft),
      top: Math.min(Math.max(margin, top), maxTop),
    };
  }

  function applyPanelPosition(box) {
    const position = readPosition();
    if (!position) return;
    const rect = box.getBoundingClientRect();
    const next = clampPosition(position.left, position.top, rect.width || 260, rect.height || 120);
    box.style.left = `${next.left}px`;
    box.style.top = `${next.top}px`;
    box.style.right = "auto";
    box.style.bottom = "auto";
  }

  function savePanelPosition(box) {
    const rect = box.getBoundingClientRect();
    const next = clampPosition(rect.left, rect.top, rect.width, rect.height);
    gmSet(STORE.position, next);
  }

  const MIN_PANEL_W = 240;
  const MIN_PANEL_H = 150;

  function readSize() {
    const value = gmGet(STORE.size, null);
    if (!value || typeof value !== "object") return null;
    const width = Number(value.width);
    const height = Number(value.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    return { width, height };
  }

  // Keep a user-chosen panel size inside the viewport (and above a usable floor),
  // so a resize saved on a big screen doesn't overflow a small PDA one on reload.
  function clampSize(width, height) {
    const margin = 16;
    const maxW = Math.max(MIN_PANEL_W, window.innerWidth - margin);
    const maxH = Math.max(MIN_PANEL_H, window.innerHeight - margin);
    return {
      width: Math.min(Math.max(MIN_PANEL_W, Math.round(width)), maxW),
      height: Math.min(Math.max(MIN_PANEL_H, Math.round(height)), maxH),
    };
  }

  function applyPanelSize(box) {
    const size = readSize();
    if (!size) return;
    const next = clampSize(size.width, size.height);
    box.style.width = `${next.width}px`;
    box.style.height = `${next.height}px`;
    // An explicit height replaces the CSS max-height cap; the body scrolls inside.
    box.style.maxHeight = "none";
  }

  function savePanelSize(box) {
    const rect = box.getBoundingClientRect();
    const next = clampSize(rect.width, rect.height);
    gmSet(STORE.size, next);
  }

  const LAUNCHER_W = 46;
  const LAUNCHER_H = 38;

  function readLauncherPosition() {
    const value = gmGet(STORE.launcherPos, null);
    if (!value || typeof value !== "object") return null;
    const left = Number(value.left);
    const top = Number(value.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { left, top };
  }

  function applyLauncherPosition(launcher) {
    const pos = readLauncherPosition();
    if (!pos) return;
    const next = clampPosition(pos.left, pos.top, LAUNCHER_W, LAUNCHER_H);
    launcher.style.left = `${next.left}px`;
    launcher.style.top = `${next.top}px`;
    launcher.style.right = "auto";
    launcher.style.bottom = "auto";
  }

  function saveLauncherPosition(launcher) {
    const rect = launcher.getBoundingClientRect();
    const next = clampPosition(rect.left, rect.top, rect.width || LAUNCHER_W, rect.height || LAUNCHER_H);
    gmSet(STORE.launcherPos, next);
  }

  function pdaApiKey() {
    return PDA_API_KEY && !PDA_API_KEY.includes("###") ? PDA_API_KEY.trim() : "";
  }

  function settings() {
    const functionsUrl = readString(STORE.functionsUrl).trim() || DEFAULT_FUNCTIONS_URL;
    const anonKey = readString(STORE.anonKey).trim() || DEFAULT_ANON_KEY;
    return {
      tornKey: readString(STORE.tornKey).trim() || pdaApiKey(),
      functionsUrl,
      anonKey,
      sessionToken: readString(STORE.sessionToken).trim(),
      signupToken: readString(STORE.signupToken).trim(),
    };
  }

  // Pull a token out of a pasted signup LINK or a raw token (Settings → paste a link).
  function extractSignupToken(input) {
    const s = String(input || "").trim();
    if (!s) return "";
    const m = s.match(/\/chain\/e\/([^/?#]+)/);
    let token = m ? m[1] : s;
    try {
      token = decodeURIComponent(token);
    } catch {
      /* keep raw */
    }
    return String(token).trim().slice(0, 128);
  }

  function getSignupIdentity() {
    const value = gmGet(STORE.signupIdentity, null);
    return value && typeof value === "object" ? value : null;
  }

  // Which surface the panel shows. A captured signup link drives WHICH event, so it
  // wins (token mode): viewing is open, and signing up authenticates with the key
  // (session) to record a VERIFIED, faction-checked claim for that event. Without a
  // link, a session shows the faction's current event (session mode, full manager
  // controls). Managers who captured a link can Clear it in Settings to get those
  // controls back. Nothing configured yet -> none.
  function panelMode() {
    const cfg = settings();
    if (cfg.signupToken) return "token";
    if (cfg.sessionToken) return "session";
    return "none";
  }

  // Returns true if the secrets (key + session) were persisted; false means GM
  // storage is unavailable and they were deliberately NOT written to the page.
  function saveSettings(next) {
    const pda = pdaApiKey();
    let tornKey = (next.tornKey || "").trim();
    // Never persist the PDA-injected key — TornPDA provides it fresh each load.
    if (pda && tornKey === pda) tornKey = "";
    const okKey = gmSet(STORE.tornKey, tornKey);
    gmSet(STORE.functionsUrl, (next.functionsUrl || DEFAULT_FUNCTIONS_URL).trim());
    gmSet(STORE.anonKey, (next.anonKey || DEFAULT_ANON_KEY).trim());
    const okSession = gmSet(STORE.sessionToken, (next.sessionToken || "").trim());
    return okKey && okSession;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  // Semantic-ish version compare (dot-separated integers). -1 if a<b, 0 eq, 1 a>b.
  function compareVersions(a, b) {
    const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
    const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i += 1) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  // The min/latest_script_version handshake the backend advertises in its get
  // response: too old -> the site may reject/misbehave, so lock actions; a newer
  // latest -> a non-blocking "update available" nudge.
  function scriptVersionState() {
    const w = state.watch || {};
    const min = typeof w.min_script_version === "string" ? w.min_script_version : null;
    const latest = typeof w.latest_script_version === "string" ? w.latest_script_version : null;
    return {
      tooOld: min ? compareVersions(VERSION, min) < 0 : false,
      updateAvailable: latest ? compareVersions(VERSION, latest) < 0 : false,
      latest,
    };
  }

  function httpError(message, status) {
    const err = new Error(message);
    err.status = status;
    return err;
  }

  function parseHttpJson(status, responseText, url) {
    let parsed = null;
    try {
      parsed = responseText ? JSON.parse(responseText) : null;
    } catch {
      throw httpError(`Non-JSON response from ${url}`, status);
    }
    if (status < 200 || status >= 300) {
      const msg =
        parsed && typeof parsed === "object" && typeof parsed.error === "string"
          ? parsed.error
          : `Request failed (${status})`;
      throw httpError(msg, status);
    }
    return parsed;
  }

  // --- Exact response freshness ------------------------------------------------------
  // A cached response states how stale it is — we were simply throwing the headers away.
  //
  //   Age:  seconds this response has sat in a cache. Exact, and independent of the
  //         member's own clock. This is the signal that makes the countdown exact.
  //   Date: the server's generation time. Usable too, but it has to have the local clock
  //         offset removed first (see clockOffsetMs).
  //
  // Either one converts Torn's relative `timeout` into an absolute deadline, which is what
  // lets a countdown stay correct to the second between polls instead of merely bounded.
  function parseResponseMeta(rawHeaders) {
    const out = { ageSec: null, serverNowMs: null };
    const text = String(rawHeaders || "");
    if (!text) return out;
    const age = text.match(/^\s*age:\s*(\d+)\s*$/im);
    if (age) {
      const n = Number(age[1]);
      if (Number.isFinite(n) && n >= 0 && n < 3600) out.ageSec = n;
    }
    const date = text.match(/^\s*date:\s*(.+)$/im);
    if (date) {
      const ms = Date.parse(date[1].trim());
      if (Number.isFinite(ms)) out.serverNowMs = ms;
    }
    return out;
  }

  // --- Torn's clock vs the member's ----------------------------------------------------
  // `end` is an absolute instant on TORN's clock, so comparing it against Date.now() is
  // only valid once the member's clock skew is removed — phones drift, and a naive
  // (end − now) on a clock that is 47s fast reports 47s less than there really is, firing
  // the drop alarm after the chain has already died.
  //
  // The offset comes free from the same response: (end − timeout) is Torn's generation
  // time, so (local receipt − that) is skew + network latency + any cache age. Taking the
  // MINIMUM across recent samples filters the latency and cache age away — they are only
  // ever additive — leaving the skew. A short ring buffer rather than an all-time minimum,
  // so that a phone whose clock gets corrected mid-session re-converges instead of being
  // pinned to an offset that is no longer true.
  const CLOCK_SAMPLES = 20;
  const clockOffsets = [];
  function noteServerClock(endUnix, timeoutSec, localRecvSec) {
    if (!(endUnix > 0) || !(timeoutSec > 0)) return;
    const offset = localRecvSec - (endUnix - timeoutSec);
    if (!Number.isFinite(offset) || Math.abs(offset) > 86400) return; // implausible
    clockOffsets.push(offset);
    if (clockOffsets.length > CLOCK_SAMPLES) clockOffsets.shift();
  }
  function serverClockOffsetSec() {
    return clockOffsets.length ? Math.min(...clockOffsets) : null;
  }
  // Test-only: the ring is module state shared by every caller, so a unit test measuring
  // skew has to start from empty. Unused by the userscript itself.
  function resetClockSamplesForTests() {
    clockOffsets.length = 0;
  }

  // Running minimum of (local receipt − server Date). That minimum converges to the
  // member's clock skew plus the best-case network latency, both of which are constant
  // offsets — so subtracting it leaves the part that actually varies: cache staleness.
  // Clock-skew immune without needing the member's clock to be right.
  let clockOffsetMs = null;
  function stalenessFromMeta(meta, receivedAtMs) {
    if (!meta) return null;
    if (meta.ageSec != null) return { sec: meta.ageSec, source: "age" };
    if (meta.serverNowMs != null) {
      const delta = receivedAtMs - meta.serverNowMs;
      if (clockOffsetMs == null || delta < clockOffsetMs) clockOffsetMs = delta;
      // The Date header has 1-second resolution, so this is accurate to about a second.
      return { sec: Math.max(0, (delta - clockOffsetMs) / 1000), source: "date" };
    }
    return null;
  }

  async function requestJsonWithTornPda(url, options = {}) {
    const method = options.method || "GET";
    const headers = options.headers || {};
    const data = options.body == null ? undefined : JSON.stringify(options.body);
    const post = window.PDA_httpPost;
    const get = window.PDA_httpGet;
    const res = method === "POST"
      ? await post(url, headers, data || "")
      : await get(url, headers);
    const status = Number(res?.status ?? res?.statusCode ?? 200);
    const responseText = String(res?.responseText ?? res?.body ?? res ?? "");
    // PDA's bridge may or may not surface headers, and spells it differently from GM.
    // Try what's plausible and degrade quietly — a missing header just means we fall back
    // to the bounded estimate rather than the exact one.
    if (typeof options.onMeta === "function") {
      const raw = res?.responseHeaders ?? res?.headers ?? res?.allResponseHeaders ?? "";
      options.onMeta(parseResponseMeta(typeof raw === "string" ? raw : headerObjectToText(raw)), Date.now());
    }
    return parseHttpJson(status, responseText, url);
  }

  // PDA may hand headers back as an object rather than the raw header block.
  function headerObjectToText(obj) {
    if (!obj || typeof obj !== "object") return "";
    try {
      return Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join("\n");
    } catch {
      return "";
    }
  }

  function requestJson(url, options = {}) {
    if (
      typeof window.PDA_httpGet === "function" &&
      ((options.method || "GET") === "GET" || typeof window.PDA_httpPost === "function")
    ) {
      return requestJsonWithTornPda(url, options);
    }
    // No page-context fetch fallback: every API/session call must go through the
    // userscript manager (GM_xmlhttpRequest) or Torn PDA, so the Torn key and session
    // token are never exposed to torn.com's own page scripts.
    if (typeof GM_xmlhttpRequest !== "function") {
      return Promise.reject(
        new Error("This script needs Tampermonkey (or Torn PDA) — the browser's own fetch is never used for API or session calls, to keep your Torn key and session private."),
      );
    }

    const method = options.method || "GET";
    const headers = options.headers || {};
    const data = options.body == null ? undefined : JSON.stringify(options.body);
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        data,
        timeout: options.timeout || 25000,
        onload: (res) => {
          try {
            if (typeof options.onMeta === "function") {
              options.onMeta(parseResponseMeta(res.responseHeaders), Date.now());
            }
            resolve(parseHttpJson(res.status, res.responseText, url));
          } catch (error) {
            reject(error);
          }
        },
        onerror: () => reject(new Error(`Network error calling ${url}`)),
        ontimeout: () => reject(new Error(`Timed out calling ${url}`)),
      });
    });
  }

  async function callFunction(slug, body = {}, opts = {}) {
    const cfg = settings();
    if (!cfg.functionsUrl || !cfg.anonKey || !cfg.sessionToken) {
      throw new Error("Connect the site session in Settings.");
    }
    try {
      return await requestJson(`${cfg.functionsUrl.replace(/\/+$/, "")}/${slug}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: cfg.anonKey,
          Authorization: `Bearer ${cfg.anonKey}`,
          "X-Session-Token": cfg.sessionToken,
        },
        body,
      });
    } catch (error) {
      // Session expired or was invalidated → transparently re-mint it from the stored
      // Torn key once (sliding renewal), then retry. Needs a Torn key to reconnect.
      if (error && error.status === 401 && !opts.retried && cfg.tornKey) {
        await connectSiteFromTornKey();
        return callFunction(slug, body, { retried: true });
      }
      throw error;
    }
  }

  // Public chain-signup capability API — header-less (Content-Type only), token in the
  // body, NO session or Torn key. This is the anon token-mode path.
  // Public chain-signup call. Viewing is header-less (anonymous). For a claim/release
  // the caller passes a sessionToken -> we add X-Session-Token so the backend records
  // a VERIFIED, faction-checked member claim (never anonymous free-text from here).
  async function callSignup(action, extra = {}, sessionToken) {
    const cfg = settings();
    const token = cfg.signupToken;
    if (!token) throw new Error("No signup link captured yet.");
    const base = (cfg.functionsUrl || DEFAULT_FUNCTIONS_URL).replace(/\/+$/, "");
    const headers = { "Content-Type": "application/json" };
    if (sessionToken) headers["X-Session-Token"] = sessionToken;
    return requestJson(`${base}/chain-signup`, {
      method: "POST",
      headers,
      body: { action, token, ...extra },
    });
  }

  // The session (from the Torn key) is what verifies a signup. Return it, minting one
  // from the stored/PDA key on demand; if there's no key, tell the member to add one.
  async function ensureVerifiedSession() {
    const cfg = settings();
    if (cfg.sessionToken) return cfg.sessionToken;
    if (!cfg.tornKey) {
      throw new Error("Add your Torn API key in Settings to sign up — it verifies you're in the faction.");
    }
    return await connectSiteFromTornKey();
  }

  async function connectSiteFromTornKey() {
    const cfg = settings();
    if (!cfg.tornKey) throw new Error("Add your Torn API key first.");
    if (!cfg.functionsUrl || !cfg.anonKey) throw new Error("The script backend is not configured.");
    // persist:false — identity-only. The site validates the key against Torn to confirm
    // who we are + our faction, but stores NO copy of the key (the key lives only here, in
    // GM storage, for the zero-lag direct-to-Torn calls). The session it mints lasts ~12h;
    // when it lapses, callFunction's 401 path re-mints from the stored key, re-checking the
    // faction at Torn each time.
    const res = await requestJson(`${cfg.functionsUrl.replace(/\/+$/, "")}/connect-torn-key`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.anonKey,
        Authorization: `Bearer ${cfg.anonKey}`,
      },
      body: { apiKey: cfg.tornKey, persist: false },
    });
    if (!res || typeof res.sessionToken !== "string") {
      throw new Error("The site did not return a session token.");
    }
    gmSet(STORE.sessionToken, res.sessionToken);
    // Remember who the key belongs to (returned by connect-torn-key) so token mode
    // can show "signed in as X" and know which slots are yours — no Torn call needed.
    if (res.player && res.player.id != null) {
      gmSet(STORE.signupIdentity, { id: Number(res.player.id), name: res.player.name || `ID ${res.player.id}` });
    }
    return res.sessionToken;
  }

  // The live_chain block the Overseer backend serves on BOTH the session and the
  // token payloads (identical shape). Convert it to the panel's chain shape,
  // anchoring the countdown to when the SERVER cached it so the timer stays honest
  // without a Torn key of our own.
  function serverLiveChain(res) {
    const lc = res && res.live_chain && res.live_chain.chain;
    if (!lc || typeof lc !== "object") return null;
    const current = num(lc.current) ?? 0;
    const timeout = num(lc.timeout) ?? 0;
    const cachedAt = res.live_chain.fetched_at ? new Date(res.live_chain.fetched_at).getTime() : NaN;
    return {
      active: current > 0 && timeout > 0,
      current,
      max: num(lc.max) ?? 0,
      timeout,
      modifier: num(lc.modifier) ?? 0,
      cooldown: num(lc.cooldown) ?? 0,
      // Carry the chain start through when the backend sends it, so the leaderboard stays
      // windowed to THIS chain on the cache fallback too (without it the window silently
      // widened to a rolling 4h and mixed in the previous chain's hits).
      start: num(lc.start) ?? 0,
      // The backend block carries no absolute drop instant, so the countdown falls back to
      // the timeout anchored at the server's cache time.
      deadlineLocalMs: null,
      fetchedAt: Number.isFinite(cachedAt) ? cachedAt : Date.now(),
    };
  }

  // The hit leaderboard the backend serves (from the attack_outgoing buffer) on
  // both payloads. It arrives already aggregated + sorted, so the panel just adopts
  // it — no Torn key, no client-side attack parsing. Null (best-effort failure) or a
  // between-chains empty list both render as "no data yet".
  function serverLeaderboard(res) {
    const block = res && res.leaderboard;
    if (!block || typeof block !== "object") {
      return { leaderboard: [], last: null, error: "No leaderboard data yet." };
    }
    const rows = Array.isArray(block.leaderboard) ? block.leaderboard : [];
    const leaderboard = rows.map((r) => ({
      playerId: num(r?.player_id) ?? null,
      name: String(r?.name ?? (r?.player_id != null ? `ID ${r.player_id}` : "Unknown")),
      hits: num(r?.hits) ?? 0,
      respect: num(r?.respect) ?? 0,
      avg: num(r?.avg) ?? 0,
    }));
    const l = block.last;
    const ts = l && typeof l === "object" ? num(l.timestamp) : null;
    const last = ts != null && ts > 0
      ? { attackerId: num(l.attackerId ?? l.player_id) ?? null, attackerName: String(l.attackerName ?? "?"), defenderName: String(l.defenderName ?? "target"), timestamp: ts }
      : null;
    return { leaderboard, last, error: null };
  }

  // --- Direct-from-Torn live data (member key, zero-lag) -----------------------
  // These go STRAIGHT to Torn via the userscript manager / PDA (never a page fetch),
  // so the key stays private but the chain HUD + leaderboard match torn.com with no
  // backend cache lag. The Overseer backend remains the fallback (see refreshAll).

  async function tornFetch(path, opts = {}) {
    const cfg = settings();
    if (!cfg.tornKey) throw new Error("Add a Torn API key in Settings.");
    const url = new URL(`https://api.torn.com/v2${path.startsWith("/") ? path : `/${path}`}`);
    url.searchParams.set("key", cfg.tornKey);
    url.searchParams.set("comment", COMMENT);
    const data = await requestJson(url.toString(), opts.onMeta ? { onMeta: opts.onMeta } : {});
    if (data && typeof data === "object" && data.error) throw tornApiError(data.error);
    return data;
  }

  // Torn signals its own failures in a 200 body. Code 5 is "too many requests" — worth
  // tagging, because the panel's own 3s poll is the usual cause and the fix (back off,
  // close spare torn.com windows) is different from a key/permission problem.
  function tornApiError(err) {
    const code = num(err?.code);
    const error = new Error(err?.error || `Torn API error ${code ?? ""}`.trim());
    error.tornCode = code;
    error.rateLimited = code === 5;
    return error;
  }

  async function tornLegacyFaction(selections) {
    const cfg = settings();
    if (!cfg.tornKey) throw new Error("Add a Torn API key in Settings.");
    const url = new URL("https://api.torn.com/faction/");
    url.searchParams.set("selections", selections);
    url.searchParams.set("key", cfg.tornKey);
    url.searchParams.set("comment", COMMENT);
    const data = await requestJson(url.toString());
    if (data && typeof data === "object" && data.error) throw tornApiError(data.error);
    return data;
  }

  function asRows(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") return Object.values(value);
    return [];
  }

  // Torn /v2/faction/chain -> the panel's chain shape, stamped with the moment WE got
  // the response so the local drop-timer countdown stays honest between polls.
  function parseChain(raw, freshness) {
    const c = raw?.chain || raw || {};
    const current = num(c.current) ?? 0;
    const rawTimeout = num(c.timeout) ?? 0;
    // Subtract the response's own measured staleness, so `timeout` describes NOW rather
    // than whenever the cache generated it. Without this the countdown always ran late
    // (reporting more time than there was) by however long the response had been cached.
    const stale = freshness && Number.isFinite(freshness.sec) ? Math.max(0, freshness.sec) : 0;
    const timeout = rawTimeout > 0 ? Math.max(0, rawTimeout - stale) : 0;
    // `timeout` is seconds remaining AS OF THE INSTANT TORN GENERATED THE RESPONSE — which
    // is exactly why a cached response runs late. `end` is absolute unix seconds. So if
    // `end` is that same instant expressed absolutely, then:
    //
    //     end − timeout  ==  the moment Torn generated this response
    //
    // That single subtraction does two jobs at once. It VALIDATES the interpretation (the
    // result has to land a plausible moment ago), and it yields the exact staleness — from
    // the body, needing no `Age` or `Date` header, which matters because PDA's bridge may
    // not expose headers at all. Requiring the difference to land in a just-now window is
    // also a far stronger guard than asking whether `end` merely looks near-future: a
    // stale `end` from a previous chain, or an `end` meaning something else entirely,
    // won't line up with `timeout` by coincidence.
    const endUnix = num(c.end) ?? 0;
    const nowSec = Date.now() / 1000;
    noteServerClock(endUnix, rawTimeout, nowSec);
    const offset = serverClockOffsetSec();
    const genUnix = endUnix > 0 && rawTimeout > 0 ? endUnix - rawTimeout : 0;
    // Age of this response, on a common clock: how far its generation time sits behind
    // now, once the member's skew is taken out. Near zero for an uncached endpoint.
    const genAge = genUnix > 0 && offset != null ? nowSec - offset - genUnix : null;
    // Allow a little negative slack for jitter, and up to 3 minutes of cache age.
    const endUsable = genAge != null && genAge >= -5 && genAge <= 180;
    // The drop instant expressed on the MEMBER's clock, so the per-second countdown can
    // just subtract Date.now() forever — no re-anchoring, no drift, nothing to go stale.
    const deadlineLocalMs = endUsable ? (endUnix + offset) * 1000 : null;
    return {
      active: current > 0 && rawTimeout > 0,
      current,
      // Torn's own identifier for THIS chain run. An exact identity signal, which beats
      // inferring "is this still the same chain?" from the hit count going up or down.
      id: num(c.id) ?? 0,
      max: num(c.maximum ?? c.max) ?? 0,
      timeout: deadlineLocalMs != null ? Math.max(0, Math.round((deadlineLocalMs - Date.now()) / 1000)) : timeout,
      deadlineLocalMs,
      modifier: num(c.modifier) ?? 0,
      cooldown: num(c.cooldown) ?? 0,
      start: num(c.start) ?? 0, // unix seconds the chain began — windows the leaderboard
      end: endUnix,
      fetchedAt: Date.now(),
      // Which mechanism gave us this countdown, best first — surfaced in the UI so a
      // member (and we) can tell at a glance whether it's exact or merely bounded.
      timeSource: endUsable ? "chain.end" : freshness?.source || "uncorrected",
      // How long this response had been cached. Derived from (end − timeout) when that
      // checks out, otherwise measured from the headers. Reported in the UI either way.
      staleSec: endUsable ? Math.max(0, genAge) : stale,
    };
  }

  // Torn /faction?selections=attacks -> the same aggregated leaderboard shape the
  // backend serves, built client-side from the last ~100 attacks (needs faction API
  // access; a 403/access error surfaces as an error and we fall back to the backend).
  // Windowed to THIS chain (windowStartSec) and filtered to faction members (rosterIds)
  // so it matches the live chain — not last-100-attacks that include the previous chain
  // and incoming enemy hits. Also computes a recent hit PACE (per-minute) over the
  // sampled window: your own, the whole faction, and the per-hitter average.
  function parseAttacks(raw, viewerId, windowStartSec, rosterIds) {
    const rows = asRows(raw?.attacks ?? raw);
    const byId = new Map();
    let last = null;
    let total = 0;
    let yourHits = 0;
    let minTs = Infinity;
    let maxTs = 0;
    const yourTs = [];
    const yourResp = [];
    const vid = viewerId != null ? Number(viewerId) : null;
    const winStart = Number.isFinite(windowStartSec) && windowStartSec > 0 ? windowStartSec : 0;
    const hasRoster = rosterIds instanceof Set && rosterIds.size > 0;
    for (const row of rows) {
      const attacker = row?.attacker && typeof row.attacker === "object" ? row.attacker : {};
      const defender = row?.defender && typeof row.defender === "object" ? row.defender : {};
      const attackerId = num(row?.attacker_id ?? row?.attackerID ?? attacker.id);
      if (!attackerId || attackerId <= 0) continue; // stealthed / unknown attacker
      // Only faction members' hits (drops incoming enemy attacks); and only within the
      // current chain's window (drops the previous chain / between-chain randoms).
      if (hasRoster && !rosterIds.has(attackerId)) continue;
      const timestamp =
        num(row?.timestamp_ended ?? row?.ended ?? row?.timestamp_started ?? row?.started ?? row?.timestamp) ?? 0;
      if (winStart && timestamp > 0 && timestamp < winStart) continue;
      const attackerName = row?.attacker_name || attacker.name || `ID ${attackerId}`;
      const defenderName = row?.defender_name || defender.name || row?.target_name || "target";
      const respect = num(row?.respect_gain ?? row?.respect ?? row?.respectGain ?? row?.respect_total) ?? 0;
      const prior = byId.get(attackerId) || { playerId: attackerId, name: attackerName, hits: 0, respect: 0 };
      prior.hits += 1;
      prior.respect += respect;
      byId.set(attackerId, prior);
      total += 1;
      if (vid != null && attackerId === vid) {
        yourHits += 1;
        if (timestamp > 0) { yourTs.push(timestamp); yourResp.push(respect); }
      }
      if (timestamp > 0) {
        if (timestamp < minTs) minTs = timestamp;
        if (timestamp > maxTs) maxTs = timestamp;
      }
      if (timestamp > 0 && (!last || timestamp > last.timestamp)) {
        last = { attackerId, attackerName, defenderName, timestamp };
      }
    }
    const leaderboard = [...byId.values()]
      .map((row) => ({ ...row, avg: row.hits > 0 ? row.respect / row.hits : 0 }))
      .sort((a, b) => b.hits - a.hits || b.respect - a.respect)
      .slice(0, 8);

    // Recent per-minute pace over the sampled window. All three figures share ONE
    // window so they're consistent: the faction rate, YOUR rate, and the rate an
    // average active hitter is managing (faction ÷ number of people who hit).
    const windowSec = maxTs > 0 && minTs < Infinity ? maxTs - minTs : 0;
    const hitters = byId.size;
    let pace = null;
    if (windowSec >= PACE_MIN_WINDOW_SEC && total >= 3) {
      const perMin = (n) => (n / windowSec) * 60;
      pace = {
        faction: perMin(total),
        you: vid != null ? perMin(yourHits) : null,
        avg: hitters > 0 ? perMin(total) / hitters : 0,
        hitters,
      };
    }
    return { leaderboard, last, error: null, mine: { hits: yourHits, ts: yourTs, respect: yourResp }, pace };
  }

  // --- Cross-tab coordination ----------------------------------------------------------
  // Torn's 100 req/min budget is per ACCOUNT, so it cannot be widened by handing out more
  // keys — spending less is the only lever there is. Every open torn.com window was running
  // its own poll loop, so two visible windows doubled our share of that one budget for no
  // benefit, both fetching the identical chain.
  //
  // So exactly one tab polls Torn. It takes a short lease in localStorage and publishes
  // each result there; the others read the published snapshot instead of calling the API.
  // The lease is short and the leader drops it the moment it's backgrounded, so whichever
  // window the member is actually looking at takes over within a few seconds.
  //
  // localStorage is safe HERE specifically because the chain snapshot is not a secret —
  // it's the same hit count and timer torn.com is already rendering on the page. Keys and
  // session tokens remain GM-storage-only (SECRET_KEYS); nothing sensitive is published.
  const LEADER_KEY = "tocw_poll_leader";
  const SHARED_KEY = "tocw_shared_chain";
  const LEADER_LEASE_MS = 9000;
  const SHARED_MAX_AGE_MS = 30000;
  const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  function lsGet(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function lsSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode / quota — fall back to every tab polling for itself */
    }
  }

  // Take or renew the polling lease. Returns true when this tab should hit Torn. A hidden
  // tab never contends, so the visible window always wins within one lease period.
  function claimPollLeader() {
    if (typeof localStorage === "undefined") return true; // no coordination available
    if (document.visibilityState !== "visible") return false;
    const lease = lsGet(LEADER_KEY);
    const fresh = lease && Number.isFinite(lease.at) && Date.now() - lease.at < LEADER_LEASE_MS;
    if (fresh && lease.id !== TAB_ID) return false;
    lsSet(LEADER_KEY, { id: TAB_ID, at: Date.now() });
    return true;
  }

  function releasePollLeader() {
    const lease = lsGet(LEADER_KEY);
    if (lease && lease.id === TAB_ID) lsSet(LEADER_KEY, { id: TAB_ID, at: 0 });
  }

  function publishSharedChain() {
    if (!state.chain) return;
    lsSet(SHARED_KEY, { at: Date.now(), by: TAB_ID, chain: state.chain, attacks: state.attacks, roster: state.tornRoster });
  }

  // The follower path: adopt what the leader last published, if it's recent enough to be
  // worth more than our own (absent) data.
  function readSharedChain() {
    const shared = lsGet(SHARED_KEY);
    if (!shared || !Number.isFinite(shared.at)) return null;
    if (Date.now() - shared.at > SHARED_MAX_AGE_MS) return null;
    if (!shared.chain || typeof shared.chain !== "object") return null;
    return shared;
  }

  // Torn /v2/faction/members -> { [id]: { name, status } }. Handles both the v2 array and
  // the legacy id-keyed object, and takes `last_action.status` (Online/Idle/Offline) which
  // is what the panel's status dot means — not `status`, which is hospital/jail/okay.
  function parseRoster(raw) {
    const rows = asRows(raw?.members ?? raw);
    const out = {};
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const id = num(row.id ?? row.player_id ?? row.user_id);
      const name = typeof row.name === "string" ? row.name.trim() : "";
      if (!id || id <= 0 || !name) continue;
      const la = row.last_action && typeof row.last_action === "object" ? row.last_action : null;
      const status = typeof la?.status === "string" ? la.status : null;
      out[id] = { name, status };
    }
    return Object.keys(out).length ? out : null;
  }

  // Freshness bookkeeping so the heavier reads (attacks, roster, backend schedule) run on
  // their own slower cadence than the fast chain poll.
  let lastAttacksAt = 0;
  let lastScheduleAt = 0;
  let lastRosterAt = 0;

  // A key with no session was a dead end: panelMode() returns "none", so NEITHER schedule
  // branch in refreshAll ran, nothing ever minted a session, and the panel sat telling the
  // member to go and do it by hand — forever, because nothing was actually connecting.
  //
  // Adding the key is the consent step; there's nothing further to ask. So mint the session
  // from it automatically. Throttled, because a key that Torn rejects (typo, wrong
  // permissions, not in a faction) must not turn into a connect-torn-key call every poll.
  const CONNECT_RETRY_MS = 60000;
  let lastConnectAttemptAt = 0;
  let connectError = null;

  async function ensureSessionFromKey() {
    const cfg = settings();
    if (cfg.sessionToken || !cfg.tornKey) return;
    if (lastConnectAttemptAt && Date.now() - lastConnectAttemptAt < CONNECT_RETRY_MS) return;
    lastConnectAttemptAt = Date.now();
    try {
      await connectSiteFromTornKey();
      connectError = null;
    } catch (e) {
      connectError = e.message || "Could not verify your key with the Overseer site.";
    }
  }

  // Called when a key is entered or an explicit retry is requested, so neither has to wait
  // out the throttle above.
  function retryConnectNow() {
    lastConnectAttemptAt = 0;
    connectError = null;
  }

  async function refreshAll(manual = false) {
    // Only the manual button shows a spinner — a background poll every few seconds
    // must not flicker the UI or blank a value mid-chain.
    if (manual) {
      state.loading = true;
      state.notice = null;
      render({ background: true }); // spinner only — must not disturb an open form
    }
    state.error = null;
    try {
      // Mint the session from the key BEFORE reading panelMode, so it resolves to
      // "session" on this very pass instead of sitting in "none" and skipping both
      // schedule branches. An explicit Refresh always retries, throttle or not.
      if (manual) retryConnectNow();
      await ensureSessionFromKey();
      const cfg = settings();
      const mode = panelMode();
      const now = Date.now();
      // Clear the inactive surface so a mode switch never renders stale data.
      if (mode === "token") state.watch = null;
      else state.signup = null;

      const hasKey = Boolean(cfg.tornKey);
      const wantSchedule = manual || now - lastScheduleAt >= SCHEDULE_MIN_INTERVAL;
      const wantAttacks = hasKey && (manual || now - lastAttacksAt >= ATTACKS_MIN_INTERVAL);

      const tasks = [];
      let serverRes = null;
      let scheduleErr = null;
      let tornChain = null;
      let tornAttacks = null;
      let tornChainErr = null;

      // 1) Backend schedule (event / shifts / roster) + a FALLBACK live block. Throttled
      //    so a fast live poll doesn't hammer Supabase — the schedule changes slowly.
      if (wantSchedule && mode === "session") {
        tasks.push(
          callFunction("chain-watch", { action: "get" })
            .then((res) => { serverRes = res; state.watch = res; lastScheduleAt = Date.now(); state.scheduleConfirmedAt = Date.now(); })
            .catch((e) => { scheduleErr = e; if (!state.watch) state.watch = null; }),
        );
      } else if (wantSchedule && mode === "token") {
        // Verify-to-view: the signup get now needs a session. Use the stored one, minting
        // it from the Torn key once if needed (then it's cached for later polls). A truly
        // keyless viewer gets a needs_verification stub and the panel prompts for a key.
        let st = cfg.sessionToken;
        if (!st && cfg.tornKey) {
          try { st = await ensureVerifiedSession(); } catch { st = ""; }
        }
        tasks.push(
          callSignup("get", {}, st || undefined)
            .then((res) => { serverRes = res; state.signup = res; lastScheduleAt = Date.now(); state.scheduleConfirmedAt = Date.now(); })
            .catch((e) => { scheduleErr = e; if (!state.signup) state.signup = null; }),
        );
      }

      // 2) Zero-lag live data STRAIGHT from Torn (member key). This is the primary
      //    source whenever a key is present; the backend block is only a fallback.
      //    Only the lease-holding tab actually calls Torn — see claimPollLeader.
      const isLeader = hasKey ? claimPollLeader() : false;
      if (hasKey && !isLeader) {
        // A follower: take the leader's published snapshot rather than spending another
        // slice of the shared 100/min budget on the identical request.
        const shared = readSharedChain();
        if (shared) {
          state.chain = shared.chain;
          if (shared.attacks) state.attacks = shared.attacks;
          if (shared.roster) state.tornRoster = shared.roster; // names too, not just the chain
          state.liveSource = "torn";
          state.tornFailCount = 0;
          state.chainConfirmedAt = shared.at;
          state.chainStaleError = null;
        }
      }
      if (hasKey && isLeader) {
        // Window the leaderboard to the running chain (its start), else a rolling 4h;
        // filter to faction members so incoming enemy hits don't pollute it.
        const chainStart = state.chain?.active && state.chain.start > 0
          ? state.chain.start
          : Math.floor(Date.now() / 1000) - 4 * 3600;
        const rosterIds = new Set(
          (state.signup?.roster || state.watch?.roster || [])
            .map((m) => Number(m.id))
            .filter((n) => Number.isFinite(n) && n > 0),
        );
        let chainFreshness = null;
        tasks.push(
          tornFetch("/faction/chain", {
            onMeta: (meta, receivedAt) => { chainFreshness = stalenessFromMeta(meta, receivedAt); },
          })
            .then((raw) => { tornChain = parseChain(raw, chainFreshness); })
            .catch((e) => { tornChainErr = e; }),
        );
        // Names + online status, resolved from our own key because the backend's
        // identity-only session usually can't (see ROSTER_MIN_INTERVAL). Slow cadence:
        // a roster changes far less often than a chain does.
        if (manual || now - lastRosterAt >= ROSTER_MIN_INTERVAL) {
          tasks.push(
            tornFetch("/faction/members")
              .then((raw) => {
                const roster = parseRoster(raw);
                if (roster) { state.tornRoster = roster; lastRosterAt = Date.now(); }
              })
              .catch(() => { /* no faction access — fall back to whatever names the payload has */ }),
          );
        }
        if (wantAttacks) {
          tasks.push(
            tornLegacyFaction("attacks")
              .then((raw) => { tornAttacks = parseAttacks(raw, viewerId(), chainStart, rosterIds); lastAttacksAt = Date.now(); })
              .catch(() => { /* no faction API access etc. — fall back to the backend block */ }),
          );
        }
      }

      await Promise.all(tasks);

      // Resolve the live chain HUD: direct Torn wins; else the backend cache; else keep
      // the last value (never blank a live timer on one failed poll).
      if (tornChain) {
        // Torn caches /faction/chain, so consecutive polls can return the SAME timeout.
        // Keep the previous anchor when the data hasn't moved, or the countdown jumps back
        // to the start each poll; re-anchor only when timeout/current actually changed.
        const prev = state.chain;
        if (
          prev && prev.active && tornChain.active &&
          prev.timeout === tornChain.timeout && prev.current === tornChain.current
        ) {
          tornChain.fetchedAt = prev.fetchedAt;
        }
        state.chain = tornChain;
        state.liveSource = "torn";
        state.tornFailCount = 0;
        state.rateLimited = false;
        state.chainConfirmedAt = Date.now();
        state.chainStaleError = null;
        publishSharedChain(); // hand it to the other windows so they need not fetch
      } else if (!hasKey || isLeader) {
        // Only count a failure when we actually attempted the fetch. A follower that
        // simply has no shared snapshot yet hasn't failed at anything.
        if (hasKey) state.tornFailCount += 1;
        if (tornChainErr?.rateLimited) state.rateLimited = true;
        const cached = serverRes ? serverLiveChain(serverRes) : null;
        if (cached) {
          state.chain = cached;
          state.liveSource = "cache";
          state.chainConfirmedAt = Date.now();
          state.chainStaleError = null;
        } else if (state.chain) {
          // Nothing fresh from either source. Keep the last snapshot on screen (one bad
          // poll must not blank a live timer) but remember WHY it wasn't confirmed —
          // render() downgrades it to STALE once it ages past CHAIN_STALE_MS rather than
          // letting a frozen hit count keep wearing the LIVE badge.
          state.chainStaleError = tornChainErr || state.chainStaleError;
        }
      }

      // Resolve the leaderboard the same way (direct Torn -> backend -> keep last).
      if (tornAttacks) {
        state.attacks = tornAttacks;
      } else if (serverRes) {
        state.attacks = serverLeaderboard(serverRes);
      }

      // Fold this poll's chain reading into the cache-corrected deadline estimate (hits
      // first, so a landed hit clears the now-void bounds before the new bound lands).
      if (state.chain?.active) {
        noteChainHits(currentHitsBest());
        noteChainTimer(state.chain.timeout);
      } else {
        clearChainEstimate();
      }

      // Adopt the faction's watcher defaults (0098) from whichever payload we have.
      state.factionConfig = state.watch?.watch_config ?? state.signup?.watch_config ?? null;
      updateChainLifecycle();
      state.fetchedAt = Date.now();

      // Only surface an error when we're left with nothing to show. A failed direct
      // chain poll that still has a backend fallback (or a last value) stays quiet.
      if (mode === "none") {
        state.error = null;
      } else if (scheduleErr && !state.watch && !state.signup) {
        state.error = scheduleErr.message || "Could not load Chain Watch.";
      } else if (tornChainErr && !state.chain) {
        state.error = tornChainErr.message || "Could not load the live chain from Torn.";
      }
      // A stale-but-present chain used to stay silent (the branch above only fires with
      // NO chain at all), which is exactly how the panel drifted out of sync without
      // ever saying so. renderChainStale() now speaks for that case.
    } finally {
      state.loading = false;
      render({ background: true });
      scheduleNextRefresh();
    }
  }

  // Self-adjusting poll loop: fast while a chain is live (zero-lag), easy between
  // chains, barely ticking while hidden. refreshAll re-arms this in its finally.
  let refreshTimer = null;
  function scheduleNextRefresh() {
    clearTimeout(refreshTimer);
    // The fast poll only pays off when we can read Torn directly (a key) during a live
    // chain; keyless viewers can't beat the backend cache, so they stay on the easy pace.
    const canLive = Boolean(settings().tornKey) && Boolean(state.chain?.active);
    // Keep polling fast even while hidden IF alarms are armed on a live chain — an alarm
    // is only as accurate as the last chain fetch, so it must not go stale in a pocket.
    // Near the drop every second counts; with minutes on the clock it doesn't. The timer
    // itself keeps ticking locally (and off Torn's own chain bar when it's readable), so
    // easing off here costs no accuracy where it matters.
    const livePoll = chainRemaining() > RELAXED_ABOVE_SEC ? LIVE_POLL_RELAXED_MS : LIVE_POLL_MS;
    const base = canLive && (!state.hidden || state.alarm)
      ? livePoll
      : state.hidden ? HIDDEN_POLL_MS : IDLE_POLL_MS;
    // Back off after consecutive direct-Torn failures. Polling a rate-limited key every
    // 3s is what KEEPS it limited — the 100 req/min is per ACCOUNT, so it is shared with
    // every other window and every other script the member is running.
    const backoff = TORN_BACKOFF_MS[Math.min(state.tornFailCount, TORN_BACKOFF_MS.length - 1)];
    const delay = Math.max(base, backoff);
    refreshTimer = setTimeout(() => {
      // Poll whenever the TAB is foreground (panel hidden is fine — alarms/data still
      // need refreshing); a backgrounded tab pauses (browsers throttle it anyway).
      if (document.visibilityState === "visible") {
        void refreshAll(false); // re-arms the loop in its finally
      } else {
        scheduleNextRefresh(); // paused (tab backgrounded) — keep the loop alive
      }
    }, delay);
  }

  // torn.com renders its own chain bar, and it's the exact thing the player is looking
  // at — zero API-cache lag and zero API cost. Both layouts use a CSS-module class whose
  // prefix is stable, `chain-bar___<hash>`, which is a far better anchor than hunting for
  // a countdown and walking up looking for the word "chain":
  //
  //   desktop  <div class="chain-bar___…">   … <div class="bar-timeleft___…">4:32</div>
  //   mobile   <a   class="chain-bar___… bar-mobile___…" href="…#/war/chain">
  //                                          … <p class="bar-value___…">1 / 10</p>
  //
  // The mobile/PDA bar carries NO countdown at all — only "hits / next-bonus". So mobile
  // gets its HIT COUNT free from the DOM but still needs the API for the drop timer,
  // while desktop gets both. Each reader returns null when its element isn't there.
  //
  // Mobile DOES have a countdown in the bar's tooltip ("Chain: 1 / 10 (00:17)"), but that
  // is a floating-ui popover mounted on demand — the bar carries data-is-tooltip-opened,
  // and the node only exists while it's open. So it is not something to depend on, and we
  // never synthesise a hover to force it. It sits outside the bar, so the scoped read
  // can't see it; the global fallback below picks it up on its own whenever a member
  // happens to have it open (its <p> reads "Chain: 1 / 10 (00:17)", which satisfies the
  // ancestor-names-the-chain test). Free when it's there, never relied upon.
  // ALL chain bars, not just the first: Torn can have both the desktop and the mobile bar
  // in the DOM with one hidden by CSS, and the hidden one may not be populated. So the
  // readers try each in turn and take the first that actually yields a value.
  function chainBarNodes() {
    try {
      return document.querySelectorAll('[class*="chain-bar"]');
    } catch {
      return [];
    }
  }

  // "1 / 10" → 1. The denominator is Torn's next-bonus target, which we compute ourselves
  // (nextBonus), so only the current count is taken.
  function readSidebarChainHits() {
    try {
      for (const bar of chainBarNodes()) {
        const value = bar.querySelector('[class*="bar-value"]');
        const m = (value?.textContent || "").trim().match(/^(\d{1,7})\s*\/\s*\d{1,7}$/);
        if (!m) continue;
        const hits = Number(m[1]);
        if (Number.isInteger(hits) && hits >= 0) return hits;
      }
    } catch {
      /* DOM shape changed — fall back to the API value */
    }
    return null;
  }

  let sidebarChainNode = null;
  // "M:SS" → seconds, rejecting anything outside the chain timer's real 0–5:00 range
  // (Energy counts to 15:00, so the range alone rules the other bars out). Self-contained:
  // it never compares against our API value, which may itself be stale.
  function timerTextSeconds(el) {
    const m = (el?.textContent || "").trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const secs = Number(m[1]) * 60 + Number(m[2]);
    return secs >= 0 && secs <= 300 ? secs : null;
  }

  // Fallback identification for a countdown found OUTSIDE a recognised chain bar: accept
  // it only if a nearby ancestor names the chain.
  function chainTimerSeconds(timer) {
    if (!timer) return null;
    const secs = timerTextSeconds(timer);
    if (secs == null) return null;
    let node = timer.parentElement;
    for (let i = 0; i < 5 && node; i += 1, node = node.parentElement) {
      const t = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length > 80) break; // walked past this single bar into its neighbours
      if (/chain/i.test(t)) return secs;
    }
    return null;
  }
  // Seconds to drop, or null. Preferred path is the chain bar's OWN countdown (scoped to
  // the container, so no other bar can be mistaken for it). The old global hunt stays as a
  // fallback for any layout where the chain-bar class isn't what we expect.
  function readSidebarChainSeconds() {
    try {
      for (const bar of chainBarNodes()) {
        const secs = timerTextSeconds(bar.querySelector('[class*="timeleft"]'));
        if (secs != null) return secs;
      }
      if (sidebarChainNode && sidebarChainNode.isConnected) {
        const secs = chainTimerSeconds(sidebarChainNode);
        if (secs != null) return secs;
        sidebarChainNode = null;
      }
      for (const timer of document.querySelectorAll('[class*="timeleft"]')) {
        const secs = chainTimerSeconds(timer);
        if (secs != null) {
          sidebarChainNode = timer;
          return secs;
        }
      }
    } catch {
      sidebarChainNode = null;
    }
    return null;
  }

  // How long since the on-screen chain snapshot was last confirmed by a successful read,
  // and whether that's long enough to stop calling it live. Everything the panel shows
  // from state.chain (hit count, drop timer, bonus progress) is only as true as this.
  function chainStaleness() {
    if (!state.chain) return { ageMs: 0, stale: false };
    const at = state.chainConfirmedAt ?? state.chain.fetchedAt ?? null;
    if (at == null) return { ageMs: 0, stale: false };
    const ageMs = Date.now() - at;
    const limit = state.liveSource === "cache" ? CHAIN_STALE_CACHE_MS : CHAIN_STALE_MS;
    return { ageMs, stale: ageMs > limit };
  }

  // Torn's own chain bar is the player-visible truth, it ticks every second, and it costs
  // no API call. Once chainTimerSeconds has confidently identified it (the bar's own text
  // says "Chain", and the value is inside the chain timer's real 0–300s range) it OUTRANKS
  // our API snapshot — so re-anchor to it. This also keeps the API-derived countdown honest
  // for the moments the bar isn't readable (PDA, pages without the sidebar).
  //
  // It previously only won when it agreed with the API to within 90s, which inverted the
  // priority exactly when it mattered: once a poll failed, the API countdown ran down to
  // 00:00, the sidebar's real 4:00 was then >90s away, and the correct number on the page
  // got rejected as implausible.
  function syncChainFromSidebar() {
    if (!state.chain?.active) {
      clearChainEstimate();
      return null;
    }
    // Hits first: a reset invalidates the collected bounds, so it must be applied before
    // this tick's timer reading is folded in.
    noteChainHits(currentHitsBest());
    const dom = readSidebarChainSeconds();
    if (dom != null) {
      state.chain.timeout = dom;
      state.chain.fetchedAt = Date.now();
      state.sidebarSyncedAt = Date.now();
      noteChainTimer(dom); // exact — keeps the estimate right if the bar later disappears
    }
    // The hit count is handled differently on purpose. The timer is safe to adopt outright
    // because it's a pure countdown, but Torn's own bar may refresh more lazily than our
    // 3s API poll — adopting its hits unconditionally could drag a FRESH count backwards.
    // So it's only used to repair a snapshot we already know is stale, which is exactly
    // the case that matters (and the only chain truth mobile/PDA can offer at all).
    if (chainStaleness().stale) {
      const hits = readSidebarChainHits();
      if (hits != null && hits !== state.chain.current) {
        state.chain.current = hits;
        state.sidebarHitsSyncedAt = Date.now();
      }
    }
    return dom;
  }

  // True while Torn's own chain bar is supplying the hit count (stale-API repair above).
  function sidebarHitsLive() {
    return state.sidebarHitsSyncedAt != null && Date.now() - state.sidebarHitsSyncedAt < 15000;
  }

  // True while Torn's own chain bar is feeding us a live countdown. When it is, the drop
  // timer is trustworthy even if the API snapshot behind the hit count has gone stale.
  function sidebarTimerLive() {
    return state.sidebarSyncedAt != null && Date.now() - state.sidebarSyncedAt < 5000;
  }

  // Torn doesn't call it a chain until 10 hits land inside the timer — below that you're in
  // CHAIN WARM-UP, which the bar's own tooltip spells out: "Make 9 more hits within 00:17
  // to start a chain". The API reports current/timeout during warm-up exactly as it does
  // mid-chain, so the panel was badging it LIVE and calling the countdown a "drop timer" —
  // wrong on both counts, and precisely the kind of status mismatch members were reporting.
  // The hit-or-lose-it urgency is identical, so alarms and the countdown stay on as they
  // are; only the labelling changes to match what Torn is actually showing.
  const CHAIN_WARMUP_HITS = 10;
  function chainWarmup() {
    return Boolean(state.chain?.active) && state.chain.current < CHAIN_WARMUP_HITS;
  }

  // The hit count we trust most right now: the API's, or Torn's own bar if it's further
  // along (mobile/PDA has the bar but no countdown). Monotonic within a chain run, which is
  // what lets a change in it stand in for "a hit landed".
  function currentHitsBest() {
    const api = state.chain?.current ?? 0;
    const dom = readSidebarChainHits();
    return dom != null && dom > api ? dom : api;
  }

  // A landed hit resets Torn's timer, so every bound we'd collected describes a run that no
  // longer exists. Hit count moving is the unambiguous signal for that — and on mobile the
  // chain bar supplies it every second for free, so PDA detects the reset promptly even
  // while the API poll is easing off.
  function noteChainHits(hits) {
    if (!Number.isFinite(hits)) return;
    if (hits !== state.chainRunHits) {
      state.chainRunHits = hits;
      state.chainDeadline = null;
    }
  }

  // Torn caches /faction/chain, so a response's `timeout` may be several seconds old — and
  // a stale value always OVERSTATES the time left, which is the dangerous direction for a
  // drop alarm. Each observation is therefore an UPPER BOUND on the true deadline, and the
  // tightest bound is the best estimate: keep the MINIMUM across the run. Repeated cached
  // responses are self-cancelling (the same `timeout` read 3s later implies a deadline 3s
  // further out, so the minimum ignores it) and the estimate can never regress.
  //
  // What this does NOT do is beat the poll rate. Simulated against a 30s cache on every
  // phase alignment, the freshest reading available in a cycle is stale by up to just under
  // one poll interval — ~2.8s at a 3s poll, ~9.8s at 10s — and no estimator can recover
  // what was never fetched. That bound, not the estimator, is why the poll cadence has to
  // step up before the timer gets anywhere near an alarm threshold (RELAXED_ABOVE_SEC).
  function noteChainTimer(remainingSec) {
    if (!Number.isFinite(remainingSec) || remainingSec <= 0) return;
    const observed = Date.now() + remainingSec * 1000;
    if (state.chainDeadline == null || observed < state.chainDeadline) {
      state.chainDeadline = observed;
    }
  }

  function clearChainEstimate() {
    state.chainDeadline = null;
    state.chainRunHits = null;
  }

  function chainRemaining() {
    if (!state.chain?.active) return 0;
    // Torn's own bar is exact when we can read it (it's the number the player sees).
    const dom = readSidebarChainSeconds();
    if (dom != null) return dom;
    // Torn's absolute drop instant, converted to this member's clock. Nothing here decays
    // between polls — it is a fixed point that only moves when a hit pushes it out — so
    // this is the countdown on PDA, where there is no chain bar to read.
    if (state.chain.deadlineLocalMs != null) {
      return Math.max(0, Math.round((state.chain.deadlineLocalMs - Date.now()) / 1000));
    }
    if (state.chainDeadline != null) {
      return Math.max(0, Math.round((state.chainDeadline - Date.now()) / 1000));
    }
    return Math.max(0, state.chain.timeout - Math.floor((Date.now() - state.chain.fetchedAt) / 1000));
  }

  function duration(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  function countdownTo(iso) {
    if (!iso) return null;
    return Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
  }

  function tctTime(iso, withDate = false) {
    if (!iso) return "--";
    const d = new Date(iso);
    const opts = withDate
      ? { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }
      : { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" };
    return `${d.toLocaleString("en-US", opts)} TCT`;
  }

  function nextBonus(current) {
    const target = BONUS_MILESTONES.find((n) => n > current);
    if (!target) return null;
    return { target, toGo: target - current };
  }

  function localTime(iso) {
    if (!iso) return "--";
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return "--";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  // Bare "HH:MM" in TCT (UTC), no zone suffix — for building compact time ranges.
  function hhmmTct(iso) {
    if (!iso) return "--";
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return "--";
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  }

  // Two clean, non-breaking lines: the TCT window and the viewer-local window, each
  // with a small zone tag — so nothing wraps mid-value in the narrow time column.
  function shiftLabel(shift) {
    const tct = `${hhmmTct(shift.shift_start)}–${hhmmTct(shift.shift_end)}`;
    const local = `${localTime(shift.shift_start)}–${localTime(shift.shift_end)}`;
    return `<span class="tocw-when-tct">${tct}<span class="tocw-when-zone"> TCT</span></span>` +
      `<span class="tocw-when-local">${local}<span class="tocw-when-zone"> local</span></span>`;
  }

  function statusClass(status) {
    if (status === "Online") return "ok";
    if (status === "Idle") return "warn";
    return "bad";
  }

  // The "Current watcher" / "Next watcher" cards. This must read BOTH payload shapes:
  // refreshAll nulls state.watch in token mode, so reading only state.watch.shifts left
  // every link-mode viewer looking at "No watcher assigned" on a fully staffed sheet —
  // the other half of why clearing the link "fixed" the panel.
  function currentAndNextShift() {
    const now = Date.now();
    const shifts = Array.isArray(state.watch?.shifts)
      ? state.watch.shifts
      : (Array.isArray(state.signup?.shifts) ? state.signup.shifts : []).map((s) => ({
          shift_start: s.shift_start,
          shift_end: s.shift_end,
          watcher_id: s.main?.watcher_id,
          watcher_name: s.main?.watcher_name,
          watcher_online_status: s.main?.online_status,
        }));
    const current = shifts.find((s) => new Date(s.shift_start).getTime() <= now && new Date(s.shift_end).getTime() > now) || null;
    const next = shifts.find((s) => new Date(s.shift_start).getTime() > now) || null;
    return { current, next };
  }

  // --- Who "you" are, and which of the shifts are yours ------------------------

  // The viewer's Torn id: from the session (session mode) or the cached signup
  // identity (token mode). Null when we don't know who's watching (nothing personal).
  function viewerId() {
    const sid = state.watch?.viewer?.player_id ?? state.signup?.viewer?.player_id;
    if (sid != null) return Number(sid);
    const identity = getSignupIdentity();
    return identity && identity.id != null ? Number(identity.id) : null;
  }

  // Every shift the viewer holds (main or backup), across both payload shapes,
  // sorted by start. Empty when the viewer holds none / is unknown.
  function viewerShifts() {
    const vid = viewerId();
    if (vid == null) return [];
    const out = [];
    if (Array.isArray(state.watch?.shifts)) {
      for (const s of state.watch.shifts) {
        if (Number(s.watcher_id) === vid) out.push({ start: s.shift_start, end: s.shift_end, role: "main" });
        if (Number(s.backup_watcher_id) === vid) out.push({ start: s.shift_start, end: s.shift_end, role: "backup" });
      }
    } else if (Array.isArray(state.signup?.shifts)) {
      for (const s of state.signup.shifts) {
        if (s.main && Number(s.main.watcher_id) === vid) out.push({ start: s.shift_start, end: s.shift_end, role: "main" });
        if (s.backup && Number(s.backup.watcher_id) === vid) out.push({ start: s.shift_start, end: s.shift_end, role: "backup" });
      }
    }
    return out.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  }

  // The viewer's currently-active shift (if on watch now) and their next upcoming one.
  function viewerShiftStatus() {
    const now = Date.now();
    const mine = viewerShifts();
    const active = mine.find((s) => new Date(s.start).getTime() <= now && new Date(s.end).getTime() > now) || null;
    const next = mine.find((s) => new Date(s.start).getTime() > now) || null;
    return { active, next };
  }

  // MAIN-slot coverage across both payload shapes: {start, end, id, name, online}.
  function normalizedShifts() {
    if (Array.isArray(state.watch?.shifts)) {
      return state.watch.shifts.map((s) => ({
        start: s.shift_start, end: s.shift_end,
        id: s.watcher_id, name: s.watcher_name, online: s.watcher_online_status,
      }));
    }
    if (Array.isArray(state.signup?.shifts)) {
      return state.signup.shifts.map((s) => ({
        start: s.shift_start, end: s.shift_end,
        id: s.main?.watcher_id, name: s.main?.watcher_name, online: s.main?.online_status,
      }));
    }
    return [];
  }

  // Handoff readiness for the shift that's ending: is the NEXT slot covered by someone
  // online? Returns null until the current shift is within HANDOFF_WARN of ending.
  //  - "gap":   no next watcher assigned at all
  //  - "risk":  next watcher assigned but not Online (idle/offline)
  //  - "ready": next watcher assigned and Online
  function handoffStatus() {
    const rows = normalizedShifts();
    const now = Date.now();
    const current = rows.find((s) => new Date(s.start).getTime() <= now && new Date(s.end).getTime() > now) || null;
    if (!current) return null;
    const handoffAt = new Date(current.end).getTime();
    const endsIn = Math.floor((handoffAt - now) / 1000);
    if (endsIn > HANDOFF_WARN_SECS) return null;
    // The shift that covers the instant this one ends (the contiguous next slot). If
    // nothing covers it, there's an immediate unmanned gap right after the handoff.
    const cover = rows.find((s) => new Date(s.start).getTime() <= handoffAt && new Date(s.end).getTime() > handoffAt) || null;
    // A missing assignment is a fact about the sheet, so it stands even on old data.
    if (!cover || cover.id == null) return { state: "gap", endsIn, name: null, online: null, stale: false };
    // Whether they're ONLINE is not. That comes from the throttled schedule poll, and
    // claiming "the next watcher isn't online" off a two-minute-old roster is how a panel
    // ends up waking someone to chase a watcher who has been at their desk the whole time.
    // Say we don't know instead — the handoff is still flagged, just without the false claim.
    // A NAME is stable, so resolving it from any roster we have is always fine. ONLINE
    // STATUS is not — it changes by the minute, and this decides whether to wake someone.
    // So each source only counts while it's actually fresh: the payload's until the
    // schedule goes stale, ours until the same age. Our roster refreshes on the slow
    // ROSTER_MIN_INTERVAL, so it will often be too old to vouch for a status even though
    // its names remain perfectly good — which is the honest split.
    const name = rosterName(cover.id, cover.name || `ID ${cover.id}`);
    const payloadStatus = scheduleStale() ? null : (cover.online ?? null);
    const rosterFresh = lastRosterAt > 0 && Date.now() - lastRosterAt <= SCHEDULE_STALE_MS;
    const ownStatus = rosterFresh ? (state.tornRoster?.[cover.id]?.status ?? null) : null;
    const status = payloadStatus ?? ownStatus;
    if (status == null) return { state: "unknown", endsIn, id: cover.id, name, online: null, stale: true };
    return { state: status === "Online" ? "ready" : "risk", endsIn, id: cover.id, name, online: status, stale: false };
  }

  // True when the schedule payload (shifts + roster + online status) is old enough that
  // its online flags shouldn't be treated as current.
  function scheduleStale() {
    if (state.scheduleConfirmedAt == null) return true;
    return Date.now() - state.scheduleConfirmedAt > SCHEDULE_STALE_MS;
  }

  // "~Xm" ETA to close a gap of `toGo` hits at `pacePerMin`. Empty when unknown.
  function etaText(toGo, pacePerMin) {
    if (!pacePerMin || pacePerMin <= 0 || toGo <= 0) return "";
    const mins = toGo / pacePerMin;
    if (!Number.isFinite(mins)) return "";
    if (mins < 1) return "~<1m";
    if (mins < 60) return `~${Math.round(mins)}m`;
    return `~${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`;
  }

  // --- Alarms (opt-in): sound (WebAudio), vibration, and a panel flash ---------

  let audioCtx = null;
  // Must be primed by a user gesture (the alarm toggle) or the browser/PDA blocks
  // audio; resuming a suspended context here is what makes later beeps actually play.
  function primeAudio() {
    try {
      if (!audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        audioCtx = new Ctx();
      }
      if (audioCtx.state === "suspended") void audioCtx.resume();
    } catch {
      audioCtx = null;
    }
  }

  function beep(count = 1, freq = 880, type = "square") {
    if (!audioCtx) primeAudio();
    if (!audioCtx) return;
    const peak = Math.max(0.0002, state.alarmVolume); // exponential ramps can't hit 0
    try {
      const t0 = audioCtx.currentTime;
      for (let i = 0; i < count; i += 1) {
        const at = t0 + i * 0.18;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = type;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(peak, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.15);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(at);
        osc.stop(at + 0.17);
      }
    } catch {
      /* audio can fail on some webviews — never let it break the tick */
    }
  }

  // Named tone presets so watchers can pick a sound they'll actually notice.
  const ALARM_TONES = ["beep", "chime", "siren"];
  function playAlarmSound(kind) {
    const drop = kind === "drop";
    if (state.alarmTone === "chime") return beep(drop ? 3 : 2, drop ? 1320 : 988, "sine");
    if (state.alarmTone === "siren") return beep(drop ? 4 : 2, drop ? 860 : 640, "sawtooth");
    return beep(drop ? 3 : 2, drop ? 990 : 740, "square"); // beep (default)
  }

  function flashPanel(kind) {
    const box = document.getElementById("tocw");
    if (!box) return;
    const cls = kind === "drop" ? "tocw-flash-bad" : "tocw-flash-warn";
    box.classList.remove(cls);
    void box.offsetWidth; // restart the animation
    box.classList.add(cls);
    setTimeout(() => box.classList.remove(cls), 1500);
  }

  function notify(message) {
    try {
      if (typeof GM_notification === "function") {
        GM_notification({ title: "Chain Watch", text: message, timeout: 8000, silent: !state.alarmSound });
      }
    } catch {
      /* notifications unavailable */
    }
  }

  // Speak an alert aloud (voice countdown). cancel() first so alerts don't queue up
  // into a backlog when several fire close together near the drop.
  function speak(message) {
    try {
      const synth = window.speechSynthesis;
      if (!synth || typeof SpeechSynthesisUtterance !== "function") return;
      const u = new SpeechSynthesisUtterance(String(message));
      u.rate = 1.1;
      u.volume = Math.max(0.15, state.alarmVolume);
      synth.cancel();
      synth.speak(u);
    } catch {
      /* TTS unavailable on this webview */
    }
  }

  // A short rising chime (distinct from the alarm) for bonus celebrations.
  function chime(freqs) {
    if (!audioCtx) primeAudio();
    if (!audioCtx) return;
    const peak = Math.max(0.0002, state.alarmVolume);
    try {
      const t0 = audioCtx.currentTime;
      (freqs || [660, 880, 1174]).forEach((f, i) => {
        const at = t0 + i * 0.13;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.value = f;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(peak, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(at);
        osc.stop(at + 0.24);
      });
    } catch {
      /* ignore */
    }
  }

  // Bonus milestone landed: a green flash + rising chime + a celebratory notice.
  function celebrate(milestone) {
    const box = document.getElementById("tocw");
    if (box) {
      box.classList.remove("tocw-flash-good");
      void box.offsetWidth;
      box.classList.add("tocw-flash-good");
      setTimeout(() => box.classList.remove("tocw-flash-good"), 1500);
    }
    chime();
    state.notice = `🎉 ${Number(milestone).toLocaleString()} chain bonus!`;
  }

  function fireAlarm(kind, message) {
    if (state.alarmSound) playAlarmSound(kind);
    if (state.alarmVibrate) {
      try {
        navigator.vibrate?.(kind === "drop" ? [130, 60, 130, 60, 220] : [200, 100, 200]);
      } catch {
        /* not supported */
      }
    }
    if (state.alarmFlash) flashPanel(kind);
    if (state.alarmNotify) notify(message);
    if (state.alarmVoice) speak(message);
    state.notice = message;
  }

  // --- Screen wake lock: keep a phone/PDA awake while on watch so the alarm fires ---
  let wakeLock = null;
  async function acquireWakeLock() {
    try {
      if (wakeLock || !("wakeLock" in navigator)) return;
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener?.("release", () => { wakeLock = null; });
    } catch {
      wakeLock = null; // denied / unsupported — silently do without
    }
  }
  function releaseWakeLock() {
    try {
      wakeLock?.release?.();
    } catch {
      /* ignore */
    }
    wakeLock = null;
  }
  // Hold the lock while you're the active watcher, or a chain is live and alarms are
  // armed (you're actively hitting). The OS drops the lock when the tab hides, so this
  // (called each tick + on visibility change) re-acquires it when you come back.
  function updateWakeLock() {
    const want = state.wakeLockEnabled
      && document.visibilityState === "visible"
      && (Boolean(viewerShiftStatus().active) || (Boolean(state.chain?.active) && state.alarm));
    if (want && !wakeLock) void acquireWakeLock();
    else if (!want && wakeLock) releaseWakeLock();
  }

  // Per-poll chain lifecycle: accumulate YOUR hits across the chain (dedup by
  // timestamp), celebrate bonus milestones, snapshot a post-chain summary when it
  // ends, and auto-enter/exit focus mode on your shift. Runs after each data poll.
  function updateChainLifecycle() {
    const active = Boolean(state.chain?.active);
    const cur = state.chain?.current || 0;

    // A DIFFERENT chain run, identified by Torn's own chain id. This catches the case the
    // active/!wasChainActive edge cannot: one chain ending and the next starting between
    // two polls (easy on the relaxed cadence, or across a backgrounded tab), where we
    // never observe active=false and would otherwise carry the previous chain's peak,
    // your-hits and bonus tracking straight into the new one — and merge them into its
    // "chain ended" recap. id is 0 when Torn omits it, in which case nothing changes.
    const id = state.chain?.id || 0;
    const newRun = active && id > 0 && state.lastChainId != null && id !== state.lastChainId;
    if (active) state.lastChainId = id;

    // No recap is carried across a newRun on purpose: reaching this branch means we never
    // saw the previous chain end, so its totals are partial by definition and a "chain
    // ended: 40 hits" card built from them would understate a chain we simply missed.
    if (newRun) clearChainEstimate();
    if ((active && !state.wasChainActive) || newRun) {
      // A fresh chain started — reset the per-chain accumulators.
      state.chainYourHits = 0;
      state.chainYourRespect = 0;
      state.chainSeenTs = new Set();
      state.chainPeak = 0;
      state.lastBonusPassed = BONUS_MILESTONES.filter((n) => n <= cur).pop() || 0;
      state.chainSummary = null;
    }

    if (active) {
      state.chainPeak = Math.max(state.chainPeak, cur);
      // Accumulate your hits over the whole chain from the direct attack feed (deduped
      // by timestamp so overlapping poll windows don't double-count).
      const mine = state.attacks?.mine;
      if (Array.isArray(mine?.ts)) {
        for (let i = 0; i < mine.ts.length; i += 1) {
          const t = mine.ts[i];
          if (!state.chainSeenTs.has(t)) {
            state.chainSeenTs.add(t);
            state.chainYourHits += 1;
            state.chainYourRespect += mine.respect?.[i] || 0;
          }
        }
      }
      // Bonus celebration when a milestone is crossed.
      if (state.celebrate) {
        const passed = BONUS_MILESTONES.filter((n) => n <= cur).pop() || 0;
        if (passed > state.lastBonusPassed) {
          state.lastBonusPassed = passed;
          celebrate(passed);
        }
      }
    }

    if (!active && state.wasChainActive && state.chainPeak > 0) {
      // Chain just ended — snapshot the recap.
      state.chainSummary = {
        totalHits: state.chainPeak,
        yourHits: state.chainYourHits,
        yourRespect: state.chainYourRespect,
      };
    }

    if (state.autoFocus && !state.settingsOpen) {
      // React only to on-watch TRANSITIONS so a manual focus toggle mid-shift sticks.
      const onWatch = Boolean(viewerShiftStatus().active);
      if (onWatch && !state.wasOnWatch && !state.focus) {
        state.focus = true;
        gmSet(STORE.focus, true);
      } else if (!onWatch && state.wasOnWatch && state.focus) {
        state.focus = false;
        gmSet(STORE.focus, false);
      }
      state.wasOnWatch = onWatch;
    }

    state.wasChainActive = active;
    pruneFiredShift();
  }

  // firedShift keys are `<shift ISO start>:<kind>` and were never removed, so a long-lived
  // tab across many chains accumulated them without bound. Shifts that finished a day ago
  // can never fire again, so drop them. Cheap, and only walks the set once it's large.
  function pruneFiredShift() {
    if (state.firedShift.size < 64) return;
    const cutoff = Date.now() - 86400000;
    for (const key of state.firedShift) {
      const at = new Date(key.slice(0, key.lastIndexOf(":"))).getTime();
      if (Number.isFinite(at) && at < cutoff) state.firedShift.delete(key);
    }
  }

  // Runs every second (even while collapsed/hidden — the whole point is to alert you
  // when you're NOT looking). Fires each drop threshold once per chain run, re-arming
  // when a fresh hit pushes the timer back up; warns before + at your shift start.
  function evaluateAlarms() {
    if (!state.alarm) return;

    if (state.chain?.active && chainStaleness().stale && !sidebarTimerLive()) {
      // The countdown is running off a snapshot nothing has confirmed in a while, so a
      // "drops in 10s" alarm here would be a guess. Say the true thing once instead —
      // a wrong drop alarm is worse than none, because watchers stop trusting the alarm.
      // Exempt when torn.com's own chain bar is feeding us the countdown: the API being
      // stale doesn't make the timer wrong, and that's when the alarm matters most.
      if (!state.firedDrop.has("stale")) {
        state.firedDrop.add("stale");
        fireAlarm("drop", "Chain data went stale — check the chain on Torn.");
      }
    } else if (state.chain?.active) {
      const remaining = chainRemaining();
      // A fresh hit reset the timer upward → re-arm the thresholds for this run.
      if (state.lastRemaining != null && remaining > state.lastRemaining + 3) state.firedDrop.clear();
      state.lastRemaining = remaining;
      for (const t of effThresholds()) {
        if (remaining > 0 && remaining <= t && !state.firedDrop.has(t)) {
          state.firedDrop.add(t);
          fireAlarm("drop", chainWarmup()
            ? `Warm-up ends in ${remaining}s — ${CHAIN_WARMUP_HITS - state.chain.current} more to start the chain!`
            : `Chain drops in ${remaining}s — HIT NOW!`);
          break; // one alert per tick
        }
      }
    } else {
      state.firedDrop.clear();
      state.lastRemaining = null;
    }

    const { active, next } = viewerShiftStatus();
    if (next) {
      const secs = countdownTo(next.start);
      if (secs != null) {
        const warnKey = `${next.start}:warn`;
        const nowKey = `${next.start}:now`;
        if (secs <= SHIFT_WARN_SECS && secs > 30 && !state.firedShift.has(warnKey)) {
          state.firedShift.add(warnKey);
          fireAlarm("shift", `Your ${next.role} shift starts in ${Math.max(1, Math.round(secs / 60))}m — get ready.`);
        }
        if (secs <= 5 && !state.firedShift.has(nowKey)) {
          state.firedShift.add(nowKey);
          fireAlarm("shift", "Your shift is starting now.");
        }
      }
    }
    if (active) {
      const liveKey = `${active.start}:live`;
      if (!state.firedShift.has(liveKey)) {
        state.firedShift.add(liveKey);
        fireAlarm("shift", "You're on watch now — keep the chain alive.");
      }
      // Handoff: your shift is ending and the next slot isn't covered by someone online.
      const handoff = handoffStatus();
      if (handoff && (handoff.state === "gap" || handoff.state === "risk")) {
        const handoffKey = `${active.start}:handoff`;
        if (!state.firedShift.has(handoffKey)) {
          state.firedShift.add(handoffKey);
          fireAlarm("shift", handoff.state === "gap"
            ? "No watcher scheduled after you — get the next slot covered!"
            : `Next watcher (${handoff.name}) isn't online — ping them before you hand off.`);
        }
      }
    }
  }

  // Drop-timer urgency: green while comfortable, amber approaching, red (pulsing) close.
  // Plain-language account of where the countdown is coming from and whether it's exact.
  // Deliberately visible (the TORN LIVE tooltip) so this is verifiable in the field rather
  // than something we assume: if Torn stops sending a header, it says so instead of
  // silently degrading to a bounded guess.
  function timerSourceLabel() {
    if (sidebarTimerLive()) return "Exact — read from Torn's own chain bar on this page.";
    const src = state.chain?.timeSource;
    const stale = state.chain?.staleSec;
    if (src === "chain.end") {
      const off = serverClockOffsetSec();
      const skew = off == null ? "" : ` Your clock differs from Torn's by ${off >= 0 ? "+" : ""}${off.toFixed(1)}s, corrected for.`;
      const age = Math.round(stale || 0);
      return `Exact — counting down to Torn's absolute drop time (chain.end).`
        + `${age > 1 ? ` That response was ${age}s old.` : " The endpoint answered live (no cache lag)."}${skew}`;
    }
    if (src === "age") {
      return `Exact — corrected with the response's Age header (was ${Math.round(stale || 0)}s cached).`;
    }
    if (src === "date") {
      return `Corrected to ~1s using the response Date header (was ~${Math.round(stale || 0)}s cached).`;
    }
    return "Approximate — Torn sent no freshness header, so the countdown is bounded by the poll interval, not exact.";
  }

  function timerUrgencyClass(remaining) {
    if (remaining <= 0) return "";
    if (remaining <= 30) return "u-bad";
    if (remaining <= 60) return "u-warn";
    return "u-ok";
  }

  function createShell() {
    if (!document.getElementById("tocw-style")) {
      const style = document.createElement("style");
      style.id = "tocw-style";
      style.textContent = `
      #tocw {
        position: fixed;
        left: 82px;
        bottom: 124px;
        width: 390px;
        min-width: ${MIN_PANEL_W}px;
        max-height: min(680px, calc(100vh - 148px));
        display: flex;
        flex-direction: column;
        overflow: hidden;
        z-index: 2147483646;
        background: #101923;
        color: #eaf3ff;
        border: 1px solid #38495e;
        border-radius: 10px;
        box-shadow: 0 14px 34px rgba(0,0,0,.42);
        font-family: Arial, sans-serif;
        font-size: 13px;
        pointer-events: auto;
      }
      #tocw * { box-sizing: border-box; }
      #tocw-resize {
        position: absolute;
        right: 1px;
        bottom: 1px;
        width: 18px;
        height: 18px;
        cursor: nwse-resize;
        touch-action: none;
        z-index: 3;
        border-bottom-right-radius: 9px;
        background: linear-gradient(135deg, transparent 46%, #46596f 46%, #46596f 56%, transparent 56%, transparent 68%, #46596f 68%, #46596f 78%, transparent 78%);
      }
      #tocw-resize:hover { background: linear-gradient(135deg, transparent 46%, #6f88a6 46%, #6f88a6 56%, transparent 56%, transparent 68%, #6f88a6 68%, #6f88a6 78%, transparent 78%); }
      #tocw button, #tocw-modal button {
        cursor: pointer;
        border: 1px solid #34465d;
        border-radius: 7px;
        background: #182335;
        color: #f7fbff;
        font-weight: 700;
        padding: 7px 9px;
      }
      #tocw button.primary, #tocw-modal button.primary { background: #ff3b45; border-color: #ff3b45; }
      #tocw button.small { padding: 4px 7px; font-size: 11px; }
      #tocw button:disabled { opacity: .55; cursor: wait; }
      .tocw-head { flex: 0 0 auto; padding: 14px 14px 10px; border-bottom: 1px solid #25384d; cursor: move; touch-action: none; user-select: none; }
      .tocw-head button { cursor: pointer; }
      .tocw-title { font-size: 19px; font-weight: 800; margin: 0 0 5px; }
      .tocw-muted { color: #9eb4ce; font-size: 12px; line-height: 1.35; }
      .tocw-pills { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }
      .tocw-pill { display: inline-flex; align-items: center; min-height: 21px; padding: 3px 8px; border-radius: 999px; font-size: 11px; font-weight: 800; background: #1d344f; color: #d9ebff; }
      .tocw-pill.ok { background: #103d2b; color: #d6ffe8; }
      .tocw-pill.warn { background: #67420c; color: #ffe1a7; }
      .tocw-pill.bad { background: #651922; color: #ffc6cc; }
      .tocw-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 12px 14px 14px; display: grid; gap: 10px; align-content: start; }
      .tocw-card { background: #0d141d; border: 1px solid #2b3d52; border-radius: 8px; padding: 10px; }
      .tocw-card-title { font-weight: 800; margin-bottom: 6px; }
      .tocw-big { font-size: 32px; font-weight: 900; letter-spacing: 0; line-height: 1; }
      .tocw-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .tocw-row { display: grid; grid-template-columns: 108px 1fr; gap: 12px; align-items: start; padding: 10px 4px 10px 10px; border-top: 1px solid #25384d; border-radius: 6px; }
      .tocw-row:first-child { border-top: 0; }
      /* Shift time: two non-breaking lines (TCT window, then local), tiny zone tags */
      .tocw-when-tct { display: block; white-space: nowrap; font-weight: 700; color: #eaf3ff; font-size: 12.5px; }
      .tocw-when-local { display: block; white-space: nowrap; font-size: 11px; color: #93a8c2; margin-top: 2px; }
      .tocw-when-zone { font-weight: 400; font-size: 10px; color: #7385a0; }
      /* Main + backup stack vertically, each its own clear line (role · who · action) */
      .tocw-slots { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
      /* A slot is role · who · actions on one line. The actions were flex-shrink:0 while
         the name had min-width:0, so at phone widths the three buttons took everything and
         the name collapsed to a few pixels and spilled underneath them — the overlap in the
         PDA screenshot. Giving the name a real minimum makes the ACTIONS wrap to their own
         line instead, which is the right thing to give up first. */
      .tocw-slot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; row-gap: 6px; }
      .tocw-slot__role { min-width: 52px; font-weight: 700; color: #9eb4ce; }
      .tocw-slot--backup .tocw-slot__role { color: #7f93ad; }
      .tocw-slot__who { flex: 1 1 120px; min-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tocw-slot__actions { display: flex; gap: 5px; flex-wrap: wrap; justify-content: flex-end; flex-shrink: 0; margin-left: auto; }
      /* Member names link to their Torn profile. Explicit colors so torn.com's own anchor
         styles can't bleed in and turn them unreadable inside the panel. */
      .tocw-who { color: #eaf3ff; text-decoration: none; border-bottom: 1px dotted #5b708a; }
      .tocw-who:hover { color: #fff; border-bottom-color: #9eb4ce; }
      .tocw-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; margin-right: 5px; background: #789; }
      .tocw-dot.ok { background: #32d47b; }
      .tocw-dot.warn { background: #f2b13c; }
      .tocw-dot.bad { background: #ff5d67; }
      /* Roster picker for assigning a slot. Scrolls inside its own box so a 100-member
         faction can't push the buttons below it off the panel. */
      .tocw-picker { max-height: 210px; overflow-y: auto; -webkit-overflow-scrolling: touch; border: 1px solid #2b3d52; border-radius: 7px; padding: 4px; }
      .tocw-pick { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: transparent; border: 0; border-radius: 6px; padding: 8px; font-weight: 600; }
      .tocw-pick:hover { background: #17263a; }
      .tocw-pick__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tocw-alert { padding: 8px 9px; border-radius: 7px; background: #21180b; border: 1px solid #67420c; color: #ffdca1; }
      .tocw-alert.bad { background: #231016; border-color: #651922; color: #ffc6cc; }
      .tocw-actions { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
      .tocw-progress { height: 8px; background: #0a1018; border-radius: 999px; overflow: hidden; border: 1px solid #28394d; margin-top: 6px; }
      .tocw-progress span { display: block; height: 100%; background: #35b76f; }
      /* Drop-timer urgency */
      .tocw-big.u-ok, .tocw-focus-timer.u-ok, .tocw-cstatus-timer.u-ok { color: #6ff0a8; }
      .tocw-big.u-warn, .tocw-focus-timer.u-warn, .tocw-cstatus-timer.u-warn { color: #ffcf6b; }
      .tocw-big.u-bad, .tocw-focus-timer.u-bad, .tocw-cstatus-timer.u-bad { color: #ff6d76; animation: tocw-pulse .9s ease-in-out infinite; }
      @keyframes tocw-pulse { 0%,100% { opacity: 1; } 50% { opacity: .4; } }
      /* Focus (on-watch) mode + HIT button */
      .tocw-focus { text-align: center; padding: 6px 0 2px; }
      .tocw-focus-timer { font-size: 58px; font-weight: 900; line-height: 1; letter-spacing: -1px; }
      .tocw-focus-sub { font-size: 15px; margin-top: 4px; }
      .tocw-hit { display: block; width: 100%; text-align: center; text-decoration: none; padding: 12px; border-radius: 9px; font-weight: 900; font-size: 15px; background: #243447; color: #eaf3ff; border: 1px solid #3a5573; }
      .tocw-hit--setup { background: transparent; border-style: dashed; color: #cfe0f7; font-weight: 700; font-size: 13px; cursor: pointer; }
      .tocw-hit-sub { display: block; font-size: 11px; font-weight: 700; opacity: .85; margin-top: 2px; }
      .tocw-hit.urgent { background: #ff3b45; border-color: #ff6870; color: #fff; animation: tocw-pulse .8s ease-in-out infinite; }
      #tocw-focus.on { background: #234; border-color: #46617f; }
      /* Alarm flash on the whole panel */
      @keyframes tocw-flashbad { 30% { box-shadow: 0 0 0 4px rgba(255,60,72,.9), 0 0 34px rgba(255,60,72,.75); } 100% { box-shadow: 0 14px 34px rgba(0,0,0,.42); } }
      @keyframes tocw-flashwarn { 30% { box-shadow: 0 0 0 4px rgba(255,190,80,.85), 0 0 30px rgba(255,190,80,.6); } 100% { box-shadow: 0 14px 34px rgba(0,0,0,.42); } }
      @keyframes tocw-flashgood { 30% { box-shadow: 0 0 0 4px rgba(53,183,111,.9), 0 0 34px rgba(53,183,111,.7); } 100% { box-shadow: 0 14px 34px rgba(0,0,0,.42); } }
      #tocw.tocw-flash-bad { animation: tocw-flashbad 1.4s ease-out; }
      #tocw.tocw-flash-warn { animation: tocw-flashwarn 1.4s ease-out; }
      #tocw.tocw-flash-good { animation: tocw-flashgood 1.4s ease-out; }
      /* Active / your shift row highlight */
      .tocw-row.active { background: #12233a; box-shadow: inset 3px 0 0 #35b76f; }
      .tocw-row.mine { box-shadow: inset 3px 0 0 #ff9f43; }
      .tocw-row.active.mine { background: #1a2740; box-shadow: inset 3px 0 0 #ffce54; }
      .tocw-you { display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 999px; font-size: 10px; font-weight: 800; background: #ff9f43; color: #201200; vertical-align: middle; }
      /* Watcher status banner + alarm button */
      .tocw-watch-banner { padding: 9px 10px; border-radius: 8px; font-weight: 800; display: flex; justify-content: space-between; gap: 8px; align-items: center; }
      .tocw-watch-banner.on { background: #103d2b; color: #d6ffe8; border: 1px solid #2f7d55; }
      .tocw-watch-banner.soon { background: #1d344f; color: #d9ebff; border: 1px solid #34506f; }
      .tocw-watch-banner .tocw-shift-time { font-size: 17px; font-weight: 900; }
      #tocw-alarm.on { background: #ff3b45; border-color: #ff6870; color: #fff; }
      /* Wide content (the leaderboard table) scrolls inside its own box, never the panel */
      .tocw-scroll-x { overflow-x: auto; -webkit-overflow-scrolling: touch; }
      /* Explicit colors so torn.com's own table styles can't bleed in (was black text) */
      .tocw-table { width: 100%; border-collapse: collapse; font-size: 12px; color: #eaf3ff; background: transparent; }
      .tocw-table th, .tocw-table td { text-align: right; padding: 5px 6px; border-top: 1px solid #25384d; white-space: nowrap; color: #eaf3ff; background: transparent; }
      .tocw-table th { color: #9eb4ce; font-weight: 700; }
      .tocw-table th:first-child, .tocw-table td:first-child { text-align: left; position: sticky; left: 0; background: #0d141d; }
      /* Compact drop-timer status shown only when minimized (hidden when expanded) */
      .tocw-cstatus { display: none; margin-top: 1px; white-space: nowrap; }
      .tocw-cstatus-timer { font-weight: 900; font-size: 21px; line-height: 1; }
      #tocw.collapsed { width: 240px; min-width: 0; height: auto; max-height: none; overflow: visible; }
      #tocw.collapsed .tocw-head { padding: 10px; border-bottom: 0; }
      #tocw.collapsed .tocw-pills { margin-bottom: 6px; }
      #tocw.collapsed .tocw-pills .tocw-pill:nth-child(n+2) { display: none; }
      #tocw.collapsed .tocw-title, #tocw.collapsed .tocw-subtitle { display: none; }
      #tocw.collapsed .tocw-cstatus { display: block; }
      #tocw.collapsed #tocw-focus { display: none; }
      #tocw.collapsed #tocw-collapse, #tocw.collapsed #tocw-hide, #tocw.collapsed #tocw-alarm { padding: 5px 8px; font-size: 12px; }
      #tocw.collapsed .tocw-body { display: none; }
      #tocw.collapsed #tocw-resize { display: none; }
      /* In-panel settings view (was a modal — now inherits the panel's z-index + drag) */
      .tocw-settings label { display: grid; gap: 5px; margin-bottom: 10px; color: #cfe0f7; font-size: 12px; font-weight: 700; }
      .tocw-settings input, .tocw-settings select, .tocw-settings textarea {
        width: 100%;
        padding: 9px 10px;
        border-radius: 7px;
        border: 1px solid #33465e;
        background: #0b1119;
        color: #f8fbff;
      }
      .tocw-settings textarea { font-family: inherit; font-size: 13px; resize: vertical; }
      .tocw-settings input[type="range"] { padding: 0; }
      .tocw-settings input[type="checkbox"] { width: auto; }
      .tocw-settings .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .tocw-settings .tocw-check { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-weight: 700; color: #cfe0f7; font-size: 13px; }
      .tocw-settings .tocw-modal-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; margin-top: 14px; }
      @media (max-width: 760px) {
        #tocw { left: 8px; right: 8px; top: auto; bottom: 8px; width: auto; max-height: 80vh; font-size: 14px; }
        #tocw .tocw-body { padding: 12px 12px 16px; gap: 12px; }
        #tocw button.small { padding: 8px 11px; font-size: 13px; }
        #tocw .tocw-actions button { padding: 11px 9px; }
        .tocw-settings .grid { grid-template-columns: 1fr; }
        .tocw-big { font-size: 30px; }
        .tocw-focus-timer { font-size: 64px; }
        /* Reclaim the fixed 108px time column: at phone widths it is a third of the row,
           and the shift window reads fine as a heading above the slots. */
        .tocw-row { grid-template-columns: 1fr; gap: 8px; padding: 12px 10px; }
        .tocw-when-tct, .tocw-when-local { display: inline; }
        .tocw-when-local { margin-left: 10px; }
        /* The coloured dot already encodes online status; the word beside it just competed
           with the name for space. Keep it on desktop, drop it here (the dot carries a
           title with the full status). */
        .tocw-slot__who .tocw-slot__status { display: none; }
        .tocw-slot__actions button.small { padding: 7px 9px; font-size: 12px; }
      }
    `;
      document.head.appendChild(style);
    }

    if (!document.getElementById("tocw")) {
      const box = document.createElement("div");
      box.id = "tocw";
      document.body.appendChild(box);
      applyPanelPosition(box);
    }
  }

  function bindDrag(box) {
    const handle = document.getElementById("tocw-drag-handle");
    if (!handle || handle.dataset.bound === "1") return;
    handle.dataset.bound = "1";
    handle.addEventListener("pointerdown", (event) => {
      if (event.button != null && event.button !== 0) return;
      if (event.target?.closest?.("button, input, textarea, select, a, summary")) return;
      const rect = box.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      box.style.left = `${rect.left}px`;
      box.style.top = `${rect.top}px`;
      box.style.right = "auto";
      box.style.bottom = "auto";
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();

      const move = (moveEvent) => {
        const next = clampPosition(
          moveEvent.clientX - offsetX,
          moveEvent.clientY - offsetY,
          box.offsetWidth,
          box.offsetHeight,
        );
        box.style.left = `${next.left}px`;
        box.style.top = `${next.top}px`;
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        savePanelPosition(box);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
      window.addEventListener("pointercancel", up, { once: true });
    });
  }

  // Bottom-right grip: drag to resize the panel (touch-friendly for PDA). The
  // top-left is pinned so it grows toward the corner; the chosen size persists.
  function bindResize(box) {
    const grip = document.getElementById("tocw-resize");
    if (!grip || grip.dataset.bound === "1") return;
    grip.dataset.bound = "1";
    grip.addEventListener("pointerdown", (event) => {
      if (event.button != null && event.button !== 0) return;
      const rect = box.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const startW = rect.width;
      const startH = rect.height;
      // Anchor the top-left corner so only width/height change under the grip.
      box.style.left = `${rect.left}px`;
      box.style.top = `${rect.top}px`;
      box.style.right = "auto";
      box.style.bottom = "auto";
      box.style.maxHeight = "none";
      grip.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();

      const move = (moveEvent) => {
        const next = clampSize(startW + (moveEvent.clientX - startX), startH + (moveEvent.clientY - startY));
        box.style.width = `${next.width}px`;
        box.style.height = `${next.height}px`;
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        savePanelSize(box);
        savePanelPosition(box);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
      window.addEventListener("pointercancel", up, { once: true });
    });
  }

  let lastRenderView = null;
  // The notice currently on screen and when it first appeared (see NOTICE_TTL_MS).
  let shownNotice = null;
  let shownNoticeAt = 0;
  // opts.background marks a render driven by the data loop (or a spinner) rather than by
  // a direct interaction with what's on screen.
  function render(opts = {}) {
    createShell();
    const box = document.getElementById("tocw");
    if (!box) return;
    // Settings is a FORM, and a poll rebuilding it mid-edit wipes whatever is half-typed,
    // snaps <details> shut and drops the caret — every few seconds. Preserving focus (as a
    // previous pass did) wasn't enough, because each input re-renders its value from
    // storage, so the in-progress text goes with it. The settings view shows no live data,
    // so a poll has nothing to contribute: skip it entirely and let the member's own
    // interactions drive the rebuild.
    if (state.settingsOpen && opts.background) return;
    // Fully hidden: leave only the floating "TO" launcher (tap it to bring the
    // panel back). Cheap early-out so the 1s render tick does no work while hidden.
    const launcher = document.getElementById("tocw-launcher");
    if (state.hidden) {
      box.style.display = "none";
      if (launcher) launcher.style.display = "";
      return;
    }
    box.style.display = "";
    if (launcher) launcher.style.display = "none";
    box.classList.toggle("collapsed", state.collapsed);
    // Collapsed uses the compact auto size; otherwise honor a saved resize.
    if (state.collapsed) {
      box.style.width = "";
      box.style.height = "";
      box.style.maxHeight = "";
    } else {
      applyPanelSize(box);
    }

    // Preserve the body's scroll position across the full innerHTML rebuild — otherwise
    // every poll (and any re-render) snaps the user back to the top mid-read. But when
    // the VIEW changes (main ↔ focus ↔ settings) start that view at the top instead.
    const viewKind = state.settingsOpen ? "settings" : state.focus ? "focus" : "main";
    const prevBody = box.querySelector(".tocw-body");
    const savedScroll = prevBody && viewKind === lastRenderView ? prevBody.scrollTop : 0;
    lastRenderView = viewKind;

    // Preserve focus and caret across the rebuild too. Without this a background poll
    // yanks the cursor out of whatever field is being typed in — which the inline schedule
    // form made unmissable, but which applied to every Settings input already.
    const activeEl = document.activeElement;
    const focusId = activeEl && activeEl.id && box.contains(activeEl) ? activeEl.id : null;
    let selStart = null;
    let selEnd = null;
    if (focusId) {
      // Reading selectionStart throws on some input types (number/range) — not fatal.
      try { selStart = activeEl.selectionStart; selEnd = activeEl.selectionEnd; } catch { /* no caret */ }
    }

    const cfg = settings();
    const event = state.watch?.event || state.signup?.event || null;
    const mode = panelMode();
    const chain = state.chain;
    const live = Boolean(chain?.active);
    const { stale } = chainStaleness();
    const warmup = chainWarmup();

    // Age the notice out. Stamping it here (rather than at each of the ~25 assignment
    // sites) means any code path that sets a notice gets the expiry for free.
    if (state.notice !== shownNotice) {
      shownNotice = state.notice;
      shownNoticeAt = Date.now();
    }
    if (state.notice && Date.now() - shownNoticeAt > NOTICE_TTL_MS) {
      state.notice = null;
      shownNotice = null;
    }
    const currentHits = chain?.current || 0;
    const remaining = chainRemaining();
    const bonus = nextBonus(currentHits);
    const previousBonus = BONUS_MILESTONES.filter((n) => n <= currentHits).pop() || 0;
    const bonusPct = bonus
      ? Math.max(0, Math.min(100, Math.round(((currentHits - previousBonus) / (bonus.target - previousBonus)) * 100)))
      : 0;
    const scheduledSeconds = event ? countdownTo(event.starts_at) : null;
    const { current, next } = currentAndNextShift();

    const vstat = scriptVersionState();
    state.scriptTooOld = vstat.tooOld;
    const versionAlert = vstat.tooOld
      ? `<div class="tocw-alert bad">Chain Watch v${VERSION} is out of date${vstat.latest ? ` (this faction needs v${escapeHtml(vstat.latest)}+)` : ""}. <a href="${UPDATE_URL}" target="_blank" rel="noreferrer noopener">Update the script</a> — actions are disabled until you do.</div>`
      : vstat.updateAvailable
        ? `<div class="tocw-alert">Chain Watch v${escapeHtml(vstat.latest)} is available (you have v${VERSION}). <a href="${UPDATE_URL}" target="_blank" rel="noreferrer noopener">Update</a>.</div>`
        : "";

    box.innerHTML = `
      <div class="tocw-head" id="tocw-drag-handle" title="Drag to move Chain Watch">
        <div class="tocw-pills">
          <span class="tocw-pill ${warmup ? "warn" : live && !stale ? "ok" : "warn"}" ${warmup ? `title="Chain warm-up — ${CHAIN_WARMUP_HITS} hits are needed inside the timer before this counts as a chain"` : ""}>${warmup ? "WARM-UP" : live ? "LIVE" : "SCHEDULED"}</span>
          ${stale
            ? `<span class="tocw-pill bad" title="The chain snapshot hasn't been confirmed recently — these numbers may not match Torn">STALE</span>`
            : needsKey()
              ? `<span class="tocw-pill warn" title="No Torn API key set — the chain HUD, names and signups all need one">NO KEY</span>`
              : state.liveSource === "torn"
                ? `<span class="tocw-pill ok" title="${escapeHtml(timerSourceLabel())}">TORN LIVE</span>`
                : state.liveSource === "cache"
                  ? `<span class="tocw-pill warn" title="Your own Torn read failed, so this is the Overseer cache — it lags and can't resolve names. A fallback, not a mode.">CACHED</span>`
                  : `<span class="tocw-pill" title="Waiting on the first successful read">SITE SYNC</span>`}
          <span class="tocw-pill">READ-ONLY</span>
        </div>
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;">
          <div style="min-width:0;">
            <div class="tocw-title">Chain Watch</div>
            <div class="tocw-muted tocw-subtitle">v${VERSION} - ${event ? escapeHtml(event.title) : "No chain scheduled"}</div>
            <div class="tocw-cstatus">${live
              ? `<span class="tocw-cstatus-timer ${timerUrgencyClass(remaining)}" id="tocw-ctimer">${duration(remaining)}</span> <span class="tocw-muted">· ${chain.current} hit${chain.current === 1 ? "" : "s"}${stale ? " · stale" : ""}</span>`
              : event
                ? `<span class="tocw-muted">Starts in ${duration(scheduledSeconds)}</span>`
                : `<span class="tocw-muted">No chain scheduled</span>`}</div>
          </div>
          <div style="display:flex;gap:6px;align-items:flex-start;flex-shrink:0;">
            <button id="tocw-focus" class="small ${state.focus ? "on" : ""}" title="${state.focus ? "Exit focus (full panel)" : "Focus mode — giant timer only"}" aria-label="Toggle focus mode">⛶</button>
            <button id="tocw-alarm" class="small ${state.alarm ? "on" : ""}" title="${state.alarm ? "Watcher alarms ON — click to mute" : "Turn on watcher alarms (drop timer + your shift)"}" aria-label="Toggle alarms">${state.alarm ? "🔔" : "🔕"}</button>
            <button id="tocw-collapse" class="small" title="${state.collapsed ? "Expand the panel" : "Minimize to the header"}">${state.collapsed ? "Open" : "Min"}</button>
            <button id="tocw-hide" class="small" title="Hide — reopen with the TO button" aria-label="Hide panel">✕</button>
          </div>
        </div>
      </div>
      <div class="tocw-body">
        ${state.error ? `<div class="tocw-alert bad">${escapeHtml(state.error)}</div>` : ""}
        ${state.notice ? `<div class="tocw-alert">${escapeHtml(state.notice)}</div>` : ""}
        ${state.settingsOpen ? renderSettingsBody() : state.focus ? renderFocus(chain, remaining, live, event, scheduledSeconds) : `
        ${versionAlert}
        ${needsKey()
          ? renderKeyGate()
          : mode === "token"
            ? (state.signup?.needs_verification
                ? `<div class="tocw-alert">Verifying you against Torn — if this persists, your key may not have faction access.</div>`
                : `<div class="tocw-alert">Viewing via link${event ? ` — ${escapeHtml(event.title)}` : ""} — verified with your key.</div>`)
            : !cfg.sessionToken
              ? (connectError
                  ? `<div class="tocw-alert bad">Your key was rejected by the Overseer site: ${escapeHtml(connectError)}
                      <button id="tocw-connect-retry" class="small" style="margin-top:6px;">Try again</button></div>`
                  : `<div class="tocw-alert">Verifying your key with the Overseer site…</div>`)
              : ""}
        ${renderStaleLink()}
        ${renderChainStale()}
        ${renderAccessHint()}
        ${renderChainSummary()}
        ${renderWatchBanner()}
        ${renderCoverage()}
        ${renderScheduleForm()}
        ${renderSlotActionForm()}
        ${live ? renderLive(chain, remaining, bonus, bonusPct, current, next) : renderScheduled(event, scheduledSeconds)}
        ${renderShifts()}
        ${renderAbsence()}
        <div class="tocw-actions">
          <button id="tocw-refresh" class="primary" ${state.loading ? "disabled" : ""}>${state.loading ? "Loading" : "Refresh"}</button>
          <button id="tocw-copy">Copy</button>
          <button id="tocw-settings">Settings</button>
        </div>
        <div class="tocw-muted" style="text-align:center;">No auto attacks</div>
        `}
      </div>
      <div id="tocw-resize" title="Drag to resize"></div>
    `;

    // Restore the pre-rebuild scroll position (content height is stable poll-to-poll).
    if (savedScroll > 0) {
      const newBody = box.querySelector(".tocw-body");
      if (newBody) newBody.scrollTop = savedScroll;
    }
    if (focusId) {
      const again = document.getElementById(focusId);
      if (again) {
        again.focus();
        if (selStart != null) {
          try { again.setSelectionRange(selStart, selEnd); } catch { /* no caret to restore */ }
        }
      }
    }

    document.getElementById("tocw-focus")?.addEventListener("click", () => {
      state.focus = !state.focus;
      gmSet(STORE.focus, state.focus);
      render();
    });
    document.getElementById("tocw-alarm")?.addEventListener("click", () => {
      state.alarm = !state.alarm;
      gmSet(STORE.alarm, state.alarm);
      if (state.alarm) {
        primeAudio(); // this click is the user gesture that unlocks audio
        if (state.alarmSound) beep(1);
        state.notice = "Watcher alarms on — you'll be alerted near the drop and at your shift.";
      } else {
        state.notice = "Watcher alarms muted.";
      }
      render();
    });
    document.getElementById("tocw-collapse")?.addEventListener("click", () => {
      state.collapsed = !state.collapsed;
      gmSet(STORE.collapsed, state.collapsed);
      render();
    });
    document.getElementById("tocw-hide")?.addEventListener("click", () => {
      state.hidden = true;
      gmSet(STORE.hidden, true);
      render();
    });
    document.getElementById("tocw-refresh")?.addEventListener("click", () => void refreshAll(true));
    document.getElementById("tocw-force-refresh")?.addEventListener("click", () => {
      state.tornFailCount = 0; // a manual retry clears the backoff
      void refreshAll(true);
    });
    document.getElementById("tocw-link-clear")?.addEventListener("click", () => clearSignupLink());
    document.getElementById("tocw-slot-cancel")?.addEventListener("click", () => closeSlotAction());
    document.getElementById("tocw-slot-confirm")?.addEventListener("click", () => void submitSlotAction());
    document.getElementById("tocw-slot-search")?.addEventListener("input", (e) => {
      // Re-render to refilter, keeping the caret (render() restores focus + selection).
      if (state.slotAction) state.slotAction.query = String(e.target.value);
      render();
    });
    for (const pick of box.querySelectorAll("[data-tocw-pick]")) {
      pick.addEventListener("click", () => void submitSlotAction(pick.getAttribute("data-tocw-pick")));
    }
    document.getElementById("tocw-sched-save")?.addEventListener("click", () => void submitScheduleForm());
    document.getElementById("tocw-sched-cancel")?.addEventListener("click", () => {
      captureScheduleForm(); // keep the draft text in case they reopen it
      state.scheduleOpen = false;
      state.scheduleForm.error = null;
      render();
    });
    // Mirror typing into state on the way out of each field, so the next poll's re-render
    // restores it rather than blanking the form mid-entry.
    for (const id of ["tocw-sched-title", "tocw-sched-start", "tocw-sched-hours"]) {
      document.getElementById(id)?.addEventListener("input", captureScheduleForm);
    }
    document.getElementById("tocw-copy")?.addEventListener("click", () => void copySummary());
    document.getElementById("tocw-summary-dismiss")?.addEventListener("click", () => {
      state.chainSummary = null;
      render();
    });
    document.getElementById("tocw-settings")?.addEventListener("click", () => {
      state.settingsOpen = true;
      render();
    });
    document.getElementById("tocw-connect-retry")?.addEventListener("click", () => {
      retryConnectNow();
      void refreshAll(true);
    });
    document.getElementById("tocw-key-setup")?.addEventListener("click", () => {
      // Open Settings with Connection & setup already expanded and the key field focused —
      // otherwise "Open Settings" drops you at the top of a long form with the one field
      // you need collapsed out of sight at the bottom.
      state.settingsOpen = true;
      state.settingsExpandConnection = true;
      render();
      const key = document.getElementById("tocw-set-torn-key");
      if (key) {
        key.focus();
        key.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    });
    document.getElementById("tocw-hit-setup")?.addEventListener("click", () => {
      state.settingsOpen = true;
      render();
    });
    document.getElementById("tocw-hit-next")?.addEventListener("click", () => hitNextTarget());
    document.getElementById("tocw-absence-out")?.addEventListener("click", () => void reportOut());
    document.getElementById("tocw-absence-in")?.addEventListener("click", () => void reportIn());
    for (const btn of box.querySelectorAll("[data-tocw-action]")) {
      btn.addEventListener("click", () => void handleAction(btn));
    }
    bindDrag(box);
    bindResize(box);
    if (state.settingsOpen) wireSettings();
  }

  function renderScheduled(event, seconds) {
    const canManage = Boolean(state.watch?.viewer?.can_manage);
    return `
      <div class="tocw-card">
        <div class="tocw-card-title">${event ? "Next scheduled chain" : "No scheduled chain"}</div>
        <div class="tocw-big" id="tocw-timer">${event ? `Starts in ${duration(seconds)}` : "--"}</div>
        <div class="tocw-muted">${event ? `${escapeHtml(event.title)} - ${tctTime(event.starts_at, true)}` : "Ask a chain-watch manager to schedule one."}</div>
        ${event && event.status === "draft" && canManage
          ? `<div class="tocw-muted" style="margin-top:6px;">Draft — <a href="https://${OVERSEER_HOST}/faction/chains" target="_blank" rel="noreferrer noopener">publish it &amp; mint the signup link on the site ↗</a></div>`
          : ""}
        ${canManage ? `<button class="small" data-tocw-action="schedule" style="margin-top:8px;">Schedule chain (draft)</button>` : ""}
      </div>
    `;
  }

  // Personal watcher banner: "you're on watch now — ends in X" or "your shift starts
  // in X". Shown above the chain HUD in every mode so a watcher always knows their
  // status at a glance. The countdown element is updated in place each second by tick().
  function renderWatchBanner() {
    const { active, next } = viewerShiftStatus();
    if (active) {
      const ends = Math.max(0, Math.floor((new Date(active.end).getTime() - Date.now()) / 1000));
      return `<div class="tocw-watch-banner on">
        <span>🟢 You're on watch now${active.role === "backup" ? " (backup)" : ""}</span>
        <span>ends in <span class="tocw-shift-time" id="tocw-shift-timer">${duration(ends)}</span></span>
      </div>`;
    }
    if (next) {
      return `<div class="tocw-watch-banner soon">
        <span>⏰ Your ${next.role === "backup" ? "backup " : ""}shift</span>
        <span>starts in <span class="tocw-shift-time" id="tocw-shift-timer">${duration(countdownTo(next.start))}</span></span>
      </div>`;
    }
    return "";
  }

  // ---- Whole-chain "I'm out" opt-out (mode-aware) -----------------------------
  // A verified member can flag they can't make THIS chain, with an optional reason.
  // Session mode writes chain-watch report_absence; token mode writes the same absence
  // through the public signup endpoint (session-verified). Leadership sees it WITH the
  // reason on the Faction -> Chains tab; here we surface only who's out (names).
  function myAbsenceInfo() {
    if (panelMode() === "token") {
      const my = state.signup?.my_absence;
      return { out: Boolean(my), reason: my?.reason ?? null };
    }
    const vid = viewerId();
    const rows = Array.isArray(state.watch?.absences) ? state.watch.absences : [];
    const mine = vid != null ? rows.find((a) => Number(a.player_id) === vid && !a.cleared_at) : null;
    return { out: Boolean(mine), reason: mine?.reason ?? null };
  }

  // Who's out, as {id, name} — the id is what lets the name be resolved and linked. It was
  // being dropped here, which is why this list alone kept showing raw "ID 12345" even once
  // the rest of the panel had names.
  // Keyed off WHICH PAYLOAD is loaded rather than off panelMode, matching normalizedShifts
  // and coverageGaps. Mode and payload can briefly disagree (refreshAll nulls the inactive
  // one), and the payload is the thing actually being rendered.
  function absentMembers() {
    if (Array.isArray(state.signup?.absent)) {
      return state.signup.absent.map((a) => ({
        id: num(a?.id ?? a?.player_id),
        name: a?.name ?? a?.player_name ?? null,
      }));
    }
    const rows = Array.isArray(state.watch?.absences) ? state.watch.absences : [];
    return rows.filter((a) => !a.cleared_at).map((a) => ({
      id: num(a?.player_id),
      name: a?.player_name ?? null,
    }));
  }

  function renderAbsence() {
    const mode = panelMode();
    if (mode === "none") return "";
    if (mode === "token" && state.signup?.needs_verification) return "";
    const event = state.watch?.event || state.signup?.event || null;
    if (!event) return "";
    const readOnly = mode === "token" ? Boolean(event.read_only) : watchEventReadOnly(event);
    if (readOnly) return "";
    const { out, reason } = myAbsenceInfo();
    const others = absentMembers();
    const othersLine = others.length
      ? `<div class="tocw-muted" style="margin-top:6px;">Out this chain (${others.length}): ${
          others.map((a) => profileLink(a.id, rosterName(a.id, a.name || `ID ${a.id ?? "?"}`))).join(", ")
        }</div>`
      : "";
    const control = out
      ? `<div class="tocw-watch-banner soon"><span>🚫 You're out for this chain${reason ? ` — "${escapeHtml(reason)}"` : ""}</span><button class="small" id="tocw-absence-in">I'm back in</button></div>`
      : `<div style="margin-top:8px;"><button class="small" id="tocw-absence-out">I can't make this chain</button></div>`;
    return `${control}${othersLine}`;
  }

  async function reportOut() {
    const raw = prompt("Can't make this chain? Add a reason for leadership (optional):");
    if (raw === null) return; // cancelled
    try {
      const reason = raw.trim();
      if (panelMode() === "token") {
        const session = await ensureVerifiedSession();
        state.signup = await callSignup("report_absence", { reason }, session);
      } else {
        state.watch = await callFunction("chain-watch", { action: "report_absence", reason });
      }
      state.error = null;
      state.notice = "You're marked out for this chain — leadership can see it.";
      render();
    } catch (e) {
      state.error = e.message || "Couldn't update your status.";
      render();
    }
  }

  async function reportIn() {
    try {
      if (panelMode() === "token") {
        const session = await ensureVerifiedSession();
        state.signup = await callSignup("clear_absence", {}, session);
      } else {
        state.watch = await callFunction("chain-watch", { action: "clear_absence" });
      }
      state.error = null;
      state.notice = "You're back in for this chain.";
      render();
    } catch (e) {
      state.error = e.message || "Couldn't update your status.";
      render();
    }
  }

  // Upcoming shifts (current + future) with NO main watcher assigned — the gaps that
  // silently drop a chain. Works across the session and token payload shapes.
  function coverageGaps() {
    const now = Date.now();
    const out = [];
    if (Array.isArray(state.watch?.shifts)) {
      for (const s of state.watch.shifts) {
        if (new Date(s.shift_end).getTime() > now && s.watcher_id == null) out.push(s.shift_start);
      }
    } else if (Array.isArray(state.signup?.shifts)) {
      for (const s of state.signup.shifts) {
        if (new Date(s.shift_end).getTime() > now && !s.main?.filled) out.push(s.shift_start);
      }
    }
    return out;
  }

  function renderCoverage() {
    const gaps = coverageGaps();
    if (!gaps.length) return "";
    const shown = gaps.slice(0, 4).map((iso) => tctTime(iso).replace(" TCT", "")).join(", ");
    const more = gaps.length > 4 ? ` +${gaps.length - 4}` : "";
    return `<div class="tocw-alert bad">⚠️ ${gaps.length} unmanned shift${gaps.length > 1 ? "s" : ""} ahead — ${shown}${more} TCT. Fill the gaps or the chain can drop.</div>`;
  }

  // Post-chain recap, shown once a chain ends (until dismissed or the next one starts).
  function renderChainSummary() {
    const s = state.chainSummary;
    if (!s || state.chain?.active) return "";
    return `
      <div class="tocw-card" style="border-color:#2f7d55;">
        <div class="tocw-card-title">🎉 Chain ended</div>
        <div><strong>${s.totalHits.toLocaleString()}</strong> hits${s.yourHits ? ` · You: <strong>${s.yourHits.toLocaleString()}</strong> hits, ${Math.round(s.yourRespect).toLocaleString()} respect` : ""}</div>
        <button class="small" id="tocw-summary-dismiss" style="margin-top:8px;">Dismiss</button>
      </div>
    `;
  }

  // Recent hit pace (your rate, the faction's total rate, and the per-hitter average),
  // computed from the direct-Torn attack sample. Reworded per feedback: it never implies
  // an individual "bonus ETA" — the bonus is a faction milestone, shown separately.
  function renderHitPace(attacks) {
    const p = attacks?.pace;
    if (!p) return "";
    const fmt = (n) => (n == null ? "—" : n.toFixed(1));
    const you = p.you != null ? `You <strong>${fmt(p.you)}</strong>/min` : "";
    return `
      <div class="tocw-card">
        <div class="tocw-card-title">Hit pace <span class="tocw-muted">(recent)</span></div>
        ${you ? `<div style="font-size:15px;">${you}</div>` : ""}
        <div class="tocw-muted">Faction ${fmt(p.faction)}/min total · avg ${fmt(p.avg)}/min across ${p.hitters} hitter${p.hitters === 1 ? "" : "s"}</div>
      </div>
    `;
  }

  // A pasted signup link pins the panel to ONE event forever — panelMode() stays "token"
  // for as long as the token is stored, so a link minted for last week's chain keeps
  // showing that sheet while the faction runs a new one. That's why "clear the link in
  // Settings" became the standing workaround; surface it in the panel instead, one click,
  // where the member actually notices the mismatch.
  function signupLinkExpired() {
    if (panelMode() !== "token") return false;
    const event = state.signup?.event;
    if (!event) return false;
    // "frozen" is the finalized-archive phase renderSignupShifts already keys off; read_only
    // is the flag renderAbsence uses. Either means this sheet can no longer be the live one.
    if (event.read_only || event.phase === "frozen") return true;
    const shifts = Array.isArray(state.signup?.shifts) ? state.signup.shifts : [];
    if (!shifts.length) return false;
    const lastEnd = shifts.reduce((max, s) => Math.max(max, new Date(s.shift_end).getTime() || 0), 0);
    // An hour's grace so a chain running past its last scheduled slot isn't declared over.
    return lastEnd > 0 && Date.now() - lastEnd > 3600000;
  }

  function renderStaleLink() {
    if (!signupLinkExpired()) return "";
    const title = state.signup?.event?.title;
    return `<div class="tocw-alert bad">This signup link is for a finished chain${title ? ` (${escapeHtml(title)})` : ""}, so the shifts below are last chain's — not your faction's current one.
      <button id="tocw-link-clear" class="small" style="margin-top:6px;">Switch to my faction's current chain</button></div>`;
  }

  // Drop the pinned signup link and fall back to session mode (the faction's live event).
  function clearSignupLink(notice) {
    gmSet(STORE.signupToken, "");
    state.signup = null;
    state.notice = notice || "Signup link cleared — showing your faction's current chain.";
    void refreshAll(true);
  }

  // The panel's honesty valve: when the chain snapshot hasn't been confirmed recently,
  // say so plainly instead of letting a frozen hit count sit under a LIVE badge. This is
  // the state members were hitting and describing as "the panel desynced from the chain".
  function renderChainStale() {
    const { ageMs, stale } = chainStaleness();
    if (!stale) return "";
    const secs = Math.round(ageMs / 1000);
    const how = secs >= 120 ? `${Math.round(secs / 60)}m` : `${secs}s`;
    // Name only what's actually suspect. Desktop keeps a true drop timer off Torn's chain
    // bar; mobile/PDA keeps a true hit count off the same bar (it has no countdown). Telling
    // a watcher their timer is unreliable when it isn't is its own kind of desync.
    const timerOk = sidebarTimerLive();
    const hitsOk = sidebarHitsLive();
    const what = timerOk && hitsOk
      ? "some details below may lag (hits and drop timer are being read from Torn's own chain bar)"
      : timerOk
        ? "the hit count below may not match Torn (the drop timer is being read from Torn's own chain bar)"
        : hitsOk
          ? "the drop timer below may not match Torn (the hit count is being read from Torn's own chain bar)"
          : "the hits and drop timer below may not match Torn";
    const why = state.rateLimited
      ? "Torn is rate-limiting your account (error 5). The 100 requests/minute limit is per account, not per key, so it's shared with every other Torn script you run — a second key won't help. Close spare torn.com windows or pause another script; the panel is backing off and will recover on its own."
      : state.chainStaleError?.message
        ? escapeHtml(state.chainStaleError.message)
        : "The live chain read isn't coming back.";
    return `<div class="tocw-alert bad">Chain data is <strong>${how} old</strong> — ${what}. ${why}
      <button id="tocw-force-refresh" class="small" style="margin-top:6px;">Retry now</button></div>`;
  }

  // Every path into this panel needs a Torn key, and has done since verify-to-view landed
  // server-side: chain-signup answers a keyless caller with only { needs_verification: true }
  // — no sheet, no roster, no live data — and a site session can only be minted FROM a key.
  // The panel used to imply otherwise ("…or paste a chain-watch signup link there") and to
  // badge itself CACHED / SITE SYNC as though a keyless mode worked. Those backend blocks
  // are real, but they are a FALLBACK for when your own Torn call fails, not a way in.
  function needsKey() {
    return !settings().tornKey;
  }

  function renderKeyGate() {
    if (!needsKey()) return "";
    const hasLink = Boolean(settings().signupToken);
    return `
      <div class="tocw-card" style="border-color:#67420c;">
        <div class="tocw-card-title">⚙️ Add your Torn API key to start</div>
        <div class="tocw-muted">
          Chain Watch reads the live chain, hit count, watcher names and online status straight
          from Torn with your own key — that's what makes the drop timer match the game. The key
          also proves you're in the faction, which the chain sheet requires before it will show
          any shifts at all${hasLink ? " (your signup link is saved and opens as soon as the key is in)" : ""}.
        </div>
        <div class="tocw-muted" style="margin-top:6px;">
          A <strong>Limited-access</strong> key with faction access is enough. It's stored only in
          your userscript manager — the Overseer backend never keeps a copy.
        </div>
        <button id="tocw-key-setup" class="small" style="margin-top:8px;">Open Settings</button>
      </div>
    `;
  }

  // A key that EXISTS but can't read the faction is the realistic failure now that a key is
  // required — it's the difference between "you're not set up" and "you're set up wrong".
  function renderAccessHint() {
    if (!needsKey() && state.tornFailCount >= 3 && state.liveSource !== "torn") {
      return `<div class="tocw-alert">Your Torn key isn't returning live chain data — it likely needs <strong>faction API access</strong>. Ask leadership to enable it; until then the panel falls back to the Overseer cache, which lags and can't resolve names.</div>`;
    }
    return "";
  }

  // The HIT button cycles YOUR target list (player ids you set in Settings): each click
  // opens the next target's attack page and advances the loop. Turns big + red near the
  // drop. Falls back to a legacy target URL, or a "set your list" prompt when nothing's set.
  function renderHitButton(remaining) {
    const urgent = Boolean(state.chain?.active) && remaining > 0 && remaining <= 60;
    const ids = state.targetIds;
    if (ids.length > 0) {
      const idx = state.targetIndex % ids.length;
      const id = ids[idx];
      const pos = ids.length > 1 ? ` · ${idx + 1}/${ids.length}` : "";
      return `<button id="tocw-hit-next" type="button" class="tocw-hit${urgent ? " urgent" : ""}">${urgent ? "⚔️ HIT NOW" : "⚔️ Hit next"}<span class="tocw-hit-sub">→ target ${id}${pos}</span></button>`;
    }
    const url = effHitUrl();
    if (url) {
      return `<a id="tocw-hit" class="tocw-hit${urgent ? " urgent" : ""}" href="${escapeHtml(url)}" target="_self" rel="noreferrer noopener">${urgent ? "⚔️ HIT NOW" : "⚔️ Go hit"}</a>`;
    }
    return `<button id="tocw-hit-setup" type="button" class="tocw-hit tocw-hit--setup">⚙️ Set your target list</button>`;
  }

  // Open the current target's attack page and advance the loop (persisted, so the next
  // click — even after the page reloads on the attack screen — goes to the next one).
  function hitNextTarget() {
    const ids = state.targetIds;
    if (!ids.length) return;
    const idx = state.targetIndex % ids.length;
    const id = ids[idx];
    state.targetIndex = (idx + 1) % ids.length;
    gmSet(STORE.targetIndex, state.targetIndex);
    window.location.href = `https://www.torn.com/loader.php?sid=attack&user2ID=${id}`;
  }

  // Compact "on watch" view: a giant drop timer, hits, your pace, the HIT button, and
  // the handoff/your-shift banners — nothing else. For glance-and-hit during a shift.
  function renderFocus(chain, remaining, live, event, scheduledSeconds) {
    const cur = chain?.current || 0;
    const you = state.attacks?.pace?.you;
    const timerText = live ? duration(remaining) : (event ? `Starts in ${duration(scheduledSeconds)}` : "--");
    const label = live
      ? (chainWarmup() ? `Warm-up — ${CHAIN_WARMUP_HITS - cur} more to start` : "Drop timer")
      : (event ? "Next chain" : "No chain scheduled");
    return `
      ${renderWatchBanner()}
      ${renderHandoff()}
      <div class="tocw-focus">
        <div class="tocw-muted">${label}</div>
        <div class="tocw-focus-timer ${live ? timerUrgencyClass(remaining) : ""}" id="tocw-timer">${timerText}</div>
        ${live ? `<div class="tocw-focus-sub">Hits <strong>${cur}</strong>${you != null ? ` · You <strong>${you.toFixed(1)}</strong>/min` : ""}</div>` : ""}
      </div>
      ${renderHitButton(remaining)}
      <div class="tocw-actions" style="grid-template-columns:1fr 1fr;">
        <button id="tocw-refresh" class="primary" ${state.loading ? "disabled" : ""}>${state.loading ? "…" : "Refresh"}</button>
        <button id="tocw-settings">Settings</button>
      </div>
    `;
  }

  // Optional personal chain goal: progress + an ETA off the faction's recent pace. This
  // is a FACTION-total ETA (the whole chain reaching N), never a personal-bonus claim.
  function renderGoal(chain, attacks) {
    const goal = effGoal();
    if (!goal || !chain?.active) return "";
    const cur = chain.current || 0;
    const toGo = goal - cur;
    const eta = etaText(toGo, attacks?.pace?.faction);
    const pct = Math.max(0, Math.min(100, Math.round((cur / goal) * 100)));
    return `
      <div class="tocw-card">
        <div class="tocw-card-title">Goal ${goal.toLocaleString()}</div>
        <div>${cur.toLocaleString()} / ${goal.toLocaleString()}${toGo > 0 ? ` · ${toGo.toLocaleString()} to go${eta ? ` (${eta})` : ""}` : " ✅ reached"}</div>
        <div class="tocw-progress"><span style="width:${pct}%"></span></div>
      </div>
    `;
  }

  // Handoff readiness alert for the shift that's ending soon (see handoffStatus).
  function renderHandoff() {
    const h = handoffStatus();
    if (!h) return "";
    if (h.state === "gap") {
      return `<div class="tocw-alert bad">🚨 Handoff gap — no watcher after this shift (ends in ${duration(h.endsIn)}). Get it covered.</div>`;
    }
    if (h.state === "risk") {
      return `<div class="tocw-alert bad">🚨 Next watcher ${profileLink(h.id, h.name || "")} is ${escapeHtml(h.online || "not online")} — ping them (handoff in ${duration(h.endsIn)}).</div>`;
    }
    if (h.state === "unknown") {
      return `<div class="tocw-alert">⏱️ Handoff in ${duration(h.endsIn)} — ${profileLink(h.id, h.name || "the next watcher")} is up. Their online status is out of date, so check before you hand off.</div>`;
    }
    return `<div class="tocw-watch-banner on">✅ Handoff ready — ${profileLink(h.id, h.name || "")} is online (in ${duration(h.endsIn)})</div>`;
  }

  function renderLive(chain, remaining, bonus, bonusPct, current, next) {
    const attacks = state.attacks || { leaderboard: [], last: null, error: null };
    const currentOffline = current?.watcher_id && current.watcher_online_status !== "Online";
    const facPace = attacks?.pace?.faction;
    const bonusEta = bonus ? etaText(bonus.toGo, facPace) : "";
    const warm = chainWarmup();
    const toStart = warm ? CHAIN_WARMUP_HITS - chain.current : 0;
    return `
      <div class="tocw-card">
        <div class="tocw-grid">
          <div>
            <div class="tocw-muted">${warm ? "Warm-up ends in" : "Drop timer"}</div>
            <div class="tocw-big ${timerUrgencyClass(remaining)}" id="tocw-timer">${duration(remaining)}</div>
          </div>
          <div>
            <div class="tocw-muted">Hits</div>
            <div class="tocw-big">${chain.current}</div>
          </div>
        </div>
        ${warm ? `<div class="tocw-muted" style="margin-top:8px;">Not a chain yet — <strong>${toStart}</strong> more hit${toStart === 1 ? "" : "s"} inside the timer to start one.</div>` : ""}
        ${bonus ? `<div class="tocw-muted" style="margin-top:8px;">Next bonus: ${bonus.toGo} to ${bonus.target}${bonusEta ? ` (${bonusEta})` : ""}</div><div class="tocw-progress"><span style="width:${bonusPct}%"></span></div>` : ""}
      </div>
      ${renderHitButton(remaining)}
      ${renderGoal(chain, attacks)}
      ${renderHitPace(attacks)}
      ${renderHandoff()}
      <div class="tocw-card">
        <div class="tocw-card-title">Current watcher</div>
        ${renderWatcherLine(current, "No watcher assigned")}
        <div class="tocw-muted">${current ? `Shift ends ${tctTime(current.shift_end)}` : ""}</div>
      </div>
      <div class="tocw-card">
        <div class="tocw-card-title">Next watcher</div>
        ${renderWatcherLine(next, "No next watcher")}
        <div class="tocw-muted">${next ? `Starts ${tctTime(next.shift_start)}` : ""}</div>
      </div>
      ${currentOffline ? `<div class="tocw-alert bad">Current watcher is not online.</div>` : ""}
      <div class="tocw-card">
        <div class="tocw-card-title">Last attack</div>
        ${attacks.last ? `<div>${attacks.last.attackerId ? profileLink(attacks.last.attackerId, rosterName(attacks.last.attackerId, attacks.last.attackerName)) : escapeHtml(attacks.last.attackerName)} vs ${escapeHtml(attacks.last.defenderName)} - ${duration(Math.floor(Date.now() / 1000 - attacks.last.timestamp))} ago</div>` : `<div class="tocw-muted">${escapeHtml(attacks.error || "Attack log unavailable.")}</div>`}
      </div>
      ${renderLeaderboard(attacks)}
    `;
  }

  // Resolve a player id to a real name using the roster the payload already sends
  // (signup.roster in token mode; watch.roster for managers). This upgrades a slot
  // stored as a bare "ID <n>" client-side, so names read right even before the backend
  // re-resolution deploys. Falls back to the stored name / id when the roster can't help.
  // OUR roster first. The backend's payload roster is empty for an identity-only session
  // whenever its 25s cache is cold, which is most of the time — that's why slots that used
  // to read "Alice" started reading "ID 12345". The locally-fetched roster doesn't have
  // that problem, so it wins; the payload roster stays as a fallback for keyless viewers.
  function rosterName(id, fallback) {
    const nid = Number(id);
    if (!Number.isFinite(nid) || nid <= 0) return fallback;
    const own = state.tornRoster?.[nid]?.name;
    if (own && !/^ID \d+$/.test(own)) return own;
    const roster = state.signup?.roster || state.watch?.roster || [];
    const member = roster.find((r) => Number(r.id) === nid);
    const name = member && typeof member.name === "string" ? member.name.trim() : "";
    return name && !/^ID \d+$/.test(name) ? name : fallback;
  }

  // Online status for the dot. The payload's value is null when the backend had no roster,
  // so fall back to what our own roster fetch saw.
  function rosterStatus(id, fallback) {
    if (fallback) return fallback;
    const nid = Number(id);
    if (!Number.isFinite(nid) || nid <= 0) return fallback;
    return state.tornRoster?.[nid]?.status ?? fallback;
  }

  // A member's name as a link to their Torn profile. Falls back to plain text when we have
  // no id to link to, so it's safe to use everywhere a name is rendered.
  function profileLink(id, name) {
    const nid = Number(id);
    const label = escapeHtml(name);
    if (!Number.isFinite(nid) || nid <= 0) return label;
    return `<a class="tocw-who" href="https://www.torn.com/profiles.php?XID=${nid}" target="_blank" rel="noreferrer noopener" title="Open ${label}'s profile">${label}</a>`;
  }

  // The common "dot + linked name + status" cell.
  function memberCell(id, fallbackName, statusRaw) {
    const status = rosterStatus(id, statusRaw);
    const name = rosterName(id, fallbackName);
    // The dot carries the status as a tooltip so the word beside it can be dropped on
    // narrow screens without losing the information.
    return `<span class="tocw-dot ${statusClass(status)}" title="${escapeHtml(status || "Status unknown")}"></span>${profileLink(id, name)}`;
  }

  function renderWatcherLine(shift, fallback) {
    if (!shift?.watcher_id) return `<div class="tocw-muted">${escapeHtml(fallback)}</div>`;
    const status = rosterStatus(shift.watcher_id, shift.watcher_online_status);
    const name = rosterName(shift.watcher_id, shift.watcher_name || `ID ${shift.watcher_id}`);
    return `<div><span class="tocw-dot ${statusClass(status)}"></span><strong>${profileLink(shift.watcher_id, name)}</strong> <span class="tocw-muted">${escapeHtml(status || "Unknown")}</span></div>`;
  }

  function renderLeaderboard(attacks) {
    const rows = attacks?.leaderboard || [];
    return `
      <div class="tocw-card">
        <div class="tocw-card-title">Leaderboard</div>
        ${rows.length ? `
          <div class="tocw-scroll-x">
            <table class="tocw-table">
              <thead><tr><th>Member</th><th>Hits</th><th>Respect</th><th>Avg</th></tr></thead>
              <tbody>
                ${rows.map((r) => `<tr><td>${r.playerId ? profileLink(r.playerId, rosterName(r.playerId, r.name)) : escapeHtml(r.name)}</td><td>${r.hits}</td><td>${r.respect.toFixed(1)}</td><td>${r.avg.toFixed(2)}</td></tr>`).join("")}
              </tbody>
            </table>
          </div>
        ` : `<div class="tocw-muted">${escapeHtml(attacks?.error || "No leaderboard data yet.")}</div>`}
      </div>
    `;
  }

  // A session-mode event whose sheet can no longer change: a frozen finalized
  // archive, or an imported historical event. Both are immutable server-side
  // (migration 0091), so every mutating action would 409 — the panel renders
  // them read-only instead of dangling buttons that only produce errors.
  function watchEventReadOnly(event) {
    if (!event) return false;
    return event.status === "frozen" || event.status === "imported" || Boolean(event.frozen_at);
  }

  function renderShifts() {
    if (panelMode() === "token") return renderSignupShifts();
    const event = state.watch?.event;
    if (!event) return "";
    const shifts = state.watch?.shifts || [];
    const viewer = state.watch?.viewer || {};
    const readOnly = watchEventReadOnly(event);
    return `
      <div class="tocw-card">
        <div class="tocw-card-title">Chainwatch shifts</div>
        ${readOnly ? `<div class="tocw-muted">🔒 ${event.status === "imported" ? "Imported chain" : "Chain finalized"} — this sheet is read-only.</div>` : ""}
        ${shifts.map((shift) => renderShiftRow(shift, viewer, readOnly)).join("")}
      </div>
    `;
  }

  function renderShiftRow(shift, viewer, readOnly) {
    const now = Date.now();
    const active = new Date(shift.shift_start).getTime() <= now && new Date(shift.shift_end).getTime() > now;
    const vid = viewer.player_id != null ? Number(viewer.player_id) : null;
    const mine = vid != null && (Number(shift.watcher_id) === vid || Number(shift.backup_watcher_id) === vid);
    return `
      <div class="tocw-row${active ? " active" : ""}${mine ? " mine" : ""}">
        <div class="tocw-muted">${shiftLabel(shift)}${mine ? `<span class="tocw-you">YOU</span>` : ""}</div>
        <div class="tocw-slots">
          ${renderSlot(shift, "main", viewer, readOnly)}
          ${renderSlot(shift, "backup", viewer, readOnly)}
        </div>
      </div>
    `;
  }

  // One watcher slot (main or backup) with its own claim/leave/assign/lock actions.
  // Locked slots are read-only for members (backend enforces too); a manager sees an
  // Unlock button. Every action button carries data-role so handleAction targets the
  // right slot.
  function renderSlot(shift, role, viewer, readOnly) {
    const isBackup = role === "backup";
    const watcherId = isBackup ? shift.backup_watcher_id : shift.watcher_id;
    const watcherName = isBackup ? shift.backup_watcher_name : shift.watcher_name;
    const onlineStatus = isBackup ? shift.backup_watcher_online_status : shift.watcher_online_status;
    const locked = Boolean(isBackup ? shift.backup_locked : shift.locked);
    const assigned = watcherId != null;
    const own = assigned && Number(watcherId) === Number(viewer.player_id);
    const canManage = Boolean(viewer.can_manage);
    const roleLabel = isBackup ? "Backup" : "Main";
    const btn = (act, label) => `<button class="small" data-tocw-action="${act}" data-shift="${shift.id}" data-role="${role}">${label}</button>`;

    // A finalized/imported event is immutable: show who filled each slot, but no
    // claim/assign/lock controls (they'd 409 server-side).
    const actions = [];
    if (readOnly) {
      // no actions — read-only archive
    } else if (locked) {
      if (canManage) actions.push(btn("unlock", "Unlock"));
    } else if (assigned) {
      if (canManage) actions.push(btn("assign", "Change"));
      if (canManage || own) actions.push(btn("clear", own && !canManage ? "Leave" : "Clear"));
      if (canManage) actions.push(btn("lock", "Lock"));
    } else {
      actions.push(canManage ? btn("assign", "Assign") : btn("signup", "Sign up"));
      if (canManage) actions.push(btn("lock", "Lock"));
    }

    const who = assigned
      ? `${memberCell(watcherId, watcherName || `ID ${watcherId}`, onlineStatus)} <span class="tocw-muted tocw-slot__status">${escapeHtml(rosterStatus(watcherId, onlineStatus) || "")}</span>`
      : locked
        ? `<span class="tocw-muted">Locked</span>`
        : `<span class="tocw-muted">Open</span>`;

    return `
      <div class="tocw-slot tocw-slot--${role}">
        <span class="tocw-slot__role">${roleLabel}</span>
        <span class="tocw-slot__who">${locked ? "🔒 " : ""}${who}</span>
        <span class="tocw-slot__actions">${actions.join("")}</span>
      </div>
    `;
  }

  // --- Token mode (anon signup via link) --------------------------------------

  function renderSignupShifts() {
    const signup = state.signup;
    if (!signup || !signup.event) return "";
    // A keyless caller gets an event stub with needs_verification and NO shifts. Rendering
    // the card anyway produced an empty sheet under a "Signups are closed for this chain"
    // note — which is not what's happening. The key gate above already says what to do.
    if (signup.needs_verification) return "";
    const shifts = signup.shifts || [];
    const identity = getSignupIdentity();
    const canClaim = Boolean(signup.can_claim);
    const phase = signup.event.phase;
    // A frozen event is a finalized archive (read-only). Distinguish it from an
    // ordinary closed/draft sheet so the panel reads as "locked record", not
    // "you missed signups".
    const closedNote = canClaim
      ? ""
      : phase === "frozen"
        ? `<div class="tocw-muted">🔒 This chain is finalized — the sheet is read-only.</div>`
        : phase === "draft"
          ? `<div class="tocw-muted">This chain hasn't been published yet.</div>`
          : `<div class="tocw-muted">Signups are closed for this chain.</div>`;
    return `
      <div class="tocw-card">
        <div class="tocw-card-title">Chainwatch shifts</div>
        ${identity && identity.id != null
          ? `<div class="tocw-muted">Signed in as ${profileLink(identity.id, rosterName(identity.id, identity.name || `ID ${identity.id}`))} ✓</div>`
          : canClaim
            ? `<div class="tocw-muted">Signing up verifies you with your Torn key${settings().tornKey || settings().sessionToken ? "" : " — add it in Settings"}.</div>`
            : ""}
        ${shifts.map((shift) => {
          const now = Date.now();
          const active = new Date(shift.shift_start).getTime() <= now && new Date(shift.shift_end).getTime() > now;
          const vid = identity && identity.id != null ? Number(identity.id) : null;
          const mine = vid != null && (Number(shift.main?.watcher_id) === vid || Number(shift.backup?.watcher_id) === vid);
          return `
          <div class="tocw-row${active ? " active" : ""}${mine ? " mine" : ""}">
            <div class="tocw-muted">${shiftLabel(shift)}${mine ? `<span class="tocw-you">YOU</span>` : ""}</div>
            <div class="tocw-slots">
              ${renderSignupSlot(shift, "main", canClaim, identity)}
              ${renderSignupSlot(shift, "backup", canClaim, identity)}
            </div>
          </div>
        `;
        }).join("")}
        ${closedNote}
      </div>
    `;
  }

  function renderSignupSlot(shift, role, canClaim, identity) {
    const slot = (role === "backup" ? shift.backup : shift.main) || {};
    const roleLabel = role === "backup" ? "Backup" : "Main";
    const filled = Boolean(slot.filled);
    const locked = Boolean(slot.locked);
    const mine = filled && identity && identity.id != null && Number(slot.watcher_id) === Number(identity.id);
    const btn = (act, label) => `<button class="small" data-tocw-action="${act}" data-shift="${shift.id}" data-role="${role}">${label}</button>`;

    const actions = [];
    if (!locked && canClaim) {
      if (!filled) actions.push(btn("signup", "Sign up"));
      else if (mine) actions.push(btn("release", "Leave"));
    }

    const who = filled
      ? `${memberCell(slot.watcher_id, slot.watcher_name || `ID ${slot.watcher_id}`, slot.online_status)}${slot.verified ? "" : ` <span class="tocw-muted">(unverified)</span>`}`
      : locked
        ? `<span class="tocw-muted">Locked</span>`
        : `<span class="tocw-muted">Open</span>`;

    return `
      <div class="tocw-slot tocw-slot--${role}">
        <span class="tocw-slot__role">${roleLabel}</span>
        <span class="tocw-slot__who">${locked ? "🔒 " : ""}${who}</span>
        <span class="tocw-slot__actions">${actions.join("")}</span>
      </div>
    `;
  }

  async function handleSignupAction(btn) {
    const action = btn.getAttribute("data-tocw-action");
    const shiftId = Number(btn.getAttribute("data-shift"));
    const role = btn.getAttribute("data-role") === "backup" ? "backup" : "main";
    try {
      // Both claim and release authenticate with the key/session: the backend records
      // (and later releases) a verified member claim under the real Torn id, and
      // rejects a session whose faction doesn't match this event's faction.
      if (action === "signup") {
        const session = await ensureVerifiedSession();
        state.signup = await callSignup("claim", { shift_id: shiftId, role }, session);
        state.notice = role === "backup" ? "Backup slot claimed (verified)." : "Shift claimed (verified).";
      } else if (action === "release") {
        const session = await ensureVerifiedSession();
        state.signup = await callSignup("release", { shift_id: shiftId, role }, session);
        state.notice = "Slot released.";
      }
      render();
    } catch (e) {
      state.error = e.message || "Action failed.";
      render();
    }
  }

  async function handleAction(btn) {
    // Token mode uses the public chain-signup endpoints, not the session chain-watch.
    if (panelMode() === "token") return handleSignupAction(btn);
    const action = btn.getAttribute("data-tocw-action");
    const shiftId = Number(btn.getAttribute("data-shift"));
    const role = btn.getAttribute("data-role") === "backup" ? "backup" : "main";
    // Locked out until the script is updated — the backend advertised a higher
    // min_script_version, so mutations may be rejected or behave unexpectedly.
    if (state.scriptTooOld) {
      state.error = "Update the Chain Watch script to continue — it's too old for the current site.";
      state.notice = null;
      render();
      return;
    }
    // A finalized/imported event is immutable server-side; block the doomed call
    // from a stale button and say why (schedule is exempt — it starts a NEW event).
    if (action !== "schedule" && watchEventReadOnly(state.watch?.event)) {
      state.error = "This chain is finalized — the sheet is read-only.";
      state.notice = null;
      render();
      return;
    }
    try {
      if (action === "signup") {
        state.watch = await callFunction("chain-watch", { action: "signup", shift_id: shiftId, role });
        state.notice = role === "backup" ? "Backup slot claimed." : "Shift claimed.";
      } else if (action === "assign" || action === "clear") {
        // Both open an inline card; submitSlotAction performs the call. Assign picks from
        // the roster we already hold rather than asking for an exact name from memory.
        openSlotAction(action, shiftId, role);
        return;
      } else if (action === "lock" || action === "unlock") {
        state.watch = await callFunction("chain-watch", {
          action: action === "lock" ? "lock_slot" : "unlock_slot",
          shift_id: shiftId,
          role,
        });
        state.notice = action === "lock" ? "Slot locked." : "Slot unlocked.";
      } else if (action === "schedule") {
        // Opens the inline form; submitScheduleForm does the save (a DRAFT — publishing
        // and minting the public link stays on the site, so the script never creates a
        // half-configured live event).
        state.scheduleOpen = true;
        state.scheduleForm.error = null;
      }
      render();
    } catch (e) {
      state.error = e.message || "Action failed.";
      render();
    }
  }

  // --- Inline slot actions (assign / clear) --------------------------------------------
  // These replaced window.prompt + window.confirm. Both were rough on PDA — native dialogs
  // over a webview — but the real problem was "type the member's EXACT name", which fails
  // on a typo, on capitalisation, and on any name with punctuation, with an alert() as the
  // only feedback. We already hold the full roster (fetched with the member's own key), so
  // the right interaction is picking from it, not retyping it from memory.

  // The roster as a sorted list. Prefers the one we fetched ourselves, since the backend's
  // is manager-only and usually empty for an identity-only session.
  function rosterList() {
    const own = state.tornRoster;
    if (own && Object.keys(own).length) {
      return Object.entries(own)
        .map(([id, m]) => ({ id: Number(id), name: m?.name || `ID ${id}`, status: m?.status ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    const payload = state.signup?.roster || state.watch?.roster || [];
    return payload
      .map((m) => ({ id: Number(m?.id), name: String(m?.name ?? `ID ${m?.id}`), status: m?.online_status ?? null }))
      .filter((m) => Number.isFinite(m.id) && m.id > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Name substring OR id prefix, so both "ali" and "1234" narrow the list.
  function filterRoster(list, query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return list;
    return list.filter((m) => m.name.toLowerCase().includes(q) || String(m.id).startsWith(q));
  }

  function openSlotAction(kind, shiftId, role) {
    state.slotAction = { kind, shiftId, role, query: "", error: null, busy: false };
    render();
  }

  function closeSlotAction() {
    state.slotAction = null;
    render();
  }

  function slotActionShift() {
    const sa = state.slotAction;
    if (!sa) return null;
    return (state.watch?.shifts || []).find((s) => Number(s.id) === Number(sa.shiftId)) || null;
  }

  function slotActionLabel() {
    const sa = state.slotAction;
    const shift = slotActionShift();
    const when = shift ? `${hhmmTct(shift.shift_start)}–${hhmmTct(shift.shift_end)} TCT` : "this shift";
    return `${sa.role === "backup" ? "Backup" : "Main"} · ${when}`;
  }

  function renderSlotActionForm() {
    const sa = state.slotAction;
    if (!sa) return "";
    const shift = slotActionShift();
    const heldId = shift ? (sa.role === "backup" ? shift.backup_watcher_id : shift.watcher_id) : null;
    const heldName = shift ? (sa.role === "backup" ? shift.backup_watcher_name : shift.watcher_name) : null;
    const err = sa.error ? `<div class="tocw-alert bad" style="margin-bottom:8px;">${escapeHtml(sa.error)}</div>` : "";

    if (sa.kind === "clear") {
      // Names the person and the slot, which a bare "Clear this chainwatch slot?" never did.
      const who = heldId ? rosterName(heldId, heldName || `ID ${heldId}`) : "this slot";
      return `
        <div class="tocw-card" style="border-color:#651922;">
          <div class="tocw-card-title">Clear ${escapeHtml(slotActionLabel())}?</div>
          <div class="tocw-muted">This removes <strong>${escapeHtml(who)}</strong> from the slot. They can be reassigned afterwards.</div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;">
            <button id="tocw-slot-cancel" class="small">Cancel</button>
            <button id="tocw-slot-confirm" class="small primary" ${sa.busy ? "disabled" : ""}>${sa.busy ? "Clearing…" : "Clear slot"}</button>
          </div>
        </div>
      `;
    }

    const all = rosterList();
    const matches = filterRoster(all, sa.query);
    const shown = matches.slice(0, 30);
    const idQuery = /^\d{1,10}$/.test(sa.query.trim()) ? Number(sa.query.trim()) : null;
    return `
      <div class="tocw-card tocw-settings" style="border-color:#3a5573;">
        <div class="tocw-card-title">Assign ${escapeHtml(slotActionLabel())}</div>
        ${err}
        <label style="margin-bottom:8px;">Search the roster <span class="tocw-muted">— name or player ID</span>
          <input id="tocw-slot-search" value="${escapeHtml(sa.query)}" placeholder="Start typing a name…" autocomplete="off" />
        </label>
        ${all.length
          ? `<div class="tocw-picker">
              ${shown.map((m) => `
                <button type="button" class="tocw-pick" data-tocw-pick="${m.id}" ${sa.busy ? "disabled" : ""}>
                  <span class="tocw-dot ${statusClass(m.status)}" title="${escapeHtml(m.status || "Status unknown")}"></span>
                  <span class="tocw-pick__name">${escapeHtml(m.name)}</span>
                  <span class="tocw-muted">${m.id}</span>
                </button>`).join("")}
              ${matches.length > shown.length ? `<div class="tocw-muted" style="padding:6px 2px;">+${matches.length - shown.length} more — keep typing to narrow it.</div>` : ""}
              ${!matches.length ? `<div class="tocw-muted" style="padding:6px 2px;">No member matches that.${idQuery ? "" : " You can also type a player ID."}</div>` : ""}
            </div>`
          : `<div class="tocw-muted">No roster loaded — your key may lack faction access. You can still assign by player ID.</div>`}
        ${idQuery && !matches.some((m) => m.id === idQuery)
          ? `<button type="button" class="tocw-pick" data-tocw-pick="${idQuery}" style="margin-top:6px;">Assign player ID <strong>${idQuery}</strong></button>`
          : ""}
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;">
          <button id="tocw-slot-cancel" class="small">Cancel</button>
        </div>
      </div>
    `;
  }

  async function submitSlotAction(watcherId) {
    const sa = state.slotAction;
    if (!sa || sa.busy) return;
    sa.busy = true;
    sa.error = null;
    render();
    try {
      if (sa.kind === "clear") {
        state.watch = await callFunction("chain-watch", { action: "clear", shift_id: sa.shiftId, role: sa.role });
        state.notice = "Slot cleared.";
      } else {
        state.watch = await callFunction("chain-watch", {
          action: "assign", shift_id: sa.shiftId, watcher_id: Number(watcherId), role: sa.role,
        });
        state.notice = "Slot assigned.";
      }
      state.slotAction = null;
    } catch (e) {
      sa.busy = false;
      sa.error = e.message || "Action failed.";
    }
    render();
  }

  // Validate the schedule form's three fields, returning either the payload or the first
  // problem. Pure, so it's unit-testable and shared by the form and any caller.
  function validateSchedule(title, startRaw, durationRaw) {
    const cleanTitle = String(title || "").trim();
    if (!cleanTitle) return { error: "Give the chain a title." };
    const iso = parseTctInput(String(startRaw || ""));
    if (!iso) return { error: "Start time must look like 2026-08-14 20:00 (TCT)." };
    const hours = Number(durationRaw);
    if (!Number.isInteger(hours) || hours < 1 || hours > 24) {
      return { error: "Duration must be a whole number of hours, 1 to 24." };
    }
    return { value: { title: cleanTitle.slice(0, 80), starts_at: iso, duration_hours: hours } };
  }

  // Inline scheduling form, replacing three chained window.prompt() calls. Those were
  // rough on mobile/PDA, and cancelling at the third step silently threw away the first
  // two answers. This keeps what you typed, validates in place, and shows the error next
  // to the fields instead of in an alert().
  function renderScheduleForm() {
    if (!state.scheduleOpen) return "";
    const f = state.scheduleForm;
    return `
      <div class="tocw-card tocw-settings" style="border-color:#3a5573;">
        <div class="tocw-card-title">Schedule a chain (draft)</div>
        ${f.error ? `<div class="tocw-alert bad" style="margin-bottom:8px;">${escapeHtml(f.error)}</div>` : ""}
        <label>Title
          <input id="tocw-sched-title" value="${escapeHtml(f.title)}" placeholder="Chain Night" />
        </label>
        <label>Start (TCT / UTC)
          <input id="tocw-sched-start" value="${escapeHtml(f.start)}" placeholder="YYYY-MM-DD HH:mm" />
        </label>
        <label>Duration (hours)
          <input id="tocw-sched-hours" type="number" min="1" max="24" step="1" value="${escapeHtml(f.hours)}" />
        </label>
        <div class="tocw-muted" style="margin-bottom:8px;">Creates a draft — publish it on the Overseer site to open signups and mint the link.</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button id="tocw-sched-cancel" class="small">Cancel</button>
          <button id="tocw-sched-save" class="small primary">Create draft</button>
        </div>
      </div>
    `;
  }

  // Read the form back into state so a re-render (poll, tick) never discards typing.
  function captureScheduleForm() {
    if (!state.scheduleOpen) return;
    const t = document.getElementById("tocw-sched-title");
    const s = document.getElementById("tocw-sched-start");
    const h = document.getElementById("tocw-sched-hours");
    if (t) state.scheduleForm.title = String(t.value);
    if (s) state.scheduleForm.start = String(s.value);
    if (h) state.scheduleForm.hours = String(h.value);
  }

  async function submitScheduleForm() {
    captureScheduleForm();
    const f = state.scheduleForm;
    const res = validateSchedule(f.title, f.start, f.hours);
    if (res.error) {
      f.error = res.error;
      render();
      return;
    }
    try {
      state.watch = await callFunction("chain-watch", { action: "save_event", ...res.value, draft: true });
      state.scheduleOpen = false;
      state.scheduleForm = { title: "", start: "", hours: "6", error: null };
      state.notice = "Draft chain created — publish it on the Overseer site to open signups and mint the link.";
    } catch (e) {
      f.error = e.message || "Could not create the draft.";
    }
    render();
  }

  // Parse "YYYY-MM-DD HH:mm" (TCT/UTC unless an explicit offset is given) → ISO, or null.
  //
  // The shape MUST be checked before handing anything to Date. V8's parser is lenient to
  // the point of being dangerous here: new Date("garbage:00Z") returns 1 Jan 2000 rather
  // than an invalid date, so the previous version silently accepted any typo and scheduled
  // the chain for the year 2000. It also rolls 2026-02-31 forward into March instead of
  // rejecting it, so the fields are round-tripped below.
  function parseTctInput(value) {
    const clean = String(value || "").trim().replace(" ", "T");
    const m = clean.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:\d{2})?(Z|[+-]\d{2}:?\d{2})?$/i);
    if (!m) return null;
    const iso = `${clean}${m[6] ? "" : ":00"}${m[7] ? "" : "Z"}`;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    // With no explicit offset the input is UTC, so the UTC fields must match what was
    // typed — this is what rejects 2026-02-31 rather than quietly moving it to 3 March.
    if (!m[7]) {
      if (
        d.getUTCFullYear() !== Number(m[1]) ||
        d.getUTCMonth() + 1 !== Number(m[2]) ||
        d.getUTCDate() !== Number(m[3]) ||
        d.getUTCHours() !== Number(m[4]) ||
        d.getUTCMinutes() !== Number(m[5])
      ) return null;
    }
    return d.toISOString();
  }

  // Paste-ready status block for faction chat: state of the chain + coverage at a
  // glance so a manager can drop it in and everyone knows what's needed.
  async function copySummary() {
    const event = state.watch?.event || state.signup?.event;
    const chain = state.chain;
    const { current, next } = currentAndNextShift();
    const gaps = coverageGaps();
    const h = handoffStatus();
    const lines = ["🔗 Chain Watch"];
    if (chain?.active) lines.push(`LIVE: ${chain.current} hits · ${duration(chainRemaining())} to drop`);
    else if (event) lines.push(`Next: ${event.title} — ${tctTime(event.starts_at, true)}`);
    else lines.push("No chain scheduled");
    lines.push(current?.watcher_id
      ? `On watch: ${rosterName(current.watcher_id, current.watcher_name || `ID ${current.watcher_id}`)} (${rosterStatus(current.watcher_id, current.watcher_online_status) || "Unknown"})`
      : "On watch: nobody ⚠️");
    lines.push(next?.watcher_id
      ? `Next: ${rosterName(next.watcher_id, next.watcher_name || `ID ${next.watcher_id}`)} @ ${tctTime(next.shift_start)} (${rosterStatus(next.watcher_id, next.watcher_online_status) || "Unknown"})`
      : "Next: unassigned ⚠️");
    if (h && h.state === "risk") lines.push(`🚨 Handoff: ${h.name} isn't online`);
    if (h && h.state === "gap") lines.push("🚨 Handoff: no watcher after the current shift");
    if (gaps.length) lines.push(`⚠️ Unmanned: ${gaps.slice(0, 6).map((iso) => tctTime(iso).replace(" TCT", "")).join(", ")} TCT`);
    const text = lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      state.notice = "Status copied — paste it in faction chat.";
    } catch {
      state.notice = text;
    }
    render();
  }

  // Should "Connection & setup" render expanded? Open it when there's no key (the key
  // field is the one thing that member needs, and burying it at the bottom of a collapsed
  // section made them hunt for it), when something sent them here to set the key, or when
  // they had it open before the last rebuild.
  function connectionOpen() {
    return needsKey() || state.settingsExpandConnection || state.connectionWasOpen;
  }

  // Settings render INSIDE the panel body (not a floating modal) — so they inherit the
  // panel's z-index + drag, and work on mobile where a modal was buried behind the
  // full-width panel. Same input ids as before; wireSettings() attaches the handlers.
  function renderSettingsBody() {
    const cfg = settings();
    const idx = state.targetIds.length ? (state.targetIndex % state.targetIds.length) + 1 : 0;
    return `
      <div class="tocw-settings">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px;">
        <div style="font-weight:800;font-size:17px;">Settings</div>
        <button id="tocw-set-back" class="small">← Back</button>
      </div>

      <div style="padding:10px;border:1px solid #333;border-radius:8px;">
        <label style="margin-bottom:4px;">Your attack targets <span class="tocw-muted">— player IDs (one per line or comma-separated)</span>
          <textarea id="tocw-set-target-ids" rows="3" placeholder="123456&#10;789012&#10;…">${escapeHtml(state.targetIds.join("\n"))}</textarea>
        </label>
        <div class="tocw-muted">The ⚔️ HIT button opens each one in turn (one per click), so you hit down your list.${state.targetIds.length ? ` ${state.targetIds.length} target${state.targetIds.length === 1 ? "" : "s"} · currently at #${idx}. <button id="tocw-target-reset" class="small" type="button">Restart</button>` : ""}</div>
        ${effHitUrl() ? `
          <div class="tocw-muted" style="margin-top:8px;border-top:1px solid #2b3d52;padding-top:8px;">
            You still have an old single-target link saved from before the list existed:
            <code style="word-break:break-all;">${escapeHtml(effHitUrl())}</code>.
            It's only used when the list above is empty. Nothing writes it any more, so it was
            invisible until now.
            <button id="tocw-hit-url-clear" class="small" type="button" style="margin-top:6px;">Forget it</button>
          </div>` : ""}
      </div>

      <div style="margin-top:10px;padding:10px;border:1px solid #333;border-radius:8px;">
        <div style="font-weight:700;font-size:14px;">Watcher alarms <span class="tocw-muted" style="font-weight:400;">— ${state.alarm ? "ON" : "OFF"}</span></div>
        <div class="tocw-muted" style="margin:2px 0 8px;">
          Turn alarms on/off with the ${state.alarm ? "🔔" : "🔕"} button in the header (that's the master switch).
          These control what fires when they're on — alerts near the chain drop and before + at your own shift.
        </div>
        <label class="tocw-check"><input type="checkbox" id="tocw-set-alarm-sound" ${state.alarmSound ? "checked" : ""} /> Sound (beep)</label>
        <label class="tocw-check"><input type="checkbox" id="tocw-set-alarm-vibrate" ${state.alarmVibrate ? "checked" : ""} /> Vibrate (mobile / PDA)</label>
        <label class="tocw-check"><input type="checkbox" id="tocw-set-alarm-flash" ${state.alarmFlash ? "checked" : ""} /> Visual flash</label>
        <label class="tocw-check"><input type="checkbox" id="tocw-set-alarm-notify" ${state.alarmNotify ? "checked" : ""} /> Desktop notification</label>
        <label class="tocw-check"><input type="checkbox" id="tocw-set-alarm-voice" ${state.alarmVoice ? "checked" : ""} /> Voice countdown (speak alerts)</label>
        <div class="grid" style="margin-top:8px;">
          <label>Sound
            <select id="tocw-set-alarm-tone">
              ${ALARM_TONES.map((t) => `<option value="${t}" ${state.alarmTone === t ? "selected" : ""}>${t[0].toUpperCase()}${t.slice(1)}</option>`).join("")}
            </select>
          </label>
          <label>Volume
            <input id="tocw-set-alarm-volume" type="range" min="0" max="100" value="${Math.round(state.alarmVolume * 100)}" />
          </label>
        </div>
        <label style="margin-top:8px;">Drop alerts at (seconds to drop) <span class="tocw-muted">— blank = faction default</span>
          <input id="tocw-set-alarm-thresholds" value="${escapeHtml(state.thresholdsPref)}" placeholder="${escapeHtml((cleanThresholdArray(state.factionConfig?.drop_thresholds) || DEFAULT_DROP_THRESHOLDS).join(", "))}" />
        </label>
        <label class="tocw-check" style="margin-top:8px;"><input type="checkbox" id="tocw-set-wakelock" ${state.wakeLockEnabled ? "checked" : ""} /> Keep screen awake while on watch</label>
        <label class="tocw-check"><input type="checkbox" id="tocw-set-autofocus" ${state.autoFocus ? "checked" : ""} /> Auto-focus mode when on watch</label>
        <label class="tocw-check"><input type="checkbox" id="tocw-set-celebrate" ${state.celebrate ? "checked" : ""} /> Celebrate bonus milestones</label>
        <button id="tocw-alarm-test" class="small" style="margin-top:6px;">Test alarm</button>
      </div>
      <div style="margin-top:10px;padding:10px;border:1px solid #333;border-radius:8px;">
        ${state.factionConfig && (state.factionConfig.chain_goal || state.factionConfig.drop_thresholds)
          ? `<div class="tocw-muted" style="margin-bottom:8px;">Your faction has set watcher defaults (thresholds / goal). Leave a field blank to use them.</div>`
          : ""}
        <label>Chain goal (hits, 0 = off) <span class="tocw-muted">— blank = faction</span>
          <input id="tocw-set-goal" type="number" min="0" step="100" value="${state.chainGoalPref || ""}" placeholder="${Number(state.factionConfig?.chain_goal) > 0 ? Number(state.factionConfig.chain_goal) : "e.g. 5000"}" />
        </label>
        ${state.watch?.viewer?.can_manage ? `
          <div style="margin-top:4px;border-top:1px solid #2b3d52;padding-top:8px;">
            <div style="font-weight:700;">Faction defaults (managers)</div>
            <div class="tocw-muted" style="margin:2px 0 6px;">Push your current thresholds + goal as the faction defaults — every member's panel adopts them (each member can still override). The HIT target stays per-member.</div>
            <button id="tocw-save-faction-config" class="small">Save thresholds + goal as faction defaults</button>
          </div>` : ""}
      </div>

      <details id="tocw-conn-details" ${connectionOpen() ? "open" : ""} style="margin-top:10px;">
        <summary class="tocw-muted" style="cursor:pointer;font-weight:700;">Connection &amp; setup</summary>
        <div style="margin-top:10px;">
          <label>Torn API key ${pdaApiKey() ? "(provided by TornPDA)" : ""} <span class="tocw-muted">— connects your site session AND fetches the live chain/leaderboard for zero-lag data</span>
            <input id="tocw-set-torn-key" type="password" value="${escapeHtml(pdaApiKey() && cfg.tornKey === pdaApiKey() ? "" : cfg.tornKey)}" autocomplete="off" placeholder="${pdaApiKey() ? "Using the TornPDA key" : "Limited-access Torn API key"}" />
          </label>
          <label>Site session token
            <input id="tocw-set-session" type="password" value="${escapeHtml(cfg.sessionToken)}" autocomplete="off" />
          </label>
          <div style="margin-top:10px;padding:10px;border:1px solid #333;border-radius:8px;">
            <div style="font-weight:700;">Signup link (token mode)</div>
            <div class="tocw-muted" style="margin:4px 0 8px;">
              ${cfg.signupToken
                ? "Linked to a signup event. Paste a different link to switch events. Signing up uses your Torn key to verify your faction."
                : "Paste a chain-watch signup link (from faction chat) to view + sign up for that specific event here. Optional — session mode already shows your faction's current chain."}
            </div>
            <div class="grid" style="grid-template-columns:1fr auto;gap:8px;align-items:end;">
              <label style="margin:0;">Paste a link or token
                <input id="tocw-set-signup" value="" autocomplete="off" placeholder="https://${OVERSEER_HOST}/chain/e/…" />
              </label>
              <button id="tocw-signup-clear" ${cfg.signupToken ? "" : "disabled"}>Clear link</button>
            </div>
          </div>
          <p class="tocw-muted" style="margin:10px 0 0;">
            Data: your live chain + leaderboard come straight from api.torn.com with your key (via the userscript
            manager / Torn PDA — never exposed to torn.com's page scripts); schedule &amp; signups go to your Overseer backend.
          </p>
          <div style="margin-top:8px;">
            <button id="tocw-modal-connect">Connect site from Torn key</button>
          </div>
        </div>
      </details>

      <div class="tocw-modal-actions">
        <button id="tocw-modal-save" class="primary">Save</button>
      </div>
      </div>
    `;
  }

  // Attach the settings handlers after the settings body is in the DOM (called from
  // render() when state.settingsOpen). Same logic as the old modal, minus the overlay.
  function wireSettings() {
    // The backend URL + publishable key are fixed (the DEFAULT_* constants); there's no
    // UI to override them, so settings()/saveSettings just use the defaults.
    const collect = () => ({
      tornKey: valueOf("tocw-set-torn-key"),
      sessionToken: valueOf("tocw-set-session"),
    });
    const checked = (id) => Boolean(document.getElementById(id)?.checked);
    const applyAlarmSettings = () => {
      // NB: state.alarm (the master on/off) is owned by the header 🔔 toggle, NOT this
      // form — so saving settings never flips it, and the two can't disagree.
      state.alarmSound = checked("tocw-set-alarm-sound");
      state.alarmVibrate = checked("tocw-set-alarm-vibrate");
      state.alarmFlash = checked("tocw-set-alarm-flash");
      state.alarmNotify = checked("tocw-set-alarm-notify");
      state.wakeLockEnabled = checked("tocw-set-wakelock");
      // Personal PREFS ("" / 0 = inherit the faction default): normalize to a clean
      // stored form (parsed thresholds, valid URL or "", non-negative goal).
      const parsedT = parseThresholds(valueOf("tocw-set-alarm-thresholds"), null);
      state.thresholdsPref = parsedT ? parsedT.join(", ") : "";
      const tone = valueOf("tocw-set-alarm-tone");
      state.alarmTone = ALARM_TONES.includes(tone) ? tone : "beep";
      state.alarmVolume = clampVolume(Number(valueOf("tocw-set-alarm-volume")) / 100);
      state.chainGoalPref = Math.max(0, Math.round(Number(valueOf("tocw-set-goal")) || 0));
      // Your rotating attack list. If it changed, keep the loop position in range.
      const targetEl = document.getElementById("tocw-set-target-ids");
      const newTargets = parseTargetIds(targetEl && "value" in targetEl ? String(targetEl.value) : "");
      const targetsChanged = newTargets.join(",") !== state.targetIds.join(",");
      state.targetIds = newTargets;
      if (targetsChanged || state.targetIndex >= newTargets.length) state.targetIndex = 0;
      state.alarmVoice = checked("tocw-set-alarm-voice");
      state.autoFocus = checked("tocw-set-autofocus");
      state.celebrate = checked("tocw-set-celebrate");
      gmSet(STORE.alarmSound, state.alarmSound);
      gmSet(STORE.alarmVibrate, state.alarmVibrate);
      gmSet(STORE.alarmFlash, state.alarmFlash);
      gmSet(STORE.alarmNotify, state.alarmNotify);
      gmSet(STORE.wakeLock, state.wakeLockEnabled);
      gmSet(STORE.alarmThresholds, state.thresholdsPref);
      gmSet(STORE.alarmTone, state.alarmTone);
      gmSet(STORE.alarmVolume, state.alarmVolume);
      gmSet(STORE.chainGoal, state.chainGoalPref);
      gmSet(STORE.targetIds, state.targetIds.join(","));
      gmSet(STORE.targetIndex, state.targetIndex);
      gmSet(STORE.alarmVoice, state.alarmVoice);
      gmSet(STORE.autoFocus, state.autoFocus);
      gmSet(STORE.celebrate, state.celebrate);
      if (state.alarm) primeAudio(); // Save is a user gesture → (re)unlock audio while armed
      updateWakeLock();
    };
    const close = () => {
      state.settingsOpen = false;
      render();
    };
    const details = document.getElementById("tocw-conn-details");
    details?.addEventListener("toggle", () => {
      state.connectionWasOpen = Boolean(details.open);
      // A deliberate collapse should stick, so clear the one-shot "expand it for them".
      if (!details.open) state.settingsExpandConnection = false;
    });
    document.getElementById("tocw-set-back")?.addEventListener("click", close);
    document.getElementById("tocw-hit-url-clear")?.addEventListener("click", () => {
      state.hitUrlPref = "";
      gmSet(STORE.hitUrl, "");
      state.notice = "Old single-target link forgotten.";
      close();
    });
    document.getElementById("tocw-target-reset")?.addEventListener("click", () => {
      state.targetIndex = 0;
      gmSet(STORE.targetIndex, 0);
      state.notice = "Target list restarted.";
      close();
    });
    document.getElementById("tocw-alarm-test")?.addEventListener("click", () => {
      primeAudio();
      // Preview the CURRENT form's tone/volume without needing to save first.
      const prevTone = state.alarmTone;
      const prevVol = state.alarmVolume;
      const tone = valueOf("tocw-set-alarm-tone");
      state.alarmTone = ALARM_TONES.includes(tone) ? tone : "beep";
      state.alarmVolume = clampVolume(Number(valueOf("tocw-set-alarm-volume")) / 100);
      if (checked("tocw-set-alarm-sound")) playAlarmSound("drop");
      if (checked("tocw-set-alarm-vibrate")) {
        try { navigator.vibrate?.([130, 60, 130, 60, 220]); } catch { /* unsupported */ }
      }
      if (checked("tocw-set-alarm-flash")) flashPanel("drop");
      if (checked("tocw-set-alarm-voice")) speak("Ten seconds — hit now");
      state.alarmTone = prevTone;
      state.alarmVolume = prevVol;
    });
    document.getElementById("tocw-modal-save")?.addEventListener("click", () => {
      const prevKey = settings().tornKey;
      const prevSession = settings().sessionToken;
      const ok = saveSettings(collect());
      applyAlarmSettings();
      // Compare the key's VALUE, not just its presence: replacing a rejected key with a
      // working one is the main recovery path, and it would otherwise sit out the
      // connect throttle doing nothing.
      const nextKey = settings().tornKey;
      const keyChanged = Boolean(nextKey) && nextKey !== prevKey;
      // A different key is a different identity, so the session minted from the old one is
      // no longer valid for it — drop it and let ensureSessionFromKey mint a fresh one.
      // Unless the member deliberately pasted a session token in this same save, which is
      // an explicit override worth respecting.
      if (keyChanged && settings().sessionToken === prevSession) {
        gmSet(STORE.sessionToken, "");
        gmSet(STORE.signupIdentity, null);
      }
      if (keyChanged) retryConnectNow();
      // Last-resort manual link entry: bind a pasted signup link/token.
      const pasted = extractSignupToken(valueOf("tocw-set-signup"));
      if (pasted) gmSet(STORE.signupToken, pasted);
      if (ok) {
        state.notice = pasted ? "Signup link saved." : "Settings saved.";
      } else {
        state.error = "Install Tampermonkey or use Torn PDA — your key and session can't be stored securely otherwise, so they were not saved.";
      }
      close();
      if (keyChanged || pasted) void refreshAll(true);
    });
    document.getElementById("tocw-save-faction-config")?.addEventListener("click", async () => {
      // Managers push the CURRENT effective values as the faction-wide defaults, so
      // every member's panel adopts them. Persist personal prefs first so "effective"
      // reflects exactly what's in the form.
      applyAlarmSettings();
      try {
        // The HIT target URL is deliberately NOT pushed — it's per-member.
        const res = await callFunction("chain-watch", {
          action: "save_config",
          drop_thresholds: effThresholds(),
          chain_goal: effGoal() || null,
        });
        state.watch = res;
        state.factionConfig = res?.watch_config ?? state.factionConfig;
        state.notice = "Saved thresholds + goal as faction defaults.";
        close();
      } catch (e) {
        state.error = e.message || "Could not save faction defaults.";
        render();
      }
    });
    document.getElementById("tocw-signup-clear")?.addEventListener("click", () => {
      gmSet(STORE.signupToken, "");
      gmSet(STORE.signupIdentity, null);
      state.signup = null;
      state.notice = "Signup link cleared.";
      close();
    });
    document.getElementById("tocw-modal-connect")?.addEventListener("click", async () => {
      saveSettings(collect());
      retryConnectNow();
      try {
        const token = await connectSiteFromTornKey();
        document.getElementById("tocw-set-session").value = token;
        saveSettings({ ...collect(), sessionToken: token });
        state.notice = "Site connected.";
        close();
      } catch (e) {
        state.error = e.message || "Site connection failed.";
        render();
      }
    });
  }

  function valueOf(id) {
    const el = document.getElementById(id);
    return el && "value" in el ? String(el.value).trim() : "";
  }

  function createLauncher() {
    if (document.getElementById("tocw-launcher")) return;
    const launcher = document.createElement("button");
    launcher.id = "tocw-launcher";
    launcher.type = "button";
    launcher.textContent = "TO";
    launcher.title = "Open Torn Overseer (drag to move)";
    launcher.style.cssText = [
      "position:fixed",
      "left:58px",
      "bottom:76px",
      "z-index:2147483647",
      `width:${LAUNCHER_W}px`,
      `height:${LAUNCHER_H}px`,
      "border-radius:9px",
      "border:2px solid #ff6870",
      "background:#ff3b45",
      "color:#fff",
      "font:bold 15px Arial,sans-serif",
      "box-shadow:0 8px 22px rgba(0,0,0,.45)",
      "cursor:pointer",
      "touch-action:none",
    ].join(";");
    applyLauncherPosition(launcher);
    launcher.addEventListener("click", () => {
      // A drag ends in a click too — swallow that one so moving the button
      // doesn't also open the panel.
      if (launcher.dataset.dragged === "1") {
        launcher.dataset.dragged = "";
        return;
      }
      state.hidden = false;
      state.collapsed = false;
      gmSet(STORE.hidden, false);
      gmSet(STORE.collapsed, false);
      createShell();
      render();
      const box = document.getElementById("tocw");
      if (box) box.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    bindLauncherDrag(launcher);
    document.body.appendChild(launcher);
  }

  // Make the "TO" launcher draggable (persisted), while a plain tap still opens the
  // panel. A small movement threshold tells a drag from a tap so it never misfires.
  function bindLauncherDrag(launcher) {
    launcher.addEventListener("pointerdown", (event) => {
      if (event.button != null && event.button !== 0) return;
      const rect = launcher.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      const startX = event.clientX;
      const startY = event.clientY;
      let moved = false;
      launcher.dataset.dragged = "";
      launcher.setPointerCapture?.(event.pointerId);

      const move = (moveEvent) => {
        if (!moved && Math.abs(moveEvent.clientX - startX) < 4 && Math.abs(moveEvent.clientY - startY) < 4) return;
        moved = true;
        // Switch to top/left anchoring the moment a drag begins.
        launcher.style.right = "auto";
        launcher.style.bottom = "auto";
        const next = clampPosition(
          moveEvent.clientX - offsetX,
          moveEvent.clientY - offsetY,
          launcher.offsetWidth || LAUNCHER_W,
          launcher.offsetHeight || LAUNCHER_H,
        );
        launcher.style.left = `${next.left}px`;
        launcher.style.top = `${next.top}px`;
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        if (moved) {
          launcher.dataset.dragged = "1";
          saveLauncherPosition(launcher);
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
      window.addEventListener("pointercancel", up, { once: true });
    });
  }

  function boot() {
    if (!document.body) {
      setTimeout(boot, 100);
      return;
    }
    console.info("[Torn Overseer Chain Watch] loaded", location.href);
    migrateSecretsFromLocalStorage();
    createLauncher();
    // Persisted-on alarms: browsers block audio until a user gesture, so prime the
    // audio context on the first tap/click anywhere on the page.
    if (state.alarm) document.addEventListener("pointerdown", () => primeAudio(), { once: true });
    try {
      createShell();
      render();
    } catch (error) {
      console.error("[Torn Overseer Chain Watch] render failed", error);
    }
    // A screen wake lock is dropped whenever the tab hides; re-evaluate (re-acquire or
    // release) each time visibility changes, and resume the poll loop on return.
    document.addEventListener("visibilitychange", () => {
      updateWakeLock();
      // Drop the polling lease the moment this window is backgrounded, so the window the
      // member is actually looking at picks it up rather than waiting out the lease.
      if (document.visibilityState !== "visible") {
        releasePollLeader();
        return;
      }
      // Polling is paused while the tab is backgrounded, so coming back is exactly when
      // the snapshot is oldest. Re-read immediately rather than waiting out a poll delay
      // and showing the user a stale chain in the meantime.
      if (chainStaleness().stale) void refreshAll(false);
      else scheduleNextRefresh();
    });
    // Kick off the live-data loop (refreshAll re-arms itself via scheduleNextRefresh,
    // polling fast while a chain is live and easing off otherwise).
    setTimeout(() => void refreshAll(false), 800);
    // 1s tick updates ONLY the countdown text in place — no innerHTML rebuild, so it
    // never resets the user's scroll position or fights their interaction between polls.
    setInterval(tick, 1000);
  }

  // Surgical per-second update: refresh the drop-timer / "starts in" text without
  // re-rendering the panel. Full re-renders happen on data polls (which preserve scroll).
  function tick() {
    try {
      // Re-anchor to torn.com's own chain bar first, so everything below (alarms, the
      // countdown, the staleness check) works off the freshest truth available.
      syncChainFromSidebar();
      // Alarms run regardless of visibility — they exist to alert you when the panel
      // is collapsed or hidden and you're not watching it.
      evaluateAlarms();
      updateWakeLock();
      if (state.hidden) return;
      if (state.collapsed) {
        // Minimized: only the compact status drop-timer is visible — keep it ticking.
        const cel = document.getElementById("tocw-ctimer");
        if (cel && state.chain?.active) {
          const remaining = chainRemaining();
          cel.textContent = duration(remaining);
          cel.className = `tocw-cstatus-timer ${timerUrgencyClass(remaining)}`;
        }
        return;
      }

      const el = document.getElementById("tocw-timer");
      if (el) {
        // Preserve the base class (full-panel .tocw-big vs focus-mode .tocw-focus-timer),
        // only swapping the urgency modifier.
        const base = el.classList.contains("tocw-focus-timer") ? "tocw-focus-timer" : "tocw-big";
        if (state.chain?.active) {
          const remaining = chainRemaining();
          el.textContent = duration(remaining);
          el.className = `${base} ${timerUrgencyClass(remaining)}`;
        } else {
          const event = state.watch?.event || state.signup?.event || null;
          const seconds = event ? countdownTo(event.starts_at) : null;
          el.textContent = event ? `Starts in ${duration(seconds)}` : "--";
          el.className = base;
        }
      }

      // The viewer's own shift countdown ("on watch — ends in / starts in").
      const shiftEl = document.getElementById("tocw-shift-timer");
      if (shiftEl) {
        const { active, next } = viewerShiftStatus();
        if (active) shiftEl.textContent = duration(Math.max(0, Math.floor((new Date(active.end).getTime() - Date.now()) / 1000)));
        else if (next) shiftEl.textContent = duration(countdownTo(next.start));
      }
    } catch (error) {
      console.error("[Torn Overseer Chain Watch] tick failed", error);
    }
  }

  if (!IS_BROWSER) {
    // Node: export the pure helpers for the unit tests and never boot the UI.
    if (typeof module === "object" && module && module.exports) {
      module.exports = {
        state,
        parseChain,
        parseAttacks,
        serverLiveChain,
        parseTargetIds,
        parseThresholds,
        cleanThresholdArray,
        validHttpUrl,
        compareVersions,
        extractSignupToken,
        parseResponseMeta,
        stalenessFromMeta,
        noteServerClock,
        serverClockOffsetSec,
        resetClockSamplesForTests,
        validateSchedule,
        parseTctInput,
        currentAndNextShift,
        render,
        renderSlot,
        renderSignupShifts,
        renderKeyGate,
        renderSlotActionForm,
        rosterList,
        filterRoster,
        openSlotAction,
        parseRoster,
        rosterName,
        rosterStatus,
        profileLink,
        absentMembers,
        normalizedShifts,
        coverageGaps,
        handoffStatus,
        chainWarmup,
        chainStaleness,
        chainRemaining,
        nextBonus,
        duration,
        noteChainHits,
        noteChainTimer,
        clearChainEstimate,
      };
    }
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
