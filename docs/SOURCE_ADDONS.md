# Writing a source add-on for D2L Pull

D2L Pull downloads Brightspace (D2L) rosters and grades. Everything else, such as an online textbook
or lab platform like CompTIA CertMaster, McGraw Hill Connect, Pearson MyLab or Cengage, comes from
**source add-ons**: small, separate Chrome extensions that plug into D2L Pull.

An add-on only has to do one thing: read the instructor's data from its own site and return CSV
text. D2L Pull does the rest: the popup section, the checkboxes, linking each class to a D2L course,
saving files into that course's folder, and passing them to the course's post-processor.

`addons/comptia-certmaster/` is a complete working example.

## How it fits together

```
 ┌──────────────┐  register / status / classes / pull   ┌────────────────────────┐
 │  D2L Pull    │ ─────────────────────────────────────▶ │  Source add-on         │
 │  (core)      │ ◀───────────────────────────────────── │  (its own permissions) │
 │              │        CSV files + log lines           │  reads its site in the │
 │ saves files, │                                        │  instructor's own tab  │
 │ runs post-   │                                        └────────────────────────┘
 │ processors   │
 └──────────────┘
```

* Messages go over Chrome's `chrome.runtime.sendMessage(otherExtensionId, …)`.
* The add-on holds the host permissions for its platform. D2L Pull never gets access to it.
* D2L Pull shows a new add-on as **waiting for approval** until the instructor approves it in
  D2L Pull's settings. Until then it's never called.

D2L Pull's extension ID is fixed: **`ilmegdpkffcmnhanlgciclmceidicbof`**.

## Messages (API version 1)

All messages are JSON objects with a `type`. Replies are sent with `sendResponse`; return `true`
from the listener for async replies. Add-ons must ignore messages whose `sender.id` isn't D2L Pull's ID.

### 1. `d2lpull/register` (add-on → D2L Pull)

Send it when the add-on installs or starts, and whenever D2L Pull sends `d2lpull/hello`.

```js
chrome.runtime.sendMessage(D2L_PULL_ID, {
  type: "d2lpull/register",
  api: 1,
  key: "comptia",                       // short id: letters, digits, -  (used in file placeholders)
  name: "CompTIA CertMaster",           // section title in the popup
  version: "1.0.0",
  site: { label: "platform.comptia.org", url: "https://platform.comptia.org/" },
  outputs: [                            // one checkbox each in the popup
    { key: "labs",    label: "Labs",    filename: "comptia_labs.csv" },
    { key: "quizzes", label: "Quizzes", filename: "comptia_quizzes.csv" }
  ],
  settings: [                           // shown on the add-on's card in D2L Pull settings
    { key: "quizReport", label: "Quiz report name (regex)", type: "text", default: "quiz" }
  ]
});
// reply: { ok: true, approved: false }   (approved once the instructor allows it)
```

Setting types: `text`, `number`, `checkbox`, `select` (add `options: [{value, label}]`).

### 2. `d2lpull/hello` (D2L Pull → add-on)

Reply with the same object you'd send in `d2lpull/register`. D2L Pull sends it when the instructor
adds the add-on by ID in settings, and to re-sync after an update.

### 3. `d2lpull/status` (D2L Pull → add-on)

```js
// request: { type: "d2lpull/status" }
// reply:   { ready: true,  message: "tab open" }
//          { ready: false, message: "open platform.comptia.org and log in" }
```

### 4. `d2lpull/classes` (D2L Pull → add-on)

Lists the instructor's current classes, so D2L Pull can link each one to a D2L course.

```js
// request: { type: "d2lpull/classes", settings: { …add-on settings… } }
// reply:   { ok: true, classes: [ { id: "a1b2c3d4…", name: "CIS 140L … CRN 12345 …",
//                                   start: "2026-09-21T08:00:00Z", end: "2026-12-14T07:59:00Z" } ] }
```

Linking is automatic when a class name and a D2L course code or name share a number of four or
more digits, such as a CRN. Linking is also automatic when there's exactly one class and one
course. Instructors can pick the link by hand in settings.

### 5. `d2lpull/pull` (D2L Pull → add-on)

```js
// request:
{ type: "d2lpull/pull",
  outputs: ["labs", "quizzes"],        // which checkboxes are ticked
  classIds: ["a1b2c3d4…"],             // only these classes (the ones linked to selected courses)
  settings: { quizReport: "quiz" } }

// reply:
{ ok: true,
  files: [ { classId: "a1b2c3d4…", output: "labs", content: "Student,\"Lab - 1.1.11 …\"\n…" },
           { classId: "a1b2c3d4…", output: "quizzes", content: "\"Name\",…" } ],
  log: [ "labs: 52 labs, 25 students", "quizzes: 5 quizzes, 25 students" ] }

// on failure:
{ ok: false, error: "Not signed in — log in at platform.comptia.org" }
```

`content` is the file's exact text. D2L Pull saves it byte-for-byte as
`<course folder>/<outputs[].filename>`. Make it match whatever the platform's own export produces,
so existing scripts accept it unchanged.

Pulls can take a while. Chrome keeps the add-on's service worker alive while it's answering
(up to 5 minutes).

## Using the files in a post-processor

Each saved file becomes a placeholder for that course's post-processor: `{<add-on key>.<output key>}`,
for example `{comptia.labs}` and `{comptia.quizzes}`. D2L files are `{grades}` and `{roster}`.

## Reading the platform's data

Do what the CompTIA add-on does: find the instructor's open tab for the platform
(`chrome.tabs.query`), then `chrome.scripting.executeScript` a function into it. Code running in the
page can use the page's own login (cookies, or a token in `localStorage`). No credentials are copied,
stored or sent anywhere else.

## Checklist

- [ ] `manifest.json`: `"background": { "service_worker": … }`, `scripting` + `tabs` permissions,
      and `host_permissions` for your platform only.
- [ ] Add a fixed `"key"` so your add-on's ID never changes.
- [ ] Ignore messages from any sender except `ilmegdpkffcmnhanlgciclmceidicbof`.
- [ ] Register on `runtime.onInstalled` and `runtime.onStartup`, and answer `d2lpull/hello`.
- [ ] Return CSV exactly as the platform's own export would.
