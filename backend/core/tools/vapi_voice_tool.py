from typing import Optional, Dict, Any, List
import json
import asyncio
import httpx
import phonenumbers
from phonenumbers import NumberParseException, geocoder
import structlog
from core.agentpress.tool import Tool, ToolResult, openapi_schema, tool_metadata
from core.utils.config import config
from core.agentpress.thread_manager import ThreadManager
from core.utils.logger import logger
from core.vapi_config import vapi_config, DEFAULT_SYSTEM_PROMPT, DEFAULT_FIRST_MESSAGE
from core.billing.config import TOKEN_PRICE_MULTIPLIER

def normalize_phone_number(raw_number: str, default_region: str = "US") -> tuple[str, str, str]:
    if not raw_number or not raw_number.strip():
        raise ValueError("Empty number provided")
    
    raw_number = raw_number.strip()
    
    common_country_codes = {
        '1': 'US',      # USA/Canada
        '44': 'GB',     # UK
        '91': 'IN',     # India
        '86': 'CN',     # China
        '81': 'JP',     # Japan
        '49': 'DE',     # Germany
        '33': 'FR',     # France
        '39': 'IT',     # Italy
        '34': 'ES',     # Spain
        '61': 'AU',     # Australia
        '55': 'BR',     # Brazil
        '52': 'MX',     # Mexico
        '971': 'AE',    # UAE
        '966': 'SA',    # Saudi Arabia
        '65': 'SG',     # Singapore
        '82': 'KR',     # South Korea
        '7': 'RU',      # Russia
        '27': 'ZA',     # South Africa
        '31': 'NL',     # Netherlands
        '46': 'SE',     # Sweden
    }
    
    if not raw_number.startswith('+'):
        for code, region in sorted(common_country_codes.items(), key=lambda x: len(x[0]), reverse=True):
            if raw_number.startswith(code):
                raw_number = '+' + raw_number
                default_region = region
                logger.info(f"Detected country code {code} ({region}), adding + prefix")
                break
    
    try:
        if raw_number.startswith('+'):
            parsed = phonenumbers.parse(raw_number, None)
        else:
            parsed = phonenumbers.parse(raw_number, default_region)
    except phonenumbers.NumberParseException as e:
        if not raw_number.startswith('+'):
            try:
                parsed = phonenumbers.parse(raw_number, default_region)
            except phonenumbers.NumberParseException:
                raise ValueError(f"Cannot parse number '{raw_number}'. Please include country code (e.g., +1 for US, +91 for India)")
        else:
            raise ValueError(f"Invalid phone number format: '{raw_number}'")

    if not phonenumbers.is_possible_number(parsed):
        raise ValueError(f"Number '{raw_number}' is not a possible valid number")
    if not phonenumbers.is_valid_number(parsed):
        raise ValueError(f"Number '{raw_number}' is not valid")

    region_code = geocoder.region_code_for_number(parsed)
    country_name = geocoder.description_for_number(parsed, "en") or region_code
    
    country_code = str(parsed.country_code)

    formatted = phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)
    
    logger.info(f"Normalized: {raw_number} -> {formatted} (Country: {country_name}, Code: +{country_code})")
    
    return formatted, country_code, country_name

@tool_metadata(
    display_name="Voice Calls",
    description="Make and manage voice phone calls with AI agents",
    icon="Phone",
    color="bg-indigo-100 dark:bg-indigo-800/50",
    weight=280,
    visible=True
)
class VapiVoiceTool(Tool):
    
    def __init__(self, thread_manager: ThreadManager):
        super().__init__()
        self.thread_manager = thread_manager
        self.api_key = config.VAPI_PRIVATE_KEY
        self.base_url = "https://api.vapi.ai"
        
        if not self.api_key:
            logger.warning("VAPI_PRIVATE_KEY not configured - Voice Calls tool will not be available")
        else:
            logger.info("Voice Calls tool initialized with Vapi AI")
    
    def _get_headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
    
    
    async def _get_current_thread_and_user(self) -> tuple[Optional[str], Optional[str], Optional[str]]:
        thread_id = None
        user_id = None
        agent_id = None
        
        try:
            context_vars = structlog.contextvars.get_contextvars()
            thread_id = context_vars.get('thread_id')
            agent_id = context_vars.get('agent_id')
            account_id = context_vars.get('account_id')

            if account_id:
                user_id = account_id
            
            if not thread_id and hasattr(self.thread_manager, 'thread_id'):
                thread_id = self.thread_manager.thread_id
                logger.info(f"[VapiVoiceTool] Using thread_id from thread_manager: {thread_id}")

            if not user_id and thread_id:
                try:
                    from core.services.supabase import DBConnection
                    db = DBConnection()
                    client = await db.client
                    thread = await client.from_('threads').select('account_id').eq('thread_id', thread_id).single().execute()
                    if thread.data:
                        user_id = thread.data.get('account_id')
                        logger.info(f"[VapiVoiceTool] Found account_id from database: {user_id}")
                except Exception as e:
                    logger.warning(f"[VapiVoiceTool] Failed to get account_id from thread: {e}")
            
        except Exception as e:
            logger.error(f"[VapiVoiceTool] Error getting context: {e}")
        
        logger.info(f"[VapiVoiceTool] Final context - thread_id: {thread_id}, user_id: {user_id}, agent_id: {agent_id}")
        
        return thread_id, user_id, agent_id
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "make_phone_call",
            "description": "Initiate an outbound phone call using AI voice agent. The agent will call the specified phone number and have a conversation based on the provided configuration. This tool returns immediately after initiating the call. ALWAYS Use wait_for_call_completion to monitor the call until it ends.",
            "parameters": {
                "type": "object",
                "properties": {
                    "phone_number": {
                        "type": "string",
                        "format": "string",
                        "description": "The phone number to call as a STRING. Can be in various formats: E.164 (+14155551234), national (415-555-1234), or international. Will be automatically converted to E.164 format. IMPORTANT: Must be sent as a string, not a number."
                    },
                    "first_message": {
                        "type": "string",
                        "format": "string",
                        "description": "The first message the AI assistant should say when the call is answered. This is the greeting or opening statement.",
                        "default": "Hello, this is an AI assistant calling."
                    },
                    "system_prompt": {
                        "type": "string",
                        "format": "string",
                        "description": "Optional system prompt to guide the AI assistant's behavior during the call. Defines personality, objectives, and conversation guidelines.",
                    },
                },
                "required": ["phone_number"]
            }
        }
    })
    async def make_phone_call(
        self,
        phone_number: str,
        first_message: str = "Hello, this is an AI assistant calling.",
        system_prompt: Optional[str] = None,
    ) -> ToolResult:
        
        if not isinstance(phone_number, str):
            phone_number = str(phone_number)
        
        if not self.api_key:
            return self.fail_response("VAPI_PRIVATE_KEY not configured. Please add your Vapi API key to the configuration.")
        
        try:
            normalized_phone, country_code, country_name = normalize_phone_number(phone_number)
            
            thread_id, user_id, agent_id = await self._get_current_thread_and_user()
            country_context = f"\n\nIMPORTANT: You are calling a phone number in {country_name} (country code +{country_code}). Please be aware of potential cultural differences, time zones, and language preferences."
            
            if system_prompt:
                enhanced_system_prompt = system_prompt + country_context
            else:
                enhanced_system_prompt = DEFAULT_SYSTEM_PROMPT + country_context
            
            assistant_config = vapi_config.get_assistant_config(
                system_prompt=enhanced_system_prompt,
                first_message=first_message or DEFAULT_FIRST_MESSAGE
            )
            
            payload = {
                "phoneNumberId": config.VAPI_PHONE_NUMBER_ID,
                "customer": {
                    "number": normalized_phone
                },
                "assistant": assistant_config
            }
            
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self.base_url}/call/phone",
                    headers=self._get_headers(),
                    json=payload,
                    timeout=30.0
                )
                
                response.raise_for_status()
                call_data = response.json()
            
            from core.services.supabase import DBConnection
            db = DBConnection()
            client = await db.client
            
            call_id = call_data.get("id")
            
            logger.info(f"[VapiVoiceTool] Creating call record - call_id: {call_id}, thread_id: {thread_id}, agent_id: {agent_id}")

            call_record = {
                "call_id": call_id,
                "agent_id": agent_id,
                "thread_id": thread_id,
                "phone_number": normalized_phone,
                "direction": "outbound",
                "status": call_data.get("status", "queued"),
                "transcript": [],
                "started_at": call_data.get("createdAt")
            }
            
            try:
                result = await client.table("vapi_calls").upsert(call_record, on_conflict="call_id").execute()
                if result.data:
                    logger.info(f"Successfully created/updated call record in database for {call_id}")
                    logger.info(f"Initial call record: {result.data[0] if result.data else 'No data returned'}")
                else:
                    logger.warning(f"Upsert returned no data for {call_id}")
            except Exception as e:
                logger.error(f"Failed to save call record to database: {str(e)}")
                try:
                    minimal_record = {
                        "call_id": call_id,
                        "status": "queued",
                        "phone_number": normalized_phone,
                        "thread_id": thread_id,
                        "agent_id": agent_id,
                        "transcript": []
                    }
                    fallback_result = await client.table("vapi_calls").upsert(minimal_record).execute()
                    logger.info(f"Created minimal call record via fallback for {call_id} with thread_id: {thread_id}")
                except Exception as e2:
                    logger.error(f"Even minimal record failed for {call_id}: {str(e2)}")
            
            if thread_id:
                try:
                    await self.thread_manager.add_message(
                        thread_id=thread_id,
                        type="assistant",
                        content=f"📞 **Initiating call to {normalized_phone}**\n🌍 **Country: {country_name}**\n\nCall ID: `{call_id[:8]}...`\n\nThe conversation will appear here in real-time as it happens.",
                        is_llm_message=False,
                        metadata={
                            "call_id": call_id,
                            "type": "call_initiated",
                            "phone_number": normalized_phone,
                            "country": country_name,
                            "country_code": f"+{country_code}",
                            "source": "vapi_voice_tool"
                        }
                    )
                    logger.info(f"[VapiVoiceTool] Added call initiation message to thread {thread_id}")
                except Exception as e:
                    logger.error(f"Failed to add call initiation message to thread: {e}")
            
            call_id = call_data.get("id")
            
            result = {
                "call_id": call_id,
                "status": call_data.get("status"),
                "phone_number": normalized_phone,
                "original_number": phone_number,
                "country": country_name,
                "country_code": f"+{country_code}",
                "message": f"Call initiated successfully to {normalized_phone} ({country_name}). Call ID: {call_id}",
                "next_action": "MONITOR_CALL",
                "instructions": f"The call has been initiated. Now use wait_for_call_completion with call_id: {call_id} to monitor the call until it ends and see the real-time conversation."
            }
            
            return self.success_response(result)
        
        except ValueError as e:
            return self.fail_response(str(e))
        except httpx.HTTPStatusError as e:
            error_detail = e.response.text
            logger.error(f"Vapi API error: {error_detail}")
            return self.fail_response(f"Failed to make call: {error_detail}")
        except Exception as e:
            logger.error(f"Error making call: {str(e)}")
            return self.fail_response(f"Error making call: {str(e)}")
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "end_call",
            "description": "End an active phone call. Use this to programmatically terminate an ongoing call before it completes naturally.",
            "parameters": {
                "type": "object",
                "properties": {
                    "call_id": {
                        "type": "string",
                        "description": "The unique identifier of the call to end. This is returned when initiating a call."
                    }
                },
                "required": ["call_id"]
            }
        }
    })
    async def end_call(self, call_id: str) -> ToolResult:
        
        if not self.api_key:
            return self.fail_response("VAPI_PRIVATE_KEY not configured")
        
        try:
            async with httpx.AsyncClient() as client:
                response = await client.patch(
                    f"{self.base_url}/call/{call_id}",
                    headers=self._get_headers(),
                    json={"status": "ended"},
                    timeout=30.0
                )
                
                response.raise_for_status()
            
            from core.services.supabase import DBConnection
            db = DBConnection()
            client = await db.client
            
            await client.table("vapi_calls").update({
                "status": "ended",
                "ended_at": "now()"
            }).eq("call_id", call_id).execute()
            
            return self.success_response({
                "call_id": call_id,
                "status": "ended",
                "message": f"Call {call_id} has been ended successfully"
            })
            
        except httpx.HTTPStatusError as e:
            error_detail = e.response.text
            logger.error(f"Vapi API error ending call: {error_detail}")
            return self.fail_response(f"Failed to end call: {error_detail}")
        except Exception as e:
            logger.error(f"Error ending call: {str(e)}")
            return self.fail_response(f"Error ending call: {str(e)}")
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "get_call_details",
            "description": "Get the current status and details of a phone call, including transcript if available. Use this to check if a call has completed and retrieve the conversation transcript.",
            "parameters": {
                "type": "object",
                "properties": {
                    "call_id": {
                        "type": "string",
                        "description": "The unique identifier of the call to check"
                    }
                },
                "required": ["call_id"]
            }
        }
    })
    async def get_call_details(self, call_id: str) -> ToolResult:
        
        if not self.api_key:
            return self.fail_response("VAPI_PRIVATE_KEY not configured")
        
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self.base_url}/call/{call_id}",
                    headers=self._get_headers(),
                    timeout=30.0
                )
                
                response.raise_for_status()
                call_data = response.json()
            
            result = {
                "call_id": call_data.get("id"),
                "status": call_data.get("status"),
                "phone_number": call_data.get("customer", {}).get("number"),
                "duration": call_data.get("duration"),
                "started_at": call_data.get("startedAt"),
                "ended_at": call_data.get("endedAt"),
                "transcript": call_data.get("transcript", []),
                "cost": call_data.get("cost")
            }
            
            return self.success_response(result)
            
        except httpx.HTTPStatusError as e:
            error_detail = e.response.text
            logger.error(f"Vapi API error getting call status: {error_detail}")
            return self.fail_response(f"Failed to get call status: {error_detail}")
        except Exception as e:
            logger.error(f"Error getting call status: {str(e)}")
            return self.fail_response(f"Error getting call status: {str(e)}")
    
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "wait_for_call_completion",
            "description": "Monitor an active call until it completes, streaming the real-time conversation to the thread. This tool will continuously check the call status and display live transcription. Use this immediately after make_call to monitor the conversation. ALWAYS Use get_call_details after calling this tool to get the full transcript and details of the call.",
            "parameters": {
                "type": "object",
                "properties": {
                    "call_id": {
                        "type": "string",
                        "description": "The unique identifier of the call to monitor"
                    },
                    "check_interval": {
                        "type": "integer",
                        "description": "Seconds between status checks. Default is 2 seconds for real-time updates.",
                        "default": 2,
                        "minimum": 1,
                        "maximum": 10
                    }
                },
                "required": ["call_id"]
            }
        }
    })
    async def wait_for_call_completion(self, call_id: str, check_interval: int = 2) -> ToolResult:
        
        if not self.api_key:
            return self.fail_response("VAPI_PRIVATE_KEY not configured")
        
        try:
            from core.services.supabase import DBConnection
            db = DBConnection()
            client = await db.client
            
            thread_id, user_id, agent_id = await self._get_current_thread_and_user()
            
            logger.info(f"[wait_for_call_completion] Starting to monitor call {call_id}")
            if thread_id:
                await self.thread_manager.add_message(
                    thread_id=thread_id,
                    type="assistant",
                    content=f"📞 **Monitoring Call**\n\nI'm now monitoring the active call. The conversation will appear here in real-time.\n\n---\n\n*Live Transcript:*",
                    is_llm_message=False,
                    metadata={
                        "call_id": call_id,
                        "type": "call_monitoring_started",
                        "source": "wait_for_call_completion"
                    }
                )
            
            max_wait_time = 3600
            total_wait = 0
            last_transcript_count = 0
            
            while total_wait < max_wait_time:
                result = await client.table("vapi_calls").select("*").eq("call_id", call_id).single().execute()
                
                if result.data:
                    status = result.data.get("status", "unknown")
                    transcript = result.data.get("transcript", [])
                    
                    if isinstance(transcript, str):
                        try:
                            transcript = json.loads(transcript)
                        except:
                            transcript = []
                    
                    transcript_count = len(transcript) if isinstance(transcript, list) else 0
                    
                    if transcript_count > last_transcript_count and thread_id:
                        new_messages = transcript[last_transcript_count:] if isinstance(transcript, list) else []
                        for msg in new_messages:
                            if isinstance(msg, dict) and msg.get("role") and msg.get("content"):
                                try:
                                    speaker = "🤖 AI" if msg["role"] == "assistant" else "👤 Caller"
                                    await self.thread_manager.add_message(
                                        thread_id=thread_id,
                                        type="assistant",
                                        content=f"{speaker}: {msg['content']}",
                                        is_llm_message=False,
                                        metadata={
                                            "call_id": call_id,
                                            "type": "call_transcript_update",
                                            "source": "wait_for_call_completion"
                                        }
                                    )
                                except Exception as e:
                                    logger.warning(f"Failed to add transcript message to thread: {e}")
                        last_transcript_count = transcript_count
                    
                    if status in ["ended", "completed", "failed", "error"]:
                        logger.info(f"[wait_for_call_completion] Call {call_id} has ended with status: {status}")
                        
                        if thread_id:
                            try:
                                duration = result.data.get("duration_seconds", 0)
                                cost = result.data.get("cost", 0)
                                credits_deducted = float(cost) * float(TOKEN_PRICE_MULTIPLIER) if cost else 0
                                
                                summary_msg = f"""📞 **Call Completed**

**Status**: {status}
**Duration**: {duration} seconds
**Credits Used**: ${credits_deducted:.4f}
**Call ID**: `{call_id[:8]}...`

The voice call has ended. You can continue with any follow-up actions."""
                                
                                await self.thread_manager.add_message(
                                    thread_id=thread_id,
                                    type="assistant",
                                    content=summary_msg,
                                    is_llm_message=False,
                                    metadata={
                                        "call_id": call_id,
                                        "type": "call_completed",
                                        "source": "wait_for_call_completion"
                                    }
                                )
                            except Exception as e:
                                logger.error(f"Failed to add completion message: {e}")
                        
                        return self.success_response({
                            "call_id": call_id,
                            "final_status": status,
                            "duration_seconds": result.data.get("duration_seconds"),
                            "transcript_messages": transcript_count,
                            "cost": result.data.get("cost"),
                            "message": f"Call completed with status: {status}. Duration: {result.data.get('duration_seconds', 0)} seconds."
                        })
                    
                    logger.debug(f"[wait_for_call_completion] Call {call_id} still active with status: {status}, checking again in {check_interval}s")
                
                await asyncio.sleep(check_interval)
                total_wait += check_interval
            
            return self.fail_response(f"Call monitoring timed out after {max_wait_time} seconds. Call may still be active.")
            
        except Exception as e:
            logger.error(f"Error monitoring call {call_id}: {str(e)}")
            return self.fail_response(f"Error monitoring call: {str(e)}")
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "list_calls",
            "description": "List recent phone calls with their status and basic details. Use this to see call history and find specific call IDs.",
            "parameters": {
                "type": "object",
                "properties": {
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of calls to return. Default is 10, maximum is 100.",
                        "default": 10,
                        "minimum": 1,
                        "maximum": 100
                    }
                }
            }
        }
    })
    async def list_calls(self, limit: int = 10) -> ToolResult:
        
        if not self.api_key:
            return self.fail_response("VAPI_PRIVATE_KEY not configured")
        
        try:
            thread_id, user_id, agent_id = await self._get_current_thread_and_user()
            
            from core.services.supabase import DBConnection
            db = DBConnection()
            client = await db.client
            
            query = client.table("vapi_calls").select("*").order("created_at", desc=True).limit(limit)
            
            if thread_id:
                query = query.eq("thread_id", thread_id)
            
            result = await query.execute()
            
            calls = []
            for call in result.data:
                calls.append({
                    "call_id": call.get("call_id"),
                    "phone_number": call.get("phone_number"),
                    "direction": call.get("direction"),
                    "status": call.get("status"),
                    "duration_seconds": call.get("duration_seconds"),
                    "started_at": call.get("started_at"),
                    "ended_at": call.get("ended_at")
                })
            
            return self.success_response({
                "calls": calls,
                "count": len(calls),
                "message": f"Retrieved {len(calls)} call(s)"
            })
            
        except Exception as e:
            logger.error(f"Error listing calls: {str(e)}")
            return self.fail_response(f"Error listing calls: {str(e)}")

