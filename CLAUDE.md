# CLAUDE.md: notes for working on D2L Pull

D2L Pull downloads Brightspace (D2L) rosters and grades for the courses an instructor teaches,
pulls data from other platforms through **source add-ons**, and runs the instructor's own
**post-processor** on the files. The maintainer teaches at Portland Community College
(Brightspace at `online.pcc.edu`), but the tool must stay generic for any school and course.
`README.md` is the user guide and `docs/SOURCE_ADDONS.md` is the add-on API. Read both before
changing behaviour.

## Hard rules

- **Never commit, print or paste student data** (FERPA). That covers rosters, grades, names,
  usernames and emails, including in test fixtures, logs, commit messages and screenshots.
  `.gitignore` excludes `*.csv`. Use synthetic data for tests.
- **Never commit credentials**: session cookies, `jwt-*` tokens, API keys. The repo is meant to be
  public, and every version was scanned clean before publishing.
- **Don't enter credentials or log in for the user.** All site access goes through the
  instructor's own logged-in browser tab.
- **Read-only against live sites** unless the user approves a specific action. Generating
  reports on a platform (zyBooks, Red Hat Academy) creates records, so ask first.
- **Don't change the extension `key`s in any manifest.** They fix the extension IDs, which the
  add-on API and the native helper depend on:
  - core D2L Pull: `ilmegdpkffcmnhanlgciclmceidicbof`
  - CompTIA add-on: `hilmbhmdcipikhoaemnaipcodifaloan`
  - native host name: `com.mnaught.d2lpull`
- Commit messages: plain descriptions, no session links.
- Output files must stay **byte-identical** to the platform's own exports (headers, quoting,
  row order, CRLF where the platform uses it), so existing converters keep working. The D2L
  grades header was verified against a real Brightspace export, and the CompTIA files against
  real CertMaster exports.

## Layout

| Path | What |
|---|---|
| `chrome-extension/` | Core MV3 extension (v3.0.0). `background.js` service worker runs jobs; `popup.*`, `options.*`, `selector.js`, `ui.css` are the UI |
| `chrome-extension/lib/select.js` | Pick/Pattern selection rules (`apply`, `toggle`, `switchMode`, `suggestPattern`) |
| `chrome-extension/lib/config.js` | Settings model, `normalize`/`migrateV2`, course selection, `weeksSince`, `folderFor`, add-on `autoLink` |
| `chrome-extension/lib/d2l.js` | Brightspace API: `listCourses`, `courseInfo`, `pullCourse`, `d2lHeader` (runs inside the D2L tab) |
| `addons/comptia-certmaster/` | First source add-on, and the template for new ones |
| `native/` | Native messaging helper (`d2l_pull_host.py`) + installers for Windows/macOS/Linux |
| `d2l_pull.py` | CLI: same rules and output as the extension, D2L only, stdlib only |
| `d2l_pull.sh` | Legacy v2 bash script, kept for reference. Don't extend |

## How it works

- **Auth model:** nothing stores credentials. The core and add-ons find the user's open tab for a
  site (`chrome.tabs.query`) and `chrome.scripting.executeScript` a function into it, so requests
  use the page's own cookies or token. The core asks for host permission at runtime
  (`optional_host_permissions`). Each add-on holds host permissions for its own platform only.
- **D2L (Valence API):** `/d2l/api/versions/`, `lp/{v}/enrollments/myenrollments/` (paged by
  Bookmark, filtered to `Course Offering`), `le/{v}/{ou}/classlist/`, `…/grades/`,
  `…/grades/categories/`, `…/grades/{id}/values/` (paged by `Next`). Due dates come from
  `…/dropbox/folders/`, `…/quizzes/` and discussion topics, matched to grade items.
- **Selection rules:** `{mode: "pick"|"pattern", pattern, include:[{id,name}], exclude:[{id,name}]}`.
  Pattern mode selects regex matches plus include, minus exclude. Names are a fallback when IDs
  change in next term's course copy. `d2l_pull.py` implements the same rules, so keep them in sync.
- **Zero-fill:** a missing grade becomes 0 once the item's due date has passed (cutoff = now, or
  the end of "Through week" plus grace days). Each item can override this: auto, 0 or blank.
- **Add-on API v1:** messages `d2lpull/register`, `hello`, `status`, `classes` and `pull` over
  `chrome.runtime.sendMessage`. Add-ons return CSV text, and the core saves it. Add-on classes
  auto-link to D2L courses by a shared 4+ digit number (a CRN). The spec is `docs/SOURCE_ADDONS.md`.
- **Native helper v2:** the helper keeps its own list of approved commands in
  `%APPDATA%/D2LPull/commands.json` (or the platform equivalent). Adding or changing a command
  needs a native confirmation dialog. The extension sends only a command id plus file paths and
  values (no quotes or control characters). Steps are argument lists with `{placeholders}`. On
  Windows the console script is written as UTF-8 with `chcp 65001`, which fixed an mbcs crash on
  non-ASCII labels.
- **Post-processor fallback:** if a file wasn't downloaded this run, the last download in that
  folder is used.

## Platform status

Windows is in daily use, including the full download → post-processor → result file run. Linux
is tested. On macOS the extension should work, but the helper is untested (Tk/dialogs,
Terminal permissions). See the README table.

## Testing

There's no test suite in the repo yet. Changes so far were checked by:
- Running `select.js`/`config.js` logic in Node and the CLI against synthetic data.
- An end-to-end run in Chromium (Playwright) with both extensions loaded, mocked D2L/CompTIA
  APIs, and the real `convert.py` from CompTIA-D2L-Gradebook-Converter.
- Byte comparison (sha256) of generated files against real exports. The real files hold student
  data, so they're never committed.

Adding a synthetic-fixture test suite (Node for `lib/`, Python for the CLI) would be a good
early task.

## Related project

CompTIA-D2L-Gradebook-Converter (`meowomancer/CompTIA-D2L-Gradebook-Converter`, by a colleague)
is the post-processor used in CIS 140L. It's a separate project. Don't modify it from here.

## Open work

### Red Hat Academy add-on: feasibility checked, not started

Site: `https://rha.ole.redhat.com/rha/app/classes`. Checked read-only, Oct 2026.
- **Auth:** cookies on `rha.ole.redhat.com`. No token in storage, so `fetch(..., {credentials:"include"})`
  from inside the tab works.
- **API base:** `/rha/sapi/rest/`.
  - `user_class`: the instructor's classes, with `doc_id`, `class_name`, `course_code`,
    `course_title`, `start_date`, `end_date`, `label`, `students[]`, `status`.
  - `user_class/{class_id}/class_dashboard/`: an object keyed by student username. Each entry
    has `userinfo` (name, emails), `course_progress[]` (`total_progress`, `total_score`,
    `thresholds`, `@timestamp`) and `grades` (filled only when RHA assignments are used).
  - Also present: `user_class/{id}/assignment`, `academy`, `academy/{id}/students?report_type=csv`,
    `academy/{id}/student_activity?student=<username>`. `reports/search/` and `jobs` are async
    report jobs, which create records, so avoid them.
- **Linking:** class labels include the CRN (e.g. "… CRN 41508 RH124"), so `autoLink` works.
- **To do first:** find the per-student detail call (chapter, lab, quiz or knowledge-check
  scores). The UI has `student:quiz`/`student:kc` views. Open one student's detail view and
  record its network calls. Then decide the CSV columns. RHA has no native progress export to
  match, so we define the format.
- **Matching caveat:** Red Hat IDs are often personal accounts, so matching to D2L may need
  the email from `userinfo` or a manual map in the post-processor.

### zyBooks add-on: investigated, not started

- Bearer token in `localStorage["ember_simple_auth-session-5"]`.
- `/v1/zybook/{book}/roster` returns TA, Student, Unsubscribed and Temporary groups. Each
  student has a free-text `class_section` (e.g. "… CRN 20325"; watch for double spaces).
- `zyserver2 /activity_summary` is an async job giving per-student completion. Assignments
  carry due dates per section group.
- Undecided: compute scores from activity, or use official score reports (which create records,
  so ask first). It's a shared book across sections with TAs, so filter by section.

### Other

- Chrome Web Store prep: names, icons, privacy policy, and supporting both store and unpacked IDs.
- CLI: optional CompTIA support via a pasted token (`COMPTIA_TOKEN`). The token expires within hours.
