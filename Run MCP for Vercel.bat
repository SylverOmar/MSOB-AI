@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0run_mcp_for_vercel.ps1"
if errorlevel 1 (
    echo.
    echo The local MCP could not be started. See the message above.
    pause
    exit /b 1
)

exit /b 0
