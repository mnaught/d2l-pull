#!/usr/bin/env python3
"""Windows helper for the D2L Pull Chrome extension (Chrome "native messaging" host).

Chrome starts this when you tick "Run converter after download". It receives the
paths of the files the extension just saved and opens a console window that runs
CompTIA-D2L-Gradebook-Converter's convert.py on them:

    python convert.py <labs> <d2l> [--quizzes <quizzes>] --week N --table          (preview)
    python convert.py <labs> <d2l> [--quizzes <quizzes>] --week N --out d2l_import.csv

The window stays open so you can answer convert.py's student-matching questions
and read its output. It only ever runs convert.py found next to (or one level
above) the downloaded files — nothing else.

Install once with install.cmd (registers this helper for Chrome and Edge).
"""
import json
import os
import struct
import subprocess
import sys
import tempfile
from pathlib import Path


def read_message():
    if sys.platform == "win32":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    (length,) = struct.unpack("<I", raw_len)
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def send_message(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def find_converter(start: Path):
    """convert.py in the labs file's folder or its parent (the default Data/ layout)."""
    for d in (start, start.parent):
        if (d / "convert.py").is_file():
            return d
    return None


def existing_file(p, what):
    if not p:
        return None
    f = Path(p)
    if not f.is_file():
        raise ValueError(f"{what} file not found: {f}")
    if f.suffix.lower() != ".csv":
        raise ValueError(f"{what} file is not a .csv: {f}")
    return f


def q(p):
    """Quote for a .cmd file. Paths never contain double quotes on Windows."""
    return '"' + str(p) + '"'


def build_script(conv_dir: Path, labs: Path, d2l: Path, quizzes, week: int) -> str:
    py = q(sys.executable)
    base = f"{py} convert.py {q(labs)} {q(d2l)}" + (f" --quizzes {q(quizzes)}" if quizzes else "") + f" --week {week}"
    return "\r\n".join([
        "@echo off",
        "setlocal DisableDelayedExpansion",
        f"title CompTIA to D2L converter - week {week}",
        f"cd /d {q(conv_dir)}",
        "echo Preview of the CompTIA columns (week %s):" % week,
        "echo.",
        f"{base} --table || goto :fail",
        "echo.",
        f"{base} --out d2l_import.csv || goto :fail",
        "echo.",
        f"echo Import {conv_dir}\\d2l_import.csv in D2L under Grades - Import.",
        "goto :eof",
        ":fail",
        "echo.",
        "echo convert.py stopped with an error - see the message above.",
        "",
    ])


def launch(script_text: str, cwd: Path):
    fd, path = tempfile.mkstemp(prefix="d2l_pull_convert_", suffix=".cmd")
    with os.fdopen(fd, "w", encoding="mbcs" if sys.platform == "win32" else "utf-8", newline="") as f:
        f.write(script_text)
    flags = 0
    if sys.platform == "win32":
        flags = subprocess.CREATE_NEW_CONSOLE | 0x01000000  # CREATE_BREAKAWAY_FROM_JOB: outlive Chrome's helper job
    args = ["cmd.exe", "/k", path] if sys.platform == "win32" else ["sh", path]
    try:
        subprocess.Popen(args, cwd=str(cwd), creationflags=flags, close_fds=True)
    except OSError:
        # Some Chrome builds don't allow breakaway; a new console still works.
        subprocess.Popen(args, cwd=str(cwd), creationflags=flags & ~0x01000000, close_fds=True)


def handle(msg):
    if not isinstance(msg, dict):
        raise ValueError("bad message")
    if msg.get("action") == "ping":
        return {"ok": True, "python": sys.version.split()[0]}
    if msg.get("action") != "convert":
        raise ValueError("unknown action")

    labs = existing_file(msg.get("labs"), "Labs")
    if not labs:
        raise ValueError("no labs file given")
    quizzes = existing_file(msg.get("quizzes"), "Quizzes")
    week = int(msg.get("week") or 0)
    if not 1 <= week <= 52:
        raise ValueError("week must be between 1 and 52")

    conv_dir = find_converter(labs.parent)
    if not conv_dir:
        raise ValueError(f"convert.py not found in {labs.parent} or its parent folder. "
                         "Set the extension's 'Save to' folder to the converter's Data folder.")
    d2l = existing_file(msg.get("d2l"), "D2L") or existing_file(str(labs.parent / "d2l.csv"), "D2L")

    launch(build_script(conv_dir, labs, d2l, quizzes, week), conv_dir)
    return {"ok": True, "dir": str(conv_dir)}


def main():
    try:
        msg = read_message()
        send_message(handle(msg))
    except Exception as e:  # report every problem back to the extension
        send_message({"ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
