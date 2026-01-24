"""
Tests for configuration loader.
"""

import os
import json
import pytest
from setup.config.loader import ConfigLoader
from setup.config.schema import SetupMethod


class TestConfigLoader:
    """Tests for ConfigLoader class."""

    def test_parse_env_file(self, isolated_env):
        # Create a test .env file
        env_path = os.path.join(isolated_env, "backend", ".env")
        with open(env_path, "w") as f:
            f.write("KEY1=value1\n")
            f.write("KEY2=value2\n")
            f.write("# Comment line\n")
            f.write("KEY3=\"quoted value\"\n")
            f.write("KEY4='single quoted'\n")
            f.write("\n")  # Empty line

        loader = ConfigLoader(isolated_env)
        env_vars = loader.parse_env_file(os.path.join("backend", ".env"))

        assert env_vars["KEY1"] == "value1"
        assert env_vars["KEY2"] == "value2"
        assert env_vars["KEY3"] == "quoted value"
        assert env_vars["KEY4"] == "single quoted"
        assert "#" not in env_vars  # Comment should not be parsed

    def test_parse_nonexistent_file(self, temp_dir):
        loader = ConfigLoader(temp_dir)
        env_vars = loader.parse_env_file("nonexistent.env")
        assert env_vars == {}

    def test_load_progress_empty(self, isolated_env):
        loader = ConfigLoader(isolated_env)
        progress = loader.load_progress()
        assert progress["current_step"] == 0
        assert progress["data"] == {}

    def test_save_and_load_progress(self, isolated_env):
        loader = ConfigLoader(isolated_env)

        # Save progress
        loader.save_progress(5, {"setup_method": "docker", "test": "value"})

        # Load progress
        progress = loader.load_progress()
        assert progress["current_step"] == 5
        assert progress["data"]["setup_method"] == "docker"
        assert progress["data"]["test"] == "value"

    def test_reset_progress(self, isolated_env):
        loader = ConfigLoader(isolated_env)

        # Save some progress
        loader.save_progress(5, {"test": "value"})

        # Reset
        loader.reset_progress()

        # Check it's cleared
        progress = loader.load_progress()
        assert progress["current_step"] == 0
        assert progress["data"] == {}

    def test_load_from_config_file_json(self, isolated_env):
        # Create a JSON config file
        config_path = os.path.join(isolated_env, "config.json")
        with open(config_path, "w") as f:
            json.dump({
                "setup_method": "docker",
                "supabase": {
                    "SUPABASE_URL": "https://test.supabase.co"
                }
            }, f)

        loader = ConfigLoader(isolated_env)
        config_data = loader.load_from_config_file(config_path)

        assert config_data is not None
        assert config_data["setup_method"] == "docker"
        assert config_data["supabase"]["SUPABASE_URL"] == "https://test.supabase.co"

    def test_load_config_merges_sources(self, isolated_env):
        # Create backend .env with some values
        backend_env = os.path.join(isolated_env, "backend", ".env")
        with open(backend_env, "w") as f:
            f.write("SUPABASE_URL=https://env.supabase.co\n")
            f.write("OPENAI_API_KEY=sk-from-env\n")

        # Create progress file with different values
        progress_path = os.path.join(isolated_env, ".setup_progress")
        with open(progress_path, "w") as f:
            json.dump({
                "step": 3,
                "data": {
                    "supabase": {
                        "SUPABASE_URL": "https://progress.supabase.co"
                    }
                }
            }, f)

        loader = ConfigLoader(isolated_env)
        config = loader.load_config()

        # Progress should override env file
        assert config.supabase.SUPABASE_URL == "https://progress.supabase.co"
        # env file value should be preserved where not overridden
        assert config.llm.OPENAI_API_KEY == "sk-from-env"

    def test_export_config_json(self, isolated_env, mock_config):
        loader = ConfigLoader(isolated_env)
        output_path = os.path.join(isolated_env, "export.json")

        loader.export_config(mock_config, output_path)

        assert os.path.exists(output_path)
        with open(output_path, "r") as f:
            data = json.load(f)
        assert data["setup_method"] == "manual"
        assert data["supabase"]["SUPABASE_URL"] == "https://test.supabase.co"
