#!/bin/bash

# Start Android Emulator and Expo Dev Server
# Usage: ./scripts/start-android.sh

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Set environment variables
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator

AVD_NAME="Kortix_Dev"

# Check if emulator is already running
if adb devices 2>/dev/null | grep -q "emulator"; then
    echo -e "${GREEN}✓ Emulator already running${NC}"
else
    echo -e "${YELLOW}Starting emulator...${NC}"
    
    # Check if AVD exists
    if ! avdmanager list avd 2>/dev/null | grep -q "$AVD_NAME"; then
        echo -e "${RED}AVD not found. Run setup first: ./scripts/setup-android.sh${NC}"
        exit 1
    fi
    
    # Start emulator in background
    emulator -avd "$AVD_NAME" -no-snapshot-load &
    EMULATOR_PID=$!
    
    # Wait for emulator to boot
    echo -e "${YELLOW}Waiting for emulator to boot...${NC}"
    adb wait-for-device
    
    # Wait for boot animation to complete
    while [ "$(adb shell getprop sys.boot_completed 2>/dev/null)" != "1" ]; do
        sleep 2
    done
    
    echo -e "${GREEN}✓ Emulator ready${NC}"
fi

# Check if dev client is installed
DEV_CLIENT_PACKAGE="com.kortix.app"
if ! adb shell pm list packages 2>/dev/null | grep -q "$DEV_CLIENT_PACKAGE"; then
    echo -e "${YELLOW}⚠️  Dev client not installed${NC}"
    echo -e "${YELLOW}You need to build and install the dev client first.${NC}"
    echo ""
    echo -e "${GREEN}Recommended (fast, uses cache):${NC}"
    echo -e "${GREEN}  npm run android:build${NC}"
    echo -e "${GREEN}  or: eas build:dev --platform android${NC}"
    echo ""
    echo -e "${YELLOW}Alternative (full build):${NC}"
    echo -e "${YELLOW}  eas build --profile development --platform android${NC}"
    echo ""
    read -p "Would you like to build and install now? (y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${YELLOW}Building dev client (this may take a few minutes)...${NC}"
        eas build:dev --platform android
        
        # Check again after build
        if ! adb shell pm list packages 2>/dev/null | grep -q "$DEV_CLIENT_PACKAGE"; then
            echo -e "${RED}Failed to install dev client. Please install manually.${NC}"
            exit 1
        fi
        
        echo -e "${GREEN}✓ Dev client installed${NC}"
        echo ""
    else
        echo -e "${YELLOW}Please build and install the dev client, then run this script again.${NC}"
        exit 1
    fi
fi

# Start Expo dev client
echo -e "${YELLOW}Starting Expo dev client...${NC}"
echo -e "${GREEN}✓ When Expo starts, manually open the Kortix dev client app on the emulator${NC}"
echo -e "${GREEN}  Or scan the QR code / enter the URL shown in the terminal${NC}"
echo ""

# Start Expo with dev client
npx expo start --dev-client

