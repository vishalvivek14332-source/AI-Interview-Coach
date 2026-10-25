@echo off
setlocal enabledelayedexpansion

title AI Interview Coach - Standalone MetaHuman Runner
echo ======================================================================
echo    AI Interview Coach — Standalone MetaHuman Pixel Streaming Launcher
echo ======================================================================
echo.

rem 1. Resolve Project and Engine Paths
set "PROJECT_DIR=%~dp0.."
set "UPROJECT_PATH=C:\Users\USER\Desktop\Metahuman_Background\MyProject4\MyProject4.uproject"
set "UE_EDITOR=C:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\UnrealEditor.exe"
set "PACKAGED_EXE=C:\Users\USER\Desktop\Metahuman_Build\Windows\MyProject4.exe"
set "DEFAULT_PYTHON=C:\Users\USER\AppData\Local\Python\pythoncore-3.14-64\python.exe"

rem 2. Find Python
if exist "%DEFAULT_PYTHON%" (
    set "PYTHON_EXE=%DEFAULT_PYTHON%"
) else (
    where python >nul 2>&1
    if !errorlevel! == 0 (
        set "PYTHON_EXE=python"
    ) else (
        echo [ERROR] Python not found. Please install Python 3.10+ or set PYTHON_EXE.
        pause
        exit /b 1
    )
)
echo [OK] Using Python: %PYTHON_EXE%

rem 3. Check for existing Unreal Editor process holding ports
echo [INFO] Checking if Unreal Editor is currently running...
powershell -Command "Get-Process UnrealEditor -ErrorAction SilentlyContinue | Select-Object -Property Id, ProcessName"
echo.

rem 4. Start Standalone Pixel Streaming Signalling Server
echo [INFO] Starting Standalone Pixel Streaming Signalling Server...
set "SIGNALLING_SCRIPT=%PROJECT_DIR%\pixel_streaming\signalling_server.py"

if not exist "%SIGNALLING_SCRIPT%" (
    echo [ERROR] Could not find signalling_server.py at: %SIGNALLING_SCRIPT%
    pause
    exit /b 1
)

start "PixelStreaming-SignallingServer" /MIN "%PYTHON_EXE%" "%SIGNALLING_SCRIPT%" --streamer-port 8888 --player-port 80
echo [OK] Signalling server launched in background.
echo      - Streamer WebSocket: ws://127.0.0.1:8888
echo      - Player Web Endpoint: http://127.0.0.1:80
echo.

rem Give server 2 seconds to initialize listening sockets
timeout /t 2 /nobreak >nul

rem 5. Check if fully Packaged Build exists; if not, run Standalone Game Mode
if exist "%PACKAGED_EXE%" (
    echo [OK] Packaged Standalone Executable found at:
    echo      %PACKAGED_EXE%
    echo [INFO] Launching Packaged Standalone MetaHuman...
    start "MetaHuman-Packaged" "%PACKAGED_EXE%" -Windowed -ResX=1280 -ResY=720 -PixelStreaming2.ConnectionURL=ws://127.0.0.1:8888 -PixelStreamingURL=ws://127.0.0.1:8888
) else (
    echo [INFO] Packaged build not found at %PACKAGED_EXE%.
    echo [INFO] Launching Unreal project in Standalone Game Mode (-game, NO Editor GUI)...
    if not exist "%UE_EDITOR%" (
        echo [ERROR] Unreal Engine executable not found at: %UE_EDITOR%
        echo Please package the project first using scripts\package_metahuman.bat
        pause
        exit /b 1
    )
    if not exist "%UPROJECT_PATH%" (
        echo [ERROR] Unreal Project file not found at: %UPROJECT_PATH%
        pause
        exit /b 1
    )
    start "MetaHuman-StandaloneGame" "%UE_EDITOR%" "%UPROJECT_PATH%" -game -Windowed -ResX=1280 -ResY=720 -PixelStreaming2.ConnectionURL=ws://127.0.0.1:8888 -PixelStreamingURL=ws://127.0.0.1:8888
)

echo.
echo ======================================================================
echo    MetaHuman Standalone Streaming is ACTIVE!
echo    Website: http://127.0.0.1:5000/interview
echo    Stream:  http://127.0.0.1:80/?AutoConnect=true
echo ======================================================================
echo You do NOT need Unreal Editor open.
echo To stop everything, close the game window or run scripts\stop_metahuman.bat.
echo.
pause
