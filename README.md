# D2L Pull

One click to download **Brightspace (D2L) rosters and grades** for the courses you teach, plus
data from other platforms through **add-ons** (e.g. CompTIA CertMaster), and then run **your own
post-processing script** on the files (a converter, a report, a sync).

It works at any school that uses Brightspace, and in any course. You choose what to pull by ticking
courses and grade items, or with regular expressions. Both work, and you can mix them.

| Part | What it is |
|---|---|
| `chrome-extension/` | **D2L Pull**: the main Chrome/Edge extension |
| `addons/comptia-certmaster/` | Add-on: CompTIA CertMaster lab gradebooks and quiz reports |
| `native/` | Small helper that lets D2L Pull start your post-processing program (Windows, Mac, Linux) |
| `d2l_pull.py` | Command-line version (same rules and output; reads settings exported from the extension) |
| `docs/SOURCE_ADDONS.md` | How to write an add-on for another platform |

## Install

1. Download this repo (green **Code** button, then **Download ZIP**) and unzip it somewhere permanent.
2. In Chrome go to `chrome://extensions` (Edge: `edge://extensions`), turn on **Developer mode**,
   click **Load unpacked** and pick the **`chrome-extension`** folder. Pin **D2L Pull** to the toolbar.
3. *Optional add-ons:* also **Load unpacked** each add-on folder you want, e.g. `addons/comptia-certmaster`.
4. *Optional post-processing:* run `native\install.cmd` (Windows) or `native/install.sh` (Mac/Linux)
   once, then restart the browser. It needs Python 3.

## Set up (once)

Open **D2L Pull → Settings**:

1. **Brightspace**: your address (e.g. `https://online.myschool.edu`), or click **Use my open tab**.
2. **Courses**: click **Load from Brightspace**, then choose:
   * *Count me as teaching when my role is*: e.g. Instructor (schools name roles differently).
   * *Only courses whose dates include today*: on by default.
   * *Courses*: tick them, or use a pattern like `CIS.?140L`.
3. **Course settings**: what to export. **Defaults** apply to every course; give a course its own
   settings when it needs to differ.
   * **Grade items**: tick items, or a pattern tested on "category name", e.g. `^(CompTIA Labs|CompTIA Quizzes)\b`.
   * **Missing grades**: 0 once the item's due date has passed (dates come from the linked assignment,
     discussion or quiz), with a per-item *Missing* override (auto / 0 / blank).
   * **Students**: which classlist roles (normally Student).
   * **Files**: folder inside Downloads (default `D2L Pull/{course_code}`), file names, key field
     (Org Defined ID / Username / both), extra user columns. Grades are written exactly like
     Brightspace's *Grades → Export* (points), so they can be imported back.
   * **Add-on classes**: which add-on class belongs to this course (automatic by CRN).
   * **Post-processor**: see below.
4. **Add-ons**: approve each add-on you installed.

### Pick or Pattern

Every list (roles, courses, grade items, students) has **Pick | Pattern**:

* **Pick**: tick rows. Saved by D2L ID, with the name as a fallback, so a copied course next term
  still finds the items (flagged *matched by name* so you can check them).
* **Pattern**: a regular expression (case-insensitive) selects rows, highlighted live. Ticking or
  unticking a row adds an exception (*added* / *excluded*). Patterns carry over to next term's courses.
* **Make a pattern from my picks** turns your ticks into a regex that selects exactly them.
* Switching views keeps the current selection.

## Use

1. Log in to Brightspace (and to any add-on's site) in a tab.
2. Click **D2L Pull**, tick what to download (Roster / Grades / add-on files), set **Through week**
   if your post-processor needs it (blank = weeks since the course started), and click **Download**.
   You can close the popup; the work continues in the background.

## Post-processors

A post-processor is any program or script you want run on the downloaded files, e.g. a converter.
Set it up per course (or in Defaults) under **Course settings → Post-processor**, or with
**Change…** next to *Run post-processors* in the popup:

* **Program**: **Browse…** to your script (`.py` runs with Python, `.ps1` with PowerShell, `.cmd`/`.bat`, `.sh`, or any program).
* **Arguments**: one line per step; steps run in order and stop at the first error. Placeholders:
  `{grades}` `{roster}` `{folder}` `{week}` `{course_code}` `{course_id}` `{course_name}`, plus one
  per add-on file, e.g. `{comptia.labs}` `{comptia.quizzes}`.
* **Working folder**: blank means the program's folder. It can use placeholders, e.g. `{folder}/..`.
* **Console window**: on, so the program can ask questions and you can read its output.

Click **Save & approve…**. The helper on your computer shows the exact command and asks you to
allow it. The extension can't run anything you haven't approved on that computer. If a file wasn't
downloaded this time, the copy from your last download in that folder is used.

**Example: CompTIA → D2L converter** (`convert.py` next to its `Data` folder):

```
Save to:         <your folder inside Downloads>/CompTIA-D2L-Gradebook-Converter/Data
Grades file:     d2l.csv
Program:         …\CompTIA-D2L-Gradebook-Converter\convert.py
Working folder:  {folder}/..
Arguments:       {comptia.labs} {grades} --quizzes {comptia.quizzes} --week {week} --table
                 {comptia.labs} {grades} --quizzes {comptia.quizzes} --week {week} --out d2l_import.csv
```

## Add-ons

Add-ons are separate extensions that bring in data from other platforms. They keep their own site
permissions, and D2L Pull only uses them after you approve them. The CompTIA CertMaster add-on
produces files byte-identical to CertMaster's own *Class Gradebook* (points) and custom quiz report
exports. To support another platform, see **[docs/SOURCE_ADDONS.md](docs/SOURCE_ADDONS.md)**.

## Command line

`d2l_pull.py` (Python 3.8+, no installs) does the D2L part with the same rules and identical output:

```bash
export D2L_SESSION='…'  D2L_SECURE='…'        # cookies d2lSessionVal / d2lSecureSessionVal
python3 d2l_pull.py --host https://online.myschool.edu --list-courses
python3 d2l_pull.py --host … --list-items 123456
python3 d2l_pull.py --host … --grades --courses-pattern 'CIS.?140L' --items-pattern '^CompTIA' --out ~/grades
python3 d2l_pull.py --profile d2l-pull-settings.json --grades --then 'python3 convert.py … {grades} --week {week}'
```

Run `python3 d2l_pull.py --help` for all options. `d2l_pull.sh` is the old v2 bash version, kept for reference.

## Backup and sharing

**Settings → Backup → Export** saves everything (courses, items, post-processor steps) to a JSON file
you can share with colleagues teaching the same course. Importing doesn't copy approvals: each person
approves post-processors on their own computer.

## Privacy

Everything runs in your browser with your existing logins. Nothing is sent anywhere except to
Brightspace and the add-on sites themselves. Rosters and grades are student records (FERPA): the
repo's `.gitignore` excludes CSV output. Don't commit downloaded files or session cookies.

## Brightspace API calls used

| Purpose | Endpoint |
|---|---|
| API versions | `GET /d2l/api/versions/` |
| Your courses | `GET /d2l/api/lp/{v}/enrollments/myenrollments/` (paged; course offerings only) |
| Classlist | `GET /d2l/api/le/{v}/{orgUnitId}/classlist/` |
| Grade items / categories | `GET /d2l/api/le/{v}/{orgUnitId}/grades/` and `…/grades/categories/` |
| Grade values | `GET /d2l/api/le/{v}/{orgUnitId}/grades/{gradeObjectId}/values/` (paged) |
| Due dates | `…/dropbox/folders/`, `…/quizzes/`, `…/discussions/forums/{id}/topics/` |
