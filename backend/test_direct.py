import asyncio
import httpx

async def test_direct():
    # Test calling agent/start directly
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            response = await client.post(
                "http://localhost:8000/v1/agent/start",
                data={
                    'prompt': 'Hi',
                    'model_name': 'kortix/basic',
                },
                headers={
                    'Authorization': 'Bearer test_admin_key_for_local_testing_12345'
                }
            )
            print(f"Status: {response.status_code}")
            print(f"Response: {response.text}")
        except Exception as e:
            print(f"Error: {e}")

asyncio.run(test_direct())
