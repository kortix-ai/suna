from typing import Dict, Any, Optional, List
from fastapi import Request, HTTPException
from core.utils.logger import logger
from core.services.supabase import DBConnection
from core.billing.config import TOKEN_PRICE_MULTIPLIER
from core.vapi_config import vapi_config
from decimal import Decimal
import json
import hmac
import hashlib

class VapiWebhookHandler:

    def __init__(self):
        self.db = DBConnection()
    
    async def verify_signature(self, request: Request, secret: Optional[str] = None) -> bool:
        if not secret:
            return True
        
        try:
            signature = request.headers.get("x-vapi-signature")
            if not signature:
                return False
            
            body = await request.body()
            expected_signature = hmac.new(
                secret.encode(),
                body,
                hashlib.sha256
            ).hexdigest()
            return hmac.compare_digest(signature, expected_signature)
        except Exception as e:
            logger.error(f"Error verifying webhook signature: {e}")
            return False
    
    def _extract_call_id(self, payload: Dict[str, Any]) -> Optional[str]:
        call = payload.get("call", {})
        if call and call.get("id"):
            return call.get("id")
        
        message = payload.get("message", {})
        if message:
            message_call = message.get("call", {})
            if isinstance(message_call, dict) and message_call.get("id"):
                return message_call.get("id")
            
            artifact = message.get("artifact", {})
            artifact_call = artifact.get("call", {})
            if isinstance(artifact_call, dict) and artifact_call.get("id"):
                return artifact_call.get("id")
        
        return payload.get("callId") or payload.get("call_id")
    
    def _extract_call_data(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        call = payload.get("call", {})
        if call:
            return call
        
        message = payload.get("message", {})
        if message:
            message_call = message.get("call", {})
            if isinstance(message_call, dict):
                return message_call
            
            artifact = message.get("artifact", {})
            artifact_call = artifact.get("call", {})
            if isinstance(artifact_call, dict):
                return artifact_call
        
        return {}
    
    async def handle_webhook(self, event_type: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        try:
            handlers = {
                "conversation-update": self._handle_conversation_update,
                "status-update": self._handle_status_update,
                "end-of-call-report": self._handle_end_of_call_report,
                "call.started": self._handle_call_started,
                "call.ended": self._handle_call_ended,
                "transcript.updated": self._handle_transcript_updated,
                "assistant-request": self._handle_assistant_request,
                "speech-update": lambda p: {"status": "ok"}
            }
            
            handler = handlers.get(event_type)
            if handler:
                if event_type == "speech-update":
                    return handler(payload)
                return await handler(payload)
            else:
                return {"status": "unhandled"}
        
        except Exception as e:
            logger.error(f"Error handling webhook event {event_type}: {e}")
            raise HTTPException(status_code=500, detail=str(e))
    
    async def _handle_conversation_update(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        from core.agentpress.thread_manager import ThreadManager
        
        call_id = self._extract_call_id(payload)
        call = self._extract_call_data(payload)
        
        if not call_id:
            return {"status": "error", "message": "Missing call ID"}
        
        client = await self.db.client
        
        message_data = payload.get("message", {})
        artifact = message_data.get("artifact", {})
        messages = artifact.get("messages", [])
        conversation = message_data.get("conversation", [])
        
        transcript_data = self._process_messages(messages) or self._process_conversation(conversation)
        
        status = "in-progress" if transcript_data else call.get("status", "in-progress")
        
        update_data = {
            "transcript": transcript_data,
            "status": status,
            "updated_at": "now()"
        }
        
        try:
            result = await client.table("vapi_calls")\
                .select("*")\
                .eq("call_id", call_id)\
                .execute()
            
            if result.data:
                await client.table("vapi_calls")\
                    .update(update_data)\
                    .eq("call_id", call_id)\
                    .execute()
            else:
                new_call = {
                    "call_id": call_id,
                    "phone_number": call.get("customer", {}).get("number"),
                    "direction": "outbound" if call.get("type") == "outboundPhoneCall" else "inbound",
                    "status": status,
                    "transcript": transcript_data,
                    "started_at": call.get("createdAt")
                }
                await client.table("vapi_calls").insert(new_call).execute()
        
        except Exception as e:
            logger.error(f"Database operation failed for call {call_id}: {e}")
            return {"status": "error", "message": str(e)}
        
        if transcript_data:
            await self._stream_transcript_to_thread(call_id, transcript_data)
        
        return {"status": "success"}
    
    def _process_messages(self, messages: List[Dict]) -> List[Dict]:
        transcript = []
        for msg in messages:
            role = msg.get("role", "")
            if role in ["bot", "assistant", "user"] and msg.get("message"):
                transcript.append({
                    "role": "assistant" if role in ["bot", "assistant"] else "user",
                    "message": msg.get("message", ""),
                    "timestamp": msg.get("time")
                })
        return transcript
    
    def _process_conversation(self, conversation: List[Dict]) -> List[Dict]:
        transcript = []
        for msg in conversation:
            role = msg.get("role", "")
            if role in ["assistant", "bot", "user"] and msg.get("content"):
                transcript.append({
                    "role": "assistant" if role in ["assistant", "bot"] else "user",
                    "message": msg.get("content", ""),
                    "timestamp": None
                })
        return transcript
    
    async def _handle_status_update(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        call_id = self._extract_call_id(payload)
        call = self._extract_call_data(payload)
        
        if not call_id:
            return {"status": "error", "message": "Missing call ID"}
        
        message_data = payload.get("message", {})
        status = message_data.get("status") or call.get("status") or payload.get("status") or ""
        
        client = await self.db.client
        
        update_data = {"status": status}
        
        if status in ["completed", "ended", "failed", "no-answer", "busy", "cancelled"]:
            update_data["ended_at"] = message_data.get("timestamp") or call.get("endedAt") or "now()"
        
        await client.table("vapi_calls").update(update_data).eq("call_id", call_id).execute()
        
        return {"status": "success"}
    
    async def _handle_end_of_call_report(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        call_id = self._extract_call_id(payload)
        call = self._extract_call_data(payload)
        
        if not call_id:
            return {"status": "error", "message": "Missing call ID"}
        
        client = await self.db.client
        message_data = payload.get("message", {})
        
        artifact = message_data.get("artifact", {})
        messages = artifact.get("messages", []) or message_data.get("messages", [])
        
        transcript_data = self._process_messages(messages)
        
        if not transcript_data and message_data.get("transcript"):
            transcript_data = self._parse_transcript_text(message_data.get("transcript", ""))
        
        duration = message_data.get("durationSeconds", 0)
        cost = message_data.get("cost", 0)
        
        thread_id = await self._get_thread_id_for_call(call_id)
        user_id = None
        credit_deducted = False
        actual_cost_deducted = 0
        
        if thread_id:
            user_id = await self._get_user_id_from_thread(thread_id)
            
            if user_id and cost > 0:
                try:
                    from core.billing.credit_manager import CreditManager
                    credit_manager = CreditManager()
                    
                    cost_in_credits = Decimal(str(cost)) * TOKEN_PRICE_MULTIPLIER
                    
                    deduct_result = await credit_manager.use_credits(
                        account_id=user_id,
                        amount=cost_in_credits,
                        description=f"Vapi voice call ({duration}s)",
                        thread_id=thread_id
                    )
                    
                    if deduct_result.get('success'):
                        credit_deducted = True
                        actual_cost_deducted = float(cost_in_credits)
                        logger.info(f"Successfully deducted {cost_in_credits} credits for call {call_id}")
                    else:
                        logger.warning(f"Failed to deduct credits for call {call_id}: {deduct_result.get('error', 'Unknown error')}")
                except Exception as e:
                    logger.error(f"Error deducting credits for call {call_id}: {e}")
        
        update_data = {
            "status": "completed",
            "duration_seconds": int(duration) if duration else None,
            "transcript": transcript_data,
            "started_at": message_data.get("startedAt"),
            "ended_at": message_data.get("endedAt"),
            "cost": actual_cost_deducted if credit_deducted else cost,
            "updated_at": "now()"
        }
        
        try:
            result = await client.table("vapi_calls").update(update_data).eq("call_id", call_id).execute()
            
            if not result.data:
                new_call = {
                    "call_id": call_id,
                    "phone_number": call.get("customer", {}).get("number"),
                    "direction": "outbound" if call.get("type") == "outboundPhoneCall" else "inbound",
                    **update_data
                }
                await client.table("vapi_calls").insert(new_call).execute()
        except Exception as e:
            logger.error(f"Failed to update call {call_id}: {e}")
        
        await self._notify_call_completion(call_id, duration, actual_cost_deducted if credit_deducted else cost)
        
        return {"status": "success"}
    
    def _parse_transcript_text(self, transcript_text: str) -> List[Dict]:
        transcript_data = []
        for line in transcript_text.split('\n'):
            if line.startswith("AI:"):
                transcript_data.append({
                    "role": "assistant",
                    "message": line.replace("AI:", "").strip()
                })
            elif line.startswith("User:"):
                transcript_data.append({
                    "role": "user",
                    "message": line.replace("User:", "").strip()
                })
        return transcript_data
    
    async def _notify_call_completion(self, call_id: str, duration: int, cost: float) -> None:
        thread_id = await self._get_thread_id_for_call(call_id)
        if not thread_id:
            return
        
        from core.agentpress.thread_manager import ThreadManager
        thread_manager = ThreadManager()
        
        duration_text = f"{duration}s" if duration else "unknown"
        cost_text = f"${cost:.4f}" if cost and cost > 0 else "$0.00"
        
        await thread_manager.add_message(
            thread_id=thread_id,
            type="assistant",
            content=f"📞 **Call Completed** - Duration: {duration_text}, Credits Used: {cost_text}",
            is_llm_message=False,
            metadata={
                "call_id": call_id,
                "type": "call_completed",
                "duration": duration,
                "cost": cost,
                "credits_deducted": cost,
                "source": "vapi_webhook"
            }
        )
    
    async def _handle_call_started(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        call_id = self._extract_call_id(payload)
        call = self._extract_call_data(payload)
        
        if not call_id:
            return {"status": "error", "message": "Missing call ID"}
        
        client = await self.db.client
        
        update_data = {
            "status": "in-progress",
            "started_at": call.get("startedAt") or call.get("createdAt")
        }
        
        result = await client.table("vapi_calls").update(update_data).eq("call_id", call_id).execute()
        
        if not result.data:
            new_call = {
                "call_id": call_id,
                "phone_number": call.get("customer", {}).get("number"),
                "direction": "inbound" if call.get("type") == "inboundPhoneCall" else "outbound",
                "status": "in-progress",
                "started_at": call.get("startedAt"),
                "transcript": []
            }
            await client.table("vapi_calls").insert(new_call).execute()
        
        await self._notify_call_started(call_id, call.get("customer", {}).get("number", "Unknown"))
        
        return {"status": "success"}
    
    async def _notify_call_started(self, call_id: str, phone_number: str) -> None:
        thread_id = await self._get_thread_id_for_call(call_id)
        if not thread_id:
            return
        
        from core.agentpress.thread_manager import ThreadManager
        thread_manager = ThreadManager()
        
        await thread_manager.add_message(
            thread_id=thread_id,
            type="assistant",
            content=f"📞 **Call Started** - Connecting to {phone_number}...",
            is_llm_message=False,
            metadata={
                "call_id": call_id,
                "type": "call_started",
                "phone_number": phone_number,
                "source": "vapi_webhook"
            }
        )
    
    async def _handle_call_ended(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        call_id = self._extract_call_id(payload)
        call = self._extract_call_data(payload)
        
        if not call_id:
            return {"status": "error", "message": "Missing call ID"}
        
        client = await self.db.client
        
        transcript_data = call.get("transcript", [])
        duration = call.get("duration") or call.get("durationSeconds")
        cost = call.get("cost", 0)
        
        thread_id = await self._get_thread_id_for_call(call_id)
        user_id = None
        credit_deducted = False
        actual_cost_deducted = 0
        
        if thread_id:
            user_id = await self._get_user_id_from_thread(thread_id)
            
            if user_id and cost > 0:
                try:
                    from core.billing.credit_manager import CreditManager
                    credit_manager = CreditManager()
                    
                    cost_in_credits = Decimal(str(cost)) * TOKEN_PRICE_MULTIPLIER
                    
                    deduct_result = await credit_manager.use_credits(
                        account_id=user_id,
                        amount=cost_in_credits,
                        description=f"Vapi voice call ({duration}s)",
                        thread_id=thread_id
                    )
                    
                    if deduct_result.get('success'):
                        credit_deducted = True
                        actual_cost_deducted = float(cost_in_credits)
                        logger.info(f"Successfully deducted {cost_in_credits} credits for call {call_id}")
                    else:
                        logger.warning(f"Failed to deduct credits for call {call_id}: {deduct_result.get('error', 'Unknown error')}")
                except Exception as e:
                    logger.error(f"Error deducting credits for call {call_id}: {e}")
        
        update_data = {
            "status": "ended",
            "ended_at": call.get("endedAt") or call.get("endTime") or "now()",
            "duration_seconds": int(duration) if duration else None,
            "transcript": transcript_data if transcript_data else None,
            "cost": actual_cost_deducted if credit_deducted else cost
        }
        
        await client.table("vapi_calls").update(update_data).eq("call_id", call_id).execute()
        
        if thread_id and transcript_data:
            await self._save_transcript_to_thread(thread_id, call_id, transcript_data)
        
        return {"status": "success"}
    
    async def _handle_transcript_updated(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        call_id = self._extract_call_id(payload)
        transcript = payload.get("transcript", [])
        
        if not call_id:
            return {"status": "error", "message": "Missing call ID"}
        
        client = await self.db.client
        await client.table("vapi_calls").update({
            "transcript": json.dumps(transcript)
        }).eq("call_id", call_id).execute()
        
        return {"status": "success"}
    
    
    async def _handle_assistant_request(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "assistant": vapi_config.get_assistant_config()
        }
    
    async def _get_thread_id_for_call(self, call_id: str) -> Optional[str]:
        try:
            client = await self.db.client
            result = await client.table("vapi_calls").select("thread_id").eq("call_id", call_id).single().execute()
            return result.data.get("thread_id") if result.data else None
        except Exception as e:
            logger.error(f"Error getting thread_id for call {call_id}: {e}")
            return None
    
    async def _get_user_id_from_thread(self, thread_id: str) -> Optional[str]:
        try:
            client = await self.db.client
            result = await client.table("threads").select("account_id").eq("thread_id", thread_id).single().execute()
            return result.data.get("account_id") if result.data else None
        except Exception as e:
            logger.error(f"Error getting user_id for thread {thread_id}: {e}")
            return None
    
    async def _stream_transcript_to_thread(self, call_id: str, transcript_data: List[Dict[str, Any]]) -> None:
        try:
            thread_id = await self._get_thread_id_for_call(call_id)
            if not thread_id:
                return
            
            client = await self.db.client
            existing_result = await client.table("messages").select("metadata").eq("thread_id", thread_id).execute()
            
            existing_indices = set()
            if existing_result.data:
                for msg in existing_result.data:
                    metadata = msg.get("metadata", {})
                    if (metadata.get("call_id") == call_id and 
                        metadata.get("message_index") is not None):
                        existing_indices.add(metadata["message_index"])
            
            from core.agentpress.thread_manager import ThreadManager
            thread_manager = ThreadManager()
            
            for idx, msg in enumerate(transcript_data):
                if idx not in existing_indices:
                    role = msg.get("role", "")
                    message_text = msg.get("message", "")
                    
                    if not message_text.strip() or role == "system":
                        continue
                    
                    formatted_content = (
                        f"🤖 **AI Assistant**: {message_text}"
                        if role == "assistant"
                        else f"👤 **Caller**: {message_text}"
                    )
                    
                    await thread_manager.add_message(
                        thread_id=thread_id,
                        type="assistant",
                        content=formatted_content,
                        is_llm_message=False,
                        metadata={
                            "call_id": call_id,
                            "message_index": idx,
                            "role": role,
                            "timestamp": msg.get("timestamp"),
                            "is_realtime_transcript": True,
                            "source": "vapi_webhook"
                        }
                    )
        except Exception as e:
            logger.error(f"Failed to stream transcript to thread: {e}")
    
    async def _save_transcript_to_thread(self, thread_id: str, call_id: str, transcript: list) -> None:
        try:
            client = await self.db.client
            
            conversation_text = "\n".join([
                f"{msg.get('role', 'unknown')}: {msg.get('message', '')}"
                for msg in transcript
            ])
            
            message_data = {
                "thread_id": thread_id,
                "role": "assistant",
                "content": f"Call completed (ID: {call_id})\n\nTranscript:\n{conversation_text}",
                "metadata": {
                    "type": "voice_call_transcript",
                    "call_id": call_id
                }
            }
            
            await client.table("messages").insert(message_data).execute()
        except Exception as e:
            logger.error(f"Error saving transcript to thread: {e}")

