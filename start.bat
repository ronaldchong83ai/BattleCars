@echo off
title Battle Cars - Local File Server
echo ==============================================
echo        BATTLE CARS - 3D CAR SHOOTER GAME
echo ==============================================
echo.
echo NOTE: The Authoritative DGS runs on the remote server.
echo       This script only serves the static files locally.
echo.
echo Starting local web server on port 8000...
echo Opening browser: http://localhost:8000
echo.
echo Press Ctrl+C to stop.
echo ==============================================
echo.

:: Open the browser first
start "" "http://localhost:8000"

:: Start the Python HTTP file server for local development
python -m http.server 8000
