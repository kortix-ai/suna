import os
from typing import Optional
from temporalio.client import Client, TLSConfig
from core.utils.logger import logger

_client: Optional[Client] = None

def get_temporal_config() -> dict:
    return {
        "namespace": os.getenv("TEMPORAL_NAMESPACE", ""),
        "address": os.getenv("TEMPORAL_ADDRESS", ""),
        "api_key": os.getenv("TEMPORAL_API_KEY", ""),
        "tls_cert_path": os.getenv("TEMPORAL_TLS_CERT_PATH", ""),
        "tls_key_path": os.getenv("TEMPORAL_TLS_KEY_PATH", ""),
    }

async def get_temporal_client() -> Client:
    global _client
    
    if _client is not None:
        return _client
    
    config = get_temporal_config()
    
    if not config["namespace"] or not config["address"]:
        raise ValueError(
            "TEMPORAL_NAMESPACE and TEMPORAL_ADDRESS must be set. "
            "Get these from your Temporal Cloud dashboard."
        )
    
    tls_config = None
    
    if config["api_key"]:
        tls_config = TLSConfig()
        logger.info(f"Connecting to Temporal: {config['address']}")
        _client = await Client.connect(
            config["address"],
            namespace=config["namespace"],
            tls=tls_config,
            rpc_metadata={"temporal-namespace": config["namespace"]},
            api_key=config["api_key"],
        )
    elif config["tls_cert_path"] and config["tls_key_path"]:
        with open(config["tls_cert_path"], "rb") as f:
            client_cert = f.read()
        with open(config["tls_key_path"], "rb") as f:
            client_key = f.read()
        
        tls_config = TLSConfig(
            client_cert=client_cert,
            client_private_key=client_key,
        )
        logger.info(f"Connecting to Temporal: {config['address']}")
        _client = await Client.connect(
            config["address"],
            namespace=config["namespace"],
            tls=tls_config,
        )
    else:
        raise ValueError(
            "Either TEMPORAL_API_KEY or both TEMPORAL_TLS_CERT_PATH and "
            "TEMPORAL_TLS_KEY_PATH must be set for Temporal Cloud authentication."
        )
    
    logger.info(f"✅ Connected to Temporal Cloud namespace: {config['namespace']}")
    return _client

async def close_temporal_client():
    global _client
    if _client is not None:
        await _client.close()
        _client = None
        logger.info("Temporal client closed")

