#!/bin/bash

# Android Emulator Setup Script for Kortix Mobile
# Run once: ./scripts/setup-android.sh

set -e

echo "🤖 Setting up Android development environment..."

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo -e "${RED}This script is for macOS only${NC}"
    exit 1
fi

# Check for Homebrew
if ! command -v brew &> /dev/null; then
    echo -e "${RED}Homebrew not found. Install it first: https://brew.sh${NC}"
    exit 1
fi

# Install Android command line tools if not present
if [ ! -d "/opt/homebrew/share/android-commandlinetools" ]; then
    echo -e "${YELLOW}Installing Android command line tools...${NC}"
    brew install --cask android-commandlinetools
fi

# Set environment variables
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator

# Add to .zshrc if not already there
if ! grep -q "ANDROID_HOME" ~/.zshrc 2>/dev/null; then
    echo -e "${YELLOW}Adding Android SDK to ~/.zshrc...${NC}"
    echo '' >> ~/.zshrc
    echo '# Android SDK (added by Kortix setup script)' >> ~/.zshrc
    echo 'export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools' >> ~/.zshrc
    echo 'export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator' >> ~/.zshrc
    echo -e "${GREEN}✓ Added to ~/.zshrc${NC}"
fi

# Accept licenses
echo -e "${YELLOW}Accepting Android SDK licenses...${NC}"
yes | sdkmanager --licenses > /dev/null 2>&1 || true

# Install required SDK components
echo -e "${YELLOW}Installing Android SDK components (this may take a few minutes)...${NC}"
sdkmanager "platform-tools" "emulator" "platforms;android-34" "system-images;android-34;google_apis;arm64-v8a" > /dev/null 2>&1

# Create AVD if it doesn't exist
AVD_NAME="Kortix_Dev"
if ! avdmanager list avd 2>/dev/null | grep -q "$AVD_NAME"; then
    echo -e "${YELLOW}Creating Android Virtual Device: $AVD_NAME...${NC}"
    echo "no" | avdmanager create avd \
        --name "$AVD_NAME" \
        --package "system-images;android-34;google_apis;arm64-v8a" \
        --device "pixel_5" \
        --force > /dev/null 2>&1
    
    # Enable hardware keyboard
    AVD_CONFIG="$HOME/.android/avd/${AVD_NAME}.avd/config.ini"
    if [ -f "$AVD_CONFIG" ]; then
        # Add or update keyboard setting
        if grep -q "hw.keyboard=" "$AVD_CONFIG"; then
            sed -i '' 's/hw.keyboard=.*/hw.keyboard=yes/' "$AVD_CONFIG"
        else
            echo "hw.keyboard=yes" >> "$AVD_CONFIG"
        fi
    fi
    
    echo -e "${GREEN}✓ AVD created with keyboard enabled${NC}"
else
    # Ensure keyboard is enabled for existing AVD
    AVD_CONFIG="$HOME/.android/avd/${AVD_NAME}.avd/config.ini"
    if [ -f "$AVD_CONFIG" ]; then
        if grep -q "hw.keyboard=" "$AVD_CONFIG"; then
            sed -i '' 's/hw.keyboard=.*/hw.keyboard=yes/' "$AVD_CONFIG"
        else
            echo "hw.keyboard=yes" >> "$AVD_CONFIG"
        fi
        echo -e "${GREEN}✓ AVD keyboard enabled${NC}"
    else
        echo -e "${GREEN}✓ AVD already exists${NC}"
    fi
fi

echo ""
echo -e "${GREEN}✅ Android setup complete!${NC}"
echo ""
echo "To start developing:"
echo "  1. Open a new terminal (to load PATH changes)"
echo "  2. Run: npm run android:dev"
echo ""
echo "Or start the emulator manually:"
echo "  emulator -avd $AVD_NAME &"

