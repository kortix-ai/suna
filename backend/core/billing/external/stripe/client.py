import asyncio
from typing import Any, Callable, Dict, Optional
from datetime import datetime, timezone, timedelta
from enum import Enum
from functools import wraps
import stripe
from core.utils.logger import logger
from core.services.supabase import DBConnection
from core.utils.config import config
from ..interfaces import CircuitBreakerInterface

stripe.api_key = config.STRIPE_SECRET_KEY

class CircuitState(Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"

class StripeCircuitBreaker(CircuitBreakerInterface):
    def __init__(
        self,
        circuit_name: str = "stripe_api",
        failure_threshold: int = 5,
        recovery_timeout: int = 60,
        expected_exception: type = stripe.StripeError
    ):
        self.circuit_name = circuit_name
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.expected_exception = expected_exception
        self.db = DBConnection()
        self._lock = asyncio.Lock()
    
    async def safe_call(self, func: Callable, *args, **kwargs) -> Any:
        """Execute Stripe API call with circuit breaker protection - FIXED"""
        async with self._lock:
            state_info = await self._get_circuit_state()
            
            if await self._should_allow_request(state_info):
                try:
                    result = await func(*args, **kwargs)
                    await self._record_success()
                    return result
                except self.expected_exception as e:
                    await self._record_failure(str(e))
                    raise
                except Exception as e:
                    logger.error(f"[CIRCUIT BREAKER] Unexpected error in {func.__name__}: {e}")
                    raise
            else:
                logger.warning(f"[CIRCUIT BREAKER] Request blocked - circuit is {state_info['state'].value}")
                raise Exception(f"Circuit breaker is {state_info['state'].value} - blocking request to Stripe API")
    
    async def get_status(self) -> Dict:
        """Get current circuit breaker status - FIXED"""
        state_info = await self._get_circuit_state()
        return {
            'circuit_name': self.circuit_name,
            'state': state_info['state'].value,
            'failure_count': state_info['failure_count'],
            'last_failure_time': state_info['last_failure_time'].isoformat() if state_info['last_failure_time'] else None,
            'failure_threshold': self.failure_threshold,
            'recovery_timeout': self.recovery_timeout,
            'status': '✅ Healthy' if state_info['state'] == CircuitState.CLOSED else f"🔴 {state_info['state'].value.upper()}"
        }
    
    async def _get_circuit_state(self) -> Dict:
        try:
            client = await self.db.client
            result = await client.from_('circuit_breaker_state').select('*').eq(
                'circuit_name', self.circuit_name
            ).execute()
            
            if result.data and len(result.data) > 0:
                state_data = result.data[0]
                
                last_failure_time = None
                if state_data.get('last_failure_time'):
                    last_failure_time = datetime.fromisoformat(state_data['last_failure_time'].replace('Z', '+00:00'))
                
                return {
                    'state': CircuitState(state_data['state']),
                    'failure_count': state_data['failure_count'],
                    'last_failure_time': last_failure_time
                }
            
            await self._initialize_circuit_state()
            return {
                'state': CircuitState.CLOSED,
                'failure_count': 0,
                'last_failure_time': None
            }
            
        except Exception as e:
            logger.error(f"[CIRCUIT BREAKER] Error reading state from DB: {e}, defaulting to CLOSED")
            return {
                'state': CircuitState.CLOSED,
                'failure_count': 0,
                'last_failure_time': None
            }
    
    async def _should_allow_request(self, state_info: Dict) -> bool:
        state = state_info['state']
        
        if state == CircuitState.CLOSED:
            return True
        elif state == CircuitState.OPEN:
            if state_info['last_failure_time']:
                time_since_failure = datetime.now(timezone.utc) - state_info['last_failure_time']
                if time_since_failure.total_seconds() >= self.recovery_timeout:
                    await self._transition_to_half_open()
                    return True
            return False
        elif state == CircuitState.HALF_OPEN:
            return True
        
        return False
    
    async def _record_success(self):
        try:
            client = await self.db.client
            await client.from_('circuit_breaker_state').upsert({
                'circuit_name': self.circuit_name,
                'state': CircuitState.CLOSED.value,
                'failure_count': 0,
                'last_failure_time': None,
                'updated_at': datetime.now(timezone.utc).isoformat()
            }).execute()
            logger.debug(f"[CIRCUIT BREAKER] Recorded success for {self.circuit_name}")
        except Exception as e:
            logger.error(f"[CIRCUIT BREAKER] Failed to record success: {e}")
    
    async def _record_failure(self, error_message: str):
        try:
            client = await self.db.client
            state_info = await self._get_circuit_state()
            new_failure_count = state_info['failure_count'] + 1
            
            new_state = CircuitState.OPEN if new_failure_count >= self.failure_threshold else CircuitState.CLOSED
            
            await client.from_('circuit_breaker_state').upsert({
                'circuit_name': self.circuit_name,
                'state': new_state.value,
                'failure_count': new_failure_count,
                'last_failure_time': datetime.now(timezone.utc).isoformat(),
                'updated_at': datetime.now(timezone.utc).isoformat()
            }).execute()
            
            if new_state == CircuitState.OPEN:
                logger.warning(f"[CIRCUIT BREAKER] Circuit opened due to {new_failure_count} failures: {error_message}")
            else:
                logger.debug(f"[CIRCUIT BREAKER] Recorded failure #{new_failure_count} for {self.circuit_name}")
                
        except Exception as e:
            logger.error(f"[CIRCUIT BREAKER] Failed to record failure: {e}")
    
    async def _transition_to_half_open(self):
        try:
            client = await self.db.client
            await client.from_('circuit_breaker_state').upsert({
                'circuit_name': self.circuit_name,
                'state': CircuitState.HALF_OPEN.value,
                'failure_count': 0
            }).execute()
        except Exception as e:
            logger.error(f"[CIRCUIT BREAKER] Failed to transition to half-open: {e}")
    
    async def _initialize_circuit_state(self):
        try:
            client = await self.db.client
            await client.from_('circuit_breaker_state').insert({
                'circuit_name': self.circuit_name,
                'state': CircuitState.CLOSED.value,
                'failure_count': 0,
                'last_failure_time': None,
                'updated_at': datetime.now(timezone.utc).isoformat(),
                'created_at': datetime.now(timezone.utc).isoformat()
            }).execute()
            logger.info(f"[CIRCUIT BREAKER] Initialized circuit state for {self.circuit_name}")
        except Exception as e:
            logger.error(f"[CIRCUIT BREAKER] Failed to initialize state: {e}")

class StripeAPIWrapper:
    _circuit_breaker = StripeCircuitBreaker()
    
    @classmethod
    async def safe_stripe_call(cls, func: Callable, *args, **kwargs) -> Any:
        return await cls._circuit_breaker.safe_call(func, *args, **kwargs)
    
    @classmethod
    async def get_circuit_status(cls) -> Dict:
        return await cls._circuit_breaker.get_status()
    
    @classmethod
    async def retrieve_customer(cls, customer_id: str) -> stripe.Customer:
        return await cls.safe_stripe_call(stripe.Customer.retrieve_async, customer_id)
    
    @classmethod
    async def create_customer(cls, **kwargs) -> stripe.Customer:
        return await cls.safe_stripe_call(stripe.Customer.create_async, **kwargs)
    
    @classmethod
    async def retrieve_subscription(cls, subscription_id: str) -> stripe.Subscription:
        return await cls.safe_stripe_call(stripe.Subscription.retrieve_async, subscription_id)
    
    @classmethod
    async def retrieve_payment_intent(cls, payment_intent_id: str) -> stripe.PaymentIntent:
        return await cls.safe_stripe_call(stripe.PaymentIntent.retrieve_async, payment_intent_id)
    
    @classmethod
    async def cancel_subscription(cls, subscription_id: str, cancel_immediately: bool = True) -> stripe.Subscription:
        if cancel_immediately:
            return await cls.safe_stripe_call(
                stripe.Subscription.cancel_async, 
                subscription_id,
                prorate=True
            )
        else:
            return await cls.safe_stripe_call(
                stripe.Subscription.modify_async,
                subscription_id,
                cancel_at_period_end=True
            )
    
    @classmethod
    async def modify_subscription(cls, subscription_id: str, **kwargs) -> stripe.Subscription:
        return await cls.safe_stripe_call(
            stripe.Subscription.modify_async,
            subscription_id,
            **kwargs
        )
    
    @classmethod
    async def create_checkout_session(cls, **kwargs) -> stripe.checkout.Session:
        return await cls.safe_stripe_call(stripe.checkout.Session.create_async, **kwargs)
    
    @classmethod 
    async def list_invoices(cls, **kwargs) -> stripe.ListObject:
        return await cls.safe_stripe_call(stripe.Invoice.list_async, **kwargs)
    
    @classmethod
    async def retrieve_price(cls, price_id: str) -> stripe.Price:
        return await cls.safe_stripe_call(stripe.Price.retrieve_async, price_id)
    
    @classmethod
    async def list_subscriptions(cls, **kwargs) -> stripe.ListObject:
        return await cls.safe_stripe_call(stripe.Subscription.list_async, **kwargs)

stripe_circuit_breaker = StripeCircuitBreaker()
