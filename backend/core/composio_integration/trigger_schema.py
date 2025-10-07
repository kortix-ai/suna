import os
import httpx
from typing import Dict, Any, Optional
from fastapi import HTTPException
from core.utils.logger import logger

class TriggerSchemaService:
    def __init__(self):
        self.api_base = os.getenv("COMPOSIO_API_BASE", "https://backend.composio.dev").rstrip("/")
        self.api_key = os.getenv("COMPOSIO_API_KEY")
    
    async def get_trigger_schema(self, trigger_slug: str) -> Dict[str, Any]:
        if not self.api_key:
            raise HTTPException(status_code=500, detail="COMPOSIO_API_KEY not configured")
        
        try:
            headers = {"x-api-key": self.api_key}
            url = f"{self.api_base}/api/v3/triggers_types/{trigger_slug}"
            
            async with httpx.AsyncClient(timeout=10) as http_client:
                response = await http_client.get(url, headers=headers)
                
                if response.status_code == 404:
                    raise HTTPException(status_code=404, detail=f"Trigger {trigger_slug} not found")
                elif response.status_code != 200:
                    raise HTTPException(status_code=response.status_code, 
                                      detail=f"Failed to fetch trigger schema: {response.text}")
                
                data = response.json()
                
                return {
                    "slug": trigger_slug,
                    "name": data.get("name", trigger_slug),
                    "description": data.get("description"),
                    "config": data.get("config", {}),
                    "app": data.get("app"),
                }
                
        except httpx.TimeoutException:
            logger.error(f"Timeout fetching trigger schema for {trigger_slug}")
            raise HTTPException(status_code=504, detail="Timeout fetching trigger schema")
        except httpx.HTTPError as e:
            logger.error(f"HTTP error fetching trigger schema: {e}")
            raise HTTPException(status_code=500, detail="Failed to fetch trigger schema")
        except Exception as e:
            logger.error(f"Unexpected error fetching trigger schema: {e}")
            raise HTTPException(status_code=500, detail="Internal server error")
