#!/usr/bin/env python3
"""
Pull class rosters and/or CompTIA gradebook exports for every current-term
Brightspace (D2L) course you teach.  Python port of d2l_pull.sh — standard
library only, no pip installs needed (Python 3.8+).

Usage:
  python3 d2l_pull.py roster     # class rosters only           -> rosters/<course>.csv
  python3 d2l_pull.py grades     # CompTIA lab/quiz grades only  -> grades/<course>_comptia_grades.csv
  python3 d2l_pull.py both       # both (default)
  (or set MODE=roster|grades|both instead of passing an argument)

Grades export mirrors Grades > Export with:
  Key field: Both (OrgDefinedId + Username)   Grade values: Points
  Grade items: CompTIA labs and quizzes only   No subtotals / categories / final grade
  Missing grades exported as 0
  D2L import-compatible layout ("<Item> Points Grade", "#username", End-of-Line Indicator)

Auth: reuses your logged-in browser session (no admin-registered OAuth app needed).
  1. Log into Brightspace in your browser.
  2. DevTools (F12) -> Application/Storage -> Cookies -> your D2L host.
  3. Copy the values of d2lSessionVal and d2lSecureSessionVal below (or set
     D2L_SESSION / D2L_SECURE environment variables).
Session cookies expire when you log out / time out — just grab fresh ones.

Optional settings (environment variables):
  D2L_HOST       Brightspace URL                         (default https://d2l.pcc.edu)
  ROLE_MATCH     your role in courses you teach          (default Instructor)
  TERM_MATCH     text in course code/name for the term   (default: use course dates)
  STUDENT_MATCH  classlist roles included in grades      (default Student)
  ITEM_MATCH     regex for grade items to export         (default CompTIA + lab|quiz)
  ROSTER_OUT / GRADES_OUT  output folders                (default rosters / grades)
"""

import csv
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HOST = os.environ.get("D2L_HOST", "https://d2l.pcc.edu").rstrip("/")
SESSION = os.environ.get("D2L_SESSION", "PASTE_d2lSessionVal")
SECURE = os.environ.get("D2L_SECURE", "PASTE_d2lSecureSessionVal")
ROLE_MATCH = os.environ.get("ROLE_MATCH", "Instructor")
TERM_MATCH = os.environ.get("TERM_MATCH", "")
STUDENT_MATCH = os.environ.get("STUDENT_MATCH", "Student")
ITEM_MATCH = os.environ.get("ITEM_MATCH", r"comptia.*(lab|quiz)|(lab|quiz).*comptia")
ROSTER_OUT = Path(os.environ.get("ROSTER_OUT", "rosters"))
GRADES_OUT = Path(os.environ.get("GRADES_OUT", "grades"))

COOKIE = f"d2lSessionVal={SESSION}; d2lSecureSessionVal={SECURE}"
MODES = {
    "roster": (True, False), "rosters": (True, False),
    "grades": (False, True), "grade": (False, True), "gradebook": (False, True),
    "both": (True, True), "all": (True, True),
}


def api(path_or_url, auth=True):
    """GET a D2L API path ("/d2l/api/...") or full URL; return parsed JSON."""
    url = path_or_url if path_or_url.startswith("http") else HOST + path_or_url
    req = urllib.request.Request(url, headers={"Cookie": COOKIE} if auth else {})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        hint = " — session cookies missing or expired?" if e.code in (401, 403) else ""
        sys.exit(f"HTTP {e.code} for {url}{hint}")


def latest_versions():
    vers = api("/d2l/api/versions/", auth=False)
    v = {p["ProductCode"]: p["LatestVersion"] for p in vers}
    return v["lp"], v["le"]


def current_courses(lp):
    """Current-term courses where your role matches ROLE_MATCH."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    role_re = re.compile(ROLE_MATCH, re.I)
    term_re = re.compile(TERM_MATCH, re.I) if TERM_MATCH else None
    courses, bookmark = [], ""
    while True:
        q = "orgUnitTypeId=3&isActive=true"
        if bookmark:
            q += "&bookmark=" + urllib.parse.quote(bookmark)
        page = api(f"/d2l/api/lp/{lp}/enrollments/myenrollments/?{q}")
        for item in page["Items"]:
            acc, ou = item.get("Access", {}), item["OrgUnit"]
            if not role_re.search(acc.get("ClasslistRoleName") or ""):
                continue
            start, end = acc.get("StartDate"), acc.get("EndDate")
            if not (start and end and start <= now <= end):   # current term only
                continue
            if term_re and not term_re.search(f"{ou.get('Code') or ''} {ou['Name']}"):
                continue
            courses.append({"id": ou["Id"], "name": ou["Name"], "code": ou.get("Code")})
        if not page["PagingInfo"].get("HasMoreItems"):
            break
        bookmark = page["PagingInfo"]["Bookmark"]
    return courses


def safe_name(s):
    return re.sub(r"[^A-Za-z0-9._-]", "_", str(s))


def pull_roster(classlist, code):
    ROSTER_OUT.mkdir(parents=True, exist_ok=True)
    path = ROSTER_OUT / f"{code}.csv"
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, quoting=csv.QUOTE_NONNUMERIC, lineterminator="\n")
        w.writerow(["OrgDefinedId", "Username", "FirstName", "LastName", "Email", "Role"])
        for p in classlist:
            w.writerow([p.get("OrgDefinedId") or "", p.get("Username") or "",
                        p.get("FirstName") or "", p.get("LastName") or "",
                        p.get("Email") or "", p.get("ClasslistRoleDisplayName") or ""])
    print(f"  roster: wrote {path} ({len(classlist)} people)")


def pull_grades(le, course_id, classlist, code):
    # Only real numeric items are kept, so category subtotals, calculated/formula
    # items and the final grade are never exported.
    items = api(f"/d2l/api/le/{le}/{course_id}/grades/")
    cats = {c["Id"]: c["Name"] for c in api(f"/d2l/api/le/{le}/{course_id}/grades/categories/")}
    item_re = re.compile(ITEM_MATCH, re.I)
    sel = [i for i in items
           if i.get("GradeType") == "Numeric"
           and item_re.search(f"{cats.get(i.get('CategoryId'), '')} {i['Name']}")]

    print(f"  grades: {len(sel)} CompTIA lab/quiz items")
    for i in sel:
        print(f"    {i['Name']}  (/{i.get('MaxPoints')})")
    if not sel:
        print("  grades: skipped (no matching items — check ITEM_MATCH)")
        return

    points = {}  # (item id, user id) -> points
    for i in sel:
        nxt = f"/d2l/api/le/{le}/{course_id}/grades/{i['Id']}/values/"
        while nxt:
            page = api(nxt)
            for obj in page.get("Objects", []):
                gv = obj.get("GradeValue") or {}
                if gv.get("PointsNumerator") is not None:
                    points[(i["Id"], str(obj["User"]["Identifier"]))] = gv["PointsNumerator"]
            nxt = page.get("Next")

    student_re = re.compile(STUDENT_MATCH, re.I)
    students = [s for s in classlist
                if student_re.search(s.get("ClasslistRoleDisplayName") or s.get("RoleName") or "")]

    GRADES_OUT.mkdir(parents=True, exist_ok=True)
    path = GRADES_OUT / f"{code}_comptia_grades.csv"
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, quoting=csv.QUOTE_NONNUMERIC, lineterminator="\n")
        w.writerow(["OrgDefinedId", "Username"]
                   + [f"{i['Name']} Points Grade" for i in sel]
                   + ["End-of-Line Indicator"])
        for s in students:
            uid = str(s.get("Identifier"))
            w.writerow([s.get("OrgDefinedId") or "", "#" + (s.get("Username") or "")]
                       + [points.get((i["Id"], uid), 0) for i in sel]   # missing -> 0
                       + ["#"])
    print(f"  grades: wrote {path} ({len(students)} students)")


def main():
    mode = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("MODE", "both")).lower()
    if mode in ("-h", "--help", "help"):
        print(__doc__)
        return
    if mode not in MODES:
        sys.exit(f"Unknown mode '{mode}' — use roster, grades or both")
    do_roster, do_grades = MODES[mode]

    lp, le = latest_versions()
    print(f"Mode: {mode}   (lp/{lp}, le/{le})")

    courses = current_courses(lp)
    print("Current-term courses you teach:")
    for c in courses:
        print(f"  {c['id']}\t{c['code']}\t{c['name']}")

    for c in courses:
        code = safe_name(c["code"] or c["id"])
        print(f"Course {c['id']} ({code})")
        classlist = api(f"/d2l/api/le/{le}/{c['id']}/classlist/")   # shared by both modes
        if do_roster:
            pull_roster(classlist, code)
        if do_grades:
            pull_grades(le, c["id"], classlist, code)


if __name__ == "__main__":
    main()
