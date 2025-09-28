#!/bin/bash

# Health check script for Suna platform
set -e

echo "🔍 Suna Platform Health Check"
echo "=============================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to check service
check_service() {
    local service=$1
    local url=$2
    local expected=$3
    
    echo -n "Checking $service... "
    
    response=$(curl -s -o /dev/null -w "%{http_code}" "$url" || echo "000")
    
    if [[ "$response" == "$expected" ]]; then
        echo -e "${GREEN}✓ OK${NC} (HTTP $response)"
        return 0
    else
        echo -e "${RED}✗ FAILED${NC} (HTTP $response, expected $expected)"
        return 1
    fi
}

# Function to check Docker container
check_container() {
    local container=$1
    echo -n "Checking container $container... "
    
    if docker ps | grep -q "$container"; then
        status=$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || echo "no-health-check")
        if [[ "$status" == "healthy" ]] || [[ "$status" == "no-health-check" ]]; then
            echo -e "${GREEN}✓ Running${NC}"
            return 0
        else
            echo -e "${YELLOW}⚠ Running but $status${NC}"
            return 1
        fi
    else
        echo -e "${RED}✗ Not running${NC}"
        return 1
    fi
}

# Function to test Supabase connection
test_supabase() {
    echo -n "Testing Supabase connection... "
    
    # Test with your actual Supabase URL and anon key
    response=$(curl -s -o /dev/null -w "%{http_code}" \
        "https://uaoxoehlkulpqyuezfwq.supabase.co/rest/v1/" \
        -H "apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVhb3hvZWhsa3VscHF5dWV6ZndxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc1Nzc4MjMsImV4cCI6MjA3MzE1MzgyM30.m-xbvxiOhU9wvnqYZA7jOFKX218eYh2tkc6tOucb6-A" \
        -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVhb3hvZWhsa3VscHF5dWV6ZndxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc1Nzc4MjMsImV4cCI6MjA3MzE1MzgyM30.m-xbvxiOhU9wvnqYZA7jOFKX218eYh2tkc6tOucb6-A" \
        || echo "000")
    
    if [[ "$response" == "200" ]]; then
        echo -e "${GREEN}✓ Connected${NC}"
        return 0
    else
        echo -e "${RED}✗ Failed${NC} (HTTP $response)"
        return 1
    fi
}

# Function to test thread endpoint
test_threads_endpoint() {
    echo -n "Testing threads endpoint... "
    
    response=$(curl -s "https://uaoxoehlkulpqyuezfwq.supabase.co/rest/v1/threads?select=id&limit=1" \
        -H "apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVhb3hvZWhsa3VscHF5dWV6ZndxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc1Nzc4MjMsImV4cCI6MjA3MzE1MzgyM30.m-xbvxiOhU9wvnqYZA7jOFKX218eYh2tkc6tOucb6-A" \
        -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVhb3hvZWhsa3VscHF5dWV6ZndxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc1Nzc4MjMsImV4cCI6MjA3MzE1MzgyM30.m-xbvxiOhU9wvnqYZA7jOFKX218eYh2tkc6tOucb6-A" \
        2>/dev/null)
    
    if echo "$response" | grep -q "error"; then
        error_msg=$(echo "$response" | python3 -c "import sys, json; print(json.load(sys.stdin).get('message', 'Unknown error'))" 2>/dev/null || echo "Parse error")
        echo -e "${RED}✗ Failed${NC} - $error_msg"
        return 1
    else
        echo -e "${GREEN}✓ Table exists${NC}"
        return 0
    fi
}

echo ""
echo "1. Docker Services"
echo "------------------"
check_container "suna_backend_1"
check_container "suna_worker_1"
check_container "suna_frontend_1"
check_container "suna_redis_1"

echo ""
echo "2. HTTP Endpoints"
echo "-----------------"
check_service "Backend API" "http://localhost:8000/health" "200"
check_service "Frontend" "http://localhost:3000" "200"

echo ""
echo "3. Redis"
echo "--------"
echo -n "Testing Redis connection... "
if redis-cli ping &>/dev/null; then
    echo -e "${GREEN}✓ Connected${NC}"
else
    echo -e "${RED}✗ Failed${NC}"
fi

echo ""
echo "4. Supabase"
echo "-----------"
test_supabase
test_threads_endpoint

echo ""
echo "=============================="
echo "Health check complete!"