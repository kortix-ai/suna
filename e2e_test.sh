#!/bin/bash

# E2E test script for Suna platform
set -e

echo "🚀 Suna Platform E2E Test"
echo "========================="

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Configuration
SUPABASE_URL="https://uaoxoehlkulpqyuezfwq.supabase.co"
SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVhb3hvZWhsa3VscHF5dWV6ZndxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc1Nzc4MjMsImV4cCI6MjA3MzE1MzgyM30.m-xbvxiOhU9wvnqYZA7jOFKX218eYh2tkc6tOucb6-A"

echo "Step 1: Starting services..."
echo "----------------------------"
docker-compose down &>/dev/null
docker-compose up -d

echo "Waiting for services to start..."
sleep 10

echo ""
echo "Step 2: Health checks..."
echo "------------------------"
./health_check.sh

echo ""
echo "Step 3: Testing Supabase threads endpoint..."
echo "--------------------------------------------"
echo "Testing with provided curl command:"

response=$(curl -s "${SUPABASE_URL}/rest/v1/threads?select=*&account_id=eq.c489bc3b-e76b-46f3-b79a-ebde335ff1cf" \
  -H 'accept: */*' \
  -H 'accept-language: en-US,en;q=0.9' \
  -H 'accept-profile: public' \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "authorization: Bearer ${SUPABASE_ANON_KEY}" \
  -H 'origin: http://localhost:3000' \
  -H 'referer: http://localhost:3000/')

if echo "$response" | grep -q "error"; then
    echo -e "${RED}✗ Failed${NC}"
    echo "Error response:"
    echo "$response" | python3 -m json.tool
else
    echo -e "${GREEN}✓ Success${NC}"
    echo "Response:"
    echo "$response" | python3 -m json.tool | head -20
fi

echo ""
echo "Step 4: Testing backend API..."
echo "------------------------------"
echo -n "GET /health: "
health_response=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:8000/health")
if [[ "$health_response" == "200" ]]; then
    echo -e "${GREEN}✓ OK${NC}"
else
    echo -e "${RED}✗ Failed (HTTP $health_response)${NC}"
fi

echo -n "GET /api/agents: "
agents_response=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:8000/api/agents")
if [[ "$agents_response" == "200" ]] || [[ "$agents_response" == "401" ]]; then
    echo -e "${GREEN}✓ OK${NC} (HTTP $agents_response)"
else
    echo -e "${RED}✗ Failed (HTTP $agents_response)${NC}"
fi

echo ""
echo "Step 5: Testing frontend..."
echo "---------------------------"
echo -n "GET /: "
frontend_response=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000/")
if [[ "$frontend_response" == "200" ]]; then
    echo -e "${GREEN}✓ OK${NC}"
else
    echo -e "${RED}✗ Failed (HTTP $frontend_response)${NC}"
fi

echo -n "GET /dashboard: "
dashboard_response=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000/dashboard")
if [[ "$dashboard_response" == "200" ]] || [[ "$dashboard_response" == "307" ]]; then
    echo -e "${GREEN}✓ OK${NC} (HTTP $dashboard_response)"
else
    echo -e "${RED}✗ Failed (HTTP $dashboard_response)${NC}"
fi

echo ""
echo "========================="
echo "E2E test complete!"
echo ""
echo "To stop services run: docker-compose down"
echo "To view logs run: docker-compose logs -f"