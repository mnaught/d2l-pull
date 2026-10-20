// CompTIA CertMaster (platform.comptia.org) pull.
// Runs inside your logged-in CompTIA tab (injected by the extension). It uses the
// same login token the page itself uses, so nothing is copied or stored.
// Produces the two files CompTIA-D2L-Gradebook-Converter expects:
//   labs    = the Class Gradebook export with "Show scores as points"
//   quizzes = your custom quizzes report export
// Also loadable in Node for testing (exports at the bottom).

(function (root) {
  const API = "https://api.platform.comptia.org/api/v1";
  const COMPTIA_DEFAULTS = { quizReportMatch: "quiz" };

  // ---- CSV writers matching CompTIA's own exports byte-for-byte ------------------
  // (Verified 2026-10-07 against real "Class Gradebook" and custom-report downloads.)
  const q = (s) => '"' + String(s ?? "").replace(/"/g, '""') + '"';
  const num = (v) => String(Math.round(Number(v) * 100) / 100);   // 18.00000 -> 18, 17.6666700 -> 17.67

  // Lab gradebook export: LF line endings, first header bare, other headers and the
  // Points Possible row quoted, student scores bare numbers, no trailing newline.
  function labsCsv(labs, students) {
    const lines = [
      ["Student", ...labs.map((l) => q(`Lab - ${l.resourceIndex} ${l.resourceTitle}`))].join(","),
      [q("Points Possible"), ...labs.map((l) => q(l.pointsPossible))].join(","),
      ...students.map((s) => [q(s.name), ...labs.map((l) => num(s.scores[l.resourceId] ?? 0))].join(",")),
    ];
    return lines.join("\n");
  }

  // Custom report export: CRLF line endings, every field quoted, no trailing newline.
  function quizzesCsv(columns, rows) {
    return rows.map((r) => r.map(q).join(",")).join("\r\n");
  }

  const cmpIndex = (a, b) => {
    const x = a.split(".").map(Number), y = b.split(".").map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
    return 0;
  };
  const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_|_$/g, "");

  function decodeJwt(tok) {
    const b64 = tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("utf8"));
  }

  // o: { labs, quizzes, quizReportMatch, classIds?: [...] (only these classes), listOnly?: true }
  async function comptiaPull(userOpts = {}, deps = {}) {
    const o = { ...COMPTIA_DEFAULTS, ...userOpts };
    const log = deps.log ?? (() => {});
    const fetchFn = deps.fetch ?? fetch.bind(globalThis);
    const token = deps.token ?? (typeof localStorage !== "undefined" ? localStorage.getItem("jwt-labSimUser") : null);
    if (!token) throw new Error("Not signed in to CompTIA in this tab — log in at platform.comptia.org and try again.");

    const claims = decodeJwt(token);
    if (claims.exp && claims.exp * 1000 < Date.now())
      throw new Error("Your CompTIA login has expired — refresh the CompTIA tab (log in again if asked) and retry.");
    const userId = claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"] || claims.sub;
    const campuses = String(claims.TeacherAtCampuses || "").split(/[,;\s]+/).filter(Boolean);
    if (!campuses.length) throw new Error("This CompTIA account isn't a teacher at any campus.");

    async function api(path) {
      const sep = path.includes("?") ? "&" : "?";
      const r = await fetchFn(API + path + sep + "cacheBust=" + Date.now(), { headers: { Authorization: "Bearer " + token } });
      if (!r.ok) {
        const hint = r.status === 401 ? " — refresh the CompTIA tab to renew your login" : "";
        throw new Error(`CompTIA API ${r.status} for ${path.split("?")[0]}${hint}`);
      }
      return r.json();
    }

    // Current classes you teach
    const now = new Date().toISOString();
    const classes = [];
    for (const campus of campuses) {
      for (const c of await api(`/campuses/${campus}/campusclasses`)) {
        const cp = c.classProfile || {};
        if (cp.deletedDateUtc || cp.archiveDateUtc) continue;
        if (!(cp.startDateUtc <= now && now <= cp.endDateUtc)) continue;           // current term only
        if (c.teachers && !JSON.stringify(c.teachers).includes(userId)) continue; // yours only
        classes.push({ id: cp.classProfileId, name: cp.name, start: cp.startDateUtc, end: cp.endDateUtc });
      }
    }
    if (o.listOnly) return { classes, files: [] };
    const wanted = o.classIds ? classes.filter((c) => o.classIds.includes(c.id)) : classes;
    log(`${wanted.length} CompTIA class(es)`);

    const files = [];
    for (const c of wanted) {
      const tag = "";
      log(c.name);

      if (o.labs) {
        const products = await api(`/class/${c.id}/courses/selection-options`);
        if (!products.length) { log("  labs: skipped (no course assigned)"); }
        for (const p of products) {
          // Every lab in the course, in course order (same columns as the CompTIA export)
          const map = await api(`/resources/versions/${p.id}/2/map`);
          const labs = Object.values(map)
            .filter((r) => r.resourceType === 3 && r.resourceSubType === 5)
            .sort((a, b) => cmpIndex(a.resourceIndex, b.resourceIndex));

          // Highest score per student per resource, as points
          const students = [];
          for (let page = 1; ; page++) {
            const gb = await api(`/reportData/gradebookData/${c.id}/${p.id}/paged?filter=Highest&page=${page}`);
            const idx = Object.fromEntries(Object.entries(gb.value.idToResource || {}).map(([i, x]) => [i, x.resourceId]));
            for (const r of gb.value.results || []) {
              const scores = {};
              for (const [i, d] of Object.entries(r.resultData || {})) scores[idx[i]] = d.scores?.points ?? 0;
              students.push({ name: r.nameDisplay, scores });
            }
            if (!gb.hasMore) break;
          }
          // Rows stay in API order — that is the order CompTIA's own export uses.
          const ptag = products.length > 1 ? safeName(p.name) + "_" : "";
          files.push({ kind: "labs", classId: c.id, className: c.name, path: `${tag}${ptag}comptia_labs.csv`, csv: labsCsv(labs, students) });
          log(`  labs: ${labs.length} labs, ${students.length} students (${p.name})`);
        }
      }

      if (o.quizzes) {
        const reps = (await api(`/customreports/classes/${c.id}/${userId}?page=1&search=`)).map((x) => x.customReport || x);
        const re = new RegExp(o.quizReportMatch || "quiz", "i");
        const rep = reps.find((x) => re.test(x.name)) || null;
        if (!rep) {
          log(`  quizzes: skipped — no custom report with "${o.quizReportMatch}" in its name (found: ${reps.map((x) => x.name).join(", ") || "none"})`);
        } else {
          const cols = await api(`/customreports/${rep.customReportId}/${userId}/resources`);
          const title = Object.fromEntries(cols.map((x) => [x.field, x.headerName || x.resourceTitle || x.field]));
          const data = await api(`/customreports/${rep.customReportId}/${userId}?showZero=true&showScoreTimeAttempts=show_points` +
                                 `&scoreStats=show_high_scores&currentDisplay=all_items&requestingUserId=${userId}`);
          const header = data[0].map((cell) => (cell.header === "name" ? "Name" : title[cell.header] || cell.header));
          const pointsRow = data[0].map((cell) => cell.value);
          const studentRows = data.slice(1)
            .map((r) => r.map((cell, i) => (i === 0 ? cell.value : cell.value == null || cell.value === "" ? "" : num(cell.value))));
          files.push({ kind: "quizzes", classId: c.id, className: c.name, path: `${tag}comptia_quizzes.csv`,
                       csv: quizzesCsv(header, [header, pointsRow, ...studentRows]) });
          log(`  quizzes: ${header.length - 1} quizzes, ${studentRows.length} students ("${rep.name}")`);
        }
      }
    }
    return { classes, files };
  }

  root.comptiaPull = comptiaPull;
  root.COMPTIA_DEFAULTS = COMPTIA_DEFAULTS;
  if (typeof module !== "undefined") module.exports = { comptiaPull, COMPTIA_DEFAULTS, labsCsv, quizzesCsv };
})(typeof globalThis !== "undefined" ? globalThis : this);
