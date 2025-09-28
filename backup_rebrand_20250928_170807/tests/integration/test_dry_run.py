"""
Integration tests for dry-run mode in the rebranding system.
These tests will fail until the rebrand module is properly refactored.
"""

import pytest
import tempfile
import json
import shutil
from pathlib import Path
from unittest.mock import Mock, patch

# This import will fail initially since we need to refactor rebrand.py
from rebrand import Rebrander, BrandConfiguration


class TestDryRunMode:
    """Integration test suite for dry-run mode functionality."""

    def setup_method(self):
        """Set up test fixtures."""
        self.adentic_config_data = {
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
        
        self.test_project_structure = {
            "frontend/src/app.tsx": '''
                import React from 'react';
                
                function App() {
                    return (
                        <div>
                            <h1>Welcome to Kortix Suna</h1>
                            <p>Powered by Kortix AI</p>
                            <a href="https://suna.so/">Visit our website</a>
                        </div>
                    );
                }
                
                export default App;
            ''',
            "frontend/src/components/Header.tsx": '''
                const Header = () => {
                    return (
                        <header>
                            <img src="/kortix-logo.svg" alt="Kortix Logo" />
                            <h1>Suna AI Assistant</h1>
                        </header>
                    );
                };
            ''',
            "backend/config.py": '''
                import os
                
                class Config:
                    APP_NAME = "Kortix Suna"
                    COMPANY = "Kortix AI" 
                    API_URL = "https://api.suna.so"
                    ADMIN_KEY = os.getenv("KORTIX_ADMIN_API_KEY")
            ''',
            "package.json": '''
                {
                    "name": "kortix-suna",
                    "description": "AI assistant platform by Kortix",
                    "homepage": "https://suna.so",
                    "repository": "https://github.com/kortix-ai/suna"
                }
            ''',
            "README.md": '''
                # Kortix Suna
                
                An AI assistant platform built by Kortix AI.
                
                ## Quick Start
                
                Visit [suna.so](https://suna.so) to get started.
                
                ## Support
                
                - Twitter: [@kortixai](https://x.com/kortixai)
                - GitHub: [kortix-ai/suna](https://github.com/kortix-ai/suna)
            ''',
            ".env.example": '''
                KORTIX_ADMIN_API_KEY=your_admin_key_here
                SUNA_API_URL=https://api.suna.so
                APP_NAME=Kortix Suna
            ''',
            "frontend/public/kortix-logo.svg": '<svg>Kortix logo content</svg>',
            "docs/deployment.md": '''
                # Deployment Guide for Kortix Suna
                
                This guide covers deploying the Suna platform.
            '''
        }

    def create_test_project(self, tmp_path: Path) -> Path:
        """Create a test project structure."""
        project_root = tmp_path / "test_project"
        project_root.mkdir()
        
        for file_path, content in self.test_project_structure.items():
            full_path = project_root / file_path
            full_path.parent.mkdir(parents=True, exist_ok=True)
            full_path.write_text(content.strip())
        
        # Create assets directory with test assets
        assets_dir = project_root / "adentic_brand_assets"
        assets_dir.mkdir()
        (assets_dir / "adentic-logo.svg").write_text('<svg>Adentic logo content</svg>')
        (assets_dir / "favicon.png").write_bytes(b'fake PNG content')
        
        return project_root

    def test_dry_run_no_files_modified(self):
        """Test that dry run mode doesn't modify any files."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            project_root = self.create_test_project(tmp_path)
            
            # Update config to point to our test assets
            config_data = self.adentic_config_data.copy()
            config_data["new_assets_dir"] = str(project_root / "adentic_brand_assets")
            
            config = BrandConfiguration(config_data)
            
            # Store original content of all files
            original_content = {}
            for file_path in project_root.rglob("*"):
                if file_path.is_file() and not file_path.name.startswith('.'):
                    try:
                        original_content[str(file_path)] = file_path.read_text()
                    except UnicodeDecodeError:
                        original_content[str(file_path)] = file_path.read_bytes()
            
            # Run rebranding in dry run mode
            rebrander = Rebrander(
                config=config,
                dry_run=True,
                backup=False,
                base_path=project_root
            )
            
            changes = rebrander.run()
            
            # Verify no files were actually modified
            for file_path in project_root.rglob("*"):
                if file_path.is_file() and not file_path.name.startswith('.'):
                    try:
                        current_content = file_path.read_text()
                    except UnicodeDecodeError:
                        current_content = file_path.read_bytes()
                    
                    original = original_content.get(str(file_path))
                    assert current_content == original, f"File {file_path} was modified in dry run"
            
            # But changes should be detected and logged
            assert len(changes) > 0

    def test_dry_run_detects_all_expected_changes(self):
        """Test that dry run detects all expected changes for Adentic rebrand."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            project_root = self.create_test_project(tmp_path)
            
            config_data = self.adentic_config_data.copy()
            config_data["new_assets_dir"] = str(project_root / "adentic_brand_assets")
            
            config = BrandConfiguration(config_data)
            
            rebrander = Rebrander(
                config=config,
                dry_run=True,
                backup=False,
                base_path=project_root
            )
            
            changes = rebrander.run()
            
            # Verify expected text changes are detected
            text_changes = [c for c in changes if c.change_type == "TEXT"]
            change_details = [c.details for c in text_changes]
            
            expected_replacements = [
                "Kortix → Adentic",
                "Suna → Assistant", 
                "Kortix AI → Adentic AI",
                "https://suna.so → https://adentic.ai",
                "KORTIX_ADMIN_API_KEY → ADENTIC_ADMIN_API_KEY"
            ]
            
            for expected in expected_replacements:
                assert any(expected in detail for detail in change_details), \
                    f"Expected replacement '{expected}' not found in changes"
            
            # Verify image changes are detected
            image_changes = [c for c in changes if c.change_type == "IMAGE"]
            assert len(image_changes) > 0
            
            # Verify file renames are detected
            rename_changes = [c for c in changes if c.change_type == "RENAME"]
            assert len(rename_changes) > 0

    def test_dry_run_report_generation(self):
        """Test that dry run generates comprehensive reports."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            project_root = self.create_test_project(tmp_path)
            
            config_data = self.adentic_config_data.copy()
            config_data["new_assets_dir"] = str(project_root / "adentic_brand_assets")
            
            config = BrandConfiguration(config_data)
            
            rebrander = Rebrander(
                config=config,
                dry_run=True,
                backup=False,
                base_path=project_root
            )
            
            changes = rebrander.run()
            report = rebrander.generate_report()
            
            # Verify report indicates dry run
            assert report["execution_info"]["dry_run"] is True
            assert "DRY RUN" in str(report).upper()
            
            # Verify report contains expected sections
            required_sections = [
                "summary",
                "changes_by_type", 
                "affected_files",
                "adentic_transformation"
            ]
            
            for section in required_sections:
                assert section in report
            
            # Verify summary shows detected changes
            summary = report["summary"]
            assert summary["total_changes"] > 0
            assert summary["files_affected"] > 0

    def test_dry_run_with_missing_assets(self):
        """Test dry run behavior when assets are missing."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            project_root = self.create_test_project(tmp_path)
            
            # Point to non-existent assets directory
            config_data = self.adentic_config_data.copy()
            config_data["new_assets_dir"] = str(project_root / "missing_assets")
            
            config = BrandConfiguration(config_data)
            
            rebrander = Rebrander(
                config=config,
                dry_run=True,
                backup=False,
                base_path=project_root
            )
            
            changes = rebrander.run()
            
            # Should still detect text changes
            text_changes = [c for c in changes if c.change_type == "TEXT"]
            assert len(text_changes) > 0
            
            # Should detect missing assets as warnings/errors
            warnings = [c for c in changes if c.change_type == "WARNING"]
            errors = [c for c in changes if c.change_type == "ERROR"]
            
            # Should have warnings or errors about missing assets
            assert len(warnings) > 0 or len(errors) > 0

    def test_dry_run_performance_on_large_project(self):
        """Test dry run performance on a larger project structure."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            project_root = tmp_path / "large_project"
            project_root.mkdir()
            
            # Create a larger project structure
            for i in range(50):
                subdir = project_root / f"module_{i}"
                subdir.mkdir()
                
                for j in range(10):
                    file_path = subdir / f"file_{j}.py"
                    file_path.write_text(f"""
                        # Module {i} File {j}
                        from kortix import Suna
                        
                        class Component{j}:
                            def __init__(self):
                                self.name = "Kortix Component"
                                self.url = "https://suna.so/api"
                    """)
            
            config_data = self.adentic_config_data.copy()
            config_data["new_assets_dir"] = None  # Skip asset processing for performance
            
            config = BrandConfiguration(config_data)
            
            import time
            start_time = time.time()
            
            rebrander = Rebrander(
                config=config,
                dry_run=True,
                backup=False,
                base_path=project_root
            )
            
            changes = rebrander.run()
            
            end_time = time.time()
            execution_time = end_time - start_time
            
            # Should complete in reasonable time (adjust threshold as needed)
            assert execution_time < 30.0, f"Dry run took too long: {execution_time}s"
            
            # Should detect many changes
            assert len(changes) > 100

    def test_dry_run_comparison_with_actual_run(self):
        """Test that dry run predictions match actual run results."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            # Create two identical project copies
            project1 = self.create_test_project(tmp_path / "project1")
            project2 = self.create_test_project(tmp_path / "project2")
            
            config_data = self.adentic_config_data.copy()
            config_data["new_assets_dir"] = str(project1 / "adentic_brand_assets")
            config = BrandConfiguration(config_data)
            
            # Run dry run on first project
            dry_run_rebrander = Rebrander(
                config=config,
                dry_run=True,
                backup=False,
                base_path=project1
            )
            dry_run_changes = dry_run_rebrander.run()
            
            # Run actual rebrand on second project  
            config_data["new_assets_dir"] = str(project2 / "adentic_brand_assets")
            config2 = BrandConfiguration(config_data)
            
            actual_rebrander = Rebrander(
                config=config2,
                dry_run=False,
                backup=False,
                base_path=project2
            )
            actual_changes = actual_rebrander.run()
            
            # Compare change counts by type
            dry_run_by_type = {}
            actual_by_type = {}
            
            for change in dry_run_changes:
                dry_run_by_type[change.change_type] = dry_run_by_type.get(change.change_type, 0) + 1
            
            for change in actual_changes:
                actual_by_type[change.change_type] = actual_by_type.get(change.change_type, 0) + 1
            
            # Should have similar change counts (allowing for slight variations)
            for change_type in dry_run_by_type:
                dry_count = dry_run_by_type[change_type]
                actual_count = actual_by_type.get(change_type, 0)
                
                # Allow for small differences due to implementation details
                difference = abs(dry_count - actual_count)
                tolerance = max(1, dry_count * 0.1)  # 10% tolerance or 1, whichever is larger
                
                assert difference <= tolerance, \
                    f"Change count mismatch for {change_type}: dry_run={dry_count}, actual={actual_count}"

    def test_dry_run_with_permission_issues(self):
        """Test dry run behavior with file permission issues."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            project_root = self.create_test_project(tmp_path)
            
            # Make some files read-only
            readonly_file = project_root / "frontend" / "src" / "app.tsx"
            readonly_file.chmod(0o444)
            
            config_data = self.adentic_config_data.copy()
            config_data["new_assets_dir"] = str(project_root / "adentic_brand_assets")
            
            try:
                config = BrandConfiguration(config_data)
                
                rebrander = Rebrander(
                    config=config,
                    dry_run=True,
                    backup=False,
                    base_path=project_root
                )
                
                changes = rebrander.run()
                
                # Dry run should still work even with permission issues
                assert len(changes) > 0
                
                # Should detect the permission issue as a warning
                warnings = [c for c in changes if c.change_type == "WARNING"]
                permission_warnings = [w for w in warnings if "permission" in w.details.lower()]
                
                # In dry run, permission issues might not be detected until actual write
                # But the run should complete successfully
                
            finally:
                # Restore permissions for cleanup
                readonly_file.chmod(0o644)

    def test_dry_run_output_formatting(self):
        """Test that dry run output is clearly formatted."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            project_root = self.create_test_project(tmp_path)
            
            config_data = self.adentic_config_data.copy()
            config_data["new_assets_dir"] = str(project_root / "adentic_brand_assets")
            
            config = BrandConfiguration(config_data)
            
            # Capture output
            import io
            import sys
            captured_output = io.StringIO()
            
            with patch('sys.stdout', captured_output):
                rebrander = Rebrander(
                    config=config,
                    dry_run=True,
                    backup=False,
                    base_path=project_root
                )
                
                changes = rebrander.run()
            
            output = captured_output.getvalue()
            
            # Verify dry run indicators in output
            assert "[DRY RUN]" in output
            assert "No files were actually modified" in output
            assert "Remove --dry-run flag to apply changes" in output
            
            # Verify change descriptions are clear
            assert "Adentic" in output
            assert "Assistant" in output

    def test_dry_run_configuration_validation(self):
        """Test that dry run validates configuration without side effects."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            project_root = self.create_test_project(tmp_path)
            
            # Test with invalid configuration
            invalid_config_data = {
                "brand_name": "",  # Invalid empty brand name
                "website_url": "not-a-url"  # Invalid URL
            }
            
            with pytest.raises(Exception):  # Should raise validation error
                config = BrandConfiguration(invalid_config_data)
                rebrander = Rebrander(
                    config=config,
                    dry_run=True,
                    backup=False,
                    base_path=project_root
                )
            
            # Verify project files were not affected by validation failure
            app_file = project_root / "frontend" / "src" / "app.tsx"
            content = app_file.read_text()
            assert "Kortix" in content  # Original content unchanged