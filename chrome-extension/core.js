// d2l-pull core: same logic as d2l_pull.py / d2l_pull.sh, in plain JS.
// Runs inside your logged-in Brightspace tab (injected by the extension), so
// requests carry your session automatically — no cookie handling at all.
// Also loadable in Node for testing (exports at the bottom).

(function (root) {
  const DEFAULTS = {
    mode: "both",                                   // roster | grades | both
    roleMatch: "Instructor",
    termMatch: "",
    studentMatch: "Student",
    itemMatch: "comptia.*(lab|quiz)|(lab|quiz).*comptia",
  };

  // CSV like Python's csv.QUOTE_NONNUMERIC: strings quoted, numbers bare.
  function csvCell(v) {
    if (typeof v === "number") return String(v);
    return '"' + String(v ?? "").replace(/"/g, '""') + '"';
  }
  const csvRow = (cells) => cells.map(csvCell).join(",");
  const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_");

  async function d2lPull(userOpts = {}, deps = {}) {
    const o = { ...DEFAULTS, ...userOpts };
    const base = deps.base ?? (typeof location !== "undefined" ? location.origin : "");
    const log = deps.log ?? (() => {});
    const fetchFn = deps.fetch ?? fetch.bind(globalThis);

    const doRoster = o.mode === "roster" || o.mode === "both";
    const doGrades = o.mode === "grades" || o.mode === "both";
    if (!doRoster && !doGrades) throw new Error(`Unknown mode '${o.mode}'`);

    async function api(pathOrUrl) {
      const url = pathOrUrl.startsWith("http") ? pathOrUrl : base + pathOrUrl;
      const r = await fetchFn(url, { credentials: "include" });
      if (!r.ok) {
        const hint = r.status === 401 || r.status === 403 ? " — are you logged in to Brightspace in this tab?" : "";
        throw new Error(`HTTP ${r.status} for ${url}${hint}`);
      }
      return r.json();
    }

    // API versions
    let vers;
    try { vers = await api("/d2l/api/versions/"); }
    catch (e) { throw new Error("This doesn't look like a Brightspace page. Open your D2L site and try again. (" + e.message + ")"); }
    const v = Object.fromEntries(vers.map((p) => [p.ProductCode, p.LatestVersion]));
    const lp = v.lp, le = v.le;
    log(`Mode: ${o.mode} (lp/${lp}, le/${le})`);

    // Current-term courses you teach
    const now = new Date().toISOString().slice(0, 19);
    const roleRe = new RegExp(o.roleMatch, "i");
    const termRe = o.termMatch ? new RegExp(o.termMatch, "i") : null;
    const courses = [];
    let bookmark = "";
    for (;;) {
      let q = "orgUnitTypeId=3&isActive=true";
      if (bookmark) q += "&bookmark=" + encodeURIComponent(bookmark);
      const page = await api(`/d2l/api/lp/${lp}/enrollments/myenrollments/?${q}`);
      for (const item of page.Items) {
        const acc = item.Access || {}, ou = item.OrgUnit;
        if (!roleRe.test(acc.ClasslistRoleName || "")) continue;
        const s = acc.StartDate, e = acc.EndDate;
        if (!(s && e && s.slice(0, 19) <= now && now <= e.slice(0, 19))) continue;  // current term only
        if (termRe && !termRe.test(`${ou.Code || ""} ${ou.Name}`)) continue;
        courses.push({ id: ou.Id, name: ou.Name, code: ou.Code });
      }
      if (!page.PagingInfo?.HasMoreItems) break;
      bookmark = page.PagingInfo.Bookmark;
    }
    log(`Current-term courses you teach: ${courses.length}`);
    courses.forEach((c) => log(`  ${c.code || c.id} — ${c.name}`));

    const files = [];
    const itemRe = new RegExp(o.itemMatch, "i");
    const studentRe = new RegExp(o.studentMatch, "i");

    for (const c of courses) {
      const code = safeName(c.code || c.id);
      log(`Course ${code}`);
      const classlist = await api(`/d2l/api/le/${le}/${c.id}/classlist/`);

      if (doRoster) {
        const rows = [csvRow(["OrgDefinedId", "Username", "FirstName", "LastName", "Email", "Role"])];
        for (const p of classlist)
          rows.push(csvRow([p.OrgDefinedId || "", p.Username || "", p.FirstName || "",
                            p.LastName || "", p.Email || "", p.ClasslistRoleDisplayName || ""]));
        files.push({ path: `rosters/${code}.csv`, csv: rows.join("\n") + "\n" });
        log(`  roster: ${classlist.length} people`);
      }

      if (doGrades) {
        // Only real numeric items: no category subtotals, calculated items or final grade.
        const items = await api(`/d2l/api/le/${le}/${c.id}/grades/`);
        const cats = Object.fromEntries(
          (await api(`/d2l/api/le/${le}/${c.id}/grades/categories/`)).map((k) => [k.Id, k.Name]));
        const sel = items.filter((i) => i.GradeType === "Numeric" &&
                                        itemRe.test(`${cats[i.CategoryId] || ""} ${i.Name}`));
        log(`  grades: ${sel.length} CompTIA lab/quiz items`);
        if (!sel.length) { log("  grades: skipped (no matching items — check the item filter)"); continue; }

        const points = new Map();   // "itemId|userId" -> points
        for (const i of sel) {
          let next = `/d2l/api/le/${le}/${c.id}/grades/${i.Id}/values/`;
          while (next) {
            const page = await api(next);
            for (const obj of page.Objects || []) {
              const gv = obj.GradeValue || {};
              if (gv.PointsNumerator != null) points.set(`${i.Id}|${obj.User.Identifier}`, gv.PointsNumerator);
            }
            next = page.Next || null;
          }
        }

        const students = classlist.filter((s) => studentRe.test(s.ClasslistRoleDisplayName || s.RoleName || ""));
        const rows = [csvRow(["OrgDefinedId", "Username", ...sel.map((i) => `${i.Name} Points Grade`), "End-of-Line Indicator"])];
        for (const s of students)
          rows.push(csvRow([s.OrgDefinedId || "", "#" + (s.Username || ""),
                            ...sel.map((i) => points.get(`${i.Id}|${s.Identifier}`) ?? 0),   // missing -> 0
                            "#"]));
        files.push({ path: `grades/${code}_comptia_grades.csv`, csv: rows.join("\n") + "\n" });
        log(`  grades: ${students.length} students`);
      }
    }
    return { courses, files };
  }

  root.d2lPull = d2lPull;
  root.D2L_DEFAULTS = DEFAULTS;
  if (typeof module !== "undefined") module.exports = { d2lPull, DEFAULTS };
})(typeof globalThis !== "undefined" ? globalThis : this);
