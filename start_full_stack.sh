#!/bin/bash
# Complete Kusor stack startup script with uv

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Starting Kusor Full Stack with uv${NC}"

# Check if uv is available
if ! command -v uv &> /dev/null; then
    echo -e "${RED}❌ uv is not installed or not in PATH${NC}"
    echo "Install it with: curl -LsSf https://astral.sh/uv/install.sh | sh"
    exit 1
fi

# Add uv to PATH
export PATH="$HOME/.local/bin:$PATH"

# Function to check if port is in use
check_port() {
    local port=$1
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null ; then
        return 0  # Port is in use
    else
        return 1  # Port is free
    fi
}

# Stop Docker services if running
echo -e "${YELLOW}📦 Checking Docker services...${NC}"
if docker-compose ps | grep -q "Up"; then
    echo -e "${YELLOW}🛑 Stopping Docker services...${NC}"
    docker-compose down
fi

# Start Redis
echo -e "${YELLOW}🔴 Starting Redis...${NC}"
docker-compose up redis -d

# Wait for Redis to be ready
echo -e "${YELLOW}⏳ Waiting for Redis to be ready...${NC}"
sleep 3

# Check if backend port is free
if check_port 8000; then
    echo -e "${RED}❌ Port 8000 is already in use${NC}"
    echo "Please stop the service using port 8000 or use a different port"
    exit 1
fi

# Start backend
echo -e "${GREEN}🔧 Starting backend with uv...${NC}"
cd backend
uv run api.py &
BACKEND_PID=$!

# Wait for backend to start
echo -e "${YELLOW}⏳ Waiting for backend to start...${NC}"
sleep 5

# Check if backend is running
if ! curl -s http://localhost:8000/ > /dev/null; then
    echo -e "${RED}❌ Backend failed to start${NC}"
    kill $BACKEND_PID 2>/dev/null || true
    exit 1
fi

echo -e "${GREEN}✅ Backend is running on http://localhost:8000${NC}"

# Start agent worker
echo -e "${GREEN}🤖 Starting agent worker with uv...${NC}"
uv run dramatiq run_agent_background &
WORKER_PID=$!

echo -e "${GREEN}✅ Agent worker is running${NC}"

# Go back to root directory
cd ..

echo -e "${GREEN}🎉 Kusor Full Stack is running!${NC}"
echo -e "${BLUE}📊 Services:${NC}"
echo -e "  • Redis: localhost:6379"
echo -e "  • Backend API: http://localhost:8000"
echo -e "  • API Docs: http://localhost:8000/docs"
echo -e "  • Agent Worker: Running"
echo ""
echo -e "${YELLOW}📱 To start the mobile app:${NC}"
echo -e "  cd apps/mobile && npx expo start --ios"
echo ""
echo -e "${YELLOW}🛑 To stop all services:${NC}"
echo -e "  kill $BACKEND_PID $WORKER_PID"
echo -e "  docker-compose down"
echo ""
echo -e "${BLUE}Press Ctrl+C to stop all services${NC}"

# Wait for interrupt
trap "echo -e '\n${YELLOW}🛑 Stopping services...${NC}'; kill $BACKEND_PID $WORKER_PID 2>/dev/null || true; docker-compose down; echo -e '${GREEN}✅ All services stopped${NC}'; exit 0" INT

# Keep script running
wait
