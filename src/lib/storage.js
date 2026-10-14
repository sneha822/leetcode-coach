/* storage.js — thin promise wrapper over chrome.storage.local.
   The SAME extension storage area is shared by content scripts, popup,
   dashboard, and the service worker, so this is the single source of truth.
   Classic script → window.LCC.storage. Nothing here ever leaves the browser. */
(function (root) {
  "use strict";
  var LCC = (root.LCC = root.LCC || {});
  var K = LCC.schema.KEYS;
  var DEFAULTS = LCC.schema.DEFAULT_SETTINGS;

  function area() {
    // chrome.storage.local is available in every extension context.
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
      throw new Error("chrome.storage.local unavailable in this context");
    }
    return chrome.storage.local;
  }

  function get(key) {
    return new Promise(function (resolve, reject) {
      try {
        area().get(key, function (res) {
          var err = chrome.runtime && chrome.runtime.lastError;
          if (err) return reject(new Error(err.message));
          resolve(res ? res[key] : undefined);
        });
      } catch (e) { reject(e); }
    });
  }

  function set(key, value) {
    return new Promise(function (resolve, reject) {
      try {
        var obj = {}; obj[key] = value;
        area().set(obj, function () {
          var err = chrome.runtime && chrome.runtime.lastError;
          if (err) return reject(new Error(err.message));
          resolve(value);
        });
      } catch (e) { reject(e); }
    });
  }

  var storage = {
    getSettings: function () {
      return get(K.settings).then(function (s) {
        return Object.assign({}, DEFAULTS, s || {});
      });
    },
    setSettings: function (patch) {
      return storage.getSettings().then(function (s) {
        return set(K.settings, Object.assign({}, s, patch || {}));
      });
    },

    getActive: function () { return get(K.active).then(function (a) { return a || null; }); },
    setActive: function (session) { return set(K.active, session); },
    clearActive: function () { return set(K.active, null); },

    getSessions: function () { return get(K.sessions).then(function (a) { return Array.isArray(a) ? a : []; }); },

    /** Append a finished session (most-recent-first). */
    addSession: function (session) {
      return storage.getSessions().then(function (list) {
        list.unshift(session);
        return set(K.sessions, list).then(function () { return session; });
      });
    },

    /** Merge a patch into a stored session by id. */
    updateSession: function (id, patch) {
      return storage.getSessions().then(function (list) {
        var i = list.findIndex(function (s) { return s.id === id; });
        if (i < 0) return null;
        list[i] = Object.assign({}, list[i], patch);
        return set(K.sessions, list).then(function () { return list[i]; });
      });
    },

    deleteSession: function (id) {
      return storage.getSessions().then(function (list) {
        return set(K.sessions, list.filter(function (s) { return s.id !== id; }));
      });
    },

    /** Wipe everything this extension stores. */
    reset: function () {
      return Promise.all([set(K.active, null), set(K.sessions, []), set(K.settings, {})]);
    },

    /** Full export payload (settings + all sessions). */
    exportAll: function () {
      return Promise.all([storage.getSettings(), storage.getSessions()]).then(function (r) {
        return { exportedAt: new Date().toISOString(), schemaVersion: LCC.schema.VERSION, settings: r[0], sessions: r[1] };
      });
    }
  };

  LCC.storage = storage;
})(typeof self !== "undefined" ? self : this);
