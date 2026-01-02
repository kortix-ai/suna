#!/bin/bash

# Start Expo Dev Server for Physical Android Device
# Usage: ./scripts/start-android-device.sh

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Set Android environment variables
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/platform-tools

# Check if adb is available
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
    echo "  2. Enable USB Debugging on your phone:"
    echo "     - Go to Settings > About Phone"
    echo "     - Tap 'Build Number' 7 times to enable Developer Options"
    echo "     - Go to Settings > Developer Options"
    echo "     - Enable 'USB Debugging'"
    echo "  3. Accept the USB debugging prompt on your phone"
    echo "  4. Run this script again"
    echo ""
    echo -e "${YELLOW}To check devices manually:${NC}"
    echo "  adb devices"
    exit 1
fi

echo -e "${GREEN}✓ Found $DEVICES connected device(s)${NC}"
adb devices

# Check if dev client is installed
DEV_CLIENT_PACKAGE="com.kortix.app"
if ! adb shell pm list packages 2>/dev/null | grep -q "$DEV_CLIENT_PACKAGE"; then
    echo -e "${YELLOW}⚠️  Dev client not installed on device${NC}"
    echo ""
    echo -e "${YELLOW}You need to build and install the dev client first.${NC}"
    echo ""
    echo -e "${GREEN}Option 1 - Local build (fastest):${NC}"
    echo -e "  npx expo run:android --device"
    echo ""
    echo -e "${GREEN}Option 2 - EAS build (cloud):${NC}"
    echo -e "  eas build --profile development --platform android"
    echo ""
    read -p "Would you like to build and install now? (y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${YELLOW}Building dev client...${NC}"
        npx expo run:android --device
    else
        echo -e "${YELLOW}Please build and install the dev client, then run this script again.${NC}"
        exit 1
    fi
fi

echo ""
echo -e "${GREEN}✓ Dev client installed${NC}"
echo ""
echo -e "${YELLOW}Starting Expo dev server...${NC}"
echo -e "${GREEN}✓ When Expo starts, open the Kortix app on your device${NC}"
echo -e "${GREEN}  Or scan the QR code shown in the terminal${NC}"
echo ""

# Start Expo with dev client
npx expo start --dev-client

