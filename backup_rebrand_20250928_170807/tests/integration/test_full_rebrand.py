"""
Integration tests for full rebranding workflow in the rebranding system.
These tests will fail until the rebrand module is properly refactored.
"""

import pytest
import tempfile
import json
import shutil
import time
from pathlib import Path
from unittest.mock import Mock, patch
from PIL import Image

# This import will fail initially since we need to refactor rebrand.py
from rebrand import Rebrander, BrandConfiguration


class TestFullRebrandWorkflow:
    """Integration test suite for complete rebranding workflow."""

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
        
        self.comprehensive_project_structure = {
            # Frontend React/TypeScript files
            "frontend/src/app.tsx": '''
                import React from 'react';
                import { KortixLogo } from './components/KortixLogo';
                
                const App: React.FC = () => {
                    return (
                        <div className="app">
                            <header>
                                <KortixLogo />
                                <h1>Welcome to Kortix Suna</h1>
                            </header>
                            <main>
                                <p>Powered by Kortix AI technology</p>
                                <a href="https://suna.so/">Learn more</a>
                            </main>
                        </div>
                    );
                };
                
                export default App;
            ''',
            "frontend/src/components/KortixLogo.tsx": '''
                import React from 'react';
                
                export const KortixLogo: React.FC = () => {
                    return (
                        <div className="kortix-logo">
                            <img src="/kortix-logo.svg" alt="Kortix Logo" />
                            <span>Kortix</span>
                        </div>
                    );
                };
            ''',
            "frontend/src/components/Header.tsx": '''
                const Header = () => {
                    const title = "Suna AI Assistant";
                    const subtitle = "By Kortix AI";
                    
                    return (
                        <header className="header">
                            <img src="/kortix-symbol.svg" alt="Symbol" />
                            <div>
                                <h1>{title}</h1>
                                <p>{subtitle}</p>
                            </div>
                        </header>
                    );
                };
                
                export default Header;
            ''',
            
            # Backend Python files
            "backend/api.py": '''
                from fastapi import FastAPI
                import os
                
                app = FastAPI(
                    title="Kortix Suna API",
                    description="AI Assistant API by Kortix AI",
                    version="1.0.0"
                )
                
                KORTIX_ADMIN_KEY = os.getenv("KORTIX_ADMIN_API_KEY")
                SUNA_VERSION = "2.0.0"
                
                @app.get("/")
                async def root():
                    return {
                        "app": "Kortix Suna",
                        "company": "Kortix AI",
                        "website": "https://suna.so/"
                    }
            ''',
            "backend/config.py": '''
                import os
                
                class Config:
                    APP_NAME = "Kortix Suna"
                    COMPANY_NAME = "Kortix AI"
                    PRODUCT_NAME = "Suna"
                    API_BASE_URL = "https://api.suna.so"
                    WEBSITE_URL = "https://suna.so"
                    
                    # Environment variables
                    ADMIN_API_KEY = os.getenv("KORTIX_ADMIN_API_KEY")
                    DEBUG = os.getenv("SUNA_DEBUG", "false").lower() == "true"
                
                class DatabaseConfig:
                    def __init__(self):
                        self.url = f"postgresql://user:pass@localhost/kortix_suna"
                        self.app_name = "Kortix Suna DB"
            ''',
            
            # Configuration files
            "package.json": '''
                {
                    "name": "kortix-suna",
                    "version": "2.0.0",
                    "description": "AI assistant platform by Kortix AI",
                    "homepage": "https://suna.so",
                    "repository": {
                        "type": "git",
                        "url": "https://github.com/kortix-ai/suna.git"
                    },
                    "keywords": ["kortix", "suna", "ai", "assistant"],
                    "author": "Kortix AI",
                    "scripts": {
                        "dev": "next dev",
                        "build": "next build",
                        "start": "next start"
                    }
                }
            ''',
            "docker-compose.yml": '''
                version: '3.8'
                services:
                  suna-api:
                    build: ./backend
                    environment:
                      - APP_NAME=Kortix Suna
                      - KORTIX_ADMIN_API_KEY=${KORTIX_ADMIN_API_KEY}
                    ports:
                      - "8000:8000"
                  
                  suna-frontend:
                    build: ./frontend
                    environment:
                      - NEXT_PUBLIC_APP_NAME=Kortix Suna
                      - NEXT_PUBLIC_API_URL=https://api.suna.so
                    ports:
                      - "3000:3000"
            ''',
            ".env.example": '''
                # Kortix Suna Environment Variables
                KORTIX_ADMIN_API_KEY=your_admin_key_here
                SUNA_API_URL=https://api.suna.so
                SUNA_DEBUG=false
                APP_NAME="Kortix Suna"
                COMPANY_NAME="Kortix AI"
            ''',
            
            # Documentation
            "README.md": '''
                # Kortix Suna
                
                An advanced AI assistant platform built by Kortix AI.
                
                ## Overview
                
                Suna is the flagship product of Kortix AI, providing intelligent assistance
                through natural language processing and machine learning.
                
                ## Quick Start
                
                1. Visit [suna.so](https://suna.so) to get started
                2. Sign up for an account
                3. Get your API key from the dashboard
                
                ## API Documentation
                
                Our API is available at `https://api.suna.so/docs`
                
                ## Support
                
                - Website: [suna.so](https://suna.so)
                - Twitter: [@kortixai](https://x.com/kortixai)
                - GitHub: [kortix-ai/suna](https://github.com/kortix-ai/suna)
                - LinkedIn: [Kortix AI](https://www.linkedin.com/company/kortix/)
                
                ## License
                
                Copyright © 2023 Kortix AI. All rights reserved.
            ''',
            "docs/api-reference.md": '''
                # Kortix Suna API Reference
                
                Welcome to the Suna API documentation.
                
                ## Base URL
                
                ```
                https://api.suna.so/v1
                ```
                
                ## Authentication
                
                Include your Kortix API key in the header:
                
                ```
                Authorization: Bearer your_kortix_api_key
                ```
            ''',
            "docs/deployment.md": '''
                # Deploying Kortix Suna
                
                This guide covers deploying the Suna platform to production.
                
                ## Environment Variables
                
                Set the following environment variables:
                
                - `KORTIX_ADMIN_API_KEY`: Your admin API key
                - `SUNA_API_URL`: The API base URL
                - `APP_NAME`: Set to "Kortix Suna"
            ''',
            
            # Static assets
            "frontend/public/kortix-logo.svg": '<svg xmlns="http://www.w3.org/2000/svg"><text>Kortix Logo</text></svg>',
            "frontend/public/kortix-logo-white.svg": '<svg xmlns="http://www.w3.org/2000/svg"><text fill="white">Kortix Logo</text></svg>',
            "frontend/public/kortix-symbol.svg": '<svg xmlns="http://www.w3.org/2000/svg"><circle r="20" fill="blue"/></svg>',
            "frontend/public/favicon.ico": b'fake ICO content',
            "apps/mobile/assets/images/kortix-logo-square.svg": '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" fill="blue"/></svg>'
        }

    def create_comprehensive_test_project(self, tmp_path: Path) -> Path:
        """Create a comprehensive test project structure."""
        project_root = tmp_path / "test_project"
        project_root.mkdir()
        
        for file_path, content in self.comprehensive_project_structure.items():
            full_path = project_root / file_path
            full_path.parent.mkdir(parents=True, exist_ok=True)
            
            if isinstance(content, bytes):
                full_path.write_bytes(content)
            else:
                full_path.write_text(content.strip())
        
        # Create comprehensive assets directory
        assets_dir = project_root / "adentic_brand_assets"
        assets_dir.mkdir()
        
        # Create high-quality replacement assets
        asset_files = {
            "adentic-logo.svg": '<svg xmlns="http://www.w3.org/2000/svg"><text>Adentic Logo</text></svg>',
            "adentic-logo-white.svg": '<svg xmlns="http://www.w3.org/2000/svg"><text fill="white">Adentic Logo</text></svg>',
            "adentic-symbol.svg": '<svg xmlns="http://www.w3.org/2000/svg"><circle r="20" fill="green"/></svg>',
            "adentic-logo-square.svg": '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" fill="green"/></svg>',
            "favicon.ico": b'new ICO content',
            "favicon.png": self._create_test_png(32, 32, (0, 255, 0)),  # Green favicon
            "banner.png": self._create_test_png(800, 400, (0, 200, 0)),  # Green banner
            "thumbnail-dark.png": self._create_test_png(600, 315, (0, 150, 0)),
            "thumbnail-light.png": self._create_test_png(600, 315, (200, 255, 200)),
            "icon.png": self._create_test_png(512, 512, (0, 255, 0)),
            "adaptive-icon.png": self._create_test_png(512, 512, (0, 255, 0))
        }
        
        for filename, content in asset_files.items():
            asset_path = assets_dir / filename
            if isinstance(content, bytes):
                asset_path.write_bytes(content)
            else:
                asset_path.write_text(content)
        
        return project_root

    def _create_test_png(self, width: int, height: int, color: tuple) -> bytes:
        """Create a test PNG image with specified dimensions and color."""
        image = Image.new('RGB', (width, height), color)
        import io
        buffer = io.BytesIO()
        image.save(buffer, format='PNG')
        return buffer.getvalue()

    def test_complete_adentic_rebrand_workflow(self):
        """Test the complete end-to-end Adentic rebranding workflow."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            project_root = self.create_comprehensive_test_project(tmp_path)
            
            # Configure for Adentic rebrand
            config_data = self.adentic_config_data.copy()
            config_data["new_assets_dir"] = str(project_root / "adentic_brand_assets")
            
            config = BrandConfiguration(config_data)
            
            # Execute complete rebrand
            rebrander = Rebrander(
                config=config,
                dry_run=False,
                backup=True,
                base_path=project_root
            )
            
            changes = rebrander.run()
            report = rebrander.generate_report()
            
            # Verify text replacements were applied
            self._verify_text_replacements(project_root)
            
            # Verify image replacements were applied  
            self._verify_image_replacements(project_root)
            
            # Verify file renames were applied
            self._verify_file_renames(project_root)
            
            # Verify backup was created
            self._verify_backup_creation(project_root, rebrander.backup_dir)
            
            # Verify report completeness
            self._verify_report_completeness(report, changes)
            
            # Verify project still functions
            self._verify_project_integrity(project_root)

    def _verify_text_replacements(self, project_root: Path):
        """Verify that all text replacements were applied correctly."""
        # Check React components
        app_tsx = (project_root / "frontend" / "src" / "app.tsx").read_text()
        assert "Adentic Assistant" in app_tsx
        assert "Adentic AI" in app_tsx
        assert "https://adentic.ai/" in app_tsx
        assert "Kortix" not in app_tsx
        
        # Check renamed component
        adentic_logo_tsx = (project_root / "frontend" / "src" / "components" / "AdenticLogo.tsx").read_text()
        assert "AdenticLogo" in adentic_logo_tsx
        assert "adentic-logo.svg" in adentic_logo_tsx
        assert "Adentic Logo" in adentic_logo_tsx
        
        # Check backend files
        api_py = (project_root / "backend" / "api.py").read_text()
        assert "Adentic Assistant API" in api_py
        assert "ADENTIC_ADMIN_API_KEY" in api_py
        assert "Assistant" in api_py
        assert "Adentic AI" in api_py
        
        config_py = (project_root / "backend" / "config.py").read_text()
        assert "Adentic Assistant" in config_py
        assert "Adentic AI" in config_py
        assert "Assistant" in config_py
        assert "https://api.adentic.ai" in config_py
        
        # Check configuration files
        package_json = json.loads((project_root / "package.json").read_text())
        assert package_json["name"] == "adentic-assistant"
        assert "Adentic AI" in package_json["description"]
        assert "https://adentic.ai" in package_json["homepage"]
        
        # Check environment file
        env_example = (project_root / ".env.example").read_text()
        assert "ADENTIC_ADMIN_API_KEY" in env_example
        assert "https://api.adentic.ai" in env_example
        assert "Adentic Assistant" in env_example
        
        # Check documentation
        readme = (project_root / "README.md").read_text()
        assert "# Adentic Assistant" in readme
        assert "Adentic AI" in readme
        assert "https://adentic.ai" in readme
        assert "@adenticai" in readme

    def _verify_image_replacements(self, project_root: Path):
        """Verify that image files were replaced correctly."""
        # Check main logo
        logo_path = project_root / "frontend" / "public" / "adentic-logo.svg"
        assert logo_path.exists()
        logo_content = logo_path.read_text()
        assert "Adentic Logo" in logo_content
        
        # Check white logo
        white_logo_path = project_root / "frontend" / "public" / "adentic-logo-white.svg"
        assert white_logo_path.exists()
        
        # Check symbol
        symbol_path = project_root / "frontend" / "public" / "adentic-symbol.svg"
        assert symbol_path.exists()
        symbol_content = symbol_path.read_text()
        assert 'fill="green"' in symbol_content
        
        # Check mobile assets
        mobile_logo_path = project_root / "apps" / "mobile" / "assets" / "images" / "adentic-logo-square.svg"
        assert mobile_logo_path.exists()
        
        # Verify old files don't exist
        old_logo_path = project_root / "frontend" / "public" / "kortix-logo.svg"
        assert not old_logo_path.exists()

    def _verify_file_renames(self, project_root: Path):
        """Verify that files were renamed correctly."""
        # Check component rename
        old_component = project_root / "frontend" / "src" / "components" / "KortixLogo.tsx"
        new_component = project_root / "frontend" / "src" / "components" / "AdenticLogo.tsx"
        
        assert not old_component.exists()
        assert new_component.exists()
        
        # Verify import statements were updated
        app_tsx = (project_root / "frontend" / "src" / "app.tsx").read_text()
        assert "AdenticLogo" in app_tsx
        assert "KortixLogo" not in app_tsx

    def _verify_backup_creation(self, project_root: Path, backup_dir: Path):
        """Verify that backup was created properly."""
        assert backup_dir is not None
        assert backup_dir.exists()
        assert backup_dir.is_dir()
        
        # Check that important files were backed up
        backed_up_files = list(backup_dir.rglob("*"))
        assert len(backed_up_files) > 0
        
        # Verify backup manifest exists
        manifest_path = backup_dir / "backup_manifest.json"
        assert manifest_path.exists()
        
        with open(manifest_path) as f:
            manifest = json.load(f)
        
        assert "timestamp" in manifest
        assert "config" in manifest
        assert manifest["config"]["brand_name"] == "Adentic"

    def _verify_report_completeness(self, report: dict, changes: list):
        """Verify that the generated report is comprehensive."""
        assert isinstance(report, dict)
        
        # Check required report sections
        required_sections = [
            "timestamp",
            "execution_info", 
            "configuration",
            "summary",
            "changes_by_type",
            "affected_files",
            "adentic_transformation"
        ]
        
        for section in required_sections:
            assert section in report, f"Missing report section: {section}"
        
        # Verify summary statistics
        summary = report["summary"]
        assert summary["total_changes"] == len(changes)
        assert summary["total_changes"] > 0
        assert summary["files_affected"] > 0
        
        # Verify Adentic-specific transformation details
        adentic_transform = report["adentic_transformation"]
        assert "brand_name_changes" in adentic_transform
        assert "product_name_changes" in adentic_transform
        assert "url_changes" in adentic_transform

    def _verify_project_integrity(self, project_root: Path):
        """Verify that the project structure and files are still valid."""
        # Check that all expected files exist
        critical_files = [
            "frontend/src/app.tsx",
            "frontend/src/components/AdenticLogo.tsx",
            "backend/api.py",
            "backend/config.py",
            "package.json",
            "README.md"
        ]
        
        for file_path in critical_files:
            full_path = project_root / file_path
            assert full_path.exists(), f"Critical file missing: {file_path}"
        
        # Verify JSON files are still valid
        package_json_path = project_root / "package.json"
        try:
            json.loads(package_json_path.read_text())
        except json.JSONDecodeError:
            pytest.fail("package.json is not valid JSON after rebrand")

    def test_rebrand_with_custom_config_file(self):
        """Test rebranding using a custom configuration file."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            project_root = self.create_comprehensive_test_project(tmp_path)
            
            # Create custom config file
            config_file = tmp_path / "adentic_rebrand_config.json"
            config_data = self.adentic_config_data.copy()
            config_data["new_assets_dir"] = str(project_root / "adentic_brand_assets")
            
            with open(config_file, 'w') as f:
                json.dump(config_data, f, indent=2)
            
            # Load config from file
            config = BrandConfiguration.from_file(config_file)
            
            rebrander = Rebrander(
                config=config,
                dry_run=False,
                backup=True,
                base_path=project_root
            )
            
            changes = rebrander.run()
            
            assert len(changes) > 0
            self._verify_text_replacements(project_root)

    def test_rebrand_rollback_workflow(self):
        """Test the complete rebrand and rollback workflow."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            project_root = self.create_comprehensive_test_project(tmp_path)
            
            # Store original content for verification
            original_files = {}
            for file_path in project_root.rglob("*"):
                if file_path.is_file():
                    try:
                        original_files[str(file_path)] = file_path.read_text()
                    except UnicodeDecodeError:
                        original_files[str(file_path)] = file_path.read_bytes()
            
            # Execute rebrand with backup
            config_data = self.adentic_config_data.copy()
            config_data["new_assets_dir"] = str(project_root / "adentic_brand_assets")
            config = BrandConfiguration(config_data)
            
            rebrander = Rebrander(
                config=config,
                dry_run=False,
                backup=True,
                base_path=project_root
            )
            
            changes = rebrander.run()
            backup_dir = rebrander.backup_dir
            
            # Verify rebrand was applied
            app_tsx = (project_root / "frontend" / "src" / "app.tsx").read_text()
            assert "Adentic" in app_tsx
            
            # Execute rollback
            rebrander.rollback_from_backup()
            
            # Verify rollback restored original content
            app_tsx_restored = (project_root / "frontend" / "src" / "app.tsx").read_text()
            assert "Kortix" in app_tsx_restored
            assert "Adentic" not in app_tsx_restored

    def test_rebrand_with_large_files(self):
        """Test rebranding with large files to verify performance."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            project_root = tmp_path / "large_project"
            project_root.mkdir()
            
            # Create large file with brand references
            large_file = project_root / "large_data.sql"
            large_content = []
            for i in range(10000):
                large_content.append(f"INSERT INTO users (name, company) VALUES ('User{i}', 'Kortix AI');")
                if i % 100 == 0:
                    large_content.append(f"-- Kortix Suna data export line {i}")
            
            large_file.write_text("\n".join(large_content))
            
            # Create assets
            assets_dir = project_root / "adentic_brand_assets"
            assets_dir.mkdir()
            (assets_dir / "adentic-logo.svg").write_text('<svg>Adentic</svg>')
            
            config_data = self.adentic_config_data.copy()
            config_data["new_assets_dir"] = str(assets_dir)
            config = BrandConfiguration(config_data)
            
            start_time = time.time()
            
            rebrander = Rebrander(
                config=config,
                dry_run=False,
                backup=False,
                base_path=project_root
            )
            
            changes = rebrander.run()
            
            end_time = time.time()
            execution_time = end_time - start_time
            
            # Should complete in reasonable time
            assert execution_time < 60.0, f"Large file processing took too long: {execution_time}s"
            
            # Verify changes were applied
            processed_content = large_file.read_text()
            assert "Adentic AI" in processed_content
            assert "Adentic Assistant" in processed_content
            assert processed_content.count("Adentic AI") > 100

    def test_rebrand_error_recovery(self):
        """Test error recovery during rebranding process."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            project_root = self.create_comprehensive_test_project(tmp_path)
            
            # Create a file that will cause permission error
            problem_file = project_root / "readonly.txt"
            problem_file.write_text("Kortix content")
            problem_file.chmod(0o444)  # Read-only
            
            config_data = self.adentic_config_data.copy()
            config_data["new_assets_dir"] = str(project_root / "adentic_brand_assets")
            config = BrandConfiguration(config_data)
            
            try:
                rebrander = Rebrander(
                    config=config,
                    dry_run=False,
                    backup=True,
                    base_path=project_root
                )
                
                changes = rebrander.run()
                
                # Should have processed other files despite error
                assert len(changes) > 0
                
                # Should have recorded the error
                errors = [c for c in changes if c.change_type == "ERROR"]
                assert len(errors) > 0
                
                # Other files should still be processed
                app_tsx = (project_root / "frontend" / "src" / "app.tsx").read_text()
                assert "Adentic" in app_tsx
                
            finally:
                # Restore permissions for cleanup
                problem_file.chmod(0o644)

    def test_rebrand_with_binary_files(self):
        """Test rebranding behavior with binary files."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            project_root = tmp_path / "binary_project"
            project_root.mkdir()
            
            # Create binary files
            binary_files = {
                "images/photo.jpg": b'\xff\xd8\xff\xe0' + b'fake JPEG data with Kortix text',
                "docs/document.pdf": b'%PDF-1.4 fake PDF with Kortix references',
                "assets/data.bin": b'\x00\x01\x02Kortix\x03\x04\x05'
            }
            
            for file_path, content in binary_files.items():
                full_path = project_root / file_path
                full_path.parent.mkdir(parents=True, exist_ok=True)
                full_path.write_bytes(content)
            
            # Add text file for comparison
            text_file = project_root / "config.txt"
            text_file.write_text("Kortix configuration file")
            
            config_data = self.adentic_config_data.copy()
            config_data["new_assets_dir"] = None  # Skip assets
            config = BrandConfiguration(config_data)
            
            rebrander = Rebrander(
                config=config,
                dry_run=False,
                backup=False,
                base_path=project_root
            )
            
            changes = rebrander.run()
            
            # Binary files should be skipped
            text_changes = [c for c in changes if c.change_type == "TEXT"]
            
            # Should only process text files
            assert len(text_changes) == 1
            assert "config.txt" in text_changes[0].file_path
            
            # Verify text file was processed
            processed_text = text_file.read_text()
            assert "Adentic configuration file" in processed_text

    def test_rebrand_concurrent_execution_safety(self):
        """Test that concurrent rebranding executions are handled safely."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            project_root = self.create_comprehensive_test_project(tmp_path)
            
            config_data = self.adentic_config_data.copy()
            config_data["new_assets_dir"] = str(project_root / "adentic_brand_assets")
            config = BrandConfiguration(config_data)
            
            # First rebrander
            rebrander1 = Rebrander(
                config=config,
                dry_run=False,
                backup=True,
                base_path=project_root
            )
            
            # Second rebrander (should detect first is running)
            rebrander2 = Rebrander(
                config=config,
                dry_run=False,
                backup=True,
                base_path=project_root
            )
            
            # Create lock file to simulate first rebrander running
            lock_file = project_root / ".rebrand.lock"
            lock_file.write_text("rebrander1")
            
            try:
                # Second rebrander should detect lock and handle gracefully
                with pytest.raises(Exception) as exc_info:
                    changes2 = rebrander2.run()
                
                assert "lock" in str(exc_info.value).lower() or "running" in str(exc_info.value).lower()
                
            finally:
                lock_file.unlink(missing_ok=True)