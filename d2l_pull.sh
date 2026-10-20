#!/usr/bin/env bash
# LEGACY (v2): kept for reference. Use d2l_pull.py (v3) instead; it has the same rules and
# output as the D2L Pull extension. This script still uses its old CompTIA-only defaults.
# Pull class rosters and/or CompTIA gradebook exports for every current-term
# Brightspace (D2L) course you teach.
#
# Usage:
#   bash d2l_pull.sh roster     # class rosters only            -> rosters/<course>.csv
#   bash d2l_pull.sh grades     # CompTIA lab/quiz grades only   -> grades/<course>_comptia_grades.csv
#   bash d2l_pull.sh both       # both (default)
#   (or set MODE=roster|grades|both instead of passing an argument)
#
# Grades export mirrors Grades > Export with:
#   Key field: Both (OrgDefinedId + Username)   Grade values: Points
#   Grade items: CompTIA labs and quizzes only   No subtotals / categories / final grade
#   Missing grades exported as 0
#   D2L import-compatible layout ("<Item> Points Grade", "#username", End-of-Line Indicator)
#
# Needs: curl, jq
#
# Auth: reuses your logged-in browser session (no admin-registered OAuth app needed).
#   1. Log into Brightspace in your browser.
#   2. DevTools (F12) -> Application/Storage -> Cookies -> your D2L host.
#   3. Copy the values of d2lSessionVal and d2lSecureSessionVal below (or export them).
# Session cookies expire when you log out / time out — just grab fresh ones.
#
# Optional settings (environment variables):
#   D2L_HOST       Brightspace URL                         (default https://d2l.pcc.edu)
#   ROLE_MATCH     your role in courses you teach          (default Instructor)
#   TERM_MATCH     text in course code/name for the term   (default: use course dates)
#   STUDENT_MATCH  classlist roles included in grades      (default Student)
#   ITEM_MATCH     regex for grade items to export         (default CompTIA + lab|quiz)
#   ROSTER_OUT / GRADES_OUT  output folders                (default rosters / grades)

set -euo pipefail

MODE="${1:-${MODE:-both}}"
case "$MODE" in
  roster|rosters) DO_ROSTER=1; DO_GRADES=0 ;;
  grades|grade|gradebook) DO_ROSTER=0; DO_GRADES=1 ;;
  both|all) DO_ROSTER=1; DO_GRADES=1 ;;
  -h|--help|help) sed -n '2,32p' "$0"; exit 0 ;;
  *) echo "Unknown mode '$MODE' — use roster, grades or both" >&2; exit 2 ;;
esac

HOST="${D2L_HOST:-https://d2l.pcc.edu}"
SESSION="${D2L_SESSION:-PASTE_d2lSessionVal}"
SECURE="${D2L_SECURE:-PASTE_d2lSecureSessionVal}"
ROLE_MATCH="${ROLE_MATCH:-Instructor}"
TERM_MATCH="${TERM_MATCH:-}"
STUDENT_MATCH="${STUDENT_MATCH:-Student}"
ITEM_MATCH="${ITEM_MATCH:-comptia.*(lab|quiz)|(lab|quiz).*comptia}"
ROSTER_OUT="${ROSTER_OUT:-rosters}"
GRADES_OUT="${GRADES_OUT:-grades}"
NOW=$(date -u +%Y-%m-%dT%H:%M:%S)

COOKIE="d2lSessionVal=$SESSION; d2lSecureSessionVal=$SECURE"
api() {  # accepts a path ("/d2l/api/...") or a full URL (paging "Next" links)
  local u="$1"; [[ $u == http* ]] || u="$HOST$u"
  curl -fsS -H "Cookie: $COOKIE" "$u"
}

# Discover the API versions your instance supports (no auth needed)
VERS=$(curl -fsS "$HOST/d2l/api/versions/")
LP=$(jq -r '.[] | select(.ProductCode=="lp") | .LatestVersion' <<<"$VERS")
LE=$(jq -r '.[] | select(.ProductCode=="le") | .LatestVersion' <<<"$VERS")
echo "Mode: $MODE   (lp/$LP, le/$LE)"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# ---- Current-term courses you teach -------------------------------------------
BOOKMARK=""
: > "$WORK/courses"
while :; do
  PAGE=$(api "/d2l/api/lp/$LP/enrollments/myenrollments/?orgUnitTypeId=3&isActive=true${BOOKMARK:+&bookmark=$BOOKMARK}")
  jq -c --arg r "$ROLE_MATCH" --arg now "$NOW" --arg t "$TERM_MATCH" '.Items[]
        | select((.Access.ClasslistRoleName // "") | test($r; "i"))
        # current term only: course dates must bracket today
        | select(.Access.StartDate != null and .Access.EndDate != null
                 and .Access.StartDate <= $now and .Access.EndDate >= $now)
        | select($t == "" or ((.OrgUnit.Code // "") + " " + .OrgUnit.Name | test($t; "i")))
        | {id: .OrgUnit.Id, name: .OrgUnit.Name, code: .OrgUnit.Code}' <<<"$PAGE" >> "$WORK/courses"
  [[ $(jq -r '.PagingInfo.HasMoreItems' <<<"$PAGE") == "true" ]] || break
  BOOKMARK=$(jq -r '.PagingInfo.Bookmark' <<<"$PAGE")
done

echo "Current-term courses you teach:"
jq -r '"  \(.id)\t\(.code)\t\(.name)"' "$WORK/courses"

# ---- Roster ---------------------------------------------------------------------
pull_roster() {  # $1 course id, $2 safe code
  local file="$ROSTER_OUT/$2.csv"
  mkdir -p "$ROSTER_OUT"
  jq -r '
      ["OrgDefinedId","Username","FirstName","LastName","Email","Role"],
      (.[] | [.OrgDefinedId, .Username, .FirstName, .LastName, .Email, .ClasslistRoleDisplayName])
      | @csv' "$WORK/classlist.json" > "$file"
  echo "  roster: wrote $file ($(($(wc -l < "$file") - 1)) people)"
}

# ---- Grades ---------------------------------------------------------------------
pull_grades() {  # $1 course id, $2 safe code
  local id="$1" file="$GRADES_OUT/$2_comptia_grades.csv"
  mkdir -p "$GRADES_OUT"

  # Only real numeric items are kept, so category subtotals, calculated/formula
  # items and the final grade are never exported.
  api "/d2l/api/le/$LE/$id/grades/" > "$WORK/items.json"
  api "/d2l/api/le/$LE/$id/grades/categories/" > "$WORK/cats.json"
  jq -c --arg m "$ITEM_MATCH" --slurpfile cats "$WORK/cats.json" '
      ($cats[0] | map({key: (.Id|tostring), value: .Name}) | from_entries) as $cn
      | [ .[]
          | select(.GradeType == "Numeric")
          | select((($cn[(.CategoryId|tostring)] // "") + " " + .Name) | test($m; "i"))
          | {id: .Id, name: .Name, max: .MaxPoints} ]' "$WORK/items.json" > "$WORK/sel.json"

  local n; n=$(jq length "$WORK/sel.json")
  echo "  grades: $n CompTIA lab/quiz items"
  jq -r '.[] | "    \(.name)  (/\(.max))"' "$WORK/sel.json"
  if (( n == 0 )); then echo "  grades: skipped (no matching items — check ITEM_MATCH)"; return; fi

  : > "$WORK/values"
  local gid next page
  for gid in $(jq -r '.[].id' "$WORK/sel.json"); do
    next="/d2l/api/le/$LE/$id/grades/$gid/values/"
    while [[ -n $next && $next != null ]]; do
      page=$(api "$next")
      jq -c --argjson g "$gid" '.Objects[]
            | {g: $g, u: .User.Identifier, p: (.GradeValue.PointsNumerator // null)}' <<<"$page" >> "$WORK/values"
      next=$(jq -r '.Next // empty' <<<"$page")
    done
  done

  jq -rn --arg sm "$STUDENT_MATCH" \
        --slurpfile cl "$WORK/classlist.json" \
        --slurpfile sel "$WORK/sel.json" \
        --slurpfile vals <(jq -s . "$WORK/values") '
      ($vals[0] | map({key: "\(.g)|\(.u)", value: .p}) | from_entries) as $pts
      | $sel[0] as $items
      | (["OrgDefinedId", "Username"]
         + ($items | map("\(.name) Points Grade"))
         + ["End-of-Line Indicator"]),
        ($cl[0][]
         | select((.ClasslistRoleDisplayName // .RoleName // "") | test($sm; "i"))
         | . as $s
         | [ ($s.OrgDefinedId // ""), "#" + ($s.Username // "") ]
           + ($items | map($pts["\(.id)|\($s.Identifier)"] // 0))   # missing -> 0
           + ["#"])
      | @csv' > "$file"
  echo "  grades: wrote $file ($(($(wc -l < "$file") - 1)) students)"
}

# ---- Run per course -------------------------------------------------------------
while read -r c; do
  ID=$(jq -r .id <<<"$c")
  CODE=$(jq -j '.code // .id' <<<"$c" | tr -c 'A-Za-z0-9._-' '_')
  echo "Course $ID ($CODE)"
  api "/d2l/api/le/$LE/$ID/classlist/" > "$WORK/classlist.json"   # shared by both modes
  if (( DO_ROSTER )); then pull_roster "$ID" "$CODE"; fi
  if (( DO_GRADES )); then pull_grades "$ID" "$CODE"; fi
done < "$WORK/courses"
