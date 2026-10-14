/* util.js — small shared helpers. Classic script; attaches to window.LCC.
   Loaded in content scripts, popup, dashboard, and (via importScripts) the
   service worker. No imports, no external dependencies. */
(function (root) {
  "use strict";
  var LCC = (root.LCC = root.LCC || {});

  var util = {
    /** RFC4122-ish id; crypto.randomUUID where available. */
    uuid: function () {
      if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
      return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    },

    nowISO: function () { return new Date().toISOString(); },
    todayKey: function (d) { d = d || new Date(); return d.toISOString().slice(0, 10); },

    clamp: function (n, lo, hi) { return Math.max(lo, Math.min(hi, n)); },

    /** Format milliseconds as H:MM:SS or M:SS. */
    fmtDuration: function (ms) {
      if (!ms || ms < 0) ms = 0;
      var s = Math.floor(ms / 1000);
      var h = Math.floor(s / 3600);
      var m = Math.floor((s % 3600) / 60);
      var sec = s % 60;
      var pad = function (n) { return (n < 10 ? "0" : "") + n; };
      return h > 0 ? h + ":" + pad(m) + ":" + pad(sec) : m + ":" + pad(sec);
    },

    /** "2.4 min" style, for dashboards. */
    fmtMinutes: function (ms) {
      if (!ms || ms < 0) return "0 min";
      var min = ms / 60000;
      return (min < 10 ? min.toFixed(1) : Math.round(min)) + " min";
    },

    /** Trailing-edge debounce. */
    debounce: function (fn, wait) {
      var t = null;
      return function () {
        var ctx = this, args = arguments;
        if (t) clearTimeout(t);
        t = setTimeout(function () { t = null; fn.apply(ctx, args); }, wait);
      };
    },

    /** Pull a problem slug out of a LeetCode URL, or "" if not a problem page. */
    slugFromUrl: function (url) {
      try {
        var u = new URL(url);
        if (!/leetcode\.com$/.test(u.hostname.replace(/^www\./, ""))) return "";
        var m = u.pathname.match(/\/problems\/([^/]+)/);
        return m ? m[1] : "";
      } catch (e) { return ""; }
    },

    /** A title-cased label from a slug, as a fallback when the DOM title is missing. */
    titleFromSlug: function (slug) {
      return (slug || "").replace(/[-_]+/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    },

    /** Quote a CSV field per RFC 4180. */
    csvCell: function (v) {
      if (v == null) return "";
      var s = String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    },

    /** Build a CSV string from an array of row-arrays. */
    toCSV: function (rows) {
      return rows.map(function (r) { return r.map(util.csvCell).join(","); }).join("\r\n");
    }
  };

  LCC.util = util;
})(typeof self !== "undefined" ? self : this);
