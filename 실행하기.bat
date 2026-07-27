@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 금집부쌤의 서울시 아파트 실거래 대시보드를 시작합니다...
echo.
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:8766"
python server.py
if errorlevel 1 (
  echo.
  echo [오류] python 실행에 실패했습니다. Python 3가 설치되어 있는지 확인하세요.
  pause
)
