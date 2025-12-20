import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from core.services import redis as redis_service


async def test_redis_connection():
    print("Testing Redis connection...")
    print("-" * 40)
    
    config = redis_service.get_redis_config()
    print(f"Redis Host: {config['host']}")
    print(f"Redis Port: {config['port']}")
    print(f"Redis Username: {config['username'] or 'None'}")
    print(f"Redis Password: {'***' if config['password'] else 'None'}")
    print(f"Redis SSL: {config['ssl']}")
    print("-" * 40)
    
    try:
        client = await redis_service.initialize_async()
        print("✓ Successfully connected to Redis!")
        
        info = await redis_service.get_connection_info()
        if "error" not in info:
            print(f"\nServer Info:")
            print(f"  Connected clients: {info['server'].get('connected_clients', 'N/A')}")
            print(f"\nPool Info:")
            print(f"  Max connections: {info['pool'].get('max_connections', 'N/A')}")
        
        await redis_service.set("test_key", "test_value", ex=10)
        value = await redis_service.get("test_key")
        if value == "test_value":
            print("\n✓ Read/Write test passed!")
        else:
            print("\n✗ Read/Write test failed!")
        
        await redis_service.delete("test_key")
        
    except ConnectionError as e:
        print(f"✗ Connection Error: {e}")
        return False
    except Exception as e:
        print(f"✗ Error: {e}")
        return False
    finally:
        await redis_service.close()
        print("\nConnection closed.")
    
    return True


if __name__ == "__main__":
    success = asyncio.run(test_redis_connection())
    sys.exit(0 if success else 1)

