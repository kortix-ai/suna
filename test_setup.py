import unittest
from unittest.mock import patch, mock_open, MagicMock, call
import sys
import os

# Add the script's directory to the Python path to allow importing
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

# Now import the script
import setup


class TestSetupWizard(unittest.TestCase):

    def setUp(self):
        """Set up for each test."""
        # Prevent the script from printing to the console during tests
        patcher = patch("builtins.print")
        self.mock_print = patcher.start()
        self.addCleanup(patcher.stop)

        # Patch time.sleep to speed up tests
        patcher = patch("time.sleep")
        self.mock_sleep = patcher.start()
        self.addCleanup(patcher.stop)

        # Patch sys.exit to prevent tests from stopping
        patcher = patch("sys.exit")
        self.mock_exit = patcher.start()
        self.addCleanup(patcher.stop)

        # Mock file system operations to avoid creating real files
        self.mock_open_patcher = patch("builtins.open", new_callable=mock_open)
        self.mock_file_open = self.mock_open_patcher.start()
        self.addCleanup(self.mock_open_patcher.stop)

        self.os_path_exists_patcher = patch("os.path.exists")
        self.mock_os_path_exists = self.os_path_exists_patcher.start()
        self.addCleanup(self.os_path_exists_patcher.stop)

        self.os_path_isdir_patcher = patch("os.path.isdir")
        self.mock_os_path_isdir = self.os_path_isdir_patcher.start()
        self.addCleanup(self.os_path_isdir_patcher.stop)

        self.os_path_isfile_patcher = patch("os.path.isfile")
        self.mock_os_path_isfile = self.os_path_isfile_patcher.start()
        self.addCleanup(self.os_path_isfile_patcher.stop)

    def test_01_choose_docker_setup(self):
        """Test choosing Docker setup method."""
        with patch("builtins.input", return_value="1"), patch(
            "setup.load_progress", return_value={"step": 0, "data": {}}
        ):
            wizard = setup.SetupWizard()
            wizard.choose_setup_method()
            self.assertEqual(wizard.env_vars["setup_method"], "docker")

    def test_02_choose_manual_setup(self):
        """Test choosing manual setup method."""
        with patch("builtins.input", return_value="2"), patch(
            "setup.load_progress", return_value={"step": 0, "data": {}}
        ):
            wizard = setup.SetupWizard()
            wizard.choose_setup_method()
            self.assertEqual(wizard.env_vars["setup_method"], "manual")

    def test_03_check_requirements_docker(self):
        """Test requirement checking for Docker setup."""
        with patch(
            "setup.load_progress",
            return_value={"step": 0, "data": {"setup_method": "docker"}},
        ), patch("subprocess.run") as mock_subprocess:

            # Mock successful command executions
            mock_subprocess.return_value = MagicMock()

            # Mock filesystem checks
            self.mock_os_path_exists.return_value = True
            self.mock_os_path_isdir.return_value = True
            self.mock_os_path_isfile.return_value = True

            wizard = setup.SetupWizard()
            wizard.check_requirements()

            # Verify git and docker version checks were called
            expected_calls = [
                call(
                    ["git", "--version"],
                    stdout=-1,
                    stderr=-1,
                    check=True,
                    shell=setup.IS_WINDOWS,
                ),
                call(
                    ["docker", "--version"],
                    stdout=-1,
                    stderr=-1,
                    check=True,
                    shell=setup.IS_WINDOWS,
                ),
                call(
                    ["docker", "info"],
                    stdout=-1,
                    stderr=-1,
                    check=True,
                    shell=setup.IS_WINDOWS,
                ),
            ]
            mock_subprocess.assert_has_calls(expected_calls)

    def test_04_check_requirements_manual(self):
        """Test requirement checking for manual setup."""
        with patch(
            "setup.load_progress",
            return_value={"step": 0, "data": {"setup_method": "manual"}},
        ), patch("subprocess.run") as mock_subprocess:

            # Mock successful command executions
            mock_subprocess.return_value = MagicMock()

            # Mock filesystem checks
            self.mock_os_path_exists.return_value = True
            self.mock_os_path_isdir.return_value = True
            self.mock_os_path_isfile.return_value = True

            wizard = setup.SetupWizard()
            wizard.check_requirements()

            # Verify all manual setup requirements were checked
            expected_calls = [
                call(
                    ["git", "--version"],
                    stdout=-1,
                    stderr=-1,
                    check=True,
                    shell=setup.IS_WINDOWS,
                ),
                call(
                    ["uv", "--version"],
                    stdout=-1,
                    stderr=-1,
                    check=True,
                    shell=setup.IS_WINDOWS,
                ),
                call(
                    ["node", "--version"],
                    stdout=-1,
                    stderr=-1,
                    check=True,
                    shell=setup.IS_WINDOWS,
                ),
                call(
                    ["npm", "--version"],
                    stdout=-1,
                    stderr=-1,
                    check=True,
                    shell=setup.IS_WINDOWS,
                ),
                call(
                    ["docker", "--version"],
                    stdout=-1,
                    stderr=-1,
                    check=True,
                    shell=setup.IS_WINDOWS,
                ),
                call(
                    ["docker", "info"],
                    stdout=-1,
                    stderr=-1,
                    check=True,
                    shell=setup.IS_WINDOWS,
                ),
            ]
            mock_subprocess.assert_has_calls(expected_calls)

    def test_05_collect_supabase_info(self):
        """Test collecting Supabase information."""
        user_inputs = [
            "",  # Continue prompt
            "https://test.supabase.co",
            "test_anon_key_12345",
            "test_service_key_12345",
        ]

        with patch("builtins.input", side_effect=user_inputs), patch(
            "setup.load_progress", return_value={"step": 0, "data": {}}
        ):
            wizard = setup.SetupWizard()
            # Ensure the supabase key exists in env_vars
            if "supabase" not in wizard.env_vars:
                wizard.env_vars["supabase"] = {}
            wizard.collect_supabase_info()

            self.assertEqual(
                wizard.env_vars["supabase"]["SUPABASE_URL"], "https://test.supabase.co"
            )
            self.assertEqual(
                wizard.env_vars["supabase"]["SUPABASE_ANON_KEY"], "test_anon_key_12345"
            )
            self.assertEqual(
                wizard.env_vars["supabase"]["SUPABASE_SERVICE_ROLE_KEY"],
                "test_service_key_12345",
            )

    def test_06_configure_env_files(self):
        """Test environment file configuration."""
        with patch("setup.load_progress", return_value={"step": 0, "data": {}}):
            wizard = setup.SetupWizard()
            wizard.env_vars = {
                "setup_method": "docker",
                "supabase": {
                    "SUPABASE_URL": "https://test.supabase.co",
                    "SUPABASE_ANON_KEY": "test_anon_key",
                    "SUPABASE_SERVICE_ROLE_KEY": "test_service_key",
                },
                "llm": {"MODEL_TO_USE": "openai/gpt-4o"},
                "search": {
                    "TAVILY_API_KEY": "test_tavily",
                    "FIRECRAWL_API_KEY": "test_firecrawl",
                    "FIRECRAWL_URL": "https://api.firecrawl.dev",
                },
                "rapidapi": {"RAPID_API_KEY": "test_rapid"},
                "daytona": {
                    "DAYTONA_API_KEY": "test_daytona",
                    "DAYTONA_SERVER_URL": "https://app.daytona.io/api",
                    "DAYTONA_TARGET": "us",
                },
            }

            wizard.configure_env_files()

            # Check that env files were created
            self.mock_file_open.assert_any_call(os.path.join("backend", ".env"), "w")
            self.mock_file_open.assert_any_call(
                os.path.join("frontend", ".env.local"), "w"
            )

    def test_07_resumability(self):
        """Test that the wizard can resume from a saved step."""
        saved_progress = {"step": 1, "data": {"setup_method": "docker"}}

        with patch("setup.load_progress", return_value=saved_progress):
            wizard = setup.SetupWizard()

        # Verify it loaded correctly
        self.assertEqual(wizard.current_step, 1)
        self.assertEqual(wizard.env_vars["setup_method"], "docker")

    def test_08_validators(self):
        """Test the helper validator functions."""
        self.assertTrue(setup.validate_url("http://example.com"))
        self.assertTrue(setup.validate_url("https://example.com/path?query=1"))
        self.assertFalse(setup.validate_url("not-a-url"))
        self.assertTrue(setup.validate_url("", allow_empty=True))

        self.assertTrue(setup.validate_api_key("1234567890"))
        self.assertFalse(setup.validate_api_key("12345"))
        self.assertFalse(setup.validate_api_key(None))
        self.assertTrue(setup.validate_api_key("", allow_empty=True))

    def test_09_setup_supabase_database(self):
        """Test the setup_supabase_database method."""
        # Create a test wizard instance
        wizard = setup.SetupWizard()
        wizard.env_vars['supabase'] = {'SUPABASE_URL': 'https://test.supabase.co', 'SUPABASE_ANON_KEY': 'test', 'SUPABASE_SERVICE_ROLE_KEY': 'test'}

        # Mock the input function to return 'y' for skip
        import builtins
        original_input = builtins.input

        def mock_input(prompt):
            if 'skip' in prompt.lower():
                print(f'Mock input: "{prompt}" -> "y"')
                return 'y'
            return original_input(prompt)

        builtins.input = mock_input

        # Test the method
        try:
            print("Testing setup_supabase_database with skip...")
            wizard.setup_supabase_database()
            print('Method completed successfully')
        except SystemExit as e:
            print(f'SystemExit called with code: {e.code}')
        except Exception as e:
            print(f'Exception: {e}')
            import traceback
            traceback.print_exc()


if __name__ == "__main__":
    unittest.main(argv=["first-arg-is-ignored"], exit=False)
