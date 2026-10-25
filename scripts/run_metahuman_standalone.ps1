<#
.SYNOPSIS
    Starts Standalone MetaHuman Application and Pixel Streaming Infrastructure.
.DESCRIPTION
    Runs the standalone packaged MetaHuman application (or -game mode) with the
    Pixel Streaming Signalling Server, completely independent of Unreal Editor.
#>

$ErrorActionPreference = "Stop"

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "   AI Interview Coach — Standalone MetaHuman Pixel Streaming Launcher   " -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host ""

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Resolve-Path "$ScriptDir\.."
$UProject = "C:\Users\USER\Desktop\Metahuman_Background\MyProject4\MyProject4.uproject"
$PackagedExe = "C:\Users\USER\Desktop\Metahuman_Build\Windows\MyProject4.exe"
$UEEditor = "C:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\UnrealEditor.exe"
$SignallingScript = "$ProjectRoot\pixel_streaming\signalling_server.py"

# 1. Resolve Python executable
$Python = "C:\Users\USER\AppData\Local\Python\pythoncore-3.14-64\python.exe"
if (-not (Test-Path $Python)) {
    $PythonCmd = Get-Command python -ErrorAction SilentlyContinue
    if ($PythonCmd) { $Python = $PythonCmd.Source }
    else { throw "Python not found. Please install Python 3.10+." }
}
Write-Host "[OK] Using Python: $Python" -ForegroundColor Green

# 2. Check for running UnrealEditor instance
$runningEditor = Get-Process UnrealEditor -ErrorAction SilentlyContinue
if ($runningEditor) {
    Write-Host "[WARNING] An UnrealEditor process (PID $($runningEditor.Id)) is currently running." -ForegroundColor Yellow
    Write-Host "          If it is bound to ports 80 or 8888, please close it so standalone mode can bind." -ForegroundColor Yellow
}

# 3. Start Signalling Server
Write-Host "[INFO] Starting Signalling Server..." -ForegroundColor Yellow
$signallingProc = Start-Process -FilePath $Python -ArgumentList "`"$SignallingScript`" --streamer-port 8888 --player-port 80" -PassThru -WindowStyle Minimized
Write-Host "[OK] Signalling Server running (PID $($signallingProc.Id))" -ForegroundColor Green
Write-Host "     Streamer WS: ws://127.0.0.1:8888" -ForegroundColor DarkCyan
Write-Host "     Player HTTP/WS: http://127.0.0.1:80" -ForegroundColor DarkCyan
Start-Sleep -Seconds 2

# 4. Launch Game (Packaged or Standalone -game)
$streamArgs = "-Windowed -ResX=1280 -ResY=720 -PixelStreaming2.ConnectionURL=ws://127.0.0.1:8888 -PixelStreamingURL=ws://127.0.0.1:8888"

if (Test-Path $PackagedExe) {
    Write-Host "[OK] Found Packaged Executable at: $PackagedExe" -ForegroundColor Green
    Write-Host "[INFO] Launching Packaged MetaHuman..." -ForegroundColor Cyan
    Start-Process -FilePath $PackagedExe -ArgumentList $streamArgs
} elseif (Test-Path $UProject) {
    Write-Host "[INFO] Packaged build not found at $PackagedExe." -ForegroundColor Yellow
    Write-Host "[INFO] Launching in Standalone Game Mode (-game, NO Editor GUI)..." -ForegroundColor Cyan
    Start-Process -FilePath $UEEditor -ArgumentList "`"$UProject`" -game $streamArgs"
} else {
    Write-Error "Neither packaged build nor uproject found. Please check paths."
}

Write-Host ""
Write-Host "======================================================================" -ForegroundColor Green
Write-Host "   MetaHuman Standalone Streaming is ACTIVE!                          " -ForegroundColor Green
Write-Host "   Interview Web App: http://127.0.0.1:5000/interview                  " -ForegroundColor White
Write-Host "   Direct Player URL: http://127.0.0.1:80/?AutoConnect=true            " -ForegroundColor White
Write-Host "======================================================================" -ForegroundColor Green
Write-Host "To stop services, close the game window and run scripts\stop_metahuman.bat." -ForegroundColor Gray
