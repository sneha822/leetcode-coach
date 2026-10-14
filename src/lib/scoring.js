/* scoring.js — transparent, explainable session scoring. window.LCC.scoring

   Design rules (from the product brief):
   - Separate OBSERVED behaviour from SELF-REPORTED claims. Every category says
     which it used.
   - When evidence is insufficient, return "not assessed" instead of inventing
     a number. The total is out of the sum of ASSESSED maxima, and we also show
     how many points were not assessed.
   - Never award points merely for passing test cases; a self-derived but
     incorrect solution can still score on reasoning, debugging, and explanation.
   - Pasting / autocomplete / speed are NOT treated as proof of cheating. A
     large paste only affects the score if the USER classifies it as external
     assistance.
*/
(function (root) {
  "use strict";
  var LCC = (root.LCC = root.LCC || {});
  var SCORING = LCC.schema.SCORING;

  function byKey(k) { for (var i = 0; i < SCORING.length; i++) if (SCORING[i].key === k) return SCORING[i]; return { max: 0, label: k }; }
  function filled(s) { return typeof s === "string" && s.trim().length > 0; }
  function round(n) { return Math.round(n * 10) / 10; }

  // Each scorer returns { points, max, basis, detail } or { notAssessed:true, max, basis:'not assessed', detail }.
  var NA = function (key, detail) { return { key: key, label: byKey(key).label, max: byKey(key).max, notAssessed: true, basis: "not assessed", points: 0, detail: detail }; };
  var R = function (key, points, basis, detail) {
    var max = byKey(key).max;
    return { key: key, label: byKey(key).label, max: max, points: LCC.util.clamp(round(points), 0, max), basis: basis, detail: detail };
  };

  function scoreApproach(s) {
    var plan = s.plan || {};
    var refl = s.reflection || {};
    var planFields = ["observations", "bruteForce", "optimized", "timeComplexity", "spaceComplexity"];
    var planDone = planFields.filter(function (f) { return filled(plan[f]); }).length;
    var hasPlan = planDone > 0;
    var hasRefl = refl.solvedWithoutHints !== null;
    if (!hasPlan && !hasRefl) return NA("approach", "No pre-session plan recorded and no reflection answered.");

    // Observed: plan completeness (up to 12) + chosen mode (up to 8).
    var planPts = (planDone / planFields.length) * 12;
    var modePts = s.mode === "independent" ? 8 : s.mode === "hints" ? 4 : 0;
    // Self-reported: solved without hints (up to 10).
    var selfPts = refl.solvedWithoutHints === true ? 10 : (refl.solvedWithoutHints === false ? 2 : 0);

    var basis = hasPlan && hasRefl ? "mixed" : hasPlan ? "observed" : "self-reported";
    var detail = "Plan: " + planDone + "/5 fields → " + round(planPts) + "/12 (observed). " +
      "Mode \"" + s.mode + "\" → " + modePts + "/8 (observed). " +
      (hasRefl ? ("Self-reported solved without hints: " + refl.solvedWithoutHints + " → " + selfPts + "/10.") : "Reflection not answered → 0/10.");
    return R("approach", planPts + modePts + selfPts, basis, detail);
  }

  function scoreProcess(s) {
    var m = s.metrics || {};
    var hasEditorData = m.editorAvailable === true && (m.editEvents > 0 || (m.submissions && m.submissions.length));
    if (!hasEditorData) return NA("process", "Editor activity could not be observed (editor hooks unavailable or no edits captured).");

    // Start from full credit for showing real editing activity, then adjust.
    var pts = 15;
    var notes = [];
    if (m.editEvents < 5) { pts -= 6; notes.push("very few edit events (" + m.editEvents + ") — little in-editor building observed (-6)"); }
    else { notes.push(m.editEvents + " edit events observed"); }

    // Only an EXTERNAL-classified paste reduces process credit; refactor/template do not.
    var externalPaste = (m.pastes || []).some(function (p) { return p.classification === "external"; });
    if (externalPaste) { pts -= 8; notes.push("a paste was classified by you as external assistance (-8)"); }

    return R("process", pts, "observed", notes.join("; ") + ".");
  }

  function scoreCorrectness(s) {
    var m = s.metrics || {};
    var refl = s.reflection || {};
    var subs = m.submissions || [];
    var sawSubmissions = m.editorAvailable === true || subs.length > 0 || refl.outcome;
    if (!sawSubmissions) return NA("correctness", "No submission outcome observed and no outcome reported.");

    // Observed acceptance (max 10) — NOT the whole score.
    var accepted = subs.some(function (x) { return x.verdict === "Accepted"; }) || refl.outcome === "accepted";
    var attempted = subs.length > 0 || refl.outcome === "attempted";
    var accPts = accepted ? 10 : (attempted ? 3 : 0);

    // Self-reported edge-case reasoning (max 10).
    var edgePts = 0, edgeBasis = "none";
    if (filled(refl.edgeCases)) { edgePts += 6; edgeBasis = "edge cases described"; }
    if (refl.canExplain === true) { edgePts += 4; edgeBasis += (edgeBasis === "none" ? "" : " + ") + "can explain why it works"; }
    edgePts = Math.min(edgePts, 10);

    var detail = (accepted ? "Accepted outcome observed/reported → 10/10." : attempted ? "Attempted, not accepted → 3/10 (reasoning still credited elsewhere)." : "No accepted/attempted outcome → 0/10.") +
      " Edge-case reasoning (self-reported): " + edgeBasis + " → " + edgePts + "/10.";
    return R("correctness", accPts + edgePts, subs.length ? "mixed" : "self-reported", detail);
  }

  function scoreComplexity(s) {
    var plan = s.plan || {};
    var refl = s.reflection || {};
    var hasPlanCx = filled(plan.timeComplexity) || filled(plan.spaceComplexity);
    var hasRefl = refl.canExplain !== null;
    if (!hasPlanCx && !hasRefl) return NA("complexity", "No complexity stated in the plan and no reflection answered.");

    var planPts = (filled(plan.timeComplexity) ? 2.5 : 0) + (filled(plan.spaceComplexity) ? 2.5 : 0); // up to 5, observed presence
    var selfPts = refl.canExplain === true ? 5 : 0; // up to 5, self-reported
    var detail = "Stated complexity in plan: time=" + (filled(plan.timeComplexity) ? "\"" + plan.timeComplexity + "\"" : "—") +
      ", space=" + (filled(plan.spaceComplexity) ? "\"" + plan.spaceComplexity + "\"" : "—") + " → " + planPts + "/5 (observed presence, not verified). " +
      "Self-reported can explain complexity: " + (refl.canExplain === true) + " → " + selfPts + "/5.";
    return R("complexity", planPts + selfPts, hasPlanCx && hasRefl ? "mixed" : hasPlanCx ? "observed" : "self-reported", detail);
  }

  function scoreDebugging(s) {
    var subs = (s.metrics && s.metrics.submissions) || [];
    if (!subs.length) return NA("debugging", "No submissions observed, so debugging/recovery can't be assessed.");

    var firstAccepted = subs.findIndex(function (x) { return x.verdict === "Accepted"; });
    var fails = subs.filter(function (x) { return x.verdict && x.verdict !== "Accepted"; }).length;
    var pts, detail;
    if (firstAccepted === 0) { pts = 10; detail = "Accepted on the first submission — clean, no debugging needed (10/15)."; }
    else if (firstAccepted > 0) { pts = 15; detail = "Recovered from " + fails + " failed submission(s) to an Accepted one — strong debugging (15/15)."; }
    else { pts = 6; detail = fails + " failed submission(s), not yet accepted — recovery attempted (6/15)."; }
    return R("debugging", pts, "observed", detail);
  }

  function scoreExplanation(s) {
    var refl = s.reflection || {};
    var hasRefl = refl.canExplain !== null || LCC.scoring._filled(refl.explanation);
    if (!hasRefl) return NA("explanation", "No explanation written and reflection not answered.");
    var len = (refl.explanation || "").trim().length;
    var writePts = len >= 240 ? 6 : len >= 80 ? 4 : len > 0 ? 2 : 0;
    var claimPts = refl.canExplain === true ? 4 : 0;
    var detail = "Written explanation length " + len + " chars → " + writePts + "/6 (self-reported). " +
      "Claimed can explain: " + (refl.canExplain === true) + " → " + claimPts + "/4.";
    return R("explanation", writePts + claimPts, "self-reported", detail);
  }

  var scoring = {
    _filled: filled,
    scoreSession: function (s) {
      var parts = [
        scoreApproach(s), scoreProcess(s), scoreCorrectness(s),
        scoreComplexity(s), scoreDebugging(s), scoreExplanation(s)
      ];
      var total = 0, assessedMax = 0, notAssessed = [];
      parts.forEach(function (p) {
        if (p.notAssessed) { notAssessed.push(p.label); }
        else { total += p.points; assessedMax += p.max; }
      });
      return {
        total: round(total),
        assessedMax: assessedMax,
        fullMax: 100,
        notAssessed: notAssessed,
        breakdown: parts,
        computedAt: Date.now()
      };
    }
  };

  LCC.scoring = scoring;
})(typeof self !== "undefined" ? self : this);
