import pytest
from unittest.mock import patch, MagicMock

# This test will fail until brand.py is created
class TestEmailBrandConfig:
    def test_email_brand_config_loads(self):
        """Test that EmailBrandConfig is properly configured"""
        from backend.core.config.brand import EmailBrandConfig

        config = EmailBrandConfig()

        assert config.brand_name == "Adentic"
        assert config.primary_color == "#CC3A00"
        assert config.copyright_text == "© 2025 Adentic. All rights reserved."
        assert "adentic" in config.logo_url.lower()

    def test_email_templates_use_brand_config(self):
        """Test that email templates use the brand configuration"""
        from backend.core.config.brand import EmailBrandConfig

        config = EmailBrandConfig()

        # Mock email template rendering
        with patch('backend.core.services.email.render_template') as mock_render:
            mock_render.return_value = f"""
            <html>
                <body style="color: {config.primary_color}">
                    <h1>{config.brand_name}</h1>
                    <footer>{config.copyright_text}</footer>
                </body>
            </html>
            """

            rendered = mock_render()

            assert "Adentic" in rendered
            assert "#CC3A00" in rendered
            assert "© 2025 Adentic. All rights reserved." in rendered

    def test_brand_name_not_kortix(self):
        """Ensure Adentic has been replaced with Adentic"""
        from backend.core.config.brand import EmailBrandConfig

        config = EmailBrandConfig()

        assert "Adentic" not in config.brand_name
        assert "Adentic" not in config.copyright_text
        assert config.brand_name == "Adentic"