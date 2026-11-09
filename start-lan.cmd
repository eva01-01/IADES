@echo off
setlocal
cd /d "%~dp0"
echo Building AI Design Studio for local-network access...
call npm run build
if errorlevel 1 (
  echo Build failed. Fix the reported errors and try again.
  pause
  exit /b 1
)
echo Starting the private studio. Keep this window open while devices are connected.
call npm run start:lan
pause
