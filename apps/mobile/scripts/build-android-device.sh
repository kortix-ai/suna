#!/bin/bash

# Build and install Android app on connected device
# Usage: ./scripts/build-android-device.sh

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Set environment variables
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools
export JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home
export PATH=$JAVA_HOME/bin:$PATH

echo -e "${YELLOW}Checking environment...${NC}"

# Verify Java
if ! command -v java &> /dev/null; then
    echo -e "${RED}Java not found. Please run: ./scripts/setup-java.sh${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Java: $(java -version 2>&1 | head -1)${NC}"

# Verify adb
if ! command -v adb &> /dev/null; then
    echo -e "${RED}adb not found. Make sure ANDROID_HOME is set correctly.${NC}"
    exit 1
fi

# Check for connected devices
echo -e "${YELLOW}Checking for connected Android devices...${NC}"
DEVICES=$(adb devices | grep -v "List" | grep "device$" | wc -l | tr -d ' ')

if [ "$DEVICES" -eq "0" ]; then
    echo -e "${RED}No Android devices found!${NC}"
    echo ""
    echo -e "${YELLOW}Please:${NC}"
    echo "  1. Connect your Android phone via USB"
    echo "  2. Enable USB Debugging"
    echo "  3. Accept the USB debugging prompt"
    echo ""
    adb devices
    exit 1
fi

echo -e "${GREEN}✓ Found $DEVICES connected device(s)${NC}"
adb devices
echo ""

# Build and install
echo -e "${YELLOW}Building and installing app on device...${NC}"
echo -e "${GREEN}This may take a few minutes on first build...${NC}"
echo ""

cd "$(dirname "$0")/.."
npx expo run:android --device

echo ""
echo -e "${GREEN}✅ Build complete!${NC}"
echo ""
echo "To start the development server:"
echo "  npx expo start --dev-client"

