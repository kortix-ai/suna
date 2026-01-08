from typing import Dict, List, Optional
from decimal import Decimal
from datetime import datetime, timezone, timedelta
import stripe
from core.utils.logger import logger
from core.utils.cache import Cache
from ..credits.manager import credit_manager
from ..shared.config import get_tier_by_price_id
from ..external.stripe import StripeAPIWrapper
from .interfaces import ReconciliationManagerInterface
from core.utils.config import config
from core.billing import repo as billing_repo

class ReconciliationService(ReconciliationManagerInterface):
    def __init__(self):
        self.stripe = stripe
        stripe.api_key = config.STRIPE_SECRET_KEY
    
    async def reconcile_failed_payments(self) -> Dict:
        results = {
            'checked': 0,
            'fixed': 0,
            'failed': 0,
            'errors': []
        }
        
        try:
            since = datetime.now(timezone.utc) - timedelta(hours=24)
            
            failed_purchases = await billing_repo.get_pending_credit_purchases(since.isoformat())
            
            if not failed_purchases:
                logger.info("[RECONCILIATION] No pending credit purchases found")
                return results
            
            results['checked'] = len(failed_purchases)
            
            for purchase in failed_purchases:
                try:
                    payment_intent = await StripeAPIWrapper.retrieve_payment_intent(
                        purchase['stripe_payment_intent_id']
                    )
                    
                    if payment_intent.status == 'succeeded':
                        logger.warning(f"[RECONCILIATION] Found successful payment without credits: {purchase['id']}")
                        
                        ledger_exists = await billing_repo.check_ledger_by_payment_intent(
                            purchase['stripe_payment_intent_id']
                        )
                        
                        if not ledger_exists:
                            result = await credit_manager.add_credits(
                                account_id=purchase['account_id'],
                                amount=Decimal(str(purchase['amount_dollars'])),
                                is_expiring=False,
                                description=f"Reconciled purchase: ${purchase['amount_dollars']} credits",
                                type='purchase',
                                stripe_event_id=f"reconciliation_{purchase['id']}"
                            )
                            
                            if result.get('success'):
                                await billing_repo.update_purchase_by_id(
                                    purchase_id=purchase['id'],
                                    status='completed',
                                    reconciled_at=datetime.now(timezone.utc).isoformat()
                                )
                                
                                results['fixed'] += 1
                                logger.info(f"[RECONCILIATION] Fixed missing credits for {purchase['account_id']}")
                            else:
                                results['failed'] += 1
                                results['errors'].append(f"Failed to add credits for {purchase['id']}")
                        else:
                            await billing_repo.update_purchase_by_id(
                                purchase_id=purchase['id'],
                                status='completed',
                                note='Credits already added'
                            )
                            
                            logger.info(f"[RECONCILIATION] Purchase {purchase['id']} already processed")
                    
                    elif payment_intent.status == 'canceled' or payment_intent.status == 'failed':
                        await billing_repo.update_purchase_by_id(
                            purchase_id=purchase['id'],
                            status='failed',
                            error_message=f'Payment {payment_intent.status}'
                        )
                        
                        logger.info(f"[RECONCILIATION] Marked purchase {purchase['id']} as failed")
                
                except Exception as e:
                    logger.error(f"[RECONCILIATION] Error processing purchase {purchase['id']}: {e}")
                    results['errors'].append(str(e))
                    results['failed'] += 1
            
        except Exception as e:
            logger.error(f"[RECONCILIATION] Fatal error: {e}")
            results['errors'].append(f"Fatal error: {str(e)}")
        
        logger.info(f"[RECONCILIATION] Complete: checked={results['checked']}, fixed={results['fixed']}, failed={results['failed']}")
        return results
    
    async def verify_balance_consistency(self) -> Dict:
        results = {
            'checked': 0,
            'fixed': 0,
            'discrepancies_found': []
        }
        
        try:
            accounts = await billing_repo.get_all_credit_accounts_balances()
            
            results['checked'] = len(accounts) if accounts else 0
            
            for account in accounts or []:
                expected = Decimal(str(account['expiring_credits'])) + Decimal(str(account['non_expiring_credits']))
                actual = Decimal(str(account['balance']))
                
                if abs(expected - actual) > Decimal('0.01'):
                    logger.warning(f"[BALANCE CHECK] Discrepancy found for {account['account_id']}: "
                                 f"expected=${expected:.2f}, actual=${actual:.2f}")
                    
                    results['discrepancies_found'].append({
                        'account_id': account['account_id'],
                        'expected': float(expected),
                        'actual': float(actual),
                        'difference': float(expected - actual)
                    })
                    
                    result = await billing_repo.call_reconcile_credit_balance(account['account_id'])
                    
                    if result and result.get('was_fixed'):
                        results['fixed'] += 1
                        logger.info(f"[BALANCE CHECK] Fixed balance for {account['account_id']}")
        
        except Exception as e:
            logger.error(f"[BALANCE CHECK] Error: {e}")
        
        return results
    
    async def detect_double_charges(self) -> Dict:
        results = {
            'duplicates_found': [],
            'total_checked': 0
        }
        
        try:
            since = datetime.now(timezone.utc) - timedelta(days=7)
            
            ledger_entries = await billing_repo.get_recent_ledger_entries_for_duplicate_check(since.isoformat())
            
            results['total_checked'] = len(ledger_entries) if ledger_entries else 0
            
            seen = {}
            for entry in ledger_entries or []:
                key = f"{entry['account_id']}_{entry['amount']}_{entry['description']}"
                
                if key in seen:
                    time_diff = abs((datetime.fromisoformat(entry['created_at'].replace('Z', '+00:00')) - 
                                   datetime.fromisoformat(seen[key]['created_at'].replace('Z', '+00:00'))).total_seconds())
                    
                    if time_diff < 60:
                        results['duplicates_found'].append({
                            'account_id': entry['account_id'],
                            'amount': entry['amount'],
                            'description': entry['description'],
                            'entries': [entry['id'], seen[key]['id']],
                            'time_difference_seconds': time_diff
                        })
                        logger.warning(f"[DUPLICATE CHECK] Potential duplicate found for {entry['account_id']}: "
                                     f"${entry['amount']} - {entry['description']}")
                else:
                    seen[key] = entry
        
        except Exception as e:
            logger.error(f"[DUPLICATE CHECK] Error: {e}")
        
        return results
    
    async def cleanup_expired_credits(self) -> Dict:
        results = {
            'accounts_cleaned': 0,
            'credits_removed': 0.0
        }
        
        try:
            result = await billing_repo.call_cleanup_expired_credits()
            
            if result:
                for row in result:
                    results['accounts_cleaned'] += 1
                    results['credits_removed'] += float(row.get('credits_removed', 0))
                    logger.info(f"[CLEANUP] Removed ${row['credits_removed']:.2f} expired credits from {row['account_id']}")
        
        except Exception as e:
            logger.error(f"[CLEANUP] Error: {e}")
        
        return results
    
    async def retry_failed_payment(self, payment_id: str) -> Dict:
        try:
            payment = await billing_repo.get_credit_purchase_by_id(payment_id)
            
            if not payment:
                return {'success': False, 'error': 'Payment not found'}
            
            if payment['status'] != 'pending':
                return {'success': False, 'error': f'Payment status is {payment["status"]}, cannot retry'}
            
            payment_intent = await StripeAPIWrapper.retrieve_payment_intent(payment['stripe_payment_intent_id'])
            
            if payment_intent.status == 'succeeded':
                result = await credit_manager.add_credits(
                    account_id=payment['account_id'],
                    amount=Decimal(str(payment['amount_dollars'])),
                    is_expiring=False,
                    description=f"Reconciled purchase: ${payment['amount_dollars']} credits",
                    type='purchase',
                    stripe_event_id=f"retry_{payment_id}"
                )
                
                await billing_repo.update_purchase_by_id(
                    purchase_id=payment_id,
                    status='completed',
                    completed_at=datetime.now(timezone.utc).isoformat()
                )
                
                logger.info(f"[RETRY] Successfully reconciled payment {payment_id}")
                return {'success': True, 'action': 'reconciled', 'credits_added': float(payment['amount_dollars'])}
            
            else:
                logger.info(f"[RETRY] Payment {payment_id} still pending in Stripe: {payment_intent.status}")
                return {'success': False, 'error': f'Stripe payment status: {payment_intent.status}'}
                
        except Exception as e:
            logger.error(f"[RETRY] Error retrying payment {payment_id}: {e}")
            return {'success': False, 'error': str(e)}


reconciliation_service = ReconciliationService()
