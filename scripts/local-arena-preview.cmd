@echo off
rem Local preview of the website with the Unity arena (Windows). Opens two windows:
rem   backend  -> http://localhost:4000   (JSON storage in a TEMP file, never the project's save file)
rem   website  -> http://localhost:5180   (Vite dev server, serves client\public\unity\arena; API and
rem               sockets go through its proxy, so the page only ever talks to its own origin)
rem Re-running it only starts whichever server is not already running.
rem Safe by construction: no PostgreSQL/Neon, no AI key, nothing deployed. Close both windows to stop.
setlocal
cd /d "%~dp0.."
set PERSISTENCE=json
set DATABASE_URL=
set ANTHROPIC_API_KEY=
set AI_ANALYSIS_ENABLED=
set ROOM_STORAGE_FILE=%TEMP%\ipl_arena_preview_rooms.json
set PORT=4000
set WEB_PORT=5180
set VITE_SERVER_URL=http://localhost:%WEB_PORT%
netstat -ano | findstr /R /C:":4000 .*LISTENING" >nul && (echo Backend already running on port 4000.) || start "IPL backend (local preview)" cmd /k node server\index.js
netstat -ano | findstr /R /C:":%WEB_PORT% .*LISTENING" >nul && (echo Website already running on port %WEB_PORT%.) || start "IPL website (local preview)" cmd /k "cd client && node_modules\.bin\vite.cmd --port %WEB_PORT% --strictPort"
echo Started. Open http://localhost:5180 in your browser in a few seconds.
