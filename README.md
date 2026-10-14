# LeetCode Independent-Solving Coach

A Manifest V3 Chrome extension that helps you practise LeetCode **independently**:
it runs focus sessions, prompts you to plan before you code, observes your
coding process where the editor allows, asks you to reflect honestly afterwards,
and produces a **transparent, explainable score** — one that separates what the
extension actually *observed* from what you *self-reported*, and shows
"not assessed" instead of inventing numbers.

It is deliberately **not** a cheating detector. Pasting, autocomplete, and speed
are ambiguous and are never treated as proof of dishonesty. Everything is stored
locally; nothing is ever sent to a server.

---

## What is implemented, and what is tested

| Area | Status |
|---|---|
| Focus sessions (start/pause/resume/end, timer, mode, per-problem record) | Implemented. Logic unit-covered; **UI needs a manual run in Chrome** (see test plan). |
| Pre-session plan + post-session reflection (self-assessment) | Implemented; UI needs a manual run. |
| Transparent scoring (6 categories, observed vs self-reported, "not assessed") | Implemented **and tested** via `tools/selftest-scoring.js` (run under Node). |
| Local storage (`chrome.storage.local`), shared across popup/content/dashboard | Implemented. |
| Dashboard (stats, SVG charts, upcoming revisions, session log) | Implemented; renders from stored sessions. Needs a manual run to confirm visuals. |
| CSV / JSON export, full reset | Implemented. |
| Revision reminders at 1 / 3 / 7 / 14 days (`chrome.alarms` + notifications) | Implemented; needs a manual run to confirm notifications fire. |
| Editor tracking — edit activity, large pastes, submission outcomes, attempt diffs | Implemented against the **current** Monaco editor + submission-poll endpoint (investigated live on 2026-10). **Not yet verified on a logged-in account** — I can't submit as you. Degrades to "not assessed" if LeetCode changes. |

I have **not** run the full extension inside a logged-in Chrome profile, so I am
not claiming the editor/submission hooks work end-to-end on your account until
you run the test plan below. Everything else (manifest validity, all script
syntax, and the scoring math) has been checked.

---

## How the editor tracking works (and why it may break)

Investigated directly on `leetcode.com/problems/two-sum` (Oct 2026):

- The editor is **Monaco** and the page exposes `window.monaco`. The most
  reliable way to observe edits and pastes is a `world: "MAIN"` content script
  (`src/content/inject.js`) that attaches `model.onDidChangeContent`. A single
  change with a large inserted-text length is a paste; many small changes are
  typing. (DOM scraping is unreliable — Monaco only renders visible lines.)
- Submission verdicts arrive via polled `GET .../submissions/detail/<id>/check/`
  JSON (`status_msg`, `total_correct`, `total_testcases`, `status_runtime`,
  `status_memory`). `inject.js` patches `fetch` and `XMLHttpRequest` to read
  those responses and forwards only the verdict/counts — never your code — to the
  content script.
- The injected script **stores nothing and sends nothing off-device**. It posts
  same-window messages to `content.js`, which relays summarised events to the
  background worker.

Because this depends on LeetCode internals, it can break if they restructure the
page or the submission API. When that happens the overlay shows a red dot and the
dashboard shows "not assessed" rather than fabricating metrics.

---

## Install (load unpacked)

1. Open **`chrome://extensions`** in Chrome (or any Chromium browser, v111+ — the
   `world: "MAIN"` content script needs Chrome 111 or newer).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this **`leetcode-coach/`** folder (the one
   containing `manifest.json`).
4. Pin the extension (puzzle-piece icon → pin) so the toolbar button is visible.
5. Open a problem, e.g. `https://leetcode.com/problems/two-sum/`. A **◆ Coach**
   panel appears bottom-right, and the toolbar popup lets you start a session.

No build step, no backend, no npm install. (Icons were generated with
`node tools/generate-icons.js`; you only need to re-run that if you change them.)

---

## Using it

1. On a problem page, click the toolbar button (or the overlay) and **Start a
   focus session**, choosing a mode: *Independent*, *Hints allowed*, or
   *Editorial / review*.
2. A **plan prompt** appears (for solving modes): jot your observations,
   brute-force idea, intended optimisation, and expected time/space. You can skip
   it, but the plan is what powers the "approach" score.
3. Code. The overlay shows a timer, approximate edit activity, paste count, and
   submission count. If you paste a large block you'll get a gentle prompt to
   classify it as *your refactor*, a *template*, or *external help* — only
   "external help" affects the score.
4. Click **End** → a **reflection** asks whether you solved it without hints,
   used external help, can reproduce it, can explain it, plus edge cases and a
   short explanation.
5. You get an **explainable score**; open the **dashboard** for trends, difficulty
   breakdown, debugging patterns, re-attempted problems, upcoming revisions, and
   export.

---

## Scoring (out of 100, transparent)

| Category | Max | Mostly from |
|---|---|---|
| Independent approach development | 30 | plan completeness + mode (observed) + "solved without hints" (self-reported) |
| Code development process | 15 | observed edit activity; reduced only by a paste *you* marked external |
| Correctness & edge-case handling | 20 | observed accept/attempt **plus** self-reported edge-case reasoning (never full for passing alone) |
| Complexity analysis | 10 | stated complexity (observed presence) + self-reported understanding |
| Debugging & recovery | 15 | observed submissions (failed→accepted = full; clean first try = 10; not penalised) |
| Explanation quality | 10 | your written explanation (self-reported) |

Each category reports its **basis** (observed / self-reported / mixed / not
assessed) and a one-line **explanation** of how the points were derived. The
total is shown as `X / assessedMax`, and any unassessed categories are listed, so
the number is never inflated by guesses.

---

## Test plan (do this once in Chrome)

**Automated (already runnable now):**
```bash
node tools/selftest-scoring.js     # scoring invariants — should print ALL CHECKS PASSED
node tools/generate-icons.js       # (re)generate icons if needed
```

**Manual, in a logged-in Chrome:**
1. **Load & detect** — load unpacked; open `/problems/two-sum/`. Expect the ◆
   Coach overlay and, within a few seconds, a **green** editor dot (hover: "Editor
   tracking active"). A red dot means the Monaco hook didn't attach — note it.
2. **Session lifecycle** — Start (independent) → fill the plan → type code and
   watch *edits* climb → **Pause**/**Resume** (timer freezes/resumes) → **End**.
3. **Paste awareness** — paste ~10+ lines; expect the warning toast; classify it
   three different ways across runs and confirm only *External help* lowers the
   process score.
4. **Submission capture** — run and submit (both a wrong and an accepted
   attempt). Expect *submits* to increment and, after scoring, a non-empty
   "Debugging patterns" panel with a recovery count and runtime. *This is the hook
   most likely to need adjustment — if submits stay 0, see Troubleshooting.*
5. **Scoring & dashboard** — finish with a full reflection; confirm the score
   modal shows per-category basis labels; open the dashboard and verify tiles,
   weekly chart, difficulty rows, and the session log expands.
6. **Reminders** — temporarily shorten a reminder (edit `REMINDER_DAYS` in
   `src/lib/schema.js` to include a tiny value for a quick test, or use
   `chrome://extensions` → service worker → `chrome.alarms`), confirm a
   notification fires and clicking it opens the dashboard.
7. **Export / reset / privacy** — export CSV and JSON; confirm no code appears
   unless you enabled "Store my code"; reset and confirm the dashboard empties.

---

## Known limitations

- **Not a cheating detector.** It cannot verify self-reports, detect all AI use,
  or prove a paste's origin. It makes the honest/assisted distinction *your*
  call and labels every self-reported signal as such.
- **Editor/submission hooks are best-effort** and version-dependent on LeetCode.
  Contest pages, the old UI, and future redesigns may not be supported; the
  extension shows an understandable "unavailable" state instead of wrong numbers.
- **"Active coding time" is an approximation** (edit events expanded into short
  windows), not a precise measurement.
- **Topic/pattern analytics** are limited to **difficulty** (reliably read from
  the page). True per-pattern tags aren't available without a problem→pattern
  source, so the dashboard does not fabricate them.
- **One active session at a time.** Starting a new one while another is active
  returns the existing session; end it first (the popup can force-end).
- `window.print()` and other sandbox limits don't apply here (this is a real
  extension, not a web artifact), but Chrome **must be v111+** for the MAIN-world
  content script.

## Troubleshooting

- **Overlay doesn't appear:** confirm the URL matches `leetcode.com/problems/*`,
  reload the tab, and check `chrome://extensions` → the extension has no errors.
- **Editor dot is red / edits stay 0:** LeetCode likely changed the editor.
  Open DevTools console on the problem page and check for `window.monaco`. The
  attachment logic is in `src/content/inject.js` (`isCodeModel`, `tryAttach`).
- **Submits stay 0 after submitting:** the check-endpoint shape may have changed.
  In DevTools → Network, find the `.../check/` response and compare its fields to
  `handleCheck()` in `src/content/inject.js`; adjust the field names there.
- **No reminders:** ensure notifications are allowed for Chrome at the OS level
  and that "Revision reminders" is on in the popup settings.
- **Service worker inactive:** MV3 workers sleep; they wake on the next event.
  You can inspect it via `chrome://extensions` → "service worker".

## Privacy

- Permissions requested: `storage`, `alarms`, `notifications`, and host access to
  `leetcode.com` only. No `tabs`, `history`, `cookies`, or broad host access.
- Your code is **not stored** unless you turn on "Store my code snapshots" in
  settings; by default only diffs, lengths, and line counts are kept.
- Nothing is transmitted off your machine. Reset and export are always available.

## File map

```
leetcode-coach/
  manifest.json
  README.md
  src/
    lib/        util.js  schema.js  storage.js  scoring.js      (shared; window.LCC.*)
    content/    inject.js (MAIN world)  content.js (overlay/UI)  overlay.css
    background/ service-worker.js        (owns the session, scores, reminders)
    popup/      popup.html  popup.css  popup.js
    dashboard/  dashboard.html  dashboard.css  dashboard.js
    icons/      icon16.png  icon48.png  icon128.png
  tools/        generate-icons.js  selftest-scoring.js
```
