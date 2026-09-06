@echo off
cd /d "%~dp0"
echo Starting AegisVoice at http://127.0.0.1:4173
node server.mjs --open
pause
