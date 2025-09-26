# Data Model: Automated Rebranding System

## Core Entities

### BrandConfiguration
**Purpose**: Defines the new brand identity to apply

**Attributes**:
- `brand_name`: str (2-50 chars, alphanumeric + dash/underscore)
  - Replaces: "Kortix"
  - Example: "AcmeCorp"

- `product_name`: str (2-50 chars, alphanumeric + dash/underscore)
  - Replaces: "Suna"
  - Example: "WorkerAI"

- `company_name`: str (2-100 chars)
  - Replaces: "Kortix AI"
  - Example: "AcmeCorp AI Solutions"

- `full_product_name`: str (2-100 chars)
  - Replaces: "Kortix Suna"
  - Example: "AcmeCorp WorkerAI"

- `website_url`: str (valid URL)
  - Replaces: "https://suna.so/"
  - Example: "https://acmecorp.ai/"

- `social_urls`: dict
  - `twitter`: str (optional URL)
  - `github`: str (optional URL)
  - `linkedin`: str (optional URL)

- `new_assets_dir`: str (valid directory path)
  - Directory containing replacement image files
  - Example: "./new_brand_assets"

**Validation Rules**:
- Brand/product names must match pattern: ^[a-zA-Z][a-zA-Z0-9_-]{1,49}$
- URLs must be valid HTTP(S) addresses
- Assets directory must exist if specified

### ChangeReport
**Purpose**: Documents all modifications made during rebranding

**Attributes**:
- `timestamp`: datetime (ISO-8601 format)
  - When rebranding was executed

- `configuration`: BrandConfiguration
  - Complete config used for this run

- `dry_run`: bool
  - Whether changes were actually applied

- `backup_directory`: str (optional)
  - Path to backup if created

- `changes`: list[ChangeEntry]
  - Detailed list of all modifications

- `summary`: ChangeSummary
  - Aggregated statistics

### ChangeEntry
**Purpose**: Individual file modification record

**Attributes**:
- `file_path`: str
  - Absolute or relative path to file

- `change_type`: enum
  - Values: TEXT, IMAGE, RENAME, ERROR

- `details`: str
  - Human-readable description
  - Examples:
    - "Replaced 'Kortix' with 'AcmeCorp' (5 occurrences)"
    - "Renamed from 'kortix-logo.svg' to 'acmecorp-logo.svg'"
    - "Replaced image with './new_brand_assets/logo.svg'"

- `error`: str (optional)
  - Error message if change failed

### ChangeSummary
**Purpose**: Statistical overview of changes

**Attributes**:
- `total_files_scanned`: int
- `total_files_modified`: int
- `text_changes`: int
- `image_replacements`: int
- `file_renames`: int
- `errors`: int
- `execution_time_seconds`: float

### BackupManifest
**Purpose**: Index of backed up files for restoration

**Attributes**:
- `created_at`: datetime
- `original_cwd`: str
- `backup_directory`: str
- `files`: list[BackupEntry]

### BackupEntry
**Purpose**: Single file backup record

**Attributes**:
- `original_path`: str
  - Original file location

- `backup_path`: str
  - Location in backup directory

- `file_hash`: str
  - SHA-256 hash for verification

- `permissions`: int
  - Original file permissions (octal)

## State Transitions

### Rebranding Process States
```
INITIALIZED → VALIDATING → SCANNING → BACKING_UP → PROCESSING → REPORTING → COMPLETE
                   ↓            ↓           ↓           ↓           ↓
                ERROR        ERROR       ERROR       ERROR       ERROR
```

### File Processing States
```
PENDING → BACKED_UP → MODIFIED → VERIFIED
             ↓           ↓          ↓
          SKIPPED     FAILED    CORRUPTED
```

## Relationships

```
BrandConfiguration
    |
    └──→ RedbrandingSession
              |
              ├──→ BackupManifest
              |        |
              |        └──→ BackupEntry (1:N)
              |
              └──→ ChangeReport
                       |
                       ├──→ ChangeSummary (1:1)
                       |
                       └──→ ChangeEntry (1:N)
```

## Data Persistence

### Configuration File (JSON)
```json
{
  "brand_name": "AcmeCorp",
  "product_name": "WorkerAI",
  "company_name": "AcmeCorp AI Solutions",
  "full_product_name": "AcmeCorp WorkerAI",
  "website_url": "https://acmecorp.ai/",
  "twitter_url": "https://x.com/acmecorp",
  "github_url": "https://github.com/acmecorp/",
  "linkedin_url": "https://linkedin.com/company/acmecorp/",
  "new_assets_dir": "./new_brand_assets"
}
```

### Report File (JSON)
```json
{
  "timestamp": "2025-09-25T10:30:00Z",
  "configuration": { ... },
  "dry_run": false,
  "backup_directory": "backup_rebrand_20250925_103000",
  "summary": {
    "total_files_scanned": 150,
    "total_files_modified": 47,
    "text_changes": 35,
    "image_replacements": 8,
    "file_renames": 4,
    "errors": 0,
    "execution_time_seconds": 12.5
  },
  "changes": [
    {
      "file_path": "frontend/src/lib/site.ts",
      "change_type": "TEXT",
      "details": "Replaced 'Kortix' with 'AcmeCorp' (3 occurrences)"
    }
  ]
}
```

### Backup Manifest (JSON)
```json
{
  "created_at": "2025-09-25T10:30:00Z",
  "original_cwd": "/home/user/project",
  "backup_directory": "backup_rebrand_20250925_103000",
  "files": [
    {
      "original_path": "frontend/src/lib/site.ts",
      "backup_path": "backup_rebrand_20250925_103000/frontend/src/lib/site.ts",
      "file_hash": "sha256:abcd1234...",
      "permissions": 644
    }
  ]
}
```

## Constraints

### File System
- Maximum path length: 4096 characters (Linux), 260 (Windows)
- Maximum file size for processing: 10MB (configurable)
- Excluded directories: .git, node_modules, venv, __pycache__

### Performance
- Process minimum 10 files/second
- Generate report within 1 second after processing
- Backup creation should not exceed 2x file copy time

### Validation
- Brand names cannot be empty or whitespace-only
- Cannot use system-reserved filenames
- Asset files must exist before replacement attempt
- Backup directory must have write permissions