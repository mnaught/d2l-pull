#!/usr/bin/env python3
"""Register (or remove) the D2L Pull helper for Chrome, Edge and Chromium.

    python install_host.py            install for the current user (no admin needed)
    python install_host.py --remove   uninstall

Windows: writes com.mnaught.d2lpull.json next to this file and points the per-user
registry keys for Chrome and Edge at it.
Mac/Linux: writes the manifest into each browser's NativeMessagingHosts folder.
Only the D2L Pull extension (fixed ID below) may talk to the helper.
"""
import json
import os
import stat
import sys
from pathlib import Path

NAME = "com.mnaught.d2lpull"
EXTENSION_ID = "ilmegdpkffcmnhanlgciclmceidicbof"   # fixed by the "key" in chrome-extension/manifest.json
HERE = Path(__file__).resolve().parent
HOST = HERE / "d2l_pull_host.py"


def manifest(path):
    return {
        "name": NAME,
        "description": "D2L Pull helper: runs your approved post-processors",
        "path": str(path),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{EXTENSION_ID}/"],
    }


def windows(remove):
    import winreg
    keys = [rf"Software\Google\Chrome\NativeMessagingHosts\{NAME}",
            rf"Software\Microsoft\Edge\NativeMessagingHosts\{NAME}",
            rf"Software\Chromium\NativeMessagingHosts\{NAME}"]
    man = HERE / f"{NAME}.json"
    if remove:
        for k in keys:
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, k)
            except FileNotFoundError:
                pass
        man.unlink(missing_ok=True)
        return
    bat = HERE / "d2l_pull_host.bat"
    bat.write_text(f'@echo off\r\n"{sys.executable}" "{HOST}" %*\r\n', encoding="mbcs")
    man.write_text(json.dumps(manifest(bat), indent=2), encoding="utf-8")
    for k in keys:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, k) as key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(man))


def unix(remove):
    home = Path.home()
    if sys.platform == "darwin":
        sup = home / "Library" / "Application Support"
        dirs = [sup / "Google" / "Chrome", sup / "Microsoft Edge", sup / "Chromium"]
    else:
        cfg = Path(os.environ.get("XDG_CONFIG_HOME") or home / ".config")
        dirs = [cfg / "google-chrome", cfg / "microsoft-edge", cfg / "chromium"]
    launcher = HERE / "d2l_pull_host.sh"
    if not remove:
        launcher.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{HOST}" "$@"\n')
        launcher.chmod(launcher.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    for d in dirs:
        target = d / "NativeMessagingHosts" / f"{NAME}.json"
        if remove:
            target.unlink(missing_ok=True)
        elif d.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(manifest(launcher), indent=2))


def main():
    remove = "--remove" in sys.argv
    (windows if sys.platform == "win32" else unix)(remove)
    if remove:
        print("D2L Pull helper removed.")
    else:
        print(f"D2L Pull helper installed (uses Python {sys.version.split()[0]} at {sys.executable}).")
        print("Restart your browser, then set up a post-processor in D2L Pull's settings.")


if __name__ == "__main__":
    main()
