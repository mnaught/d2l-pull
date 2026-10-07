#!/usr/bin/env python3
"""Register (or remove) the D2L Pull Windows helper for Chrome and Edge.

    python install_host.py            install for the current user (no admin needed)
    python install_host.py --remove   uninstall

Writes com.mnaught.d2lpull.json next to this file and points
HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.mnaught.d2lpull (and the
Edge equivalent) at it. Only the D2L Pull extension (fixed ID below) may use it.
"""
import json
import sys
from pathlib import Path

NAME = "com.mnaught.d2lpull"
EXTENSION_ID = "ilmegdpkffcmnhanlgciclmceidicbof"   # fixed by the "key" in chrome-extension/manifest.json
HERE = Path(__file__).resolve().parent
KEYS = [rf"Software\Google\Chrome\NativeMessagingHosts\{NAME}",
        rf"Software\Microsoft\Edge\NativeMessagingHosts\{NAME}"]


def main():
    if sys.platform != "win32":
        sys.exit("This installer is for Windows.")
    import winreg

    manifest = HERE / f"{NAME}.json"
    if "--remove" in sys.argv:
        for k in KEYS:
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, k)
            except FileNotFoundError:
                pass
        manifest.unlink(missing_ok=True)
        print("D2L Pull helper removed.")
        return

    bat = HERE / "d2l_pull_host.bat"
    bat.write_text(f'@echo off\r\n"{sys.executable}" "{HERE / "d2l_pull_host.py"}" %*\r\n', encoding="mbcs")
    manifest.write_text(json.dumps({
        "name": NAME,
        "description": "D2L Pull helper: runs CompTIA-D2L-Gradebook-Converter",
        "path": str(bat),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{EXTENSION_ID}/"],
    }, indent=2), encoding="utf-8")
    for k in KEYS:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, k) as key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(manifest))
    print(f"D2L Pull helper installed (uses {sys.executable}).")
    print("Restart Chrome, then tick 'Run converter after download' in the extension.")


if __name__ == "__main__":
    main()
