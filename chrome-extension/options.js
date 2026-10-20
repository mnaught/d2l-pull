// D2L Pull settings page.
const { h } = Selector;
const $ = (id) => document.getElementById(id);
const call = async (type, extra = {}) => {
  const r = await chrome.runtime.sendMessage({ type, ...extra });
  if (!r?.ok) throw new Error(r?.error || "no answer");
  return r.value;
};
const native = (msg) => call("native", { msg });
const clone = (x) => JSON.parse(JSON.stringify(x));
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" }) : "—");

let cfg, courses = null, current = "template", previewId = null;
const infoCache = {}, classCache = {}, removedAddons = new Set();
let helperCommands = null;

// ---- saving -------------------------------------------------------------------------------
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    // Merge with add-on registrations that may have arrived while this page was open.
    const latest = await call("getConfig");
    const addons = {};
    for (const [id, a] of Object.entries(latest.addons)) {
      if (removedAddons.has(id)) continue;
      addons[id] = { ...a, approved: cfg.addons[id]?.approved ?? a.approved, settings: cfg.addons[id]?.settings ?? a.settings };
    }
    cfg.addons = addons;
    await call("setConfig", { cfg });
    $("saved").textContent = "· saved";
    setTimeout(() => ($("saved").textContent = ""), 1200);
  }, 250);
}
const profile = () => (current === "template" ? cfg.template : cfg.profiles[current] || cfg.template);
const editingDefaults = () => current === "template" || !cfg.profiles[current];

// ---- Brightspace site -------------------------------------------------------------------
function siteSection() {
  $("siteUrl").value = cfg.site || "";
  $("detect").onclick = async () => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((t) => /^https:\/\/[^/]+\/d2l\//.test(t.url || ""));
    if (t) { $("siteUrl").value = new URL(t.url).origin; $("siteMsg").textContent = "Found " + new URL(t.url).host + " — click Save."; }
    else $("siteMsg").textContent = "No Brightspace tab found. Open Brightspace and log in, or type the address.";
  };
  $("saveSite").onclick = async () => {
    let url;
    try { url = new URL($("siteUrl").value.trim().replace(/^(?!https?:\/\/)/, "https://")); }
    catch { $("siteMsg").textContent = "That isn't a web address."; return; }
    const origin = "https://" + url.host;
    const granted = await chrome.permissions.request({ origins: [origin + "/*"] });
    if (!granted) { $("siteMsg").textContent = "D2L Pull needs permission for that site to read your courses."; return; }
    cfg.site = origin; $("siteUrl").value = origin; save();
    $("siteMsg").textContent = "Saved. Loading your courses…";
    loadCourses();
  };
}

// ---- courses ------------------------------------------------------------------------------
async function loadCourses() {
  $("coursesMsg").textContent = "Loading…";
  try {
    courses = await call("courses");
    $("coursesMsg").textContent = `${courses.length} course enrollments found.`;
  } catch (e) { $("coursesMsg").textContent = e.message; }
  drawCourses(); drawProfiles();
}

function drawCourses() {
  $("currentOnly").checked = cfg.currentOnly;
  const list = courses || [];
  const sel = Config.selectCourses(cfg, list);
  Selector.render($("rolesSel"), {
    items: sel.roleItems, rule: cfg.roles, noun: "roles", nameTitle: "Role",
    emptyText: courses ? "No roles found." : "Click “Load from Brightspace” (with a Brightspace tab open).",
    columns: [{ title: "Courses", cell: (r) => String(list.filter((c) => c.role === r.id).length) }],
    onChange: (r) => { cfg.roles = r; save(); drawCourses(); drawProfiles(); },
  });
  Selector.render($("coursesSel"), {
    items: sel.eligible.map((c) => ({ id: c.id, name: c.name, text: Config.courseText(c), c })), rule: cfg.courses, noun: "courses", nameTitle: "Course",
    emptyText: courses ? "No courses match the role and date filters above." : "Click “Load from Brightspace”.",
    columns: [{ title: "Code", cell: (i) => i.c.code }, { title: "Role", cell: (i) => i.c.role },
              { title: "Dates", cell: (i) => `${fmtDate(i.c.start)} – ${fmtDate(i.c.end)}` },
              { title: "Settings", cell: (i) => (cfg.profiles[i.id] ? "own" : "defaults") }],
    onChange: (r) => { cfg.courses = r; save(); drawProfiles(); },
  });
}
$("currentOnly").onchange = () => { cfg.currentOnly = $("currentOnly").checked; save(); drawCourses(); drawProfiles(); };
$("loadCourses").onclick = loadCourses;

// ---- per-course settings ------------------------------------------------------------------
function selectedCourses() { return courses ? Config.selectCourses(cfg, courses).selected : []; }
function courseById(id) { return (courses || []).find((c) => c.id === id); }

function drawProfiles() {
  const sel = selectedCourses();
  const ps = $("profileSel");
  ps.replaceChildren(h("option", { value: "template", textContent: "Defaults (all courses without their own)" }));
  const ids = [...new Set([...sel.map((c) => c.id), ...Object.keys(cfg.profiles)])];
  for (const id of ids) {
    const c = courseById(id);
    const label = (c ? (c.code || c.name) : `course ${id}`) + (cfg.profiles[id] ? " — own settings" : " — uses defaults") + (c && !sel.includes(c) ? " (not selected)" : "");
    ps.append(h("option", { value: id, textContent: label }));
  }
  if (![...ps.options].some((o) => o.value === current)) current = "template";
  ps.value = current;
  const pv = $("previewSel");
  pv.replaceChildren(...sel.map((c) => h("option", { value: c.id, textContent: c.code || c.name })));
  if (!sel.some((c) => c.id === previewId)) previewId = sel[0]?.id || null;
  if (previewId) pv.value = previewId;
  drawProfile();
}
$("profileSel").onchange = () => { current = $("profileSel").value; drawProfile(); };
$("previewSel").onchange = () => { previewId = $("previewSel").value; drawProfile(); };

$("ownBtn").onclick = () => {
  if (current === "template") return;
  if (cfg.profiles[current]) {
    if (!confirm("Drop this course's own settings and use the defaults?")) return;
    delete cfg.profiles[current];
  } else {
    cfg.profiles[current] = clone(cfg.template);
  }
  save(); drawProfiles();
};

async function getInfo(id) {
  if (!id) return null;
  if (!infoCache[id]) infoCache[id] = call("courseInfo", { courseId: id }).catch((e) => ({ error: e.message }));
  return infoCache[id];
}

async function drawProfile() {
  const p = profile();
  const isTemplate = current === "template";
  $("ownBtn").hidden = isTemplate;
  $("ownBtn").textContent = cfg.profiles[current] ? "Use the defaults instead" : "Give this course its own settings";
  $("previewWrap").hidden = !isTemplate;
  const readOnly = !isTemplate && !cfg.profiles[current];
  $("setup").querySelectorAll("input, select, textarea, #itemsSel button, #studentsSel button").forEach((el) => {
    if (!["profileSel", "previewSel"].includes(el.id)) el.disabled = readOnly;
  });
  $("infoMsg").textContent = readOnly ? "This course uses the defaults. Edit “Defaults”, or give this course its own settings." : "";

  // files
  for (const k of ["folder", "gradesFile", "rosterFile", "keyField"]) {
    $(k).value = p[k] || "";
    $(k).onchange = () => { profile()[k] = $(k).value.trim(); save(); };
  }
  document.querySelectorAll("[data-col]").forEach((b) => {
    b.checked = (p.userCols || []).includes(b.dataset.col);
    b.onchange = () => { profile().userCols = [...document.querySelectorAll("[data-col]:checked")].map((x) => x.dataset.col); save(); };
  });
  // zero-fill
  $("zeroOn").checked = !!p.zero.enabled;
  $("zeroOn").onchange = () => { profile().zero.enabled = $("zeroOn").checked; save(); };
  document.querySelectorAll("[name=cutoff]").forEach((r) => { r.checked = r.value === (p.zero.cutoff || "now"); r.onchange = () => { profile().zero.cutoff = r.value; save(); }; });
  $("grace").value = p.zero.grace ?? 2;
  $("grace").onchange = () => { profile().zero.grace = Number($("grace").value) || 0; save(); };

  drawPost();

  // items + students need the course's gradebook
  const id = isTemplate ? previewId : current;
  const empty = (msg) => { $("itemsSel").replaceChildren(h("div", { className: "hint", textContent: msg })); $("studentsSel").replaceChildren(); };
  if (!id) return empty(courses ? "Select a course above to see its grade items." : "Load your courses first (Courses → Load from Brightspace).");
  $("itemsSel").replaceChildren(h("div", { className: "hint", textContent: "Loading gradebook…" }));
  const info = await getInfo(id);
  if (info.error) return empty(info.error);
  if ((isTemplate ? previewId : current) !== id) return;   // selection changed meanwhile

  const exportable = new Set(["Numeric", "PassFail", "SelectBox"]);
  // calculated/formula/text items can't be exported, so pattern suggestions may ignore them
  const items = info.items.map((i) => ({ ...i, text: `${i.category} ${i.name}`, inert: !exportable.has(i.type) }));
  Selector.render($("itemsSel"), {
    items, rule: p.items, noun: "items", nameTitle: "Grade item",
    groupBy: (i) => i.category || "No category", categoryOf: (i) => i.category,
    columns: [
      { title: "Points", cell: (i) => (exportable.has(i.type) ? String(i.maxPoints ?? "") : i.type) },
      { title: "Due", cell: (i) => fmtDate(i.due) },
      { title: "Missing", cell: (i) => {
          const o = profile().zero.overrides?.[i.id]?.mode || "auto";
          const s = h("select", { disabled: readOnly },
            h("option", { value: "auto", textContent: i.due ? "auto (0 after due)" : "auto (blank: no due date)" }),
            h("option", { value: "0", textContent: "0" }), h("option", { value: "blank", textContent: "blank" }));
          s.value = o;
          s.onchange = () => {
            const ov = profile().zero.overrides || (profile().zero.overrides = {});
            if (s.value === "auto") delete ov[i.id]; else ov[i.id] = { name: i.name, mode: s.value };
            save();
          };
          return s;
        } },
    ],
    onChange: (r) => { profile().items = r; save(); },
  });
  const roles = info.roles.length ? info.roles : ["Student"];
  Selector.render($("studentsSel"), {
    items: roles.map((r) => ({ id: r, name: r })), rule: p.students, noun: "roles", nameTitle: "Classlist role",
    onChange: (r) => { profile().students = r; save(); },
  });
  if (readOnly) $("setup").querySelectorAll("#itemsSel input, #itemsSel button, #studentsSel input, #studentsSel button").forEach((el) => (el.disabled = true));
  drawLinks(id);
}

async function drawLinks(courseId) {
  const approved = Object.entries(cfg.addons).filter(([, a]) => a.approved);
  $("linksWrap").hidden = !approved.length;
  const grid = $("links"); grid.replaceChildren();
  const course = courseById(courseId);
  for (const [id, a] of approved) {
    const s = h("select", { disabled: editingDefaults() && current !== "template" });
    grid.append(h("label", { textContent: a.info.name }), s);
    s.append(h("option", { value: "auto", textContent: "Automatic" }));
    try {
      classCache[id] ||= call("addonClasses", { id });
      const classes = await classCache[id];
      const auto = course ? Config.autoLink(course, classes, selectedCourses().length) : null;
      s.options[0].textContent = `Automatic${course ? " → " + (auto ? auto.name : "no match") : ""}`;
      for (const k of classes) s.append(h("option", { value: k.id, textContent: k.name }));
    } catch (e) { s.options[0].textContent = "Automatic (classes unavailable: " + e.message + ")"; }
    s.value = profile().links?.[id] || "auto";
    s.onchange = () => { (profile().links ||= {})[id] = s.value; save(); };
  }
}

// ---- post-processor -----------------------------------------------------------------------
function placeholderNames() {
  const names = ["grades", "roster", "folder", "week", "course_code", "course_id", "course_name"];
  for (const a of Object.values(cfg.addons)) if (a.approved) for (const o of a.info.outputs) names.push(`${a.info.key}.${o.key}`);
  return names;
}
function drawPost() {
  const p = profile().post;
  $("postLabel").value = p.label || "";
  $("postProgram").value = p.program || "";
  $("postCwd").value = p.cwd || "";
  $("postSteps").value = p.steps || "";
  $("postConsole").checked = p.console !== false;
  $("placeholders").replaceChildren(...placeholderNames().map((n) => {
    const c = h("code", { textContent: `{${n}}`, title: "insert" });
    c.onclick = () => { const t = $("postSteps"); const s = t.selectionStart ?? t.value.length; t.value = t.value.slice(0, s) + `{${n}}` + t.value.slice(t.selectionEnd ?? s); t.focus(); };
    return c;
  }));
  const pend = $("pendingPost"); pend.replaceChildren();
  if (p.pending) {
    pend.append(h("div", { className: "banner" },
      h("div", {}, h("b", { textContent: "Suggested from your previous settings: " }), p.pending.label),
      h("div", { className: "hint", textContent: p.pending.note || "" }),
      h("button", { textContent: "Fill in", onclick: () => {
        $("postLabel").value = p.pending.label; $("postSteps").value = p.pending.steps; $("postCwd").value = p.pending.cwd || "{folder}/..";
        if (!$("postProgram").value) $("postProgram").placeholder = `click Browse… and pick ${p.pending.program}`;
      } })));
  }
  postStatus();
}
async function postStatus() {
  const p = profile().post;
  if (!p.commandId) { $("postMsg").textContent = p.program ? "Not saved yet." : ""; return; }
  try {
    helperCommands ||= (await native({ action: "ping" })).commands || [];
    $("postMsg").textContent = helperCommands.some((c) => c.id === p.commandId) ? "✓ Approved on this computer." : "Not approved on this computer — click Save & approve.";
  } catch { $("postMsg").textContent = "Helper not installed (see Helper below)."; }
}
$("browseProgram").onclick = async () => {
  const r = await native({ action: "browse", kind: "file", title: "Choose the post-processing program or script" });
  if (r.ok && r.path) $("postProgram").value = r.path; else if (r.error) $("postMsg").textContent = r.missing ? "Install the helper first (see Helper below)." : r.error;
};
$("browseCwd").onclick = async () => {
  const r = await native({ action: "browse", kind: "folder", title: "Choose the working folder" });
  if (r.ok && r.path) $("postCwd").value = r.path; else if (r.error) $("postMsg").textContent = r.missing ? "Install the helper first (see Helper below)." : r.error;
};
$("savePost").onclick = async () => {
  const p = profile().post;
  const steps = $("postSteps").value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(Config.splitArgs);
  const command = { id: p.commandId || undefined, label: $("postLabel").value.trim(), program: $("postProgram").value.trim(),
                    cwd: $("postCwd").value.trim(), console: $("postConsole").checked, steps: steps.length ? steps : [[]] };
  if (!command.program) { $("postMsg").textContent = "Choose a program first (Browse…)."; return; }
  $("postMsg").textContent = "Waiting for your approval in the helper's window…";
  const r = await native({ action: "save", command });
  if (!r.ok) { $("postMsg").textContent = r.missing ? "Install the helper first (see Helper below)." : r.declined ? "Not approved — nothing changed." : r.error; return; }
  Object.assign(p, { commandId: r.id, label: command.label || command.program.split(/[\\/]/).pop(), program: command.program,
                     cwd: command.cwd, steps: $("postSteps").value, console: command.console, pending: null });
  helperCommands = null; save(); drawPost();
};
$("clearPost").onclick = async () => {
  const p = profile().post;
  if (p.commandId) await native({ action: "remove", id: p.commandId }).catch(() => {});
  Object.assign(p, { commandId: "", label: "", program: "", cwd: "", steps: "", pending: null });
  helperCommands = null; save(); drawPost();
};

// ---- add-ons ------------------------------------------------------------------------------
function drawAddons() {
  const list = $("addonList"); list.replaceChildren();
  const entries = Object.entries(cfg.addons);
  if (!entries.length) list.append(h("p", { className: "muted", textContent: "No add-ons yet. Install one (e.g. the CompTIA CertMaster add-on) and it shows up here." }));
  for (const [id, a] of entries) {
    const status = h("span", { className: "hint", textContent: "checking…" });
    const card = h("div", { className: "card", style: "margin:8px 0;padding:12px" },
      h("div", { className: "inline" }, h("b", { textContent: a.info.name }), h("span", { className: "muted", textContent: `v${a.info.version} · ${id}` }), status),
      h("div", { className: "hint", textContent: "Files: " + a.info.outputs.map((o) => `${o.label} → ${o.filename}  {${a.info.key}.${o.key}}`).join(" · ") }));
    const approve = h("button", { textContent: a.approved ? "Revoke" : "Approve", onclick: () => { const cur = cfg.addons[id]; if (!cur) return; cur.approved = !cur.approved; save(); drawAddons(); drawProfiles(); } });
    const remove = h("button", { textContent: "Remove", onclick: () => { if (!confirm(`Forget ${a.info.name}? It will ask again next time it starts.`)) return; delete cfg.addons[id]; removedAddons.add(id); save(); drawAddons(); } });
    if (!a.approved) card.append(h("div", { className: "banner" }, `${a.info.name} wants to provide data to D2L Pull. `, approve));
    else card.append(h("div", { className: "inline", style: "margin-top:6px" }, approve, remove));
    if (a.info.settings?.length) {
      const grid = h("div", { className: "grid", style: "margin-top:8px" });
      for (const s of a.info.settings) {
        const v = a.settings?.[s.key] ?? s.default ?? "";
        let input;
        if (s.type === "checkbox") input = h("input", { type: "checkbox", checked: !!v });
        else if (s.type === "select") { input = h("select", {}, (s.options || []).map((o) => h("option", { value: o.value, textContent: o.label }))); input.value = v; }
        else input = h("input", { type: s.type === "number" ? "number" : "text", value: v });
        input.onchange = () => { const cur = cfg.addons[id]; if (!cur) return; (cur.settings ||= {})[s.key] = s.type === "checkbox" ? input.checked : s.type === "number" ? Number(input.value) : input.value; delete classCache[id]; save(); };
        grid.append(h("label", { textContent: s.label }), input);
      }
      card.append(grid);
    }
    list.append(card);
    call("addonStatus", { id }).then((s) => { status.textContent = s.message || (s.ready ? "ready" : ""); status.className = s.ready ? "ok" : "warn"; }).catch(() => {});
  }
}
$("addAddon").onclick = async () => {
  const id = $("addonId").value.trim();
  if (!/^[a-p]{32}$/.test(id)) { $("addonMsg").textContent = "An extension ID is 32 letters a–p (see chrome://extensions)."; return; }
  try { await call("addonHello", { id }); cfg.addons = (await call("getConfig")).addons; $("addonMsg").textContent = "Found it — approve it above."; drawAddons(); }
  catch (e) { $("addonMsg").textContent = e.message; }
};

// ---- helper + backup ------------------------------------------------------------------------
$("ping").onclick = async () => {
  const r = await native({ action: "ping" });
  $("helperMsg").textContent = r.ok ? `✓ Helper v${r.version} (Python ${r.python}), ${r.commands.length} approved post-processor(s).`
    : r.missing ? "Not installed. Run native\\install.cmd (Windows) or native/install.sh, then restart the browser." : r.error;
};
$("export").onclick = () => {
  const blob = new Blob([JSON.stringify({ ...cfg, exported: new Date().toISOString() }, null, 2)], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: "d2l-pull-settings.json" }); a.click();
};
$("importBtn").onclick = () => $("importFile").click();
$("importFile").onchange = async () => {
  try {
    const data = JSON.parse(await $("importFile").files[0].text());
    if (data.schema !== 3) throw new Error("Not a D2L Pull settings file.");
    const keepAddons = cfg.addons;                   // approvals are per computer
    cfg = Config.normalize(data); cfg.addons = keepAddons;
    for (const p of [cfg.template, ...Object.values(cfg.profiles)]) if (p.post?.commandId) p.post.commandId = "";   // must be re-approved here
    await call("setConfig", { cfg });
    $("backupMsg").textContent = "Imported. Post-processors need Save & approve on this computer.";
    init();
  } catch (e) { $("backupMsg").textContent = e.message; }
};

// ---- start ------------------------------------------------------------------------------
async function init() {
  $("ver").textContent = "v" + chrome.runtime.getManifest().version;
  cfg = await call("getConfig");
  siteSection(); drawCourses(); drawProfiles(); drawAddons();
  if (cfg.site) { try { if ((await call("siteStatus")).tab) await loadCourses(); else $("coursesMsg").textContent = `Open ${cfg.site} in a tab and log in, then click Load.`; } catch {} }
  if (location.hash === "#post") {
    // jump to the first selected course that has its own post-processor, else defaults
    const withPost = selectedCourses().find((c) => cfg.profiles[c.id]?.post?.commandId);
    if (withPost) { current = withPost.id; drawProfiles(); }
  }
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
}
init();
