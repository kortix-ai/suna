import dramatiq
from dramatiq.brokers.redis import RedisBroker
from core.utils.logger import logger
from core.services.redis import get_redis_config

_broker_initialized = False
_broker = None

def get_broker():
    """
    Get or initialize the Dramatiq Redis broker.
    This is safe to call multiple times - it will only initialize once.
    
    Returns:
        RedisBroker: The configured Dramatiq broker instance
    """
    global _broker_initialized, _broker
    
    if _broker_initialized:
        return _broker
    
    redis_config = get_redis_config()
    redis_host = redis_config["host"]
    redis_port = redis_config["port"]
    redis_username = redis_config["username"]
    
    if redis_config["url"]:
        auth_info = f" (user={redis_username})" if redis_username else ""
        logger.info(f"🔧 Initializing Dramatiq broker with Redis at {redis_host}:{redis_port}{auth_info}")
        _broker = RedisBroker(url=redis_config["url"], middleware=[dramatiq.middleware.AsyncIO()])
    else:
        logger.info(f"🔧 Initializing Dramatiq broker with Redis at {redis_host}:{redis_port}")
        _broker = RedisBroker(host=redis_host, port=redis_port, middleware=[dramatiq.middleware.AsyncIO()])
    
    dramatiq.set_broker(_broker)
    _broker_initialized = True
    logger.info("✅ Dramatiq broker initialized")
    
    return _broker

def ensure_broker():
    """
    Ensure the Dramatiq broker is initialized.
    Call this before sending any Dramatiq messages.
    """
    get_broker()

