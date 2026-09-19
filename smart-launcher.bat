@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Local Video Uploader - Smart Launcher

set "SAFE_LAUNCHER=D:\fantasai-chronicles\Start_Video_Uploader.bat"

if not exist "%SAFE_LAUNCHER%" (
  echo [ERROR] Safe local uploader launcher not found: %SAFE_LAUNCHER%
  exit /b 10
)

rem Direct local launcher. Arguments such as /scheduled, /morning, or /evening
rem are passed through only when Task Scheduler explicitly supplies them.
rem No Git pull/reset and no package installation are permitted here.
call "%SAFE_LAUNCHER%" %*
set "LAUNCH_EXIT=!ERRORLEVEL!"
if not "!LAUNCH_EXIT!"=="0" (
  echo [ERROR] Local uploader launcher returned exit code !LAUNCH_EXIT!.
  echo Review D:\fantasai-chronicles\logs\local-uploader-runtime.log
)
exit /b !LAUNCH_EXIT!
