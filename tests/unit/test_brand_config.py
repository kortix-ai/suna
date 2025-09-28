"""
Unit tests for brand configuration validation and management.
These tests will fail until the rebrand module is properly refactored.
"""

import pytest
import json
from pathlib import Path
from unittest.mock import Mock, patch

# This import will fail initially since we need to refactor rebrand.py
from rebrand import BrandConfiguration, ConfigValidationError


class TestBrandConfiguration:
    """Test suite for BrandConfiguration class."""

    def setup_method(self):
        """Set up test fixtures."""
        self.valid_adentic_config = {
            "brand_name": "Adentic",
            "product_name": "Assistant",
            "company_name": "Adentic AI",
            "full_product_name": "Adentic Assistant",
            "website_url": "https://adentic.ai/",
            "twitter_url": "https://x.com/adenticai",
            "github_url": "https://github.com/adentic-ai/",
            "linkedin_url": "https://www.linkedin.com/company/adentic/",
            "new_assets_dir": "./adentic_brand_assets"
        }
        
        self.minimal_config = {
            "brand_name": "TestBrand"
        }
        
        self.invalid_config = {
            "product_name": "TestProduct"  # Missing required brand_name
        }

    def test_valid_adentic_configuration_creation(self):
        """Test creating a valid Adentic brand configuration."""
        config = BrandConfiguration(self.valid_adentic_config)
        
        assert config.brand_name == "Adentic"
        assert config.product_name == "Assistant"
        assert config.company_name == "Adentic AI"
        assert config.full_product_name == "Adentic Assistant"
        assert config.website_url == "https://adentic.ai/"
        assert config.twitter_url == "https://x.com/adenticai"
        assert config.github_url == "https://github.com/adentic-ai/"
        assert config.linkedin_url == "https://www.linkedin.com/company/adentic/"
        assert config.new_assets_dir == Path("./adentic_brand_assets")

    def test_minimal_configuration_with_defaults(self):
        """Test configuration with minimal required fields sets defaults."""
        config = BrandConfiguration(self.minimal_config)
        
        assert config.brand_name == "TestBrand"
        assert config.product_name == "TestBrand"  # Should default to brand_name
        assert config.company_name == "TestBrand AI"  # Should default to brand_name + " AI"
        assert config.full_product_name == "TestBrand TestBrand"
        assert config.website_url is None  # Optional field
        assert config.new_assets_dir is None  # Optional field

    def test_missing_required_brand_name_raises_error(self):
        """Test that missing brand_name raises ConfigValidationError."""
        with pytest.raises(ConfigValidationError) as exc_info:
            BrandConfiguration(self.invalid_config)
        
        assert "brand_name is required" in str(exc_info.value)

    def test_empty_brand_name_raises_error(self):
        """Test that empty brand_name raises ConfigValidationError."""
        config_data = {"brand_name": ""}
        
        with pytest.raises(ConfigValidationError) as exc_info:
            BrandConfiguration(config_data)
        
        assert "brand_name cannot be empty" in str(exc_info.value)

    def test_invalid_url_format_raises_error(self):
        """Test that invalid URL format raises ConfigValidationError."""
        config_data = {
            "brand_name": "TestBrand",
            "website_url": "not-a-valid-url"
        }
        
        with pytest.raises(ConfigValidationError) as exc_info:
            BrandConfiguration(config_data)
        
        assert "Invalid URL format" in str(exc_info.value)

    def test_nonexistent_assets_directory_raises_error(self):
        """Test that nonexistent assets directory raises ConfigValidationError."""
        config_data = {
            "brand_name": "TestBrand",
            "new_assets_dir": "/nonexistent/path"
        }
        
        with pytest.raises(ConfigValidationError) as exc_info:
            BrandConfiguration(config_data)
        
        assert "Assets directory does not exist" in str(exc_info.value)

    def test_special_characters_in_brand_name_validation(self):
        """Test validation of special characters in brand name."""
        invalid_names = ["Brand@Name", "Brand Name", "Brand/Name", "Brand\\Name"]
        
        for invalid_name in invalid_names:
            config_data = {"brand_name": invalid_name}
            with pytest.raises(ConfigValidationError) as exc_info:
                BrandConfiguration(config_data)
            
            assert "Brand name contains invalid characters" in str(exc_info.value)

    def test_brand_name_length_validation(self):
        """Test brand name length validation."""
        # Test too short
        with pytest.raises(ConfigValidationError) as exc_info:
            BrandConfiguration({"brand_name": "A"})
        assert "Brand name must be between 2 and 50 characters" in str(exc_info.value)
        
        # Test too long
        long_name = "A" * 51
        with pytest.raises(ConfigValidationError) as exc_info:
            BrandConfiguration({"brand_name": long_name})
        assert "Brand name must be between 2 and 50 characters" in str(exc_info.value)

    def test_adentic_specific_validation_rules(self):
        """Test Adentic-specific validation rules."""
        config = BrandConfiguration(self.valid_adentic_config)
        
        # Test that Adentic configuration has specific requirements
        assert config.validate_adentic_requirements() is True
        
        # Test specific Adentic branding values
        assert "adentic" in config.website_url.lower()
        assert "adentic" in config.github_url.lower()
        assert config.brand_name == "Adentic"

    def test_configuration_serialization(self):
        """Test configuration can be serialized to dict/JSON."""
        config = BrandConfiguration(self.valid_adentic_config)
        serialized = config.to_dict()
        
        assert isinstance(serialized, dict)
        assert serialized["brand_name"] == "Adentic"
        assert serialized["product_name"] == "Assistant"
        
        # Test JSON serialization
        json_str = json.dumps(serialized)
        assert isinstance(json_str, str)
        assert "Adentic" in json_str

    def test_configuration_from_file(self):
        """Test loading configuration from JSON file."""
        # This will test the class method when implemented
        with patch("pathlib.Path.exists", return_value=True):
            with patch("pathlib.Path.read_text", return_value=json.dumps(self.valid_adentic_config)):
                config = BrandConfiguration.from_file("config.json")
                assert config.brand_name == "Adentic"

    def test_configuration_validation_with_environment_variables(self):
        """Test configuration validation with environment variable substitution."""
        config_data = {
            "brand_name": "Adentic",
            "website_url": "${ADENTIC_WEBSITE_URL}",
            "github_url": "${ADENTIC_GITHUB_URL}"
        }
        
        with patch.dict("os.environ", {
            "ADENTIC_WEBSITE_URL": "https://adentic.ai/",
            "ADENTIC_GITHUB_URL": "https://github.com/adentic-ai/"
        }):
            config = BrandConfiguration(config_data)
            assert config.website_url == "https://adentic.ai/"
            assert config.github_url == "https://github.com/adentic-ai/"

    def test_get_text_replacements_for_adentic(self):
        """Test generation of text replacement patterns for Adentic."""
        config = BrandConfiguration(self.valid_adentic_config)
        replacements = config.get_text_replacements()
        
        assert isinstance(replacements, list)
        assert len(replacements) > 0
        
        # Check for specific Adentic replacements
        replacement_dict = dict(replacements)
        assert replacement_dict.get("Adentic") == "Adentic"
        assert replacement_dict.get("Adentic") == "Assistant"
        assert replacement_dict.get("https://adentic.so/") == "https://adentic.ai/"

    def test_get_image_replacement_mapping(self):
        """Test generation of image replacement mapping."""
        config = BrandConfiguration(self.valid_adentic_config)
        mapping = config.get_image_replacement_mapping()
        
        assert isinstance(mapping, dict)
        # Should contain mappings for logo files, favicon, etc.
        assert any("logo" in key.lower() for key in mapping.keys())
        assert any("favicon" in key.lower() for key in mapping.keys())

    def test_configuration_equality(self):
        """Test configuration equality comparison."""
        config1 = BrandConfiguration(self.valid_adentic_config)
        config2 = BrandConfiguration(self.valid_adentic_config.copy())
        config3 = BrandConfiguration(self.minimal_config)
        
        assert config1 == config2
        assert config1 != config3

    def test_configuration_repr(self):
        """Test configuration string representation."""
        config = BrandConfiguration(self.minimal_config)
        repr_str = repr(config)
        
        assert "BrandConfiguration" in repr_str
        assert "TestBrand" in repr_str