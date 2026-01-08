from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Optional

@dataclass
class CreditAccount:
    id: str
    account_id: str
    balance: Decimal
    expiring_credits: Decimal
    non_expiring_credits: Decimal
    tier: str
    created_at: datetime
    updated_at: datetime
    next_credit_grant: Optional[datetime] = None
    billing_cycle_anchor: Optional[datetime] = None
    
    def total_credits(self) -> Decimal:
        return self.expiring_credits + self.non_expiring_credits
    
    def can_run_with_cost(self, cost: Decimal) -> bool:
        return self.balance >= cost
    
    def is_free_tier(self) -> bool:
        return self.tier == "free"






