#!/bin/bash
set -e

API_URL="http://localhost:8000/v1"
ADMIN_API_KEY="test_admin_key_for_local_testing_12345"

echo "🧪 Testing E2E Benchmark Test Harness Locally"
echo "=============================================="
echo ""

# Function to wait for test completion
wait_for_test() {
    local run_id=$1
    local test_name=$2
    local max_wait=300  # 5 minutes
    local elapsed=0
    local interval=3
    
    echo "⏳ Waiting for $test_name to complete (run_id: $run_id)..."
    
    while [ $elapsed -lt $max_wait ]; do
        sleep $interval
        elapsed=$((elapsed + interval))
        
        response=$(curl -s "$API_URL/admin/test-harness/runs/$run_id" \
            -H "X-Admin-Api-Key: $ADMIN_API_KEY")
        
        status=$(echo "$response" | jq -r '.status // "unknown"')
        total=$(echo "$response" | jq -r '.summary.total_prompts // 0')
        successful=$(echo "$response" | jq -r '.summary.successful // 0')
        
        echo "  [$elapsed/${max_wait}s] Status: $status | Progress: $successful/$total"
        
        if [ "$status" = "completed" ]; then
            echo ""
            echo "✅ $test_name completed successfully!"
            echo "$response" | jq '.'
            return 0
        elif [ "$status" = "failed" ]; then
            echo ""
            echo "❌ $test_name failed!"
            echo "$response" | jq '.'
            return 1
        fi
    done
    
    echo ""
    echo "⏱️  $test_name timed out after ${max_wait}s"
    return 1
}

# Test 1: Core Test (single prompt)
echo "📋 Test 1: Core Test (single prompt)"
echo "-----------------------------------"
echo ""

core_payload=$(jq -n \
    --arg mode "core_test" \
    --argjson concurrency 1 \
    --arg model "kortix/basic" \
    --argjson prompt_ids '["edge_conversation"]' \
    '{
        mode: $mode,
        concurrency: $concurrency,
        model: $model,
        prompt_ids: $prompt_ids
    }')

echo "📤 Starting core test..."
echo "$core_payload" | jq '.'
echo ""

core_response=$(curl -s -X POST "$API_URL/admin/test-harness/run" \
    -H "X-Admin-Api-Key: $ADMIN_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$core_payload")

core_run_id=$(echo "$core_response" | jq -r '.run_id')

if [ -z "$core_run_id" ] || [ "$core_run_id" = "null" ]; then
    echo "❌ Failed to start core test"
    echo "$core_response" | jq '.'
    exit 1
fi

echo "✅ Core test started: $core_run_id"
echo ""

wait_for_test "$core_run_id" "Core Test"

echo ""
echo "================================================"
echo ""
sleep 3

# Test 2: Stress Test (5 executions, concurrency 2)
echo "🔥 Test 2: Stress Test (5 executions, concurrency 2)"
echo "---------------------------------------------------"
echo ""

stress_payload=$(jq -n \
    --arg mode "stress_test" \
    --argjson concurrency 2 \
    --argjson num_executions 5 \
    --argjson prompt_ids '["edge_conversation", "edge_knowledge"]' \
    '{
        mode: $mode,
        concurrency: $concurrency,
        num_executions: $num_executions,
        prompt_ids: $prompt_ids
    }')

echo "📤 Starting stress test..."
echo "$stress_payload" | jq '.'
echo ""

stress_response=$(curl -s -X POST "$API_URL/admin/test-harness/run" \
    -H "X-Admin-Api-Key: $ADMIN_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$stress_payload")

stress_run_id=$(echo "$stress_response" | jq -r '.run_id')

if [ -z "$stress_run_id" ] || [ "$stress_run_id" = "null" ]; then
    echo "❌ Failed to start stress test"
    echo "$stress_response" | jq '.'
    exit 1
fi

echo "✅ Stress test started: $stress_run_id"
echo ""

wait_for_test "$stress_run_id" "Stress Test"

echo ""
echo "================================================"
echo ""
echo "🎉 All tests completed successfully!"
echo ""
echo "📊 Summary:"
echo "  - Core Test Run ID: $core_run_id"
echo "  - Stress Test Run ID: $stress_run_id"
echo ""
echo "To view full results:"
echo "  curl $API_URL/admin/test-harness/runs/$core_run_id -H \"X-Admin-Api-Key: $ADMIN_API_KEY\" | jq '.'"
echo "  curl $API_URL/admin/test-harness/runs/$stress_run_id -H \"X-Admin-Api-Key: $ADMIN_API_KEY\" | jq '.'"

