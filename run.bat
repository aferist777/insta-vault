@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo [Insta Vault] Creating virtual environment...
    python -m venv .venv || goto :fail
    ".venv\Scripts\python.exe" -m pip install --upgrade pip -q
    echo [Insta Vault] Installing dependencies...
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :fail
)

".venv\Scripts\python.exe" -m app.main %*
if errorlevel 1 goto :crashed
goto :eof

:crashed
echo.
echo [Insta Vault] The app exited with an error (see the message above).
echo If it says the port is busy, close the other Insta Vault window and try again.
pause
exit /b 1

:fail
echo.
echo [Insta Vault] Setup failed. Check that Python 3.10+ is on PATH.
pause
exit /b 1
