@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 灵框 · 知识库
set KB_PORT=7717
node server.js
pause
