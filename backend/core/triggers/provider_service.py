import asyncio
import json
import os
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Dict, Any, Optional, List

import croniter
import pytz
import httpx
from core.services.supabase import DBConnection

from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.utils.config import config as app_config, EnvMode
from .trigger_service import Trigger, TriggerEvent, TriggerResult, TriggerType


class TriggerProvider(ABC):
    
    def __init__(self, provider_id: str, trigger_type: TriggerType):
        self.provider_id = provider_id
        self.trigger_type = trigger_type
    
    @abstractmethod
    async def validate_config(self, config: Dict[str, Any]) -> Dict[str, Any]:
        pass
    
    @abstractmethod
    async def setup_trigger(self, trigger: Trigger) -> bool:
        pass
    
    @abstractmethod
    async def teardown_trigger(self, trigger: Trigger) -> bool:
        pass
    
    @abstractmethod
    async def process_event(self, trigger: Trigger, event: TriggerEvent) -> TriggerResult:
        pass

    # Optional override for providers that manage remote trigger instances
    async def delete_remote_trigger(self, trigger: Trigger) -> bool:
        return True


class ScheduleProvider(TriggerProvider):
    def __init__(self):
        super().__init__("schedule", TriggerType.SCHEDULE)
        self._db = DBConnection()
    
    async def validate_config(self, config: Dict[str, Any]) -> Dict[str, Any]:
        if 'cron_expression' not in config:
            raise ValueError("cron_expression is required for scheduled triggers")
        
        if 'agent_prompt' not in config:
            raise ValueError("agent_prompt is required for agent execution")
        
        user_timezone = config.get('timezone', 'UTC')
        if user_timezone != 'UTC':
            try:
                pytz.timezone(user_timezone)
            except pytz.UnknownTimeZoneError:
                raise ValueError(f"Invalid timezone: {user_timezone}")
        
        try:
            croniter.croniter(config['cron_expression'])
        except Exception as e:
            raise ValueError(f"Invalid cron expression: {str(e)}")
        
        if app_config.ENV_MODE != EnvMode.STAGING:
            cron_parts = config['cron_expression'].split()
            if len(cron_parts) == 5:
                minute, hour, day, month, weekday = cron_parts
                
                if hour == '*' and (minute == '*' or minute.startswith('*/')):
                    raise ValueError("Schedules that run more frequently than once per hour are not allowed. Minimum interval is 1 hour.")
                
                if minute.startswith('*/'):
                    try:
                        interval = int(minute[2:])
                        if interval < 60:
                            raise ValueError("Schedules that run more frequently than once per hour are not allowed. Minimum interval is 1 hour.")
                    except ValueError:
                        pass
        
        return config
    
    async def setup_trigger(self, trigger: Trigger) -> bool:
        try:
            base_url = app_config.WEBHOOK_BASE_URL or 'http://localhost:8000'
            webhook_url = f"{base_url}/v1/triggers/{trigger.trigger_id}/webhook"
            cron_expression = trigger.config['cron_expression']
            user_timezone = trigger.config.get('timezone', 'UTC')

            if user_timezone != 'UTC':
                cron_expression = self._convert_cron_to_utc(cron_expression, user_timezone)
            
            payload = {
                "trigger_id": trigger.trigger_id,
                "agent_id": trigger.agent_id,
                "agent_prompt": trigger.config.get('agent_prompt'),
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
            
            headers: Dict[str, Any] = {
                "Content-Type": "application/json",
                "X-Trigger-Source": "schedule"
            }

            secret = os.getenv("TRIGGER_WEBHOOK_SECRET")
            if secret:
                headers["X-Trigger-Secret"] = secret
            if app_config.ENV_MODE == EnvMode.STAGING:
                vercel_bypass_key = os.getenv("VERCEL_PROTECTION_BYPASS_KEY", "")
                if vercel_bypass_key:
                    headers["X-Vercel-Protection-Bypass"] = vercel_bypass_key

            # Supabase Cron job names are case-sensitive; we keep a stable name per trigger
            job_name = f"trigger_{trigger.trigger_id}"

            # Schedule via Supabase Cron RPC helper
            client = await self._db.client
            try:
                result = await client.rpc(
                    "schedule_trigger_http",
                    {
                        "job_name": job_name,
                        "schedule": cron_expression,
                        "url": webhook_url,
                        "headers": headers,
                        "body": payload,
                        "timeout_ms": 8000,
                    },
                ).execute()
            except Exception as rpc_err:
                logger.error(f"Failed to schedule Supabase Cron job via RPC: {rpc_err}")
                return False

            trigger.config['cron_job_name'] = job_name
            try:
                trigger.config['cron_job_id'] = result.data
            except Exception:
                trigger.config['cron_job_id'] = None
            logger.debug(f"Created Supabase Cron job '{job_name}' for trigger {trigger.trigger_id}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to setup Supabase Cron schedule for trigger {trigger.trigger_id}: {e}")
            return False
    
    async def teardown_trigger(self, trigger: Trigger) -> bool:
        try:
            job_name = trigger.config.get('cron_job_name') or f"trigger_{trigger.trigger_id}"
            client = await self._db.client

            try:
                await client.rpc(
                    "unschedule_job_by_name",
                    {"job_name": job_name},
                ).execute()
                logger.debug(f"Unschedule requested for Supabase Cron job '{job_name}' (trigger {trigger.trigger_id})")
                return True
            except Exception as rpc_err:
                logger.warning(f"Failed to unschedule job '{job_name}' via RPC: {rpc_err}")
                return False
            
        except Exception as e:
            logger.error(f"Failed to teardown Supabase Cron schedule for trigger {trigger.trigger_id}: {e}")
            return False
    
    async def process_event(self, trigger: Trigger, event: TriggerEvent) -> TriggerResult:
        try:
            raw_data = event.raw_data
            
            execution_variables = {
                'scheduled_time': raw_data.get('timestamp'),
                'trigger_id': event.trigger_id,
                'agent_id': event.agent_id
            }
            
            agent_prompt = raw_data.get('agent_prompt')
            
            if not agent_prompt:
                raise ValueError("agent_prompt is required for agent execution")
            
            model = trigger.config.get('model') if trigger.config else None
            
            return TriggerResult(
                success=True,
                should_execute_agent=True,
                agent_prompt=agent_prompt,
                execution_variables=execution_variables,
                model=model
            )
                
        except Exception as e:
            return TriggerResult(
                success=False,
                error_message=f"Error processing schedule event: {str(e)}"
            )
    
    def _convert_cron_to_utc(self, cron_expression: str, user_timezone: str) -> str:
        """
        Convert a cron expression from user's timezone to UTC.
        
        This handles the conversion of hour/minute values to UTC, accounting for DST.
        Uses today's date as reference to determine the current DST offset.
        
        Note: Due to DST changes, there may be a 1-hour shift during DST transitions.
        For expressions with wildcards or intervals, returns the original expression.
        
        Handles:
        - Single hour values: "0 9 * * *" 
        - Comma-separated hours: "0 9,17 * * *"
        - Day boundary crossing when converting timezones
        """
        try:
            parts = cron_expression.split()
            if len(parts) != 5:
                return cron_expression
                
            minute, hour, day, month, weekday = parts
            
            # If minute or hour contain wildcards or step intervals, we can't convert meaningfully
            if '*' in minute or '*' in hour or '/' in minute or '/' in hour:
                logger.debug(f"Cron expression {cron_expression} contains wildcards/intervals - will run in UTC")
                return cron_expression
            
            # Check if we're dealing with specific days that would need date adjustment
            # For safety, only convert expressions with wildcard days (daily schedules)
            has_specific_day = day != '*' and not day.startswith('*/')
            has_specific_weekday = weekday != '*' and weekday != '0-6' and weekday != '1-7'
            
            try:
                user_tz = pytz.timezone(user_timezone)
                
                # Get today's date in the user's timezone to account for current DST
                now_in_user_tz = datetime.now(user_tz)
                reference_date = now_in_user_tz.date()
                
                # Parse minute - could be single value or comma-separated
                if ',' in minute:
                    minutes = [int(m.strip()) for m in minute.split(',')]
                else:
                    minutes = [int(minute)]
                
                # Parse hour - could be single value, comma-separated, or range
                if ',' in hour:
                    hours = [int(h.strip()) for h in hour.split(',')]
                elif '-' in hour:
                    # Range like "9-17"
                    start, end = hour.split('-')
                    hours = list(range(int(start), int(end) + 1))
                else:
                    hours = [int(hour)]
                
                # Convert each hour:minute combination to UTC
                utc_hours = set()
                utc_minutes = set()
                day_offset = 0  # Track if we cross day boundary
                
                for h in hours:
                    for m in minutes:
                        # Create datetime in user's timezone
                        user_time_naive = datetime.combine(
                            reference_date, 
                            datetime.min.time().replace(hour=h, minute=m)
                        )
                        user_time = user_tz.localize(user_time_naive)
                        
                        # Convert to UTC
                        utc_time = user_time.astimezone(timezone.utc)
                        
                        utc_hours.add(utc_time.hour)
                        utc_minutes.add(utc_time.minute)
                        
                        # Check for day boundary crossing (only relevant for specific day schedules)
                        if utc_time.date() != user_time.date():
                            if utc_time.date() < user_time.date():
                                day_offset = -1
                            else:
                                day_offset = 1
                
                # Format the UTC hour and minute parts
                utc_hour_str = ','.join(str(h) for h in sorted(utc_hours))
                utc_minute_str = ','.join(str(m) for m in sorted(utc_minutes))
                
                # Handle day adjustment for specific day schedules
                converted_day = day
                converted_weekday = weekday
                
                if day_offset != 0:
                    if has_specific_day:
                        # Adjust specific day of month - this is imperfect but handles common cases
                        if day.isdigit():
                            new_day = int(day) + day_offset
                            if 1 <= new_day <= 31:
                                converted_day = str(new_day)
                            else:
                                logger.warning(f"Day boundary crossing results in invalid day {new_day}, keeping original")
                        else:
                            logger.warning(f"Complex day specification '{day}' with day boundary crossing - timing may be off by one day")
                    
                    if has_specific_weekday:
                        # Adjust weekday - 0=Sunday, 6=Saturday in cron
                        if weekday.isdigit():
                            new_weekday = (int(weekday) + day_offset) % 7
                            converted_weekday = str(new_weekday)
                        elif '-' in weekday:
                            # Range like "1-5" (Mon-Fri)
                            start, end = weekday.split('-')
                            new_start = (int(start) + day_offset) % 7
                            new_end = (int(end) + day_offset) % 7
                            converted_weekday = f"{new_start}-{new_end}"
                        else:
                            logger.warning(f"Complex weekday specification '{weekday}' with day boundary crossing - timing may be off by one day")
                
                converted = f"{utc_minute_str} {utc_hour_str} {converted_day} {month} {converted_weekday}"
                logger.debug(f"Converted cron '{cron_expression}' from {user_timezone} to UTC: '{converted}'")
                return converted
                    
            except Exception as e:
                logger.warning(f"Failed to convert timezone for cron expression {cron_expression}: {e}")
                return cron_expression
            
        except Exception as e:
            logger.error(f"Error converting cron expression to UTC: {e}")
            return cron_expression


class WebhookProvider(TriggerProvider):
    
    def __init__(self):
        super().__init__("webhook", TriggerType.WEBHOOK)
    
    async def validate_config(self, config: Dict[str, Any]) -> Dict[str, Any]:
        return config
    
    async def setup_trigger(self, trigger: Trigger) -> bool:
        return True
    
    async def teardown_trigger(self, trigger: Trigger) -> bool:
        return True
    
    async def process_event(self, trigger: Trigger, event: TriggerEvent) -> TriggerResult:
        try:
            execution_variables = {
                'webhook_data': event.raw_data,
                'trigger_id': event.trigger_id,
                'agent_id': event.agent_id
            }
            
            agent_prompt = f"Process webhook data: {json.dumps(event.raw_data)}"
            
            return TriggerResult(
                success=True,
                should_execute_agent=True,
                agent_prompt=agent_prompt,
                execution_variables=execution_variables
            )
            
        except Exception as e:
            return TriggerResult(
                success=False,
                error_message=f"Error processing webhook event: {str(e)}"
            )


class ProviderService:
    
    def __init__(self, db_connection: DBConnection):
        self._db = db_connection
        self._providers: Dict[str, TriggerProvider] = {}
        self._initialize_providers()

    def _initialize_providers(self):
        self._providers["schedule"] = ScheduleProvider()
        self._providers["webhook"] = WebhookProvider()
        composio_provider = ComposioEventProvider()
        composio_provider.set_db(self._db)
        self._providers["composio"] = composio_provider
    
    async def get_available_providers(self) -> List[Dict[str, Any]]:
        providers = []
        
        for provider_id, provider in self._providers.items():
            provider_info = {
                "provider_id": provider_id,
                "name": provider_id.title(),
                "description": f"{provider_id.title()} trigger provider",
                "trigger_type": provider.trigger_type.value,
                "webhook_enabled": True,
                "config_schema": self._get_provider_schema(provider_id)
            }
            providers.append(provider_info)
        
        return providers
    
    def _get_provider_schema(self, provider_id: str) -> Dict[str, Any]:
        if provider_id == "schedule":
            return {
                "type": "object",
                "properties": {
                    "cron_expression": {
                        "type": "string",
                        "description": "Cron expression for scheduling"
                    },
                    "agent_prompt": {
                        "type": "string",
                        "description": "Prompt for agent execution"
                    },
                    "timezone": {
                        "type": "string",
                        "description": "Timezone for cron expression"
                    }
                },
                "required": ["cron_expression", "agent_prompt"]
            }
        elif provider_id == "webhook":
            return {
                "type": "object",
                "properties": {
                    "webhook_secret": {
                        "type": "string",
                        "description": "Secret for webhook validation"
                    }
                },
                "required": []
            }
        elif provider_id == "composio":
            return {
                "type": "object",
                "properties": {
                    "composio_trigger_id": {
                        "type": "string",
                        "description": "Composio trigger instance ID (nano id from payload.id)"
                    },
                    "trigger_slug": {
                        "type": "string",
                        "description": "Composio trigger slug (e.g., GITHUB_COMMIT_EVENT)"
                    },
                    "agent_prompt": {
                        "type": "string",
                        "description": "Prompt template for agent execution"
                    }
                },
                "required": ["composio_trigger_id", "agent_prompt"]
            }
        
        return {"type": "object", "properties": {}, "required": []}
    
    async def validate_trigger_config(self, provider_id: str, config: Dict[str, Any]) -> Dict[str, Any]:
        provider = self._providers.get(provider_id)
        if not provider:
            raise ValueError(f"Unknown provider: {provider_id}")
        
        return await provider.validate_config(config)
    
    async def get_provider_trigger_type(self, provider_id: str) -> TriggerType:
        provider = self._providers.get(provider_id)
        if not provider:
            raise ValueError(f"Unknown provider: {provider_id}")
        
        return provider.trigger_type
    
    async def setup_trigger(self, trigger: Trigger) -> bool:
        provider = self._providers.get(trigger.provider_id)
        if not provider:
            logger.error(f"Unknown provider: {trigger.provider_id}")
            return False
        
        return await provider.setup_trigger(trigger)
    
    async def teardown_trigger(self, trigger: Trigger) -> bool:
        provider = self._providers.get(trigger.provider_id)
        if not provider:
            logger.error(f"Unknown provider: {trigger.provider_id}")
            return False
        
        return await provider.teardown_trigger(trigger)
    
    async def delete_remote_trigger(self, trigger: Trigger) -> bool:
        provider = self._providers.get(trigger.provider_id)
        if not provider:
            logger.error(f"Unknown provider: {trigger.provider_id}")
            return False
        try:
            return await provider.delete_remote_trigger(trigger)
        except Exception as e:
            logger.warning(f"Provider delete_remote_trigger failed for {trigger.provider_id}: {e}")
            return False
    
    async def process_event(self, trigger: Trigger, event: TriggerEvent) -> TriggerResult:
        provider = self._providers.get(trigger.provider_id)
        if not provider:
            return TriggerResult(
                success=False,
                error_message=f"Unknown provider: {trigger.provider_id}"
            )
        
        return await provider.process_event(trigger, event)


class ComposioEventProvider(TriggerProvider):
    def __init__(self):
        # Use WEBHOOK to match existing DB enum (no migration needed)
        super().__init__("composio", TriggerType.WEBHOOK)
        self._api_base = os.getenv("COMPOSIO_API_BASE", "https://backend.composio.dev")
        self._api_key = os.getenv("COMPOSIO_API_KEY", "")
        self._db: Optional[DBConnection] = None

    def set_db(self, db: DBConnection):
        """Set database connection for provider"""
        self._db = db

    async def _count_triggers_with_composio_id(self, composio_trigger_id: str, exclude_trigger_id: Optional[str] = None) -> int:
        """Count how many triggers use the same composio_trigger_id (excluding specified trigger)"""
        if not self._db:
            return 0
        client = await self._db.client
        
        query = client.table('agent_triggers').select('trigger_id', count='exact').eq('trigger_type', 'webhook').eq('config->>composio_trigger_id', composio_trigger_id)
        
        if exclude_trigger_id:
            query = query.neq('trigger_id', exclude_trigger_id)
            
        result = await query.execute()
        count = result.count or 0
        
        return count

    async def _count_active_triggers_with_composio_id(self, composio_trigger_id: str, exclude_trigger_id: Optional[str] = None) -> int:
        """Count how many ACTIVE triggers use the same composio_trigger_id (excluding specified trigger)"""
        if not self._db:
            return 0
        client = await self._db.client
        
        query = client.table('agent_triggers').select('trigger_id', count='exact').eq('trigger_type', 'webhook').eq('is_active', True).eq('config->>composio_trigger_id', composio_trigger_id)
        
        if exclude_trigger_id:
            query = query.neq('trigger_id', exclude_trigger_id)
            
        result = await query.execute()
        count = result.count or 0
        
        return count

    def _headers(self) -> Dict[str, str]:
        return {"x-api-key": self._api_key, "Content-Type": "application/json"}

    def _api_bases(self) -> List[str]:
        # Try env-configured base first, then known public bases
        candidates: List[str] = [
            self._api_base,
            "https://backend.composio.dev",
        ]
        seen: set[str] = set()
        unique: List[str] = []
        for base in candidates:
            if not isinstance(base, str) or not base:
                continue
            if base in seen:
                continue
            seen.add(base)
            unique.append(base.rstrip("/"))
        return unique

    async def validate_config(self, config: Dict[str, Any]) -> Dict[str, Any]:
        composio_trigger_id = config.get("composio_trigger_id")
        if not composio_trigger_id or not isinstance(composio_trigger_id, str):
            raise ValueError("composio_trigger_id is required and must be a string")


        return config

    async def setup_trigger(self, trigger: Trigger) -> bool:
        # Enable in Composio only if this will be the first active trigger with this composio_trigger_id
        try:
            composio_trigger_id = trigger.config.get("composio_trigger_id")
            if not composio_trigger_id or not self._api_key:
                return True
            
            # Check if other ACTIVE triggers are using this composio_trigger_id
            other_active_count = await self._count_active_triggers_with_composio_id(composio_trigger_id, trigger.trigger_id)
            logger.debug(f"Setup trigger {trigger.trigger_id}: other_active_count={other_active_count} for composio_id={composio_trigger_id}")
            
            if other_active_count > 0:
                # Other active triggers exist, don't touch Composio - just mark our trigger as active locally
                logger.debug(f"Skipping Composio enable - {other_active_count} other active triggers exist")
                return True
            
            # We're the first/only active trigger, enable in Composio
            logger.debug(f"Enabling trigger in Composio - first active trigger for {composio_trigger_id}")
            payload_candidates: List[Dict[str, Any]] = [
                {"status": "enable"},
                {"status": "enabled"},
                {"enabled": True},
            ]
            async with httpx.AsyncClient(timeout=10) as client:
                for api_base in self._api_bases():
                    url = f"{api_base}/api/v3/trigger_instances/manage/{composio_trigger_id}"
                    for body in payload_candidates:
                        try:
                            resp = await client.patch(url, headers=self._headers(), json=body)
                            if resp.status_code in (200, 204):
                                logger.debug(f"Successfully enabled trigger in Composio: {composio_trigger_id}")
                                return True
                        except Exception:
                            continue
            return True
        except Exception:
            return True

    async def teardown_trigger(self, trigger: Trigger) -> bool:
        # Disable in Composio only if this was the last active trigger with this composio_trigger_id
        try:
            composio_trigger_id = trigger.config.get("composio_trigger_id")
            
            if not composio_trigger_id or not self._api_key:
                logger.info(f"TEARDOWN: Skipping - no composio_id or api_key")
                return True
            
            # Check if other ACTIVE triggers are using this composio_trigger_id
            other_active_count = await self._count_active_triggers_with_composio_id(composio_trigger_id, trigger.trigger_id)
            
            if other_active_count > 0:
                # Other active triggers exist, don't touch Composio - just mark our trigger as inactive locally
                logger.info(f"TEARDOWN: Skipping Composio disable - {other_active_count} other active triggers exist")
                return True
            
            # We're the last active trigger, disable in Composio
            payload_candidates: List[Dict[str, Any]] = [
                {"status": "disable"},
                {"status": "disabled"},
                {"enabled": False},
            ]
            async with httpx.AsyncClient(timeout=10) as client:
                for api_base in self._api_bases():
                    url = f"{api_base}/api/v3/trigger_instances/manage/{composio_trigger_id}"
                    for body in payload_candidates:
                        try:
                            resp = await client.patch(url, headers=self._headers(), json=body)
                            if resp.status_code in (200, 204):
                                return True
                        except Exception as e:
                            logger.warning(f"TEARDOWN: Failed to disable with body {body}: {e}")
                            continue
            logger.warning(f"TEARDOWN: Failed to disable trigger in Composio: {composio_trigger_id}")
            return True
        except Exception as e:
            logger.error(f"TEARDOWN: Exception in teardown_trigger: {e}")
            return True

    async def delete_remote_trigger(self, trigger: Trigger) -> bool:
        # Only permanently remove the remote Composio trigger if this is the last trigger using it
        try:
            composio_trigger_id = trigger.config.get("composio_trigger_id")
            if not composio_trigger_id or not self._api_key:
                return True
            
            # Check if other triggers are using this composio_trigger_id
            other_count = await self._count_triggers_with_composio_id(composio_trigger_id, trigger.trigger_id)
            if other_count > 0:
                # Other triggers exist, don't delete from Composio - just remove our local trigger
                return True
            
            # We're the last trigger, permanently delete from Composio
            async with httpx.AsyncClient(timeout=10) as client:
                for api_base in self._api_bases():
                    url = f"{api_base}/api/v3/trigger_instances/manage/{composio_trigger_id}"
                    try:
                        resp = await client.delete(url, headers=self._headers())
                        if resp.status_code in (200, 204):
                            return True
                    except Exception:
                        continue
            return False
        except Exception:
            return False

    async def process_event(self, trigger: Trigger, event: TriggerEvent) -> TriggerResult:
        try:
            raw = event.raw_data or {}
            trigger_slug = raw.get("triggerSlug") or trigger.config.get("trigger_slug")
            provider_event_id = raw.get("eventId") or raw.get("payload", {}).get("id") or raw.get("id")
            connected_account_id = None
            metadata = raw.get("metadata") or {}
            if isinstance(metadata, dict):
                connected = metadata.get("connectedAccount") or {}
                if isinstance(connected, dict):
                    connected_account_id = connected.get("id")

            execution_variables = {
                "provider": "composio",
                "trigger_slug": trigger_slug,
                "composio_trigger_id": raw.get("id") or trigger.config.get("composio_trigger_id"),
                "provider_event_id": provider_event_id,
                "connected_account_id": connected_account_id,
                "received_at": datetime.now(timezone.utc).isoformat(),
            }

            agent_prompt = trigger.config.get("agent_prompt")
            if not agent_prompt:
                agent_prompt = f"Process Composio event {trigger_slug or ''}: {json.dumps(raw.get('payload', raw))[:800]}"

            model = trigger.config.get('model') if trigger.config else None

            return TriggerResult(
                success=True,
                should_execute_agent=True,
                agent_prompt=agent_prompt,
                execution_variables=execution_variables,
                model=model
            )

        except Exception as e:
            return TriggerResult(success=False, error_message=f"Error processing Composio event: {str(e)}")


def get_provider_service(db_connection: DBConnection) -> ProviderService:
    return ProviderService(db_connection) 