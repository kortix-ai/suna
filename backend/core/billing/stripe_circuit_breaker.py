import asyncio
from typing import Any, Callable, Dict, Optional
from datetime import datetime, timezone, timedelta
from enum import Enum
from functools import wraps
import stripe
from core.utils.logger import logger
from core.services.supabase import DBConnection


class CircuitState(Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


class CircuitBreaker:
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
    
    async def _initialize_circuit_state(self):
        try:
            client = await self.db.client
            await client.from_('circuit_breaker_state').upsert({
                'circuit_name': self.circuit_name,
                'state': CircuitState.CLOSED.value,
                'failure_count': 0,
                'last_failure_time': None,
                'updated_at': datetime.now(timezone.utc).isoformat()
            }, on_conflict='circuit_name').execute()
        except Exception as e:
            logger.error(f"[CIRCUIT BREAKER] Error initializing state: {e}")
    
    async def _update_circuit_state(self, state: CircuitState, failure_count: int, last_failure_time: Optional[datetime] = None):
        try:
            client = await self.db.client
            await client.from_('circuit_breaker_state').upsert({
                'circuit_name': self.circuit_name,
                'state': state.value,
                'failure_count': failure_count,
                'last_failure_time': last_failure_time.isoformat() if last_failure_time else None,
                'updated_at': datetime.now(timezone.utc).isoformat()
            }, on_conflict='circuit_name').execute()
        except Exception as e:
            logger.error(f"[CIRCUIT BREAKER] Error updating state: {e}")
    
    async def call(self, func: Callable, *args, **kwargs) -> Any:
        async with self._lock:
            circuit_state = await self._get_circuit_state()
            state = circuit_state['state']
            last_failure_time = circuit_state['last_failure_time']
            
            if state == CircuitState.OPEN:
                if self._should_attempt_reset(last_failure_time):
                    await self._update_circuit_state(CircuitState.HALF_OPEN, circuit_state['failure_count'], last_failure_time)
                    logger.info(f"[CIRCUIT BREAKER] Moving to HALF_OPEN state for {self.circuit_name}")
                else:
                    time_remaining = self.recovery_timeout - (datetime.now(timezone.utc) - last_failure_time).total_seconds()
                    logger.warning(f"[CIRCUIT BREAKER] Circuit {self.circuit_name} is OPEN. Retry in {time_remaining:.0f}s")
                    raise Exception(f"Circuit breaker is OPEN. Service unavailable. Will retry after {int(time_remaining)} seconds")
        
        try:
            result = await self._execute(func, *args, **kwargs)
            await self._on_success()
            return result
        except self.expected_exception as e:
            await self._on_failure()
            raise e
    
    async def _execute(self, func: Callable, *args, **kwargs) -> Any:
        if asyncio.iscoroutinefunction(func):
            return await func(*args, **kwargs)
        else:
            return func(*args, **kwargs)
    
    async def _on_success(self):
        async with self._lock:
            circuit_state = await self._get_circuit_state()
            
            if circuit_state['state'] == CircuitState.HALF_OPEN:
                await self._update_circuit_state(CircuitState.CLOSED, 0, None)
                logger.info(f"[CIRCUIT BREAKER] Circuit {self.circuit_name} closed after successful recovery")
            elif circuit_state['failure_count'] > 0:
                await self._update_circuit_state(CircuitState.CLOSED, 0, None)
    
    async def _on_failure(self):
        async with self._lock:
            circuit_state = await self._get_circuit_state()
            failure_count = circuit_state['failure_count'] + 1
            now = datetime.now(timezone.utc)
            
            if failure_count >= self.failure_threshold:
                await self._update_circuit_state(CircuitState.OPEN, failure_count, now)
                logger.error(f"[CIRCUIT BREAKER] Circuit {self.circuit_name} OPENED after {failure_count} failures across all instances!")
            else:
                await self._update_circuit_state(circuit_state['state'], failure_count, now)
                logger.warning(f"[CIRCUIT BREAKER] Failure {failure_count}/{self.failure_threshold} for {self.circuit_name}")
    
    def _should_attempt_reset(self, last_failure_time: Optional[datetime]) -> bool:
        if not last_failure_time:
            return True
        
        time_since_failure = (datetime.now(timezone.utc) - last_failure_time).total_seconds()
        return time_since_failure >= self.recovery_timeout
    
    async def get_status(self) -> Dict:
        circuit_state = await self._get_circuit_state()
        return {
            'circuit_name': self.circuit_name,
            'state': circuit_state['state'].value,
            'failure_count': circuit_state['failure_count'],
            'threshold': self.failure_threshold,
            'last_failure': circuit_state['last_failure_time'].isoformat() if circuit_state['last_failure_time'] else None,
            'recovery_timeout': self.recovery_timeout
        }


stripe_circuit_breaker = CircuitBreaker(
    circuit_name="stripe_api",
    failure_threshold=5,
    recovery_timeout=60,
    expected_exception=stripe.error.StripeError
)


def with_circuit_breaker(func):
    @wraps(func)
    async def wrapper(*args, **kwargs):
        try:
            return await stripe_circuit_breaker.call(func, *args, **kwargs)
        except Exception as e:
            logger.error(f"[CIRCUIT BREAKER] Error in {func.__name__}: {e}")
            raise
    
    return wrapper


class StripeAPIWrapper:
    @staticmethod
    @with_circuit_breaker
    async def create_subscription(customer_id: str, price_id: str, **kwargs) -> stripe.Subscription:
        return await stripe.Subscription.create_async(
            customer=customer_id,
            items=[{'price': price_id}],
            **kwargs
        )
    
    @staticmethod
    @with_circuit_breaker
    async def retrieve_subscription(subscription_id: str) -> stripe.Subscription:
        return await stripe.Subscription.retrieve_async(subscription_id)
    
    @staticmethod
    @with_circuit_breaker
    async def modify_subscription(subscription_id: str, **kwargs) -> stripe.Subscription:
        return await stripe.Subscription.modify_async(subscription_id, **kwargs)
    
    @staticmethod
    @with_circuit_breaker
    async def cancel_subscription(subscription_id: str, **kwargs) -> stripe.Subscription:
        return await stripe.Subscription.cancel_async(subscription_id, **kwargs)
    
    @staticmethod
    @with_circuit_breaker
    async def create_checkout_session(**kwargs) -> stripe.checkout.Session:
        return await stripe.checkout.Session.create_async(**kwargs)
    
    @staticmethod
    @with_circuit_breaker
    async def retrieve_payment_intent(payment_intent_id: str) -> stripe.PaymentIntent:
        return await stripe.PaymentIntent.retrieve_async(payment_intent_id)
    
    @staticmethod
    @with_circuit_breaker
    async def upcoming_invoice(customer: str, **kwargs) -> stripe.Invoice:
        return await stripe.Invoice.upcoming_async(customer=customer, **kwargs)
    
    @staticmethod
    @with_circuit_breaker
    async def list_invoices(**kwargs) -> stripe.ListObject:
        return stripe.Invoice.list(**kwargs)
    
    @staticmethod
    @with_circuit_breaker
    async def retrieve_price(price_id: str) -> stripe.Price:
        return await stripe.Price.retrieve_async(price_id)
    
    @staticmethod
    async def safe_stripe_call(func: Callable, *args, max_retries: int = 3, **kwargs) -> Any:
        for attempt in range(max_retries):
            try:
                return await stripe_circuit_breaker.call(func, *args, **kwargs)
            except stripe.error.RateLimitError as e:
                wait_time = min(2 ** attempt, 10)
                logger.warning(f"[STRIPE API] Rate limited, retrying in {wait_time}s (attempt {attempt + 1}/{max_retries})")
                await asyncio.sleep(wait_time)
                if attempt == max_retries - 1:
                    raise
            except stripe.error.APIConnectionError as e:
                wait_time = min(2 ** attempt, 10)
                logger.warning(f"[STRIPE API] Connection error, retrying in {wait_time}s (attempt {attempt + 1}/{max_retries})")
                await asyncio.sleep(wait_time)
                if attempt == max_retries - 1:
                    raise
            except stripe.error.StripeError as e:
                logger.error(f"[STRIPE API] Stripe error: {e}")
                raise
        
        raise Exception(f"Max retries ({max_retries}) exceeded for Stripe API call")
