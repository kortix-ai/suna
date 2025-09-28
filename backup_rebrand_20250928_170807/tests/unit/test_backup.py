"""
Unit tests for backup functionality in the rebranding system.
These tests will fail until the rebrand module is properly refactored.
"""

import pytest
import tempfile
import shutil
import json
from pathlib import Path
from datetime import datetime
from unittest.mock import Mock, patch, MagicMock

# This import will fail initially since we need to refactor rebrand.py
from rebrand import BackupManager, BrandConfiguration, BackupError


class TestBackupManager:
    """Test suite for BackupManager class."""

    def setup_method(self):
        """Set up test fixtures."""
        self.adentic_config = BrandConfiguration({
            "brand_name": "Adentic",
            "product_name": "Assistant",
            "company_name": "Adentic AI"
        })
        
        self.backup_manager = BackupManager(
            config=self.adentic_config,
            enabled=True
        )

    def test_backup_manager_initialization(self):
        """Test BackupManager initialization."""
        assert self.backup_manager.config == self.adentic_config
        assert self.backup_manager.enabled is True
        assert self.backup_manager.backup_dir is not None
        assert isinstance(self.backup_manager.backup_dir, Path)

    def test_backup_manager_disabled(self):
        """Test BackupManager when disabled."""
        disabled_manager = BackupManager(
            config=self.adentic_config,
            enabled=False
        )
        
        assert disabled_manager.enabled is False
        assert disabled_manager.backup_dir is None

    def test_generate_backup_directory_name(self):
        """Test generation of backup directory name."""
        with patch('rebrand.datetime') as mock_datetime:
            mock_datetime.now.return_value = datetime(2023, 12, 25, 14, 30, 45)
            mock_datetime.strftime = datetime.strftime
            
            backup_dir = self.backup_manager.generate_backup_directory_name()
            
            assert "backup_rebrand_" in str(backup_dir)
            assert "20231225_143045" in str(backup_dir)

    def test_create_backup_directory(self):
        """Test creating backup directory."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            backup_dir = tmp_path / "test_backup"
            
            self.backup_manager.backup_dir = backup_dir
            self.backup_manager.create_backup_directory()
            
            assert backup_dir.exists()
            assert backup_dir.is_dir()

    def test_create_backup_directory_already_exists(self):
        """Test creating backup directory when it already exists."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            backup_dir = tmp_path / "existing_backup"
            backup_dir.mkdir()
            
            self.backup_manager.backup_dir = backup_dir
            
            # Should not raise error if directory already exists
            self.backup_manager.create_backup_directory()
            assert backup_dir.exists()

    def test_backup_file_success(self):
        """Test successful file backup."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            # Create source file
            source_file = tmp_path / "source.txt"
            source_file.write_text("Original content")
            
            # Set up backup directory
            backup_dir = tmp_path / "backup"
            self.backup_manager.backup_dir = backup_dir
            self.backup_manager.create_backup_directory()
            
            # Backup the file
            backup_path = self.backup_manager.backup_file(source_file)
            
            expected_backup_path = backup_dir / "source.txt"
            assert backup_path == expected_backup_path
            assert backup_path.exists()
            assert backup_path.read_text() == "Original content"

    def test_backup_file_with_directory_structure(self):
        """Test backing up file with preserved directory structure."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            # Create nested source file
            source_dir = tmp_path / "project" / "src" / "components"
            source_dir.mkdir(parents=True)
            source_file = source_dir / "Header.tsx"
            source_file.write_text("React component")
            
            # Set up backup directory
            backup_dir = tmp_path / "backup"
            self.backup_manager.backup_dir = backup_dir
            self.backup_manager.create_backup_directory()
            
            # Set the base path for relative path calculation
            base_path = tmp_path / "project"
            
            # Backup the file
            backup_path = self.backup_manager.backup_file(source_file, base_path)
            
            expected_backup_path = backup_dir / "src" / "components" / "Header.tsx"
            assert backup_path == expected_backup_path
            assert backup_path.exists()
            assert backup_path.read_text() == "React component"

    def test_backup_file_disabled_manager(self):
        """Test backing up file when backup is disabled."""
        disabled_manager = BackupManager(
            config=self.adentic_config,
            enabled=False
        )
        
        with tempfile.TemporaryDirectory() as tmp_dir:
            source_file = Path(tmp_dir) / "source.txt"
            source_file.write_text("Content")
            
            backup_path = disabled_manager.backup_file(source_file)
            
            assert backup_path is None

    def test_backup_file_nonexistent_source(self):
        """Test backing up nonexistent file raises error."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            backup_dir = tmp_path / "backup"
            self.backup_manager.backup_dir = backup_dir
            self.backup_manager.create_backup_directory()
            
            nonexistent_file = tmp_path / "missing.txt"
            
            with pytest.raises(BackupError) as exc_info:
                self.backup_manager.backup_file(nonexistent_file)
            
            assert "Source file does not exist" in str(exc_info.value)

    def test_backup_file_permission_error(self):
        """Test backing up file with permission issues."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            # Create source file
            source_file = tmp_path / "source.txt"
            source_file.write_text("Content")
            
            # Create backup directory with no write permissions
            backup_dir = tmp_path / "backup"
            backup_dir.mkdir()
            backup_dir.chmod(0o555)  # Read and execute only
            
            self.backup_manager.backup_dir = backup_dir
            
            try:
                with pytest.raises(BackupError) as exc_info:
                    self.backup_manager.backup_file(source_file)
                
                assert "Permission denied" in str(exc_info.value)
                
            finally:
                # Restore permissions for cleanup
                backup_dir.chmod(0o755)

    def test_backup_multiple_files(self):
        """Test backing up multiple files."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            # Create multiple source files
            files_to_backup = [
                tmp_path / "file1.txt",
                tmp_path / "subdir" / "file2.py",
                tmp_path / "another" / "deep" / "file3.json"
            ]
            
            for file_path in files_to_backup:
                file_path.parent.mkdir(parents=True, exist_ok=True)
                file_path.write_text(f"Content of {file_path.name}")
            
            # Set up backup
            backup_dir = tmp_path / "backup"
            self.backup_manager.backup_dir = backup_dir
            self.backup_manager.create_backup_directory()
            
            # Backup all files
            backup_paths = self.backup_manager.backup_multiple_files(
                files_to_backup, 
                base_path=tmp_path
            )
            
            assert len(backup_paths) == 3
            
            for original_file, backup_path in zip(files_to_backup, backup_paths):
                assert backup_path.exists()
                assert backup_path.read_text() == f"Content of {original_file.name}"

    def test_create_backup_manifest(self):
        """Test creating backup manifest file."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            backup_dir = tmp_path / "backup"
            backup_dir.mkdir()
            self.backup_manager.backup_dir = backup_dir
            
            # Create some backed up files
            (backup_dir / "file1.txt").write_text("Content 1")
            (backup_dir / "subdir").mkdir()
            (backup_dir / "subdir" / "file2.py").write_text("Content 2")
            
            manifest_path = self.backup_manager.create_backup_manifest()
            
            assert manifest_path.exists()
            assert manifest_path.name == "backup_manifest.json"
            
            # Verify manifest content
            with open(manifest_path) as f:
                manifest = json.load(f)
            
            assert "timestamp" in manifest
            assert "config" in manifest
            assert "backed_up_files" in manifest
            assert manifest["config"]["brand_name"] == "Adentic"
            assert len(manifest["backed_up_files"]) == 2

    def test_restore_from_backup(self):
        """Test restoring files from backup."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            # Create original file
            original_file = tmp_path / "original.txt"
            original_file.write_text("Original content")
            
            # Create backup
            backup_dir = tmp_path / "backup"
            backup_dir.mkdir()
            backup_file = backup_dir / "original.txt"
            backup_file.write_text("Backup content")
            
            self.backup_manager.backup_dir = backup_dir
            
            # Modify original file
            original_file.write_text("Modified content")
            
            # Restore from backup
            self.backup_manager.restore_file(original_file)
            
            assert original_file.read_text() == "Backup content"

    def test_restore_from_backup_file_not_in_backup(self):
        """Test restoring file that doesn't exist in backup."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            backup_dir = tmp_path / "backup"
            backup_dir.mkdir()
            self.backup_manager.backup_dir = backup_dir
            
            missing_file = tmp_path / "missing.txt"
            missing_file.write_text("Content")
            
            with pytest.raises(BackupError) as exc_info:
                self.backup_manager.restore_file(missing_file)
            
            assert "not found in backup" in str(exc_info.value)

    def test_restore_all_files(self):
        """Test restoring all files from backup."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            # Create project structure
            project_files = [
                tmp_path / "app.py",
                tmp_path / "config.json",
                tmp_path / "src" / "component.tsx"
            ]
            
            for file_path in project_files:
                file_path.parent.mkdir(parents=True, exist_ok=True)
                file_path.write_text(f"Original {file_path.name}")
            
            # Create backup
            backup_dir = tmp_path / "backup"
            self.backup_manager.backup_dir = backup_dir
            self.backup_manager.create_backup_directory()
            
            # Backup all files
            for file_path in project_files:
                self.backup_manager.backup_file(file_path, base_path=tmp_path)
            
            # Modify original files
            for file_path in project_files:
                file_path.write_text(f"Modified {file_path.name}")
            
            # Restore all
            restored_files = self.backup_manager.restore_all_files(base_path=tmp_path)
            
            assert len(restored_files) == 3
            
            # Verify restoration
            for file_path in project_files:
                assert file_path.read_text() == f"Original {file_path.name}"

    def test_cleanup_old_backups(self):
        """Test cleaning up old backup directories."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            # Create multiple backup directories with different timestamps
            old_backup1 = tmp_path / "backup_rebrand_20231201_120000"
            old_backup2 = tmp_path / "backup_rebrand_20231202_120000"
            recent_backup = tmp_path / "backup_rebrand_20231225_120000"
            
            for backup_dir in [old_backup1, old_backup2, recent_backup]:
                backup_dir.mkdir()
                (backup_dir / "test.txt").write_text("backup")
            
            # Clean up, keeping only 1 most recent
            BackupManager.cleanup_old_backups(tmp_path, keep_count=1)
            
            assert not old_backup1.exists()
            assert not old_backup2.exists()
            assert recent_backup.exists()

    def test_get_backup_size(self):
        """Test calculating backup directory size."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            backup_dir = tmp_path / "backup"
            backup_dir.mkdir()
            
            # Create files of known sizes
            (backup_dir / "small.txt").write_text("x" * 100)  # 100 bytes
            (backup_dir / "medium.txt").write_text("x" * 1000)  # 1000 bytes
            
            subdir = backup_dir / "subdir"
            subdir.mkdir()
            (subdir / "large.txt").write_text("x" * 5000)  # 5000 bytes
            
            self.backup_manager.backup_dir = backup_dir
            
            total_size = self.backup_manager.get_backup_size()
            
            # Should be approximately 6100 bytes (plus some overhead)
            assert total_size >= 6100
            assert total_size < 7000  # Allow for filesystem overhead

    def test_verify_backup_integrity(self):
        """Test verifying backup integrity."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            # Create original file
            original_file = tmp_path / "test.txt"
            original_file.write_text("Test content for integrity check")
            
            # Create backup
            backup_dir = tmp_path / "backup"
            self.backup_manager.backup_dir = backup_dir
            self.backup_manager.create_backup_directory()
            
            backup_path = self.backup_manager.backup_file(original_file)
            
            # Verify integrity
            is_valid = self.backup_manager.verify_backup_integrity(original_file)
            assert is_valid is True
            
            # Corrupt the backup
            backup_path.write_text("Corrupted content")
            
            # Verify should fail now
            is_valid = self.backup_manager.verify_backup_integrity(original_file)
            assert is_valid is False

    def test_backup_statistics(self):
        """Test getting backup statistics."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            
            backup_dir = tmp_path / "backup"
            self.backup_manager.backup_dir = backup_dir
            self.backup_manager.create_backup_directory()
            
            # Create some backup files
            files = ["file1.txt", "file2.py", "file3.json"]
            for filename in files:
                (backup_dir / filename).write_text(f"Content of {filename}")
            
            stats = self.backup_manager.get_backup_statistics()
            
            assert isinstance(stats, dict)
            assert stats["total_files"] == 3
            assert stats["total_size"] > 0
            assert "backup_directory" in stats
            assert stats["backup_directory"] == str(backup_dir)