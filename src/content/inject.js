/* inject.js — runs in the PAGE's MAIN world (declared world:"MAIN" in the
   manifest), so it can touch LeetCode's own `window.monaco` and patch
   fetch/XHR. It NEVER stores anything and NEVER sends anything off-device:
   it only posts same-window messages to content.js (ISOLATED world), which
   decides what to keep. Everything is wrapped in try/catch and degrades to
   "editor unavailable" instead of throwing, because it depends on LeetCode
   internals that can change.

   Investigated against leetcode.com/problems/two-sum (2026-10): editor is
   Monaco with `window.monaco` exposed; submission verdicts arrive via polled
   GET .../submissions/detail/<id>/check/ JSON responses. */
(function () {
  "use strict";
  if (window.__lccInjected) return;
  window.__lccInjected = true;

  var TAG = "LCC_INJECT";
  function post(msg) {
    try { msg.source = TAG; window.postMessage(msg, window.location.origin); }
    catch (e) { /* ignore */ }
  }

  /* ---------------- Monaco editor hooks ---------------- */
  var attached = new WeakSet();
  var codeModel = null;

  function isCodeModel(model) {
    try {
      var lang = model.getLanguageId ? model.getLanguageId() : "";
      // The sample/testcase box is plaintext; the solution editor is a real language.
      return lang && lang !== "plaintext";
    } catch (e) { return false; }
  }

  function lineCount(model) {
    try { return model.getLineCount ? model.getLineCount() : 0; } catch (e) { return 0; }
  }

  function attachModel(model) {
    try {
      if (!model || attached.has(model) || !isCodeModel(model)) return;
      attached.add(model);
      codeModel = model;
      model.onDidChangeContent(function (e) {
        try {
          var inserted = 0, removed = 0, maxSingle = 0;
          (e.changes || []).forEach(function (c) {
            var t = c.text ? c.text.length : 0;
            inserted += t; removed += c.rangeLength || 0;
            if (t > maxSingle) maxSingle = t;
          });
          post({ type: "change", inserted: inserted, removed: removed, maxSingle: maxSingle,
                 len: model.getValueLength ? model.getValueLength() : 0, lines: lineCount(model) });
        } catch (err) { /* ignore */ }
      });
      post({ type: "editor-status", available: true });
    } catch (e) { /* ignore */ }
  }

  function tryAttach() {
    try {
      if (!window.monaco || !window.monaco.editor) return false;
      var models = window.monaco.editor.getModels ? window.monaco.editor.getModels() : [];
      var any = false;
      models.forEach(function (m) { if (isCodeModel(m)) { attachModel(m); any = true; } });
      // Attach to models created later (language switch, late load).
      if (!window.__lccModelHook && window.monaco.editor.onDidCreateModel) {
        window.__lccModelHook = true;
        window.monaco.editor.onDidCreateModel(function (m) { setTimeout(function () { attachModel(m); }, 0); });
      }
      return any;
    } catch (e) { return false; }
  }

  // Poll for monaco until it is ready (document_start runs before LeetCode loads it).
  var tries = 0;
  var poll = setInterval(function () {
    tries++;
    if (tryAttach() || tries > 120 /* ~60s */) {
      clearInterval(poll);
      if (tries > 120 && !codeModel) post({ type: "editor-status", available: false });
    }
  }, 500);

  // Answer requests for the current code snapshot (used at submission time).
  window.addEventListener("message", function (ev) {
    if (ev.source !== window || !ev.data || ev.data.source !== "LCC_CONTENT") return;
    if (ev.data.type === "getCode") {
      var code = "", lines = 0, len = 0;
      try { if (codeModel) { code = codeModel.getValue(); lines = lineCount(codeModel); len = code.length; } } catch (e) {}
      post({ type: "code", reqId: ev.data.reqId || null, code: code, len: len, lines: lines });
    }
  });

  /* ---------------- Submission/Run outcome hooks ---------------- */
  // LeetCode polls GET .../submissions/detail/<id>/check/ returning JSON with
  // state/status_msg/total_correct/total_testcases/status_runtime/status_memory.
  function parseMs(s) { try { var m = String(s || "").match(/([\d.]+)/); return m ? Math.round(parseFloat(m[1])) : null; } catch (e) { return null; } }

  function handleCheck(json) {
    try {
      if (!json || json.state !== "SUCCESS") return;             // still PENDING/STARTED → ignore
      var sid = String(json.submission_id || "");
      var isRun = sid.indexOf("runcode") === 0 || json.code_answer != null;
      post({
        type: "outcome",
        kind: isRun ? "run" : "submit",
        verdict: json.status_msg || (json.run_success ? "Finished" : "Unknown"),
        passed: typeof json.total_correct === "number" ? json.total_correct : null,
        total: typeof json.total_testcases === "number" ? json.total_testcases : null,
        runtimeMs: parseMs(json.status_runtime),
        memory: json.status_memory || null
      });
    } catch (e) { /* ignore */ }
  }

  function looksLikeCheck(url) { return typeof url === "string" && url.indexOf("/check/") !== -1; }

  // Patch fetch.
  try {
    var _fetch = window.fetch;
    if (_fetch && !window.__lccFetchHook) {
      window.__lccFetchHook = true;
      window.fetch = function () {
        var url = arguments[0] && arguments[0].url ? arguments[0].url : arguments[0];
        return _fetch.apply(this, arguments).then(function (res) {
          try {
            if (looksLikeCheck(url)) res.clone().json().then(handleCheck).catch(function () {});
          } catch (e) {}
          return res;
        });
      };
    }
  } catch (e) {}

  // Patch XMLHttpRequest (LeetCode has historically used XHR for the check poll).
  try {
    var XP = XMLHttpRequest.prototype;
    if (!XP.__lccHook) {
      XP.__lccHook = true;
      var _open = XP.open, _send = XP.send;
      XP.open = function (method, url) { this.__lccUrl = url; return _open.apply(this, arguments); };
      XP.send = function () {
        var xhr = this;
        this.addEventListener("load", function () {
          try {
            if (looksLikeCheck(xhr.__lccUrl) && xhr.responseText) handleCheck(JSON.parse(xhr.responseText));
          } catch (e) {}
        });
        return _send.apply(this, arguments);
      };
    }
  } catch (e) {}
})();
