/* schema.js — shared constants and record factories. Classic script → window.LCC.schema */
(function (root) {
  "use strict";
  var LCC = (root.LCC = root.LCC || {});
  var util = LCC.util;

  var SCORING = [
    { key: "approach",    label: "Independent approach development", max: 30 },
    { key: "process",     label: "Code development process",         max: 15 },
    { key: "correctness", label: "Correctness & edge-case handling", max: 20 },
    { key: "complexity",  label: "Complexity analysis",              max: 10 },
    { key: "debugging",   label: "Debugging & recovery",             max: 15 },
    { key: "explanation", label: "Explanation quality",              max: 10 }
  ];

  var schema = {
    VERSION: 1,

    MODES: [
      { id: "independent", label: "Independent solving", hintsAllowed: false, desc: "No hints, no editorial. Pure practice." },
      { id: "hints",       label: "Hints allowed",       hintsAllowed: true,  desc: "You may peek at hints but not full solutions." },
      { id: "review",      label: "Editorial / review",  hintsAllowed: true,  desc: "Studying the editorial or redoing a known problem." }
    ],

    OUTCOMES: [
      { id: "accepted",  label: "Accepted" },
      { id: "attempted", label: "Attempted (not accepted)" },
      { id: "gave_up",   label: "Gave up / out of time" },
      { id: "reviewed",  label: "Reviewed only" }
    ],

    SCORING: SCORING,

    // A single paste larger than this (characters) is flagged for classification.
    LARGE_PASTE_CHARS: 120,
    // No editor activity for this long (ms) starts an "inactivity" period.
    INACTIVITY_GAP_MS: 60000,
    // Each edit event credits this much "active coding time" (merged, capped by elapsed).
    ACTIVE_WINDOW_MS: 8000,
    // If the content script stops sending heartbeats for this long (tab closed,
    // crashed, or asleep), the background freezes the timer at the last beat.
    STALE_TICK_MS: 45000,

    REMINDER_DAYS: [1, 3, 7, 14],

    KEYS: { active: "lc_active", sessions: "lc_sessions", settings: "lc_settings" },

    DEFAULT_SETTINGS: {
      storeRawCode: false,        // privacy: off by default. Only diffs/lengths kept.
      remindersEnabled: true,
      showOverlay: true,
      largePasteChars: 120,
      autoPauseMins: 5            // auto-pause after this many minutes idle (0 = off)
    },

    /** A fresh, empty self-assessment plan (pre-session). */
    newPlan: function () {
      return { observations: "", bruteForce: "", optimized: "", timeComplexity: "", spaceComplexity: "" };
    },

    /** A fresh reflection (post-session). null booleans = "not answered". */
    newReflection: function () {
      return {
        outcome: "",
        solvedWithoutHints: null,
        usedExternalHelp: null,
        canReproduce: null,
        canExplain: null,
        edgeCases: "",
        explanation: ""
      };
    },

    /** Build a new active-session object. */
    newSession: function (fields) {
      fields = fields || {};
      var start = Date.now();
      return {
        id: util.uuid(),
        schemaVersion: 1,
        url: fields.url || "",
        slug: fields.slug || "",
        title: fields.title || "",
        difficulty: fields.difficulty || "",
        mode: fields.mode || "independent",
        createdAt: start,
        startedAt: start,
        endedAt: null,
        // timing
        durationMs: 0,       // wall-clock while running (excludes paused time)
        activeMs: 0,         // approximate active coding time
        pausedMs: 0,
        running: true,
        paused: false,
        pausedReason: null,  // 'manual' | 'idle' — idle pauses auto-resume on activity
        lastResumeAt: start,
        lastActivityAt: start,
        lastTickAt: start,   // heartbeat from the content script; stale => tab gone
        firstEditAt: null,
        // self-assessment
        plan: schema.newPlan(),
        planSavedAt: null,
        reflection: schema.newReflection(),
        // observed metrics
        metrics: {
          editEvents: 0,
          keystrokes: 0,
          largestPasteChars: 0,
          pastes: [],           // {ts, chars, classification}
          submissions: [],      // {ts, verdict, passed, total, runtimeMs, memory, codeLen, lineCount, diff}
          inactivityPeriods: [],// {start, end, ms}
          editorAvailable: null // set true/false once we know if hooks attached
        },
        scored: null
      };
    }
  };

  LCC.schema = schema;
})(typeof self !== "undefined" ? self : this);
