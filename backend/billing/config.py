from decimal import Decimal
from typing import Dict, List, Optional
from dataclasses import dataclass
from core.utils.config import config
from enum import Enum
import asyncio
from core.services.supabase import DBConnection
from core.utils.logger import logger

class TrialMode(Enum):
    DISABLED = "disabled"
    CC_REQUIRED = "cc_required"
    CC_OPTIONAL = "cc_optional"

@dataclass
class TrialConfig:
    mode: TrialMode
    duration_days: int = 7
    trial_tier: str = "tier_2_20"
    trial_credits: Decimal = Decimal("20.00")
    stripe_trial_period_days: int = 7
    require_payment_method_upfront: bool = False
    
DEFAULT_TRIAL_CONFIG = TrialConfig(
    mode=TrialMode.CC_REQUIRED,
    duration_days=7,
    trial_tier="tier_2_20",
    trial_credits=Decimal("20.00"),
    stripe_trial_period_days=7,
    require_payment_method_upfront=False
)

_trial_config_cache = None
_trial_config_cache_time = None

async def get_trial_config() -> TrialConfig:
    global _trial_config_cache, _trial_config_cache_time
    import time
    
    if _trial_config_cache and _trial_config_cache_time and (time.time() - _trial_config_cache_time < 60):
        return _trial_config_cache
    
    try:
        db = DBConnection()
        client = await db.client
        
        result = await client.from_('system_config').select('key, value').in_('key', [
            'trial_mode', 'trial_duration_days', 'trial_credits'
        ]).execute()
        
        if result.data:
            settings = {row['key']: row['value'] for row in result.data}
            
            mode_str = settings.get('trial_mode', 'cc_required')
            mode = TrialMode(mode_str) if mode_str in [m.value for m in TrialMode] else TrialMode.CC_REQUIRED
            
            _trial_config_cache = TrialConfig(
                mode=mode,
                duration_days=int(settings.get('trial_duration_days', 7)),
                trial_tier="tier_2_20",
                trial_credits=Decimal(settings.get('trial_credits', '20.00')),
                stripe_trial_period_days=int(settings.get('trial_duration_days', 7)),
                require_payment_method_upfront=(mode == TrialMode.CC_REQUIRED)
            )
            _trial_config_cache_time = time.time()
            return _trial_config_cache
    except Exception as e:
        logger.warning(f"Failed to load trial config from database: {e}, using defaults")
    
    return DEFAULT_TRIAL_CONFIG

def is_trial_enabled() -> bool:
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            return DEFAULT_TRIAL_CONFIG.mode != TrialMode.DISABLED
        config = loop.run_until_complete(get_trial_config())
        return config.mode != TrialMode.DISABLED
    except:
        return DEFAULT_TRIAL_CONFIG.mode != TrialMode.DISABLED

def is_cc_required_for_trial() -> bool:
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            return DEFAULT_TRIAL_CONFIG.mode == TrialMode.CC_REQUIRED
        config = loop.run_until_complete(get_trial_config())
        return config.mode == TrialMode.CC_REQUIRED
    except:
        return DEFAULT_TRIAL_CONFIG.mode == TrialMode.CC_REQUIRED

TOKEN_PRICE_MULTIPLIER = Decimal('1.5')
MINIMUM_CREDIT_FOR_RUN = Decimal('0.01')
DEFAULT_TOKEN_COST = Decimal('0.000002')

FREE_TIER_INITIAL_CREDITS = Decimal('5.00')

@dataclass
class Tier:
    name: str
    price_ids: List[str]
    monthly_credits: Decimal
    display_name: str
    can_purchase_credits: bool
    models: List[str]
    project_limit: int

TIERS: Dict[str, Tier] = {
    'free': Tier(
        name='free',
        price_ids=[config.STRIPE_FREE_TIER_ID],
        monthly_credits=FREE_TIER_INITIAL_CREDITS,
        display_name='Free Tier',
        can_purchase_credits=False,
        models=['openai/gpt-5-mini', 'openrouter/moonshotai/kimi-k2'],
        project_limit=3
    ),
    'tier_2_20': Tier(
        name='tier_2_20',
        price_ids=[
            config.STRIPE_TIER_2_20_ID,
            config.STRIPE_TIER_2_20_YEARLY_ID,
            config.STRIPE_TIER_2_17_YEARLY_COMMITMENT_ID
        ],
        monthly_credits=Decimal('20.00'),
        display_name='Starter',
        can_purchase_credits=True,
        models=['all'],
        project_limit=100
    ),
    'tier_6_50': Tier(
        name='tier_6_50',
        price_ids=[
            config.STRIPE_TIER_6_50_ID,
            config.STRIPE_TIER_6_50_YEARLY_ID,
            config.STRIPE_TIER_6_42_YEARLY_COMMITMENT_ID
        ],
        monthly_credits=Decimal('50.00'),
        display_name='Professional',
        can_purchase_credits=True,
        models=['all'],
        project_limit=500
    ),
    'tier_12_100': Tier(
        name='tier_12_100',
        price_ids=[
            config.STRIPE_TIER_12_100_ID,
            config.STRIPE_TIER_12_100_YEARLY_ID
        ],
        monthly_credits=Decimal('100.00'),
        display_name='Team',
        can_purchase_credits=True,
        models=['all'],
        project_limit=1000
    ),
    'tier_25_200': Tier(
        name='tier_25_200',
        price_ids=[
            config.STRIPE_TIER_25_200_ID,
            config.STRIPE_TIER_25_200_YEARLY_ID,
            config.STRIPE_TIER_25_170_YEARLY_COMMITMENT_ID
        ],
        monthly_credits=Decimal('200.00'),
        display_name='Business',
        can_purchase_credits=True,
        models=['all'],
        project_limit=2500
    ),
    'tier_50_400': Tier(
        name='tier_50_400',
        price_ids=[
            config.STRIPE_TIER_50_400_ID,
            config.STRIPE_TIER_50_400_YEARLY_ID
        ],
        monthly_credits=Decimal('400.00'),
        display_name='Enterprise',
        can_purchase_credits=True,
        models=['all'],
        project_limit=5000
    ),
    'tier_125_800': Tier(
        name='tier_125_800',
        price_ids=[
            config.STRIPE_TIER_125_800_ID,
            config.STRIPE_TIER_125_800_YEARLY_ID
        ],
        monthly_credits=Decimal('800.00'),
        display_name='Enterprise Plus',
        can_purchase_credits=True,
        models=['all'],
        project_limit=10000
    ),
    'tier_200_1000': Tier(
        name='tier_200_1000',
        price_ids=[
            config.STRIPE_TIER_200_1000_ID,
            config.STRIPE_TIER_200_1000_YEARLY_ID
        ],
        monthly_credits=Decimal('1000.00'),
        display_name='Ultimate',
        can_purchase_credits=True,
        models=['all'],
        project_limit=25000
    ),
}

CREDIT_PACKAGES = [
    {'amount': Decimal('10.00'), 'stripe_price_id': config.STRIPE_CREDITS_10_PRICE_ID},
    {'amount': Decimal('25.00'), 'stripe_price_id': config.STRIPE_CREDITS_25_PRICE_ID},
    {'amount': Decimal('50.00'), 'stripe_price_id': config.STRIPE_CREDITS_50_PRICE_ID},
    {'amount': Decimal('100.00'), 'stripe_price_id': config.STRIPE_CREDITS_100_PRICE_ID},
    {'amount': Decimal('250.00'), 'stripe_price_id': config.STRIPE_CREDITS_250_PRICE_ID},
    {'amount': Decimal('500.00'), 'stripe_price_id': config.STRIPE_CREDITS_500_PRICE_ID},
]

ADMIN_LIMITS = {
    'max_credit_adjustment': Decimal('1000.00'),
    'max_bulk_grant': Decimal('10000.00'),
    'require_super_admin_above': Decimal('500.00'),
}

def get_tier_by_price_id(price_id: str) -> Optional[Tier]:
    for tier in TIERS.values():
        if price_id in tier.price_ids:
            return tier
    return None

def get_tier_by_name(tier_name: str) -> Optional[Tier]:
    return TIERS.get(tier_name)

def get_monthly_credits(tier_name: str) -> Decimal:
    tier = TIERS.get(tier_name)
    return tier.monthly_credits if tier else TIERS['free'].monthly_credits

def can_purchase_credits(tier_name: str) -> bool:
    tier = TIERS.get(tier_name)
    return tier.can_purchase_credits if tier else False

def is_model_allowed(tier_name: str, model: str) -> bool:
    tier = TIERS.get(tier_name, TIERS['free'])
    if 'all' in tier.models:
        return True
    return model in tier.models

def get_project_limit(tier_name: str) -> int:
    tier = TIERS.get(tier_name)
    return tier.project_limit if tier else 3 