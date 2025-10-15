import asyncio
from typing import Any, Callable, Dict, Optional
from datetime import datetime, timezone, timedelta
from enum import Enum
from functools import wraps
import stripe
from core.utils.logger import logger


class CircuitState(Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


class CircuitBreaker:
    def __init__(
        self,
        failure_threshold: int = 5,
        recovery_timeout: int = 60,
        expected_exception: type = stripe.error.StripeError
    ):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.expected_exception = expected_exception
        self.failure_count = 0
        self.last_failure_time: Optional[datetime] = None
        self.state = CircuitState.CLOSED
        self._lock = asyncio.Lock()
    
    async def call(self, func: Callable, *args, **kwargs) -> Any:
        async with self._lock:
            if self.state == CircuitState.OPEN:
                if self._should_attempt_reset():
                    self.state = CircuitState.HALF_OPEN
                else:
                    raise Exception(f"Circuit breaker is OPEN. Service unavailable. Will retry after {self.recovery_timeout} seconds")
        
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
            self.failure_count = 0
            if self.state == CircuitState.HALF_OPEN:
                self.state = CircuitState.CLOSED
                logger.info("[CIRCUIT BREAKER] Circuit closed after successful recovery")
    
    async def _on_failure(self):
        async with self._lock:
            self.failure_count += 1
            self.last_failure_time = datetime.now(timezone.utc)
            
            if self.failure_count >= self.failure_threshold:
                self.state = CircuitState.OPEN
                logger.warning(f"[CIRCUIT BREAKER] Circuit opened after {self.failure_count} failures")
    
    def _should_attempt_reset(self) -> bool:
        if not self.last_failure_time:
            return True
        
        time_since_failure = (datetime.now(timezone.utc) - self.last_failure_time).total_seconds()
        return time_since_failure >= self.recovery_timeout
    
    def get_status(self) -> Dict:
        return {
            'state': self.state.value,
            'failure_count': self.failure_count,
            'threshold': self.failure_threshold,
            'last_failure': self.last_failure_time.isoformat() if self.last_failure_time else None
        }


stripe_circuit_breaker = CircuitBreaker(
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
