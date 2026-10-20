// D2L engine. Injected into the instructor's logged-in Brightspace tab, so every request
// uses their own session (nothing is copied or stored). Also loadable in Node for tests:
// pass deps.fetch / deps.base.
//
//   D2L.listCourses()                      -> your course enrollments (all roles, all terms)
//   D2L.courseInfo(courseId, {dues})       -> grade items (+ due dates), categories, classlist roles
//   D2L.pullCourse(courseId, spec)         -> { files: [{kind, csv}], log }
//
// The grades file is written exactly like Brightspace's own Grades > Export, so its
// output can be fed to other tools and re-imported through Grades > Import.

(function (root) {
  const TOOL_DROPBOX = 2000, TOOL_DISCUSSION = 3000;

  function client(deps = {}) {
    const base = deps.base ?? (typeof location !== "undefined" ? location.origin : "");
    const fetchFn = deps.fetch ?? fetch.bind(globalThis);
    let versions = null;
    async function get(pathOrUrl, { optional = false } = {}) {
      const url = pathOrUrl.startsWith("http") ? pathOrUrl : base + pathOrUrl;
      const r = await fetchFn(url, { credentials: "include" });
      if (!r.ok) {
        if (optional) return null;
        const hint = r.status === 401 || r.status === 403 ? " — are you logged in to Brightspace in that tab?" : "";
        throw new Error(`Brightspace ${r.status} for ${url.replace(base, "")}${hint}`);
      }
      return r.json();
    }
    async function v() {
      if (versions) return versions;
      let list;
      try { list = await get("/d2l/api/versions/"); }
      catch (e) { throw new Error("That tab doesn't look like Brightspace. (" + e.message + ")"); }
      const m = Object.fromEntries(list.map((p) => [p.ProductCode, p.LatestVersion]));
      return (versions = { lp: m.lp, le: m.le });
    }
    // Follow D2L's two paging styles: PagingInfo.Bookmark and ObjectListPage "Next".
    async function pagedItems(path) {
      const out = []; let bookmark = "";
      for (;;) {
        const sep = path.includes("?") ? "&" : "?";
        const page = await get(path + (bookmark ? `${sep}bookmark=${encodeURIComponent(bookmark)}` : ""));
        out.push(...(page.Items || []));
        if (!page.PagingInfo?.HasMoreItems) return out;
        bookmark = page.PagingInfo.Bookmark;
      }
    }
    async function objectPages(path, optional = false) {
      const out = []; let next = path;
      while (next) {
        const page = await get(next, { optional });
        if (!page) break;
        out.push(...(page.Objects || []));
        next = page.Next || null;
      }
      return out;
    }
    return { get, v, pagedItems, objectPages };
  }

  // ---- courses -------------------------------------------------------------------------
  async function listCourses(deps = {}) {
    const c = client(deps);
    const { lp } = await c.v();
    const items = await c.pagedItems(`/d2l/api/lp/${lp}/enrollments/myenrollments/`);
    // Course offerings only. The type comes with each enrollment (the org-unit-type lookup
    // API is closed to instructors at many schools).
    return items
      .filter((i) => !i.OrgUnit.Type || i.OrgUnit.Type.Code === "Course Offering")
      .map((i) => ({
        id: String(i.OrgUnit.Id), code: i.OrgUnit.Code || "", name: i.OrgUnit.Name,
        role: i.Access?.ClasslistRoleName || "", start: i.Access?.StartDate || null, end: i.Access?.EndDate || null,
        active: i.Access?.IsActive !== false, canAccess: i.Access?.CanAccess !== false,
      }));
  }

  // ---- course details ------------------------------------------------------------------
  async function courseInfo(courseId, opts = {}, deps = {}) {
    const c = client(deps);
    const { le } = await c.v();
    const P = `/d2l/api/le/${le}/${courseId}`;
    const [items, cats, classlist] = await Promise.all([
      c.get(`${P}/grades/`), c.get(`${P}/grades/categories/`), c.get(`${P}/classlist/`)]);
    const catById = Object.fromEntries(cats.map((k) => [String(k.Id), k]));

    // Due dates come from whatever the grade item is linked to (assignment folder,
    // discussion topic or quiz). Items with no linked due date get null.
    const due = {};
    if (opts.dues) {
      const [folders, quizzes, forums] = await Promise.all([
        c.get(`${P}/dropbox/folders/`, { optional: true }),
        c.objectPages(`${P}/quizzes/`, true),
        c.get(`${P}/discussions/forums/`, { optional: true })]);
      for (const f of folders || []) if (f.GradeItemId && f.DueDate) due[f.GradeItemId] = f.DueDate;
      for (const q of quizzes || []) if (q.GradeItemId && q.DueDate) due[q.GradeItemId] ??= q.DueDate;
      const topics = {};
      for (const f of forums || []) {
        for (const t of (await c.get(`${P}/discussions/forums/${f.ForumId}/topics/`, { optional: true })) || [])
          topics[t.TopicId] = t.DueDate || t.EndDate || null;
      }
      for (const i of items) {
        const t = i.AssociatedTool;
        if (!due[i.Id] && t?.ToolId === TOOL_DISCUSSION && topics[t.ToolItemId]) due[i.Id] = topics[t.ToolItemId];
        if (!due[i.Id] && t?.ToolId === TOOL_DROPBOX) { /* folder not readable: leave undated */ }
      }
    }

    return {
      items: items.map((i) => ({
        id: String(i.Id), name: i.Name, type: i.GradeType, categoryId: String(i.CategoryId || 0),
        category: catById[String(i.CategoryId)]?.Name || "", maxPoints: i.MaxPoints, weight: i.Weight,
        hidden: !!i.IsHidden, due: due[i.Id] || null,
      })),
      categories: cats.map((k) => ({ id: String(k.Id), name: k.Name, weight: k.Weight })),
      roles: [...new Set(classlist.map((p) => p.ClasslistRoleDisplayName || ""))].filter(Boolean).sort(),
      classlistCount: classlist.length,
    };
  }

  // ---- CSV helpers -----------------------------------------------------------------------
  const qcell = (v) => (typeof v === "number" ? String(v) : '"' + String(v ?? "").replace(/"/g, '""') + '"');
  const dcell = (v) => { const s = String(v ?? ""); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const n = (x) => String(Math.round(Number(x) * 1e6) / 1e6);
  const EXPORTABLE = new Set(["Numeric", "PassFail", "SelectBox"]);   // have a points value

  // "<Name> Points Grade <Numeric MaxPoints:25 Weight:12.5 Category:CompTIA Labs CategoryWeight:25>"
  function d2lHeader(item, cat) {
    const meta = [`${item.type || "Numeric"} MaxPoints:${n(item.maxPoints)}`];
    if (Number(item.weight) > 0) meta.push(`Weight:${n(item.weight)}`);
    if (cat) {
      meta.push(`Category:${cat.name}`);
      if (Number(cat.weight) > 0) meta.push(`CategoryWeight:${n(cat.weight)}`);
    }
    return `${item.name} Points Grade <${meta.join(" ")}>`;
  }

  const USER_COLS = { last: ["Last Name", (p) => p.LastName], first: ["First Name", (p) => p.FirstName], email: ["Email", (p) => p.Email] };

  // spec: { roster, grades, itemIds: [], studentRoles: [], keyField: "both"|"orgdefinedid"|"username",
  //         userCols: ["last","first","email"], zero: { enabled, cutoff: ISO|null, overrides: {itemId: "0"|"blank"} },
  //         info: <courseInfo result, optional> }
  async function pullCourse(courseId, spec, deps = {}) {
    const c = client(deps);
    const { le } = await c.v();
    const P = `/d2l/api/le/${le}/${courseId}`;
    const log = [], files = [];
    const classlist = await c.get(`${P}/classlist/`);

    if (spec.roster) {
      const rows = [["OrgDefinedId", "Username", "FirstName", "LastName", "Email", "Role"].map(qcell).join(",")];
      for (const p of classlist)
        rows.push([p.OrgDefinedId || "", p.Username || "", p.FirstName || "", p.LastName || "", p.Email || "",
                   p.ClasslistRoleDisplayName || ""].map(qcell).join(","));
      files.push({ kind: "roster", csv: rows.join("\n") + "\n" });
      log.push(`roster: ${classlist.length} people`);
    }

    if (spec.grades) {
      const info = spec.info || (await courseInfo(courseId, { dues: !!spec.zero?.enabled }, deps));
      const cats = Object.fromEntries(info.categories.map((k) => [k.id, k]));
      const want = new Set((spec.itemIds || []).map(String));
      const sel = info.items.filter((i) => want.has(i.id) && EXPORTABLE.has(i.type));
      const skipped = info.items.filter((i) => want.has(i.id) && !EXPORTABLE.has(i.type)).length;
      log.push(`grades: ${sel.length} items` + (skipped ? ` (${skipped} calculated/text items skipped)` : ""));
      if (!sel.length) { log.push("grades: nothing to export — no grade items selected"); return { files, log }; }

      const points = new Map();   // "itemId|userId" -> points
      for (const i of sel)
        for (const obj of await c.objectPages(`${P}/grades/${i.id}/values/`)) {
          const gv = obj.GradeValue || {};
          if (gv.PointsNumerator != null) points.set(`${i.id}|${obj.User.Identifier}`, gv.PointsNumerator);
        }

      // Missing grades: per-item override, else 0 once the item's due date has passed.
      const z = spec.zero || {};
      const cutoff = z.cutoff ? Date.parse(z.cutoff) : Date.now();
      const fill = sel.map((i) => {
        const o = z.overrides?.[i.id];
        if (o === "0") return true;
        if (o === "blank") return false;
        return !!z.enabled && !!i.due && Date.parse(i.due) <= cutoff;
      });
      if (z.enabled || Object.keys(z.overrides || {}).length)
        log.push(`grades: missing -> 0 in ${fill.filter(Boolean).length} of ${sel.length} columns (due by ${new Date(cutoff).toLocaleDateString()})`);

      const roles = new Set(spec.studentRoles || ["Student"]);
      const students = classlist.filter((p) => roles.has(p.ClasslistRoleDisplayName || ""));
      const keyCols = spec.keyField === "orgdefinedid" ? ["OrgDefinedId"] : spec.keyField === "username" ? ["Username"] : ["OrgDefinedId", "Username"];
      const extra = (spec.userCols || []).filter((k) => USER_COLS[k]);
      const header = [...keyCols, ...extra.map((k) => USER_COLS[k][0]), ...sel.map((i) => d2lHeader(i, cats[i.categoryId])), "End-of-Line Indicator"];
      const rows = [header.map(dcell).join(",")];
      for (const s of students) {
        const keys = keyCols.map((k) => "#" + ((k === "OrgDefinedId" ? s.OrgDefinedId : s.Username) || ""));
        const vals = sel.map((i, k) => {
          const p = points.get(`${i.id}|${s.Identifier}`);
          return p != null ? n(p) : fill[k] ? "0" : "";
        });
        rows.push([...keys, ...extra.map((k) => USER_COLS[k][1](s) || ""), ...vals, "#"].map(dcell).join(","));
      }
      files.push({ kind: "grades", csv: rows.join("\r\n") + "\r\n" });
      log.push(`grades: ${students.length} students`);
    }
    return { files, log };
  }

  const api = { listCourses, courseInfo, pullCourse, d2lHeader };
  root.D2L = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
