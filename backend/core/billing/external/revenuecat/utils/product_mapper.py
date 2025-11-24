from typing import Tuple, Optional
from decimal import Decimal
from core.utils.logger import logger
from ....shared.config import get_tier_by_name


class ProductMapper:
    PRODUCT_MAPPING = {
        'kortix_plus_monthly': 'tier_2_20',
        'kortix_plus_yearly': 'tier_2_20',

        'kortix_pro_monthly': 'tier_6_50',
        'kortix_pro_yearly': 'tier_6_50',
        
        'kortix_ultra_monthly': 'tier_25_200',
        'kortix_ultra_yearly': 'tier_25_200',
    }
    
    VALID_PRODUCT_IDS = set(PRODUCT_MAPPING.keys())
    
    @classmethod
    def validate_product_id(cls, product_id: str) -> bool:
        if not product_id:
            return False
        
        if product_id.lower() not in cls.VALID_PRODUCT_IDS:
            logger.error(
                f"[REVENUECAT] ❌ INVALID PRODUCT ID RECEIVED: '{product_id}'\n"
                f"Valid product IDs: {cls.VALID_PRODUCT_IDS}\n"
                f"This indicates a configuration mismatch between app and backend!"
            )
            return False
        return True
    
    @classmethod
    def map_product_to_tier(cls, product_id: str) -> str:
        mapped_tier = cls.PRODUCT_MAPPING.get(product_id.lower())
        if mapped_tier:
            return mapped_tier
        
        logger.critical(
            f"[REVENUECAT] ❌ Unknown product ID: {product_id} - Raising error to trigger retry/alert\n"
            f"THIS MUST BE FIXED IN CONFIGURATION"
        )
        raise ValueError(f"Unknown product ID: {product_id}")
    
    @classmethod
    def get_tier_info(cls, product_id: str) -> Tuple[str, Optional[object]]:
        tier_name = cls.map_product_to_tier(product_id)
        tier_info = get_tier_by_name(tier_name)
        return tier_name, tier_info
    
    @classmethod
    def get_period_type(cls, product_id: str) -> str:
        if not product_id:
            return 'monthly'
        
        product_id_lower = product_id.lower()
        
        if 'commitment' in product_id_lower:
            return 'yearly_commitment'
        elif 'yearly' in product_id_lower or 'annual' in product_id_lower:
            return 'yearly'
        
        return 'monthly'

