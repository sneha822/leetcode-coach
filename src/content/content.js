/* content.js — ISOLATED world. Renders the on-page coach overlay, the
   pre-session plan prompt, the paste warning, and the post-session reflection,
   and relays observed editor/network events (received from inject.js via
   window messages) to the background service worker, which owns the session.

   This script treats LeetCode's DOM/internals as untrusted and optional: if
   anything is missing it hides that feature instead of breaking. */
(function () {
  "use strict";
  var LCC = window.LCC;
  if (!LCC || !LCC.schema) { console.warn("[LCC] libs not loaded"); return; }
  var S = LCC.schema, U = LCC.util;

  var slug = U.slugFromUrl(location.href);
  if (!slug) return; // not a problem page

  var state = { active: null, settings: S.DEFAULT_SETTINGS, editorAvailable: null };
  var clock = { baseMs: 0, running: false, paused: false, at: Date.now() };
  var lastActivityAt = Date.now();
  var inactivity = null; // {startTs}
  var prevCode = null;   // last submitted code snapshot (for diffs)
  var codeWaiters = {};

  /* ---------- tiny DOM helper ---------- */
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      if (k === "class") e.className = attrs[k];
      else if (k === "text") e.textContent = attrs[k];
      else if (k === "html") e.innerHTML = attrs[k];
      else if (k.slice(0, 2) === "on" && typeof attrs[k] === "function") e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function send(type, payload) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(Object.assign({ type: type, slug: slug, url: location.href }, payload || {}), function (res) {
          void chrome.runtime.lastError; resolve(res || null);
        });
      } catch (e) { resolve(null); }
    });
  }

  /* ---------- talk to inject.js (MAIN world) ---------- */
  function requestCode() {
    return new Promise(function (resolve) {
      var reqId = U.uuid();
      codeWaiters[reqId] = resolve;
      window.postMessage({ source: "LCC_CONTENT", type: "getCode", reqId: reqId }, location.origin);
      setTimeout(function () { if (codeWaiters[reqId]) { delete codeWaiters[reqId]; resolve(null); } }, 1500);
    });
  }

  window.addEventListener("message", function (ev) {
    if (ev.source !== window || !ev.data || ev.data.source !== "LCC_INJECT") return;
    var d = ev.data;
    if (d.type === "editor-status") { state.editorAvailable = d.available; send("EDITOR_STATUS", { available: d.available }); refresh(); return; }
    if (d.type === "code") { var w = codeWaiters[d.reqId]; if (w) { delete codeWaiters[d.reqId]; w(d); } return; }
    if (d.type === "change") { onEditorChange(d); return; }
    if (d.type === "outcome") { onOutcome(d); return; }
  });

  function activeHere() {
    return state.active && state.active.running && state.active.slug === slug;
  }

  function onEditorChange(d) {
    markActivity();
    if (!activeHere() || state.active.paused) return;
    send("EVENT_EDIT", { inserted: d.inserted, removed: d.removed, maxSingle: d.maxSingle, len: d.len, lines: d.lines });
    var threshold = state.settings.largePasteChars || S.LARGE_PASTE_CHARS;
    if (d.maxSingle >= threshold) {
      var id = U.uuid();
      send("PASTE_NEW", { id: id, chars: d.maxSingle }).then(function () { showPasteToast(id, d.maxSingle); });
    }
  }

  function onOutcome(d) {
    if (!activeHere()) return;
    if (d.kind !== "submit") { // a "Run" — record lightly, don't count as a submission
      send("EVENT_RUN", { verdict: d.verdict });
      return;
    }
    requestCode().then(function (codeRes) {
      var codeLen = codeRes ? codeRes.len : null;
      var lines = codeRes ? codeRes.lines : null;
      var diff = null, raw = null;
      if (codeRes && codeRes.code != null) {
        diff = diffLines(prevCode, codeRes.code);
        prevCode = codeRes.code;
        if (state.settings.storeRawCode) raw = codeRes.code; // off by default (privacy)
      }
      send("EVENT_OUTCOME", {
        verdict: d.verdict, passed: d.passed, total: d.total,
        runtimeMs: d.runtimeMs, memory: d.memory, codeLen: codeLen, lineCount: lines,
        diff: diff, raw: raw
      }).then(refresh);
    });
  }

  // Cheap line-level diff summary (added / removed / net char delta). Not a true
  // LCS — just enough to describe "what changed between attempts".
  function diffLines(a, b) {
    if (a == null) return { addedLines: null, removedLines: null, charDelta: null, firstAttempt: true };
    var sa = a.split("\n"), sb = b.split("\n");
    var setA = {}, setB = {};
    sa.forEach(function (l) { setA[l] = (setA[l] || 0) + 1; });
    sb.forEach(function (l) { setB[l] = (setB[l] || 0) + 1; });
    var added = 0, removed = 0;
    Object.keys(setB).forEach(function (l) { added += Math.max(0, setB[l] - (setA[l] || 0)); });
    Object.keys(setA).forEach(function (l) { removed += Math.max(0, setA[l] - (setB[l] || 0)); });
    return { addedLines: added, removedLines: removed, charDelta: b.length - a.length, firstAttempt: false };
  }

  /* ---------- activity / inactivity ---------- */
  function markActivity() {
    lastActivityAt = Date.now();
    if (inactivity) {
      var period = { startTs: inactivity.startTs, endTs: Date.now(), ms: Date.now() - inactivity.startTs };
      inactivity = null;
      if (activeHere() && !state.active.paused) send("EVENT_INACTIVITY", period);
    }
  }
  setInterval(function () {
    if (!activeHere() || state.active.paused) return;
    var gap = Date.now() - lastActivityAt;
    if (!inactivity && gap >= S.INACTIVITY_GAP_MS) inactivity = { startTs: lastActivityAt };
  }, 10000);
  // Mouse/keyboard inside the editor counts as activity (not stored as edits).
  document.addEventListener("keydown", function (e) { if (e.target && e.target.closest && e.target.closest(".monaco-editor")) markActivity(); }, true);

  /* ================= OVERLAY ================= */
  var root = null, panel = null;
  function mount() {
    if (root) return;
    root = el("div", { id: "lcc-root" });
    (document.body || document.documentElement).appendChild(root);
    refresh();
  }

  function liveMs() {
    if (clock.running && !clock.paused) return clock.baseMs + (Date.now() - clock.at);
    return clock.baseMs;
  }

  function refresh() {
    if (!root) return;
    if (!state.settings.showOverlay) { root.innerHTML = ""; return; }
    root.innerHTML = "";
    panel = el("div", { class: "lcc-panel" + (state.active && state.active.slug === slug && state.active.paused ? " lcc-paused" : "") });
    root.appendChild(panel);

    var mode = state.active ? modeLabel(state.active.mode) : "";
    var header = el("div", { class: "lcc-head" }, [
      el("span", { class: "lcc-logo", text: "◆ Coach" }),
      state.active ? el("span", { class: "lcc-badge lcc-mode-" + state.active.mode, text: mode }) : null,
      el("button", { class: "lcc-min", title: "Hide overlay", text: "–", onclick: function () { state.settings.showOverlay = false; LCC.storage.setSettings({ showOverlay: false }); refresh(); } })
    ]);
    panel.appendChild(header);

    if (state.active && state.active.slug === slug) {
      panel.appendChild(el("div", { class: "lcc-timer", id: "lcc-timer", text: U.fmtDuration(liveMs()) }));
      panel.appendChild(el("div", { class: "lcc-status", text: state.active.paused ? "Paused" : "Recording your process" }));
      var m = state.active.metrics || {};
      panel.appendChild(el("div", { class: "lcc-metrics" }, [
        pill("edits", m.editEvents || 0),
        pill("pastes", (m.pastes || []).length),
        pill("submits", (m.submissions || []).length),
        el("span", { class: "lcc-dot " + (state.editorAvailable === true ? "ok" : state.editorAvailable === false ? "bad" : "wait"), title: editorTitle() })
      ]));
      var controls = el("div", { class: "lcc-btns" }, [
        el("button", { class: "lcc-btn", text: state.active.paused ? "Resume" : "Pause", onclick: function () { send(state.active.paused ? "RESUME" : "PAUSE").then(pullState); } }),
        el("button", { class: "lcc-btn lcc-end", text: "End", onclick: endFlow })
      ]);
      panel.appendChild(controls);
    } else if (state.active && state.active.slug !== slug) {
      panel.appendChild(el("div", { class: "lcc-note", text: "A session is active on another problem (" + (state.active.title || state.active.slug) + ")." }));
      panel.appendChild(el("div", { class: "lcc-timer small", text: U.fmtDuration(liveMs()) }));
    } else {
      // No active session — offer to start here.
      var sel = el("select", { class: "lcc-select", id: "lcc-mode" }, S.MODES.map(function (mo) {
        return el("option", { value: mo.id, text: mo.label });
      }));
      panel.appendChild(el("div", { class: "lcc-note", text: "Ready to practise " + (probTitle() || slug) + "?" }));
      panel.appendChild(sel);
      panel.appendChild(el("button", { class: "lcc-btn lcc-start", text: "Start focus session", onclick: function () { startFlow(sel.value); } }));
    }
  }

  function pill(label, n) { return el("span", { class: "lcc-pill" }, [el("b", { text: String(n) }), el("i", { text: label })]); }
  function editorTitle() {
    return state.editorAvailable === true ? "Editor tracking active"
      : state.editorAvailable === false ? "Editor tracking unavailable (LeetCode may have changed) — metrics will show 'not assessed'"
      : "Waiting for the editor to load…";
  }
  function modeLabel(id) { var m = S.MODES.find(function (x) { return x.id === id; }); return m ? m.label : id; }

  /* ---------- problem metadata from the DOM (best-effort) ---------- */
  function probTitle() {
    var t = document.querySelector('[data-cy="question-title"]') ||
            document.querySelector(".text-title-large a") ||
            document.querySelector(".text-title-large") ||
            document.querySelector('a[href^="/problems/"]');
    var s = t ? t.textContent.trim() : "";
    return s || U.titleFromSlug(slug);
  }
  function probDifficulty() {
    var known = ["Easy", "Medium", "Hard"];
    var nodes = document.querySelectorAll('div[class*="difficulty"],span,div');
    for (var i = 0; i < nodes.length && i < 400; i++) {
      var tx = nodes[i].textContent.trim();
      if (known.indexOf(tx) >= 0) return tx;
    }
    return "";
  }

  /* ---------- start / plan flow ---------- */
  function startFlow(mode) {
    var payload = { mode: mode, url: location.href, slug: slug, title: probTitle(), difficulty: probDifficulty() };
    send("START_SESSION", payload).then(function () {
      pullState().then(function () {
        var modeObj = S.MODES.find(function (m) { return m.id === mode; });
        if (modeObj && !modeObj.hintsAllowed || mode === "hints") planModal(); // prompt plan for solving modes
        else if (mode !== "review") planModal();
      });
    });
  }

  function planModal() {
    var plan = (state.active && state.active.plan) || S.newPlan();
    var f = {};
    function row(key, label, ph, big) {
      var inp = big ? el("textarea", { class: "lcc-ta", placeholder: ph }) : el("input", { class: "lcc-in", placeholder: ph });
      inp.value = plan[key] || ""; f[key] = inp;
      return el("label", { class: "lcc-field" }, [el("span", { text: label }), inp]);
    }
    var body = el("div", {}, [
      el("p", { class: "lcc-sub", text: "Think before you code. This is logged as your own plan — the extension can't verify it, only record it." }),
      row("observations", "Initial observations", "What is the problem really asking? Inputs, constraints, patterns you notice…", true),
      row("bruteForce", "Brute-force idea", "The simplest thing that would work, even if slow.", true),
      row("optimized", "Optimized approach you'll try", "The idea you intend to implement.", true),
      el("div", { class: "lcc-two" }, [row("timeComplexity", "Expected time", "e.g. O(n)"), row("spaceComplexity", "Expected space", "e.g. O(1)")])
    ]);
    modal("Plan your approach", body, [
      { text: "Skip", class: "ghost", onClick: function (close) { close(); } },
      { text: "Save plan & start coding", class: "primary", onClick: function (close) {
          var plan2 = {}; Object.keys(f).forEach(function (k) { plan2[k] = f[k].value.trim(); });
          send("SAVE_PLAN", { plan: plan2 }).then(pullState).then(close);
      } }
    ]);
  }

  /* ---------- paste toast ---------- */
  function showPasteToast(id, chars) {
    var t = el("div", { class: "lcc-toast" }, [
      el("div", { class: "lcc-toast-ttl", text: "Large code insertion detected (" + chars + " chars)" }),
      el("div", { class: "lcc-toast-msg", text: "If this is your own refactoring, continue. If you used an external solution, mark it so your report stays honest." }),
      el("div", { class: "lcc-toast-btns" }, [
        el("button", { class: "lcc-btn sm", text: "My refactor", onclick: function () { classify(id, "refactor", t); } }),
        el("button", { class: "lcc-btn sm", text: "Template", onclick: function () { classify(id, "template", t); } }),
        el("button", { class: "lcc-btn sm warn", text: "External help", onclick: function () { classify(id, "external", t); } })
      ])
    ]);
    root.appendChild(t);
    setTimeout(function () { if (t.parentNode) { classify(id, "unclassified", t); } }, 20000);
  }
  function classify(id, kind, node) {
    send("PASTE_CLASSIFY", { id: id, classification: kind }).then(pullState);
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  /* ---------- end / reflection flow ---------- */
  function endFlow() {
    send("PAUSE").then(pullState).then(reflectionModal);
  }

  function reflectionModal() {
    var r = (state.active && state.active.reflection) || S.newReflection();
    var f = {};
    function yn(key, label) {
      var wrap = el("div", { class: "lcc-yn" }, [el("span", { text: label })]);
      ["Yes", "No"].forEach(function (v) {
        var b = el("button", { class: "lcc-chip", type: "button", text: v, onclick: function () {
          f[key] = (v === "Yes");
          wrap.querySelectorAll(".lcc-chip").forEach(function (x) { x.classList.remove("on"); });
          b.classList.add("on");
        } });
        if (r[key] === (v === "Yes")) b.classList.add("on");
        wrap.appendChild(b);
      });
      f[key] = r[key];
      return wrap;
    }
    var outSel = el("select", { class: "lcc-select" }, S.OUTCOMES.map(function (o) { return el("option", { value: o.id, text: o.label }); }));
    outSel.value = r.outcome || "attempted";
    var edge = el("textarea", { class: "lcc-ta", placeholder: "Which edge cases matter? (empty input, duplicates, overflow, single element…)" }); edge.value = r.edgeCases || "";
    var expl = el("textarea", { class: "lcc-ta", placeholder: "In your own words, why does your approach work?" }); expl.value = r.explanation || "";

    var body = el("div", {}, [
      el("p", { class: "lcc-sub", text: "Be honest — these answers are self-reported and clearly labelled as such in your score." }),
      el("label", { class: "lcc-field" }, [el("span", { text: "Outcome" }), outSel]),
      yn("solvedWithoutHints", "Did you solve it without hints?"),
      yn("usedExternalHelp", "Did you use external help (editorial, AI, friend)?"),
      yn("canReproduce", "Could you reproduce the solution now, from scratch?"),
      yn("canExplain", "Can you explain why it works and its complexity?"),
      el("label", { class: "lcc-field" }, [el("span", { text: "Edge cases you considered" }), edge]),
      el("label", { class: "lcc-field" }, [el("span", { text: "Explanation (why it works)" }), expl])
    ]);
    modal("How did it go?", body, [
      { text: "Resume instead", class: "ghost", onClick: function (close) { send("RESUME").then(pullState).then(close); } },
      { text: "Finish & score", class: "primary", onClick: function (close) {
          var refl = {
            outcome: outSel.value,
            solvedWithoutHints: f.solvedWithoutHints === undefined ? null : f.solvedWithoutHints,
            usedExternalHelp: f.usedExternalHelp === undefined ? null : f.usedExternalHelp,
            canReproduce: f.canReproduce === undefined ? null : f.canReproduce,
            canExplain: f.canExplain === undefined ? null : f.canExplain,
            edgeCases: edge.value.trim(),
            explanation: expl.value.trim()
          };
          send("END_SESSION", { reflection: refl }).then(function (res) {
            close();
            if (res && res.scored) scoreModal(res);
            pullState();
          });
      } }
    ]);
  }

  function scoreModal(session) {
    var sc = session.scored;
    var rows = sc.breakdown.map(function (b) {
      return el("div", { class: "lcc-score-row" + (b.notAssessed ? " na" : "") }, [
        el("div", { class: "lcc-score-top" }, [
          el("span", { class: "lcc-score-label", text: b.label }),
          el("span", { class: "lcc-score-pts", text: b.notAssessed ? "not assessed" : (b.points + " / " + b.max) }),
          el("span", { class: "lcc-score-basis " + b.basis.replace(/[^a-z]/g, ""), text: b.basis })
        ]),
        el("div", { class: "lcc-score-detail", text: b.detail })
      ]);
    });
    var body = el("div", {}, [
      el("div", { class: "lcc-bigscore" }, [
        el("b", { text: String(sc.total) }), el("span", { text: " / " + sc.assessedMax + " assessed" })
      ]),
      el("p", { class: "lcc-sub", text: sc.notAssessed.length ? ("Not assessed (insufficient evidence): " + sc.notAssessed.join(", ") + ". These are shown, never invented.") : "All six categories had enough evidence to assess." }),
      el("div", { class: "lcc-score-list" }, rows),
      el("button", { class: "lcc-btn", text: "Open dashboard", onclick: function () { send("OPEN_DASHBOARD"); } })
    ]);
    modal("Session score", body, [{ text: "Done", class: "primary", onClick: function (close) { close(); } }]);
  }

  /* ---------- generic modal ---------- */
  function modal(title, body, actions) {
    var overlay = el("div", { class: "lcc-modal-overlay" });
    var close = function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); };
    var btns = (actions || []).map(function (a) {
      return el("button", { class: "lcc-btn " + (a.class || ""), text: a.text, onclick: function () { a.onClick(close); } });
    });
    var box = el("div", { class: "lcc-modal" }, [
      el("div", { class: "lcc-modal-head" }, [el("h2", { text: title }), el("button", { class: "lcc-x", text: "×", onclick: close })]),
      el("div", { class: "lcc-modal-body" }, [body]),
      el("div", { class: "lcc-modal-foot" }, btns)
    ]);
    overlay.appendChild(box);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    root.appendChild(overlay);
    return close;
  }

  /* ---------- state sync ---------- */
  function applyState(res) {
    if (!res) return;
    state.active = res.active || null;
    if (res.settings) state.settings = res.settings;
    var a = state.active;
    if (a) {
      clock.baseMs = a.durationMs || 0;
      clock.running = !!a.running; clock.paused = !!a.paused; clock.at = Date.now();
      if (a.metrics && a.metrics.editorAvailable != null && state.editorAvailable == null) state.editorAvailable = a.metrics.editorAvailable;
    } else { clock.running = false; }
    refresh();
  }
  function pullState() { return send("GET_STATE").then(applyState); }

  // live timer tick
  setInterval(function () {
    var t = document.getElementById("lcc-timer");
    if (t && clock.running && !clock.paused) t.textContent = U.fmtDuration(liveMs());
  }, 1000);
  // periodic resync with the background (authoritative)
  setInterval(pullState, 4000);

  // commands from the popup (so plan/reflection modals appear on the page)
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    if (msg.type === "PING") { sendResponse({ ok: true, slug: slug, title: probTitle(), difficulty: probDifficulty() }); return; }
    if (msg.type === "POPUP_START") { startFlow(msg.mode || "independent"); sendResponse({ ok: true }); return; }
    if (msg.type === "POPUP_END") { endFlow(); sendResponse({ ok: true }); return; }
    if (msg.type === "POPUP_REFRESH") { LCC.storage.getSettings().then(function (s) { state.settings = s; pullState(); }); sendResponse({ ok: true }); return; }
  });

  // boot
  LCC.storage.getSettings().then(function (s) { state.settings = s; mount(); pullState(); });
})();
