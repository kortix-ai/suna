#!/usr/bin/env python3
"""
Kortix/Suna Rebranding Script
Automates the process of rebranding the entire codebase

Refactored to include proper class structure with validation,
backup management, and comprehensive reporting.
"""

import os
import re
import json
import shutil
import argparse
import hashlib
import time
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Union, Any
from datetime import datetime
from urllib.parse import urlparse
from dataclasses import dataclass, asdict


# ========================================================================================
# Custom Exception Classes
# ========================================================================================

class ConfigValidationError(Exception):
    """Raised when brand configuration validation fails."""
    pass


class ReplacementError(Exception):
    """Raised when text replacement operations fail."""
    pass


class ImageReplacementError(Exception):
    """Raised when image replacement operations fail."""
    pass


class BackupError(Exception):
    """Raised when backup operations fail."""
    pass


class ReportError(Exception):
    """Raised when report generation fails."""
    pass


# ========================================================================================
# Data Classes
# ========================================================================================

@dataclass
class Change:
    """Represents a single change made during rebranding."""
    file_path: str
    change_type: str  # TEXT, IMAGE, RENAME, ERROR
    old_value: str
    new_value: str
    details: str
    timestamp: Optional[float] = None

    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = time.time()


# ========================================================================================
# Brand Configuration Class
# ========================================================================================

class BrandConfiguration:
    """Manages and validates brand configuration settings."""

    def __init__(self, config_data: Dict[str, Any]):
        """Initialize brand configuration with validation."""
        self.raw_config = config_data.copy()
        self._validate_and_set_config(config_data)

    def _validate_and_set_config(self, config_data: Dict[str, Any]):
        """Validate configuration data and set attributes."""
        # Substitute environment variables
        config_data = self._substitute_environment_variables(config_data)

        # Validate required fields
        if not config_data.get("brand_name"):
            raise ConfigValidationError("brand_name is required")

        if not config_data["brand_name"].strip():
            raise ConfigValidationError("brand_name cannot be empty")

        # Validate brand name format
        self._validate_brand_name(config_data["brand_name"])

        # Set core attributes
        self.brand_name = config_data["brand_name"]
        self.product_name = config_data.get("product_name", self.brand_name)
        self.company_name = config_data.get("company_name", f"{self.brand_name} AI")
        self.full_product_name = config_data.get("full_product_name", f"{self.brand_name} {self.product_name}")

        # Set optional URLs with validation
        self.website_url = self._validate_url(config_data.get("website_url"))
        self.twitter_url = self._validate_url(config_data.get("twitter_url"))
        self.github_url = self._validate_url(config_data.get("github_url"))
        self.linkedin_url = self._validate_url(config_data.get("linkedin_url"))

        # Set assets directory with validation
        self.new_assets_dir = self._validate_assets_dir(config_data.get("new_assets_dir"))

    def _validate_brand_name(self, brand_name: str):
        """Validate brand name format and length."""
        if len(brand_name) < 2 or len(brand_name) > 50:
            raise ConfigValidationError("Brand name must be between 2 and 50 characters")

        # Check for invalid characters
        invalid_chars = ['@', ' ', '/', '\\', '<', '>', ':', '"', '|', '?', '*']
        if any(char in brand_name for char in invalid_chars):
            raise ConfigValidationError("Brand name contains invalid characters")

    def _validate_url(self, url: Optional[str]) -> Optional[str]:
        """Validate URL format if provided."""
        if url is None:
            return None

        try:
            result = urlparse(url)
            if not all([result.scheme, result.netloc]):
                raise ConfigValidationError(f"Invalid URL format: {url}")
            return url
        except Exception:
            raise ConfigValidationError(f"Invalid URL format: {url}")

    def _validate_assets_dir(self, assets_dir: Optional[str]) -> Optional[Path]:
        """Validate assets directory if provided."""
        if assets_dir is None:
            return None

        assets_path = Path(assets_dir)
        if not assets_path.exists():
            raise ConfigValidationError(f"Assets directory does not exist: {assets_dir}")

        return assets_path

    def _substitute_environment_variables(self, config_data: Dict[str, Any]) -> Dict[str, Any]:
        """Substitute environment variables in configuration values."""
        result = {}
        for key, value in config_data.items():
            if isinstance(value, str) and value.startswith("${") and value.endswith("}"):
                env_var = value[2:-1]
                result[key] = os.environ.get(env_var, value)
            else:
                result[key] = value
        return result

    @classmethod
    def from_file(cls, config_file: Union[str, Path]) -> 'BrandConfiguration':
        """Load configuration from JSON file."""
        config_path = Path(config_file)
        if not config_path.exists():
            raise ConfigValidationError(f"Configuration file not found: {config_file}")

        try:
            with open(config_path, 'r') as f:
                config_data = json.load(f)
            return cls(config_data)
        except json.JSONDecodeError as e:
            raise ConfigValidationError(f"Invalid JSON in configuration file: {e}")

    def validate_adentic_requirements(self) -> bool:
        """Validate Adentic-specific requirements."""
        if self.brand_name != "Adentic":
            return False

        if self.website_url and "adentic" not in self.website_url.lower():
            return False

        if self.github_url and "adentic" not in self.github_url.lower():
            return False

        return True

    def get_text_replacements(self) -> List[Tuple[str, str]]:
        """Generate text replacement patterns for this brand configuration."""
        replacements = [
            # Brand names - exact matches first
            ("Kortix Suna", self.full_product_name),
            ("Kortix AI", self.company_name),
            ("Kortix", self.brand_name),
            ("kortix", self.brand_name.lower()),
            ("KORTIX", self.brand_name.upper()),
            ("Suna", self.product_name),
            ("suna", self.product_name.lower()),
            ("SUNA", self.product_name.upper()),
        ]

        # Add URL replacements if provided
        if self.website_url:
            replacements.extend([
                ("https://suna.so/", self.website_url),
                ("https://api.suna.so", f"https://api.{urlparse(self.website_url).netloc}"),
            ])

        if self.twitter_url:
            replacements.append(("https://x.com/kortixai", self.twitter_url))

        if self.github_url:
            replacements.append(("https://github.com/kortix-ai/", self.github_url))

        if self.linkedin_url:
            replacements.append(("https://www.linkedin.com/company/kortix/", self.linkedin_url))

        # Environment variables
        replacements.append((
            "KORTIX_ADMIN_API_KEY",
            f"{self.brand_name.upper()}_ADMIN_API_KEY"
        ))

        return replacements

    def get_image_replacement_mapping(self) -> Dict[str, str]:
        """Generate image replacement mapping."""
        brand_lower = self.brand_name.lower()

        return {
            "frontend/public/kortix-logo.svg": f"{brand_lower}-logo.svg",
            "frontend/public/kortix-logo-white.svg": f"{brand_lower}-logo-white.svg",
            "frontend/public/kortix-symbol.svg": f"{brand_lower}-symbol.svg",
            "frontend/public/favicon.png": "favicon.png",
            "frontend/public/banner.png": "banner.png",
            "frontend/public/thumbnail-dark.png": "thumbnail-dark.png",
            "frontend/public/thumbnail-light.png": "thumbnail-light.png",
            "frontend/src/app/favicon.ico": "favicon.ico",
            "apps/mobile/assets/images/icon.png": "icon.png",
            "apps/mobile/assets/images/favicon.png": "favicon.png",
            "apps/mobile/assets/images/adaptive-icon.png": "adaptive-icon.png",
            "apps/mobile/assets/images/kortix-logo-square.svg": f"{brand_lower}-logo-square.svg",
        }

    def to_dict(self) -> Dict[str, Any]:
        """Convert configuration to dictionary."""
        return {
            "brand_name": self.brand_name,
            "product_name": self.product_name,
            "company_name": self.company_name,
            "full_product_name": self.full_product_name,
            "website_url": self.website_url,
            "twitter_url": self.twitter_url,
            "github_url": self.github_url,
            "linkedin_url": self.linkedin_url,
            "new_assets_dir": str(self.new_assets_dir) if self.new_assets_dir else None,
        }

    def __eq__(self, other) -> bool:
        """Check equality with another configuration."""
        if not isinstance(other, BrandConfiguration):
            return False
        return self.to_dict() == other.to_dict()

    def __repr__(self) -> str:
        """String representation of configuration."""
        return f"BrandConfiguration(brand_name='{self.brand_name}', product_name='{self.product_name}')"


# ========================================================================================
# Text Replacement Class
# ========================================================================================

class TextReplacer:
    """Handles text replacement operations in files."""

    def __init__(self, config: BrandConfiguration, dry_run: bool = False, use_regex: bool = False):
        """Initialize text replacer."""
        self.config = config
        self.dry_run = dry_run
        self.use_regex = use_regex
        self.replacement_stats = {"total_replacements": 0, "replacements_by_pattern": {}}

    def get_replacement_patterns(self) -> List[Tuple[str, str]]:
        """Get all text replacement patterns."""
        return self.config.get_text_replacements()

    def get_file_patterns_to_process(self) -> List[str]:
        """Get file patterns that should be processed for text replacement."""
        return [
            "**/*.py",
            "**/*.ts",
            "**/*.tsx",
            "**/*.js",
            "**/*.jsx",
            "**/*.json",
            "**/*.md",
            "**/*.yaml",
            "**/*.yml",
            "**/*.env*",
            "**/*.html"
        ]

    def should_skip_file(self, file_path: Path) -> bool:
        """Determine if a file should be skipped."""
        exclude_dirs = {
            "node_modules", ".git", "dist", "build", ".next",
            "__pycache__", "venv", ".venv"
        }

        # Skip if in excluded directory
        if any(part in exclude_dirs for part in file_path.parts):
            return True

        # Skip backup directories
        if any("backup_rebrand_" in part for part in file_path.parts):
            return True

        # Skip the rebrand script itself
        if file_path.name == "rebrand.py":
            return True

        return False

    def replace_text_in_string(self, content: str) -> str:
        """Replace text patterns in a string."""
        patterns = self.get_replacement_patterns()

        for old_text, new_text in patterns:
            if old_text in content:
                count = content.count(old_text)
                content = content.replace(old_text, new_text)

                # Update statistics
                self.replacement_stats["total_replacements"] += count
                if old_text not in self.replacement_stats["replacements_by_pattern"]:
                    self.replacement_stats["replacements_by_pattern"][old_text] = 0
                self.replacement_stats["replacements_by_pattern"][old_text] += count

        return content

    def replace_text_in_file(self, file_path: Path) -> List[Change]:
        """Replace text in a single file."""
        changes = []

        try:
            # Read file content
            content = file_path.read_text(encoding='utf-8')
            original_content = content

            # Apply replacements
            patterns = self.get_replacement_patterns()
            for old_text, new_text in patterns:
                if old_text in content:
                    content = content.replace(old_text, new_text)
                    changes.append(Change(
                        file_path=str(file_path),
                        change_type="TEXT",
                        old_value=old_text,
                        new_value=new_text,
                        details=f"Text replacement: '{old_text}' → '{new_text}'"
                    ))

            # Write back if changes were made and not in dry run
            if content != original_content and not self.dry_run:
                file_path.write_text(content, encoding='utf-8')

            return changes

        except UnicodeDecodeError as e:
            raise ReplacementError(f"Encoding error reading {file_path}: {e}")
        except PermissionError as e:
            raise ReplacementError(f"Permission denied accessing {file_path}: {e}")
        except Exception as e:
            raise ReplacementError(f"Error processing {file_path}: {e}")

    def process_directory_tree(self, base_path: Path) -> List[Change]:
        """Process all eligible files in directory tree."""
        all_changes = []
        patterns = self.get_file_patterns_to_process()

        for pattern in patterns:
            for file_path in base_path.rglob(pattern):
                if self.should_skip_file(file_path):
                    continue

                try:
                    changes = self.replace_text_in_file(file_path)
                    all_changes.extend(changes)
                except ReplacementError:
                    # Log error but continue processing other files
                    all_changes.append(Change(
                        file_path=str(file_path),
                        change_type="ERROR",
                        old_value="",
                        new_value="",
                        details=f"Failed to process file: {file_path}"
                    ))

        return all_changes

    def get_replacement_statistics(self) -> Dict[str, Any]:
        """Get replacement statistics."""
        return self.replacement_stats.copy()


# ========================================================================================
# Image Replacement Class
# ========================================================================================

class ImageReplacer:
    """Handles image file replacement and renaming operations."""

    def __init__(self, config: BrandConfiguration, dry_run: bool = False):
        """Initialize image replacer."""
        self.config = config
        self.dry_run = dry_run
        self.changes = []

    def get_image_replacement_mapping(self) -> Dict[str, str]:
        """Get mapping of image files to replacement assets."""
        return self.config.get_image_replacement_mapping()

    def get_files_to_rename(self) -> List[str]:
        """Get list of files that need to be renamed."""
        mapping = self.get_image_replacement_mapping()
        return [path for path in mapping.keys() if "kortix" in path.lower()]

    def generate_new_filename(self, old_filename: str) -> str:
        """Generate new filename based on brand configuration."""
        new_filename = old_filename
        brand_lower = self.config.brand_name.lower()
        brand_upper = self.config.brand_name.upper()
        brand_title = self.config.brand_name.capitalize()

        # Replace in different cases
        new_filename = new_filename.replace("kortix", brand_lower)
        new_filename = new_filename.replace("KORTIX", brand_upper)
        new_filename = new_filename.replace("Kortix", brand_title)

        return new_filename

    def replace_image_file(self, old_path: Path, new_asset_name: str) -> bool:
        """Replace an image file with new asset."""
        if not self.config.new_assets_dir:
            raise ImageReplacementError("No assets directory configured")

        if not old_path.exists():
            raise ImageReplacementError(f"Source image file does not exist: {old_path}")

        new_asset_path = self.config.new_assets_dir / new_asset_name
        if not new_asset_path.exists():
            raise ImageReplacementError(f"Asset not found: {new_asset_path}")

        if not self.dry_run:
            shutil.copy2(new_asset_path, old_path)

        self.changes.append({
            "type": "image_replace",
            "file": str(old_path),
            "details": f"Replaced with {new_asset_name}"
        })

        return True

    def rename_image_file(self, old_path: Path) -> Path:
        """Rename an image file to match new branding."""
        new_filename = self.generate_new_filename(old_path.name)

        if new_filename == old_path.name:
            return old_path  # No rename needed

        new_path = old_path.parent / new_filename

        if not self.dry_run and old_path.exists():
            old_path.rename(new_path)

        self.changes.append({
            "type": "image_rename",
            "file": str(old_path),
            "details": f"Renamed to {new_filename}"
        })

        return new_path

    def validate_image_assets(self) -> bool:
        """Validate that all required image assets are available."""
        if not self.config.new_assets_dir:
            return True  # Skip validation if no assets directory

        required_assets = set(self.get_image_replacement_mapping().values())
        missing_assets = []

        for asset in required_assets:
            asset_path = self.config.new_assets_dir / asset
            if not asset_path.exists():
                missing_assets.append(asset)

        if missing_assets:
            raise ImageReplacementError(f"Missing required assets: {missing_assets}")

        return True

    def validate_image_format(self, image_path: Path, expected_format: str) -> bool:
        """Validate image format and basic properties."""
        if expected_format.lower() == 'svg':
            # For SVG, just check it's readable text
            try:
                content = image_path.read_text()
                return '<svg' in content.lower()
            except:
                return False

        # For other formats, could use PIL if available
        return True

    def backup_original_image(self, image_path: Path, backup_dir: Path):
        """Backup original image before replacement."""
        backup_path = backup_dir / image_path.name
        backup_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(image_path, backup_path)

    def process_all_images(self, base_path: Path) -> List[Change]:
        """Process all image replacements and renames."""
        changes = []
        mapping = self.get_image_replacement_mapping()

        for relative_path, asset_name in mapping.items():
            full_path = base_path / relative_path

            if full_path.exists():
                try:
                    # First rename if needed
                    new_path = self.rename_image_file(full_path)

                    # Then replace with new asset if available
                    if self.config.new_assets_dir:
                        self.replace_image_file(new_path, asset_name)

                    changes.extend([Change(
                        file_path=str(full_path),
                        change_type="IMAGE",
                        old_value=str(relative_path),
                        new_value=asset_name,
                        details=f"Image processed: {full_path.name}"
                    )])

                except ImageReplacementError as e:
                    changes.append(Change(
                        file_path=str(full_path),
                        change_type="ERROR",
                        old_value="",
                        new_value="",
                        details=f"Image processing error: {e}"
                    ))

        return changes

    def update_image_references_in_code(self, content: str) -> str:
        """Update image references in code files."""
        brand_lower = self.config.brand_name.lower()
        brand_title = self.config.brand_name.capitalize()

        # Update import statements
        content = content.replace("KortixLogo", f"{brand_title}Logo")
        content = content.replace("kortix-logo", f"{brand_lower}-logo")
        content = content.replace("kortix-symbol", f"{brand_lower}-symbol")
        content = content.replace("Kortix Logo", f"{brand_title} Logo")

        return content

    def get_image_statistics(self) -> Dict[str, Any]:
        """Get statistics about image processing."""
        return {
            "total_images_processed": len(self.changes),
            "images_replaced": len([c for c in self.changes if c["type"] == "image_replace"]),
            "images_renamed": len([c for c in self.changes if c["type"] == "image_rename"]),
        }


# ========================================================================================
# Backup Manager Class
# ========================================================================================

class BackupManager:
    """Manages backup operations for the rebranding process."""

    def __init__(self, config: BrandConfiguration, enabled: bool = True):
        """Initialize backup manager."""
        self.config = config
        self.enabled = enabled
        self.backup_dir = self.generate_backup_directory_name() if enabled else None

    def generate_backup_directory_name(self) -> Path:
        """Generate backup directory name with timestamp."""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        return Path(f"backup_rebrand_{timestamp}")

    def create_backup_directory(self):
        """Create the backup directory."""
        if self.enabled and self.backup_dir:
            self.backup_dir.mkdir(exist_ok=True)

    def backup_file(self, file_path: Path, base_path: Optional[Path] = None) -> Optional[Path]:
        """Backup a single file."""
        if not self.enabled:
            return None

        if not file_path.exists():
            raise BackupError(f"Source file does not exist: {file_path}")

        try:
            # Calculate relative path for backup structure
            if base_path:
                relative_path = file_path.relative_to(base_path)
            else:
                relative_path = file_path.name

            backup_path = self.backup_dir / relative_path
            backup_path.parent.mkdir(parents=True, exist_ok=True)

            shutil.copy2(file_path, backup_path)
            return backup_path

        except PermissionError:
            raise BackupError(f"Permission denied backing up {file_path}")
        except Exception as e:
            raise BackupError(f"Error backing up {file_path}: {e}")

    def backup_multiple_files(self, file_paths: List[Path], base_path: Path) -> List[Path]:
        """Backup multiple files."""
        backup_paths = []
        for file_path in file_paths:
            backup_path = self.backup_file(file_path, base_path)
            if backup_path:
                backup_paths.append(backup_path)
        return backup_paths

    def create_backup_manifest(self) -> Path:
        """Create backup manifest with metadata."""
        if not self.enabled or not self.backup_dir:
            raise BackupError("Backup not enabled")

        backed_up_files = []
        for file_path in self.backup_dir.rglob("*"):
            if file_path.is_file() and file_path.name != "backup_manifest.json":
                backed_up_files.append(str(file_path.relative_to(self.backup_dir)))

        manifest = {
            "timestamp": datetime.now().isoformat(),
            "config": self.config.to_dict(),
            "backed_up_files": backed_up_files,
            "backup_directory": str(self.backup_dir)
        }

        manifest_path = self.backup_dir / "backup_manifest.json"
        with open(manifest_path, 'w') as f:
            json.dump(manifest, f, indent=2)

        return manifest_path

    def restore_file(self, file_path: Path, base_path: Optional[Path] = None):
        """Restore a single file from backup."""
        if not self.enabled or not self.backup_dir:
            raise BackupError("Backup not enabled")

        if base_path:
            relative_path = file_path.relative_to(base_path)
        else:
            relative_path = file_path.name

        backup_path = self.backup_dir / relative_path
        if not backup_path.exists():
            raise BackupError(f"File {file_path} not found in backup")

        shutil.copy2(backup_path, file_path)

    def restore_all_files(self, base_path: Path) -> List[Path]:
        """Restore all files from backup."""
        if not self.enabled or not self.backup_dir:
            raise BackupError("Backup not enabled")

        restored_files = []
        for backup_file in self.backup_dir.rglob("*"):
            if backup_file.is_file() and backup_file.name != "backup_manifest.json":
                relative_path = backup_file.relative_to(self.backup_dir)
                original_path = base_path / relative_path
                original_path.parent.mkdir(parents=True, exist_ok=True)

                shutil.copy2(backup_file, original_path)
                restored_files.append(original_path)

        return restored_files

    @staticmethod
    def cleanup_old_backups(directory: Path, keep_count: int = 5):
        """Clean up old backup directories, keeping only the most recent."""
        backup_dirs = [d for d in directory.iterdir()
                      if d.is_dir() and d.name.startswith("backup_rebrand_")]

        # Sort by modification time, newest first
        backup_dirs.sort(key=lambda x: x.stat().st_mtime, reverse=True)

        # Remove old backups
        for old_backup in backup_dirs[keep_count:]:
            shutil.rmtree(old_backup)

    def get_backup_size(self) -> int:
        """Calculate total size of backup directory."""
        if not self.enabled or not self.backup_dir:
            return 0

        total_size = 0
        for file_path in self.backup_dir.rglob("*"):
            if file_path.is_file():
                total_size += file_path.stat().st_size

        return total_size

    def verify_backup_integrity(self, original_file: Path) -> bool:
        """Verify backup integrity by comparing checksums."""
        if not self.enabled or not self.backup_dir:
            return False

        try:
            relative_path = original_file.name  # Simplified for this example
            backup_path = self.backup_dir / relative_path

            if not backup_path.exists():
                return False

            # Compare file sizes first (quick check)
            if original_file.stat().st_size != backup_path.stat().st_size:
                return False

            # Compare checksums for content verification
            original_hash = hashlib.md5(original_file.read_bytes()).hexdigest()
            backup_hash = hashlib.md5(backup_path.read_bytes()).hexdigest()

            return original_hash == backup_hash

        except Exception:
            return False

    def get_backup_statistics(self) -> Dict[str, Any]:
        """Get backup statistics."""
        if not self.enabled or not self.backup_dir:
            return {"total_files": 0, "total_size": 0, "backup_directory": None}

        files = list(self.backup_dir.rglob("*"))
        file_count = len([f for f in files if f.is_file()])

        return {
            "total_files": file_count,
            "total_size": self.get_backup_size(),
            "backup_directory": str(self.backup_dir)
        }


# ========================================================================================
# Report Generator Class
# ========================================================================================

class ReportGenerator:
    """Generates comprehensive reports of rebranding operations."""

    def __init__(self, config: BrandConfiguration, changes: List[Change], dry_run: bool = False):
        """Initialize report generator."""
        self.config = config
        self.changes = changes
        self.dry_run = dry_run
        self.start_time = time.time()

    def generate_summary_statistics(self) -> Dict[str, Any]:
        """Generate summary statistics."""
        stats = {
            "total_changes": len(self.changes),
            "text_changes": len([c for c in self.changes if c.change_type == "TEXT"]),
            "image_changes": len([c for c in self.changes if c.change_type == "IMAGE"]),
            "renames": len([c for c in self.changes if c.change_type == "RENAME"]),
            "errors": len([c for c in self.changes if c.change_type == "ERROR"]),
            "files_affected": len(set(c.file_path for c in self.changes)),
        }
        return stats

    def generate_change_breakdown_by_type(self) -> Dict[str, List[Change]]:
        """Generate change breakdown by type."""
        breakdown = {}
        for change in self.changes:
            if change.change_type not in breakdown:
                breakdown[change.change_type] = []
            breakdown[change.change_type].append(change)
        return breakdown

    def generate_change_breakdown_by_directory(self) -> Dict[str, List[Change]]:
        """Generate change breakdown by directory."""
        breakdown = {}
        for change in self.changes:
            directory = str(Path(change.file_path).parent)
            if directory not in breakdown:
                breakdown[directory] = []
            breakdown[directory].append(change)
        return breakdown

    def generate_affected_files_list(self) -> List[str]:
        """Generate list of all affected files."""
        return list(set(c.file_path for c in self.changes))

    def generate_adentic_specific_sections(self) -> Dict[str, Any]:
        """Generate Adentic-specific report sections."""
        sections = {
            "brand_transformation": {
                "old_brand": "Kortix",
                "new_brand": self.config.brand_name,
                "old_product": "Suna",
                "new_product": self.config.product_name,
                "transformation_summary": f"Kortix → {self.config.brand_name}, Suna → {self.config.product_name}"
            },
            "url_updates": {
                "website": self.config.website_url,
                "twitter": self.config.twitter_url,
                "github": self.config.github_url,
                "linkedin": self.config.linkedin_url,
            },
            "asset_replacements": {
                "assets_directory": str(self.config.new_assets_dir) if self.config.new_assets_dir else None,
                "image_mapping": self.config.get_image_replacement_mapping(),
            }
        }
        return sections

    def calculate_execution_time(self) -> float:
        """Calculate execution time."""
        return time.time() - self.start_time

    def generate_full_report_data(self) -> Dict[str, Any]:
        """Generate complete report data structure."""
        try:
            report = {
                "timestamp": datetime.now().isoformat(),
                "execution_info": {
                    "dry_run": self.dry_run,
                    "brand_name": self.config.brand_name,
                    "total_duration": self.calculate_execution_time(),
                },
                "configuration": self.config.to_dict(),
                "summary": self.generate_summary_statistics(),
                "changes_by_type": {k: [asdict(c) for c in v]
                                   for k, v in self.generate_change_breakdown_by_type().items()},
                "changes_by_directory": {k: [asdict(c) for c in v]
                                        for k, v in self.generate_change_breakdown_by_directory().items()},
                "affected_files": self.generate_affected_files_list(),
                "adentic_transformation": self.generate_adentic_specific_sections(),
                "detailed_changes": [asdict(c) for c in self.changes]
            }
            return report
        except Exception as e:
            raise ReportError(f"Error generating report data: {e}")

    def save_json_report(self, output_dir: Optional[Path] = None) -> Path:
        """Save report as JSON file."""
        if output_dir is None:
            output_dir = Path.cwd()

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        brand_name = self.config.brand_name.lower()
        filename = f"rebrand_report_{brand_name}_{timestamp}.json"
        report_path = output_dir / filename

        report_data = self.generate_full_report_data()

        with open(report_path, 'w') as f:
            json.dump(report_data, f, indent=2, default=str)

        return report_path

    def save_html_report(self, output_dir: Optional[Path] = None) -> Path:
        """Save report as HTML file."""
        if output_dir is None:
            output_dir = Path.cwd()

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"rebrand_report_{timestamp}.html"
        report_path = output_dir / filename

        report_data = self.generate_full_report_data()

        html_content = f"""
        <!DOCTYPE html>
        <html>
        <head>
            <title>Rebranding Report - {self.config.brand_name}</title>
            <style>
                body {{ font-family: Arial, sans-serif; margin: 40px; }}
                .summary {{ background: #f5f5f5; padding: 20px; border-radius: 5px; }}
                .change {{ margin: 10px 0; padding: 10px; background: #fff; border: 1px solid #ddd; }}
                .error {{ background: #ffe6e6; }}
            </style>
        </head>
        <body>
            <h1>Rebranding Report - {self.config.brand_name}</h1>
            <div class="summary">
                <h2>Summary</h2>
                <p>Total Changes: {report_data['summary']['total_changes']}</p>
                <p>Files Affected: {report_data['summary']['files_affected']}</p>
                <p>Brand: Kortix → {self.config.brand_name}</p>
                <p>Product: Suna → {self.config.product_name}</p>
            </div>
            <h2>Detailed Changes</h2>
            {"".join(f'<div class="change {"error" if c["change_type"] == "ERROR" else ""}">'
                    f'<strong>{c["change_type"]}</strong>: {c["file_path"]}<br>'
                    f'{c["details"]}</div>'
                    for c in report_data["detailed_changes"])}
        </body>
        </html>
        """

        report_path.write_text(html_content)
        return report_path

    def save_markdown_report(self, output_dir: Optional[Path] = None) -> Path:
        """Save report as Markdown file."""
        if output_dir is None:
            output_dir = Path.cwd()

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"rebrand_report_{timestamp}.md"
        report_path = output_dir / filename

        report_data = self.generate_full_report_data()

        md_content = f"""# Rebranding Report - {self.config.brand_name}

## Summary

- **Total Changes**: {report_data['summary']['total_changes']}
- **Files Affected**: {report_data['summary']['files_affected']}
- **Brand Transformation**: Kortix → {self.config.brand_name}
- **Product Transformation**: Suna → {self.config.product_name}
- **Execution Time**: {report_data['execution_info']['total_duration']:.2f} seconds
- **Dry Run**: {report_data['execution_info']['dry_run']}

## Configuration

```json
{json.dumps(report_data['configuration'], indent=2)}
```

## Changes by Type

| Type | Count |
|------|-------|
| Text | {report_data['summary']['text_changes']} |
| Image | {report_data['summary']['image_changes']} |
| Rename | {report_data['summary']['renames']} |
| Error | {report_data['summary']['errors']} |

## Detailed Changes

| File | Type | Details |
|------|------|---------|
{"".join(f"| {c['file_path']} | {c['change_type']} | {c['details']} |" + chr(10) for c in report_data['detailed_changes'])}
"""

        report_path.write_text(md_content)
        return report_path

    def save_reports(self, output_dir: Optional[Path] = None, formats: List[str] = None) -> List[Path]:
        """Save reports in multiple formats."""
        if formats is None:
            formats = ["json"]

        report_paths = []

        if "json" in formats:
            report_paths.append(self.save_json_report(output_dir))
        if "html" in formats:
            report_paths.append(self.save_html_report(output_dir))
        if "markdown" in formats:
            report_paths.append(self.save_markdown_report(output_dir))

        return report_paths

    def generate_backup_report_section(self, backup_dir: Optional[Path], backup_enabled: bool) -> Dict[str, Any]:
        """Generate backup-related report section."""
        return {
            "enabled": backup_enabled,
            "backup_directory": str(backup_dir) if backup_dir else None,
            "files_backed_up": len(list(backup_dir.rglob("*"))) if backup_dir and backup_dir.exists() else 0
        }

    def generate_validation_report_section(self, validation_results: Dict[str, Any]) -> Dict[str, Any]:
        """Generate validation report section."""
        return validation_results

    def format_file_size(self, size_bytes: int) -> str:
        """Format file size for display."""
        for unit in ['B', 'KB', 'MB', 'GB']:
            if size_bytes < 1024:
                return f"{size_bytes:.1f} {unit}"
            size_bytes /= 1024
        return f"{size_bytes:.1f} TB"

    def generate_change_timeline(self) -> List[Dict[str, Any]]:
        """Generate timeline of changes."""
        timeline = []
        for change in sorted(self.changes, key=lambda c: c.timestamp or 0):
            timeline.append({
                "timestamp": change.timestamp,
                "file": change.file_path,
                "type": change.change_type,
                "details": change.details
            })
        return timeline

    def generate_risk_assessment(self) -> Dict[str, Any]:
        """Generate risk assessment section."""
        error_count = len([c for c in self.changes if c.change_type == "ERROR"])
        total_changes = len(self.changes)

        if error_count > total_changes * 0.1:
            risk_level = "high"
        elif total_changes > 100:
            risk_level = "medium"
        else:
            risk_level = "low"

        return {
            "risk_level": risk_level,
            "potential_issues": [
                "Verify all tests pass after rebranding",
                "Check for hardcoded references not caught by automatic replacement",
                "Validate image assets are properly sized and formatted",
                "Review configuration files for environment-specific values"
            ],
            "recommendations": [
                "Run comprehensive test suite",
                "Manual verification of critical user flows",
                "Review documentation for accuracy",
                "Test deployment pipeline with new assets"
            ]
        }

    def generate_rollback_instructions(self, backup_dir: Optional[Path]) -> Dict[str, Any]:
        """Generate rollback instructions."""
        return {
            "steps": [
                "Stop all running services",
                f"Restore files from backup directory: {backup_dir}",
                "Verify file integrity",
                "Restart services",
                "Run smoke tests"
            ],
            "commands": [
                f"cp -r {backup_dir}/* .",
                "npm run build",
                "npm test",
                "docker-compose up -d"
            ],
            "warnings": [
                "Backup directory must be intact",
                "Any changes made after backup will be lost",
                "Test in staging environment first"
            ]
        }

    def verify_adentic_branding_completeness(self) -> Dict[str, Any]:
        """Verify completeness of Adentic branding changes."""
        brand_changes = len([c for c in self.changes if "kortix" in c.old_value.lower()])
        product_changes = len([c for c in self.changes if "suna" in c.old_value.lower()])
        url_changes = len([c for c in self.changes if "suna.so" in c.old_value.lower()])
        asset_changes = len([c for c in self.changes if c.change_type == "IMAGE"])

        total_expected = 50  # Rough estimate
        actual_changes = brand_changes + product_changes + url_changes + asset_changes
        completeness_score = min(actual_changes / total_expected, 1.0)

        return {
            "brand_name_updates": brand_changes,
            "product_name_updates": product_changes,
            "url_updates": url_changes,
            "asset_updates": asset_changes,
            "completeness_score": completeness_score
        }

    def generate_post_rebrand_checklist(self) -> List[str]:
        """Generate post-rebranding checklist."""
        return [
            "Run full test suite to ensure functionality",
            "Build and test frontend application",
            "Verify all images load correctly",
            "Check API endpoints and documentation",
            "Test authentication and authorization",
            "Validate configuration files",
            "Review error logs for issues",
            "Test deployment pipeline",
            "Update CI/CD configurations if needed",
            "Notify team of rebranding completion"
        ]


# ========================================================================================
# Main Rebrander Class (Refactored)
# ========================================================================================

class Rebrander:
    """Main orchestrator for the rebranding process."""

    def __init__(self, config: Union[BrandConfiguration, Dict], dry_run: bool = False,
                 backup: bool = True, base_path: Optional[Path] = None):
        """Initialize rebrander with configuration."""
        if isinstance(config, dict):
            self.config = BrandConfiguration(config)
        else:
            self.config = config

        self.dry_run = dry_run
        self.backup_enabled = backup and not dry_run
        self.base_path = base_path or Path.cwd()

        # Initialize components
        self.backup_manager = BackupManager(self.config, enabled=self.backup_enabled)
        self.text_replacer = TextReplacer(self.config, dry_run=dry_run)
        self.image_replacer = ImageReplacer(self.config, dry_run=dry_run)

        # Initialize state
        self.all_changes = []
        self.start_time = time.time()

        # Create backup directory if needed
        if self.backup_enabled:
            self.backup_manager.create_backup_directory()

    @property
    def backup_dir(self) -> Optional[Path]:
        """Get backup directory path."""
        return self.backup_manager.backup_dir

    def _create_lock_file(self):
        """Create lock file to prevent concurrent execution."""
        lock_file = self.base_path / ".rebrand.lock"
        if lock_file.exists():
            raise Exception("Another rebranding process is already running")

        lock_file.write_text(f"pid:{os.getpid()}\nstart:{datetime.now().isoformat()}")
        return lock_file

    def _remove_lock_file(self, lock_file: Path):
        """Remove lock file."""
        if lock_file.exists():
            lock_file.unlink()

    def _backup_file_if_needed(self, file_path: Path):
        """Backup file if backup is enabled."""
        if self.backup_enabled:
            try:
                self.backup_manager.backup_file(file_path, self.base_path)
            except BackupError as e:
                print(f"Warning: Failed to backup {file_path}: {e}")

    def process_text_files(self) -> List[Change]:
        """Process all text files for rebranding."""
        print("Processing text files...")

        changes = []
        patterns = self.text_replacer.get_file_patterns_to_process()

        for pattern in patterns:
            for file_path in self.base_path.rglob(pattern):
                if self.text_replacer.should_skip_file(file_path):
                    continue

                # Skip backup directory
                if (self.backup_dir and
                    self.backup_dir in file_path.parents):
                    continue

                try:
                    # Backup before modification
                    self._backup_file_if_needed(file_path)

                    # Process file
                    file_changes = self.text_replacer.replace_text_in_file(file_path)
                    changes.extend(file_changes)

                    # Log changes
                    for change in file_changes:
                        print(f"{'[DRY RUN] ' if self.dry_run else ''}[TEXT] {change.file_path}: {change.details}")

                except ReplacementError as e:
                    error_change = Change(
                        file_path=str(file_path),
                        change_type="ERROR",
                        old_value="",
                        new_value="",
                        details=f"Text processing error: {e}"
                    )
                    changes.append(error_change)
                    print(f"Error processing {file_path}: {e}")

        return changes

    def process_image_files(self) -> List[Change]:
        """Process all image files for rebranding."""
        print("Processing image files...")

        if not self.config.new_assets_dir:
            print("Warning: No assets directory specified, skipping image replacement")
            return []

        try:
            self.image_replacer.validate_image_assets()
        except ImageReplacementError as e:
            print(f"Warning: Asset validation failed: {e}")
            return []

        changes = []
        mapping = self.image_replacer.get_image_replacement_mapping()

        for relative_path, asset_name in mapping.items():
            file_path = self.base_path / relative_path

            if file_path.exists():
                try:
                    # Backup before modification
                    self._backup_file_if_needed(file_path)

                    # Rename file if needed
                    new_path = self.image_replacer.rename_image_file(file_path)
                    if new_path != file_path:
                        rename_change = Change(
                            file_path=str(file_path),
                            change_type="RENAME",
                            old_value=file_path.name,
                            new_value=new_path.name,
                            details=f"Renamed to {new_path.name}"
                        )
                        changes.append(rename_change)
                        print(f"{'[DRY RUN] ' if self.dry_run else ''}[RENAME] {file_path}: → {new_path.name}")

                    # Replace with new asset
                    if self.image_replacer.replace_image_file(new_path, asset_name):
                        replace_change = Change(
                            file_path=str(new_path),
                            change_type="IMAGE",
                            old_value=str(relative_path),
                            new_value=asset_name,
                            details=f"Replaced with {asset_name}"
                        )
                        changes.append(replace_change)
                        print(f"{'[DRY RUN] ' if self.dry_run else ''}[IMAGE] {new_path}: Replaced with {asset_name}")

                except ImageReplacementError as e:
                    error_change = Change(
                        file_path=str(file_path),
                        change_type="ERROR",
                        old_value="",
                        new_value="",
                        details=f"Image processing error: {e}"
                    )
                    changes.append(error_change)
                    print(f"Error processing {file_path}: {e}")

        return changes

    def process_component_files(self) -> List[Change]:
        """Process component files that may need renaming."""
        print("Processing component files...")

        changes = []
        component_files = [
            self.base_path / "frontend/src/components/sidebar/kortix-logo.tsx",
            self.base_path / "frontend/src/components/sidebar/kortix-enterprise-modal.tsx",
        ]

        for file_path in component_files:
            if file_path.exists():
                try:
                    # Backup before modification
                    self._backup_file_if_needed(file_path)

                    # Generate new name
                    new_name = self.image_replacer.generate_new_filename(file_path.name)

                    if new_name != file_path.name:
                        new_path = file_path.parent / new_name

                        if not self.dry_run:
                            file_path.rename(new_path)

                        change = Change(
                            file_path=str(file_path),
                            change_type="RENAME",
                            old_value=file_path.name,
                            new_value=new_name,
                            details=f"Component renamed to {new_name}"
                        )
                        changes.append(change)
                        print(f"{'[DRY RUN] ' if self.dry_run else ''}[RENAME] {file_path}: → {new_name}")

                except Exception as e:
                    error_change = Change(
                        file_path=str(file_path),
                        change_type="ERROR",
                        old_value="",
                        new_value="",
                        details=f"Component processing error: {e}"
                    )
                    changes.append(error_change)
                    print(f"Error processing {file_path}: {e}")

        return changes

    def run(self) -> List[Change]:
        """Execute the complete rebranding process."""
        print("Starting rebranding process...")
        print(f"Mode: {'DRY RUN' if self.dry_run else 'LIVE'}")
        print(f"Backup: {'Enabled' if self.backup_enabled else 'Disabled'}")
        print(f"Target Brand: {self.config.brand_name}")
        print(f"Base Path: {self.base_path}\n")

        lock_file = None
        try:
            # Create lock file to prevent concurrent execution
            lock_file = self._create_lock_file()

            # Process different types of files
            text_changes = self.process_text_files()
            image_changes = self.process_image_files()
            component_changes = self.process_component_files()

            # Combine all changes
            self.all_changes = text_changes + image_changes + component_changes

            # Create backup manifest if backup enabled
            if self.backup_enabled and self.backup_dir:
                try:
                    self.backup_manager.create_backup_manifest()
                    print(f"\nBackup manifest created: {self.backup_dir / 'backup_manifest.json'}")
                except BackupError as e:
                    print(f"Warning: Failed to create backup manifest: {e}")

            print(f"\nRebranding process completed!")
            print(f"Total changes: {len(self.all_changes)}")

            if self.dry_run:
                print("\n⚠️  This was a DRY RUN. No files were actually modified.")
                print("Remove --dry-run flag to apply changes.")

            return self.all_changes

        finally:
            if lock_file:
                self._remove_lock_file(lock_file)

    def generate_report(self, output_dir: Optional[Path] = None,
                       formats: List[str] = None) -> Dict[str, Any]:
        """Generate comprehensive rebranding report."""
        if formats is None:
            formats = ["json"]

        report_generator = ReportGenerator(
            config=self.config,
            changes=self.all_changes,
            dry_run=self.dry_run
        )

        # Generate and save reports
        report_paths = report_generator.save_reports(output_dir, formats)

        # Generate report data for return
        report_data = report_generator.generate_full_report_data()

        # Add backup information
        report_data["backup"] = report_generator.generate_backup_report_section(
            backup_dir=self.backup_dir,
            backup_enabled=self.backup_enabled
        )

        # Print summary
        summary = report_data["summary"]
        print(f"\nReport generated: {', '.join(str(p) for p in report_paths)}")
        print(f"Total changes: {summary['total_changes']}")
        print(f"  - Text changes: {summary['text_changes']}")
        print(f"  - Image replacements: {summary['image_changes']}")
        print(f"  - File renames: {summary['renames']}")
        print(f"  - Errors: {summary['errors']}")

        if self.backup_dir:
            print(f"\nBackup created at: {self.backup_dir}")

        return report_data

    def rollback_from_backup(self):
        """Rollback changes using backup."""
        if not self.backup_enabled or not self.backup_dir:
            raise Exception("Backup not available for rollback")

        print("Rolling back changes from backup...")

        try:
            restored_files = self.backup_manager.restore_all_files(self.base_path)
            print(f"Restored {len(restored_files)} files from backup")

            # Remove lock file if it exists
            lock_file = self.base_path / ".rebrand.lock"
            if lock_file.exists():
                lock_file.unlink()

            print("Rollback completed successfully")

        except BackupError as e:
            print(f"Rollback failed: {e}")
            raise


# ========================================================================================
# Main Function (Backward Compatible CLI)
# ========================================================================================

def main():
    """Main function maintaining backward compatibility with existing CLI."""
    parser = argparse.ArgumentParser(description="Automated rebranding script for Kortix/Suna")
    parser.add_argument("--config", type=str, help="Path to rebranding config JSON file")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without modifying files")
    parser.add_argument("--no-backup", action="store_true", help="Skip creating backups")

    # Individual config options for backward compatibility
    parser.add_argument("--brand-name", type=str, help="New brand name (replaces 'Kortix')")
    parser.add_argument("--product-name", type=str, help="New product name (replaces 'Suna')")
    parser.add_argument("--company-name", type=str, help="New company name (replaces 'Kortix AI')")
    parser.add_argument("--website-url", type=str, help="New website URL")
    parser.add_argument("--new-assets-dir", type=str, help="Directory containing new image assets")

    args = parser.parse_args()

    try:
        # Load configuration
        if args.config:
            config = BrandConfiguration.from_file(args.config)
        else:
            # Build config from command line arguments
            config_data = {}

            if args.brand_name:
                config_data["brand_name"] = args.brand_name
            if args.product_name:
                config_data["product_name"] = args.product_name
            if args.company_name:
                config_data["company_name"] = args.company_name
            if args.website_url:
                config_data["website_url"] = args.website_url
            if args.new_assets_dir:
                config_data["new_assets_dir"] = args.new_assets_dir

            # Validate required fields
            if not config_data.get("brand_name"):
                print("Error: brand_name is required. Use --brand-name or provide in config file.")
                return 1

            # Set defaults
            if not config_data.get("product_name"):
                config_data["product_name"] = config_data["brand_name"]

            if not config_data.get("company_name"):
                config_data["company_name"] = f"{config_data['brand_name']} AI"

            config = BrandConfiguration(config_data)

        # Create and run rebrander
        rebrander = Rebrander(
            config=config,
            dry_run=args.dry_run,
            backup=not args.no_backup
        )

        # Execute rebranding
        changes = rebrander.run()

        # Generate report
        report = rebrander.generate_report(formats=["json", "markdown"])

        return 0

    except (ConfigValidationError, ReplacementError, ImageReplacementError,
            BackupError, ReportError) as e:
        print(f"Error: {e}")
        return 1
    except KeyboardInterrupt:
        print("\nRebranding interrupted by user")
        return 1
    except Exception as e:
        print(f"Unexpected error: {e}")
        return 1


if __name__ == "__main__":
    exit(main())