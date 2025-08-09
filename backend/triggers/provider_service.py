import asyncio
import json
import os
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Dict, Any, Optional, List

import croniter
import pytz
from services.supabase import DBConnection

from services.supabase import DBConnection
from utils.logger import logger
from utils.config import config, EnvMode
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
            logger.info(f"Created Supabase Cron job '{job_name}' for trigger {trigger.trigger_id}")
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
                logger.info(f"Unschedule requested for Supabase Cron job '{job_name}' (trigger {trigger.trigger_id})")
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
    
    async def process_event(self, trigger: Trigger, event: TriggerEvent) -> TriggerResult:
        provider = self._providers.get(trigger.provider_id)
        if not provider:
            return TriggerResult(
                success=False,
                error_message=f"Unknown provider: {trigger.provider_id}"
            )
        
        return await provider.process_event(trigger, event)


def get_provider_service(db_connection: DBConnection) -> ProviderService:
    return ProviderService(db_connection) 