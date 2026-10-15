/* popup.js — the toolbar controls. Reads session state from the background and
   delegates start/end to the page's content script so the plan & reflection
   modals appear on the LeetCode tab. */
(function () {
  "use strict";
  var U = window.LCC.util, S = window.LCC.schema;
  var view = document.getElementById("view");
  var tab = null, tabSlug = "", st = { active: null, settings: S.DEFAULT_SETTINGS };
  var tickTimer = null;

  function bg(type, payload) {
    return new Promise(function (res) {
      chrome.runtime.sendMessage(Object.assign({ type: type }, payload || {}), function (r) { void chrome.runtime.lastError; res(r || null); });
    });
  }
  function toTab(msg) {
    return new Promise(function (res) {
      if (!tab) return res(null);
      chrome.tabs.sendMessage(tab.id, msg, function (r) { void chrome.runtime.lastError; res(r || null); });
    });
  }
  function el(t, a, k) {
    var e = document.createElement(t); a = a || {};
    Object.keys(a).forEach(function (key) {
      if (key === "class") e.className = a[key];
      else if (key === "text") e.textContent = a[key];
      else if (key.slice(0, 2) === "on") e.addEventListener(key.slice(2), a[key]);
      else e.setAttribute(key, a[key]);
    });
    (k || []).forEach(function (c) { if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function liveMs(a) {
    if (!a) return 0;
    if (a.running && !a.paused) return (a.durationMs || 0) + (Date.now() - (a._fetchedAt || Date.now()));
    return a.durationMs || 0;
  }
  function pill(n, label) { return el("span", { class: "pill" }, [el("b", { text: String(n) }), el("i", { text: label })]); }

  function render() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    view.innerHTML = "";
    var a = st.active;

    if (a && a.running) {
      var onThisTab = a.slug === tabSlug;
      view.appendChild(el("div", { class: "title", text: a.title || U.titleFromSlug(a.slug) }));
      view.appendChild(el("div", { class: "row" }, [
        el("span", { class: "badge", text: (S.MODES.find(function (m) { return m.id === a.mode; }) || {}).label || a.mode }),
        el("span", { class: "status", text: a.paused ? (a.pausedReason === "idle" ? "Auto-paused (idle)" : "Paused") : "Recording" })
      ]));
      var timer = el("div", { class: "timer", text: U.fmtDuration(liveMs(a)) });
      view.appendChild(timer);
      var m = a.metrics || {};
      view.appendChild(el("div", { class: "metrics" }, [
        pill(m.editEvents || 0, "edits"), pill((m.pastes || []).length, "pastes"),
        pill((m.submissions || []).length, "submits"),
        pill(U.fmtMinutes(a.activeMs || 0), "active")
      ]));
      view.appendChild(el("div", { class: "btns" }, [
        el("button", { class: "btn", text: a.paused ? "Resume" : "Pause", onclick: function () { bg(a.paused ? "RESUME" : "PAUSE").then(load); } }),
        el("button", { class: "btn danger", text: "End", onclick: endSession })
      ]));
      if (!onThisTab) view.appendChild(el("div", { class: "note", text: "This session is on another tab. Open that problem to finish with a reflection, or use End to force-finish." }));

      if (a.running && !a.paused) tickTimer = setInterval(function () { timer.textContent = U.fmtDuration(liveMs(a)); }, 1000);
      return;
    }

    // no active session
    if (tabSlug) {
      view.appendChild(el("div", { class: "title", text: "Start a focus session" }));
      view.appendChild(el("div", { class: "sub", text: "On " + (tab && tab.title ? tab.title.replace(/ - LeetCode.*/, "") : U.titleFromSlug(tabSlug)) }));
      var sel = el("select", {}, S.MODES.map(function (mo) { return el("option", { value: mo.id, text: mo.label }); }));
      view.appendChild(sel);
      view.appendChild(el("div", { class: "sub", id: "modeDesc", text: S.MODES[0].desc }));
      sel.addEventListener("change", function () { var mo = S.MODES.find(function (x) { return x.id === sel.value; }); document.getElementById("modeDesc").textContent = mo ? mo.desc : ""; });
      view.appendChild(el("button", { class: "btn primary", text: "Start", onclick: function () {
        toTab({ type: "POPUP_START", mode: sel.value }).then(function () { window.close(); });
      } }));
    } else {
      view.appendChild(el("div", { class: "note", text: "Open a LeetCode problem page (leetcode.com/problems/…) to start a focus session." }));
      view.appendChild(el("div", { class: "sub", text: "Your past sessions and stats are in the dashboard." }));
    }
  }

  function endSession() {
    if (st.active && st.active.slug === tabSlug) {
      toTab({ type: "POPUP_END" }).then(function () { window.close(); });
    } else {
      bg("FORCE_END").then(load);
    }
  }

  function load() {
    return bg("GET_STATE").then(function (r) {
      st.active = r && r.active ? r.active : null;
      if (st.active) st.active._fetchedAt = Date.now();
      if (r && r.settings) st.settings = r.settings;
      render();
    });
  }

  /* settings panel */
  var panel = document.getElementById("settings");
  function syncSettingsUI() {
    document.getElementById("setReminders").checked = !!st.settings.remindersEnabled;
    document.getElementById("setOverlay").checked = !!st.settings.showOverlay;
    document.getElementById("setRawCode").checked = !!st.settings.storeRawCode;
    document.getElementById("setAutoPause").value = String(st.settings.autoPauseMins != null ? st.settings.autoPauseMins : 5);
  }
  function bindSetting(id, key) {
    document.getElementById(id).addEventListener("change", function (e) {
      var patch = {}; patch[key] = e.target.checked;
      bg("SET_SETTINGS", { patch: patch }).then(function (s) { st.settings = s; toTab({ type: "POPUP_REFRESH" }); });
    });
  }
  document.getElementById("setAutoPause").addEventListener("change", function (e) {
    bg("SET_SETTINGS", { patch: { autoPauseMins: parseInt(e.target.value, 10) || 0 } }).then(function (s) { st.settings = s; toTab({ type: "POPUP_REFRESH" }); });
  });
  bindSetting("setReminders", "remindersEnabled");
  bindSetting("setOverlay", "showOverlay");
  bindSetting("setRawCode", "storeRawCode");
  document.getElementById("cogBtn").addEventListener("click", function () { syncSettingsUI(); panel.hidden = false; });
  document.getElementById("closeSet").addEventListener("click", function () { panel.hidden = true; });
  document.getElementById("dashBtn").addEventListener("click", function () { bg("OPEN_DASHBOARD"); window.close(); });

  // boot: find active tab, derive slug, load state
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    tab = tabs && tabs[0];
    tabSlug = tab ? U.slugFromUrl(tab.url || "") : "";
    load();
  });
})();
