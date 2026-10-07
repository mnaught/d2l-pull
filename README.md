# d2l-pull

Pull **class rosters** and **CompTIA gradebooks** for every current-term course you teach, from
both **Brightspace (D2L)** and **CompTIA CertMaster**, and optionally feed them straight into
CompTIA-D2L-Gradebook-Converter (`convert.py`).

| Part | What it does | Needs |
|---|---|---|
| `chrome-extension/` | One click: D2L roster + grades, CompTIA labs + quizzes, optional converter run | Chrome or Edge |
| `native/` | Small Windows helper that lets the extension start `convert.py` | Python (already needed by the converter) |
| `d2l_pull.py` / `d2l_pull.sh` | D2L roster + grades from the command line | Python 3.8+ / bash + curl + jq |

## Chrome extension (easiest)

The extension runs inside your already-logged-in Brightspace and CompTIA tabs, so there's no
cookie or token copy/paste. One extension reads both sites.

### Install (once)

1. Download this repo (green **Code** button, then **Download ZIP**) and unzip it somewhere permanent,
   e.g. `Documents\d2l-pull`.
2. In Chrome go to `chrome://extensions` (Edge: `edge://extensions`), turn on **Developer mode**,
   click **Load unpacked** and pick the `chrome-extension` folder. Pin **D2L Pull** to the toolbar.
3. *Only for "Run converter after download":* double-click `native\install.cmd`, then restart Chrome.
   (Registers a small helper for your user account; no admin rights. `native\uninstall.cmd` removes it.)

### Use

1. Log into **Brightspace** (`d2l.pcc.edu`) and **CompTIA** (`platform.comptia.org`) in two tabs.
   Any page on each site is fine; the green dots in the popup show both tabs were found.
2. Click **D2L Pull** and tick what you want:

   | Section | Checkbox | File |
   |---|---|---|
   | Brightspace (D2L) | Roster | `d2l_roster.csv` |
   | Brightspace (D2L) | Grades | `d2l.csv`: Brightspace's own Grades export format (Key field: Both, Points, CompTIA lab + quiz items only, no subtotals) |
   | CompTIA CertMaster | Labs | `comptia_labs.csv`: same as the **Class Gradebook** export with "Show scores as points" |
   | CompTIA CertMaster | Quizzes | `comptia_quizzes.csv`: same as your custom quiz report export |
   | CompTIA CertMaster | Run converter after download | runs `convert.py` on those files |

3. Click **Download**. You can close the popup; the work continues in the background.

Files are saved (overwriting the previous ones) into
`Downloads\!Fall 26\cis140l\script\CompTIA-D2L-Gradebook-Converter\Data` by default.
Change it under **Settings → Save to**. Chrome can only save inside your Downloads folder.

The CompTIA files were checked byte-for-byte against real CertMaster downloads, and the D2L header
against a real Brightspace export, so `convert.py` treats them exactly like hand-made exports.

### Run converter after download

With this ticked (and **Labs** ticked), the helper opens a console window in the converter folder
(found next to, or one level above, the save folder) and runs:

```
python convert.py comptia_labs.csv d2l.csv --quizzes comptia_quizzes.csv --week N --table
python convert.py comptia_labs.csv d2l.csv --quizzes comptia_quizzes.csv --week N --out d2l_import.csv
```

The first command previews the grades and asks any student-matching questions; the second writes
`d2l_import.csv` for **Grades → Import**. **Week** blank means "completed weeks since the CompTIA
class started" (e.g. 2 on the Wednesday of week 3). Type a number to override.
If **Grades** isn't ticked, the converter uses the `d2l.csv` already in the folder.

### Notes

- Missing D2L grades are left **blank**, like Brightspace's own export. Writing 0 (a setting) would
  make the converter import zeros into future weeks.
- The quiz report is the first CompTIA custom report on the class whose name contains "quiz"
  (change under Settings).
- If Chrome asks where to save each file, turn off *Settings → Downloads → Ask where to save each file*.
- Only current-term courses/classes are included (by their start and end dates).

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

## CompTIA API calls used (extension)

All with the page's own login token, from inside your CompTIA tab:

| Purpose | Endpoint (`https://api.platform.comptia.org/api/v1`) |
|---|---|
| Your classes | `GET /campuses/{campusId}/campusclasses` |
| Course version | `GET /class/{classId}/courses/selection-options` |
| Lab list + points possible | `GET /resources/versions/{versionId}/2/map` |
| Lab scores (highest) | `GET /reportData/gradebookData/{classId}/{versionId}/paged?filter=Highest&page=N` |
| Custom reports | `GET /customreports/classes/{classId}/{userId}` |
| Quiz report | `GET /customreports/{reportId}/{userId}/resources` and `GET /customreports/{reportId}/{userId}?showScoreTimeAttempts=show_points&scoreStats=show_high_scores&…` |

## Privacy

Rosters and grades are student records (FERPA). The `.gitignore` excludes `rosters/`,
`grades/` and `*.csv` so output is never committed. Never commit your session cookies either.
