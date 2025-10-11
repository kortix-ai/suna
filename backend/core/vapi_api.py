from fastapi import APIRouter, Request, HTTPException, Depends
from core.vapi_webhooks import VapiWebhookHandler
from core.utils.logger import logger
from core.utils.config import config
from typing import Dict, Any

router = APIRouter(tags=["vapi"])

webhook_handler = VapiWebhookHandler()

@router.post("/webhooks/vapi", summary="Vapi Webhook Handler", operation_id="vapi_webhook")
async def handle_vapi_webhook(request: Request):
    try:
        payload = await request.json()
        
        event_type = (
            payload.get("message", {}).get("type") if "message" in payload
            else payload.get("type") or payload.get("event")
        )
        
        if not event_type:
            return {"status": "ok", "message": "Webhook received but event type not recognized"}
        
        return await webhook_handler.handle_webhook(event_type, payload)
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error processing Vapi webhook: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")

@router.get("/vapi/calls/{call_id}", summary="Get Call Details", operation_id="get_vapi_call")
async def get_call_details(call_id: str):
    try:
        from core.services.supabase import DBConnection
        db = DBConnection()
        client = await db.client
        
        result = await client.table("vapi_calls").select("*").eq("call_id", call_id).single().execute()
        
        if not result.data:
            raise HTTPException(status_code=404, detail="Call not found")
        
        return result.data
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error retrieving call details: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")

@router.get("/vapi/calls", summary="List Calls", operation_id="list_vapi_calls")
async def list_calls(limit: int = 10, thread_id: str = None):
    try:
        from core.services.supabase import DBConnection
        db = DBConnection()
        client = await db.client
        
        query = client.table("vapi_calls").select("*").order("created_at", desc=True).limit(limit)
        
        if thread_id:
            query = query.eq("thread_id", thread_id)
        
        result = await query.execute()
        
        return {
            "calls": result.data,
            "count": len(result.data)
        }
    
    except Exception as e:
        logger.error(f"Error listing calls: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")

