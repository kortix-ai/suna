class BillingError(Exception):
    pass

class InsufficientCreditsError(BillingError):
    def __init__(self, balance: float, required: float = None, message: str = None):
        self.balance = balance
        self.required = required
        if message is None:
            if required:
                message = f"Insufficient credits. Balance: {int(balance * 100)} credits, Required: {int(required * 100)} credits"
            else:
                message = f"Insufficient credits. Balance: {int(balance * 100)} credits"
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
