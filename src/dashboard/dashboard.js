/* dashboard.js — reads all sessions from chrome.storage.local and renders
   stats, an activity heatmap, a donut, charts (inline SVG, no external
   libraries), upcoming revisions, and a problem-grouped log with per-attempt
   delete. Export to CSV/JSON and full reset are here too. */
(function () {
  "use strict";
  var U = window.LCC.util, S = window.LCC.schema, store = window.LCC.storage, scoring = window.LCC.scoring;
  var $ = function (id) { return document.getElementById(id); };
  var sessions = [];

  /* ---------- derived helpers ---------- */
  function scoreOf(s) { return s.scored || (function () { try { return scoring.scoreSession(s); } catch (e) { return null; } })(); }
  function scorePct(s) { var sc = scoreOf(s); return sc && sc.assessedMax ? Math.round(sc.total / sc.assessedMax * 100) : null; }
  function accepted(s) {
    if (s.reflection && s.reflection.outcome === "accepted") return true;
    return (s.metrics && s.metrics.submissions || []).some(function (x) { return x.verdict === "Accepted"; });
  }
  function externalPaste(s) { return (s.metrics && s.metrics.pastes || []).some(function (p) { return p.classification === "external"; }); }
  function assisted(s) { return s.mode !== "independent" || (s.reflection && s.reflection.usedExternalHelp === true) || externalPaste(s); }
  function endTs(s) { return s.endedAt || s.createdAt || Date.now(); }
  function dayKey(ts) { var d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
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

  /* ---------- small SVG charts ---------- */
  function barChart(bars, opts) {
    opts = opts || {};
    var W = opts.width || 640, H = opts.height || 150, pad = 26, n = bars.length || 1;
    var gap = 8, bw = Math.max(6, (W - pad * 2 - gap * (n - 1)) / n);
    var max = Math.max(1, Math.max.apply(null, bars.map(function (b) { return b.value; })));
    var svg = ['<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg">'];
    bars.forEach(function (b, i) {
      var x = pad + i * (bw + gap), h = Math.round((b.value / max) * (H - pad * 2)), y = H - pad - h;
      svg.push('<rect x="' + x + '" y="' + y + '" width="' + bw + '" height="' + Math.max(h, 1) + '" rx="4" fill="' + (b.color || "#8b7bff") + '"/>');
      if (b.value) svg.push('<text class="bar-val" x="' + (x + bw / 2) + '" y="' + (y - 4) + '" text-anchor="middle">' + (b.valLabel != null ? b.valLabel : b.value) + '</text>');
      if (b.label) svg.push('<text class="bar-label" x="' + (x + bw / 2) + '" y="' + (H - pad + 13) + '" text-anchor="middle">' + b.label + '</text>');
    });
    svg.push('</svg>');
    return svg.join("");
  }

  function donut(a, b, labelA, labelB) {
    var total = a + b, r = 54, cx = 70, cy = 70, C = 2 * Math.PI * r, sw = 18;
    var fracA = total ? a / total : 0;
    var dashA = (fracA * C).toFixed(1) + " " + C.toFixed(1);
    var pct = total ? Math.round(fracA * 100) : 0;
    var svg = '<svg viewBox="0 0 140 140" width="140" height="140" xmlns="http://www.w3.org/2000/svg">' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="#e0b24f" stroke-width="' + sw + '"/>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="#4ec98a" stroke-width="' + sw + '" stroke-dasharray="' + dashA + '" transform="rotate(-90 ' + cx + ' ' + cy + ')" stroke-linecap="butt"/>' +
      '<text x="70" y="66" text-anchor="middle" font-size="26" font-weight="700" fill="#f1eef7">' + pct + '%</text>' +
      '<text x="70" y="86" text-anchor="middle" font-size="10" fill="#a9a3b8">independent</text></svg>';
    var legend = '<div class="legend">' +
      '<span><i class="sw ind"></i>' + labelA + ' <b>' + a + '</b></span>' +
      '<span><i class="sw ass"></i>' + labelB + ' <b>' + b + '</b></span></div>';
    return '<div class="donut">' + svg + legend + '</div>';
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
    sessions = dedupe(sessions);
    if (!sessions.length) { $("empty").hidden = false; $("content").hidden = true; return; }
    $("empty").hidden = true; $("content").hidden = false;

    var completed = sessions.filter(accepted).length;
    var indep = sessions.filter(function (s) { return !assisted(s); }).length;
    var approachTimes = sessions.map(function (s) { return s.approachMs; }).filter(function (x) { return typeof x === "number" && x >= 0; });
    var avgApproach = approachTimes.length ? approachTimes.reduce(function (a, b) { return a + b; }, 0) / approachTimes.length : null;
    var pcts = sessions.map(scorePct).filter(function (x) { return x != null; });
    var avgScore = pcts.length ? Math.round(pcts.reduce(function (a, b) { return a + b; }, 0) / pcts.length) : null;

    /* tiles */
    $("tiles").innerHTML = "";
    [
      ["Problems attempted", String(uniqueSlugs().length), sessions.length + " sessions total", "accent"],
      ["Completed", String(completed), Math.round(completed / sessions.length * 100) + "% of sessions", "ok"],
      ["Independent", String(indep), (sessions.length - indep) + " assisted", "ind"],
      ["Avg score", avgScore != null ? avgScore + "%" : "—", "assessed points", "accent"],
      ["Avg time to approach", avgApproach != null ? U.fmtMinutes(avgApproach) : "—", approachTimes.length ? "across " + approachTimes.length : "add plans", "soft"]
    ].forEach(function (t) {
      $("tiles").appendChild(el("div", { class: "tile tile-" + t[3] }, [
        el("b", { text: t[0] === "Avg score" || t[0] === "Avg time to approach" ? t[1] : t[1] }),
        el("span", { text: t[0] }), el("div", {}, [el("small", { text: t[2] })])
      ]));
    });

    renderHeatmap();
    renderStreak();

    /* donut: independent vs assisted */
    $("donut").innerHTML = donut(indep, sessions.length - indep, "Independent", "Assisted");

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
      if (!grp.length) return;
      var acc = grp.filter(accepted).length;
      var scs = grp.map(scorePct).filter(function (x) { return x != null; });
      var avg = scs.length ? Math.round(scs.reduce(function (a, b) { return a + b; }, 0) / scs.length) : 0;
      $("byDifficulty").appendChild(barRow(d + " (" + grp.length + ")", acc, grp.length, d.toLowerCase(), acc + "/" + grp.length + " accepted · avg " + avg + "%"));
    });
    if (!$("byDifficulty").children.length) $("byDifficulty").innerHTML = '<p class="muted">No difficulty data captured yet.</p>';

    /* debugging patterns */
    var withSubs = sessions.filter(function (s) { return (s.metrics && s.metrics.submissions || []).length > 0; });
    var multiSub = withSubs.filter(function (s) { return s.metrics.submissions.length > 1; });
    var recovered = multiSub.filter(function (s) { return s.metrics.submissions.findIndex(function (x) { return x.verdict === "Accepted"; }) > 0; });
    var rts = []; sessions.forEach(function (s) { (s.metrics && s.metrics.submissions || []).forEach(function (x) { if (x.verdict === "Accepted" && typeof x.runtimeMs === "number") rts.push(x.runtimeMs); }); });
    var avgRt = rts.length ? Math.round(rts.reduce(function (a, b) { return a + b; }, 0) / rts.length) : null;
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
    renderList("needHelp", help.sort(function (a, b) { return endTs(b) - endTs(a); }).map(function (s) {
      return { s: s, meta: s.mode !== "independent" ? ("mode: " + s.mode) : "external help" };
    }), "No hint/editorial sessions — all independent so far.");

    /* re-attempted problems */
    var groups = groupBySlug();
    var repeats = groups.filter(function (g) { return g.sessions.length > 1; }).map(function (g) {
      return { s: g.sessions[0], meta: g.sessions.length + " sessions · " + (g.anyAccepted ? "eventually accepted" : "not yet accepted") };
    });
    renderList("repeats", repeats, "No problem attempted more than once yet.");

    renderRevisions();
    renderLog(groups);
  }

  function dedupe(list) {
    var seen = {}, out = [];
    list.forEach(function (s) { if (!s || !s.id || seen[s.id]) return; seen[s.id] = 1; out.push(s); });
    return out;
  }
  function uniqueSlugs() { var set = {}; sessions.forEach(function (s) { set[s.slug] = 1; }); return Object.keys(set); }

  /* ---------- activity heatmap (last 12 weeks) ---------- */
  function renderHeatmap() {
    var host = $("heatmap"); host.innerHTML = "";
    var counts = {};
    sessions.forEach(function (s) { var k = dayKey(endTs(s)); counts[k] = (counts[k] || 0) + 1; });
    var max = Math.max.apply(null, [1].concat(Object.keys(counts).map(function (k) { return counts[k]; })));
    var today = new Date(); today.setHours(0, 0, 0, 0);
    // align to weeks: find the Sunday 11 weeks before this week's Sunday
    var startSun = new Date(today); startSun.setDate(today.getDate() - today.getDay() - 11 * 7);
    var grid = el("div", { class: "hm-grid" });
    for (var w = 0; w < 12; w++) {
      var col = el("div", { class: "hm-col" });
      for (var dy = 0; dy < 7; dy++) {
        var cur = new Date(startSun); cur.setDate(startSun.getDate() + w * 7 + dy);
        var k = cur.getTime();
        if (cur > today) { col.appendChild(el("div", { class: "hm-cell empty" })); continue; }
        var c = counts[k] || 0;
        var lvl = c === 0 ? 0 : c === 1 ? 1 : c === 2 ? 2 : c <= 4 ? 3 : 4;
        col.appendChild(el("div", { class: "hm-cell l" + lvl, title: c + " session" + (c === 1 ? "" : "s") + " · " + cur.toLocaleDateString() }));
      }
      grid.appendChild(col);
    }
    host.appendChild(grid);
    host.appendChild(el("div", { class: "hm-legend" }, [
      el("span", { text: "less" }),
      el("i", { class: "hm-cell l0" }), el("i", { class: "hm-cell l1" }), el("i", { class: "hm-cell l2" }),
      el("i", { class: "hm-cell l3" }), el("i", { class: "hm-cell l4" }),
      el("span", { text: "more" })
    ]));
  }

  function renderStreak() {
    var days = {}; sessions.forEach(function (s) { days[dayKey(endTs(s))] = 1; });
    var d = new Date(); d.setHours(0, 0, 0, 0);
    // allow the streak to count from today or yesterday
    if (!days[d.getTime()]) d.setDate(d.getDate() - 1);
    var streak = 0;
    while (days[d.getTime()]) { streak++; d.setDate(d.getDate() - 1); }
    $("streak").textContent = streak > 0 ? "🔥 " + streak + "-day streak" : "No active streak";
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
      var rel = r.overdue ? "overdue" : (r.when - now < 86400000 ? "due" : "");
      c.appendChild(el("div", { class: "item" }, [
        el("a", { href: r.s.url || "#", target: "_blank", rel: "noopener", text: r.s.title || U.titleFromSlug(r.s.slug) }),
        el("span", { class: "tag", text: "+" + r.day + "d" }),
        rel ? el("span", { class: "tag " + rel, text: rel }) : null,
        el("span", { class: "when", text: fmtDate(r.when) })
      ]));
    });
  }

  /* ---------- grouped problem log ---------- */
  function groupBySlug() {
    var map = {};
    sessions.forEach(function (s) {
      var g = map[s.slug] || (map[s.slug] = { slug: s.slug, title: s.title, url: s.url, difficulty: s.difficulty, sessions: [] });
      g.sessions.push(s);
      if (s.title && !g.title) g.title = s.title;
    });
    var groups = Object.keys(map).map(function (k) {
      var g = map[k];
      g.sessions.sort(function (a, b) { return endTs(b) - endTs(a); });
      g.latest = endTs(g.sessions[0]);
      g.anyAccepted = g.sessions.some(accepted);
      g.anyAssisted = g.sessions.some(assisted);
      var ps = g.sessions.map(scorePct).filter(function (x) { return x != null; });
      g.bestScore = ps.length ? Math.max.apply(null, ps) : null;
      return g;
    });
    groups.sort(function (a, b) { return b.latest - a.latest; });
    return groups;
  }

  function renderLog(groups) {
    var c = $("log"); c.innerHTML = "";
    groups.forEach(function (g) {
      var row = el("div", { class: "log-row" });
      var head = el("div", { class: "log-head" }, [
        el("span", { class: "caret", text: "▸" }),
        el("span", { class: "pname" }, [el("a", { href: g.url || "#", target: "_blank", rel: "noopener", text: g.title || U.titleFromSlug(g.slug) })]),
        el("span", { class: "tag " + (g.difficulty || "").toLowerCase(), text: g.difficulty || "—" }),
        el("span", { class: "attempts", text: g.sessions.length + "×" }),
        g.anyAccepted ? el("span", { class: "tag ok", text: "✓ accepted" }) : el("span", { class: "tag", text: "open" }),
        el("span", { class: "best", text: g.bestScore != null ? "best " + g.bestScore + "%" : "—" }),
        el("span", { class: "when", text: fmtDate(g.latest) })
      ]);
      head.addEventListener("click", function (e) { if (e.target.tagName === "A") return; row.classList.toggle("open"); });
      row.appendChild(head);
      var body = el("div", { class: "log-detail" });
      g.sessions.forEach(function (s) { body.appendChild(attemptCard(s)); });
      row.appendChild(body);
      c.appendChild(row);
    });
  }

  function attemptCard(s) {
    var sc = scoreOf(s), m = s.metrics || {};
    var card = el("div", { class: "attempt" });
    var head = el("div", { class: "attempt-head" }, [
      el("span", { class: "a-date", text: fmtDate(endTs(s)) }),
      el("span", { class: "tag", text: (S.MODES.find(function (x) { return x.id === s.mode; }) || {}).label || s.mode }),
      el("span", { class: "a-dur", text: U.fmtMinutes(s.durationMs || 0) }),
      el("span", { class: "a-out", text: accepted(s) ? "Accepted" : (s.reflection && s.reflection.outcome) || "—" }),
      el("span", { class: "a-score", text: sc ? Math.round(sc.total) + "/" + sc.assessedMax : "—" }),
      el("button", { class: "del", title: "Delete this attempt", text: "🗑", onclick: function (e) {
        e.stopPropagation();
        var b = e.currentTarget;
        if (b.dataset.confirm) { store.deleteSession(s.id).then(boot); }
        else { b.dataset.confirm = "1"; b.textContent = "sure?"; b.classList.add("confirm"); setTimeout(function () { b.textContent = "🗑"; b.classList.remove("confirm"); delete b.dataset.confirm; }, 2500); }
      } })
    ]);
    card.appendChild(head);
    if (sc) {
      var sub = el("div", { class: "a-breakdown" });
      sc.breakdown.forEach(function (bk) {
        sub.appendChild(el("div", { class: "sb-row" }, [
          el("span", { text: bk.label }),
          el("span", { class: "basis " + bk.basis.replace(/[^a-z]/g, ""), text: bk.basis }),
          el("span", { class: "pts", text: bk.notAssessed ? "n/a" : (bk.points + "/" + bk.max) })
        ]));
      });
      card.appendChild(sub);
      if (sc.notAssessed.length) card.appendChild(el("div", { class: "detail-txt", text: "Not assessed: " + sc.notAssessed.join(", ") }));
    }
    if (s.plan && (s.plan.optimized || s.plan.observations)) {
      card.appendChild(el("div", { class: "detail-txt", text: "Approach: " + (s.plan.optimized || s.plan.observations) + (s.plan.timeComplexity ? " · " + s.plan.timeComplexity : "") }));
    }
    if (s.reflection && s.reflection.explanation) card.appendChild(el("div", { class: "detail-txt", text: "Why it works: " + s.reflection.explanation }));
    return card;
  }

  /* ---------- export / reset ---------- */
  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime }), url = URL.createObjectURL(blob);
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
  function boot() { return store.getSessions().then(function (list) { sessions = list || []; render(); }); }
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      // Only react to finished-session changes; ignore the frequent active-session
      // heartbeat writes so the dashboard doesn't re-render every 15s.
      if (area === "local" && changes[S.KEYS.sessions]) boot();
    });
  } catch (e) {}
  boot();
})();
