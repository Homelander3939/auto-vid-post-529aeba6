@echo off
setlocal EnableExtensions
title Video Uploader - Safe Local Launcher

set "SAFE_LAUNCHER=D:\fantasai-chronicles\Start_Video_Uploader.bat"

if not exist "%SAFE_LAUNCHER%" (
  echo [ERROR] Safe local uploader launcher not found: %SAFE_LAUNCHER%
  if /I not "%~1"=="/scheduled" pause
  exit /b 10
)

rem Legacy filename retained for shortcuts only. It intentionally performs
rem no Git operation and no dependency/package mutation.
call "%SAFE_LAUNCHER%" %*
exit /b %ERRORLEVEL%
