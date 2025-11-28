#!/bin/bash
# Quick Redis stats - run this via ECS Exec or locally if you have Redis access

REDIS_HOST="${REDIS_HOST:-suna-redis-550707f-001.r1ljes.0001.usw2.cache.amazonaws.com}"
REDIS_PORT="${REDIS_PORT:-6379}"

echo "=========================================="
echo "📊 REDIS MEMORY STATS"
echo "=========================================="
redis-cli -h $REDIS_HOST -p $REDIS_PORT INFO memory | grep -E "used_memory|used_memory_human|used_memory_peak|maxmemory"

echo ""
echo "=========================================="
echo "📋 KEY COUNTS BY PATTERN"
echo "=========================================="
echo "agent_run:*:responses: $(redis-cli -h $REDIS_HOST -p $REDIS_PORT --scan --pattern 'agent_run:*:responses' | wc -l)"
echo "agent_config:*: $(redis-cli -h $REDIS_HOST -p $REDIS_PORT --scan --pattern 'agent_config:*' | wc -l)"
echo "agent_mcps:*: $(redis-cli -h $REDIS_HOST -p $REDIS_PORT --scan --pattern 'agent_mcps:*' | wc -l)"
echo "project:*: $(redis-cli -h $REDIS_HOST -p $REDIS_PORT --scan --pattern 'project:*' | wc -l)"
echo "dramatiq:*: $(redis-cli -h $REDIS_HOST -p $REDIS_PORT --scan --pattern 'dramatiq:*' | wc -l)"
echo "active_run:*: $(redis-cli -h $REDIS_HOST -p $REDIS_PORT --scan --pattern 'active_run:*' | wc -l)"
echo "thread_count:*: $(redis-cli -h $REDIS_HOST -p $REDIS_PORT --scan --pattern 'thread_count:*' | wc -l)"
echo "api_key:*: $(redis-cli -h $REDIS_HOST -p $REDIS_PORT --scan --pattern 'api_key:*' | wc -l)"
echo "account_state:*: $(redis-cli -h $REDIS_HOST -p $REDIS_PORT --scan --pattern 'account_state:*' | wc -l)"
echo "Total keys: $(redis-cli -h $REDIS_HOST -p $REDIS_PORT DBSIZE)"

echo ""
echo "=========================================="
echo "🔝 SAMPLE KEYS (first 10 of each pattern)"
echo "=========================================="
echo ""
echo "agent_run:*:responses:"
redis-cli -h $REDIS_HOST -p $REDIS_PORT --scan --pattern 'agent_run:*:responses' | head -10
echo ""
echo "agent_config:*:"
redis-cli -h $REDIS_HOST -p $REDIS_PORT --scan --pattern 'agent_config:*' | head -10

