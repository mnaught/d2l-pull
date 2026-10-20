#!/usr/bin/env python3
"""
d2l_pull.py: command-line version of the D2L Pull extension (v3).

Downloads Brightspace (D2L) rosters and grades for your courses and, optionally, runs a
post-processing command on them. Uses the same selection rules and output format as the
extension, and can read a settings file exported from it (Settings → Backup → Export).
Python 3.8+, standard library only.

AUTH: copy two cookies from your logged-in browser (DevTools → Application → Cookies):
    export D2L_SESSION='…d2lSessionVal…'   D2L_SECURE='…d2lSecureSessionVal…'

DISCOVER:
    python3 d2l_pull.py --host https://online.school.edu --list-courses
    python3 d2l_pull.py --host … --list-items 123456

PULL (examples):
    python3 d2l_pull.py --host … --grades --courses-pattern 'CIS.?140L' \\
        --items-pattern '^(CompTIA Labs|CompTIA Quizzes)\\b' --out ~/grades
    python3 d2l_pull.py --profile d2l-pull-settings.json --grades --roster \\
        --then 'python3 convert.py comptia_labs.csv {grades} --week {week} --out d2l_import.csv'

SELECTION RULES (same as the extension's Pick/Pattern lists):
    --X-pattern REGEX   select what matches (case-insensitive)
    --X ID,ID,…         also select these     --exclude-X ID,ID,…   but not these
    X = roles (your enrollment role), courses, items (grade items, tested on "category name"),
        students (classlist roles). Course ids/item ids come from --list-courses / --list-items.

MISSING GRADES: 0 once the item's due date has passed (--no-zero to leave blank,
--cutoff YYYY-MM-DD to use another date than today).

--then COMMAND runs once per course in that course's folder. Placeholders:
    {grades} {roster} {folder} {week} {course_code} {course_id} {course_name}
"""
import argparse
import csv
import io
import json
import os
import re
import shlex
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

EXPORTABLE = {"Numeric", "PassFail", "SelectBox"}


# ---- selection rules (mirror of chrome-extension/lib/select.js) ----------------------------
def rule(mode="pattern", pattern="", include=(), exclude=()):
    return {"mode": mode, "pattern": pattern, "include": [{"id": str(i), "name": str(i)} for i in include],
            "exclude": [{"id": str(i), "name": str(i)} for i in exclude]}


def _refs(refs, items):
    ids, by_name = set(), set()
    index = {str(it["id"]): it for it in items}
    for r in refs or []:
        if str(r.get("id")) in index:
            ids.add(str(r["id"]))
            continue
        hit = next((it for it in items if it["name"] == r.get("name")), None)
        if hit:
            ids.add(str(hit["id"]))
            by_name.add(str(hit["id"]))
    return ids, by_name


def apply_rule(r, items):
    """items: [{id, name, text?}] -> set of selected ids"""
    r = r or rule()
    inc, _ = _refs(r.get("include"), items)
    if r.get("mode") == "pick":
        return inc
    try:
        rx = re.compile(r["pattern"], re.I) if r.get("pattern") else None
    except re.error as e:
        sys.exit(f"Invalid pattern {r['pattern']!r}: {e}")
    exc, _ = _refs(r.get("exclude"), items)
    matched = {str(it["id"]) for it in items if rx and rx.search(it.get("text") or it["name"])}
    return (matched | inc) - (exc - inc)


def cli_rule(args, name, base):
    """Build a rule from --name-pattern / --name / --exclude-name, falling back to `base`."""
    pat, inc, exc = getattr(args, f"{name}_pattern"), getattr(args, name), getattr(args, f"exclude_{name}")
    if pat is None and inc is None and exc is None:
        return base
    split = lambda s: [x.strip() for x in (s or "").split(",") if x.strip()]
    if pat is None and inc is not None:
        return rule("pick", "", [i for i in split(inc) if i not in split(exc)])
    return rule("pattern", pat or "", split(inc), split(exc))


# ---- Brightspace client ---------------------------------------------------------------------
class D2L:
    def __init__(self, host, session, secure):
        self.host = host.rstrip("/")
        self.cookie = f"d2lSessionVal={session}; d2lSecureSessionVal={secure}"
        self._v = None

    def get(self, path, optional=False):
        url = path if path.startswith("http") else self.host + path
        req = urllib.request.Request(url, headers={"Cookie": self.cookie})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if optional:
                return None
            hint = " — session cookies missing or expired?" if e.code in (401, 403) else ""
            sys.exit(f"HTTP {e.code} for {url}{hint}")

    def v(self):
        if not self._v:
            m = {p["ProductCode"]: p["LatestVersion"] for p in self.get("/d2l/api/versions/")}
            self._v = (m["lp"], m["le"])
        return self._v

    def paged_items(self, path):
        out, bm = [], ""
        while True:
            sep = "&" if "?" in path else "?"
            page = self.get(path + (f"{sep}bookmark={urllib.parse.quote(bm)}" if bm else ""))
            out += page.get("Items", [])
            if not page.get("PagingInfo", {}).get("HasMoreItems"):
                return out
            bm = page["PagingInfo"]["Bookmark"]

    def object_pages(self, path, optional=False):
        out, nxt = [], path
        while nxt:
            page = self.get(nxt, optional)
            if not page:
                break
            out += page.get("Objects", [])
            nxt = page.get("Next")
        return out

    def courses(self):
        lp, _ = self.v()
        out = []
        for i in self.paged_items(f"/d2l/api/lp/{lp}/enrollments/myenrollments/"):
            ou, acc = i["OrgUnit"], i.get("Access") or {}
            if ou.get("Type") and ou["Type"].get("Code") != "Course Offering":
                continue
            out.append({"id": str(ou["Id"]), "code": ou.get("Code") or "", "name": ou["Name"], "role": acc.get("ClasslistRoleName") or "",
                        "start": acc.get("StartDate"), "end": acc.get("EndDate"), "canAccess": acc.get("CanAccess", True)})
        return out

    def course_info(self, cid, dues=True):
        _, le = self.v()
        P = f"/d2l/api/le/{le}/{cid}"
        items, cats, classlist = self.get(f"{P}/grades/"), self.get(f"{P}/grades/categories/"), self.get(f"{P}/classlist/")
        cat = {str(k["Id"]): k for k in cats}
        due = {}
        if dues:
            for f in self.get(f"{P}/dropbox/folders/", True) or []:
                if f.get("GradeItemId") and f.get("DueDate"):
                    due[f["GradeItemId"]] = f["DueDate"]
            for q in self.object_pages(f"{P}/quizzes/", True):
                if q.get("GradeItemId") and q.get("DueDate"):
                    due.setdefault(q["GradeItemId"], q["DueDate"])
            topics = {}
            for f in self.get(f"{P}/discussions/forums/", True) or []:
                for t in self.get(f"{P}/discussions/forums/{f['ForumId']}/topics/", True) or []:
                    topics[t["TopicId"]] = t.get("DueDate") or t.get("EndDate")
            for i in items:
                t = i.get("AssociatedTool") or {}
                if i["Id"] not in due and t.get("ToolId") == 3000 and topics.get(t.get("ToolItemId")):
                    due[i["Id"]] = topics[t["ToolItemId"]]
        return {
            "items": [{"id": str(i["Id"]), "name": i["Name"], "type": i["GradeType"], "categoryId": str(i.get("CategoryId") or 0),
                       "category": (cat.get(str(i.get("CategoryId"))) or {}).get("Name", ""), "maxPoints": i.get("MaxPoints"),
                       "weight": i.get("Weight"), "due": due.get(i["Id"])} for i in items],
            "categories": [{"id": str(k["Id"]), "name": k["Name"], "weight": k.get("Weight")} for k in cats],
            "roles": sorted({p.get("ClasslistRoleDisplayName") or "" for p in classlist} - {""}),
            "classlist": classlist,
        }


# ---- output (same bytes as the extension) -------------------------------------------------
def num(x):
    v = round(float(x) * 1e6) / 1e6
    return str(int(v)) if v == int(v) else repr(v)


def dcell(v):
    s = "" if v is None else str(v)
    return '"' + s.replace('"', '""') + '"' if re.search(r'[",\r\n]', s) else s


def header(item, cat):
    meta = [f"{item['type'] or 'Numeric'} MaxPoints:{num(item['maxPoints'])}"]
    if (item.get("weight") or 0) > 0:
        meta.append(f"Weight:{num(item['weight'])}")
    if cat:
        meta.append(f"Category:{cat['name']}")
        if (cat.get("weight") or 0) > 0:
            meta.append(f"CategoryWeight:{num(cat['weight'])}")
    return f"{item['name']} Points Grade <{' '.join(meta)}>"


USER_COLS = {"last": ("Last Name", "LastName"), "first": ("First Name", "FirstName"), "email": ("Email", "Email")}


def grades_csv(d2l, cid, info, item_ids, student_roles, key="both", user_cols=(), zero=True, cutoff=None, overrides=None):
    _, le = d2l.v()
    cats = {k["id"]: k for k in info["categories"]}
    sel = [i for i in info["items"] if i["id"] in item_ids and i["type"] in EXPORTABLE]
    points = {}
    for i in sel:
        for obj in d2l.object_pages(f"/d2l/api/le/{le}/{cid}/grades/{i['id']}/values/"):
            gv = obj.get("GradeValue") or {}
            if gv.get("PointsNumerator") is not None:
                points[(i["id"], str(obj["User"]["Identifier"]))] = gv["PointsNumerator"]
    limit = cutoff or datetime.now(timezone.utc)
    overrides = overrides or {}

    def fill(i):
        o = overrides.get(i["id"])
        if o in ("0", "blank"):
            return o == "0"
        return zero and bool(i["due"]) and datetime.fromisoformat(i["due"].replace("Z", "+00:00")) <= limit

    fills = [fill(i) for i in sel]
    keys = {"orgdefinedid": ["OrgDefinedId"], "username": ["Username"]}.get(key, ["OrgDefinedId", "Username"])
    extra = [c for c in user_cols if c in USER_COLS]
    rows = [[*keys, *(USER_COLS[c][0] for c in extra), *(header(i, cats.get(i["categoryId"])) for i in sel), "End-of-Line Indicator"]]
    students = [p for p in info["classlist"] if (p.get("ClasslistRoleDisplayName") or "") in student_roles]
    for s in students:
        vals = []
        for i, f in zip(sel, fills):
            p = points.get((i["id"], str(s["Identifier"])))
            vals.append(num(p) if p is not None else "0" if f else "")
        rows.append([*("#" + (s.get(k) or "") for k in keys), *((s.get(USER_COLS[c][1]) or "") for c in extra), *vals, "#"])
    return "\r\n".join(",".join(dcell(v) for v in r) for r in rows) + "\r\n", len(sel), len(students)


def roster_csv(classlist):
    out = io.StringIO()
    w = csv.writer(out, quoting=csv.QUOTE_NONNUMERIC, lineterminator="\n")
    w.writerow(["OrgDefinedId", "Username", "FirstName", "LastName", "Email", "Role"])
    for p in classlist:
        w.writerow([p.get(k) or "" for k in ("OrgDefinedId", "Username", "FirstName", "LastName", "Email", "ClasslistRoleDisplayName")])
    return out.getvalue()


def folder_for(template, c):
    vals = {"course_code": c["code"] or c["id"], "course_name": c["name"], "course_id": c["id"]}
    s = re.sub(r"\{(\w+)\}", lambda m: re.sub(r"[\\/]", "_", vals.get(m.group(1), m.group(0))), template or "")
    parts = [re.sub(r'[<>:"|?*\x00-\x1f]', "_", p.strip()).rstrip(". ") or "_" for p in re.split(r"[\\/]", s) if p.strip() not in ("", ".", "..")]
    return Path(*parts) if parts else Path(".")


def is_current(c, now):
    return bool(c["start"]) and c["start"][:19] <= now <= (c["end"] or "9999")[:19]


# ---- main -------------------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", help="Brightspace address, e.g. https://online.school.edu (or D2L_HOST)")
    ap.add_argument("--profile", help="settings file exported from the extension")
    ap.add_argument("--list-courses", action="store_true")
    ap.add_argument("--list-items", metavar="COURSE_ID")
    ap.add_argument("--grades", action="store_true")
    ap.add_argument("--roster", action="store_true")
    ap.add_argument("--out", default=".", help="base folder (course folders go inside; default: current folder)")
    ap.add_argument("--folder", help="per-course folder template (default: profile's, else {course_code})")
    ap.add_argument("--all-dates", action="store_true", help="don't limit to courses whose dates include today")
    for n in ("roles", "courses", "items", "students"):
        ap.add_argument(f"--{n}-pattern")
        ap.add_argument(f"--{n}")
        ap.add_argument(f"--exclude-{n}")
    ap.add_argument("--key", choices=["both", "orgdefinedid", "username"])
    ap.add_argument("--user-cols", help="comma list of last,first,email")
    ap.add_argument("--no-zero", action="store_true", help="leave missing grades blank")
    ap.add_argument("--cutoff", help="zero-fill items due before this date (YYYY-MM-DD; default now)")
    ap.add_argument("--week", type=int, help="value for {week} (default: weeks since the course started)")
    ap.add_argument("--then", help="command to run per course after downloading")
    args = ap.parse_args()

    cfg = json.loads(Path(args.profile).read_text()) if args.profile else {}
    host = args.host or os.environ.get("D2L_HOST") or cfg.get("site")
    if not host:
        sys.exit("Give --host (or D2L_HOST, or --profile with a site).")
    d2l = D2L(host, os.environ.get("D2L_SESSION", ""), os.environ.get("D2L_SECURE", ""))

    courses = d2l.courses()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    if args.list_courses:
        for c in courses:
            print(f"{c['id']:>8}  {'*' if is_current(c, now) else ' '} {c['role'][:18]:<18} {c['code']:<28} {c['name']}")
        print("\n* = current (dates include today)")
        return
    if args.list_items:
        info = d2l.course_info(args.list_items)
        for i in info["items"]:
            print(f"{i['id']:>8}  {i['type']:<10} {str(i['maxPoints'] or ''):>6}  due {(i['due'] or '-')[:10]:<10}  {i['category'] or '-'} / {i['name']}")
        print("\nclasslist roles:", ", ".join(info["roles"]))
        return
    if not (args.grades or args.roster):
        sys.exit("Nothing to do: add --grades and/or --roster (or --list-courses / --list-items).")

    roles_rule = cli_rule(args, "roles", cfg.get("roles") or rule("pick", "", ["Instructor"]))
    course_rule = cli_rule(args, "courses", cfg.get("courses") or rule("pattern", ".*"))
    current_only = not args.all_dates and cfg.get("currentOnly", True)
    roles = sorted({c["role"] for c in courses if c["role"]})
    role_ok = apply_rule(roles_rule, [{"id": r, "name": r} for r in roles])
    eligible = [c for c in courses if c["role"] in role_ok and (not current_only or is_current(c, now)) and c["canAccess"] is not False]
    chosen = apply_rule(course_rule, [{"id": c["id"], "name": c["name"], "text": f"{c['code']} {c['name']}"} for c in eligible])
    selected = [c for c in eligible if c["id"] in chosen]
    if not selected:
        sys.exit("No courses selected. Try --list-courses, then --courses ID or --courses-pattern.")
    print(f"{len(selected)} course(s): {', '.join(c['code'] or c['name'] for c in selected)}")

    cutoff = datetime.fromisoformat(args.cutoff).replace(tzinfo=timezone.utc) if args.cutoff else None
    for c in selected:
        prof = (cfg.get("profiles") or {}).get(c["id"]) or cfg.get("template") or {}
        folder = Path(args.out) / folder_for(args.folder or prof.get("folder") or "{course_code}", c)
        folder.mkdir(parents=True, exist_ok=True)
        print(f"\n{c['code'] or c['name']}  ->  {folder}")
        zero_cfg = prof.get("zero") or {}
        info = d2l.course_info(c["id"], dues=not args.no_zero)
        files = {}
        if args.roster:
            f = folder / (prof.get("rosterFile") or "d2l_roster.csv")
            f.write_text(roster_csv(info["classlist"]), encoding="utf-8", newline="")
            files["roster"] = f
            print(f"  roster: {len(info['classlist'])} people -> {f.name}")
        if args.grades:
            item_rule = cli_rule(args, "items", prof.get("items") or rule("pattern", ".*"))
            student_rule = cli_rule(args, "students", prof.get("students") or rule("pick", "", ["Student"]))
            items = [{"id": i["id"], "name": i["name"], "text": f"{i['category']} {i['name']}"} for i in info["items"]]
            item_ids = apply_rule(item_rule, items)
            student_roles = apply_rule(student_rule, [{"id": r, "name": r} for r in info["roles"]])
            overrides = {k: v.get("mode") for k, v in (zero_cfg.get("overrides") or {}).items()}
            if not any(i["id"] in item_ids and i["type"] in EXPORTABLE for i in info["items"]):
                print("  grades: nothing to export — no grade items selected (see --list-items)")
                continue
            text, n_items, n_students = grades_csv(
                d2l, c["id"], info, item_ids, student_roles, key=args.key or prof.get("keyField", "both"),
                user_cols=(args.user_cols.split(",") if args.user_cols else prof.get("userCols") or []),
                zero=not args.no_zero and zero_cfg.get("enabled", True), cutoff=cutoff, overrides=overrides)
            f = folder / (prof.get("gradesFile") or "d2l_grades.csv")
            f.write_bytes(text.encode("utf-8"))
            files["grades"] = f
            print(f"  grades: {n_items} items, {n_students} students -> {f.name}")
        if args.then:
            start = c["start"]
            week = args.week if args.week else (max(0, (datetime.now(timezone.utc) - datetime.fromisoformat(start.replace("Z", "+00:00"))).days // 7) if start else 0)
            vals = {"week": str(week), "folder": str(folder.resolve()), "course_code": c["code"], "course_id": c["id"], "course_name": c["name"],
                    **{k: str(p.resolve()) for k, p in files.items()}}
            argv = [re.sub(r"\{(\w+)\}", lambda m: vals.get(m.group(1), m.group(0)), t) for t in shlex.split(args.then)]
            print("  running:", " ".join(shlex.quote(a) for a in argv))
            r = subprocess.run(argv, cwd=str(folder))
            if r.returncode:
                print(f"  command exited with {r.returncode}")


if __name__ == "__main__":
    main()
