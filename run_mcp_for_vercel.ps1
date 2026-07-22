$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$mcpDirectory = Join-Path $root "mcp_ocr_server"
$trayScript = Join-Path $mcpDirectory "tray_app.py"
$statusDirectory = Join-Path $env:LOCALAPPDATA "MSOB AI"
$statusFile = Join-Path $statusDirectory "mcp-vercel-status.log"

New-Item -ItemType Directory -Path $statusDirectory -Force | Out-Null

$pythonCandidates = @(
    "C:\Program Files\Python314\pythonw.exe",
    (Get-Command pythonw.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1),
    (Get-Command python.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$python = $pythonCandidates | Select-Object -First 1

if (-not $python) {
    throw "Python is required to run the local MCP."
}
if (-not (Test-Path -LiteralPath $trayScript)) {
    throw "The MCP tray launcher is missing."
}
if (-not (Test-Path -LiteralPath (Join-Path $mcpDirectory ".env"))) {
    throw "The MCP .env file is missing."
}

Start-Process `
    -FilePath $python `
    -ArgumentList @("`"$trayScript`"") `
    -WorkingDirectory $mcpDirectory `
    -WindowStyle Hidden

Add-Content `
    -LiteralPath $statusFile `
    -Value ("{0} MCP tray launcher requested." -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss")) `
    -Encoding utf8
