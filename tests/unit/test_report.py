"""
Unit tests for report generation functionality in the rebranding system.
These tests will fail until the rebrand module is properly refactored.
"""

import pytest
import json
import tempfile
from pathlib import Path
from datetime import datetime
from unittest.mock import Mock, patch, MagicMock

# This import will fail initially since we need to refactor rebrand.py
from rebrand import ReportGenerator, BrandConfiguration, Change, ReportError


class TestReportGenerator:
    """Test suite for ReportGenerator class."""

    def setup_method(self):
        """Set up test fixtures."""
        self.adentic_config = BrandConfiguration({
            "brand_name": "Adentic",
            "product_name": "Assistant",
            "company_name": "Adentic AI",
            "full_product_name": "Adentic Assistant",
            "website_url": "https://adentic.ai/",
            "new_assets_dir": "./adentic_brand_assets"
        })
        
        self.sample_changes = [
            Change(
                file_path="frontend/src/app.tsx",
                change_type="TEXT",
                old_value="Adentic",
                new_value="Adentic",
                details="Brand name replacement"
            ),
            Change(
                file_path="frontend/src/components/Header.tsx",
                change_type="TEXT",
                old_value="Adentic",
                new_value="Assistant",
                details="Product name replacement"
            ),
            Change(
                file_path="frontend/public/logo.svg",
                change_type="IMAGE",
                old_value="adentic-logo.svg",
                new_value="adentic-logo.svg",
                details="Logo replacement"
            ),
            Change(
                file_path="frontend/src/components/sidebar/adentic-logo.tsx",
                change_type="RENAME",
                old_value="adentic-logo.tsx",
                new_value="adentic-logo.tsx",
                details="Component file rename"
            )
        ]
        
        self.report_generator = ReportGenerator(
            config=self.adentic_config,
            changes=self.sample_changes,
            dry_run=False
        )

    def test_report_generator_initialization(self):
        """Test ReportGenerator initialization."""
        assert self.report_generator.config == self.adentic_config
        assert self.report_generator.changes == self.sample_changes
        assert self.report_generator.dry_run is False
        assert self.report_generator.start_time is not None

    def test_report_generator_dry_run_mode(self):
        """Test ReportGenerator in dry run mode."""
        dry_run_generator = ReportGenerator(
            config=self.adentic_config,
            changes=self.sample_changes,
            dry_run=True
        )
        
        assert dry_run_generator.dry_run is True

    def test_generate_summary_statistics(self):
        """Test generation of summary statistics."""
        stats = self.report_generator.generate_summary_statistics()
        
        assert isinstance(stats, dict)
        assert stats["total_changes"] == 4
        assert stats["text_changes"] == 2
        assert stats["image_changes"] == 1
        assert stats["renames"] == 1
        assert stats["files_affected"] == 4

    def test_generate_summary_statistics_empty_changes(self):
        """Test summary statistics with no changes."""
        empty_generator = ReportGenerator(
            config=self.adentic_config,
            changes=[],
            dry_run=False
        )
        
        stats = empty_generator.generate_summary_statistics()
        
        assert stats["total_changes"] == 0
        assert stats["text_changes"] == 0
        assert stats["image_changes"] == 0
        assert stats["renames"] == 0
        assert stats["files_affected"] == 0

    def test_generate_change_breakdown_by_type(self):
        """Test generating change breakdown by type."""
        breakdown = self.report_generator.generate_change_breakdown_by_type()
        
        assert isinstance(breakdown, dict)
        assert "TEXT" in breakdown
        assert "IMAGE" in breakdown
        assert "RENAME" in breakdown
        
        assert len(breakdown["TEXT"]) == 2
        assert len(breakdown["IMAGE"]) == 1
        assert len(breakdown["RENAME"]) == 1

    def test_generate_change_breakdown_by_directory(self):
        """Test generating change breakdown by directory."""
        breakdown = self.report_generator.generate_change_breakdown_by_directory()
        
        assert isinstance(breakdown, dict)
        assert "frontend/src" in breakdown
        assert "frontend/public" in breakdown
        assert "frontend/src/components" in breakdown
        assert "frontend/src/components/sidebar" in breakdown

    def test_generate_affected_files_list(self):
        """Test generating list of affected files."""
        affected_files = self.report_generator.generate_affected_files_list()
        
        assert isinstance(affected_files, list)
        assert len(affected_files) == 4
        
        expected_files = [
            "frontend/src/app.tsx",
            "frontend/src/components/Header.tsx", 
            "frontend/public/logo.svg",
            "frontend/src/components/sidebar/adentic-logo.tsx"
        ]
        
        for expected_file in expected_files:
            assert expected_file in affected_files

    def test_generate_adentic_specific_report_sections(self):
        """Test generating Adentic-specific report sections."""
        adentic_sections = self.report_generator.generate_adentic_specific_sections()
        
        assert isinstance(adentic_sections, dict)
        assert "brand_transformation" in adentic_sections
        assert "url_updates" in adentic_sections
        assert "asset_replacements" in adentic_sections
        
        brand_transformation = adentic_sections["brand_transformation"]
        assert "Adentic → Adentic" in str(brand_transformation)
        assert "Adentic → Assistant" in str(brand_transformation)

    def test_generate_full_report_data(self):
        """Test generating complete report data structure."""
        with patch('rebrand.datetime') as mock_datetime:
            mock_datetime.now.return_value = datetime(2023, 12, 25, 14, 30, 45)
            mock_datetime.isoformat = datetime.isoformat
            
            report_data = self.report_generator.generate_full_report_data()
            
            assert isinstance(report_data, dict)
            
            # Check main sections
            required_sections = [
                "timestamp",
                "execution_info",
                "configuration",
                "summary",
                "changes_by_type",
                "changes_by_directory", 
                "affected_files",
                "adentic_transformation",
                "detailed_changes"
            ]
            
            for section in required_sections:
                assert section in report_data
            
            # Check execution info
            exec_info = report_data["execution_info"]
            assert exec_info["dry_run"] is False
            assert exec_info["brand_name"] == "Adentic"
            assert exec_info["total_duration"] is not None

    def test_save_json_report(self):
        """Test saving report as JSON file."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            report_path = self.report_generator.save_json_report(output_dir=tmp_path)
            
            assert report_path.exists()
            assert report_path.suffix == ".json"
            assert "rebrand_report_" in report_path.name
            assert "adentic" in report_path.name.lower()
            
            # Verify JSON content
            with open(report_path) as f:
                report_data = json.load(f)
            
            assert report_data["configuration"]["brand_name"] == "Adentic"
            assert len(report_data["detailed_changes"]) == 4

    def test_save_html_report(self):
        """Test saving report as HTML file."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            report_path = self.report_generator.save_html_report(output_dir=tmp_path)
            
            assert report_path.exists()
            assert report_path.suffix == ".html"
            assert "rebrand_report_" in report_path.name
            
            # Verify HTML content
            html_content = report_path.read_text()
            assert "<html>" in html_content
            assert "Adentic" in html_content
            assert "Rebranding Report" in html_content
            assert "Assistant" in html_content

    def test_save_markdown_report(self):
        """Test saving report as Markdown file."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            report_path = self.report_generator.save_markdown_report(output_dir=tmp_path)
            
            assert report_path.exists()
            assert report_path.suffix == ".md"
            
            # Verify Markdown content
            md_content = report_path.read_text()
            assert "# Rebranding Report" in md_content
            assert "## Summary" in md_content
            assert "Adentic" in md_content
            assert "Assistant" in md_content
            assert "| File" in md_content  # Should contain tables

    def test_generate_backup_report_section(self):
        """Test generating backup-related report section."""
        backup_dir = Path("/tmp/backup_rebrand_20231225_143045")
        
        backup_section = self.report_generator.generate_backup_report_section(
            backup_dir=backup_dir,
            backup_enabled=True
        )
        
        assert isinstance(backup_section, dict)
        assert backup_section["enabled"] is True
        assert backup_section["backup_directory"] == str(backup_dir)
        assert "files_backed_up" in backup_section

    def test_generate_backup_report_section_disabled(self):
        """Test generating backup report section when backup is disabled."""
        backup_section = self.report_generator.generate_backup_report_section(
            backup_dir=None,
            backup_enabled=False
        )
        
        assert backup_section["enabled"] is False
        assert backup_section["backup_directory"] is None

    def test_generate_validation_report_section(self):
        """Test generating validation report section."""
        validation_results = {
            "config_valid": True,
            "assets_available": True,
            "permissions_ok": True,
            "warnings": ["Some old files may contain hardcoded references"],
            "errors": []
        }
        
        validation_section = self.report_generator.generate_validation_report_section(
            validation_results
        )
        
        assert isinstance(validation_section, dict)
        assert validation_section["config_valid"] is True
        assert validation_section["assets_available"] is True
        assert len(validation_section["warnings"]) == 1
        assert len(validation_section["errors"]) == 0

    def test_calculate_execution_time(self):
        """Test calculating execution time."""
        # Simulate execution time
        import time
        start_time = self.report_generator.start_time
        time.sleep(0.1)  # Sleep for 100ms
        
        execution_time = self.report_generator.calculate_execution_time()
        
        assert execution_time >= 0.1
        assert execution_time < 1.0  # Should be less than 1 second

    def test_format_file_size(self):
        """Test formatting file sizes for display."""
        test_cases = [
            (512, "512 B"),
            (1024, "1.0 KB"),
            (1536, "1.5 KB"),
            (1048576, "1.0 MB"),
            (1073741824, "1.0 GB")
        ]
        
        for size_bytes, expected_format in test_cases:
            formatted = self.report_generator.format_file_size(size_bytes)
            assert formatted == expected_format

    def test_generate_change_timeline(self):
        """Test generating timeline of changes."""
        # Add timestamps to changes
        for i, change in enumerate(self.sample_changes):
            change.timestamp = datetime.now().timestamp() + i
        
        timeline = self.report_generator.generate_change_timeline()
        
        assert isinstance(timeline, list)
        assert len(timeline) == 4
        
        # Timeline should be sorted by timestamp
        timestamps = [entry["timestamp"] for entry in timeline]
        assert timestamps == sorted(timestamps)

    def test_generate_risk_assessment(self):
        """Test generating risk assessment section."""
        risk_assessment = self.report_generator.generate_risk_assessment()
        
        assert isinstance(risk_assessment, dict)
        assert "risk_level" in risk_assessment
        assert "potential_issues" in risk_assessment
        assert "recommendations" in risk_assessment
        
        # For comprehensive changes like Adentic rebrand, should flag as medium/high risk
        assert risk_assessment["risk_level"] in ["medium", "high"]

    def test_generate_rollback_instructions(self):
        """Test generating rollback instructions."""
        backup_dir = Path("/tmp/backup_rebrand_20231225_143045")
        
        rollback_instructions = self.report_generator.generate_rollback_instructions(
            backup_dir=backup_dir
        )
        
        assert isinstance(rollback_instructions, dict)
        assert "steps" in rollback_instructions
        assert "commands" in rollback_instructions
        assert "warnings" in rollback_instructions
        
        steps = rollback_instructions["steps"]
        assert len(steps) > 0
        assert any("backup" in step.lower() for step in steps)

    def test_save_multiple_format_reports(self):
        """Test saving reports in multiple formats simultaneously."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            formats = ["json", "html", "markdown"]
            report_paths = self.report_generator.save_reports(
                output_dir=tmp_path,
                formats=formats
            )
            
            assert len(report_paths) == 3
            assert all(path.exists() for path in report_paths)
            
            # Check that we have one of each format
            extensions = [path.suffix for path in report_paths]
            assert ".json" in extensions
            assert ".html" in extensions
            assert ".md" in extensions

    def test_report_with_errors_and_warnings(self):
        """Test generating report with errors and warnings."""
        # Add an error to changes
        error_change = Change(
            file_path="failed/file.txt",
            change_type="ERROR",
            old_value="",
            new_value="",
            details="Failed to process file due to permission error"
        )
        
        changes_with_error = self.sample_changes + [error_change]
        
        error_generator = ReportGenerator(
            config=self.adentic_config,
            changes=changes_with_error,
            dry_run=False
        )
        
        report_data = error_generator.generate_full_report_data()
        
        # Should include error analysis
        assert "errors" in report_data["summary"]
        assert report_data["summary"]["errors"] == 1

    def test_dry_run_report_indicators(self):
        """Test that dry run reports are properly marked."""
        dry_run_generator = ReportGenerator(
            config=self.adentic_config,
            changes=self.sample_changes,
            dry_run=True
        )
        
        report_data = dry_run_generator.generate_full_report_data()
        
        assert report_data["execution_info"]["dry_run"] is True
        assert "DRY RUN" in str(report_data).upper()

    def test_adentic_branding_verification(self):
        """Test verification of Adentic-specific branding changes."""
        verification = self.report_generator.verify_adentic_branding_completeness()
        
        assert isinstance(verification, dict)
        assert "brand_name_updates" in verification
        assert "product_name_updates" in verification
        assert "url_updates" in verification
        assert "asset_updates" in verification
        assert "completeness_score" in verification
        
        # Should detect that we've covered the main branding elements
        assert verification["completeness_score"] > 0.5

    def test_generate_post_rebrand_checklist(self):
        """Test generating post-rebranding checklist."""
        checklist = self.report_generator.generate_post_rebrand_checklist()
        
        assert isinstance(checklist, list)
        assert len(checklist) > 0
        
        # Should include Adentic-specific items
        checklist_text = " ".join(checklist).lower()
        assert "test" in checklist_text
        assert "build" in checklist_text
        assert "deploy" in checklist_text

    def test_report_error_handling(self):
        """Test error handling during report generation."""
        # Create generator with invalid config
        invalid_config = Mock()
        invalid_config.to_dict.side_effect = Exception("Config error")
        
        error_generator = ReportGenerator(
            config=invalid_config,
            changes=self.sample_changes,
            dry_run=False
        )
        
        with pytest.raises(ReportError) as exc_info:
            error_generator.generate_full_report_data()
        
        assert "Config error" in str(exc_info.value)