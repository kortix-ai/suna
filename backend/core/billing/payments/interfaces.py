from abc import ABC, abstractmethod
from typing import Dict, Optional
from decimal import Decimal

class PaymentProcessorInterface(ABC):
    @abstractmethod
    async def create_checkout_session(
        self, 
        account_id: str, 
        amount: Decimal, 
        success_url: str, 
        cancel_url: str
    ) -> Dict:
        pass
    
    @abstractmethod
    async def validate_payment_eligibility(self, account_id: str) -> bool:
        pass

class ReconciliationManagerInterface(ABC):
    @abstractmethod
    async def reconcile_failed_payments(self) -> Dict:
        pass
    
    @abstractmethod
    async def retry_failed_payment(self, payment_id: str) -> Dict:
        pass
