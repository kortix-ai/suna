"""
Temporal Cloud client configuration and singleton.

Provides a singleton Temporal client connected to Temporal Cloud with API key authentication.
"""
import os
from typing import Optional
from temporalio.client import Client
from core.utils.logger import logger


_temporal_client: Optional[Client] = None


async def get_temporal_client() -> Client:
    """
    Get or create the Temporal Cloud client singleton.
    
    Returns:
        Connected Temporal client instance
        
    Raises:
        ValueError: If required environment variables are not set
        Exception: If connection to Temporal Cloud fails
    """
    global _temporal_client
    
    if _temporal_client is not None:
        return _temporal_client
    
    # Get configuration from environment
    temporal_address = os.getenv("TEMPORAL_ADDRESS")
    temporal_namespace = os.getenv("TEMPORAL_NAMESPACE")
    temporal_api_key = os.getenv("TEMPORAL_API_KEY")
    
    if not temporal_address:
        raise ValueError("TEMPORAL_ADDRESS environment variable is required")
    if not temporal_namespace:
        raise ValueError("TEMPORAL_NAMESPACE environment variable is required")
    if not temporal_api_key:
        raise ValueError("TEMPORAL_API_KEY environment variable is required")
    
    logger.info(f"Connecting to Temporal Cloud at {temporal_address} (namespace: {temporal_namespace})")
    
    try:
        _temporal_client = await Client.connect(
            temporal_address,
            namespace=temporal_namespace,
            api_key=temporal_api_key,
            tls=True,
        )
        logger.info("✅ Successfully connected to Temporal Cloud")
        return _temporal_client
    except Exception as e:
        logger.error(f"Failed to connect to Temporal Cloud: {e}")
        raise


async def close_temporal_client():
    """
    Reset the Temporal client connection.
    
    Note: Temporal clients don't have an explicit close() method.
    This function resets the singleton to allow reconnection if needed.
    """
    global _temporal_client
    if _temporal_client is not None:
        # Temporal clients don't have an explicit close method
        # Just reset the singleton to allow reconnection
        _temporal_client = None
        logger.info("Temporal client connection reset")

