from abc import ABC, abstractmethod
from typing import Dict, Optional, Any, Tuple
from decimal import Decimal
from fastapi import Request

class PaymentProviderInterface(ABC):
    
    @abstractmethod
    async def create_customer(self, account_id: str, email: str) -> str:
        pass
    
    @abstractmethod
    async def create_checkout_session(self, customer_id: str, price_id: str, **kwargs) -> Dict:
        pass
    
    @abstractmethod
    async def process_webhook(self, request: Request) -> Dict:
        pass

class CircuitBreakerInterface(ABC):
    
    @abstractmethod
    async def safe_call(self, func, *args, **kwargs) -> Any:
        pass
    
    @abstractmethod
    async def get_status(self) -> Dict:
        pass

class WebhookProcessorInterface(ABC):
    
    @abstractmethod
    async def verify_webhook(self, request: Request) -> bool:
        pass
    
    @abstractmethod
    async def process_event(self, event: Dict) -> Dict:
        pass

class IdempotencyManagerInterface(ABC):
    
    @abstractmethod
    def generate_key(self, operation: str, account_id: str, **params) -> str:
        pass
