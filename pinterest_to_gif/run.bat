@echo off
chcp 65001 > nul
title Video ^& GIF Downloader (Pinterest + YouTube)
cd /d "%~dp0"

echo ========================================================
echo     Video ^& GIF Downloader (Pinterest + YouTube)
echo ========================================================
echo.

set "PY_EXE="

where python >nul 2>&1
if not errorlevel 1 (
    set "PY_EXE=python"
    goto :found_python
)

where py >nul 2>&1
if not errorlevel 1 (
    set "PY_EXE=py"
    goto :found_python
)

if exist "C:\Program Files\Python314\python.exe" (
    set "PY_EXE=C:\Program Files\Python314\python.exe"
    goto :found_python
)

if exist "%LOCALAPPDATA%\Programs\Python\Python314\python.exe" (
    set "PY_EXE=%LOCALAPPDATA%\Programs\Python\Python314\python.exe"
    goto :found_python
)

echo [ОШИБКА] Python не найден!
echo Пожалуйста, установите Python с сайта https://www.python.org/
echo При установке обязательно отметьте галочку:
echo "Add python.exe to PATH"
echo.
pause
exit /b 1

:found_python
"%PY_EXE%" pinterest_to_gif.py %*

if errorlevel 1 (
    echo.
    echo [!] Программа завершилась с ошибкой.
    pause
)
