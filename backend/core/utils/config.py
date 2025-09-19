"""
Configuration management.

This module provides a centralized way to access configuration settings and
environment variables across the application. It supports different environment
modes (development, staging, production) and provides validation for required
values.

Usage:
    from core.utils.config import config
    
    # Access configuration values
    api_key = config.OPENAI_API_KEY
    env_mode = config.ENV_MODE
"""

import os
from enum import Enum
from re import S
from typing import Dict, Any, Optional, get_type_hints, Union
from dotenv import load_dotenv
import logging
import secrets

logger = logging.getLogger(__name__)

class EnvMode(Enum):
    """Environment mode enumeration."""
    LOCAL = "local"
    STAGING = "staging"
    PRODUCTION = "production"

class Configuration:
    """
    Centralized configuration for AgentPress backend.
    
    This class loads environment variables and provides type checking and validation.
    Default values can be specified for optional configuration items.
    """
    
    # Environment mode
    ENV_MODE: EnvMode = EnvMode.LOCAL
    
    
    # Subscription tier IDs - Production
    STRIPE_FREE_TIER_ID_PROD: str = 'price_1RILb4G6l1KZGqIrK4QLrx9i'
    STRIPE_TIER_2_20_ID_PROD: str = 'price_1RILb4G6l1KZGqIrhomjgDnO'
    STRIPE_TIER_6_50_ID_PROD: str = 'price_1RILb4G6l1KZGqIr5q0sybWn'
    STRIPE_TIER_12_100_ID_PROD: str = 'price_1RILb4G6l1KZGqIr5Y20ZLHm'
    STRIPE_TIER_25_200_ID_PROD: str = 'price_1RILb4G6l1KZGqIrGAD8rNjb'
    STRIPE_TIER_50_400_ID_PROD: str = 'price_1RILb4G6l1KZGqIruNBUMTF1'
    STRIPE_TIER_125_800_ID_PROD: str = 'price_1RILb3G6l1KZGqIrbJA766tN'
    STRIPE_TIER_200_1000_ID_PROD: str = 'price_1RILb3G6l1KZGqIrmauYPOiN'
    
    # Yearly subscription tier IDs - Production (15% discount)
    STRIPE_TIER_2_20_YEARLY_ID_PROD: str = 'price_1ReHB5G6l1KZGqIrD70I1xqM'
    STRIPE_TIER_6_50_YEARLY_ID_PROD: str = 'price_1ReHAsG6l1KZGqIrlAog487C'
    STRIPE_TIER_12_100_YEARLY_ID_PROD: str = 'price_1ReHAWG6l1KZGqIrBHer2PQc'
    STRIPE_TIER_25_200_YEARLY_ID_PROD: str = 'price_1ReH9uG6l1KZGqIrsvMLHViC'
    STRIPE_TIER_50_400_YEARLY_ID_PROD: str = 'price_1ReH9fG6l1KZGqIrsPtu5KIA'
    STRIPE_TIER_125_800_YEARLY_ID_PROD: str = 'price_1ReH9GG6l1KZGqIrfgqaJyat'
    STRIPE_TIER_200_1000_YEARLY_ID_PROD: str = 'price_1ReH8qG6l1KZGqIrK1akY90q'

    # Yearly commitment prices - Production (15% discount, monthly payments with 12-month commitment via schedules)
    STRIPE_TIER_2_17_YEARLY_COMMITMENT_ID_PROD: str = 'price_1RqtqiG6l1KZGqIrhjVPtE1s'  # $17/month
    STRIPE_TIER_6_42_YEARLY_COMMITMENT_ID_PROD: str = 'price_1Rqtr8G6l1KZGqIrQ0ql0qHi'  # $42.50/month
    STRIPE_TIER_25_170_YEARLY_COMMITMENT_ID_PROD: str = 'price_1RqtrUG6l1KZGqIrEb8hLsk3'  # $170/month

    # Subscription tier IDs - Staging
    STRIPE_FREE_TIER_ID_STAGING: str = 'price_1RIGvuG6l1KZGqIrw14abxeL'
    STRIPE_TIER_2_20_ID_STAGING: str = 'price_1RIGvuG6l1KZGqIrCRu0E4Gi'
    STRIPE_TIER_6_50_ID_STAGING: str = 'price_1RIGvuG6l1KZGqIrvjlz5p5V'
    STRIPE_TIER_12_100_ID_STAGING: str = 'price_1RIGvuG6l1KZGqIrT6UfgblC'
    STRIPE_TIER_25_200_ID_STAGING: str = 'price_1RIGvuG6l1KZGqIrOVLKlOMj'
    STRIPE_TIER_50_400_ID_STAGING: str = 'price_1RIKNgG6l1KZGqIrvsat5PW7'
    STRIPE_TIER_125_800_ID_STAGING: str = 'price_1RIKNrG6l1KZGqIrjKT0yGvI'
    STRIPE_TIER_200_1000_ID_STAGING: str = 'price_1RIKQ2G6l1KZGqIrum9n8SI7'
    
    # Yearly subscription tier IDs - Staging (15% discount)
    STRIPE_TIER_2_20_YEARLY_ID_STAGING: str = 'price_1ReGogG6l1KZGqIrEyBTmtPk'
    STRIPE_TIER_6_50_YEARLY_ID_STAGING: str = 'price_1ReGoJG6l1KZGqIr0DJWtoOc'
    STRIPE_TIER_12_100_YEARLY_ID_STAGING: str = 'price_1ReGnZG6l1KZGqIr0ThLEl5S'
    STRIPE_TIER_25_200_YEARLY_ID_STAGING: str = 'price_1ReGmzG6l1KZGqIre31mqoEJ'
    STRIPE_TIER_50_400_YEARLY_ID_STAGING: str = 'price_1ReGmgG6l1KZGqIrn5nBc7e5'
    STRIPE_TIER_125_800_YEARLY_ID_STAGING: str = 'price_1ReGmMG6l1KZGqIrvE2ycrAX'
    STRIPE_TIER_200_1000_YEARLY_ID_STAGING: str = 'price_1ReGlXG6l1KZGqIrlgurP5GU'

    # Yearly commitment prices - Staging (15% discount, monthly payments with 12-month commitment via schedules)
    STRIPE_TIER_2_17_YEARLY_COMMITMENT_ID_STAGING: str = 'price_1RqYGaG6l1KZGqIrIzcdPzeQ'  # $17/month
    STRIPE_TIER_6_42_YEARLY_COMMITMENT_ID_STAGING: str = 'price_1RqYH1G6l1KZGqIrWDKh8xIU'  # $42.50/month
    STRIPE_TIER_25_170_YEARLY_COMMITMENT_ID_STAGING: str = 'price_1RqYHbG6l1KZGqIrAUVf8KpG'  # $170/month
    
    # Credit package price IDs - Production
    STRIPE_CREDITS_10_PRICE_ID_PROD: str = 'price_1RxmQUG6l1KZGqIru453O1zW'
    STRIPE_CREDITS_25_PRICE_ID_PROD: str = 'price_1RxmQlG6l1KZGqIr3hS5WtGg'
    STRIPE_CREDITS_50_PRICE_ID_PROD: str = 'price_1RxmQvG6l1KZGqIrLbMZ3D6r'
    STRIPE_CREDITS_100_PRICE_ID_PROD: str = 'price_1RxmR3G6l1KZGqIrpLwFCGac'
    STRIPE_CREDITS_250_PRICE_ID_PROD: str = 'price_1RxmRAG6l1KZGqIrtBIMsZAj'
    STRIPE_CREDITS_500_PRICE_ID_PROD: str = 'price_1RxmRGG6l1KZGqIrSyvl6w1G'
    
    # Credit package price IDs - Staging  
    STRIPE_CREDITS_10_PRICE_ID_STAGING: str = 'price_1RxXOvG6l1KZGqIrMqsiYQvk'
    STRIPE_CREDITS_25_PRICE_ID_STAGING: str = 'price_1RxXPNG6l1KZGqIrQprPgDme'
    STRIPE_CREDITS_50_PRICE_ID_STAGING: str = 'price_1RxmNhG6l1KZGqIrTq2zPtgi'
    STRIPE_CREDITS_100_PRICE_ID_STAGING: str = 'price_1RxmNwG6l1KZGqIrnliwPDM6'
    STRIPE_CREDITS_250_PRICE_ID_STAGING: str = 'price_1RxmO6G6l1KZGqIrBF8Kx87G'
    STRIPE_CREDITS_500_PRICE_ID_STAGING: str = 'price_1RxmOFG6l1KZGqIrn4wgORnH'
    
    # Computed subscription tier IDs based on environment
    @property
    def STRIPE_FREE_TIER_ID(self) -> str:   
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_FREE_TIER_ID_STAGING
        return self.STRIPE_FREE_TIER_ID_PROD
    
    @property
    def STRIPE_TIER_2_20_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_TIER_2_20_ID_STAGING
        return self.STRIPE_TIER_2_20_ID_PROD
    
    @property
    def STRIPE_TIER_6_50_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_TIER_6_50_ID_STAGING
        return self.STRIPE_TIER_6_50_ID_PROD
    
    @property
    def STRIPE_TIER_12_100_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_TIER_12_100_ID_STAGING
        return self.STRIPE_TIER_12_100_ID_PROD
    
    @property
    def STRIPE_TIER_25_200_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_TIER_25_200_ID_STAGING
        return self.STRIPE_TIER_25_200_ID_PROD
    
    @property
    def STRIPE_TIER_50_400_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_TIER_50_400_ID_STAGING
        return self.STRIPE_TIER_50_400_ID_PROD
    
    @property
    def STRIPE_TIER_125_800_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_TIER_125_800_ID_STAGING
        return self.STRIPE_TIER_125_800_ID_PROD
    
    @property
    def STRIPE_TIER_200_1000_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_TIER_200_1000_ID_STAGING
        return self.STRIPE_TIER_200_1000_ID_PROD
    
    # Yearly tier computed properties
    @property
    def STRIPE_TIER_2_20_YEARLY_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_TIER_2_20_YEARLY_ID_STAGING
        return self.STRIPE_TIER_2_20_YEARLY_ID_PROD
    
    @property
    def STRIPE_TIER_6_50_YEARLY_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_TIER_6_50_YEARLY_ID_STAGING
        return self.STRIPE_TIER_6_50_YEARLY_ID_PROD
    
    @property
    def STRIPE_TIER_12_100_YEARLY_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_TIER_12_100_YEARLY_ID_STAGING
        return self.STRIPE_TIER_12_100_YEARLY_ID_PROD
    
    @property
    def STRIPE_TIER_25_200_YEARLY_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_TIER_25_200_YEARLY_ID_STAGING
        return self.STRIPE_TIER_25_200_YEARLY_ID_PROD
    
    @property
    def STRIPE_TIER_50_400_YEARLY_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_TIER_50_400_YEARLY_ID_STAGING
        return self.STRIPE_TIER_50_400_YEARLY_ID_PROD
    
    @property
    def STRIPE_TIER_125_800_YEARLY_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_TIER_125_800_YEARLY_ID_STAGING
        return self.STRIPE_TIER_125_800_YEARLY_ID_PROD
    
    @property
    def STRIPE_TIER_200_1000_YEARLY_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_TIER_200_1000_YEARLY_ID_STAGING
        return self.STRIPE_TIER_200_1000_YEARLY_ID_PROD
    
    # Yearly commitment prices computed properties
    @property
    def STRIPE_TIER_2_17_YEARLY_COMMITMENT_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_TIER_2_17_YEARLY_COMMITMENT_ID_STAGING
        return self.STRIPE_TIER_2_17_YEARLY_COMMITMENT_ID_PROD

    @property
    def STRIPE_TIER_6_42_YEARLY_COMMITMENT_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_TIER_6_42_YEARLY_COMMITMENT_ID_STAGING
        return self.STRIPE_TIER_6_42_YEARLY_COMMITMENT_ID_PROD

    @property
    def STRIPE_TIER_25_170_YEARLY_COMMITMENT_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_TIER_25_170_YEARLY_COMMITMENT_ID_STAGING
        return self.STRIPE_TIER_25_170_YEARLY_COMMITMENT_ID_PROD
    
    # Credit package price ID properties
    @property
    def STRIPE_CREDITS_10_PRICE_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_CREDITS_10_PRICE_ID_STAGING
        return self.STRIPE_CREDITS_10_PRICE_ID_PROD
    
    @property
    def STRIPE_CREDITS_25_PRICE_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_CREDITS_25_PRICE_ID_STAGING
        return self.STRIPE_CREDITS_25_PRICE_ID_PROD
    
    @property
    def STRIPE_CREDITS_50_PRICE_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_CREDITS_50_PRICE_ID_STAGING
        return self.STRIPE_CREDITS_50_PRICE_ID_PROD
    
    @property
    def STRIPE_CREDITS_100_PRICE_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_CREDITS_100_PRICE_ID_STAGING
        return self.STRIPE_CREDITS_100_PRICE_ID_PROD
    
    @property
    def STRIPE_CREDITS_250_PRICE_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_CREDITS_250_PRICE_ID_STAGING
        return self.STRIPE_CREDITS_250_PRICE_ID_PROD
    
    @property
    def STRIPE_CREDITS_500_PRICE_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_CREDITS_500_PRICE_ID_STAGING
        return self.STRIPE_CREDITS_500_PRICE_ID_PROD
    
    # LLM API keys
    ANTHROPIC_API_KEY: Optional[str] = None
    OPENAI_API_KEY: Optional[str] = None
    GROQ_API_KEY: Optional[str] = None
    OPENROUTER_API_KEY: Optional[str] = None
    XAI_API_KEY: Optional[str] = None
    MORPH_API_KEY: Optional[str] = None
    GEMINI_API_KEY: Optional[str] = None
    OPENROUTER_API_BASE: Optional[str] = "https://openrouter.ai/api/v1"
    OPENAI_COMPATIBLE_API_KEY: Optional[str] = None
    OPENAI_COMPATIBLE_API_BASE: Optional[str] = None
    OR_SITE_URL: Optional[str] = "https://kortix.ai"
    OR_APP_NAME: Optional[str] = "Kortix AI"    
    
    # AWS Bedrock credentials
    AWS_ACCESS_KEY_ID: Optional[str] = None
    AWS_SECRET_ACCESS_KEY: Optional[str] = None
    AWS_REGION_NAME: Optional[str] = None
    

    
    # Supabase configuration
    SUPABASE_URL: str
    SUPABASE_ANON_KEY: str
    SUPABASE_SERVICE_ROLE_KEY: str
    SUPABASE_JWT_SECRET: str
    
    # Redis configuration
    REDIS_HOST: str
    REDIS_PORT: int = 6379
    REDIS_PASSWORD: Optional[str] = None
    REDIS_SSL: bool = True
    
    # Daytona sandbox configuration
    DAYTONA_API_KEY: str
    DAYTONA_SERVER_URL: str
    DAYTONA_TARGET: str
    
    # Search and other API keys
    TAVILY_API_KEY: str
    RAPID_API_KEY: str
    SERPER_API_KEY: Optional[str] = None
    CLOUDFLARE_API_TOKEN: Optional[str] = None
    FIRECRAWL_API_KEY: str
    FIRECRAWL_URL: Optional[str] = "https://api.firecrawl.dev"
    
    # Stripe configuration
    STRIPE_SECRET_KEY: Optional[str] = None
    STRIPE_WEBHOOK_SECRET: Optional[str] = None
    STRIPE_DEFAULT_PLAN_ID: Optional[str] = None
    STRIPE_DEFAULT_TRIAL_DAYS: int = 14
    
    # Stripe Product IDs
    STRIPE_PRODUCT_ID_PROD: str = 'prod_SCl7AQ2C8kK1CD'
    STRIPE_PRODUCT_ID_STAGING: str = 'prod_SCgIj3G7yPOAWY'
    
    # Sandbox configuration
    SANDBOX_IMAGE_NAME = "kortix/suna:0.1.3.16"
    SANDBOX_SNAPSHOT_NAME = "kortix/suna:0.1.3.16"
    SANDBOX_ENTRYPOINT = "/usr/bin/supervisord -n -c /etc/supervisor/conf.d/supervisord.conf"

    # LangFuse configuration
    LANGFUSE_PUBLIC_KEY: Optional[str] = None
    LANGFUSE_SECRET_KEY: Optional[str] = None
    LANGFUSE_HOST: str = "https://cloud.langfuse.com"

    # Admin API key for server-side operations
    KORTIX_ADMIN_API_KEY: Optional[str] = None

    # API Keys system configuration
    API_KEY_SECRET: str = "default-secret-key-change-in-production"
    API_KEY_LAST_USED_THROTTLE_SECONDS: int = 900
    
    # Agent execution limits (can be overridden via environment variable)
    _MAX_PARALLEL_AGENT_RUNS_ENV: Optional[str] = None
    
    # Agent limits per billing tier
    # Note: These limits are bypassed in local mode (ENV_MODE=local) where unlimited agents are allowed
    AGENT_LIMITS = {
        'free': 2,
        'tier_2_20': 5,
        'tier_6_50': 20,
        'tier_12_100': 20,
        'tier_25_200': 100,
        'tier_50_400': 100,
        'tier_125_800': 100,
        'tier_200_1000': 100,
        # Yearly plans have same limits as monthly
        'tier_2_20_yearly': 5,
        'tier_6_50_yearly': 20,
        'tier_12_100_yearly': 20,
        'tier_25_200_yearly': 100,
        'tier_50_400_yearly': 100,
        'tier_125_800_yearly': 100,
        'tier_200_1000_yearly': 100,
        # Yearly commitment plans
        'tier_2_17_yearly_commitment': 5,
        'tier_6_42_yearly_commitment': 20,
        'tier_25_170_yearly_commitment': 100,
    }

    # Project limits per billing tier
    # Note: These limits are bypassed in local mode (ENV_MODE=local) where unlimited projects are allowed
    PROJECT_LIMITS = {
        'free': 3,
        'tier_2_20': 100,
        'tier_6_50': 500,
        'tier_12_100': 1000,
        'tier_25_200': 2500,
        'tier_50_400': 5000,
        'tier_125_800': 10000,
        'tier_200_1000': 25000,
        # Yearly plans have same limits as monthly
        'tier_2_20_yearly': 100,
        'tier_6_50_yearly': 500,
        'tier_12_100_yearly': 1000,
        'tier_25_200_yearly': 2500,
        'tier_50_400_yearly': 5000,
        'tier_125_800_yearly': 10000,
        'tier_200_1000_yearly': 25000,
        # Yearly commitment plans
        'tier_2_17_yearly_commitment': 100,
        'tier_6_42_yearly_commitment': 500,
        'tier_25_170_yearly_commitment': 2500,
    }

    @property
    def MAX_PARALLEL_AGENT_RUNS(self) -> int:
        """
        Get the maximum parallel agent runs limit.
        
        Can be overridden via MAX_PARALLEL_AGENT_RUNS environment variable.
        Defaults:
        - Production: 3
        - Local/Staging: 999999 (effectively infinite)
        """
        # Check for environment variable override first
        if self._MAX_PARALLEL_AGENT_RUNS_ENV is not None:
            try:
                return int(self._MAX_PARALLEL_AGENT_RUNS_ENV)
            except ValueError:
                logger.warning(f"Invalid MAX_PARALLEL_AGENT_RUNS value: {self._MAX_PARALLEL_AGENT_RUNS_ENV}, using default")
        
        # Environment-based defaults
        if self.ENV_MODE == EnvMode.PRODUCTION:
            return 3
        else:
            # Local and staging: effectively infinite
            return 999999
    
    @property
    def STRIPE_PRODUCT_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_PRODUCT_ID_STAGING
        return self.STRIPE_PRODUCT_ID_PROD
    
    def _generate_admin_api_key(self) -> str:
        """Generate a secure admin API key for Kortix administrative functions."""
        # Generate 32 random bytes and encode as hex for a readable API key
        key_bytes = secrets.token_bytes(32)
        return key_bytes.hex()

    def __init__(self):
        """Initialize configuration by loading from environment variables."""
        # Load environment variables from .env file if it exists
        load_dotenv()
        
        # Set environment mode first
        env_mode_str = os.getenv("ENV_MODE", EnvMode.LOCAL.value)
        try:
            self.ENV_MODE = EnvMode(env_mode_str.lower())
        except ValueError:
            logger.warning(f"Invalid ENV_MODE: {env_mode_str}, defaulting to LOCAL")
            self.ENV_MODE = EnvMode.LOCAL
            
        logger.debug(f"Environment mode: {self.ENV_MODE.value}")
        
        # Load configuration from environment variables
        self._load_from_env()
        
        # Auto-generate admin API key if not present
        if not self.KORTIX_ADMIN_API_KEY:
            self.KORTIX_ADMIN_API_KEY = self._generate_admin_api_key()
            logger.info("Auto-generated KORTIX_ADMIN_API_KEY for administrative functions")
        
        # Perform validation
        self._validate()
        
    def _load_from_env(self):
        """Load configuration values from environment variables."""
        for key, expected_type in get_type_hints(self.__class__).items():
            env_val = os.getenv(key)
            
            if env_val is not None:
                # Convert environment variable to the expected type
                if expected_type == bool:
                    # Handle boolean conversion
                    setattr(self, key, env_val.lower() in ('true', 't', 'yes', 'y', '1'))
                elif expected_type == int:
                    # Handle integer conversion
                    try:
                        setattr(self, key, int(env_val))
                    except ValueError:
                        logger.warning(f"Invalid value for {key}: {env_val}, using default")
                elif expected_type == EnvMode:
                    # Already handled for ENV_MODE
                    pass
                else:
                    # String or other type
                    setattr(self, key, env_val)
        
        # Custom handling for environment-dependent properties
        max_parallel_runs_env = os.getenv("MAX_PARALLEL_AGENT_RUNS")
        if max_parallel_runs_env is not None:
            self._MAX_PARALLEL_AGENT_RUNS_ENV = max_parallel_runs_env
    
    def _validate(self):
        """Validate configuration based on type hints."""
        # Get all configuration fields and their type hints
        type_hints = get_type_hints(self.__class__)
        
        # Find missing required fields
        missing_fields = []
        for field, field_type in type_hints.items():
            # Check if the field is Optional
            is_optional = hasattr(field_type, "__origin__") and field_type.__origin__ is Union and type(None) in field_type.__args__
            
            # If not optional and value is None, add to missing fields
            if not is_optional and getattr(self, field) is None:
                missing_fields.append(field)
        
        if missing_fields:
            error_msg = f"Missing required configuration fields: {', '.join(missing_fields)}"
            logger.error(error_msg)
            raise ValueError(error_msg)
    
    def get(self, key: str, default: Any = None) -> Any:
        """Get a configuration value with an optional default."""
        return getattr(self, key, default)
    
    def as_dict(self) -> Dict[str, Any]:
        """Return configuration as a dictionary."""
        return {
            key: getattr(self, key) 
            for key in get_type_hints(self.__class__).keys()
            if not key.startswith('_')
        }

# Create a singleton instance
config = Configuration() 