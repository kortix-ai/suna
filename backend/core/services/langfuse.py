import os
from langfuse import Langfuse
from core.utils.logger import logger

# Get configuration from environment
public_key = os.getenv("LANGFUSE_PUBLIC_KEY")
secret_key = os.getenv("LANGFUSE_SECRET_KEY")
host = os.getenv("LANGFUSE_HOST", "https://cloud.langfuse.com")

# Determine if Langfuse should be enabled
enabled = bool(public_key and secret_key)

if enabled:
    logger.debug(f"🔍 Initializing Langfuse with host: {host}")
    try:
        langfuse = Langfuse(
            public_key=public_key,
            secret_key=secret_key,
            host=host,
            enabled=True
        )
        logger.info("✅ Langfuse initialized successfully")
    except Exception as e:
        logger.error(f"❌ Failed to initialize Langfuse: {e}")
        # Create disabled instance as fallback
        langfuse = Langfuse(enabled=False)
        enabled = False
else:
    logger.debug("⚠️ Langfuse disabled - missing LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY")
    langfuse = Langfuse(enabled=False)
