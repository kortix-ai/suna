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
    thread_limit: int
    concurrent_runs: int
    custom_workers_limit: int
    scheduled_triggers_limit: int
    app_triggers_limit: int

TIERS: Dict[str, Tier] = {
    'none': Tier(
        name='none',
        price_ids=[],
        monthly_credits=Decimal('0.00'),
        display_name='No Plan',
        can_purchase_credits=False,
        models=[],
        project_limit=0,
        thread_limit=0,
        concurrent_runs=0,
        custom_workers_limit=0,
        scheduled_triggers_limit=0,
        app_triggers_limit=0
    ),
    'free': Tier(
        name='free',
        price_ids=[config.STRIPE_FREE_TIER_ID],
        monthly_credits=FREE_TIER_INITIAL_CREDITS,
        display_name='Basic',
        can_purchase_credits=False,
        models=['haiku'],
        project_limit=5,
        thread_limit=5,
        concurrent_runs=1,
        custom_workers_limit=1,
        scheduled_triggers_limit=1,
        app_triggers_limit=1
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
        can_purchase_credits=False,
        models=['all'],
        project_limit=100,
        thread_limit=100,
        concurrent_runs=3,
        custom_workers_limit=5,
        scheduled_triggers_limit=5,
        app_triggers_limit=10
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
        can_purchase_credits=False,
        models=['all'],
        project_limit=500,
        thread_limit=500,
        concurrent_runs=5,
        custom_workers_limit=20,
        scheduled_triggers_limit=10,
        app_triggers_limit=25
    ),
    'tier_12_100': Tier(
        name='tier_12_100',
        price_ids=[
            config.STRIPE_TIER_12_100_ID,
            config.STRIPE_TIER_12_100_YEARLY_ID
        ],
        monthly_credits=Decimal('100.00'),
        display_name='Team',
        can_purchase_credits=False,
        models=['all'],
        project_limit=1000,
        thread_limit=1000,
        concurrent_runs=10,
        custom_workers_limit=10,
        scheduled_triggers_limit=20,
        app_triggers_limit=50
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
        project_limit=2500,
        thread_limit=2500,
        concurrent_runs=20,
        custom_workers_limit=100,
        scheduled_triggers_limit=50,
        app_triggers_limit=100
    ),
    'tier_50_400': Tier(
        name='tier_50_400',
        price_ids=[
            config.STRIPE_TIER_50_400_ID,
            config.STRIPE_TIER_50_400_YEARLY_ID
        ],
        monthly_credits=Decimal('400.00'),
        display_name='Enterprise',
        can_purchase_credits=False,
        models=['all'],
        project_limit=5000,
        thread_limit=5000,
        concurrent_runs=50,
        custom_workers_limit=50,
        scheduled_triggers_limit=100,
        app_triggers_limit=250
    ),
    'tier_125_800': Tier(
        name='tier_125_800',
        price_ids=[
            config.STRIPE_TIER_125_800_ID,
            config.STRIPE_TIER_125_800_YEARLY_ID
        ],
        monthly_credits=Decimal('800.00'),
        display_name='Enterprise Plus',
        can_purchase_credits=False,
        models=['all'],
        project_limit=10000,
        thread_limit=10000,
        concurrent_runs=100,
        custom_workers_limit=100,
        scheduled_triggers_limit=250,
        app_triggers_limit=500
    ),
    'tier_200_1000': Tier(
        name='tier_200_1000',
        price_ids=[
            config.STRIPE_TIER_200_1000_ID,
            config.STRIPE_TIER_200_1000_YEARLY_ID
        ],
        monthly_credits=Decimal('1000.00'),
        display_name='Ultimate',
        can_purchase_credits=False,
        models=['all'],
        project_limit=25000,
        thread_limit=25000,
        concurrent_runs=250,
        custom_workers_limit=250,
        scheduled_triggers_limit=500,
        app_triggers_limit=1000
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
    
    from core.ai_models import model_manager
    resolved_model_id = model_manager.resolve_model_id(model)
    model_obj = model_manager.get_model(resolved_model_id) if resolved_model_id else None
    
    if not model_obj:
        return False
    
    for allowed_pattern in tier.models:
        if allowed_pattern.lower() in model_obj.name.lower():
            return True
        if allowed_pattern.lower() in model_obj.id.lower():
            return True
        for alias in model_obj.aliases:
            if allowed_pattern.lower() in alias.lower():
                return True
    
    return False

def get_project_limit(tier_name: str) -> int:
    tier = TIERS.get(tier_name)
    return tier.project_limit if tier else 3

def is_commitment_price_id(price_id: str) -> bool:
    commitment_price_ids = [
        config.STRIPE_TIER_2_17_YEARLY_COMMITMENT_ID,
        config.STRIPE_TIER_6_42_YEARLY_COMMITMENT_ID,
        config.STRIPE_TIER_25_170_YEARLY_COMMITMENT_ID
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
        config.STRIPE_TIER_2_20_YEARLY_ID,
        config.STRIPE_TIER_6_50_YEARLY_ID,
        config.STRIPE_TIER_12_100_YEARLY_ID,
        config.STRIPE_TIER_25_200_YEARLY_ID,
        config.STRIPE_TIER_50_400_YEARLY_ID,
        config.STRIPE_TIER_125_800_YEARLY_ID,
        config.STRIPE_TIER_200_1000_YEARLY_ID
    ]
    
    if price_id in yearly_price_ids:
        return 'yearly'
    
    return 'monthly'

def get_plan_type(price_id: str) -> str:
    price_type = get_price_type(price_id)
    return price_type

def get_thread_limit(tier_name: str) -> int:
    tier = TIERS.get(tier_name)
    return tier.thread_limit if tier else TIERS['free'].thread_limit

def get_concurrent_runs_limit(tier_name: str) -> int:
    tier = TIERS.get(tier_name)
    return tier.concurrent_runs if tier else TIERS['free'].concurrent_runs

def get_custom_workers_limit(tier_name: str) -> int:
    tier = TIERS.get(tier_name)
    return tier.custom_workers_limit if tier else TIERS['free'].custom_workers_limit

def get_scheduled_triggers_limit(tier_name: str) -> int:
    tier = TIERS.get(tier_name)
    return tier.scheduled_triggers_limit if tier else TIERS['free'].scheduled_triggers_limit

def get_app_triggers_limit(tier_name: str) -> int:
    tier = TIERS.get(tier_name)
    return tier.app_triggers_limit if tier else TIERS['free'].app_triggers_limit

def get_tier_limits(tier_name: str) -> Dict:
    tier = TIERS.get(tier_name, TIERS['free'])
    return {
        'project_limit': tier.project_limit,
        'thread_limit': tier.thread_limit,
        'concurrent_runs': tier.concurrent_runs,
        'custom_workers_limit': tier.custom_workers_limit,
        'scheduled_triggers_limit': tier.scheduled_triggers_limit,
        'app_triggers_limit': tier.app_triggers_limit,
        'agent_limit': tier.custom_workers_limit,
        'can_purchase_credits': tier.can_purchase_credits,
        'models': tier.models
    } 