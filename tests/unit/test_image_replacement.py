"""
Unit tests for image replacement functionality in the rebranding system.
These tests will fail until the rebrand module is properly refactored.
"""

import pytest
import tempfile
import shutil
from pathlib import Path
from unittest.mock import Mock, patch, MagicMock
from PIL import Image

# This import will fail initially since we need to refactor rebrand.py
from rebrand import ImageReplacer, BrandConfiguration, ImageReplacementError


class TestImageReplacer:
    """Test suite for ImageReplacer class."""

    def setup_method(self):
        """Set up test fixtures."""
        self.adentic_config = BrandConfiguration({
            "brand_name": "Adentic",
            "product_name": "Assistant",
            "company_name": "Adentic AI",
            "new_assets_dir": "./adentic_brand_assets"
        })
        
        self.image_replacer = ImageReplacer(self.adentic_config)
        
        # Expected image mapping for Adentic
        self.expected_image_mapping = {
            "frontend/public/adentic-logo.svg": "adentic-logo.svg",
            "frontend/public/adentic-logo-white.svg": "adentic-logo-white.svg",
            "frontend/public/adentic-symbol.svg": "adentic-symbol.svg",
            "frontend/public/favicon.png": "favicon.png",
            "frontend/public/banner.png": "banner.png",
            "frontend/public/thumbnail-dark.png": "thumbnail-dark.png",
            "frontend/public/thumbnail-light.png": "thumbnail-light.png",
            "frontend/src/app/favicon.ico": "favicon.ico",
            "apps/mobile/assets/images/icon.png": "icon.png",
            "apps/mobile/assets/images/favicon.png": "favicon.png",
            "apps/mobile/assets/images/adaptive-icon.png": "adaptive-icon.png",
            "apps/mobile/assets/images/adentic-logo-square.svg": "adentic-logo-square.svg"
        }

    def test_get_image_replacement_mapping_for_adentic(self):
        """Test generation of image replacement mapping for Adentic."""
        mapping = self.image_replacer.get_image_replacement_mapping()
        
        assert isinstance(mapping, dict)
        assert len(mapping) > 0
        
        # Check that all expected mappings are present
        for old_path, new_filename in self.expected_image_mapping.items():
            assert old_path in mapping
            assert mapping[old_path] == new_filename

    def test_get_files_to_rename_for_adentic(self):
        """Test getting files that need to be renamed for Adentic."""
        files_to_rename = self.image_replacer.get_files_to_rename()
        
        assert isinstance(files_to_rename, list)
        
        # Should include files with 'adentic' in the name
        adentic_files = [f for f in files_to_rename if 'adentic' in f.lower()]
        assert len(adentic_files) > 0
        
        # Check specific files
        expected_renames = [
            "frontend/public/adentic-logo.svg",
            "frontend/public/adentic-logo-white.svg", 
            "frontend/public/adentic-symbol.svg",
            "apps/mobile/assets/images/adentic-logo-square.svg"
        ]
        
        for expected_file in expected_renames:
            assert expected_file in files_to_rename

    def test_generate_new_filename_for_adentic(self):
        """Test generating new filename for Adentic branding."""
        test_cases = [
            ("adentic-logo.svg", "adentic-logo.svg"),
            ("adentic-logo-white.svg", "adentic-logo-white.svg"),
            ("adentic-symbol.svg", "adentic-symbol.svg"),
            ("adentic-logo-square.svg", "adentic-logo-square.svg"),
            ("ADENTIC-BANNER.png", "ADENTIC-BANNER.png"),
            ("app-adentic-icon.ico", "app-adentic-icon.ico")
        ]
        
        for old_name, expected_new_name in test_cases:
            new_name = self.image_replacer.generate_new_filename(old_name)
            assert new_name == expected_new_name

    def test_replace_image_file_success(self):
        """Test successful image file replacement."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            # Create source image file
            old_image_path = tmp_path / "old-logo.png"
            old_image = Image.new('RGB', (100, 100), color='red')
            old_image.save(old_image_path)
            
            # Create new assets directory with replacement image
            assets_dir = tmp_path / "assets"
            assets_dir.mkdir()
            new_image_path = assets_dir / "new-logo.png"
            new_image = Image.new('RGB', (100, 100), color='blue')
            new_image.save(new_image_path)
            
            # Mock the config to point to our test assets
            self.image_replacer.config.new_assets_dir = assets_dir
            
            result = self.image_replacer.replace_image_file(
                old_image_path, 
                "new-logo.png"
            )
            
            assert result is True
            
            # Verify the image was replaced
            replaced_image = Image.open(old_image_path)
            assert replaced_image.getpixel((50, 50)) == (0, 0, 255)  # Blue color

    def test_replace_image_file_new_asset_not_found(self):
        """Test image replacement when new asset doesn't exist."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            # Create source image file
            old_image_path = tmp_path / "old-logo.png"
            old_image = Image.new('RGB', (100, 100), color='red')
            old_image.save(old_image_path)
            
            # Create empty assets directory
            assets_dir = tmp_path / "assets"
            assets_dir.mkdir()
            self.image_replacer.config.new_assets_dir = assets_dir
            
            with pytest.raises(ImageReplacementError) as exc_info:
                self.image_replacer.replace_image_file(
                    old_image_path,
                    "nonexistent-logo.png"
                )
            
            assert "Asset not found" in str(exc_info.value)

    def test_replace_image_file_dry_run(self):
        """Test image replacement in dry run mode."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            # Create source image file
            old_image_path = tmp_path / "old-logo.png"
            old_image = Image.new('RGB', (100, 100), color='red')
            old_image.save(old_image_path)
            
            # Create new assets directory with replacement image
            assets_dir = tmp_path / "assets"
            assets_dir.mkdir()
            new_image_path = assets_dir / "new-logo.png"
            new_image = Image.new('RGB', (100, 100), color='blue')
            new_image.save(new_image_path)
            
            # Create dry run image replacer
            dry_run_replacer = ImageReplacer(self.adentic_config, dry_run=True)
            dry_run_replacer.config.new_assets_dir = assets_dir
            
            result = dry_run_replacer.replace_image_file(
                old_image_path,
                "new-logo.png"
            )
            
            assert result is True
            
            # Verify the original image was NOT changed
            original_image = Image.open(old_image_path)
            assert original_image.getpixel((50, 50)) == (255, 0, 0)  # Still red

    def test_rename_image_file(self):
        """Test renaming image files."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            # Create image file with brand name
            old_file_path = tmp_path / "adentic-logo.svg"
            old_file_path.write_text('<svg>Logo content</svg>')
            
            new_file_path = self.image_replacer.rename_image_file(old_file_path)
            
            expected_new_path = tmp_path / "adentic-logo.svg"
            assert new_file_path == expected_new_path
            assert expected_new_path.exists()
            assert not old_file_path.exists()
            assert expected_new_path.read_text() == '<svg>Logo content</svg>'

    def test_rename_image_file_dry_run(self):
        """Test renaming image files in dry run mode."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            # Create image file with brand name
            old_file_path = tmp_path / "adentic-logo.svg"
            old_file_path.write_text('<svg>Logo content</svg>')
            
            dry_run_replacer = ImageReplacer(self.adentic_config, dry_run=True)
            new_file_path = dry_run_replacer.rename_image_file(old_file_path)
            
            expected_new_path = tmp_path / "adentic-logo.svg"
            assert new_file_path == expected_new_path
            
            # In dry run, original file should still exist
            assert old_file_path.exists()
            assert not expected_new_path.exists()

    def test_rename_image_file_no_brand_name(self):
        """Test renaming image files that don't contain brand name."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            # Create image file without brand name
            file_path = tmp_path / "generic-icon.png"
            file_path.write_text('PNG content')
            
            new_file_path = self.image_replacer.rename_image_file(file_path)
            
            # Should return the same path (no rename needed)
            assert new_file_path == file_path
            assert file_path.exists()

    def test_validate_image_assets_all_present(self):
        """Test validation when all required assets are present."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            assets_dir = Path(tmp_dir)
            
            # Create all required assets
            required_assets = [
                "adentic-logo.svg",
                "adentic-logo-white.svg", 
                "adentic-symbol.svg",
                "favicon.png",
                "banner.png",
                "thumbnail-dark.png",
                "thumbnail-light.png",
                "favicon.ico",
                "icon.png",
                "adaptive-icon.png",
                "adentic-logo-square.svg"
            ]
            
            for asset in required_assets:
                (assets_dir / asset).write_text('asset content')
            
            self.image_replacer.config.new_assets_dir = assets_dir
            
            result = self.image_replacer.validate_image_assets()
            assert result is True

    def test_validate_image_assets_missing_required(self):
        """Test validation when required assets are missing."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            assets_dir = Path(tmp_dir)
            
            # Create only some assets
            (assets_dir / "adentic-logo.svg").write_text('logo content')
            
            self.image_replacer.config.new_assets_dir = assets_dir
            
            with pytest.raises(ImageReplacementError) as exc_info:
                self.image_replacer.validate_image_assets()
            
            assert "Missing required assets" in str(exc_info.value)

    def test_validate_image_format_and_dimensions(self):
        """Test validation of image format and dimensions."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            assets_dir = Path(tmp_dir)
            
            # Create test images with different formats and sizes
            png_image = Image.new('RGB', (512, 512), color='red')
            png_path = assets_dir / "icon.png"
            png_image.save(png_path)
            
            # Create SVG file
            svg_path = assets_dir / "adentic-logo.svg"
            svg_content = '''<svg width="200" height="100" xmlns="http://www.w3.org/2000/svg">
                <rect width="200" height="100" fill="blue"/>
            </svg>'''
            svg_path.write_text(svg_content)
            
            self.image_replacer.config.new_assets_dir = assets_dir
            
            # Test PNG validation
            png_valid = self.image_replacer.validate_image_format(png_path, 'png')
            assert png_valid is True
            
            # Test SVG validation
            svg_valid = self.image_replacer.validate_image_format(svg_path, 'svg')
            assert svg_valid is True

    def test_backup_original_images(self):
        """Test backing up original images before replacement."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            # Create original image
            original_path = tmp_path / "logo.png"
            original_image = Image.new('RGB', (100, 100), color='red')
            original_image.save(original_path)
            
            # Create backup directory
            backup_dir = tmp_path / "backup"
            backup_dir.mkdir()
            
            self.image_replacer.backup_original_image(original_path, backup_dir)
            
            backup_path = backup_dir / "logo.png"
            assert backup_path.exists()
            
            # Verify backup is identical to original
            backup_image = Image.open(backup_path)
            assert backup_image.getpixel((50, 50)) == (255, 0, 0)

    def test_process_all_images(self):
        """Test processing all images in the mapping."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            # Create project structure
            frontend_public = tmp_path / "frontend" / "public"
            frontend_public.mkdir(parents=True)
            
            # Create original images
            (frontend_public / "adentic-logo.svg").write_text('<svg>Old logo</svg>')
            (frontend_public / "favicon.png").write_bytes(b'PNG content')
            
            # Create assets directory with new images
            assets_dir = tmp_path / "assets"
            assets_dir.mkdir()
            (assets_dir / "adentic-logo.svg").write_text('<svg>New logo</svg>')
            (assets_dir / "favicon.png").write_bytes(b'New PNG content')
            
            # Configure image replacer
            self.image_replacer.config.new_assets_dir = assets_dir
            
            # Mock the image mapping to only include our test files
            with patch.object(self.image_replacer, 'get_image_replacement_mapping') as mock_mapping:
                mock_mapping.return_value = {
                    str(frontend_public / "adentic-logo.svg"): "adentic-logo.svg",
                    str(frontend_public / "favicon.png"): "favicon.png"
                }
                
                changes = self.image_replacer.process_all_images(base_path=tmp_path)
                
                assert len(changes) > 0
                
                # Check that files were renamed and replaced
                adentic_logo_path = frontend_public / "adentic-logo.svg"
                assert adentic_logo_path.exists()
                assert adentic_logo_path.read_text() == '<svg>New logo</svg>'

    def test_get_image_statistics(self):
        """Test getting statistics about image processing."""
        # Process some mock changes
        self.image_replacer.changes = [
            {"type": "image_replace", "file": "logo.svg", "details": "Replaced"},
            {"type": "image_rename", "file": "icon.png", "details": "Renamed"},
            {"type": "image_replace", "file": "banner.png", "details": "Replaced"}
        ]
        
        stats = self.image_replacer.get_image_statistics()
        
        assert isinstance(stats, dict)
        assert stats["total_images_processed"] == 3
        assert stats["images_replaced"] == 2
        assert stats["images_renamed"] == 1

    def test_image_replacement_error_handling(self):
        """Test error handling for various image replacement scenarios."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            # Test replacing non-existent file
            non_existent = tmp_path / "missing.png"
            
            with pytest.raises(ImageReplacementError) as exc_info:
                self.image_replacer.replace_image_file(non_existent, "new-logo.png")
            
            assert "does not exist" in str(exc_info.value)

    def test_component_file_processing(self):
        """Test processing of component files that reference images."""
        component_content = '''
        import React from 'react';
        import AdenticLogo from './adentic-logo.svg';
        
        const Header = () => {
            return (
                <div>
                    <img src="/adentic-logo.svg" alt="Adentic Logo" />
                    <img src="/adentic-symbol.svg" alt="Symbol" />
                </div>
            );
        };
        '''
        
        expected_content = '''
        import React from 'react';
        import AdenticLogo from './adentic-logo.svg';
        
        const Header = () => {
            return (
                <div>
                    <img src="/adentic-logo.svg" alt="Adentic Logo" />
                    <img src="/adentic-symbol.svg" alt="Symbol" />
                </div>
            );
        };
        '''
        
        result = self.image_replacer.update_image_references_in_code(component_content)
        
        # Remove extra whitespace for comparison
        result_clean = ' '.join(result.split())
        expected_clean = ' '.join(expected_content.split())
        
        assert "adentic-logo.svg" in result
        assert "AdenticLogo" in result
        assert "Adentic Logo" in result
        assert "adentic" not in result.lower()