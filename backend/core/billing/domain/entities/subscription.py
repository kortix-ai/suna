from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Optional, Dict
from enum import Enum

class SubscriptionStatus(Enum):
    ACTIVE = "active"
    CANCELED = "canceled"
    PAST_DUE = "past_due"
    INCOMPLETE = "incomplete"
    TRIALING = "trialing"

class SubscriptionProvider(Enum):
    STRIPE = "stripe"
    REVENUECAT = "revenuecat"

@dataclass
class Subscription:
    id: str
    account_id: str
    provider: SubscriptionProvider
    provider_subscription_id: str
    tier_name: str
    status: SubscriptionStatus
    current_period_start: datetime
    current_period_end: datetime
    monthly_credits: Decimal
    created_at: datetime
    updated_at: datetime
    metadata: Optional[Dict] = None
    
    def is_active(self) -> bool:
        return self.status == SubscriptionStatus.ACTIVE
    
    def is_expired(self) -> bool:
        return datetime.utcnow() > self.current_period_end
    
    def days_until_renewal(self) -> int:
        delta = self.current_period_end - datetime.utcnow()
        return max(0, delta.days)






