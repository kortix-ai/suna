import re
import unicodedata
from typing import Tuple, Optional
from fastapi import HTTPException

class FileNameValidator:
    """Comprehensive file and folder name validation for cross-platform compatibility."""
    
    # Illegal characters for file/folder names (Windows + additional safety)
    ILLEGAL_CHARS = r'[<>:"/\\|?*\x00-\x1f]'
    
    # Reserved names (Windows)
    RESERVED_NAMES = {
        'CON', 'PRN', 'AUX', 'NUL',
        'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
        'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
    }
    
    @classmethod
    def sanitize_name(cls, name: str) -> str:
        """Sanitize a file/folder name by removing illegal characters."""
        if not name or not name.strip():
            return "Untitled"
        
        # Remove leading/trailing whitespace
        name = name.strip()
        
        # Remove illegal characters
        name = re.sub(cls.ILLEGAL_CHARS, '', name)
        
        # Remove leading/trailing dots and spaces (Windows issues)
        name = name.strip('. ')
        
        # Normalize unicode characters
        name = unicodedata.normalize('NFKC', name)
        
        # Check if it's a reserved name
        base_name = name.split('.')[0].upper()
        if base_name in cls.RESERVED_NAMES:
            name = f"_{name}"
        
        # Limit length (255 chars is filesystem limit, but we'll be more conservative)
        if len(name.encode('utf-8')) > 200:
            name = name[:200]
        
        # If name becomes empty after sanitization
        if not name:
            return "Untitled"
        
        return name
    
    @classmethod
    def validate_name(cls, name: str, item_type: str = "file") -> Tuple[bool, Optional[str]]:
        """
        Validate a file/folder name.
        Returns (is_valid, error_message)
        """
        if not name or not name.strip():
            return False, f"{item_type.capitalize()} name cannot be empty"
        
        original_name = name
        name = name.strip()
        
        # Check length
        if len(name) > 255:
            return False, f"{item_type.capitalize()} name is too long (max 255 characters)"
        
        if len(name.encode('utf-8')) > 200:
            return False, f"{item_type.capitalize()} name is too long when encoded"
        
        # Check for illegal characters
        if re.search(cls.ILLEGAL_CHARS, name):
            illegal_found = re.findall(cls.ILLEGAL_CHARS, name)
            return False, f"{item_type.capitalize()} name contains illegal characters: {', '.join(set(illegal_found))}"
        
        # Check for leading/trailing dots or spaces
        if name.startswith('.') or name.endswith('.') or name.startswith(' ') or name.endswith(' '):
            return False, f"{item_type.capitalize()} name cannot start or end with dots or spaces"
        
        # Check for reserved names
        base_name = name.split('.')[0].upper()
        if base_name in cls.RESERVED_NAMES:
            return False, f"{item_type.capitalize()} name '{base_name}' is reserved by the system"
        
        # Check for dots-only names
        if all(c == '.' for c in name):
            return False, f"{item_type.capitalize()} name cannot consist only of dots"
        
        return True, None
    
    @classmethod
    def generate_unique_name(cls, base_name: str, existing_names: list, item_type: str = "file") -> str:
        """
        Generate a unique name by appending numbers like macOS does.
        e.g., "document.txt" -> "document 2.txt" -> "document 3.txt"
        """
        # First, sanitize the base name
        base_name = cls.sanitize_name(base_name)
        
        # Check if base name is already unique
        if base_name.lower() not in [name.lower() for name in existing_names]:
            return base_name
        
        # Split name and extension for files
        if item_type == "file" and '.' in base_name:
            name_part, ext = base_name.rsplit('.', 1)
            ext = '.' + ext
        else:
            name_part = base_name
            ext = ''
        
        # Find a unique name
        counter = 2
        while True:
            new_name = f"{name_part} {counter}{ext}"
            if new_name.lower() not in [name.lower() for name in existing_names]:
                return new_name
            counter += 1
            
            # Safety break (shouldn't happen in normal use)
            if counter > 1000:
                import uuid
                unique_id = str(uuid.uuid4())[:8]
                return f"{name_part}_{unique_id}{ext}"

class ValidationError(HTTPException):
    """Custom exception for validation errors."""
    def __init__(self, message: str):
        super().__init__(status_code=400, detail=message)

async def validate_folder_name_unique(name: str, account_id: str, exclude_folder_id: str = None) -> None:
    """Check if folder name is unique for the account."""
    from core.services.supabase import DBConnection
    
    db = DBConnection()
    client = await db.client
    
    query = client.table('knowledge_base_folders').select('folder_id').eq('account_id', account_id).ilike('name', name)
    
    if exclude_folder_id:
        query = query.neq('folder_id', exclude_folder_id)
    
    result = await query.execute()
    
    if result.data:
        raise ValidationError(f"A folder with the name '{name}' already exists")

async def validate_file_name_unique_in_folder(filename: str, folder_id: str, exclude_entry_id: str = None) -> str:
    """
    Check if filename is unique in folder. If not, generate a unique name.
    Returns the final filename to use.
    """
    from core.services.supabase import DBConnection
    
    db = DBConnection()
    client = await db.client
    
    # Get all existing filenames in the folder
    query = client.table('knowledge_base_entries').select('filename').eq('folder_id', folder_id).eq('is_active', True)
    
    if exclude_entry_id:
        query = query.neq('entry_id', exclude_entry_id)
    
    result = await query.execute()
    existing_names = [entry['filename'] for entry in result.data]
    
    # Generate unique name if needed
    return FileNameValidator.generate_unique_name(filename, existing_names, "file")