#!/usr/bin/env python3
"""D2L Pull helper (Chrome "native messaging" host), version 2.

Lets the D2L Pull extension start *your* post-processing program after a download,
for example a converter script, in a console window you can watch and answer.

Security model: the extension can never tell this helper what to run. The helper
keeps its own list of approved commands (program + argument lines + working folder).
A command is only added or changed after you confirm it in a dialog this helper
shows. At run time the extension sends just a command id and values for the
placeholders: file paths, which must be existing files, plus a few plain values.

Messages (JSON):
  {action: "ping"}                                  -> {ok, version, python, platform, commands}
  {action: "browse", kind: "file"|"folder", title}  -> {ok, path} | {ok: false, cancelled: true}
  {action: "save", command: {id?, label, program, steps: [[token, ...], ...], cwd, console}}
                                                    -> confirmation dialog -> {ok, id} | {ok: false, declined}
  {action: "remove", id}                            -> {ok}
  {action: "run", id, files: {name: path}, values: {name: text}} -> {ok, cwd, log?}

Placeholders in steps and cwd look like {grades}, {comptia.labs}, {week}, {folder}.
"""
import json
import os
import re
import shlex
import struct
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

VERSION = 2
PLACEHOLDER = re.compile(r"\{([A-Za-z0-9_.-]+)\}")
SAFE_VALUE = re.compile(r'^[^"\x00-\x1f]{0,300}$')   # no quotes or control characters


# ---- storage --------------------------------------------------------------------------
def config_dir() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
        d = base / "D2LPull"
    elif sys.platform == "darwin":
        d = Path.home() / "Library" / "Application Support" / "D2LPull"
    else:
        d = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "d2lpull"
    d.mkdir(parents=True, exist_ok=True)
    return d


def load_commands():
    f = config_dir() / "commands.json"
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return {}


def save_commands(cmds):
    f = config_dir() / "commands.json"
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(cmds, indent=2), encoding="utf-8")
    tmp.replace(f)


# ---- native messaging framing -----------------------------------------------------------
def read_message():
    if sys.platform == "win32":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (n,) = struct.unpack("<I", raw)
    return json.loads(sys.stdin.buffer.read(n).decode("utf-8"))


def send_message(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


# ---- dialogs (tkinter; OS fallbacks) ----------------------------------------------------
def _tk():
    import tkinter as tk
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    return root


def ask_yes_no(title, text):
    try:
        from tkinter import messagebox
        root = _tk()
        try:
            return messagebox.askyesno(title, text, parent=root)
        finally:
            root.destroy()
    except Exception:
        pass
    if sys.platform == "win32":
        ps = ("Add-Type -AssemblyName System.Windows.Forms;"
              "$r=[System.Windows.Forms.MessageBox]::Show($env:D2LP_TEXT,$env:D2LP_TITLE,'YesNo','Question');"
              "if($r -eq 'Yes'){exit 0}else{exit 1}")
        env = dict(os.environ, D2LP_TEXT=text, D2LP_TITLE=title)
        return subprocess.run(["powershell", "-NoProfile", "-Command", ps], env=env).returncode == 0
    if sys.platform == "darwin":
        script = f'display dialog {json.dumps(text)} with title {json.dumps(title)} buttons {{"No","Yes"}} default button "No"'
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
        return "Yes" in r.stdout
    r = subprocess.run(["zenity", "--question", "--title", title, "--text", text])
    return r.returncode == 0


def browse(kind, title):
    try:
        from tkinter import filedialog
        root = _tk()
        try:
            p = filedialog.askdirectory(title=title, parent=root) if kind == "folder" else \
                filedialog.askopenfilename(title=title, parent=root)
        finally:
            root.destroy()
        return p or None
    except Exception:
        pass
    if sys.platform == "win32":
        if kind == "folder":
            ps = ("Add-Type -AssemblyName System.Windows.Forms;$d=New-Object System.Windows.Forms.FolderBrowserDialog;"
                  "if($d.ShowDialog() -eq 'OK'){$d.SelectedPath}")
        else:
            ps = ("Add-Type -AssemblyName System.Windows.Forms;$d=New-Object System.Windows.Forms.OpenFileDialog;"
                  "if($d.ShowDialog() -eq 'OK'){$d.FileName}")
        out = subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", ps], capture_output=True, text=True).stdout.strip()
        return out or None
    if sys.platform == "darwin":
        what = "folder" if kind == "folder" else "file"
        r = subprocess.run(["osascript", "-e", f'POSIX path of (choose {what} with prompt {json.dumps(title)})'],
                           capture_output=True, text=True)
        return r.stdout.strip() or None
    args = ["zenity", "--file-selection", "--title", title] + (["--directory"] if kind == "folder" else [])
    return subprocess.run(args, capture_output=True, text=True).stdout.strip() or None


# ---- commands ---------------------------------------------------------------------------
def interpreter(program: str):
    """How to start a program: scripts get their interpreter."""
    ext = Path(program).suffix.lower()
    if ext in (".py", ".pyw"):
        return [sys.executable, program]
    if sys.platform == "win32":
        if ext == ".ps1":
            return ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", program]
        if ext in (".bat", ".cmd"):
            return ["cmd.exe", "/c", program]
    elif ext == ".sh":
        return ["bash", program]
    return [program]


def describe(cmd):
    lines = [f"Name:     {cmd['label']}", f"Program:  {cmd['program']}", f"Folder:   {cmd['cwd'] or '(program folder)'}",
             f"Console:  {'yes' if cmd.get('console', True) else 'no'}", "Steps:"]
    for i, step in enumerate(cmd["steps"], 1):
        lines.append(f"  {i}. " + " ".join(shlex.quote(t) for t in [Path(cmd['program']).name, *step]))
    return "\n".join(lines)


def validate_command(c):
    program = str(c.get("program") or "")
    if not Path(program).is_file():
        raise ValueError(f"Program not found: {program}")
    steps = c.get("steps") or []
    if not steps or not all(isinstance(s, list) and all(isinstance(t, str) for t in s) for s in steps):
        raise ValueError("steps must be a list of argument lists")
    return {
        "id": str(c.get("id") or uuid.uuid4().hex[:12]),
        "label": str(c.get("label") or Path(program).name)[:80],
        "program": str(Path(program).resolve()),
        "steps": steps[:10],
        "cwd": str(c.get("cwd") or ""),
        "console": bool(c.get("console", True)),
    }


def substitute(text, values):
    missing = []

    def rep(m):
        k = m.group(1)
        if k in values:
            return values[k]
        missing.append(k)
        return m.group(0)

    out = PLACEHOLDER.sub(rep, text)
    if missing:
        raise ValueError("No value for " + ", ".join("{%s}" % k for k in sorted(set(missing))) +
                         " — tick that download, or change the post-processor's steps.")
    return out


def run_values(msg):
    vals = {}
    for k, p in (msg.get("files") or {}).items():
        f = Path(str(p))
        if not f.is_file():
            raise ValueError(f"{{{k}}}: file not found: {f}")
        vals[k] = str(f.resolve())
    for k, v in (msg.get("values") or {}).items():
        v = str(v)
        if k == "folder":
            if not Path(v).is_dir():
                raise ValueError(f"{{folder}}: not a folder: {v}")
        elif not SAFE_VALUE.match(v):
            raise ValueError(f"{{{k}}}: value not allowed: {v!r}")
        vals[k] = v
    return vals


def cmd_quote(t):
    # For a .cmd file: always double-quote; double any % so cmd doesn't expand it.
    return '"' + t.replace("%", "%%") + '"'


def launch(cmd, vals):
    base = interpreter(cmd["program"])
    steps = [base + [substitute(t, vals) for t in step] for step in cmd["steps"]]
    cwd = Path(substitute(cmd["cwd"], vals)) if cmd["cwd"] else Path(cmd["program"]).parent
    if not cwd.is_dir():
        raise ValueError(f"Working folder not found: {cwd}")
    title = f"D2L Pull - {cmd['label']}"

    if not cmd.get("console", True):
        log = config_dir() / "logs"
        log.mkdir(exist_ok=True)
        logfile = log / f"{time.strftime('%Y%m%d-%H%M%S')}-{cmd['id']}.log"
        script = " && ".join(" ".join(shlex.quote(a) for a in s) for s in steps)
        with open(logfile, "w") as out:
            flags = 0x08000000 if sys.platform == "win32" else 0   # CREATE_NO_WINDOW
            if sys.platform == "win32":
                runner = [sys.executable, "-c",
                          "import subprocess,sys,json;\n"
                          "for s in json.loads(sys.argv[1]):\n"
                          "  r=subprocess.run(s)\n"
                          "  if r.returncode: sys.exit(r.returncode)", json.dumps(steps)]
                subprocess.Popen(runner, cwd=str(cwd), stdout=out, stderr=subprocess.STDOUT, creationflags=flags | 0x01000000)
            else:
                subprocess.Popen(["/bin/sh", "-c", script], cwd=str(cwd), stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
        return {"ok": True, "cwd": str(cwd), "log": str(logfile)}

    if sys.platform == "win32":
        lines = ["@echo off", "setlocal DisableDelayedExpansion", f"title {title.replace('%', '%%')}",
                 f"cd /d {cmd_quote(str(cwd))}"]
        for i, s in enumerate(steps, 1):
            lines += ["echo.", f"echo === Step {i} of {len(steps)} ===", " ".join(cmd_quote(a) for a in s) + " || goto :fail"]
        lines += ["echo.", "echo Finished.", "goto :eof", ":fail", "echo.", "echo Stopped: the step above reported an error.", ""]
        fd, path = tempfile.mkstemp(prefix="d2l_pull_", suffix=".cmd")
        with os.fdopen(fd, "w", encoding="mbcs", newline="") as f:
            f.write("\r\n".join(lines))
        flags = subprocess.CREATE_NEW_CONSOLE
        try:
            subprocess.Popen(["cmd.exe", "/k", path], cwd=str(cwd), creationflags=flags | 0x01000000)  # break away from Chrome's job
        except OSError:
            subprocess.Popen(["cmd.exe", "/k", path], cwd=str(cwd), creationflags=flags)
        return {"ok": True, "cwd": str(cwd)}

    body = ["#!/bin/bash", f"cd {shlex.quote(str(cwd))} || exit 1"]
    for i, s in enumerate(steps, 1):
        body += [f'echo; echo "=== Step {i} of {len(steps)} ==="', " ".join(shlex.quote(a) for a in s) + ' || { echo; echo "Stopped: the step above reported an error."; exec bash; }']
    body += ['echo; echo Finished.', 'exec bash']
    fd, path = tempfile.mkstemp(prefix="d2l_pull_", suffix=".command")
    with os.fdopen(fd, "w") as f:
        f.write("\n".join(body) + "\n")
    os.chmod(path, 0o755)
    if sys.platform == "darwin":
        subprocess.Popen(["open", "-a", "Terminal", path], start_new_session=True)
    else:
        for term in (["x-terminal-emulator", "-e"], ["gnome-terminal", "--"], ["konsole", "-e"], ["xterm", "-e"]):
            try:
                subprocess.Popen(term + [path], start_new_session=True)
                break
            except FileNotFoundError:
                continue
        else:
            raise ValueError("No terminal program found; turn off 'show console' for this post-processor.")
    return {"ok": True, "cwd": str(cwd)}


# ---- dispatcher -------------------------------------------------------------------------
def handle(msg):
    if not isinstance(msg, dict):
        raise ValueError("bad message")
    action = msg.get("action")
    cmds = load_commands()
    if action == "ping":
        return {"ok": True, "version": VERSION, "python": sys.version.split()[0], "platform": sys.platform,
                "commands": [{"id": c["id"], "label": c["label"], "program": c["program"]} for c in cmds.values()]}
    if action == "browse":
        p = browse("folder" if msg.get("kind") == "folder" else "file", str(msg.get("title") or "Choose"))
        return {"ok": True, "path": p} if p else {"ok": False, "cancelled": True}
    if action == "save":
        c = validate_command(msg.get("command") or {})
        old = cmds.get(c["id"])
        if old and all(old.get(k) == c[k] for k in ("label", "program", "steps", "cwd", "console")):
            return {"ok": True, "id": c["id"], "unchanged": True}
        verb = "change this post-processor" if old else "add this post-processor"
        text = (f"D2L Pull wants to {verb}:\n\n{describe(c)}\n\n"
                "Placeholders like {grades} are filled in with the files just downloaded.\n\n"
                "Allow D2L Pull to run it when you ask?")
        if not ask_yes_no("D2L Pull — approve post-processor", text):
            return {"ok": False, "declined": True, "error": "Not approved."}
        cmds[c["id"]] = c
        save_commands(cmds)
        return {"ok": True, "id": c["id"]}
    if action == "remove":
        cmds.pop(str(msg.get("id")), None)
        save_commands(cmds)
        return {"ok": True}
    if action == "run":
        c = cmds.get(str(msg.get("id")))
        if not c:
            raise ValueError("This post-processor isn't approved on this computer — open its settings and click Save.")
        return launch(c, run_values(msg))
    raise ValueError("unknown action")


def main():
    try:
        send_message(handle(read_message()))
    except Exception as e:  # every problem goes back to the extension as text
        send_message({"ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
