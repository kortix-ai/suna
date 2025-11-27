from enum import Enum
from typing import Dict, List, Optional, Any
from pydantic import BaseModel
from datetime import datetime


class NotificationChannel(str, Enum):
    EMAIL = "email"
    IN_APP = "in_app"
    PUSH = "push"
    SMS = "sms"


class NotificationEvent(str, Enum):
    TASK_COMPLETED = "task_completed"
    TASK_FAILED = "task_failed"
    AGENT_RUN_COMPLETED = "agent_run_completed"
    AGENT_RUN_FAILED = "agent_run_failed"
    
    SUBSCRIPTION_CREATED = "subscription_created"
    SUBSCRIPTION_RENEWED = "subscription_renewed"
    SUBSCRIPTION_CANCELLED = "subscription_cancelled"
    SUBSCRIPTION_EXPIRING_SOON = "subscription_expiring_soon"
    PAYMENT_SUCCEEDED = "payment_succeeded"
    PAYMENT_FAILED = "payment_failed"
    
    CREDITS_LOW = "credits_low"
    CREDITS_DEPLETED = "credits_depleted"
    CREDITS_REFILLED = "credits_refilled"
    
    WELCOME = "welcome"
    PROMOTIONAL = "promotional"
    SYSTEM_ALERT = "system_alert"
    
    TRIGGER_EXECUTED = "trigger_executed"
    TRIGGER_FAILED = "trigger_failed"


class NotificationPriority(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    URGENT = "urgent"


class NotificationPreference(BaseModel):
    account_id: str
    event_type: NotificationEvent
    enabled_channels: List[NotificationChannel]
    enabled: bool = True
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class NotificationPayload(BaseModel):
    event_type: NotificationEvent
    user_id: str
    channels: Optional[List[NotificationChannel]] = None
    data: Dict[str, Any]
    priority: NotificationPriority = NotificationPriority.MEDIUM
    metadata: Optional[Dict[str, Any]] = None


class NotificationLog(BaseModel):
    id: Optional[str] = None
    user_id: str
    event_type: NotificationEvent
    channel: NotificationChannel
    status: str
    novu_transaction_id: Optional[str] = None
    error_message: Optional[str] = None
    payload: Optional[Dict[str, Any]] = None
    created_at: Optional[datetime] = None


class UserNotificationSettings(BaseModel):
    account_id: str
    email_enabled: bool = True
    push_enabled: bool = False
    in_app_enabled: bool = True
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
