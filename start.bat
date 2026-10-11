@echo off
chcp 65001 > nul
cd /d "%~dp0"
title マイホームシミュレーター

where node > nul 2> nul
if errorlevel 1 (
  echo Node.js が見つかりません。https://nodejs.org から LTS 版をインストールしてください。
  pause
  exit /b 1
)

rem git で取ってきたフォルダなら、最新版を取り込む（画面で変えた内容は一時退避して戻す）
if exist ".git" (
  where git > nul 2> nul
  if not errorlevel 1 (
    echo 最新版を取り込んでいます...
    git pull --rebase --autostash
    if errorlevel 1 (
      echo.
      echo 最新版の取り込みで問題が起きました。この画面の内容を Claude に貼り付けてください。
      pause
    )
  )
)

echo 準備しています...
call npm install --no-fund --no-audit
if errorlevel 1 (
  echo npm install に失敗しました。この画面の内容を Claude に貼り付けてください。
  pause
  exit /b 1
)

rem 少し待ってからブラウザを開く
start "" cmd /c "timeout /t 3 > nul & start http://localhost:5173/"
echo.
echo 起動しました。終わるときはこの画面を閉じてください。
echo.
call npm run dev
pause
