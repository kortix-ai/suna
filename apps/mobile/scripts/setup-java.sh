#!/bin/bash

# Setup Java for Android Development
# Run this after installing Java

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}Configuring Java for Android development...${NC}"

# Find Java installation
JAVA_HOME=$(/usr/libexec/java_home -v 17 2>/dev/null || /usr/libexec/java_home -v 21 2>/dev/null || /usr/libexec/java_home 2>/dev/null)

if [ -z "$JAVA_HOME" ]; then
    echo -e "${YELLOW}Java not found. Please install Java first.${NC}"
    echo "Download from: https://adoptium.net/"
    exit 1
fi

echo -e "${GREEN}✓ Found Java at: $JAVA_HOME${NC}"

# Add to .zshrc if not already there
if ! grep -q "JAVA_HOME" ~/.zshrc 2>/dev/null; then
    echo '' >> ~/.zshrc
    echo '# Java for Android Development' >> ~/.zshrc
    echo "export JAVA_HOME=$JAVA_HOME" >> ~/.zshrc
    echo 'export PATH=$JAVA_HOME/bin:$PATH' >> ~/.zshrc
    echo -e "${GREEN}✓ Added Java to ~/.zshrc${NC}"
else
    echo -e "${GREEN}✓ Java already configured in ~/.zshrc${NC}"
fi

# Verify Java
export JAVA_HOME=$JAVA_HOME
export PATH=$JAVA_HOME/bin:$PATH

java -version

echo ""
echo -e "${GREEN}✅ Java configured!${NC}"
echo ""
echo "To use in current terminal:"
echo "  export JAVA_HOME=$JAVA_HOME"
echo "  export PATH=\$JAVA_HOME/bin:\$PATH"
echo ""
echo "Or open a new terminal to load automatically."

