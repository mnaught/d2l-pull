@echo off
REM Registers the D2L Pull helper for Chrome and Edge (current user, no admin needed).
python "%~dp0install_host.py" %*
if errorlevel 1 (echo Install failed - is Python on your PATH?) else (echo Done.)
pause
