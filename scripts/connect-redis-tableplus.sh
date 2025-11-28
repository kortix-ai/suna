#!/bin/bash
# Port forward Redis to localhost for TablePlus connection
# This uses AWS Systems Manager Session Manager

REDIS_HOST="suna-redis-550707f-001.r1ljes.0001.usw2.cache.amazonaws.com"
REDIS_PORT=6379
LOCAL_PORT=6380
INSTANCE_ID="i-017e5ae434f209365"

echo "🔌 Setting up port forwarding..."
echo "   Redis: $REDIS_HOST:$REDIS_PORT"
echo "   Local:  localhost:$LOCAL_PORT"
echo ""
echo "📋 Connect TablePlus to:"
echo "   Host: localhost"
echo "   Port: $LOCAL_PORT"
echo "   Password: (none)"
echo ""
echo "⚠️  Keep this terminal open while using TablePlus"
echo "   Press Ctrl+C to stop port forwarding"
echo ""

# Start port forwarding session
aws ssm start-session \
  --target $INSTANCE_ID \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$REDIS_HOST\"],\"portNumber\":[\"$REDIS_PORT\"],\"localPortNumber\":[\"$LOCAL_PORT\"]}"

