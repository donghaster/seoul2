@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo.
echo   자동 갱신용 키 등록 (한 번만 하면 됩니다)
echo   ------------------------------------------------
echo   .env의 API 키를 GitHub 저장소 시크릿으로 등록합니다.
echo   등록하면 매일 새벽 5시에 실거래 자료가 자동으로 갱신됩니다.
echo   키 값은 화면에 표시되지 않습니다.
echo.
py "setup_secrets.py"
echo.
pause
