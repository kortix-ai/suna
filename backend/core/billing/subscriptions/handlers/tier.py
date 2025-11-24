from typing import Dict, List
from core.services.supabase import DBConnection
from core.utils.cache import Cache
from core.utils.logger import logger
from core.billing.shared.config import TIERS, TRIAL_TIER

class TierHandler:
    @staticmethod
    async def get_user_subscription_tier(account_id: str, skip_cache: bool = False) -> Dict:
        cache_key = f"subscription_tier:{account_id}"
        
        if not skip_cache:
            cached = await Cache.get(cache_key)
            if cached:
                return cached
        
        db = DBConnection()
        client = await db.client

        credit_result = await client.from_('credit_accounts')\
            .select('tier, trial_status')\
            .eq('account_id', account_id)\
            .execute()
        
        tier_name = 'none'
        trial_status = None
        
        if credit_result.data and len(credit_result.data) > 0:
            tier_name = credit_result.data[0].get('tier', 'none')
            trial_status = credit_result.data[0].get('trial_status')
        
        if trial_status == 'active' and tier_name == 'none':
            tier_name = TRIAL_TIER
            logger.info(f"[TIER] Trial active but tier=none for {account_id}, using TRIAL_TIER: {TRIAL_TIER}")
        
        tier_obj = TIERS.get(tier_name, TIERS['none'])
        tier_info = {
            'name': tier_obj.name,
            'display_name': tier_obj.display_name,
            'credits': float(tier_obj.monthly_credits),
            'can_purchase_credits': tier_obj.can_purchase_credits,
            'models': tier_obj.models,
            'project_limit': tier_obj.project_limit,
            'thread_limit': tier_obj.thread_limit,
            'concurrent_runs': tier_obj.concurrent_runs,
            'custom_workers_limit': tier_obj.custom_workers_limit,
            'scheduled_triggers_limit': tier_obj.scheduled_triggers_limit,
            'app_triggers_limit': tier_obj.app_triggers_limit,
            'agent_limit': tier_obj.custom_workers_limit,
            'is_trial': trial_status == 'active'
        }
        
        await Cache.set(cache_key, tier_info, ttl=60)
        return tier_info

    @staticmethod
    async def get_allowed_models_for_user(user_id: str, client=None) -> List[str]:
        try:
            from core.ai_models import model_manager
            from core.billing.shared.config import is_model_allowed

            tier_info = await TierHandler.get_user_subscription_tier(user_id)
            tier_name = tier_info['name']
            
            logger.debug(f"[ALLOWED_MODELS] User {user_id} tier: {tier_name}")

            if tier_info.get('models'):
                all_models = model_manager.list_available_models(include_disabled=False)
                allowed_model_ids = []
                
                for model_data in all_models:
                    model_id = model_data["id"]
                    if is_model_allowed(tier_name, model_id):
                        allowed_model_ids.append(model_id)
                
                logger.debug(f"[ALLOWED_MODELS] User {user_id} has access to {len(allowed_model_ids)} models: {[m for m in allowed_model_ids]}")
                return allowed_model_ids
            
            else:
                logger.debug(f"[ALLOWED_MODELS] User {user_id} has no model access (tier: {tier_name})")
                return []
                
        except Exception as e:
            logger.error(f"[ALLOWED_MODELS] Error getting allowed models for user {user_id}: {e}")
            return []
