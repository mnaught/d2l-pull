// D2L Pull background worker.
//  * stores settings (chrome.storage.local "cfg"), migrating v2 settings once
//  * answers the popup / options page (data from your Brightspace tab, add-on status)
//  * accepts registrations from source add-ons (other extensions)
//  * runs download jobs: D2L files + add-on files per course, then each course's post-processor

importScripts("lib/select.js", "lib/config.js");

const NATIVE_HOST = "com.mnaught.d2lpull";
const ADDON_API = 1;

// ---- settings ---------------------------------------------------------------------------
async function getConfig() {
  const { cfg } = await chrome.storage.local.get("cfg");
  if (cfg) return Config.normalize(cfg);
  const { settings } = await chrome.storage.sync.get("settings");          // v2
  const fresh = Config.normalize(settings || null);
  await chrome.storage.local.set({ cfg: fresh });
  return fresh;
}
const setConfig = (cfg) => chrome.storage.local.set({ cfg });

// ---- log / state (shown live in the popup, kept for reopening) ---------------------------
let logLines = [];
async function log(text, cls = "") {
  logLines.push({ text, cls });
  await chrome.storage.session.set({ log: logLines });
  chrome.runtime.sendMessage({ type: "log", text, cls }).catch(() => {});
}
async function setRunning(running) {
  await chrome.storage.session.set({ running });
  chrome.runtime.sendMessage({ type: "state", running }).catch(() => {});
}

// ---- Brightspace tab ----------------------------------------------------------------------
async function findTab(urlPattern) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: urlPattern }); } catch { return null; }
  if (!tabs.length) return null;
  return tabs.find((t) => t.active) || tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}
async function d2lTab(cfg) {
  if (!cfg.site) throw new Error("Set your Brightspace address in D2L Pull settings first.");
  const tab = await findTab(cfg.site.replace(/\/+$/, "") + "/*");
  if (!tab) throw new Error(`No Brightspace tab open — open ${cfg.site} and log in, then retry.`);
  return tab;
}
// Run D2L.<fn>(...args) inside the Brightspace tab.
async function inD2L(cfg, fn, ...args) {
  const tab = await d2lTab(cfg);
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["lib/d2l.js"] });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id }, args: [fn, args],
    func: async (fn, args) => {
      try { return { ok: true, value: await globalThis.D2L[fn](...args) }; }
      catch (e) { return { ok: false, error: String(e?.message || e) }; }
    },
  });
  if (!result) throw new Error("No response from the Brightspace tab — reload it and try again.");
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

// ---- add-ons ------------------------------------------------------------------------------
function validRegistration(m) {
  return m && m.type === "d2lpull/register" && m.api === ADDON_API && /^[a-z0-9-]{1,32}$/.test(m.key || "") &&
    typeof m.name === "string" && Array.isArray(m.outputs) &&
    m.outputs.every((o) => /^[a-z0-9-]{1,32}$/.test(o.key || "") && /^[\w.-]{1,80}$/.test(o.filename || ""));
}
async function register(senderId, m) {
  const cfg = await getConfig();
  const prev = cfg.addons[senderId] || {};
  const defaults = Object.fromEntries((m.settings || []).map((s) => [s.key, s.default ?? ""]));
  cfg.addons[senderId] = {
    approved: !!prev.approved,
    info: { key: m.key, name: m.name.slice(0, 60), version: String(m.version || ""), site: m.site || {},
            outputs: m.outputs.map((o) => ({ key: o.key, label: String(o.label || o.key).slice(0, 30), filename: o.filename })),
            settings: (m.settings || []).slice(0, 20) },
    settings: { ...defaults, ...(prev.settings || {}) },
  };
  await setConfig(cfg);
  return cfg.addons[senderId];
}
async function askAddon(id, msg, timeoutMs = 280000) {
  return Promise.race([
    chrome.runtime.sendMessage(id, msg),
    new Promise((_, rej) => setTimeout(() => rej(new Error("add-on didn't answer")), timeoutMs)),
  ]);
}
async function addonStatus(id) {
  try { return (await askAddon(id, { type: "d2lpull/status" }, 5000)) || { ready: false, message: "no answer" }; }
  catch (e) { return { ready: false, message: /Receiving end|Could not establish/.test(e.message) ? "add-on not installed or disabled" : e.message }; }
}

chrome.runtime.onMessageExternal.addListener((m, sender, reply) => {
  if (m?.type !== "d2lpull/register") return false;
  if (!validRegistration(m)) { reply({ ok: false, error: "invalid registration" }); return false; }
  register(sender.id, m).then((a) => reply({ ok: true, approved: a.approved }));
  return true;
});

// ---- downloads ----------------------------------------------------------------------------
function download(relPath, text) {
  return new Promise((resolve, reject) => {
    const url = "data:text/csv;charset=utf-8," + encodeURIComponent(text);
    chrome.downloads.download({ url, filename: relPath, conflictAction: "overwrite", saveAs: false }, (id) => {
      if (chrome.runtime.lastError || id == null) return reject(new Error(chrome.runtime.lastError?.message || "download failed"));
      const done = (d) => {
        if (d.id !== id || !d.state) return;
        if (d.state.current === "complete") { chrome.downloads.onChanged.removeListener(done); chrome.downloads.search({ id }, ([it]) => resolve(it.filename)); }
        else if (d.state.current === "interrupted") { chrome.downloads.onChanged.removeListener(done); reject(new Error("download interrupted")); }
      };
      chrome.downloads.onChanged.addListener(done);
    });
  });
}
// A file saved by an earlier run (so a post-processor can use it when it wasn't re-downloaded).
async function previous(relPath) {
  const tail = relPath.split("/").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\\\/]");
  const hits = await chrome.downloads.search({ filenameRegex: tail + "$", exists: true, state: "complete", orderBy: ["-startTime"], limit: 1 });
  return hits[0]?.filename || null;
}
const dirOf = (p) => p.replace(/[\\/][^\\/]*$/, "");

function native(msg) {
  return new Promise((resolve) => chrome.runtime.sendNativeMessage(NATIVE_HOST, msg, (r) =>
    resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message, missing: true } : r || { ok: false, error: "no reply" })));
}

// ---- the job ------------------------------------------------------------------------------
async function runJob() {
  logLines = [];
  await setRunning(true);
  try {
    const cfg = await getConfig();
    const run = cfg.run;
    const addonRuns = Object.entries(cfg.addons).filter(([id, a]) => a.approved && (run.outputs[id] || []).length);
    if (!run.roster && !run.grades && !addonRuns.length && !run.post) { await log("Nothing ticked.", "err"); return; }

    await log("Brightspace (D2L)", "h");
    const all = await inD2L(cfg, "listCourses");
    const sel = Config.selectCourses(cfg, all);
    sel.errors.forEach((e) => log(e, "err"));
    if (!sel.selected.length) { await log("No courses selected — check Courses in settings.", "err"); return; }
    await log(`${sel.selected.length} course(s): ${sel.selected.map((c) => c.code || c.name).join(", ")}`);

    const perCourse = Object.fromEntries(sel.selected.map((c) => [c.id, { course: c, files: {}, folder: null }]));
    const weekOf = (c) => parseInt(run.week, 10) > 0 ? parseInt(run.week, 10) : Config.weeksSince(c.start);

    // D2L files
    if (run.roster || run.grades) {
      for (const c of sel.selected) {
        const p = Config.profileFor(cfg, c.id), slot = perCourse[c.id];
        const folder = Config.folderFor(p.folder, c);
        try {
          await log(`${c.code || c.name}`, "h2");
          const info = run.grades ? await inD2L(cfg, "courseInfo", c.id, { dues: !!p.zero.enabled || Object.keys(p.zero.overrides || {}).length > 0 }) : null;
          let itemIds = [], roles = [];
          if (info) {
            const items = info.items.map((i) => ({ id: i.id, name: i.name, text: `${i.category} ${i.name}` }));
            const is = Select.apply(p.items, items);
            if (is.error) await log("Grade items: " + is.error, "err");
            if (is.byName.size) await log(`  ${is.byName.size} item(s) matched by name (new course copy?) — check them in settings`, "warn");
            itemIds = [...is.selected];
            roles = [...Select.apply(p.students, info.roles.map((r) => ({ id: r, name: r }))).selected];
          }
          const week = weekOf(c);
          const cutoff = p.zero.cutoff === "week" && c.start
            ? new Date(Date.parse(c.start) + (week * 7 + Number(p.zero.grace || 0)) * 864e5).toISOString() : null;
          const overrides = Object.fromEntries(Object.entries(p.zero.overrides || {}).map(([id, o]) => [id, o.mode]));
          const r = await inD2L(cfg, "pullCourse", c.id, {
            roster: run.roster, grades: run.grades, itemIds, studentRoles: roles, keyField: p.keyField, userCols: p.userCols,
            zero: { enabled: p.zero.enabled, cutoff, overrides }, info,
          });
          for (const line of r.log) await log("  " + line);
          for (const f of r.files) {
            const name = f.kind === "grades" ? p.gradesFile : p.rosterFile;
            const abs = await download(`${folder}/${name}`, f.csv);
            slot.files[f.kind] = abs; slot.folder = dirOf(abs);
            await log(`  saved ${folder}/${name}`, "ok");
          }
        } catch (e) { await log(`  ${e.message}`, "err"); }
      }
    }

    // Add-on files
    for (const [id, a] of addonRuns) {
      await log(a.info.name, "h");
      try {
        const st = await addonStatus(id);
        if (!st.ready) throw new Error(st.message || "not ready");
        const { classes = [] } = (await askAddon(id, { type: "d2lpull/classes", settings: a.settings })) || {};
        const linked = sel.selected.map((c) => [c, Config.linkFor(cfg, c, id, classes, sel.selected.length)]);
        for (const [c, k] of linked) if (!k) await log(`  ${c.code || c.name}: no linked class — pick one in the course's settings`, "err");
        const want = linked.filter(([, k]) => k);
        if (!want.length) continue;
        const r = await askAddon(id, { type: "d2lpull/pull", outputs: run.outputs[id], classIds: [...new Set(want.map(([, k]) => k.id))], settings: a.settings });
        if (!r?.ok) throw new Error(r?.error || "pull failed");
        for (const line of r.log || []) await log("  " + line);
        for (const [c, k] of want) {
          const p = Config.profileFor(cfg, c.id), folder = Config.folderFor(p.folder, c), slot = perCourse[c.id];
          for (const f of r.files.filter((f) => f.classId === k.id)) {
            const out = a.info.outputs.find((o) => o.key === f.output);
            if (!out) continue;
            const abs = await download(`${folder}/${out.filename}`, String(f.content));
            slot.files[`${a.info.key}.${out.key}`] = abs; slot.folder = dirOf(abs);
            await log(`  saved ${folder}/${out.filename}  (${c.code || c.name})`, "ok");
          }
        }
      } catch (e) { await log("  " + e.message, "err"); }
    }

    // Post-processors
    if (run.post) {
      await log("Post-processing", "h");
      for (const c of sel.selected) {
        const p = Config.profileFor(cfg, c.id), slot = perCourse[c.id];
        if (!p.post.commandId) { await log(`  ${c.code || c.name}: no post-processor set up`, "warn"); continue; }
        const folder = Config.folderFor(p.folder, c);
        // Files not downloaded this time: use the copy saved by an earlier run, if any.
        const names = { grades: p.gradesFile, roster: p.rosterFile };
        for (const [, a] of Object.entries(cfg.addons)) for (const o of a.info.outputs) names[`${a.info.key}.${o.key}`] = o.filename;
        for (const [k, fname] of Object.entries(names)) if (!slot.files[k]) { const prev = await previous(`${folder}/${fname}`); if (prev) slot.files[k] = prev; }
        const anyFile = Object.values(slot.files)[0];
        const values = { week: String(weekOf(c)), course_code: c.code || "", course_id: c.id, course_name: c.name };
        if (anyFile) values.folder = dirOf(anyFile);
        const r = await native({ action: "run", id: p.post.commandId, files: slot.files, values });
        if (r.ok) await log(`  ${c.code || c.name}: started "${p.post.label}"${r.log ? " (log: " + r.log + ")" : " in a new window"}`, "ok");
        else if (r.missing) await log("  The D2L Pull helper isn't installed — run native\\install.cmd (see README).", "err");
        else await log(`  ${c.code || c.name}: ${r.error}`, "err");
      }
    }
    await log("Done.", "ok");
  } catch (e) {
    await log(e.message || String(e), "err");
  } finally {
    await setRunning(false);
  }
}

// ---- messages from the popup / options page ----------------------------------------------
const handlers = {
  getConfig: () => getConfig(),
  setConfig: async ({ cfg }) => { await setConfig(cfg); return true; },
  courses: async () => { const cfg = await getConfig(); return inD2L(cfg, "listCourses"); },
  courseInfo: async ({ courseId }) => { const cfg = await getConfig(); return inD2L(cfg, "courseInfo", courseId, { dues: true }); },
  siteStatus: async () => { const cfg = await getConfig(); if (!cfg.site) return { set: false }; return { set: true, tab: !!(await findTab(cfg.site.replace(/\/+$/, "") + "/*")) }; },
  addonStatus: ({ id }) => addonStatus(id),
  addonClasses: async ({ id }) => { const cfg = await getConfig(); return (await askAddon(id, { type: "d2lpull/classes", settings: cfg.addons[id]?.settings || {} }, 60000))?.classes || []; },
  addonHello: async ({ id }) => {
    const m = await askAddon(id, { type: "d2lpull/hello" }, 5000);
    if (!validRegistration(m)) throw new Error("That extension didn't answer as a D2L Pull add-on.");
    return register(id, m);
  },
  native: ({ msg }) => native(msg),
  run: async () => {
    const { running } = await chrome.storage.session.get("running");
    if (running) throw new Error("Already running");
    runJob();
    return true;
  },
};
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  const h = handlers[m?.type];
  if (!h) return false;
  Promise.resolve().then(() => h(m)).then((value) => reply({ ok: true, value }), (e) => reply({ ok: false, error: String(e?.message || e) }));
  return true;
});

chrome.runtime.onStartup.addListener(() => chrome.storage.session.set({ running: false }));
chrome.runtime.onInstalled.addListener(() => chrome.storage.session.set({ running: false }));
