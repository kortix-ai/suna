import hashlib
from datetime import datetime, timezone
from typing import Optional
from ..interfaces import IdempotencyManagerInterface

class StripeIdempotencyManager(IdempotencyManagerInterface):
    def generate_key(
        self,
        operation: str,
        account_id: str,
        *args,
        time_bucket_minutes: int = 5,
        **kwargs
    ) -> str:
        timestamp_bucket = int(datetime.now(timezone.utc).timestamp() // (time_bucket_minutes * 60))
        sorted_kwargs = sorted(kwargs.items())
        
        components = [
            operation,
            account_id,
            *[str(arg) for arg in args],
            *[f"{k}={v}" for k, v in sorted_kwargs],
            str(timestamp_bucket),
            str(int(datetime.now(timezone.utc).timestamp() * 1000) % 10000)  # Add milliseconds for uniqueness
        ]
        
        idempotency_base = "_".join(components)
        return hashlib.sha256(idempotency_base.encode()).hexdigest()[:40]

    def generate_checkout_key(
        self,
        account_id: str,
        price_id: str,
        commitment_type: Optional[str] = None
    ) -> str:
        return self.generate_key(
            'checkout',
            account_id,
            price_id,
            commitment_type=commitment_type or 'none'
        )

    def generate_trial_key(self, account_id: str, trial_days: int) -> str:
        return self.generate_key(
            'trial_checkout',
            account_id,
            trial_days
        )

    def generate_credit_purchase_key(
        self,
        account_id: str,
        amount: float
    ) -> str:
        return self.generate_key(
            'credit_purchase',
            account_id,
            amount
        )

    def generate_subscription_modify_key(
        self,
        subscription_id: str,
        new_price_id: str
    ) -> str:
        return self.generate_key(
            'modify_subscription',
            subscription_id,
            new_price_id
        )

    def generate_subscription_cancel_key(
        self,
        subscription_id: str,
        cancel_type: str = 'at_period_end'
    ) -> str:
        return self.generate_key(
            'cancel_subscription',
            subscription_id,
            cancel_type
        )

    def generate_refund_key(
        self,
        payment_intent_id: str,
        amount: Optional[float] = None
    ) -> str:
        return self.generate_key(
            'refund',
            payment_intent_id,
            amount or 'full'
        )

stripe_idempotency_manager = StripeIdempotencyManager()

def generate_idempotency_key(operation: str, account_id: str, *args, **kwargs) -> str:
    return stripe_idempotency_manager.generate_key(operation, account_id, *args, **kwargs)

def generate_checkout_idempotency_key(account_id: str, price_id: str, commitment_type: Optional[str] = None) -> str:
    return stripe_idempotency_manager.generate_checkout_key(account_id, price_id, commitment_type)

def generate_trial_idempotency_key(account_id: str, trial_days: int) -> str:
    return stripe_idempotency_manager.generate_trial_key(account_id, trial_days)

def generate_credit_purchase_idempotency_key(account_id: str, amount: float) -> str:
    return stripe_idempotency_manager.generate_credit_purchase_key(account_id, amount)

def generate_subscription_modify_idempotency_key(subscription_id: str, new_price_id: str) -> str:
    return stripe_idempotency_manager.generate_subscription_modify_key(subscription_id, new_price_id)

def generate_subscription_cancel_idempotency_key(subscription_id: str, cancel_type: str = 'at_period_end') -> str:
    return stripe_idempotency_manager.generate_subscription_cancel_key(subscription_id, cancel_type)

def generate_refund_idempotency_key(payment_intent_id: str, amount: Optional[float] = None) -> str:
    return stripe_idempotency_manager.generate_refund_key(payment_intent_id, amount)
