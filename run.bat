@echo off
cd /d "%~dp0"
set PY=%LocalAppData%\Programs\Python\Python312\python.exe
if not exist "%PY%" set PY=python
echo Starting BC Crash Bot dashboard at http://127.0.0.1:5050
"%PY%" app.py
pause
