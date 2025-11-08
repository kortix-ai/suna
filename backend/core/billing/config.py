from decimal import Decimal
from typing import Dict, List, Optional
from dataclasses import dataclass
from core.utils.config import config

TRIAL_ENABLED = False
TRIAL_DURATION_DAYS = 7
TRIAL_TIER = "tier_2_20"
TRIAL_CREDITS = Decimal("5.00")

TOKEN_PRICE_MULTIPLIER = Decimal('1.2')
MINIMUM_CREDIT_FOR_RUN = Decimal('0.01')
DEFAULT_TOKEN_COST = Decimal('0.000002')

CREDITS_PER_DOLLAR = 100

FREE_TIER_INITIAL_CREDITS = Decimal('2.00')

@dataclass
class Tier:
    name: str
    price_ids: List[str]
    monthly_credits: Decimal
    display_name: str
    can_purchase_credits: bool
    models: List[str]
    project_limit: int
    trigger_limit: int

TIERS: Dict[str, Tier] = {
    'none': Tier(
        name='none',
        price_ids=[],
        monthly_credits=Decimal('0.00'),
        display_name='No Plan',
        can_purchase_credits=False,
        models=[],
        project_limit=0,
        trigger_limit=0
    ),
    'free': Tier(
        name='free',
        price_ids=[config.STRIPE_FREE_TIER_ID],
        monthly_credits=FREE_TIER_INITIAL_CREDITS,
        display_name='Free',
        can_purchase_credits=False,
        models=['all'],
        project_limit=1,
        trigger_limit=1
    ),
    'tier_2_20': Tier(
        name='tier_2_20',
        price_ids=[
            config.STRIPE_TIER_2_20_ID,
            config.STRIPE_TIER_2_20_YEARLY_ID,
            config.STRIPE_TIER_2_17_YEARLY_COMMITMENT_ID
        ],
        monthly_credits=Decimal('29.00'),
        display_name='Starter',
        can_purchase_credits=False,
        models=['all'],
        project_limit=10,
        trigger_limit=5
    ),
    'tier_6_50': Tier(
        name='tier_6_50',
        price_ids=[
            config.STRIPE_TIER_6_50_ID,
            config.STRIPE_TIER_6_50_YEARLY_ID,
            config.STRIPE_TIER_6_42_YEARLY_COMMITMENT_ID
        ],
        monthly_credits=Decimal('79.00'),
        display_name='Professional',
        can_purchase_credits=False,
        models=['all'],
        project_limit=50,
        trigger_limit=25
    ),
    'tier_12_100': Tier(
        name='tier_12_100',
        price_ids=[
            config.STRIPE_TIER_12_100_ID,
            config.STRIPE_TIER_12_100_YEARLY_ID
        ],
        monthly_credits=Decimal('199.00'),
        display_name='Business',
        can_purchase_credits=True,
        models=['all'],
        project_limit=200,
        trigger_limit=100
    ),
    'tier_25_200': Tier(
        name='tier_25_200',
        price_ids=[
            config.STRIPE_TIER_25_200_ID,
            config.STRIPE_TIER_25_200_YEARLY_ID,
            config.STRIPE_TIER_25_170_YEARLY_COMMITMENT_ID
        ],
        monthly_credits=Decimal('499.00'),
        display_name='Enterprise',
        can_purchase_credits=True,
        models=['all'],
        project_limit=1000,
        trigger_limit=-1  # Unlimited
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
    return tier.monthly_credits if tier else TIERS['none'].monthly_credits

def can_purchase_credits(tier_name: str) -> bool:
    tier = TIERS.get(tier_name)
    return tier.can_purchase_credits if tier else False

def is_model_allowed(tier_name: str, model: str) -> bool:
    tier = TIERS.get(tier_name, TIERS['none'])
    if 'all' in tier.models:
        return True
    return model in tier.models

def get_project_limit(tier_name: str) -> int:
    tier = TIERS.get(tier_name)
    return tier.project_limit if tier else 3

def get_trigger_limit(tier_name: str) -> int:
    tier = TIERS.get(tier_name)
    return tier.trigger_limit if tier else 0

def is_commitment_price_id(price_id: str) -> bool:
    commitment_price_ids = [
        config.STRIPE_TIER_2_17_YEARLY_COMMITMENT_ID,  # tier_2_20 (starter)
        config.STRIPE_TIER_6_42_YEARLY_COMMITMENT_ID,  # tier_6_50 (professional)
        config.STRIPE_TIER_25_170_YEARLY_COMMITMENT_ID # tier_25_200 (enterprise)
    ]
    return price_id in commitment_price_ids

def get_commitment_duration_months(price_id: str) -> int:
    if is_commitment_price_id(price_id):
        return 12
    return 0

def get_price_type(price_id: str) -> str:
    if is_commitment_price_id(price_id):
        return 'yearly_commitment'
    
    yearly_price_ids = [
        config.STRIPE_TIER_2_20_YEARLY_ID,    # tier_2_20 (starter)
        config.STRIPE_TIER_6_50_YEARLY_ID,    # tier_6_50 (professional)
        config.STRIPE_TIER_12_100_YEARLY_ID,  # tier_12_100 (business)
        config.STRIPE_TIER_25_200_YEARLY_ID,  # tier_25_200 (enterprise)
    ]
    
    if price_id in yearly_price_ids:
        return 'yearly'
    
    return 'monthly' 