"""
Tests for SetupWizard class.
"""

import os
import pytest
from unittest.mock import patch, MagicMock

from setup.wizard import SetupWizard
from setup.config.schema import SetupMethod


class TestSetupWizard:
    """Tests for SetupWizard class."""

    def test_initialization(self, isolated_env):
        wizard = SetupWizard(
            root_dir=isolated_env,
            quiet=True,
        )
        assert wizard.root_dir == isolated_env
        assert wizard.config is not None
        assert wizard.console is not None
        assert len(wizard.steps) > 0

    def test_method_override(self, isolated_env):
        wizard = SetupWizard(
            root_dir=isolated_env,
            method_override="docker",
            quiet=True,
        )
        assert wizard.config.setup_method == SetupMethod.DOCKER

    def test_steps_initialized(self, isolated_env):
        wizard = SetupWizard(
            root_dir=isolated_env,
            quiet=True,
        )
        # Check all expected steps are initialized
        assert "setup_method" in wizard.steps
        assert "requirements" in wizard.steps
        assert "supabase" in wizard.steps
        assert "daytona" in wizard.steps
        assert "environment" in wizard.steps

    def test_get_steps_in_order(self, isolated_env):
        wizard = SetupWizard(
            root_dir=isolated_env,
            quiet=True,
        )
        steps = wizard._get_steps_in_order()

        # Verify steps are sorted by order
        orders = [s.order for s in steps]
        assert orders == sorted(orders)

    def test_is_setup_complete_false(self, isolated_env):
        wizard = SetupWizard(
            root_dir=isolated_env,
            quiet=True,
        )
        # No env files created yet
        assert wizard._is_setup_complete() is False

    def test_is_setup_complete_true(self, isolated_env, mock_config):
        # Create required env files
        backend_env = os.path.join(isolated_env, "backend", ".env")
        frontend_env = os.path.join(isolated_env, "apps", "frontend", ".env.local")

        with open(backend_env, "w") as f:
            f.write("SUPABASE_URL=https://test.supabase.co\n")
            f.write("ENCRYPTION_KEY=test-key\n")

        with open(frontend_env, "w") as f:
            f.write("NEXT_PUBLIC_SUPABASE_URL=https://test.supabase.co\n")

        wizard = SetupWizard(
            root_dir=isolated_env,
            quiet=True,
        )
        assert wizard._is_setup_complete() is True

    def test_run_single_step_unknown(self, isolated_env):
        wizard = SetupWizard(
            root_dir=isolated_env,
            quiet=True,
        )
        result = wizard.run_single_step("nonexistent_step")
        assert result != 0  # Should return error code

    @patch('builtins.input', return_value='')
    def test_show_config_status(self, mock_input, isolated_env, mock_config):
        wizard = SetupWizard(
            root_dir=isolated_env,
            quiet=True,
        )
        wizard.config = mock_config

        # Should not raise
        wizard._show_config_status()
