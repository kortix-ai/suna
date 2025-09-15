from decimal import Decimal
from typing import Dict, List, Optional
from dataclasses import dataclass
from core.utils.config import config

TRIAL_ENABLED = True
TRIAL_DURATION_DAYS = 7
TRIAL_TIER = "tier_2_20"
TRIAL_CREDITS = Decimal("5.00")

TOKEN_PRICE_MULTIPLIER = Decimal('1.2')
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
    'none': Tier(
        name='none',
        price_ids=[],
        monthly_credits=Decimal('0.00'),
        display_name='No Plan',
        can_purchase_credits=False,
        models=[],
        project_limit=0
    ),
    'free': Tier(
        name='free',
        price_ids=[],
        monthly_credits=Decimal('0.00'),
        display_name='Free Tier (Discontinued)',
        can_purchase_credits=False,
        models=[],
        project_limit=0
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