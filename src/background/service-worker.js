/* service-worker.js — MV3 background (classic worker). The single owner of the
   active session: content scripts and the popup send it events and commands,
   it aggregates them into chrome.storage.local, scores on finish, and schedules
   revision reminders via chrome.alarms + chrome.notifications. No network. */
importScripts("../lib/util.js", "../lib/schema.js", "../lib/storage.js", "../lib/scoring.js");

var S = self.LCC.schema, U = self.LCC.util, store = self.LCC.storage, scoring = self.LCC.scoring;

/* ---------------- init ---------------- */
chrome.runtime.onInstalled.addListener(function () {
  store.getSettings().then(function (s) { store.setSettings(s); }); // materialize defaults
});

/* ---------------- helpers ---------------- */
function recompute(a) {
  if (!a) return a;
  if (a.running && !a.paused) a.durationMs = Math.max(0, Date.now() - a.startedAt - (a.pausedMs || 0));
  // active time can never exceed wall-clock session time
  if (a.activeMs > a.durationMs) a.activeMs = a.durationMs;
  return a;
}

// If the content script stopped heartbeating (tab closed/crashed/asleep),
// freeze the timer at the last heartbeat and mark it idle-paused so reopening
// doesn't silently count all the away-time. Returns true if it changed `a`.
function maybeStaleFreeze(a) {
  if (!a || !a.running || a.paused) return false;
  var last = a.lastTickAt || a.startedAt;
  if (Date.now() - last <= S.STALE_TICK_MS) return false;
  a.paused = true;
  a.pausedReason = "idle";
  a.pauseStartedAt = last;
  a.durationMs = Math.max(0, last - a.startedAt - (a.pausedMs || 0));
  return true;
}

function withActive(fn, sendResponse) {
  store.getActive().then(function (a) {
    Promise.resolve(fn(a)).then(function (ret) {
      if (ret && ret.__persist !== false && ret.active) {
        store.setActive(recompute(ret.active)).then(function () { sendResponse(ret.resp !== undefined ? ret.resp : { ok: true }); });
      } else {
        sendResponse(ret && ret.resp !== undefined ? ret.resp : { ok: true });
      }
    });
  });
}

function creditActiveTime(a) {
  var now = Date.now();
  if (a._lastEditAt) a.activeMs = (a.activeMs || 0) + Math.min(S.ACTIVE_WINDOW_MS, now - a._lastEditAt);
  else a.activeMs = (a.activeMs || 0) + S.ACTIVE_WINDOW_MS;
  a._lastEditAt = now;
  if (!a.firstEditAt) a.firstEditAt = now;
}

/* ---------------- message router ---------------- */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  switch (msg.type) {

    case "GET_STATE":
      Promise.all([store.getActive(), store.getSettings()]).then(function (r) {
        var a = r[0];
        if (maybeStaleFreeze(a)) {
          store.setActive(a).then(function () { sendResponse({ active: a, settings: r[1] }); });
        } else {
          sendResponse({ active: recompute(a), settings: r[1] });
        }
      });
      return true;

    case "GET_SETTINGS":
      store.getSettings().then(function (s) { sendResponse(s); });
      return true;

    case "SET_SETTINGS":
      store.setSettings(msg.patch || {}).then(function (s) { sendResponse(s); });
      return true;

    case "START_SESSION":
      store.getActive().then(function (existing) {
        if (existing && existing.running) { sendResponse({ active: recompute(existing), already: true }); return; }
        var sess = S.newSession({ url: msg.url, slug: msg.slug, title: msg.title, difficulty: msg.difficulty, mode: msg.mode });
        store.setActive(sess).then(function () { sendResponse({ active: sess }); });
      });
      return true;

    case "PAUSE":
      withActive(function (a) {
        if (!a) return { resp: { ok: false } };
        if (!a.paused) { recompute(a); a.paused = true; a.pauseStartedAt = Date.now(); a.pausedReason = "manual"; }
        return { active: a };
      }, sendResponse);
      return true;

    // Idle auto-pause: freeze at `since` (the last activity), not now, so the
    // idle gap that triggered it is excluded from the timer.
    case "AUTO_PAUSE":
      withActive(function (a) {
        if (!a || a.paused || a.slug !== msg.slug) return { resp: { ok: true }, __persist: false };
        var since = msg.since && msg.since <= Date.now() ? msg.since : Date.now();
        since = Math.max(since, a.startedAt);
        a.paused = true; a.pausedReason = "idle"; a.pauseStartedAt = since;
        a.durationMs = Math.max(0, since - a.startedAt - (a.pausedMs || 0));
        return { active: a };
      }, sendResponse);
      return true;

    case "RESUME":
      withActive(function (a) {
        if (!a) return { resp: { ok: false } };
        if (a.paused) { a.pausedMs = (a.pausedMs || 0) + (Date.now() - (a.pauseStartedAt || Date.now())); a.paused = false; a.pausedReason = null; a.pauseStartedAt = null; a.lastResumeAt = Date.now(); a.lastTickAt = Date.now(); a.lastActivityAt = Date.now(); a._lastEditAt = null; }
        return { active: a };
      }, sendResponse);
      return true;

    // Only resumes an IDLE auto-pause (a manual pause stays paused until you resume).
    case "AUTO_RESUME":
      withActive(function (a) {
        if (!a || !a.paused || a.pausedReason !== "idle" || a.slug !== msg.slug) return { resp: { ok: true }, __persist: false };
        a.pausedMs = (a.pausedMs || 0) + (Date.now() - (a.pauseStartedAt || Date.now()));
        a.paused = false; a.pausedReason = null; a.pauseStartedAt = null; a.lastResumeAt = Date.now(); a.lastTickAt = Date.now(); a.lastActivityAt = Date.now(); a._lastEditAt = null;
        return { active: a };
      }, sendResponse);
      return true;

    // Heartbeat from the content script: proves the tab is alive and carries the
    // last activity time used for idle decisions.
    case "HEARTBEAT":
      withActive(function (a) {
        if (!a || a.slug !== msg.slug) return { resp: { ok: true }, __persist: false };
        a.lastTickAt = Date.now();
        if (msg.lastActivityAt) a.lastActivityAt = msg.lastActivityAt;
        return { active: a };
      }, sendResponse);
      return true;

    case "SAVE_PLAN":
      withActive(function (a) {
        if (!a) return { resp: { ok: false } };
        a.plan = Object.assign(S.newPlan(), msg.plan || {});
        a.planSavedAt = Date.now();
        return { active: a };
      }, sendResponse);
      return true;

    case "EDITOR_STATUS":
      withActive(function (a) {
        if (!a || a.slug !== msg.slug) return { resp: { ok: true }, __persist: false };
        a.metrics.editorAvailable = !!msg.available;
        return { active: a };
      }, sendResponse);
      return true;

    case "EVENT_EDIT":
      withActive(function (a) {
        if (!a || !a.running || a.paused || a.slug !== msg.slug) return { resp: { ok: true }, __persist: false };
        var m = a.metrics;
        m.editEvents += 1;
        m.keystrokes += Math.max(0, msg.inserted || 0);
        if ((msg.maxSingle || 0) > m.largestPasteChars) m.largestPasteChars = msg.maxSingle;
        if (msg.lines != null) m.lastLineCount = msg.lines;
        creditActiveTime(a);
        recompute(a);
        return { active: a };
      }, sendResponse);
      return true;

    case "EVENT_RUN":
      withActive(function (a) {
        if (!a || a.slug !== msg.slug) return { resp: { ok: true }, __persist: false };
        a.metrics.runs = (a.metrics.runs || 0) + 1;
        return { active: a };
      }, sendResponse);
      return true;

    case "PASTE_NEW":
      withActive(function (a) {
        if (!a || a.slug !== msg.slug) return { resp: { ok: true }, __persist: false };
        a.metrics.pastes.push({ id: msg.id, ts: Date.now(), chars: msg.chars, classification: "unclassified" });
        return { active: a };
      }, sendResponse);
      return true;

    case "PASTE_CLASSIFY":
      withActive(function (a) {
        if (!a) return { resp: { ok: true }, __persist: false };
        var p = a.metrics.pastes.find(function (x) { return x.id === msg.id; });
        if (p) p.classification = msg.classification;
        return { active: a };
      }, sendResponse);
      return true;

    case "EVENT_OUTCOME":
      withActive(function (a) {
        if (!a || a.slug !== msg.slug) return { resp: { ok: true }, __persist: false };
        var sub = {
          ts: Date.now(), verdict: msg.verdict || "Unknown",
          passed: msg.passed, total: msg.total, runtimeMs: msg.runtimeMs, memory: msg.memory,
          codeLen: msg.codeLen, lineCount: msg.lineCount, diff: msg.diff || null
        };
        if (msg.raw != null) sub.raw = msg.raw; // only arrives if the user enabled storeRawCode
        a.metrics.submissions.push(sub);
        recompute(a);
        return { active: a, resp: { ok: true, active: a } };
      }, sendResponse);
      return true;

    case "EVENT_INACTIVITY":
      withActive(function (a) {
        if (!a || a.slug !== msg.slug) return { resp: { ok: true }, __persist: false };
        a.metrics.inactivityPeriods.push({ start: msg.startTs, end: msg.endTs, ms: msg.ms });
        return { active: a };
      }, sendResponse);
      return true;

    case "END_SESSION":
      endSession(msg.reflection).then(function (finished) { sendResponse(finished); });
      return true;

    case "OPEN_DASHBOARD":
      chrome.tabs.create({ url: chrome.runtime.getURL("src/dashboard/dashboard.html") });
      sendResponse({ ok: true });
      return true;

    case "FORCE_END": // popup escape hatch: end without a reflection
      endSession(null).then(function (f) { sendResponse(f); });
      return true;
  }
});

/* ---------------- finish & score ---------------- */
function endSession(reflection) {
  return store.getActive().then(function (a) {
    if (!a) return { ok: false, error: "no active session" };
    recompute(a);
    a.running = false; a.paused = false; a.endedAt = Date.now();
    if (reflection) a.reflection = Object.assign(S.newReflection(), reflection);
    // time-to-approach: plan saved time, else first edit, relative to start
    a.approachMs = a.planSavedAt ? (a.planSavedAt - a.startedAt) : (a.firstEditAt ? a.firstEditAt - a.startedAt : null);
    delete a._lastEditAt;
    try { a.scored = scoring.scoreSession(a); } catch (e) { a.scored = null; }

    return store.getSettings().then(function (settings) {
      return store.addSession(a).then(function () {
        return store.clearActive().then(function () {
          if (settings.remindersEnabled) scheduleReminders(a);
          return a;
        });
      });
    });
  });
}

/* ---------------- revision reminders ---------------- */
function scheduleReminders(session) {
  try {
    S.REMINDER_DAYS.forEach(function (day) {
      var when = Date.now() + day * 24 * 60 * 60 * 1000;
      chrome.alarms.create("lc-remind:" + session.id + ":" + day, { when: when });
    });
  } catch (e) { /* ignore */ }
}

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (!alarm || alarm.name.indexOf("lc-remind:") !== 0) return;
  var parts = alarm.name.split(":"); // lc-remind, id, day
  var id = parts[1], day = parts[2];
  store.getSessions().then(function (list) {
    var s = list.find(function (x) { return x.id === id; });
    var title = s ? (s.title || U.titleFromSlug(s.slug)) : "a LeetCode problem";
    try {
      chrome.notifications.create("lc-note:" + id + ":" + day, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("src/icons/icon128.png"),
        title: "Revision reminder (" + day + "d)",
        message: "Time to revisit “" + title + "”. Can you still reproduce and explain it?",
        priority: 1
      });
    } catch (e) { /* notifications may be unavailable */ }
  });
});

// Clicking the reminder opens the dashboard.
chrome.notifications.onClicked.addListener(function (noteId) {
  if (noteId && noteId.indexOf("lc-note:") === 0) {
    chrome.tabs.create({ url: chrome.runtime.getURL("src/dashboard/dashboard.html") });
    chrome.notifications.clear(noteId);
  }
});
