/* dashboard.js — reads all sessions from chrome.storage.local and renders
   stats, charts (inline SVG, no external libraries), upcoming revisions, and
   a session log. Export to CSV/JSON and a full reset are here too. */
(function () {
  "use strict";
  var U = window.LCC.util, S = window.LCC.schema, store = window.LCC.storage, scoring = window.LCC.scoring;
  var $ = function (id) { return document.getElementById(id); };
  var sessions = [];

  /* ---------- derived helpers ---------- */
  function scoreOf(s) { return s.scored || (function () { try { return scoring.scoreSession(s); } catch (e) { return null; } })(); }
  function accepted(s) {
    if (s.reflection && s.reflection.outcome === "accepted") return true;
    return (s.metrics && s.metrics.submissions || []).some(function (x) { return x.verdict === "Accepted"; });
  }
  function externalPaste(s) { return (s.metrics && s.metrics.pastes || []).some(function (p) { return p.classification === "external"; }); }
  function assisted(s) {
    return s.mode !== "independent" || (s.reflection && s.reflection.usedExternalHelp === true) || externalPaste(s);
  }
  function endTs(s) { return s.endedAt || s.createdAt || Date.now(); }
  function fmtDate(ts) { return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
  function el(t, a, k) {
    var e = document.createElement(t); a = a || {};
    Object.keys(a).forEach(function (key) {
      if (key === "class") e.className = a[key]; else if (key === "text") e.textContent = a[key];
      else if (key === "html") e.innerHTML = a[key]; else if (key.slice(0, 2) === "on") e.addEventListener(key.slice(2), a[key]);
      else e.setAttribute(key, a[key]);
    });
    (k || []).forEach(function (c) { if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }

  /* ---------- SVG bar chart ---------- */
  function barChart(bars, opts) {
    opts = opts || {};
    var W = opts.width || 640, H = opts.height || 150, pad = 26, n = bars.length || 1;
    var gap = 8, bw = Math.max(6, (W - pad * 2 - gap * (n - 1)) / n);
    var max = Math.max(1, Math.max.apply(null, bars.map(function (b) { return b.value; })));
    var svg = ['<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg">'];
    bars.forEach(function (b, i) {
      var x = pad + i * (bw + gap);
      var h = Math.round((b.value / max) * (H - pad * 2));
      var y = H - pad - h;
      svg.push('<rect x="' + x + '" y="' + y + '" width="' + bw + '" height="' + h + '" rx="4" fill="' + (b.color || "#8b7bff") + '"/>');
      if (b.inner != null && b.inner > 0) {
        var ih = Math.round((b.inner / max) * (H - pad * 2));
        svg.push('<rect x="' + x + '" y="' + (H - pad - ih) + '" width="' + bw + '" height="' + ih + '" rx="4" fill="' + (b.innerColor || "#4ec98a") + '"/>');
      }
      if (b.value) svg.push('<text class="bar-val" x="' + (x + bw / 2) + '" y="' + (y - 4) + '" text-anchor="middle">' + (b.valLabel != null ? b.valLabel : b.value) + '</text>');
      svg.push('<text class="bar-label" x="' + (x + bw / 2) + '" y="' + (H - pad + 13) + '" text-anchor="middle">' + b.label + '</text>');
    });
    svg.push('</svg>');
    return svg.join("");
  }

  function barRow(label, value, maxVal, cls, sub) {
    var pct = maxVal > 0 ? Math.round((value / maxVal) * 100) : 0;
    return el("div", { class: "barrow" }, [
      el("div", { class: "top" }, [el("span", { text: label }), el("span", { text: sub != null ? sub : String(value) })]),
      el("div", { class: "track" }, [el("div", { class: "fill " + (cls || ""), style: "width:" + pct + "%" })])
    ]);
  }

  /* ---------- render ---------- */
  function render() {
    if (!sessions.length) { $("empty").hidden = false; $("content").hidden = true; return; }
    $("empty").hidden = true; $("content").hidden = false;

    var completed = sessions.filter(accepted).length;
    var indep = sessions.filter(function (s) { return !assisted(s); }).length;
    var approachTimes = sessions.map(function (s) { return s.approachMs; }).filter(function (x) { return typeof x === "number" && x >= 0; });
    var avgApproach = approachTimes.length ? approachTimes.reduce(function (a, b) { return a + b; }, 0) / approachTimes.length : null;
    var avgDur = sessions.reduce(function (a, s) { return a + (s.durationMs || 0); }, 0) / sessions.length;

    /* tiles */
    $("tiles").innerHTML = "";
    [
      ["Problems attempted", sessions.length, ""],
      ["Completed (accepted)", completed, Math.round(completed / sessions.length * 100) + "% of attempts"],
      ["Independent", indep, (sessions.length - indep) + " assisted"],
      ["Avg time to approach", avgApproach != null ? U.fmtMinutes(avgApproach) : "—", approachTimes.length ? "across " + approachTimes.length : "no plans yet"],
      ["Avg session length", U.fmtMinutes(avgDur), ""]
    ].forEach(function (t) {
      $("tiles").appendChild(el("div", { class: "tile" }, [
        el("b", { text: String(t[1]) }), el("span", { text: t[0] }), t[2] ? el("div", {}, [el("small", { text: t[2] })]) : null
      ]));
    });

    /* weekly activity (last 8 weeks) */
    var weeks = [];
    var now = new Date(); now.setHours(0, 0, 0, 0);
    var monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    for (var w = 7; w >= 0; w--) {
      var start = new Date(monday); start.setDate(monday.getDate() - w * 7);
      var end = new Date(start); end.setDate(start.getDate() + 7);
      var inWeek = sessions.filter(function (s) { var t = endTs(s); return t >= start.getTime() && t < end.getTime(); });
      weeks.push({ label: (start.getMonth() + 1) + "/" + start.getDate(), value: inWeek.length, inner: inWeek.filter(accepted).length, color: "#3a3550", innerColor: "#4ec98a" });
    }
    $("chartWeekly").innerHTML = barChart(weeks, { width: 640, height: 150 });

    /* independent vs assisted */
    $("indVsAssist").innerHTML = "";
    $("indVsAssist").appendChild(barRow("Independent", indep, sessions.length, "ind"));
    $("indVsAssist").appendChild(barRow("Assisted", sessions.length - indep, sessions.length, "ass"));

    /* score trend (chronological, last 24) */
    var chrono = sessions.slice().sort(function (a, b) { return endTs(a) - endTs(b); }).slice(-24);
    var scoreBars = chrono.map(function (s) {
      var sc = scoreOf(s); var pct = sc && sc.assessedMax ? Math.round(sc.total / sc.assessedMax * 100) : 0;
      return { label: "", value: pct, valLabel: sc ? Math.round(sc.total) : 0, color: assisted(s) ? "#e0b24f" : "#8b7bff" };
    });
    $("chartScore").innerHTML = chrono.length ? barChart(scoreBars, { width: 640, height: 150 }) : '<p class="muted">No scored sessions yet.</p>';

    /* difficulty performance */
    $("byDifficulty").innerHTML = "";
    ["Easy", "Medium", "Hard"].forEach(function (d) {
      var grp = sessions.filter(function (s) { return (s.difficulty || "") === d; });
      if (!grp.length) { return; }
      var acc = grp.filter(accepted).length;
      var scs = grp.map(scoreOf).filter(Boolean).map(function (x) { return x.assessedMax ? x.total / x.assessedMax * 100 : 0; });
      var avg = scs.length ? Math.round(scs.reduce(function (a, b) { return a + b; }, 0) / scs.length) : 0;
      $("byDifficulty").appendChild(barRow(d + " (" + grp.length + ")", acc, grp.length, d.toLowerCase(), acc + "/" + grp.length + " accepted · avg " + avg + "%"));
    });
    if (!$("byDifficulty").children.length) $("byDifficulty").innerHTML = '<p class="muted">No difficulty data captured yet.</p>';

    /* debugging patterns */
    var withSubs = sessions.filter(function (s) { return (s.metrics && s.metrics.submissions || []).length > 0; });
    var multiSub = withSubs.filter(function (s) { return s.metrics.submissions.length > 1; });
    var recovered = multiSub.filter(function (s) {
      var subs = s.metrics.submissions; var fi = subs.findIndex(function (x) { return x.verdict === "Accepted"; });
      return fi > 0;
    });
    var allAcceptedSubs = [];
    sessions.forEach(function (s) { (s.metrics && s.metrics.submissions || []).forEach(function (x) { if (x.verdict === "Accepted" && typeof x.runtimeMs === "number") allAcceptedSubs.push(x.runtimeMs); }); });
    var avgRt = allAcceptedSubs.length ? Math.round(allAcceptedSubs.reduce(function (a, b) { return a + b; }, 0) / allAcceptedSubs.length) : null;
    var avgSubs = withSubs.length ? (withSubs.reduce(function (a, s) { return a + s.metrics.submissions.length; }, 0) / withSubs.length).toFixed(1) : null;
    $("debugStats").innerHTML = "";
    function kv(k, v) { $("debugStats").appendChild(el("div", { class: "kv" }, [el("span", { text: k }), el("b", { text: v })])); }
    if (withSubs.length) {
      kv("Avg submissions per problem", avgSubs);
      kv("Recovered (failed → accepted)", recovered.length + " / " + multiSub.length + " multi-attempt");
      kv("Avg accepted runtime", avgRt != null ? avgRt + " ms" : "—");
    } else { $("debugStats").innerHTML = '<p class="muted">No submission outcomes captured yet. (Requires the editor hooks to work on your logged-in LeetCode.)</p>'; }

    /* needed help */
    var help = sessions.filter(function (s) { return s.mode !== "independent" || (s.reflection && s.reflection.usedExternalHelp === true); });
    renderList("needHelp", help.map(function (s) {
      var reason = s.mode !== "independent" ? ("mode: " + s.mode) : "self-reported external help";
      return { s: s, meta: reason };
    }), "No hint/editorial sessions — all independent so far.");

    /* re-attempted problems */
    var bySlug = {};
    sessions.forEach(function (s) { (bySlug[s.slug] = bySlug[s.slug] || []).push(s); });
    var repeats = Object.keys(bySlug).filter(function (k) { return bySlug[k].length > 1; }).map(function (k) {
      var grp = bySlug[k]; var ever = grp.some(accepted);
      return { s: grp[0], meta: grp.length + " attempts · " + (ever ? "eventually accepted" : "not yet accepted") };
    });
    renderList("repeats", repeats, "No problem attempted more than once yet.");

    /* upcoming revisions */
    renderRevisions();

    /* session log */
    renderLog();
  }

  function renderList(id, items, emptyMsg) {
    var c = $(id); c.innerHTML = "";
    if (!items.length) { c.innerHTML = '<p class="muted">' + emptyMsg + '</p>'; return; }
    items.slice(0, 12).forEach(function (it) {
      var s = it.s;
      c.appendChild(el("div", { class: "item" }, [
        el("a", { href: s.url || "#", target: "_blank", rel: "noopener", text: s.title || U.titleFromSlug(s.slug) }),
        el("span", { class: "tag", text: it.meta }),
        el("span", { class: "when", text: fmtDate(endTs(s)) })
      ]));
    });
  }

  function renderRevisions() {
    var c = $("revisions"); c.innerHTML = "";
    var now = Date.now(), soon = now + 21 * 86400000, due = [];
    sessions.forEach(function (s) {
      S.REMINDER_DAYS.forEach(function (day) {
        var when = endTs(s) + day * 86400000;
        if (when <= soon) due.push({ s: s, when: when, day: day, overdue: when < now });
      });
    });
    due.sort(function (a, b) { return a.when - b.when; });
    if (!due.length) { c.innerHTML = '<p class="muted">Nothing scheduled in the next 3 weeks.</p>'; return; }
    due.slice(0, 20).forEach(function (r) {
      var when = new Date(r.when);
      var rel = r.overdue ? "overdue" : (r.when - now < 86400000 ? "due" : "");
      c.appendChild(el("div", { class: "item" }, [
        el("a", { href: r.s.url || "#", target: "_blank", rel: "noopener", text: r.s.title || U.titleFromSlug(r.s.slug) }),
        el("span", { class: "tag", text: "+" + r.day + "d" }),
        rel ? el("span", { class: "tag " + rel, text: rel }) : null,
        el("span", { class: "when", text: fmtDate(r.when) })
      ]));
    });
  }

  function renderLog() {
    var c = $("log"); c.innerHTML = "";
    sessions.forEach(function (s) {
      var sc = scoreOf(s);
      var row = el("div", { class: "log-row" });
      var head = el("div", { class: "log-head" }, [
        el("span", { class: "pname" }, [el("a", { href: s.url || "#", target: "_blank", rel: "noopener", text: s.title || U.titleFromSlug(s.slug) })]),
        el("span", { class: "tag " + (s.difficulty || "").toLowerCase(), text: s.difficulty || "—" }),
        el("span", { class: "mode", text: (S.MODES.find(function (m) { return m.id === s.mode; }) || {}).label || s.mode }),
        el("span", { class: "dur", text: U.fmtMinutes(s.durationMs || 0) }),
        el("span", { class: "out", text: accepted(s) ? "Accepted" : (s.reflection && s.reflection.outcome) || "—" }),
        el("span", { class: "score", text: sc ? Math.round(sc.total) + "/" + sc.assessedMax : "—" })
      ]);
      head.addEventListener("click", function (e) { if (e.target.tagName === "A") return; row.classList.toggle("open"); });
      row.appendChild(head);
      row.appendChild(buildDetail(s, sc));
      c.appendChild(row);
    });
  }

  function buildDetail(s, sc) {
    var d = el("div", { class: "log-detail" });
    d.appendChild(el("div", {}, [el("span", { class: "muted", text: fmtDate(endTs(s)) + " · active " + U.fmtMinutes(s.activeMs || 0) + " · " + (s.metrics ? s.metrics.editEvents : 0) + " edits · " + (s.metrics ? (s.metrics.pastes || []).length : 0) + " pastes" })]));
    if (sc) {
      d.appendChild(el("h4", { text: "Score breakdown (" + sc.total + "/" + sc.assessedMax + " assessed" + (sc.notAssessed.length ? "; not assessed: " + sc.notAssessed.join(", ") : "") + ")" }));
      sc.breakdown.forEach(function (b) {
        d.appendChild(el("div", { class: "sb-row" }, [
          el("span", { text: b.label }),
          el("span", { class: "basis " + b.basis.replace(/[^a-z]/g, ""), text: b.basis }),
          el("span", { class: "pts", text: b.notAssessed ? "n/a" : (b.points + "/" + b.max) })
        ]));
        d.appendChild(el("div", { class: "detail-txt", text: b.detail }));
      });
    }
    if (s.plan && (s.plan.optimized || s.plan.observations)) {
      d.appendChild(el("h4", { text: "Your plan" }));
      ["observations", "bruteForce", "optimized", "timeComplexity", "spaceComplexity"].forEach(function (k) {
        if (s.plan[k]) d.appendChild(el("div", { class: "detail-txt", text: k + ": " + s.plan[k] }));
      });
    }
    if (s.reflection && (s.reflection.explanation || s.reflection.edgeCases)) {
      d.appendChild(el("h4", { text: "Your reflection" }));
      if (s.reflection.edgeCases) d.appendChild(el("div", { class: "detail-txt", text: "Edge cases: " + s.reflection.edgeCases }));
      if (s.reflection.explanation) d.appendChild(el("div", { class: "detail-txt", text: "Why it works: " + s.reflection.explanation }));
    }
    return d;
  }

  /* ---------- export / reset ---------- */
  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = el("a", { href: url, download: name });
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }
  function exportCsv() {
    var head = ["date", "slug", "title", "difficulty", "mode", "outcome", "accepted", "durationMin", "activeMin", "approachMin",
      "editEvents", "pastes", "externalPastes", "submissions", "scoreTotal", "assessedMax",
      "solvedWithoutHints", "usedExternalHelp", "canReproduce", "canExplain"];
    var rows = [head];
    sessions.forEach(function (s) {
      var sc = scoreOf(s), m = s.metrics || {}, r = s.reflection || {};
      rows.push([
        new Date(endTs(s)).toISOString(), s.slug, s.title, s.difficulty, s.mode, r.outcome || "", accepted(s),
        ((s.durationMs || 0) / 60000).toFixed(1), ((s.activeMs || 0) / 60000).toFixed(1), s.approachMs != null ? (s.approachMs / 60000).toFixed(1) : "",
        m.editEvents || 0, (m.pastes || []).length, (m.pastes || []).filter(function (p) { return p.classification === "external"; }).length,
        (m.submissions || []).length, sc ? sc.total : "", sc ? sc.assessedMax : "",
        r.solvedWithoutHints, r.usedExternalHelp, r.canReproduce, r.canExplain
      ]);
    });
    download("leetcode-coach-" + U.todayKey() + ".csv", U.toCSV(rows), "text/csv");
  }
  function exportJson() {
    store.exportAll().then(function (data) { download("leetcode-coach-" + U.todayKey() + ".json", JSON.stringify(data, null, 2), "application/json"); });
  }

  $("exCsv").addEventListener("click", exportCsv);
  $("exJson").addEventListener("click", exportJson);
  $("reset").addEventListener("click", function () {
    if (!window.confirm("Delete ALL coach data (sessions + settings) on this browser? This cannot be undone.")) return;
    store.reset().then(function () { sessions = []; render(); });
  });

  /* boot + live refresh when storage changes elsewhere */
  function boot() { store.getSessions().then(function (list) { sessions = list || []; render(); }); }
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === "local" && (changes[S.KEYS.sessions] || changes[S.KEYS.active])) boot();
    });
  } catch (e) {}
  boot();
})();
