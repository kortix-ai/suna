import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Dict, Any, Optional, List

from core.services.convex_client import get_convex_client
from core.utils.logger import logger


class TriggerType(str, Enum):
    SCHEDULE = "schedule"
    WEBHOOK = "webhook"
    EVENT = "event"


@dataclass
class TriggerEvent:
    trigger_id: str
    agent_id: str
    trigger_type: TriggerType
    raw_data: Dict[str, Any]
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    context: Dict[str, Any] = field(default_factory=dict)


@dataclass
class TriggerResult:
    success: bool
    should_execute_agent: bool = False
    agent_prompt: Optional[str] = None
    execution_variables: Dict[str, Any] = field(default_factory=dict)
    error_message: Optional[str] = None
    model: Optional[str] = None


@dataclass
class Trigger:
    trigger_id: str
    agent_id: str
    provider_id: str
    trigger_type: TriggerType
    name: str
    description: Optional[str]
    is_active: bool
    config: Dict[str, Any]
    created_at: datetime
    updated_at: datetime


class TriggerService:
    def __init__(self, db_connection=None):
        # db_connection is kept for backward compatibility but not used
        # We now use the Convex client singleton
        pass
    
    async def create_trigger(
        self,
        agent_id: str,
        provider_id: str,
        name: str,
        config: Dict[str, Any],
        description: Optional[str] = None
    ) -> Trigger:
        trigger_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc)
        
        from .provider_service import get_provider_service
        provider_service = get_provider_service()
        validated_config = await provider_service.validate_trigger_config(provider_id, config)
        
        trigger_type = await provider_service.get_provider_trigger_type(provider_id)
        
        trigger = Trigger(
            trigger_id=trigger_id,
            agent_id=agent_id,
            provider_id=provider_id,
            trigger_type=trigger_type,
            name=name,
            description=description,
            is_active=True,
            config=validated_config,
            created_at=now,
            updated_at=now
        )
        
        # Skip setup_trigger for Composio since triggers are already enabled when created
        if provider_id != "composio":
            setup_success = await provider_service.setup_trigger(trigger)
            if not setup_success:
                raise ValueError(f"Failed to setup trigger with provider: {provider_id}")
        
        await self._save_trigger(trigger)
        
        logger.debug(f"Created trigger {trigger_id} for agent {agent_id}")
        return trigger
    
    async def get_trigger(self, trigger_id: str) -> Optional[Trigger]:
        convex = get_convex_client()
        try:
            data = await convex.get_trigger(trigger_id)
            if data:
                return self._map_to_trigger(data)
        except Exception as e:
            logger.warning(f"Failed to get trigger {trigger_id}: {e}")
        return None
    
    async def get_agent_triggers(self, agent_id: str) -> List[Trigger]:
        convex = get_convex_client()
        triggers_data = await convex.list_triggers(agent_id)
        
        return [self._map_to_trigger(data) for data in triggers_data]
    
    async def update_trigger(
        self,
        trigger_id: str,
        config: Optional[Dict[str, Any]] = None,
        name: Optional[str] = None,
        description: Optional[str] = None,
        is_active: Optional[bool] = None
    ) -> Trigger:
        trigger = await self.get_trigger(trigger_id)
        if not trigger:
            raise ValueError(f"Trigger not found: {trigger_id}")
        
        # Track previous activation state to optimize provider reconciliation
        previous_is_active = trigger.is_active

        if config is not None:
            from .provider_service import get_provider_service
            provider_service = get_provider_service()
            config = await provider_service.validate_trigger_config(trigger.provider_id, config)
        
        if name is not None:
            trigger.name = name
        if description is not None:
            trigger.description = description
        if is_active is not None:
            trigger.is_active = is_active
        if config is not None:
            trigger.config = config
        
        trigger.updated_at = datetime.now(timezone.utc)
        
        # Reconcile provider when config changes or activation state toggles
        config_changed = config is not None
        activation_toggled = (is_active is not None) and (previous_is_active != trigger.is_active)


        # UPDATE DATABASE FIRST so provider methods see correct state
        await self._update_trigger(trigger)

        if config_changed or activation_toggled:
            from .provider_service import get_provider_service
            provider_service = get_provider_service()

            if config_changed:
                # For config changes, fully teardown and (re)setup if active
                await provider_service.teardown_trigger(trigger)
                if trigger.is_active:
                    setup_success = await provider_service.setup_trigger(trigger)
                    if not setup_success:
                        raise ValueError(f"Failed to update trigger setup: {trigger_id}")
            elif activation_toggled:
                # Only activation toggled; call the appropriate action
                if trigger.is_active:
                    setup_success = await provider_service.setup_trigger(trigger)
                    if not setup_success:
                        raise ValueError(f"Failed to enable trigger: {trigger_id}")
                else:
                    await provider_service.teardown_trigger(trigger)
        
        logger.debug(f"Updated trigger {trigger_id}")
        return trigger
    
    async def delete_trigger(self, trigger_id: str) -> bool:
        trigger = await self.get_trigger(trigger_id)
        if not trigger:
            return False

        # DELETE FROM DATABASE FIRST so provider methods see correct state
        convex = get_convex_client()
        try:
            await convex.delete_trigger(trigger_id)
        except Exception as e:
            logger.error(f"Failed to delete trigger {trigger_id} from Convex: {e}")
            return False

        from .provider_service import get_provider_service
        provider_service = get_provider_service()
        # Now disable remotely so webhooks stop quickly
        try:
            await provider_service.teardown_trigger(trigger)
        except Exception:
            pass
        # Then request remote delete if provider supports it
        try:
            await provider_service.delete_remote_trigger(trigger)
        except Exception:
            pass

        return True
    
    async def process_trigger_event(self, trigger_id: str, raw_data: Dict[str, Any]) -> TriggerResult:
        trigger = await self.get_trigger(trigger_id)
        if not trigger:
            return TriggerResult(success=False, error_message=f"Trigger not found: {trigger_id}")
        
        if not trigger.is_active:
            return TriggerResult(success=False, error_message=f"Trigger is inactive: {trigger_id}")
        
        event = TriggerEvent(
            trigger_id=trigger_id,
            agent_id=trigger.agent_id,
            trigger_type=trigger.trigger_type,
            raw_data=raw_data
        )
        
        from .provider_service import get_provider_service
        provider_service = get_provider_service()
        result = await provider_service.process_event(trigger, event)
        
        try:
            await self._log_trigger_event(event, result)
        except Exception as e:
            logger.warning(f"Failed to log trigger event: {e}")
        
        return result
    
    async def _save_trigger(self, trigger: Trigger) -> None:
        convex = get_convex_client()
        
        config_with_provider = {**trigger.config, "provider_id": trigger.provider_id}
        
        await convex.create_trigger(
            trigger_id=trigger.trigger_id,
            agent_id=trigger.agent_id,
            trigger_type=trigger.trigger_type.value,
            name=trigger.name,
            description=trigger.description,
            is_active=trigger.is_active,
            config=config_with_provider,
            account_id=None  # Account ID will be derived from agent ownership
        )
    
    async def _update_trigger(self, trigger: Trigger) -> None:
        convex = get_convex_client()

        config_with_provider = {**trigger.config, "provider_id": trigger.provider_id}

        await convex.update_trigger(
            trigger_id=trigger.trigger_id,
            name=trigger.name,
            description=trigger.description,
            is_active=trigger.is_active,
            config=config_with_provider
        )
    
    def _map_to_trigger(self, data: Dict[str, Any]) -> Trigger:
        config_data = data.get('config', {})
        # Prefer explicit provider_id saved in config; otherwise Infer for backwards compatibility
        provider_id = config_data.get('provider_id')
        if not provider_id:
            # Older event-based Composio triggers didn't persist provider_id. Infer from config.
            if isinstance(config_data, dict) and (
                'composio_trigger_id' in config_data or 'trigger_slug' in config_data
            ):
                provider_id = 'composio'
            else:
                provider_id = data['trigger_type']
        
        clean_config = {k: v for k, v in config_data.items() if k != 'provider_id'}
        
        return Trigger(
            trigger_id=data['trigger_id'],
            agent_id=data['agent_id'],
            provider_id=provider_id,
            trigger_type=TriggerType(data['trigger_type']),
            name=data['name'],
            description=data.get('description'),
            is_active=data.get('is_active', True),
            config=clean_config,
            created_at=datetime.fromisoformat(data['created_at'].replace('Z', '+00:00')),
            updated_at=datetime.fromisoformat(data['updated_at'].replace('Z', '+00:00'))
        )
    
    async def _log_trigger_event(self, event: TriggerEvent, result: TriggerResult) -> None:
        convex = get_convex_client()

        # Ensure raw_data is JSON serializable
        try:
            if isinstance(event.raw_data, bytes):
                event_data = event.raw_data.decode('utf-8', errors='replace')
            elif isinstance(event.raw_data, str):
                event_data = event.raw_data
            else:
                event_data = str(event.raw_data)
        except Exception as e:
            logger.warning(f"Failed to serialize raw_data: {e}")
            event_data = str(event.raw_data) if event.raw_data else "{}"

        await convex.log_trigger_event(
            log_id=str(uuid.uuid4()),
            trigger_id=event.trigger_id,
            agent_id=event.agent_id,
            trigger_type=event.trigger_type.value,
            event_data=event_data,
            success=result.success,
            should_execute_agent=result.should_execute_agent,
            agent_prompt=result.agent_prompt,
            execution_variables=result.execution_variables,
            error_message=result.error_message,
            event_timestamp=event.timestamp.isoformat()
        )


def get_trigger_service(db_connection=None) -> TriggerService:
    return TriggerService(db_connection)