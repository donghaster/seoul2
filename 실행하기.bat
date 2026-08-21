@echo off
cd /d "%~dp0"
title 금집부쌤의 서울시 아파트 실거래 대시보드
echo.
echo   금집부쌤의 서울시 아파트 실거래 대시보드
echo   --------------------------------------------------
echo   잠시 후 브라우저에서 http://localhost:8766 이 열립니다.
echo   실시간 조회 모드라 기간을 자유롭게 고를 수 있습니다.
echo.
echo   * 이 창을 닫으면 서버가 꺼집니다.
echo.

where py >nul 2>nul
if errorlevel 1 goto NOPY

rem 서버가 뜰 시간을 3초 준 뒤 브라우저를 연다
start "" /min powershell -NoProfile -Command "Start-Sleep 3; Start-Process 'http://localhost:8766'"
py server.py
goto END

:NOPY
echo   [오류] Python을 찾을 수 없습니다.
echo   https://www.python.org 에서 Python 3을 설치한 뒤 다시 실행하세요.

:END
echo.
pause
