@echo off
title Stop Standalone MetaHuman and Signalling Server
echo ======================================================================
echo    Stopping MetaHuman Standalone Processes and Signalling Server
echo ======================================================================
echo.

echo [INFO] Stopping standalone MyProject4 instances...
taskkill /F /IM MyProject4.exe 2>nul
taskkill /F /IM MyProject4-Win64-Shipping.exe 2>nul

echo [INFO] Stopping Python Signalling Server...
powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*signalling_server.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" 2>nul

echo.
echo [OK] All standalone streaming processes have been stopped.
timeout /t 2 >nul
