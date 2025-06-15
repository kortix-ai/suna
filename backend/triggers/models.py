from enum import Enum
from typing import Optional, Dict, Any
from pydantic import BaseModel, Field


class TriggerType(str, Enum):
    webhook = "webhook"
    cron = "cron"
    event = "event"


class TriggerBase(BaseModel):
    name: str = Field(..., example="New Webhook Trigger")
    description: Optional[str] = None
    type: TriggerType = Field(..., description="Type of trigger")
    config: Dict[str, Any] = Field(default_factory=dict, description="Trigger-specific configuration JSON")
    enabled: bool = True


class TriggerCreateRequest(TriggerBase):
    pass


class TriggerUpdateRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    enabled: Optional[bool] = None


class TriggerResponse(TriggerBase):
    id: str
    account_id: str
    project_id: Optional[str]
    secret: Optional[str] = Field(None, description="Secret for webhook authentication (only for webhook triggers)")
    created_at: str
    updated_at: str

    class Config:
        orm_mode = True 