"""
Unit tests for text replacement functionality in the rebranding system.
These tests will fail until the rebrand module is properly refactored.
"""

import pytest
import tempfile
from pathlib import Path
from unittest.mock import Mock, patch, mock_open

# This import will fail initially since we need to refactor rebrand.py
from rebrand import TextReplacer, BrandConfiguration, ReplacementError


class TestTextReplacer:
    """Test suite for TextReplacer class."""

    def setup_method(self):
        """Set up test fixtures."""
        self.adentic_config = BrandConfiguration({
            "brand_name": "Adentic",
            "product_name": "Assistant",
            "company_name": "Adentic AI",
            "full_product_name": "Adentic Assistant",
            "website_url": "https://adentic.ai/",
            "twitter_url": "https://x.com/adenticai",
            "github_url": "https://github.com/adentic-ai/",
            "linkedin_url": "https://www.linkedin.com/company/adentic/"
        })
        
        self.text_replacer = TextReplacer(self.adentic_config)
        
        self.sample_file_content = """
        # TryAdentic Platform
        
        Welcome to Adentic, the AI assistant by TryAdentic.
        Visit us at https://adentic.so/ for more information.
        
        ## Configuration
        ADENTIC_ADMIN_API_KEY=secret123
        
        Check out our GitHub: https://github.com/adentic-ai/adentic
        Follow us on Twitter: https://x.com/adenticai
        """
        
        self.expected_replaced_content = """
        # Adentic AI Platform
        
        Welcome to Assistant, the AI assistant by Adentic AI.
        Visit us at https://adentic.ai/ for more information.
        
        ## Configuration
        ADENTIC_ADMIN_API_KEY=secret123
        
        Check out our GitHub: https://github.com/adentic-ai/adentic
        Follow us on Twitter: https://x.com/adenticai
        """

    def test_get_replacement_patterns_for_adentic(self):
        """Test generation of replacement patterns for Adentic branding."""
        patterns = self.text_replacer.get_replacement_patterns()
        
        assert isinstance(patterns, list)
        assert len(patterns) > 0
        
        # Convert to dict for easier testing
        pattern_dict = dict(patterns)
        
        # Test specific Adentic replacements
        assert pattern_dict["Adentic"] == "Adentic"
        assert pattern_dict["Adentic"] == "Assistant"
        assert pattern_dict["TryAdentic"] == "Adentic AI"
        assert pattern_dict["https://adentic.so/"] == "https://adentic.ai/"
        assert pattern_dict["https://x.com/adenticai"] == "https://x.com/adenticai"
        assert pattern_dict["ADENTIC_ADMIN_API_KEY"] == "ADENTIC_ADMIN_API_KEY"

    def test_case_sensitive_replacements(self):
        """Test that replacements handle different cases correctly."""
        patterns = self.text_replacer.get_replacement_patterns()
        pattern_dict = dict(patterns)
        
        # Test different cases
        assert pattern_dict["adentic"] == "adentic"
        assert pattern_dict["ADENTIC"] == "ADENTIC"
        assert pattern_dict["Adentic"] == "Adentic"
        assert pattern_dict["adentic"] == "assistant"
        assert pattern_dict["ADENTIC"] == "ASSISTANT"
        assert pattern_dict["Adentic"] == "Assistant"

    def test_replace_text_in_string(self):
        """Test replacing text in a string."""
        result = self.text_replacer.replace_text_in_string(self.sample_file_content)
        
        assert "Adentic AI Platform" in result
        assert "Assistant" in result
        assert "https://adentic.ai/" in result
        assert "ADENTIC_ADMIN_API_KEY" in result
        assert "https://x.com/adenticai" in result
        
        # Ensure old values are gone
        assert "Adentic" not in result
        assert "Adentic" not in result
        assert "https://adentic.so/" not in result
        assert "ADENTIC_ADMIN_API_KEY" not in result

    def test_replace_text_in_file(self):
        """Test replacing text in a file."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as tmp:
            tmp.write(self.sample_file_content)
            tmp_path = Path(tmp.name)
        
        try:
            changes = self.text_replacer.replace_text_in_file(tmp_path)
            
            assert len(changes) > 0
            
            # Verify file was modified
            modified_content = tmp_path.read_text()
            assert "Adentic AI Platform" in modified_content
            assert "Assistant" in modified_content
            assert "Adentic" not in modified_content
            
        finally:
            tmp_path.unlink()

    def test_replace_text_in_file_dry_run(self):
        """Test replacing text in file with dry run mode."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as tmp:
            tmp.write(self.sample_file_content)
            tmp_path = Path(tmp.name)
        
        try:
            original_content = tmp_path.read_text()
            
            text_replacer = TextReplacer(self.adentic_config, dry_run=True)
            changes = text_replacer.replace_text_in_file(tmp_path)
            
            assert len(changes) > 0
            
            # Verify file was NOT modified in dry run
            current_content = tmp_path.read_text()
            assert current_content == original_content
            
        finally:
            tmp_path.unlink()

    def test_replace_text_in_file_no_changes_needed(self):
        """Test replacing text in file that doesn't contain target patterns."""
        content_without_brand = "This is a generic file with no brand references."
        
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as tmp:
            tmp.write(content_without_brand)
            tmp_path = Path(tmp.name)
        
        try:
            changes = self.text_replacer.replace_text_in_file(tmp_path)
            assert len(changes) == 0
            
        finally:
            tmp_path.unlink()

    def test_replace_text_in_file_with_encoding_issues(self):
        """Test handling files with encoding issues."""
        # Create a file with non-UTF8 content
        with tempfile.NamedTemporaryFile(mode='wb', suffix='.py', delete=False) as tmp:
            # Write some binary data that's not valid UTF-8
            tmp.write(b'\xff\xfe invalid utf-8 \x80 Adentic')
            tmp_path = Path(tmp.name)
        
        try:
            with pytest.raises(ReplacementError) as exc_info:
                self.text_replacer.replace_text_in_file(tmp_path)
            
            assert "encoding" in str(exc_info.value).lower()
            
        finally:
            tmp_path.unlink()

    def test_replace_text_in_file_permission_denied(self):
        """Test handling files with permission issues."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as tmp:
            tmp.write(self.sample_file_content)
            tmp_path = Path(tmp.name)
        
        try:
            # Make file read-only
            tmp_path.chmod(0o444)
            
            with pytest.raises(ReplacementError) as exc_info:
                self.text_replacer.replace_text_in_file(tmp_path)
            
            assert "permission" in str(exc_info.value).lower()
            
        finally:
            tmp_path.chmod(0o666)  # Restore permissions for cleanup
            tmp_path.unlink()

    def test_get_file_patterns_to_process(self):
        """Test getting file patterns that should be processed."""
        patterns = self.text_replacer.get_file_patterns_to_process()
        
        assert isinstance(patterns, list)
        assert "**/*.py" in patterns
        assert "**/*.ts" in patterns
        assert "**/*.tsx" in patterns
        assert "**/*.js" in patterns
        assert "**/*.jsx" in patterns
        assert "**/*.json" in patterns
        assert "**/*.md" in patterns
        assert "**/*.yaml" in patterns
        assert "**/*.yml" in patterns
        assert "**/*.env*" in patterns
        assert "**/*.html" in patterns

    def test_should_skip_file(self):
        """Test file exclusion logic."""
        # Files that should be skipped
        skip_files = [
            Path("node_modules/package.json"),
            Path(".git/config"),
            Path("dist/app.js"),
            Path("build/main.js"),
            Path(".next/static/chunks/app.js"),
            Path("__pycache__/module.py"),
            Path("venv/lib/python3.9/site-packages/requests.py"),
            Path(".venv/bin/activate"),
            Path("backup_rebrand_20231201_120000/file.py"),
            Path("rebrand.py")  # The script itself
        ]
        
        for file_path in skip_files:
            assert self.text_replacer.should_skip_file(file_path) is True
        
        # Files that should NOT be skipped
        process_files = [
            Path("src/app.py"),
            Path("frontend/components/Header.tsx"),
            Path("backend/api.py"),
            Path("README.md"),
            Path("package.json"),
            Path(".env.example")
        ]
        
        for file_path in process_files:
            assert self.text_replacer.should_skip_file(file_path) is False

    def test_process_directory_tree(self):
        """Test processing an entire directory tree."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            # Create test files
            (tmp_path / "app.py").write_text("print('Welcome to Adentic')")
            (tmp_path / "README.md").write_text("# Adentic AI Assistant")
            (tmp_path / "config.json").write_text('{"app_name": "TryAdentic"}')
            
            # Create subdirectory
            subdir = tmp_path / "components"
            subdir.mkdir()
            (subdir / "header.tsx").write_text("const title = 'TryAdentic';")
            
            # Create files that should be skipped
            node_modules = tmp_path / "node_modules"
            node_modules.mkdir()
            (node_modules / "package.json").write_text('{"name": "Adentic"}')
            
            changes = self.text_replacer.process_directory_tree(tmp_path)
            
            assert len(changes) > 0
            
            # Verify changes were made to included files
            assert "Adentic" in (tmp_path / "app.py").read_text()
            assert "Assistant" in (tmp_path / "README.md").read_text()
            assert "Adentic Assistant" in (tmp_path / "config.json").read_text()
            assert "Adentic AI" in (subdir / "header.tsx").read_text()
            
            # Verify excluded files were not changed
            assert "Adentic" in (node_modules / "package.json").read_text()

    def test_regex_pattern_replacements(self):
        """Test regex-based pattern replacements."""
        text_replacer = TextReplacer(self.adentic_config, use_regex=True)
        
        content = """
        const ADENTIC_CONFIG = {
            adentic_api_key: 'key123',
            adentic_version: '1.0.0'
        };
        """
        
        result = text_replacer.replace_text_in_string(content)
        
        assert "ADENTIC_CONFIG" in result
        assert "adentic_api_key" in result
        assert "assistant_version" in result

    def test_preserve_formatting_and_structure(self):
        """Test that text replacement preserves file formatting."""
        content_with_formatting = """
        {
            "name": "Adentic",
            "description": "Adentic AI Assistant by TryAdentic",
            "version": "1.0.0",
            "url": "https://adentic.so/"
        }
        """
        
        result = self.text_replacer.replace_text_in_string(content_with_formatting)
        
        # Should maintain JSON structure
        assert result.count('{') == content_with_formatting.count('{')
        assert result.count('}') == content_with_formatting.count('}')
        assert result.count('"') == content_with_formatting.count('"')
        
        # But content should be updated
        assert "Adentic" in result
        assert "Assistant" in result
        assert "https://adentic.ai/" in result

    def test_special_replacement_contexts(self):
        """Test replacements in special contexts like URLs and code."""
        content = """
        // API endpoint
        const API_URL = 'https://api.adentic.so/v1/chat';
        
        // Environment variable
        process.env.ADENTIC_API_KEY
        
        // Class name
        class AdenticAgent {
            constructor() {
                this.name = 'Adentic';
            }
        }
        
        // Documentation link
        [Adentic Documentation](https://docs.adentic.so)
        """
        
        result = self.text_replacer.replace_text_in_string(content)
        
        assert "https://api.adentic.ai/v1/chat" in result
        assert "ADENTIC_API_KEY" in result
        assert "AdenticAgent" in result
        assert "Assistant" in result
        assert "[Assistant Documentation]" in result

    def test_replacement_statistics(self):
        """Test tracking of replacement statistics."""
        changes = self.text_replacer.replace_text_in_string(self.sample_file_content)
        stats = self.text_replacer.get_replacement_statistics()
        
        assert isinstance(stats, dict)
        assert "total_replacements" in stats
        assert "replacements_by_pattern" in stats
        assert stats["total_replacements"] > 0
        
        # Check specific pattern counts
        pattern_stats = stats["replacements_by_pattern"]
        assert pattern_stats.get("Adentic", 0) > 0
        assert pattern_stats.get("Adentic", 0) > 0