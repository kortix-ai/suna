# E2E API Tests

## Overview

The test suite consists of a **single comprehensive E2E test** (`test_complete_api_flow`) that tests all API routes from top to bottom in sequence:

1. Account Creation & Setup Verification
2. GET /accounts - List user accounts
3. GET /billing/account-state - Get billing/tier information
4. GET /threads - List user threads
5. GET /agent-runs/active - List active agent runs
6. POST /agent/start - Start agent run with file attachments
7. GET /agent-run/{id}/stream - Stream agent run immediately
8. GET /projects/{id} - Get project details
9. GET /threads/{id} - Get thread details
10. GET /threads/{id}/messages - Get thread messages
11. GET /thread/{id}/agent-runs - Get agent runs for thread
12. POST /agent-run/{id}/stop - Stop agent run (if still running)

## Run Tests

```bash
cd backend && uv run pytest tests/ -v
```

## Run E2E Test Only

```bash
# Run the comprehensive E2E test
uv run pytest tests/e2e/test_full_flow.py::test_complete_api_flow -v

# With markers
uv run pytest tests/ -m e2e -v
```

## Run Tests via API

```bash
# Trigger E2E tests via API endpoint
curl -X POST "http://localhost:8000/v1/admin/tests/e2e" \
  -H "X-Admin-Api-Key: YOUR_ADMIN_API_KEY" \
  -H "Content-Type: application/json"

# With test filter
curl -X POST "http://localhost:8000/v1/admin/tests/e2e?test_filter=test_complete_api_flow" \
  -H "X-Admin-Api-Key: YOUR_ADMIN_API_KEY" \
  -H "Content-Type: application/json"
```

## Test User Setup

- Test users are automatically created with random yopmail addresses (e.g., `e2e_test_abc123@yopmail.com`)
- Each test session gets a unique email address
- Account initialization (billing tier, credits, default agent) happens automatically
- The test user email is printed at the start of each test run

## Requirements

- Backend API running (default: `http://localhost:8000/v1`)
- Environment variables configured in `.env`
- `KORTIX_ADMIN_API_KEY` set for API endpoint access

## Test Structure

- `e2e/test_full_flow.py` - **Primary comprehensive E2E test** (tests all routes)
