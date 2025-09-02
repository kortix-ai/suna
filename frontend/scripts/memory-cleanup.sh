#!/bin/bash

# Memory Cleanup Script for Next.js Development
# Usage: ./scripts/memory-cleanup.sh

echo "🧹 Next.js Memory Cleanup Script"
echo "================================"

# Function to get directory size
get_size() {
    if [ -d "$1" ]; then
        du -sh "$1" 2>/dev/null | cut -f1
    else
        echo "N/A"
    fi
}

# Show current memory usage
echo "📊 Current Memory Usage:"
echo "- .next cache: $(get_size .next/cache)"
echo "- .next total: $(get_size .next)"
echo "- node_modules: $(get_size node_modules)"

# Check if Next.js is running
NEXT_PID=$(pgrep -f "next-server")
if [ ! -z "$NEXT_PID" ]; then
    echo "⚠️  Next.js server is running (PID: $NEXT_PID)"
    echo "   Stop it before cleaning cache for best results"
    read -p "Stop Next.js server and continue? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        kill $NEXT_PID
        echo "✅ Stopped Next.js server"
        sleep 2
    else
        echo "❌ Cleanup cancelled"
        exit 1
    fi
fi

# Clean Next.js cache
echo "🗑️  Cleaning Next.js cache..."
if [ -d ".next" ]; then
    rm -rf .next/cache
    rm -rf .next/static
    echo "✅ Cleared .next/cache and .next/static"
else
    echo "ℹ️  No .next directory found"
fi

# Clean npm cache
echo "🗑️  Cleaning npm cache..."
npm cache clean --force
echo "✅ Cleared npm cache"

# Optional: Clean node_modules (uncomment if needed)
# echo "🗑️  Cleaning node_modules..."
# rm -rf node_modules package-lock.json
# npm install
# echo "✅ Reinstalled node_modules"

echo ""
echo "🎉 Cleanup complete!"
echo "💡 Now run: npm run dev (with memory limits)"
echo "📈 Expected memory usage: 2-4GB instead of 10GB+"
