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
from core.utils.config import config, EnvMode
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
        # This should point to your backend base URL since Supabase Cron will POST to backend
        self._webhook_base_url = os.getenv("WEBHOOK_BASE_URL", "http://localhost:8000")
        self._db = DBConnection()
    
    async def validate_config(self, config: Dict[str, Any]) -> Dict[str, Any]:
        if 'cron_expression' not in config:
            raise ValueError("cron_expression is required for scheduled triggers")
        
        execution_type = config.get('execution_type', 'agent')
        if execution_type not in ['agent', 'workflow']:
            raise ValueError("execution_type must be either 'agent' or 'workflow'")
        
        if execution_type == 'agent' and 'agent_prompt' not in config:
            raise ValueError("agent_prompt is required for agent execution")
        elif execution_type == 'workflow' and 'workflow_id' not in config:
            raise ValueError("workflow_id is required for workflow execution")
        
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
        
        return config
    
    async def setup_trigger(self, trigger: Trigger) -> bool:
        try:
            webhook_url = f"{self._webhook_base_url}/api/triggers/{trigger.trigger_id}/webhook"
            cron_expression = trigger.config['cron_expression']
            execution_type = trigger.config.get('execution_type', 'agent')
            user_timezone = trigger.config.get('timezone', 'UTC')

            if user_timezone != 'UTC':
                cron_expression = self._convert_cron_to_utc(cron_expression, user_timezone)
            
            payload = {
                "trigger_id": trigger.trigger_id,
                "agent_id": trigger.agent_id,
                "execution_type": execution_type,
                "agent_prompt": trigger.config.get('agent_prompt'),
                "workflow_id": trigger.config.get('workflow_id'),
                "workflow_input": trigger.config.get('workflow_input', {}),
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
            
            headers: Dict[str, Any] = {
                "Content-Type": "application/json",
                "X-Trigger-Source": "schedule"
            }

            # Include simple shared secret header for backend auth
            secret = os.getenv("TRIGGER_WEBHOOK_SECRET")
            if secret:
                headers["X-Trigger-Secret"] = secret
            if config.ENV_MODE == EnvMode.STAGING:
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
            execution_type = raw_data.get('execution_type', 'agent')
            
            execution_variables = {
                'scheduled_time': raw_data.get('timestamp'),
                'trigger_id': event.trigger_id,
                'agent_id': event.agent_id
            }
            
            if execution_type == 'workflow':
                workflow_id = raw_data.get('workflow_id')
                workflow_input = raw_data.get('workflow_input', {})
                
                if not workflow_id:
                    raise ValueError("workflow_id is required for workflow execution")
                
                return TriggerResult(
                    success=True,
                    should_execute_workflow=True,
                    workflow_id=workflow_id,
                    workflow_input=workflow_input,
                    execution_variables=execution_variables
                )
            else:
                agent_prompt = raw_data.get('agent_prompt')
                
                if not agent_prompt:
                    raise ValueError("agent_prompt is required for agent execution")
                
                return TriggerResult(
                    success=True,
                    should_execute_agent=True,
                    agent_prompt=agent_prompt,
                    execution_variables=execution_variables
                )
                
        except Exception as e:
            return TriggerResult(
                success=False,
                error_message=f"Error processing schedule event: {str(e)}"
            )
    
    def _convert_cron_to_utc(self, cron_expression: str, user_timezone: str) -> str:
        try:
            parts = cron_expression.split()
            if len(parts) != 5:
                return cron_expression
                
            minute, hour, day, month, weekday = parts
            
            if minute.startswith('*/') and hour == '*':
                return cron_expression
            if hour == '*' or minute == '*':
                return cron_expression
                
            try:
                user_tz = pytz.timezone(user_timezone)
                utc_tz = pytz.UTC
                now = datetime.now(user_tz)
                
                if hour.isdigit() and minute.isdigit():
                    user_time = user_tz.localize(datetime(now.year, now.month, now.day, int(hour), int(minute)))
                    utc_time = user_time.astimezone(utc_tz)
                    return f"{utc_time.minute} {utc_time.hour} {day} {month} {weekday}"
                    
            except Exception as e:
                logger.warning(f"Failed to convert timezone for cron expression: {e}")
                
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
                    "execution_type": {
                        "type": "string",
                        "enum": ["agent", "workflow"],
                        "description": "Type of execution"
                    },
                    "agent_prompt": {
                        "type": "string",
                        "description": "Prompt for agent execution"
                    },
                    "workflow_id": {
                        "type": "string",
                        "description": "ID of workflow to execute"
                    },
                    "workflow_input": {
                        "type": "object",
                        "description": "JSON input variables for the selected workflow/playbook",
                        "additionalProperties": True
                    },
                    "timezone": {
                        "type": "string",
                        "description": "Timezone for cron expression"
                    }
                },
                "required": ["cron_expression", "execution_type"]
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
                    "execution_type": {
                        "type": "string",
                        "enum": ["agent", "workflow"],
                        "description": "How to route the event"
                    },
                    "agent_prompt": {
                        "type": "string",
                        "description": "Prompt template for agent execution"
                    },
                    "workflow_id": {
                        "type": "string",
                        "description": "Workflow ID to execute for workflow routing"
                    },
                    "workflow_input": {
                        "type": "object",
                        "description": "Optional static input object for workflow execution",
                        "additionalProperties": True
                    }
                },
                "required": ["composio_trigger_id", "execution_type"]
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
        
        # Use PostgreSQL JSON operator for exact match
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
        
        # Use PostgreSQL JSON operator for exact match
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

        execution_type = config.get("execution_type", "agent")
        if execution_type not in ["agent", "workflow"]:
            raise ValueError("execution_type must be either 'agent' or 'workflow'")

        if execution_type == "workflow" and not config.get("workflow_id"):
            raise ValueError("workflow_id is required for workflow execution")

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

            route = trigger.config.get("execution_type", "agent")
            if route == "workflow":
                workflow_id = trigger.config.get("workflow_id")
                workflow_input = trigger.config.get("workflow_input", {})
                return TriggerResult(
                    success=True,
                    should_execute_workflow=True,
                    workflow_id=workflow_id,
                    workflow_input=workflow_input,
                    execution_variables=execution_variables,
                )
            else:
                # Agent routing
                agent_prompt = trigger.config.get("agent_prompt")
                if not agent_prompt:
                    # Minimal default prompt
                    agent_prompt = f"Process Composio event {trigger_slug or ''}: {json.dumps(raw.get('payload', raw))[:800]}"

                return TriggerResult(
                    success=True,
                    should_execute_agent=True,
                    agent_prompt=agent_prompt,
                    execution_variables=execution_variables,
                )

        except Exception as e:
            return TriggerResult(success=False, error_message=f"Error processing Composio event: {str(e)}")


def get_provider_service(db_connection: DBConnection) -> ProviderService:
    return ProviderService(db_connection) 