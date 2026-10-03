# d2l-pull

Pull **class rosters** and **CompTIA gradebook exports** from Brightspace (D2L) for every
current-term course you teach, straight from the command line.

Two equivalent versions are included. Pick whichever suits you:

| File | Needs |
|---|---|
| `chrome-extension/` | Chrome or Edge only. **One click, no cookies to copy** (see below) |
| `d2l_pull.sh` | bash, `curl`, `jq` |
| `d2l_pull.py` | Python 3.8+ (standard library only, nothing to install) |

## Chrome extension (easiest)

Runs the same pull inside your logged-in Brightspace tab, so there's no cookie copy/paste
and nothing else to install. Works on Windows, Mac and Linux.

**Install (once):**
1. Download this repo (green **Code** button, then **Download ZIP**) and unzip it somewhere permanent,
   e.g. `Documents\d2l-pull`.
2. In Chrome go to `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the `chrome-extension` folder.
5. Optional: click the puzzle-piece icon and pin **D2L Pull** to the toolbar.

**Use:**
1. Log into Brightspace and stay on any Brightspace page.
2. Click the **D2L Pull** toolbar button.
3. Click **Roster**, **Grades** or **Both**.

CSVs are saved to `Downloads\d2l-pull\<date>\rosters\` and `...\grades\`, with the same columns
as the scripts. **Settings** in the popup holds the same filters as the environment variables below
(role, term, students, grade items) and remembers them. Keep the popup open until it says **Done**.

## Scripts

### Quick start

1. Log into Brightspace in your browser.
2. Open DevTools (F12), then go to **Application** (Chrome/Edge) or **Storage** (Firefox), then **Cookies**, then your D2L host.
3. Copy the values of `d2lSessionVal` and `d2lSecureSessionVal` into environment variables:

   ```bash
   export D2L_SESSION='...d2lSessionVal...'
   export D2L_SECURE='...d2lSecureSessionVal...'
   ```

4. Run:

   ```bash
   python3 d2l_pull.py both      # or: bash d2l_pull.sh both
   ```

Session cookies expire when you log out or your session times out. If you get a 401/403, grab fresh ones.

> This uses your own logged-in session, so it can only see what you can already see in
> Brightspace. No admin-registered OAuth app is required.

### Modes

```bash
python3 d2l_pull.py roster    # class rosters only
python3 d2l_pull.py grades    # CompTIA lab/quiz grades only
python3 d2l_pull.py both      # both (default)
python3 d2l_pull.py help      # show all options
```

You can also set `MODE=roster|grades|both` instead of passing an argument.

### Output

| Mode | File | Columns |
|---|---|---|
| roster | `rosters/<course code>.csv` | OrgDefinedId, Username, FirstName, LastName, Email, Role |
| grades | `grades/<course code>_comptia_grades.csv` | OrgDefinedId, Username, one `<Item> Points Grade` per item, End-of-Line Indicator |

The grades file mirrors Brightspace's **Grades → Export** with:

- **Key field:** Both (OrgDefinedId and Username)
- **Grade values:** Points
- **Grade items:** CompTIA labs and quizzes only
- **No** category subtotals, calculated items or final grade
- **Missing grades exported as 0**

It uses D2L's import layout (`#username`, trailing `#` End-of-Line Indicator), so it can be
re-imported into the gradebook.

## Which courses?

Only **current-term** courses where your role is **Instructor**. A course counts as current
when Brightspace marks it active and its start/end dates include today.

## Settings

All optional, set as environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `D2L_HOST` | `https://d2l.pcc.edu` | Your Brightspace URL |
| `ROLE_MATCH` | `Instructor` | Your role name in courses you teach (regex) |
| `TERM_MATCH` | *(dates)* | Text in course code/name for the term, e.g. `"Fall 2026"`. Use if a course has no start/end dates set |
| `STUDENT_MATCH` | `Student` | Classlist roles included in the grades export (regex) |
| `ITEM_MATCH` | `comptia.*(lab\|quiz)\|(lab\|quiz).*comptia` | Regex tested against `"<category> <item name>"` to choose grade items |
| `ROSTER_OUT` / `GRADES_OUT` | `rosters` / `grades` | Output folders |

Example: export only items whose names start with "Lab" or "Quiz":

```bash
ITEM_MATCH='^(CompTIA )?(Lab|Quiz)' python3 d2l_pull.py grades
```

## Brightspace API calls used

| Purpose | Endpoint |
|---|---|
| API versions | `GET /d2l/api/versions/` |
| Your courses | `GET /d2l/api/lp/{ver}/enrollments/myenrollments/?orgUnitTypeId=3&isActive=true` |
| Classlist | `GET /d2l/api/le/{ver}/{orgUnitId}/classlist/` |
| Grade items | `GET /d2l/api/le/{ver}/{orgUnitId}/grades/` |
| Grade categories | `GET /d2l/api/le/{ver}/{orgUnitId}/grades/categories/` |
| Grade values | `GET /d2l/api/le/{ver}/{orgUnitId}/grades/{gradeObjectId}/values/` |

## Privacy

Rosters and grades are student records (FERPA). The `.gitignore` excludes `rosters/`,
`grades/` and `*.csv` so output is never committed. Never commit your session cookies either.
