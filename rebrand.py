#!/usr/bin/env python3
"""
Kortix/Suna Rebranding Script
Automates the process of rebranding the entire codebase
"""

import os
import re
import json
import shutil
import argparse
from pathlib import Path
from typing import Dict, List, Tuple
from datetime import datetime

class Rebrander:
    def __init__(self, config: Dict, dry_run: bool = False, backup: bool = True):
        self.config = config
        self.dry_run = dry_run
        self.backup = backup
        self.changes = []
        self.backup_dir = None

        if self.backup and not self.dry_run:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            self.backup_dir = Path(f"backup_rebrand_{timestamp}")

    def log_change(self, file_path: str, change_type: str, details: str):
        """Log a change for reporting"""
        self.changes.append({
            "file": file_path,
            "type": change_type,
            "details": details
        })
        print(f"{'[DRY RUN] ' if self.dry_run else ''}[{change_type}] {file_path}: {details}")

    def backup_file(self, file_path: Path):
        """Backup a file before modification"""
        if self.backup and not self.dry_run:
            relative_path = file_path.relative_to(Path.cwd())
            backup_path = self.backup_dir / relative_path
            backup_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file_path, backup_path)

    def replace_text_in_file(self, file_path: Path, replacements: List[Tuple[str, str]]):
        """Replace text patterns in a file"""
        try:
            content = file_path.read_text(encoding='utf-8')
            original_content = content

            for old_text, new_text in replacements:
                if old_text in content:
                    content = content.replace(old_text, new_text)
                    self.log_change(str(file_path), "TEXT", f"'{old_text}' → '{new_text}'")

            if content != original_content:
                if not self.dry_run:
                    self.backup_file(file_path)
                    file_path.write_text(content, encoding='utf-8')
                return True
        except Exception as e:
            print(f"Error processing {file_path}: {e}")
            return False
        return False

    def replace_image_file(self, old_path: Path, new_assets_dir: Path):
        """Replace an image file with new asset"""
        filename = old_path.name
        new_file = new_assets_dir / filename

        if new_file.exists():
            if not self.dry_run:
                self.backup_file(old_path)
                shutil.copy2(new_file, old_path)
            self.log_change(str(old_path), "IMAGE", f"Replaced with {new_file}")
            return True
        else:
            print(f"Warning: New asset not found: {new_file}")
            return False

    def rename_file(self, old_path: Path, old_brand: str, new_brand: str):
        """Rename a file containing brand name"""
        filename = old_path.name
        if old_brand.lower() in filename.lower():
            new_filename = filename.replace(old_brand.lower(), new_brand.lower())
            new_filename = new_filename.replace(old_brand.capitalize(), new_brand.capitalize())
            new_path = old_path.parent / new_filename

            if not self.dry_run:
                self.backup_file(old_path)
                old_path.rename(new_path)
            self.log_change(str(old_path), "RENAME", f"→ {new_filename}")
            return new_path
        return old_path

    def process_text_files(self):
        """Process all text files for brand references"""
        text_replacements = [
            # Brand names
            ("Kortix Suna", self.config.get("full_product_name", "NewBrand Product")),
            ("Kortix AI", self.config.get("company_name", "NewBrand AI")),
            ("Kortix", self.config.get("brand_name", "NewBrand")),
            ("kortix", self.config.get("brand_name", "NewBrand").lower()),
            ("KORTIX", self.config.get("brand_name", "NewBrand").upper()),
            ("Suna", self.config.get("product_name", "Product")),
            ("suna", self.config.get("product_name", "Product").lower()),
            ("SUNA", self.config.get("product_name", "Product").upper()),

            # URLs and social
            ("https://suna.so/", self.config.get("website_url", "https://newbrand.com/")),
            ("https://x.com/kortixai", self.config.get("twitter_url", "https://x.com/newbrand")),
            ("https://github.com/kortix-ai/", self.config.get("github_url", "https://github.com/newbrand/")),
            ("https://www.linkedin.com/company/kortix/", self.config.get("linkedin_url", "https://www.linkedin.com/company/newbrand/")),

            # Environment variables
            ("KORTIX_ADMIN_API_KEY", f"{self.config.get('brand_name', 'NEWBRAND').upper()}_ADMIN_API_KEY"),
        ]

        # Define file patterns to process
        patterns = [
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

        # Exclude directories
        exclude_dirs = {"node_modules", ".git", "dist", "build", ".next", "__pycache__", "venv", ".venv"}

        for pattern in patterns:
            for file_path in Path.cwd().rglob(pattern):
                # Skip excluded directories
                if any(part in exclude_dirs for part in file_path.parts):
                    continue

                # Skip backup directory
                if self.backup_dir and self.backup_dir in file_path.parents:
                    continue

                # Skip this script
                if file_path.name == "rebrand.py":
                    continue

                self.replace_text_in_file(file_path, text_replacements)

    def process_image_files(self):
        """Replace image files with new assets"""
        if not self.config.get("new_assets_dir"):
            print("Warning: No new_assets_dir specified, skipping image replacement")
            return

        new_assets_dir = Path(self.config["new_assets_dir"])
        if not new_assets_dir.exists():
            print(f"Error: New assets directory not found: {new_assets_dir}")
            return

        # Image files to replace
        image_files = [
            Path("frontend/public/kortix-logo.svg"),
            Path("frontend/public/kortix-logo-white.svg"),
            Path("frontend/public/kortix-symbol.svg"),
            Path("frontend/public/favicon.png"),
            Path("frontend/public/banner.png"),
            Path("frontend/public/thumbnail-dark.png"),
            Path("frontend/public/thumbnail-light.png"),
            Path("frontend/src/app/favicon.ico"),
            Path("apps/mobile/assets/images/icon.png"),
            Path("apps/mobile/assets/images/favicon.png"),
            Path("apps/mobile/assets/images/adaptive-icon.png"),
            Path("apps/mobile/assets/images/kortix-logo-square.svg"),
        ]

        for img_path in image_files:
            if img_path.exists():
                # First rename the file if it contains brand name
                new_path = self.rename_file(img_path, "kortix", self.config.get("brand_name", "newbrand"))
                # Then replace with new asset
                self.replace_image_file(new_path, new_assets_dir)

    def process_component_files(self):
        """Rename component files containing brand names"""
        brand_files = [
            Path("frontend/src/components/sidebar/kortix-logo.tsx"),
            Path("frontend/src/components/sidebar/kortix-enterprise-modal.tsx"),
        ]

        for file_path in brand_files:
            if file_path.exists():
                self.rename_file(file_path, "kortix", self.config.get("brand_name", "newbrand"))

    def generate_report(self):
        """Generate a report of all changes"""
        report = {
            "timestamp": datetime.now().isoformat(),
            "dry_run": self.dry_run,
            "backup_dir": str(self.backup_dir) if self.backup_dir else None,
            "config": self.config,
            "changes": self.changes,
            "summary": {
                "total_changes": len(self.changes),
                "text_changes": len([c for c in self.changes if c["type"] == "TEXT"]),
                "image_changes": len([c for c in self.changes if c["type"] == "IMAGE"]),
                "renames": len([c for c in self.changes if c["type"] == "RENAME"])
            }
        }

        report_path = Path(f"rebrand_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json")
        with open(report_path, 'w') as f:
            json.dump(report, f, indent=2)

        print(f"\nReport saved to: {report_path}")
        print(f"Total changes: {report['summary']['total_changes']}")
        print(f"  - Text changes: {report['summary']['text_changes']}")
        print(f"  - Image replacements: {report['summary']['image_changes']}")
        print(f"  - File renames: {report['summary']['renames']}")

        if self.backup_dir:
            print(f"\nBackup created at: {self.backup_dir}")

    def run(self):
        """Execute the rebranding process"""
        print("Starting rebranding process...")
        print(f"Mode: {'DRY RUN' if self.dry_run else 'LIVE'}")
        print(f"Backup: {'Enabled' if self.backup else 'Disabled'}\n")

        # Create backup directory
        if self.backup_dir and not self.dry_run:
            self.backup_dir.mkdir(exist_ok=True)

        # Process files
        print("Processing text files...")
        self.process_text_files()

        print("\nProcessing image files...")
        self.process_image_files()

        print("\nRenaming component files...")
        self.process_component_files()

        # Generate report
        self.generate_report()

        if self.dry_run:
            print("\n⚠️  This was a DRY RUN. No files were actually modified.")
            print("Remove --dry-run flag to apply changes.")

def main():
    parser = argparse.ArgumentParser(description="Automated rebranding script for Kortix/Suna")
    parser.add_argument("--config", type=str, help="Path to rebranding config JSON file")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without modifying files")
    parser.add_argument("--no-backup", action="store_true", help="Skip creating backups")

    # Individual config options
    parser.add_argument("--brand-name", type=str, help="New brand name (replaces 'Kortix')")
    parser.add_argument("--product-name", type=str, help="New product name (replaces 'Suna')")
    parser.add_argument("--company-name", type=str, help="New company name (replaces 'Kortix AI')")
    parser.add_argument("--website-url", type=str, help="New website URL")
    parser.add_argument("--new-assets-dir", type=str, help="Directory containing new image assets")

    args = parser.parse_args()

    # Load config
    if args.config:
        with open(args.config, 'r') as f:
            config = json.load(f)
    else:
        config = {}

    # Override config with command line arguments
    if args.brand_name:
        config["brand_name"] = args.brand_name
    if args.product_name:
        config["product_name"] = args.product_name
    if args.company_name:
        config["company_name"] = args.company_name
    if args.website_url:
        config["website_url"] = args.website_url
    if args.new_assets_dir:
        config["new_assets_dir"] = args.new_assets_dir

    # Set defaults if not provided
    if not config.get("brand_name"):
        print("Error: brand_name is required. Use --brand-name or provide in config file.")
        return

    if not config.get("product_name"):
        config["product_name"] = config["brand_name"]

    if not config.get("company_name"):
        config["company_name"] = f"{config['brand_name']} AI"

    if not config.get("full_product_name"):
        config["full_product_name"] = f"{config['brand_name']} {config['product_name']}"

    # Create and run rebrander
    rebrander = Rebrander(
        config=config,
        dry_run=args.dry_run,
        backup=not args.no_backup
    )

    rebrander.run()

if __name__ == "__main__":
    main()