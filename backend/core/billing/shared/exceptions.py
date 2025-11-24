class BillingError(Exception):
    pass

class InsufficientCreditsError(BillingError):
    def __init__(self, balance: float, required: float = None, message: str = None):
        self.balance = balance
        self.required = required
        if message is None:
            if required:
                message = f"Insufficient credits. Balance: ${balance:.2f}, Required: ${required:.2f}"
            else:
                message = f"Insufficient credits. Balance: ${balance:.2f}"
        super().__init__(message)

class SubscriptionError(BillingError):
    pass

class PaymentError(BillingError):
    pass

class WebhookError(BillingError):
    pass

class ConfigurationError(BillingError):
    pass

class TrialError(BillingError):
    pass

class TierError(BillingError):
    pass

class CreditError(BillingError):
    pass
