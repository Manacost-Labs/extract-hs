@echo off
chcp 65001 >nul
rem Сборка dist\HearthstoneAssetStudio.exe: интерфейс (Next.js) + сервер (Python) в один файл
cd /d "%~dp0.."
pushd web && call npm run build || exit /b 1
popd
".venv\Scripts\python.exe" packaging\make_icon.py || exit /b 1
".venv\Scripts\python.exe" -m PyInstaller --noconfirm --clean --distpath dist --workpath build packaging\HearthstoneAssetStudio.spec || exit /b 1
echo Готово: dist\HearthstoneAssetStudio.exe
