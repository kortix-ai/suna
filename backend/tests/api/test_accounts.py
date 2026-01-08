"""
Tests for account-related endpoints
"""
import pytest
import httpx


@pytest.mark.asyncio
async def test_get_accounts(client: httpx.AsyncClient):
    """GET /accounts returns user accounts"""
    response = await client.get("/accounts")
    
    assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
    data = response.json()
    assert isinstance(data, list), f"Expected list, got {type(data)}"
    # Accounts list can be empty for new users


@pytest.mark.asyncio
async def test_get_account_state(client: httpx.AsyncClient):
    """GET /billing/account-state returns billing information"""
    response = await client.get("/billing/account-state")
    
    assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
    data = response.json()
    
    # Verify required fields
    assert "tier" in data, "Account state should include tier"
    
    # Tier can be a string or object with name/display_name
    tier = data["tier"]
    if isinstance(tier, dict):
        assert "name" in tier, "Tier object should have 'name'"
        assert "display_name" in tier, "Tier object should have 'display_name'"
    else:
        assert isinstance(tier, str), "Tier should be a string or object"
    
    # Log the response for debugging
    print(f"Account state response: {data}")

