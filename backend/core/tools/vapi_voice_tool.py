from typing import Optional, Dict, Any, List
import json
import asyncio
import httpx
import phonenumbers
from phonenumbers import NumberParseException, geocoder
import structlog
import re
from core.agentpress.tool import Tool, ToolResult, openapi_schema, tool_metadata
from core.utils.config import config
from core.agentpress.thread_manager import ThreadManager
from core.utils.logger import logger
from core.vapi_config import vapi_config, DEFAULT_SYSTEM_PROMPT, DEFAULT_FIRST_MESSAGE
from core.billing.shared.config import TOKEN_PRICE_MULTIPLIER

def normalize_phone_number(raw_number: str, default_region: str = "US") -> tuple[str, str, str]:
    import re
    
    if not raw_number or not isinstance(raw_number, str) or not raw_number.strip():
        raise ValueError("Empty or invalid phone number provided")
    
    original_input = raw_number
    raw_number = raw_number.strip()
    
    cleaned = re.sub(r'[^\d+]', '', raw_number)
    
    if not cleaned or (cleaned == '+' and len(cleaned) == 1):
        raise ValueError(f"Phone number '{original_input}' contains no valid digits")
    
    if cleaned.count('+') > 1:
        raise ValueError(f"Phone number '{original_input}' contains multiple '+' symbols")
    
    if '+' in cleaned and not cleaned.startswith('+'):
        raise ValueError(f"Phone number '{original_input}' has '+' in wrong position (must be at start)")
    
    max_length = 17
    if len(cleaned) > max_length:
        raise ValueError(f"Phone number '{original_input}' is too long ({len(cleaned)} digits, max {max_length})")
    
    min_length = 4
    digits_only = cleaned.replace('+', '')
    if len(digits_only) < min_length:
        raise ValueError(f"Phone number '{original_input}' is too short (minimum {min_length} digits required)")
    
    parsing_strategies = []
    
    if cleaned.startswith('+'):
        parsing_strategies.append(("With explicit + prefix", cleaned, None))
    else:
        all_regions = list(phonenumbers.SUPPORTED_REGIONS)
        priority_regions = [
            'US', 'GB', 'IN', 'CN', 'JP', 'DE', 'FR', 'IT', 'ES', 'AU',
            'CA', 'BR', 'MX', 'RU', 'KR', 'ID', 'TR', 'SA', 'AE', 'SG',
            'MY', 'TH', 'PH', 'VN', 'PK', 'BD', 'EG', 'NG', 'ZA', 'AR',
            'CO', 'CL', 'PE', 'VE', 'PL', 'UA', 'RO', 'NL', 'BE', 'GR',
            'PT', 'CZ', 'HU', 'SE', 'AT', 'CH', 'DK', 'FI', 'NO', 'IE',
            'NZ', 'IL', 'HK', 'TW', 'KZ', 'DZ', 'MA', 'KE', 'ET', 'GH'
        ]
        
        sorted_regions = []
        if default_region and default_region in all_regions:
            sorted_regions.append(default_region)
        
        for region in priority_regions:
            if region not in sorted_regions and region in all_regions:
                sorted_regions.append(region)
        
        for region in all_regions:
            if region not in sorted_regions:
                sorted_regions.append(region)
        
        parsing_strategies.append((f"With {default_region} as region", cleaned, default_region))
        
        if cleaned.startswith('00'):
            cleaned_alt = '+' + cleaned[2:]
            parsing_strategies.append(("Converting 00 prefix to +", cleaned_alt, None))
        
        for length in range(1, 5):
            if len(digits_only) > length:
                test_with_plus = '+' + digits_only
                parsing_strategies.append((f"Testing with + prefix added", test_with_plus, None))
                break
        
        for region in sorted_regions[:50]:
            parsing_strategies.append((f"Trying region {region}", cleaned, region))
    
    parsed_number = None
    successful_strategy = None
    parsing_errors = []
    
    for strategy_name, number_to_parse, region in parsing_strategies:
        try:
            if region:
                parsed = phonenumbers.parse(number_to_parse, region)
            else:
                parsed = phonenumbers.parse(number_to_parse, None)
            
            if phonenumbers.is_possible_number(parsed) and phonenumbers.is_valid_number(parsed):
                parsed_number = parsed
                successful_strategy = strategy_name
                logger.info(f"Successfully parsed using strategy: {strategy_name}")
                break
            elif phonenumbers.is_possible_number(parsed):
                if parsed_number is None:
                    parsed_number = parsed
                    successful_strategy = f"{strategy_name} (possible but not fully validated)"
                    
        except phonenumbers.NumberParseException as e:
            parsing_errors.append(f"{strategy_name}: {str(e)}")
            continue
        except Exception as e:
            parsing_errors.append(f"{strategy_name}: Unexpected error - {str(e)}")
            continue
    
    if parsed_number is None:
        error_context = f"Phone number '{original_input}' could not be parsed.\n"
        error_context += f"Cleaned format tried: '{cleaned}'\n"
        error_context += "\nSuggestions:\n"
        error_context += "1. Include country code with + prefix (e.g., +1 for US/Canada, +44 for UK, +91 for India)\n"
        error_context += "2. Use E.164 format: +[country code][number] (e.g., +14155552671)\n"
        error_context += "3. Check for typos or invalid digits\n"
        if len(parsing_errors) <= 5:
            error_context += f"\nParsing attempts:\n" + "\n".join(f"  - {err}" for err in parsing_errors[:5])
        raise ValueError(error_context)
    
    if not phonenumbers.is_valid_number(parsed_number):
        logger.warning(f"Number '{original_input}' parsed but may not be fully valid (using: {successful_strategy})")
    
    try:
        region_code = geocoder.region_code_for_number(parsed_number)
        if not region_code:
            region_code = phonenumbers.region_code_for_number(parsed_number)
        
        country_name = geocoder.description_for_number(parsed_number, "en")
        if not country_name and region_code:
            country_name = region_code
        elif not country_name:
            country_name = "Unknown"
            
        country_code = str(parsed_number.country_code)
        
        formatted = phonenumbers.format_number(parsed_number, phonenumbers.PhoneNumberFormat.E164)
        
        validation_status = "valid" if phonenumbers.is_valid_number(parsed_number) else "possible"
        logger.info(
            f"Normalized ({validation_status}): {original_input} -> {formatted} "
            f"(Country: {country_name}, Code: +{country_code}, Strategy: {successful_strategy})"
        )
        
        return formatted, country_code, country_name
        
    except Exception as e:
        logger.error(f"Error extracting phone number details: {e}")
        formatted = phonenumbers.format_number(parsed_number, phonenumbers.PhoneNumberFormat.E164)
        country_code = str(parsed_number.country_code)
        return formatted, country_code, "Unknown"

EMERGENCY_NUMBERS = {
    '911', '999', '112', '000', '110', '108', '119', '113', '100', '101', '102',
    '15', '17', '18', '191', '192', '193', '194', '190', '123', '144', '1122',
    '933', '117', '118', '1669', '1691', '995', '03', '114', '115', '122',
    '+1911', '+44999', '+112', '+61000', '+86110', '+81110', '+49112', 
    '+33112', '+39112', '+34112', '+61000', '+86119', '+81119', '+91112',
    '+911911', '+44999', '+61000', '+86110'
}

EMERGENCY_PATTERNS = [
    r'^9+1+1+$',
    r'^[0-9]{0,3}911$',
    r'^[0-9]{0,3}999$',
    r'^[0-9]{0,3}112$',
    r'^[0-9]{0,3}000$',
    r'^[0-9]{0,3}110$',
    r'^[0-9]{0,3}108$',
]

PROHIBITED_KEYWORDS = [
    'emergency', 'ambulance', 'fire', 'police', 'suicide', 'bomb', 'threat',
    'ransom', 'extortion', 'blackmail', 'hack', 'steal', 'fraud', 'scam',
    'illegal', 'money laundering', 'drug', 'weapon', 'explosive', 'terrorism',
    'attack', 'kill', 'murder', 'kidnap', 'hostage', 'swat', 'harassment',
    'phishing', 'identity theft', 'credit card fraud', 'pyramid scheme',
    'ponzi scheme', 'rob', 'burglary', 'assault', 'threaten', 'intimidate',
    'coerce', 'bribe', 'corrupt', 'smuggle', 'traffick', 'launder',
    'counterfeit', 'forge', 'fake document', 'fake id', 'social security fraud',
    'tax evasion', 'insider trading', 'market manipulation', 'price fixing'
]

SENSITIVE_KEYWORDS = [
    'payment', 'credit card', 'bank account', 'ssn', 'social security',
    'password', 'pin', 'account number', 'routing number', 'cvv',
    'medicare', 'medicaid', 'insurance claim', 'refund', 'prize',
    'lottery', 'inheritance', 'investment opportunity', 'irs', 'tax debt'
]

def is_emergency_number(phone_number: str) -> tuple[bool, Optional[str]]:
    cleaned = re.sub(r'[^\d+]', '', phone_number.strip())
    
    if cleaned in EMERGENCY_NUMBERS:
        return True, f"Direct emergency number detected: {phone_number}"
    
    digits_only = cleaned.replace('+', '')
    if digits_only in EMERGENCY_NUMBERS:
        return True, f"Emergency number detected: {phone_number}"
    
    for pattern in EMERGENCY_PATTERNS:
        if re.match(pattern, digits_only):
            return True, f"Emergency number pattern detected: {phone_number}"
    
    if len(digits_only) == 3 and digits_only in ['911', '999', '112', '000', '110', '108', '119']:
        return True, f"3-digit emergency number detected: {phone_number}"
    
    return False, None

def check_content_safety(text: str, context: str = "content") -> tuple[bool, Optional[str]]:
    if not text:
        return True, None
    
    text_lower = text.lower()
    
    found_prohibited = []
    for keyword in PROHIBITED_KEYWORDS:
        if keyword in text_lower:
            found_prohibited.append(keyword)
    
    if found_prohibited:
        logger.warning(f"Prohibited keywords detected in {context}: {', '.join(found_prohibited)}")
        return False, f"Content contains prohibited keywords related to illegal, unethical, or emergency activities: {', '.join(found_prohibited[:3])}"
    
    found_sensitive = []
    for keyword in SENSITIVE_KEYWORDS:
        if keyword in text_lower:
            found_sensitive.append(keyword)
    
    if len(found_sensitive) >= 2:
        logger.warning(f"Multiple sensitive keywords detected in {context}: {', '.join(found_sensitive)}")
        return False, f"Content appears to request sensitive personal or financial information, which may indicate a scam or fraud attempt: {', '.join(found_sensitive[:3])}"
    
    scam_patterns = [
        (r'\b(urgent|immediate|act now|limited time)\b.*\b(payment|bank|account|money)\b', 
         "urgency combined with financial requests"),
        (r'\b(verify|confirm|update)\b.*\b(account|payment|credit card|social security)\b',
         "verification requests for sensitive information"),
        (r'\b(suspended|locked|frozen|compromised)\b.*\b(account|card|access)\b',
         "account threat combined with action request"),
        (r'\b(won|prize|lottery|inheritance|refund)\b.*\b(claim|collect|receive|pay)\b',
         "prize/refund claim requests"),
        (r'\b(irs|tax|government|federal)\b.*\b(owe|debt|arrest|warrant|legal action)\b',
         "government impersonation with threats")
    ]
    
    for pattern, description in scam_patterns:
        if re.search(pattern, text_lower, re.IGNORECASE):
            logger.warning(f"Potential scam pattern detected in {context}: {description}")
            return False, f"Content matches common scam patterns: {description}"
    
    return True, None

def validate_call_safety(phone_number: str, first_message: str, system_prompt: Optional[str]) -> tuple[bool, Optional[str]]:
    is_emergency, emergency_reason = is_emergency_number(phone_number)
    if is_emergency:
        logger.error(f"BLOCKED: Attempted call to emergency number - {emergency_reason}")
        return False, f"❌ CALL BLOCKED: {emergency_reason}. Emergency numbers cannot be called through this system. For emergencies, dial directly from your phone."
    
    is_safe, safety_reason = check_content_safety(first_message, "first message")
    if not is_safe:
        logger.error(f"BLOCKED: Unsafe content in first message - {safety_reason}")
        return False, f"❌ CALL BLOCKED: {safety_reason}"
    
    if system_prompt:
        is_safe, safety_reason = check_content_safety(system_prompt, "system prompt")
        if not is_safe:
            logger.error(f"BLOCKED: Unsafe content in system prompt - {safety_reason}")
            return False, f"❌ CALL BLOCKED: {safety_reason}"
    
    return True, None

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
            "description": "Initiate an outbound phone call using AI voice agent. The agent will call the specified phone number and have a conversation based on the provided configuration. This tool returns immediately after initiating the call. ALWAYS Use wait_for_call_completion to monitor the call until it ends.\n\nSAFETY RESTRICTIONS: This tool will automatically block calls to emergency numbers (911, 999, 112, etc.) and calls with content indicating illegal, unethical, or fraudulent activities. The AI assistant is programmed to never request sensitive personal or financial information.",
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
        
        is_safe, safety_message = validate_call_safety(phone_number, first_message, system_prompt)
        if not is_safe:
            return self.fail_response(safety_message)
        
        try:
            normalized_phone, country_code, country_name = normalize_phone_number(phone_number)
            
            is_safe_normalized, safety_message_normalized = validate_call_safety(normalized_phone, first_message, system_prompt)
            if not is_safe_normalized:
                return self.fail_response(safety_message_normalized)
            
            thread_id, user_id, agent_id = await self._get_current_thread_and_user()
            safety_guidelines = "\n\nETHICAL GUIDELINES (MANDATORY):\n- NEVER request sensitive personal information (SSN, passwords, credit card numbers, bank accounts, PINs)\n- NEVER discuss illegal activities, threats, or emergency services\n- NEVER impersonate government agencies, law enforcement, or financial institutions\n- NEVER create urgency to manipulate the recipient into taking immediate action\n- NEVER request payments, transfers, or financial transactions\n- Be respectful, honest, and transparent about being an AI assistant"
            
            country_context = f"\n\nIMPORTANT: You are calling a phone number in {country_name} (country code +{country_code}). Please be aware of potential cultural differences, time zones, and language preferences."
            
            if system_prompt:
                enhanced_system_prompt = system_prompt + country_context + safety_guidelines
            else:
                enhanced_system_prompt = DEFAULT_SYSTEM_PROMPT + country_context + safety_guidelines
            
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
