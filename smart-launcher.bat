@echo off
setlocal enableextensions enabledelayedexpansion
TITLE Video Uploader - Smart Launcher

REM ======================================================
REM        VIDEO UPLOADER - PULL LATEST AND LAUNCH ALL
REM ======================================================
REM This full launcher pulls newest GitHub code, checks deps,
REM starts LM Studio helper, starts backend, starts frontend on
REM port 8081, then opens the browser.
REM ======================================================

SET "ROOT_DIR=C:\auto-vid-post"
SET "BRAVE_PATH=C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
SET "LM_STUDIO_URL=http://localhost:1234"
SET "LM_STUDIO_FORCE_LOCAL=true"

echo.
echo ======================================================
echo        VIDEO UPLOADER - PULL LATEST AND LAUNCH ALL
echo ======================================================
echo.

echo [1/6] Going to project folder...
cd /d "%ROOT_DIR%"
IF ERRORLEVEL 1 (
    echo [ERROR] Cannot open folder: %ROOT_DIR%
    echo Edit ROOT_DIR inside this BAT file if your project is in another folder.
    pause
    exit /b 1
)

echo.
echo [2/6] Checking Git remote and pulling newest code...
git remote -v
echo.
git fetch origin
IF ERRORLEVEL 1 (
    echo [ERROR] Git fetch failed. Check internet connection and GitHub remote.
    pause
    exit /b 1
)

FOR /F "tokens=*" %%b IN ('git rev-parse --abbrev-ref HEAD') DO SET "CURRENT_BRANCH=%%b"
IF "%CURRENT_BRANCH%"=="HEAD" SET "CURRENT_BRANCH=main"
echo Current branch: %CURRENT_BRANCH%
git pull --ff-only origin %CURRENT_BRANCH%
IF ERRORLEVEL 1 (
    echo.
    echo [ERROR] Git pull failed because local files may have changes or branches differ.
    echo This launcher did NOT overwrite your local files.
    echo If you want to force newest GitHub code, run this manually:
    echo git reset --hard origin/%CURRENT_BRANCH%
    pause
    exit /b 1
)

echo.
echo Latest local commit now is:
git log -1 --oneline

echo.
echo [3/6] Starting LM Studio app/API/model helper...
node server\ensure-lmstudio.js
IF ERRORLEVEL 1 (
    echo [WARN] LM Studio helper returned an error. Continuing anyway.
)

echo.
echo [4/6] Checking frontend and server dependencies...
call npm run ensure-deps
IF ERRORLEVEL 1 (
    echo [ERROR] Frontend dependency check failed.
    pause
    exit /b 1
)

cd /d "%ROOT_DIR%\server"
IF NOT EXIST "node_modules" (
    echo Server packages missing. Installing server dependencies...
    call npm install
    IF ERRORLEVEL 1 (
        echo [ERROR] Server npm install failed.
        pause
        exit /b 1
    )
    call npx playwright install chromium
    IF ERRORLEVEL 1 (
        echo [ERROR] Playwright Chromium install failed.
        pause
        exit /b 1
    )
) ELSE (
    echo [OK] Server packages found.
)
cd /d "%ROOT_DIR%"

echo.
echo [5/6] Launching backend and frontend terminals...
start "Uploader_SERVER" cmd /k "cd /d %ROOT_DIR%\server && SET LM_STUDIO_URL=http://localhost:1234 && SET LM_STUDIO_FORCE_LOCAL=true && npm start"
start "Uploader_FRONTEND" cmd /k "cd /d %ROOT_DIR% && npm run dev -- --port 8081 --strictPort"

echo.
echo [6/6] Waiting 10 seconds, then opening browser...
timeout /t 10 /nobreak

if exist "%BRAVE_PATH%" (
    start "" "%BRAVE_PATH%" http://localhost:8081
) else (
    start http://localhost:8081
)

echo.
echo [OK] Full launch started.
echo Keep the backend and frontend terminal windows open.
pause
exit /b 0
