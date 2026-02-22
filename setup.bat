@echo off
setlocal enabledelayedexpansion
title Perplexity Codex - Setup

echo.
echo  #######################################
echo  #                                     #
echo  #       Perplexity Codex Setup        #
echo  #                                     #
echo  #######################################
echo.

:: 1. Check for Node.js
echo [1/3] Checking environment...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo ❌ ERROR: Node.js is not installed!
    echo.
    echo To use this tool, you need Node.js. 
    echo 1. Download it here: https://nodejs.org/ (Choose "LTS")
    echo 2. Run the installer and restart this script.
    echo.
    echo Opening download page for you...
    start https://nodejs.org/
    pause
    exit /b 1
)

:: 2. Install Dependencies
echo [2/3] Installing dependencies (this may take a minute)...
call npm install
if %errorlevel% neq 0 (
    echo.
    echo ❌ ERROR: "npm install" failed. 
    echo Please check your internet connection and try again.
    pause
    exit /b 1
)

:: 3. Build the project
echo [3/3] Building the application...
call npm run build
if %errorlevel% neq 0 (
    echo.
    echo ❌ ERROR: Build failed.
    pause
    exit /b 1
)

echo.
echo ✅ SUCCESS! Setup is complete.
echo.
echo --------------------------------------------------
echo To start the tool later, simply run: npm start
echo --------------------------------------------------
echo.

set /p choice="Would you like to start the tool now? (y/n): "
if /i "%choice%"=="y" (
    echo Launching...
    npm start
) else (
    echo.
    echo You can start it anytime by running "npm start" in this folder.
    pause
)

