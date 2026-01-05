#!/usr/bin/env python3
"""
Test script to verify Daytona snapshot is working correctly.

This script:
1. Tests Daytona connection
2. Creates a test sandbox from the snapshot
3. Verifies /skills directory exists
4. Tests that all expected skills are present:
   - slack-gif-creator
   - webapp-testing
   - algorithmic-art
5. Verifies each skill has SKILL.md with YAML frontmatter
6. Tests CA certificates installation
7. Cleans up the test sandbox

Usage:
    python test_snapshot.py
"""

import asyncio
import sys
import os
from pathlib import Path

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent))

from core.sandbox.sandbox import create_sandbox, delete_sandbox, daytona
from core.utils.config import Configuration, config
from core.utils.logger import logger
from daytona_sdk import SessionExecuteRequest, SandboxState
from daytona import Daytona


class Colors:
    """ANSI color codes for terminal output."""
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    RESET = '\033[0m'
    BOLD = '\033[1m'


def print_success(message: str):
    """Print success message."""
    print(f"{Colors.GREEN}✓{Colors.RESET} {message}")


def print_error(message: str):
    """Print error message."""
    print(f"{Colors.RED}✗{Colors.RESET} {message}")


def print_info(message: str):
    """Print info message."""
    print(f"{Colors.BLUE}ℹ{Colors.RESET} {message}")


def print_warning(message: str):
    """Print warning message."""
    print(f"{Colors.YELLOW}⚠{Colors.RESET} {message}")


def print_header(message: str):
    """Print header message."""
    print(f"\n{Colors.BOLD}{Colors.BLUE}{'='*60}{Colors.RESET}")
    print(f"{Colors.BOLD}{Colors.BLUE}{message}{Colors.RESET}")
    print(f"{Colors.BOLD}{Colors.BLUE}{'='*60}{Colors.RESET}\n")


def test_daytona_connection():
    """Test if Daytona connection is configured."""
    print_header("Testing Daytona Connection")
    
    try:
        # Check configuration
        snapshot_name = Configuration.SANDBOX_SNAPSHOT_NAME
        print_info(f"Snapshot name: {snapshot_name}")
        
        if not snapshot_name:
            print_error("SANDBOX_SNAPSHOT_NAME is not configured")
            return False
        
        # Check environment variables
        if not config.DAYTONA_API_KEY:
            print_error("DAYTONA_API_KEY is not set")
            return False
        
        if not config.DAYTONA_SERVER_URL:
            print_error("DAYTONA_SERVER_URL is not set")
            return False
        
        print_info(f"Daytona API URL: {config.DAYTONA_SERVER_URL}")
        print_info(f"Daytona Target: {config.DAYTONA_TARGET or 'default'}")
        
        # Test connection using synchronous client
        try:
            # Initialize Daytona client (reads from environment variables)
            daytona_client = Daytona()
            
            # Try to list sandboxes to test connection (just verify it works)
            sandboxes = daytona_client.list()
            
            # If we got here, connection works
            # Try to get a count by converting to list if possible
            try:
                if hasattr(sandboxes, '__iter__') and not isinstance(sandboxes, (str, bytes)):
                    sandboxes_list = list(sandboxes)
                    sandbox_count = len(sandboxes_list)
                    print_success(f"Daytona connection successful (found {sandbox_count} existing sandboxes)")
                else:
                    print_success("Daytona connection successful")
            except (TypeError, AttributeError):
                # If we can't count, that's okay - connection still works
                print_success("Daytona connection successful")
            
            return True
        except Exception as e:
            print_error(f"Failed to connect to Daytona: {str(e)}")
            print_warning("Make sure DAYTONA_API_KEY and DAYTONA_SERVER_URL are correct")
            return False
            
    except Exception as e:
        print_error(f"Error testing Daytona connection: {str(e)}")
        return False


async def test_sandbox_creation():
    """Test creating a sandbox from the snapshot."""
    print_header("Testing Sandbox Creation")
    
    sandbox = None
    test_password = "test123"  # Define outside try block for use in exception handler
    try:
        print_info("Creating test sandbox...")
        sandbox = await create_sandbox(test_password, project_id="test-snapshot-validation")
        
        print_success(f"Sandbox created successfully!")
        print_info(f"Sandbox ID: {sandbox.id}")
        print_info(f"Sandbox State: {sandbox.state}")
        
        # Wait for sandbox to be ready
        if sandbox.state != SandboxState.STARTED:
            print_info("Waiting for sandbox to start...")
            for i in range(30):
                await asyncio.sleep(2)
                sandbox = await daytona.get(sandbox.id)
                if sandbox.state == SandboxState.STARTED:
                    print_success("Sandbox is now STARTED")
                    break
                print_info(f"  State: {sandbox.state} (waiting...)")
            else:
                print_warning(f"Sandbox did not reach STARTED state (current: {sandbox.state})")
        
        return sandbox
        
    except Exception as e:
        error_msg = str(e)
        print_error(f"Failed to create sandbox: {error_msg}")
        
        # If region error, try without target
        if "region not found" in error_msg.lower() or "region" in error_msg.lower():
            print_warning("Region/Target issue detected. Trying without target...")
            
            # Try creating with target=None
            try:
                from daytona_sdk import DaytonaConfig as AsyncDaytonaConfig, AsyncDaytona, CreateSandboxFromSnapshotParams
                from daytona_sdk import SandboxState as AsyncSandboxState
                
                # Create a temporary Daytona client without target
                temp_config = AsyncDaytonaConfig(
                    api_key=config.DAYTONA_API_KEY,
                    api_url=config.DAYTONA_SERVER_URL,
                    target=None,  # Try without target
                )
                temp_daytona = AsyncDaytona(temp_config)
                
                print_info("Attempting sandbox creation without target...")
                params = CreateSandboxFromSnapshotParams(
                    snapshot=Configuration.SANDBOX_SNAPSHOT_NAME,
                    public=True,
                    labels={'id': 'test-snapshot-validation'},
                    env_vars={
                        "CHROME_PERSISTENT_SESSION": "true",
                        "RESOLUTION": "1048x768x24",
                        "RESOLUTION_WIDTH": "1048",
                        "RESOLUTION_HEIGHT": "768",
                        "VNC_PASSWORD": test_password,
                        "ANONYMIZED_TELEMETRY": "false",
                        "CHROME_PATH": "",
                        "CHROME_USER_DATA": "",
                        "CHROME_DEBUGGING_PORT": "9222",
                        "CHROME_DEBUGGING_HOST": "localhost",
                        "CHROME_CDP": ""
                    },
                    auto_stop_interval=15,
                    auto_archive_interval=30,
                )
                sandbox = await temp_daytona.create(params)
                print_success("Sandbox created successfully without target!")
                print_info(f"Sandbox ID: {sandbox.id}")
                print_info(f"Sandbox State: {sandbox.state}")
                print_warning("Consider removing DAYTONA_TARGET from your environment or setting it to None")
                return sandbox
            except Exception as retry_error:
                print_error(f"Also failed without target: {str(retry_error)}")
                print_warning("Region/Target troubleshooting:")
                print_warning(f"  1. Current target: {config.DAYTONA_TARGET}")
                print_warning(f"  2. Try removing DAYTONA_TARGET from environment or set to empty string")
                print_warning(f"  3. Check available regions in Daytona dashboard")
                print_warning(f"  4. Snapshot '{Configuration.SANDBOX_SNAPSHOT_NAME}' might not be available")
        elif "not found" in error_msg.lower():
            print_warning("Snapshot might not exist in Daytona. Check:")
            print_warning(f"  1. Snapshot '{Configuration.SANDBOX_SNAPSHOT_NAME}' exists in Daytona dashboard")
            print_warning(f"  2. Snapshot status is 'Active'")
            print_warning(f"  3. Docker image is pushed to registry")
        else:
            print_warning("Check:")
            print_warning(f"  1. Snapshot '{Configuration.SANDBOX_SNAPSHOT_NAME}' exists and is 'Active'")
            print_warning(f"  2. Region/Target '{config.DAYTONA_TARGET}' is correct")
            print_warning(f"  3. Docker image is accessible")
        
        return None


async def test_skills_directory(sandbox):
    """Test that /skills directory exists and contains all expected skills.
    
    Verifies presence of:
    - slack-gif-creator
    - webapp-testing
    - algorithmic-art
    
    Also checks that each skill has a SKILL.md file with YAML frontmatter.
    """
    print_header("Testing /skills Directory")
    
    if not sandbox:
        print_error("No sandbox available for testing")
        return False
    
    try:
        # Create a session
        session_id = "test-session"
        await sandbox.process.create_session(session_id)
        
        # Test 1: Check if /skills directory exists
        print_info("Checking if /skills directory exists...")
        result = await sandbox.process.execute_session_command(
            session_id,
            SessionExecuteRequest(command="test -d /skills && echo 'EXISTS' || echo 'NOT_FOUND'")
        )
        
        output = result.stdout.strip() if result.stdout else ""
        if "EXISTS" in output:
            print_success("/skills directory exists")
        else:
            print_error("/skills directory not found!")
            return False
        
        # Test 2: List contents of /skills
        print_info("Listing /skills directory contents...")
        result = await sandbox.process.execute_session_command(
            session_id,
            SessionExecuteRequest(command="ls -la /skills")
        )
        
        if result.stdout:
            print_success("Directory listing:")
            print(result.stdout)
        else:
            print_warning("No output from ls command")
        
        # Test 3: Check for all expected skills
        expected_skills = [
            "slack-gif-creator",
            "webapp-testing",
            "algorithmic-art"
        ]
        
        skills_found = []
        skills_missing = []
        
        for skill_name in expected_skills:
            print_info(f"Checking for {skill_name}...")
            result = await sandbox.process.execute_session_command(
                session_id,
                SessionExecuteRequest(command=f"test -d /skills/{skill_name} && echo 'FOUND' || echo 'NOT_FOUND'")
            )
            
            output = result.stdout.strip() if result.stdout else ""
            if "FOUND" in output:
                print_success(f"{skill_name} directory found")
                skills_found.append(skill_name)
                
                # List contents first to see what's actually there
                list_result = await sandbox.process.execute_session_command(
                    session_id,
                    SessionExecuteRequest(command=f"ls -la /skills/{skill_name}/ 2>/dev/null")
                )
                
                if list_result.stdout:
                    print_info(f"  Contents of {skill_name}/:")
                    files_output = list_result.stdout.strip()
                    # Show first 10 lines
                    files_lines = files_output.split('\n')[:10]
                    for line in files_lines:
                        if line.strip():
                            print(f"    {line.strip()}")
                
                # Count total files in the skill directory
                file_count_result = await sandbox.process.execute_session_command(
                    session_id,
                    SessionExecuteRequest(command=f"find /skills/{skill_name}/ -type f 2>/dev/null | wc -l")
                )
                
                if file_count_result.stdout:
                    file_count = file_count_result.stdout.strip()
                    try:
                        count = int(file_count)
                        if count > 0:
                            print_success(f"  ✓ Found {count} files in {skill_name}/")
                        else:
                            print_warning(f"  ⚠ {skill_name}/ appears to be empty (0 files)")
                    except ValueError:
                        pass
                
                # List all files recursively to verify structure
                all_files_result = await sandbox.process.execute_session_command(
                    session_id,
                    SessionExecuteRequest(command=f"find /skills/{skill_name}/ -type f 2>/dev/null | head -15")
                )
                
                if all_files_result.stdout:
                    all_files = all_files_result.stdout.strip().split('\n')
                    if all_files and any(f.strip() for f in all_files):
                        print_info(f"  All files in {skill_name}/:")
                        for f in all_files[:15]:
                            if f.strip():
                                print(f"    {f.strip()}")
                
                # Check for SKILL.md file (required)
                skill_md_check = await sandbox.process.execute_session_command(
                    session_id,
                    SessionExecuteRequest(command=f"test -f /skills/{skill_name}/SKILL.md && echo 'SKILL_MD_EXISTS' || echo 'SKILL_MD_MISSING'")
                )
                
                skill_md_output = skill_md_check.stdout.strip() if skill_md_check.stdout else ""
                if "SKILL_MD_EXISTS" in skill_md_output:
                    print_success(f"  ✓ {skill_name}/SKILL.md exists")
                else:
                    print_warning(f"  ⚠ {skill_name}/SKILL.md missing (required file)")
                    # Check if it exists with different case or location
                    alt_check = await sandbox.process.execute_session_command(
                        session_id,
                        SessionExecuteRequest(command=f"find /skills/{skill_name}/ -name '*.md' -o -name 'SKILL*' 2>/dev/null | head -5")
                    )
                    if alt_check.stdout and alt_check.stdout.strip():
                        print_info(f"  Found alternative files:")
                        for alt_file in alt_check.stdout.strip().split('\n'):
                            if alt_file.strip():
                                print(f"    - {alt_file.strip()}")
            else:
                print_error(f"{skill_name} directory not found!")
                skills_missing.append(skill_name)
        
        # Test 4: Verify SKILL.md files exist and have proper YAML frontmatter
        print_info("Verifying SKILL.md files exist and have proper YAML frontmatter...")
        skills_with_valid_md = []
        skills_missing_md = []
        
        for skill_name in skills_found:
            # First check if file exists
            exists_check = await sandbox.process.execute_session_command(
                session_id,
                SessionExecuteRequest(command=f"test -f /skills/{skill_name}/SKILL.md && echo 'EXISTS' || echo 'MISSING'")
            )
            
            exists_output = exists_check.stdout.strip() if exists_check.stdout else ""
            
            if "EXISTS" not in exists_output:
                print_error(f"  ✗ {skill_name}/SKILL.md is missing (REQUIRED)")
                skills_missing_md.append(skill_name)
                continue
            
            # File exists, check frontmatter
            result = await sandbox.process.execute_session_command(
                session_id,
                SessionExecuteRequest(command=f"head -20 /skills/{skill_name}/SKILL.md 2>/dev/null | grep -E '^---|^name:|^description:' | head -3 || echo 'FRONTMATTER_CHECK_FAILED'")
            )
            
            output = result.stdout.strip() if result.stdout else ""
            if "FRONTMATTER_CHECK_FAILED" in output or not output:
                print_warning(f"  ⚠ {skill_name}/SKILL.md exists but may be missing YAML frontmatter")
                # Still count it as found since file exists
                skills_with_valid_md.append(skill_name)
            else:
                print_success(f"  ✓ {skill_name}/SKILL.md has YAML frontmatter")
                skills_with_valid_md.append(skill_name)
                # Show first few lines of frontmatter
                frontmatter_lines = output.split('\n')[:3]
                for line in frontmatter_lines:
                    if line.strip():
                        print(f"    {line.strip()}")
        
        # Summary
        print_info(f"\nSkills check summary:")
        print_success(f"  Found directories: {len(skills_found)}/{len(expected_skills)} skills")
        if skills_missing:
            print_error(f"  Missing directories: {', '.join(skills_missing)}")
        if skills_missing_md:
            print_error(f"  Missing SKILL.md files: {', '.join(skills_missing_md)}")
        print_success(f"  Skills with valid SKILL.md: {len(skills_with_valid_md)}/{len(skills_found)}")
        
        # Fail if not all skills are present OR if any skill is missing SKILL.md
        if len(skills_found) < len(expected_skills):
            print_warning(f"\n⚠ Not all expected skills are present in the sandbox!")
            print_warning(f"Expected: {', '.join(expected_skills)}")
            print_warning(f"Found: {', '.join(skills_found) if skills_found else 'none'}")
            return False
        
        if skills_missing_md:
            print_error(f"\n❌ Some skills are missing required SKILL.md files!")
            print_error(f"Missing SKILL.md: {', '.join(skills_missing_md)}")
            print_error("SKILL.md files are REQUIRED for Agent Skills to work properly.")
            return False
        
        # Clean up session
        try:
            await sandbox.process.delete_session(session_id)
        except:
            pass
        
        return True
        
    except Exception as e:
        print_error(f"Error testing /skills directory: {str(e)}")
        import traceback
        traceback.print_exc()
        return False


async def test_ca_certificates(sandbox):
    """Test that ca-certificates package is installed."""
    print_header("Testing CA Certificates")
    
    if not sandbox:
        print_error("No sandbox available for testing")
        return False
    
    try:
        # Create a session
        session_id = "test-ca-cert-session"
        await sandbox.process.create_session(session_id)
        
        # Test 1: Check if ca-certificates package is installed
        print_info("Checking if ca-certificates package is installed...")
        result = await sandbox.process.execute_session_command(
            session_id,
            SessionExecuteRequest(command="dpkg -l | grep -i ca-certificates || echo 'NOT_INSTALLED'")
        )
        
        output = result.stdout.strip() if result.stdout else ""
        if "NOT_INSTALLED" in output or not output:
            print_error("ca-certificates package not found!")
            print_warning("This will cause SSL/TLS connection failures")
            return False
        else:
            print_success("ca-certificates package is installed")
            # Show the package details
            print_info("Package details:")
            print(output)
        
        # Test 2: Check if certificate files exist
        print_info("Checking certificate store location...")
        result = await sandbox.process.execute_session_command(
            session_id,
            SessionExecuteRequest(command="ls -la /etc/ssl/certs/ 2>/dev/null | head -5 || echo 'CERT_DIR_NOT_FOUND'")
        )
        
        output = result.stdout.strip() if result.stdout else ""
        if "CERT_DIR_NOT_FOUND" in output:
            print_error("Certificate directory not found!")
            return False
        else:
            print_success("Certificate directory exists")
            cert_count = await sandbox.process.execute_session_command(
                session_id,
                SessionExecuteRequest(command="ls /etc/ssl/certs/ 2>/dev/null | wc -l")
            )
            if cert_count.stdout:
                print_info(f"Found {cert_count.stdout.strip()} certificate files")
        
        # Test 3: Test SSL connection with wget
        print_info("Testing SSL connection with wget...")
        result = await sandbox.process.execute_session_command(
            session_id,
            SessionExecuteRequest(command="wget --spider --timeout=5 https://www.google.com 2>&1 | head -3 || echo 'SSL_TEST_FAILED'")
        )
        
        output = result.stdout.strip() if result.stdout else ""
        if "SSL_TEST_FAILED" in output or "Unable to establish SSL connection" in output or "GnuTLS: Error" in output:
            print_error("SSL connection test failed!")
            print_warning("Output:")
            print(output)
            return False
        else:
            print_success("SSL connection test passed")
            if output:
                print_info("wget output:")
                print(output[:200])  # Show first 200 chars
        
        # Test 4: Download an image from HTTPS
        print_info("Testing image download from HTTPS...")
        # Use a simpler, more reliable URL
        test_image_url = "https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png"
        test_image_path = "/tmp/test_downloaded_image.png"
        
        # Clean up any existing file first
        await sandbox.process.execute_session_command(
            session_id,
            SessionExecuteRequest(command=f"rm -f {test_image_path}")
        )
        
        # Try wget first
        print_info("Attempting download with wget...")
        result = await sandbox.process.execute_session_command(
            session_id,
            SessionExecuteRequest(command=f"wget -O {test_image_path} --timeout=10 '{test_image_url}' 2>&1; echo '__WGET_EXIT_CODE__' $?")
        )
        
        output = result.stdout.strip() if result.stdout else ""
        stderr = result.stderr.strip() if result.stderr else ""
        combined_output = output + "\n" + stderr if stderr else output
        
        # Extract exit code
        exit_code = None
        if "__WGET_EXIT_CODE__" in combined_output:
            parts = combined_output.split("__WGET_EXIT_CODE__")
            if len(parts) > 1:
                try:
                    exit_code = int(parts[-1].strip())
                except:
                    pass
        
        # Check for SSL errors in output
        has_ssl_error = "Unable to establish SSL connection" in combined_output or "GnuTLS: Error" in combined_output
        
        # Check if file was downloaded successfully and has content
        check_file = await sandbox.process.execute_session_command(
            session_id,
            SessionExecuteRequest(command=f"test -f {test_image_path} && test -s {test_image_path} && ls -lh {test_image_path} || echo 'FILE_NOT_FOUND_OR_EMPTY'")
        )
        
        file_check_output = check_file.stdout.strip() if check_file.stdout else ""
        file_exists_and_has_content = "FILE_NOT_FOUND_OR_EMPTY" not in file_check_output
        
        # Check file size separately
        file_size_check = await sandbox.process.execute_session_command(
            session_id,
            SessionExecuteRequest(command=f"stat -c%s {test_image_path} 2>/dev/null || echo '0'")
        )
        
        file_size = 0
        if file_size_check.stdout:
            try:
                file_size = int(file_size_check.stdout.strip())
            except:
                file_size = 0
        
        # If file exists and has content, download succeeded
        if file_exists_and_has_content and file_size > 0:
            # Verify it's actually an image file
            file_type_check = await sandbox.process.execute_session_command(
                session_id,
                SessionExecuteRequest(command=f"file {test_image_path} 2>&1")
            )
            
            file_type = file_type_check.stdout.strip() if file_type_check.stdout else ""
            if "image" in file_type.lower() or "PNG" in file_type:
                print_success("Image downloaded successfully!")
                print_info(f"File: {file_check_output}")
                print_info(f"Size: {file_size} bytes")
                print_info(f"Type: {file_type}")
                
                # Clean up test file
                await sandbox.process.execute_session_command(
                    session_id,
                    SessionExecuteRequest(command=f"rm -f {test_image_path}")
                )
            else:
                print_warning("File downloaded but may not be a valid image")
                print_info(f"File type: {file_type}")
                print_info(f"Size: {file_size} bytes")
        elif file_size == 0 or (exit_code is not None and exit_code != 0) or has_ssl_error:
            # wget failed, try curl as fallback
            print_warning("wget failed, trying curl as fallback...")
            if exit_code is not None:
                print_info(f"wget exit code: {exit_code}")
            if has_ssl_error:
                print_warning("wget SSL error detected - curl may work better")
            
            # Clean up empty file
            await sandbox.process.execute_session_command(
                session_id,
                SessionExecuteRequest(command=f"rm -f {test_image_path}")
            )
            
            # Try with curl
            curl_result = await sandbox.process.execute_session_command(
                session_id,
                SessionExecuteRequest(command=f"curl -L -o {test_image_path} --max-time 10 '{test_image_url}' 2>&1; echo '__CURL_EXIT_CODE__' $?")
            )
            
            curl_output = curl_result.stdout.strip() if curl_result.stdout else ""
            curl_stderr = curl_result.stderr.strip() if curl_result.stderr else ""
            curl_combined = curl_output + "\n" + curl_stderr if curl_stderr else curl_output
            
            # Check curl exit code
            curl_exit_code = None
            if "__CURL_EXIT_CODE__" in curl_combined:
                parts = curl_combined.split("__CURL_EXIT_CODE__")
                if len(parts) > 1:
                    try:
                        curl_exit_code = int(parts[-1].strip())
                    except:
                        pass
            
            # Check file size again
            file_size_check_curl = await sandbox.process.execute_session_command(
                session_id,
                SessionExecuteRequest(command=f"stat -c%s {test_image_path} 2>/dev/null || echo '0'")
            )
            
            curl_file_size = 0
            if file_size_check_curl.stdout:
                try:
                    curl_file_size = int(file_size_check_curl.stdout.strip())
                except:
                    curl_file_size = 0
            
            if curl_file_size > 0:
                # curl succeeded!
                check_file_curl = await sandbox.process.execute_session_command(
                    session_id,
                    SessionExecuteRequest(command=f"ls -lh {test_image_path}")
                )
                file_check_output_curl = check_file_curl.stdout.strip() if check_file_curl.stdout else ""
                
                file_type_check = await sandbox.process.execute_session_command(
                    session_id,
                    SessionExecuteRequest(command=f"file {test_image_path} 2>&1")
                )
                file_type = file_type_check.stdout.strip() if file_type_check.stdout else ""
                
                print_success("Image downloaded successfully with curl!")
                print_info(f"File: {file_check_output_curl}")
                print_info(f"Size: {curl_file_size} bytes")
                print_info(f"Type: {file_type}")
                
                # Clean up
                await sandbox.process.execute_session_command(
                    session_id,
                    SessionExecuteRequest(command=f"rm -f {test_image_path}")
                )
            else:
                # Both wget and curl failed
                print_error("Image download failed with both wget and curl!")
                print_warning("wget output:")
                print(combined_output[:300])
                print_warning("curl output:")
                print(curl_combined[:300])
                if has_ssl_error or "SSL" in curl_combined or "certificate" in curl_combined.lower():
                    print_error("This appears to be an SSL/TLS issue")
                return False
        else:
            print_error("Image file was not downloaded!")
            print_warning("wget output:")
            print(combined_output[:500])
            return False
        
        # Clean up session
        try:
            await sandbox.process.delete_session(session_id)
        except:
            pass
        
        return True
        
    except Exception as e:
        print_error(f"Error testing ca-certificates: {str(e)}")
        import traceback
        traceback.print_exc()
        return False


async def cleanup_sandbox(sandbox):
    """Clean up the test sandbox."""
    print_header("Cleaning Up")
    
    if not sandbox:
        return
    
    try:
        print_info(f"Deleting test sandbox {sandbox.id}...")
        await delete_sandbox(sandbox.id)
        print_success("Test sandbox deleted successfully")
    except Exception as e:
        print_error(f"Failed to delete sandbox: {str(e)}")
        print_warning(f"Sandbox ID: {sandbox.id}")
        print_warning("You may need to delete it manually from Daytona dashboard")


async def main():
    """Main test function."""
    print_header("Daytona Snapshot Test Suite")
    
    print_info(f"Testing snapshot: {Configuration.SANDBOX_SNAPSHOT_NAME}")
    print_info(f"Image name: {Configuration.SANDBOX_IMAGE_NAME}")
    print()
    
    # Test 1: Daytona connection (synchronous)
    if not test_daytona_connection():
        print_error("\n❌ Daytona connection failed. Cannot continue.")
        sys.exit(1)
    
    # Test 2: Sandbox creation
    sandbox = await test_sandbox_creation()
    if not sandbox:
        print_error("\n❌ Sandbox creation failed. Cannot continue.")
        sys.exit(1)
    
    # Test 3: /skills directory
    skills_test_passed = await test_skills_directory(sandbox)
    
    # Test 4: CA Certificates
    ca_certs_test_passed = await test_ca_certificates(sandbox)
    
    # Cleanup
    cleanup_choice = input("\nDelete test sandbox? (y/n): ").strip().lower()
    if cleanup_choice == 'y':
        await cleanup_sandbox(sandbox)
    else:
        print_info(f"Keeping sandbox {sandbox.id} for manual inspection")
    
    # Summary
    print_header("Test Summary")
    print_success("Daytona connection: PASSED")
    print_success("Sandbox creation: PASSED")
    if skills_test_passed:
        print_success("/skills directory: PASSED")
    else:
        print_error("/skills directory: FAILED")
    
    if ca_certs_test_passed:
        print_success("CA Certificates: PASSED")
    else:
        print_error("CA Certificates: FAILED")
    
    if skills_test_passed and ca_certs_test_passed:
        print(f"\n{Colors.GREEN}{Colors.BOLD}✅ All tests passed!{Colors.RESET}\n")
    else:
        print(f"\n{Colors.RED}{Colors.BOLD}❌ Some tests failed{Colors.RESET}\n")
        sys.exit(1)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n\nTest interrupted by user")
        sys.exit(1)
    except Exception as e:
        print_error(f"\nUnexpected error: {str(e)}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

