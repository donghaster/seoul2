@echo off
cd /d "%~dp0"
title 자동 갱신용 키 등록
echo.
echo   자동 갱신용 키 등록 (한 번만 하면 됩니다)
echo   --------------------------------------------------
echo   .env의 API 키를 GitHub 저장소 시크릿으로 등록합니다.
echo   등록하면 매일 새벽 5시에 실거래 자료가 자동 갱신됩니다.
echo   키 값은 화면에 표시되지 않습니다.
echo.

where py >nul 2>nul
if errorlevel 1 goto NOPY
where gh >nul 2>nul
if errorlevel 1 goto NOGH

py setup_secrets.py
goto END

:NOPY
echo   [오류] Python을 찾을 수 없습니다. Python 3을 설치한 뒤 다시 실행하세요.
goto END

:NOGH
echo   [오류] GitHub CLI(gh)를 찾을 수 없습니다.
echo   https://cli.github.com 에서 설치한 뒤 gh auth login 을 실행하세요.

:END
echo.
pause
