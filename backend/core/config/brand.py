"""
Brand configuration for Adentic email templates and backend services
"""
from dataclasses import dataclass
from typing import Optional


@dataclass
class EmailBrandConfig:
    """Configuration for email branding"""

    brand_name: str = "Adentic"
    primary_color: str = "#CC3A00"
    logo_url: str = "https://adentic.com/logo.png"  # Update with actual domain
    copyright_text: str = "© 2025 Adentic. All rights reserved."
    support_email: str = "support@adentic.com"

    # Email template specific
    header_bg_color: str = "#FFFFFF"
    footer_bg_color: str = "#F5F5F5"
    button_color: str = "#CC3A00"
    button_text_color: str = "#FFFFFF"

    # Social links
    linkedin_url: str = "https://www.linkedin.com/company/tryadentic"
    twitter_url: Optional[str] = None
    github_url: Optional[str] = None


# Global instance
email_brand_config = EmailBrandConfig()


def get_email_template_context() -> dict:
    """Get the brand context for email templates"""
    return {
        "brand_name": email_brand_config.brand_name,
        "primary_color": email_brand_config.primary_color,
        "logo_url": email_brand_config.logo_url,
        "copyright_text": email_brand_config.copyright_text,
        "support_email": email_brand_config.support_email,
        "header_bg_color": email_brand_config.header_bg_color,
        "footer_bg_color": email_brand_config.footer_bg_color,
        "button_color": email_brand_config.button_color,
        "button_text_color": email_brand_config.button_text_color,
        "linkedin_url": email_brand_config.linkedin_url,
        "twitter_url": email_brand_config.twitter_url,
        "github_url": email_brand_config.github_url,
    }


def validate_hex_color(color: str) -> bool:
    """Validate hex color format"""
    if not color or not color.startswith("#"):
        return False

    hex_part = color[1:]
    if len(hex_part) != 6:
        return False

    try:
        int(hex_part, 16)
        return True
    except ValueError:
        return False


def get_brand_replaced_text(text: str) -> str:
    """Replace any remaining Adentic references with Adentic"""
    if not text:
        return text

    # Case-insensitive replacement
    replacements = {
        "Adentic": "Adentic",
        "kortix": "adentic",
        "KORTIX": "ADENTIC",
    }

    result = text
    for old, new in replacements.items():
        result = result.replace(old, new)

    return result