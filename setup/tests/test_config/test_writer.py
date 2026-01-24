"""
Tests for configuration writer.
"""

import os
import pytest
from setup.config.writer import ConfigWriter
from setup.config.schema import SetupMethod


class TestConfigWriter:
    """Tests for ConfigWriter class."""

    def test_format_env_content(self, isolated_env):
        writer = ConfigWriter(isolated_env)
        content = writer._format_env_content(
            {"KEY1": "value1", "KEY2": "value2"},
            header="Test header"
        )

        assert "# Test header" in content
        assert "KEY1=value1" in content
        assert "KEY2=value2" in content

    def test_write_backend_env(self, isolated_env, mock_config):
        writer = ConfigWriter(isolated_env)
        success, error = writer.write_backend_env(mock_config)

        assert success is True
        assert error == ""

        # Check file was created
        env_path = os.path.join(isolated_env, "backend", ".env")
        assert os.path.exists(env_path)

        # Check content
        with open(env_path, "r") as f:
            content = f.read()
        assert "SUPABASE_URL=https://test.supabase.co" in content
        assert "ENCRYPTION_KEY=" in content

    def test_write_frontend_env(self, isolated_env, mock_config):
        writer = ConfigWriter(isolated_env)
        success, error = writer.write_frontend_env(mock_config)

        assert success is True

        env_path = os.path.join(isolated_env, "apps", "frontend", ".env.local")
        assert os.path.exists(env_path)

        with open(env_path, "r") as f:
            content = f.read()
        assert "NEXT_PUBLIC_SUPABASE_URL=https://test.supabase.co" in content

    def test_write_mobile_env(self, isolated_env, mock_config):
        writer = ConfigWriter(isolated_env)
        success, error = writer.write_mobile_env(mock_config)

        assert success is True

        env_path = os.path.join(isolated_env, "apps", "mobile", ".env")
        assert os.path.exists(env_path)

    def test_write_root_env_for_docker(self, isolated_env, mock_config):
        mock_config.setup_method = SetupMethod.DOCKER
        writer = ConfigWriter(isolated_env)
        success, error = writer.write_root_env(mock_config)

        assert success is True

        env_path = os.path.join(isolated_env, ".env")
        assert os.path.exists(env_path)

        with open(env_path, "r") as f:
            content = f.read()
        assert "Docker Compose" in content

    def test_dry_run_mode(self, isolated_env, mock_config):
        writer = ConfigWriter(isolated_env, dry_run=True)
        result = writer.write_all(mock_config)

        # Should accumulate changes without writing
        assert result.success is True
        assert len(result.changes) > 0

        # Files should NOT exist
        env_path = os.path.join(isolated_env, "backend", ".env")
        assert not os.path.exists(env_path)

    def test_write_all_success(self, isolated_env, mock_config):
        writer = ConfigWriter(isolated_env)
        result = writer.write_all(mock_config)

        assert result.success is True
        assert "backend/.env" in result.files_written
        assert "apps/frontend/.env.local" in result.files_written
        assert "apps/mobile/.env" in result.files_written

    def test_get_preview(self, isolated_env, mock_config):
        writer = ConfigWriter(isolated_env, dry_run=True)
        writer.write_all(mock_config)

        preview = writer.get_preview()
        assert len(preview) > 0
        assert all(hasattr(change, "path") and hasattr(change, "content") for change in preview)
