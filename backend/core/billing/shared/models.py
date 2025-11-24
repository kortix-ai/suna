from pydantic import BaseModel
from decimal import Decimal
from typing import Optional

class CreateCheckoutSessionRequest(BaseModel):
    tier_key: str  # Backend tier key like 'tier_2_20', 'free', etc.
    success_url: str
    cancel_url: str
    commitment_type: Optional[str] = None

class CreatePortalSessionRequest(BaseModel):
    return_url: str
 
class PurchaseCreditsRequest(BaseModel):
    amount: Decimal
    success_url: str
    cancel_url: str

class TrialStartRequest(BaseModel):
    success_url: str
    cancel_url: str

class TokenUsageRequest(BaseModel):
    prompt_tokens: int
    completion_tokens: int
    model: str
    thread_id: Optional[str] = None
    message_id: Optional[str] = None

class CancelSubscriptionRequest(BaseModel):
    feedback: Optional[str] = None
