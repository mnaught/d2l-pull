#!/bin/sh
# Registers the D2L Pull helper for Chrome/Edge/Chromium (current user).
cd "$(dirname "$0")" && python3 install_host.py "$@"
