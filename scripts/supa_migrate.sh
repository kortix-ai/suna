#!/bin/bash

# Check if supabase CLI is installed
if ! command -v supabase &> /dev/null; then
    echo "❌ Error: supabase CLI is not installed"
    echo "Please install it from: https://supabase.com/docs/guides/cli"
    exit 1
fi

# Run migration
echo "🔄 Running Supabase migration..."
supabase db push

# Check if migration was successful
if [ $? -eq 0 ]; then
    echo "✅ DB migrated"
else
    echo "❌ Migration failed"
    exit 1
fi
