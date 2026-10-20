// Settings model, defaults, migration and small helpers shared by the
// background worker, the popup and the options page.
//
// cfg = {
//   schema: 3,
//   site: "https://online.example.edu",          // Brightspace address
//   currentOnly: true,                           // only courses whose dates include today
//   roles:   <rule over your enrollment roles>   // which of your enrollments count as "teaching"
//   courses: <rule over courses>                 // which of those courses to pull
//   template: <profile>                          // settings for courses without their own profile
//   profiles: { [courseId]: <profile> },
//   addons:   { [extensionId]: { approved, info: <register message>, settings: {} } },
//   run:      { roster, grades, outputs: { [addonId]: [outputKeys] }, post, week }
// }
//
// profile = {
//   students: <rule over classlist roles>, items: <rule over grade items>,
//   keyField, userCols, gradesFile, rosterFile, folder,
//   zero: { enabled, cutoff: "now"|"week", grace, overrides: { [itemId]: {name, mode: "0"|"blank"} } },
//   links: { [addonId]: "auto" | classId },
//   post:  { commandId, label, steps, cwd, console, pending }
// }

(function (root) {
  const Select = root.Select || (typeof require === "function" ? require("./select.js") : null);
  const R = (mode, pattern, include = []) => ({ mode, pattern, include: include.map((x) => ({ id: x, name: x })), exclude: [] });

  const PROFILE = () => ({
    students: R("pick", "", ["Student"]),
    items: R("pattern", ".*"),
    keyField: "both",
    userCols: [],
    gradesFile: "d2l_grades.csv",
    rosterFile: "d2l_roster.csv",
    folder: "D2L Pull/{course_code}",
    zero: { enabled: true, cutoff: "now", grace: 2, overrides: {} },
    links: {},
    post: { commandId: "", label: "", program: "", steps: "", cwd: "", console: true, pending: null },
  });

  const DEFAULTS = () => ({
    schema: 3,
    site: "",
    currentOnly: true,
    roles: R("pick", "", ["Instructor"]),
    courses: R("pattern", ".*"),
    template: PROFILE(),
    profiles: {},
    addons: {},
    run: { roster: false, grades: true, outputs: {}, post: false, week: "" },
  });

  // ---- v2 -> v3 migration (your old single-course settings become the template) ----------
  function migrateV2(old) {
    const cfg = DEFAULTS();
    const p = cfg.template;
    if (old.d2lHost && !/d2l\.pcc\.edu/.test(old.d2lHost)) cfg.site = old.d2lHost;   // d2l.pcc.edu never existed
    if (old.roleMatch) cfg.roles = R("pattern", `^(${old.roleMatch})$`);
    if (old.studentMatch) p.students = R("pattern", `^(${old.studentMatch})$`);
    if (old.itemMatch) p.items = R("pattern", old.itemMatch);
    if (old.termMatch) cfg.courses = R("pattern", old.termMatch);
    if (old.folder) p.folder = old.folder;
    p.gradesFile = "d2l.csv";                                // what the v2 converter flow expects
    p.rosterFile = "d2l_roster.csv";
    p.zero.enabled = old.zeroMissing !== false;
    cfg.run = { roster: !!old.roster, grades: old.grades !== false, outputs: {}, post: !!old.convert, week: old.week || "" };
    if (/comptia/i.test(old.itemMatch || "")) {
      // v2 only ever pulled the CompTIA course; keep it that way until you widen the course rule.
      cfg.courses = R("pattern", "CIS.?140L");
      p.post.pending = {
        label: "CompTIA → D2L converter",
        program: "convert.py",
        cwd: "{folder}/..",
        steps: "{comptia.labs} {grades} --quizzes {comptia.quizzes} --week {week} --table\n" +
               "{comptia.labs} {grades} --quizzes {comptia.quizzes} --week {week} --out d2l_import.csv",
        note: "From your v2 settings. Click Browse… to pick convert.py, then Save to approve it.",
      };
    }
    cfg.migratedFrom = 2;
    return cfg;
  }

  function normalize(stored) {
    if (!stored) return DEFAULTS();
    if (stored.schema === 3) {
      const d = DEFAULTS();
      const cfg = { ...d, ...stored, run: { ...d.run, ...(stored.run || {}) } };
      cfg.template = { ...PROFILE(), ...stored.template, zero: { ...PROFILE().zero, ...(stored.template?.zero || {}) }, post: { ...PROFILE().post, ...(stored.template?.post || {}) } };
      return cfg;
    }
    return migrateV2(stored);
  }

  const profileFor = (cfg, courseId) => cfg.profiles[courseId] || cfg.template;
  const hasOwnProfile = (cfg, courseId) => !!cfg.profiles[courseId];

  // ---- course selection ----------------------------------------------------------------
  function isCurrent(c, now = new Date().toISOString()) {
    return !!(c.start && c.start.slice(0, 19) <= now.slice(0, 19) && (!c.end || now.slice(0, 19) <= c.end.slice(0, 19)));
  }
  const courseText = (c) => `${c.code} ${c.name}`;

  // Returns { roles: [...], eligible: [courses after role+current filters], selected: [courses], errors }
  function selectCourses(cfg, courses) {
    const roleItems = [...new Set(courses.map((c) => c.role).filter(Boolean))].sort().map((r) => ({ id: r, name: r }));
    const roleSel = Select.apply(cfg.roles, roleItems);
    const eligible = courses.filter((c) => roleSel.selected.has(c.role) && (!cfg.currentOnly || isCurrent(c)) && c.canAccess !== false);
    const courseItems = eligible.map((c) => ({ id: c.id, name: c.name, text: courseText(c) }));
    const cs = Select.apply(cfg.courses, courseItems);
    return { roleItems, roleSel, eligible, selected: eligible.filter((c) => cs.selected.has(c.id)), courseSel: cs,
             errors: [roleSel.error, cs.error].filter(Boolean) };
  }

  // ---- weeks and placeholders --------------------------------------------------------------
  const weeksSince = (start, now = Date.now()) => (start ? Math.max(0, Math.floor((now - Date.parse(start)) / (7 * 864e5))) : 0);

  const safeSeg = (s) => String(s ?? "").replace(/[<>:"\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "").trim() || "_";
  function folderFor(template, course) {
    const vals = { course_code: course.code || course.id, course_name: course.name, course_id: course.id };
    return String(template || "")
      .replace(/\{(\w+)\}/g, (m, k) => (k in vals ? String(vals[k]).replace(/[\\/]/g, "_") : m))
      .replace(/\\/g, "/").split("/").map((s) => s.trim()).filter((s) => s && s !== "." && s !== "..").map(safeSeg).join("/");
  }

  // ---- linking add-on classes to D2L courses ----------------------------------------------
  // Auto: shared number of 4+ digits (a CRN or section number), else 1 class <-> 1 course.
  function autoLink(course, classes, courseCount) {
    const nums = new Set((`${course.code} ${course.name}`.match(/\d{4,}/g) || []));
    const hits = classes.filter((k) => (k.name.match(/\d{4,}/g) || []).some((x) => nums.has(x)));
    if (hits.length === 1) return hits[0];
    if (!hits.length && classes.length === 1 && courseCount === 1) return classes[0];
    return null;
  }
  function linkFor(cfg, course, addonId, classes, courseCount) {
    const want = profileFor(cfg, course.id).links?.[addonId] || "auto";
    if (want !== "auto") return classes.find((k) => k.id === want) || null;
    return autoLink(course, classes, courseCount);
  }

  // Shell-like split of one command line (handles "double" and 'single' quotes).
  function splitArgs(line) {
    const out = []; let cur = "", q = null, any = false;
    for (const ch of String(line)) {
      if (q) { if (ch === q) q = null; else cur += ch; continue; }
      if (ch === '"' || ch === "'") { q = ch; any = true; continue; }
      if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ""; any = false; continue; }
      cur += ch;
    }
    if (cur || any) out.push(cur);
    return out;
  }

  const api = { DEFAULTS, PROFILE, normalize, migrateV2, profileFor, hasOwnProfile, isCurrent, courseText,
                selectCourses, weeksSince, folderFor, autoLink, linkFor, splitArgs };
  root.Config = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
