from core.utils.logger import logger
from core.utils.config import config


class SignatureVerifier:
    def __init__(self):
        pass
    
    def _get_webhook_secret(self):
        """Get webhook secret from config dynamically."""
        return getattr(config, 'REVENUECAT_WEBHOOK_SECRET', None)
    
    def verify_authorization(self, authorization_header: str) -> bool:
        webhook_secret = self._get_webhook_secret()
        
        if not webhook_secret:
            logger.error(
                "[REVENUECAT] ❌ No webhook secret configured. "
                "Set REVENUECAT_WEBHOOK_SECRET to enable authorization verification."
            )
            return False
        
        if not authorization_header:
            logger.warning("[REVENUECAT] No Authorization header provided in webhook request")
            return False
        
        # RevenueCat sends Authorization header with the configured value
        # Remove "Bearer " prefix if present
        auth_value = authorization_header.replace('Bearer ', '').strip()
        
        is_valid = auth_value == webhook_secret
        
        if not is_valid:
            logger.warning(
                f"[REVENUECAT] ⚠️ Authorization verification failed. "
                f"Received: {auth_value[:16]}... (length: {len(auth_value)}), "
                f"Expected: {webhook_secret[:16]}... (length: {len(webhook_secret)}). "
                f"Config has secret: {bool(webhook_secret)}"
            )
        else:
            logger.debug("[REVENUECAT] ✅ Authorization verification successful")
        
        return is_valid

