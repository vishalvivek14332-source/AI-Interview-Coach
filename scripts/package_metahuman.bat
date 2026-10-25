@echo off
setlocal enabledelayedexpansion

title Package MetaHuman Standalone Windows Application
echo ======================================================================
echo    AI Interview Coach — Unreal Engine MetaHuman Packaging Script
echo ======================================================================
echo.

set "RUN_UAT=C:\Program Files\Epic Games\UE_5.8\Engine\Build\BatchFiles\RunUAT.bat"
set "UPROJECT=C:\Users\USER\Desktop\Metahuman_Background\MyProject4\MyProject4.uproject"
set "ARCHIVE_DIR=C:\Users\USER\Desktop\Metahuman_Build"
set "CONFIG=Shipping"

if not "%1"=="" set "CONFIG=%1"

echo [CONFIG] Build Configuration: %CONFIG%
echo [CONFIG] Project File:        %UPROJECT%
echo [CONFIG] Destination:         %ARCHIVE_DIR%
echo.

rem Check RunUAT
if not exist "%RUN_UAT%" (
    echo [ERROR] RunUAT.bat not found at:
    echo         %RUN_UAT%
    echo Please verify that Unreal Engine 5.8 is installed.
    pause
    exit /b 1
)

rem Check uproject
if not exist "%UPROJECT%" (
    echo [ERROR] Project file not found at:
    echo         %UPROJECT%
    pause
    exit /b 1
)

rem Ensure destination directory exists
if not exist "%ARCHIVE_DIR%" mkdir "%ARCHIVE_DIR%"

echo ======================================================================
echo [INFO] Starting Unreal Engine Cook and Package process...
echo [INFO] This will cook maps, assets, MetaHuman groom/textures, and produce
echo        a standalone executable at: %ARCHIVE_DIR%\Windows\MyProject4.exe
echo ======================================================================
echo.

call "%RUN_UAT%" BuildCookRun ^
  -project="%UPROJECT%" ^
  -noP4 ^
  -platform=Win64 ^
  -clientconfig=%CONFIG% ^
  -cook ^
  -build ^
  -stage ^
  -pak ^
  -archive ^
  -archivedirectory="%ARCHIVE_DIR%"

if %ERRORLEVEL% equ 0 (
    echo.
    echo ======================================================================
    echo [SUCCESS] Packaging completed successfully!
    echo Standalone Executable created at:
    echo %ARCHIVE_DIR%\Windows\MyProject4.exe
    echo ======================================================================
    echo You can now run scripts\run_metahuman_standalone.bat to start streaming!
) else (
    echo.
    echo ======================================================================
    echo [ERROR] Packaging failed with exit code %ERRORLEVEL%.
    echo Check the UAT log above for missing plugins, shaders, or C++ compile errors.
    echo ======================================================================
)

pause
