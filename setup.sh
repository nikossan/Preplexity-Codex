#!/bin/bash

# Perplexity Codex - Setup Script for Linux/macOS

echo ""
echo " #######################################"
echo " #                                     #"
echo " #       Perplexity Codex Setup        #"
echo " #                                     #"
echo " #######################################"
echo ""

# 1. Check for Node.js
echo "[1/3] Checking environment..."
if ! command -v node &> /dev/null
then
    echo ""
    echo "❌ ERROR: Node.js is not installed!"
    echo ""
    echo "To use this tool, you need Node.js."
    echo "Please install it using your package manager or download it from:"
    echo "https://nodejs.org/ (Choose 'LTS')"
    echo ""
    exit 1
fi

# 2. Install Dependencies
echo "[2/3] Installing dependencies (this may take a minute)..."
npm install
if [ $? -ne 0 ]; then
    echo ""
    echo "❌ ERROR: 'npm install' failed."
    echo "Please check your internet connection and try again."
    exit 1
fi

# 3. Build the project
echo "[3/3] Building the application..."
npm run build
if [ $? -ne 0 ]; then
    echo ""
    echo "❌ ERROR: Build failed."
    exit 1
fi

echo ""
echo "✅ SUCCESS! Setup is complete."
echo ""
echo "--------------------------------------------------"
echo "To start the tool later, simply run: npm start"
echo "--------------------------------------------------"
echo ""

read -p "Would you like to start the tool now? (y/n): " choice
case "$choice" in 
  y|Y ) 
    echo "Launching..."
    npm start
    ;;
  * ) 
    echo ""
    echo "You can start it anytime by running 'npm start' in this folder."
    ;;
esac
