@echo off
chcp 65001 >nul
rem Запуск Hearthstone Asset Studio: сервер + окно приложения
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Нет окружения .venv — см. README.md, раздел "Установка".
  pause
  exit /b 1
)
if not exist "web\out\index.html" (
  echo Собираю интерфейс...
  pushd web && call npm install && call npm run build && popd
)
".venv\Scripts\python.exe" hsserver.py %*
