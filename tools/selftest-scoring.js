/* selftest-scoring.js — runs the real scoring engine (src/lib) under Node to
   verify the transparent-scoring invariants without a browser.
   Run: node tools/selftest-scoring.js   (exit code 0 = all passed) */
global.self = global; // so the IIFEs attach LCC to the shared global
require("../src/lib/util.js");
require("../src/lib/schema.js");
require("../src/lib/scoring.js");
const { schema: S, scoring } = global.LCC;

let failures = 0;
function assert(cond, msg) { if (!cond) { failures++; console.error("  ✗ " + msg); } else { console.log("  ✓ " + msg); } }

function base(over) {
  const s = S.newSession({ slug: "two-sum", title: "Two Sum", difficulty: "Medium", mode: "independent" });
  return Object.assign(s, over || {});
}

/* 1) Strong independent solve: full plan, accepted after one failure, full reflection. */
(function () {
  console.log("\nScenario 1 — strong independent solve");
  const s = base();
  s.plan = { observations: "hash complement", bruteForce: "n^2 pairs", optimized: "one-pass hash map", timeComplexity: "O(n)", spaceComplexity: "O(n)" };
  s.planSavedAt = s.startedAt + 120000;
  s.metrics.editorAvailable = true;
  s.metrics.editEvents = 60; s.metrics.keystrokes = 300;
  s.metrics.submissions = [
    { ts: 1, verdict: "Wrong Answer", passed: 10, total: 16 },
    { ts: 2, verdict: "Accepted", passed: 16, total: 16, runtimeMs: 52 }
  ];
  s.reflection = { outcome: "accepted", solvedWithoutHints: true, usedExternalHelp: false, canReproduce: true, canExplain: true, edgeCases: "empty array, duplicates, no solution", explanation: "We store each number's complement as we scan; a match means we found the pair in one pass, which is why it is linear time." };
  const r = scoring.scoreSession(s);
  console.log("  total=" + r.total + "/" + r.assessedMax + " notAssessed=" + JSON.stringify(r.notAssessed));
  assert(r.notAssessed.length === 0, "all six categories assessed");
  const deb = r.breakdown.find(b => b.key === "debugging");
  assert(deb.points === 15 && deb.basis === "observed", "debugging = 15 (recovered from failure), observed");
  assert(r.total >= 80, "high total for a strong solve (" + r.total + ")");
})();

/* 2) Sparse: no plan, no reflection, no editor data → mostly not-assessed. */
(function () {
  console.log("\nScenario 2 — sparse (no evidence)");
  const s = base({ mode: "independent" });
  s.metrics.editorAvailable = false;
  const r = scoring.scoreSession(s);
  console.log("  total=" + r.total + "/" + r.assessedMax + " notAssessed=" + JSON.stringify(r.notAssessed));
  assert(r.notAssessed.length >= 4, "at least 4 categories not assessed (got " + r.notAssessed.length + ")");
  assert(r.breakdown.every(b => b.points <= b.max), "no category exceeds its max");
})();

/* 3) Assisted: review mode, external paste, accepted first try, partial reflection. */
(function () {
  console.log("\nScenario 3 — assisted (editorial + external paste)");
  const s = base({ mode: "review" });
  s.metrics.editorAvailable = true;
  s.metrics.editEvents = 8;
  s.metrics.pastes = [{ id: "p1", ts: 1, chars: 800, classification: "external" }];
  s.metrics.largestPasteChars = 800;
  s.metrics.submissions = [{ ts: 1, verdict: "Accepted", passed: 16, total: 16, runtimeMs: 40 }];
  s.reflection = { outcome: "accepted", solvedWithoutHints: false, usedExternalHelp: true, canReproduce: false, canExplain: false, edgeCases: "", explanation: "" };
  const r = scoring.scoreSession(s);
  console.log("  total=" + r.total + "/" + r.assessedMax);
  const proc = r.breakdown.find(b => b.key === "process");
  assert(proc.points <= 7, "process penalised for external paste (" + proc.points + "/15)");
  const appr = r.breakdown.find(b => b.key === "approach");
  assert(appr.points < 15, "approach low for review mode without plan (" + appr.points + "/30)");
  const deb = r.breakdown.find(b => b.key === "debugging");
  assert(deb.points === 10, "debugging = 10 (clean first-try accept, not penalised)");
})();

/* Invariant sweep across all three + a correctness-not-double-counted check. */
(function () {
  console.log("\nInvariants");
  const s = base();
  s.metrics.submissions = [{ ts: 1, verdict: "Accepted", passed: 16, total: 16 }];
  // only passing tests, no edge-case reasoning → correctness must NOT be full 20
  s.reflection = S.newReflection(); s.reflection.outcome = "accepted";
  const r = scoring.scoreSession(s);
  const corr = r.breakdown.find(b => b.key === "correctness");
  assert(corr.points <= 12, "correctness not full just for passing tests (" + corr.points + "/20)");
  r.breakdown.forEach(b => assert(b.points >= 0 && b.points <= b.max, b.key + " within [0," + b.max + "]"));
})();

console.log("\n" + (failures ? (failures + " CHECK(S) FAILED") : "ALL CHECKS PASSED"));
process.exit(failures ? 1 : 0);
