from typing import Dict
from datetime import datetime, timezone
from fastapi import HTTPException # type: ignore
from core.services.supabase import DBConnection
from core.utils.logger import logger
from ..repositories import SubscriptionRepository


class ValidationService:
    @staticmethod
    async def validate_transfer_event(
        event: Dict,
        webhook_data: Dict
    ) -> tuple[str, str, float]:
        logger.warning(
            f"[REVENUECAT TRANSFER] 🚨 TRANSFER EVENT DETECTED - ALL AUTO-TRANSFERS DISABLED"
        )
        logger.info(
            f"[REVENUECAT TRANSFER] Full webhook data: {webhook_data}"
        )

        transferred_to = event.get('transferred_to', [])
        transferred_from = event.get('transferred_from', [])
        product_id = event.get('product_id')
        price = event.get('price', 0)
        
        new_app_user_id = transferred_to[0] if transferred_to else None
        
        transferred_from_valid = [
            user_id for user_id in transferred_from 
            if not user_id.startswith('$RCAnonymousID:')
        ]
        
        if not new_app_user_id:
            logger.error(f"[REVENUECAT TRANSFER] Missing new_app_user_id (transferred_to array is empty), skipping")
            raise ValueError("Missing new_app_user_id")
        
        if new_app_user_id.startswith('$RCAnonymousID:'):
            logger.info(f"[REVENUECAT TRANSFER] Transfer to anonymous user, skipping")
            raise ValueError("Transfer to anonymous user")
        
        db = DBConnection()
        client = await db.client
        
        logger.warning(
            f"[REVENUECAT TRANSFER] Transfer detected: {transferred_from} → {new_app_user_id}"
        )
        
        if transferred_from_valid:
            logger.warning(
                f"[REVENUECAT TRANSFER] 🔒 Real account transfer - validating emails"
            )
            
            new_account = await SubscriptionRepository.get_credit_account(client, new_app_user_id)
            new_email = new_account.get('email') if new_account else None
            
            is_same_user = False
            for old_user_id in transferred_from_valid:
                old_account = await SubscriptionRepository.get_credit_account(client, old_user_id)
                old_email = old_account.get('email') if old_account else None
                
                logger.info(
                    f"[REVENUECAT TRANSFER] Checking: "
                    f"from={old_user_id} (email={old_email}) → to={new_app_user_id} (email={new_email})"
                )
                
                if old_email and new_email and old_email.lower() == new_email.lower():
                    is_same_user = True
                    logger.info(f"[REVENUECAT TRANSFER] ✅ SAME USER - emails match: {old_email}")
                    break
            
            if not is_same_user:
                logger.error(
                    f"[REVENUECAT TRANSFER] ⛔ BLOCKED - Different users detected\n"
                    f"From: {transferred_from_valid} → To: {new_app_user_id}\n"
                    f"This is likely subscription sharing abuse"
                )
                
                await client.from_('audit_logs').insert({
                    'event_type': 'revenuecat_transfer_blocked_different_users',
                    'account_id': new_app_user_id,
                    'metadata': {
                        'transferred_from': transferred_from_valid,
                        'transferred_to': new_app_user_id,
                        'product_id': product_id,
                        'price': price,
                        'reason': 'different_user_emails_or_missing_accounts',
                        'webhook_data': webhook_data,
                        'timestamp': datetime.now(timezone.utc).isoformat(),
                        'security_note': 'Blocked to prevent subscription sharing between different users'
                    },
                    'created_at': datetime.now(timezone.utc).isoformat()
                }).execute()
                
                raise ValueError("Different users detected")
            
            logger.info(f"[REVENUECAT TRANSFER] ✅ ALLOWING - Same user restoring subscription")
            
            await client.from_('audit_logs').insert({
                'event_type': 'revenuecat_transfer_allowed_same_user',
                'account_id': new_app_user_id,
                'metadata': {
                    'transferred_from': transferred_from_valid,
                    'transferred_to': new_app_user_id,
                    'product_id': product_id,
                    'email': new_email,
                    'reason': 'same_user_email_match',
                    'webhook_data': webhook_data
                },
                'created_at': datetime.now(timezone.utc).isoformat()
            }).execute()
        else:
            logger.warning(
                f"[REVENUECAT TRANSFER] ⛔ BLOCKED - Anonymous transfer\n"
                f"User should purchase directly, not restore anonymous subscriptions"
            )
            
            await client.from_('audit_logs').insert({
                'event_type': 'revenuecat_transfer_blocked_anonymous',
                'account_id': new_app_user_id,
                'metadata': {
                    'transferred_from': transferred_from,
                    'transferred_to': new_app_user_id,
                    'product_id': product_id,
                    'reason': 'anonymous_transfer_blocked',
                    'webhook_data': webhook_data,
                    'security_note': 'Blocked anonymous transfers to prevent device sharing abuse'
                },
                'created_at': datetime.now(timezone.utc).isoformat()
            }).execute()
            
            raise ValueError("Anonymous transfer blocked")
        
        if not product_id:
            logger.warning(f"[REVENUECAT TRANSFER] Missing product_id, inferring from accounts")
            
            if transferred_from_valid:
                old_app_user_id = transferred_from_valid[0]
                old_account = await SubscriptionRepository.get_credit_account(client, old_app_user_id)
                if old_account and old_account.get('revenuecat_product_id'):
                    product_id = old_account['revenuecat_product_id']
                    logger.info(f"[REVENUECAT TRANSFER] Inferred product: {product_id}")
            
            if not product_id:
                logger.error(f"[REVENUECAT TRANSFER] Cannot determine product_id, aborting")
                raise ValueError("Cannot determine product_id")
        
        if price == 0 or price is None:
            from ..utils import ProductMapper
            tier_name, tier_info = ProductMapper.get_tier_info(product_id)
            if tier_info:
                price = float(tier_info.monthly_credits)
        
        logger.info(f"[REVENUECAT TRANSFER] ✅ Transfer validated: {transferred_from_valid} → {new_app_user_id}")
        
        return new_app_user_id, product_id, price

