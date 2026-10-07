// d2l-pull core: Brightspace (D2L) roster + CompTIA gradebook pull, in plain JS.
// Runs inside your logged-in Brightspace tab (injected by the extension), so
// requests carry your session automatically — no cookie handling at all.
// Also loadable in Node for testing (exports at the bottom).
//
// The grades file is written exactly like Brightspace's own Grades > Export
// (Key field: Both, Points), so CompTIA-D2L-Gradebook-Converter reads it as d2l.csv
// and its output can go straight back in through Grades > Import.

(function (root) {
  const DEFAULTS = {
    roster: true,
    grades: true,
    roleMatch: "Instructor",
    termMatch: "",
    studentMatch: "Student",
    itemMatch: "comptia.*(lab|quiz)|(lab|quiz).*comptia",
    zeroMissing: false,      // D2L leaves ungraded cells blank; 0 would be imported as a real grade
  };

  // Roster CSV: strings quoted, numbers bare (same as the Python script).
  const qcell = (v) => (typeof v === "number" ? String(v) : '"' + String(v ?? "").replace(/"/g, '""') + '"');
  // D2L export CSV: quote only when needed, CRLF line endings, trailing newline.
  const dcell = (v) => { const s = String(v ?? ""); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_");
  const n = (x) => String(Math.round(Number(x) * 1e6) / 1e6);

  // "<Name> Points Grade <Numeric MaxPoints:25 Weight:12.5 Category:CompTIA Labs CategoryWeight:25>"
  function d2lHeader(item, cat) {
    const meta = [`Numeric MaxPoints:${n(item.MaxPoints)}`];
    if (Number(item.Weight) > 0) meta.push(`Weight:${n(item.Weight)}`);
    if (cat) {
      meta.push(`Category:${cat.Name}`);
      if (Number(cat.Weight) > 0) meta.push(`CategoryWeight:${n(cat.Weight)}`);
    }
    return `${item.Name} Points Grade <${meta.join(" ")}>`;
  }

  async function d2lPull(userOpts = {}, deps = {}) {
    const o = { ...DEFAULTS, ...userOpts };
    if (o.mode) { o.roster = o.mode !== "grades"; o.grades = o.mode !== "roster"; }   // old option name
    const base = deps.base ?? (typeof location !== "undefined" ? location.origin : "");
    const log = deps.log ?? (() => {});
    const fetchFn = deps.fetch ?? fetch.bind(globalThis);
    if (!o.roster && !o.grades) return { courses: [], files: [] };

    async function api(pathOrUrl) {
      const url = pathOrUrl.startsWith("http") ? pathOrUrl : base + pathOrUrl;
      const r = await fetchFn(url, { credentials: "include" });
      if (!r.ok) {
        const hint = r.status === 401 || r.status === 403 ? " — are you logged in to Brightspace in that tab?" : "";
        throw new Error(`D2L HTTP ${r.status} for ${url.replace(base, "")}${hint}`);
      }
      return r.json();
    }

    // API versions
    let vers;
    try { vers = await api("/d2l/api/versions/"); }
    catch (e) { throw new Error("That tab doesn't look like Brightspace. (" + e.message + ")"); }
    const v = Object.fromEntries(vers.map((p) => [p.ProductCode, p.LatestVersion]));
    const lp = v.lp, le = v.le;

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
    log(`Current-term D2L courses you teach: ${courses.length}`);
    courses.forEach((c) => log(`  ${c.code || c.id} — ${c.name}`));

    const files = [];
    const itemRe = new RegExp(o.itemMatch, "i");
    const studentRe = new RegExp(o.studentMatch, "i");
    const multi = courses.length > 1;

    for (const c of courses) {
      const code = safeName(c.code || c.id);
      const tag = multi ? code + "_" : "";
      log(`Course ${code}`);
      const classlist = await api(`/d2l/api/le/${le}/${c.id}/classlist/`);

      if (o.roster) {
        const rows = [["OrgDefinedId", "Username", "FirstName", "LastName", "Email", "Role"].map(qcell).join(",")];
        for (const p of classlist)
          rows.push([p.OrgDefinedId || "", p.Username || "", p.FirstName || "", p.LastName || "",
                     p.Email || "", p.ClasslistRoleDisplayName || ""].map(qcell).join(","));
        files.push({ kind: "roster", courseId: c.id, courseName: c.name, path: `${tag}d2l_roster.csv`, csv: rows.join("\n") + "\n" });
        log(`  roster: ${classlist.length} people`);
      }

      if (o.grades) {
        // Only real numeric items: no category subtotals, calculated items or final grade.
        const items = await api(`/d2l/api/le/${le}/${c.id}/grades/`);
        const cats = Object.fromEntries((await api(`/d2l/api/le/${le}/${c.id}/grades/categories/`)).map((k) => [k.Id, k]));
        const sel = items.filter((i) => i.GradeType === "Numeric" &&
                                        itemRe.test(`${cats[i.CategoryId]?.Name || ""} ${i.Name}`));
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
        const rows = [["OrgDefinedId", "Username", ...sel.map((i) => d2lHeader(i, cats[i.CategoryId])), "End-of-Line Indicator"].map(dcell).join(",")];
        for (const s of students) {
          const vals = sel.map((i) => {
            const p = points.get(`${i.Id}|${s.Identifier}`);
            return p != null ? n(p) : o.zeroMissing ? "0" : "";
          });
          rows.push(["#" + (s.OrgDefinedId || ""), "#" + (s.Username || ""), ...vals, "#"].map(dcell).join(","));
        }
        files.push({ kind: "grades", courseId: c.id, courseName: c.name, path: `${tag}d2l.csv`, csv: rows.join("\r\n") + "\r\n" });
        log(`  grades: ${students.length} students`);
      }
    }
    return { courses, files };
  }

  root.d2lPull = d2lPull;
  root.D2L_DEFAULTS = DEFAULTS;
  if (typeof module !== "undefined") module.exports = { d2lPull, DEFAULTS, d2lHeader };
})(typeof globalThis !== "undefined" ? globalThis : this);
