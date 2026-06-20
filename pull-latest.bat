@echo off
setlocal enableextensions

REM ======================================================
REM              PULL LATEST - ONLY UPDATES CODE
REM ======================================================
REM This script ONLY pulls the latest code from GitHub.
REM It does NOT start servers, install deps, or open browsers.
REM Run this whenever you want to update to the newest version.
REM ======================================================

SET "ROOT_DIR=C:\auto-vid-post"

echo.
echo [PULL] Navigating to project folder...
cd /d "%ROOT_DIR%"
IF ERRORLEVEL 1 (
    echo [!] ERROR: Could not find folder %ROOT_DIR%
    echo     Make sure the path is correct.
    pause
    exit /b 1
)

echo [PULL] Fetching latest changes from GitHub...
git pull origin main
IF ERRORLEVEL 1 (
    echo [!] ERROR: Git pull failed. Check your internet or Git remote URL.
    echo     Run: git remote -v
    pause
    exit /b 1
)

echo.
echo [OK] Done! Your code is now up to date.
echo     Restart smart-launcher.bat to run the new version.
pause
exit
