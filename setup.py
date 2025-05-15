#!/usr/bin/env python3
import os
import sys
import json
import time
import shutil
import platform
import subprocess
from pathlib import Path
import urllib.request
import configparser
from getpass import getpass
import re
import socket
import random
import string

# ANSI colors for pretty output
class Colors:
    HEADER = '\033[95m'
    BLUE = '\033[94m'
    CYAN = '\033[96m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'
    UNDERLINE = '\033[4m'

def print_banner():
    """Print Suna setup banner"""
    print(f"""
{Colors.BLUE}{Colors.BOLD}
   ███████╗██╗   ██╗███╗   ██╗ █████╗ 
   ██╔════╝██║   ██║████╗  ██║██╔══██╗
   ███████╗██║   ██║██╔██╗ ██║███████║
   ╚════██║██║   ██║██║╚██╗██║██╔══██║
   ███████║╚██████╔╝██║ ╚████║██║  ██║
   ╚══════╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═╝
                                      
   Setup Wizard
{Colors.ENDC}
""")

def print_step(step_num, total_steps, step_name):
    """Print a step header"""
    print(f"\n{Colors.BLUE}{Colors.BOLD}Step {step_num}/{total_steps}: {step_name}{Colors.ENDC}")
    print(f"{Colors.CYAN}{'='*50}{Colors.ENDC}\n")

def print_info(message):
    """Print info message"""
    print(f"{Colors.CYAN}ℹ️ {message}{Colors.ENDC}")

def print_success(message):
    """Print success message"""
    print(f"{Colors.GREEN}✅ {message}{Colors.ENDC}")

def print_warning(message):
    """Print warning message"""
    print(f"{Colors.YELLOW}⚠️ {message}{Colors.ENDC}")

def print_error(message):
    """Print error message"""
    print(f"{Colors.RED}❌ {message}{Colors.ENDC}")

def check_requirements():
    """Check if all required tools are installed"""
    requirements = {
        'git': 'https://git-scm.com/downloads',
        'docker': 'https://docs.docker.com/get-docker/',
        'python3': 'https://www.python.org/downloads/',
        'poetry': 'https://python-poetry.org/docs/#installation',
        'pip3': 'https://pip.pypa.io/en/stable/installation/',
        'node': 'https://nodejs.org/en/download/',
        'npm': 'https://docs.npmjs.com/downloading-and-installing-node-js-and-npm',
    }
    
    missing = []
    
    for cmd, url in requirements.items():
        try:
            # Check if python3/pip3 for Windows
            if platform.system() == 'Windows' and cmd in ['python3', 'pip3']:
                cmd_to_check = cmd.replace('3', '')
            else:
                cmd_to_check = cmd
                
            subprocess.run(
                [cmd_to_check, '--version'],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True
            )
            print_success(f"{cmd} is installed")
        except (subprocess.SubprocessError, FileNotFoundError):
            missing.append((cmd, url))
            print_error(f"{cmd} is not installed")
    
    if missing:
        print_error("Missing required tools. Please install them before continuing:")
        for cmd, url in missing:
            print(f"  - {cmd}: {url}")
        sys.exit(1)
    
    return True

def check_docker_running():
    """Check if Docker is running"""
    try:
        result = subprocess.run(
            ['docker', 'info'],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True
        )
        print_success("Docker is running")
        return True
    except subprocess.SubprocessError:
        print_error("Docker is installed but not running. Please start Docker and try again.")
        sys.exit(1)

def check_suna_directory():
    """Check if we're in a Suna repository"""
    required_dirs = ['backend', 'frontend']
    required_files = ['README.md', 'docker-compose.yaml']
    
    for directory in required_dirs:
        if not os.path.isdir(directory):
            print_error(f"'{directory}' directory not found. Make sure you're in the Suna repository root.")
            return False
    
    for file in required_files:
        if not os.path.isfile(file):
            print_error(f"'{file}' not found. Make sure you're in the Suna repository root.")
            return False
    
    print_success("Suna repository detected")
    return True

def validate_url(url, allow_empty=False):
    """Validate a URL"""
    if allow_empty and not url:
        return True
    
    pattern = re.compile(
        r'^(?:http|https)://'  # http:// or https://
        r'(?:(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+(?:[A-Z]{2,6}\.?|[A-Z0-9-]{2,}\.?)|'  # domain
        r'localhost|'  # localhost
        r'\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})'  # or IP
        r'(?::\d+)?'  # optional port
        r'(?:/?|[/?]\S+)$', re.IGNORECASE)
    
    return bool(pattern.match(url))

def validate_api_key(api_key, allow_empty=False):
    """Validate an API key (basic format check)"""
    if allow_empty and not api_key:
        return True
    
    # Basic check: not empty and at least 10 chars
    return bool(api_key)

def collect_supabase_info():
    """Collect Supabase information"""
    print_info("You'll need to create a Supabase project before continuing")
    print_info("Visit https://supabase.com/dashboard/projects to create one")
    print_info("After creating your project, visit the project settings -> Data API and you'll need to get the following information:")
    print_info("1. Supabase Project URL (e.g., https://abcdefg.supabase.co)")
    print_info("2. Supabase anon key")
    print_info("3. Supabase service role key")
    input("Press Enter to continue once you've created your Supabase project...")
    
    while True:
        supabase_url = input("Enter your Supabase Project URL (e.g., https://abcdefg.supabase.co): ")
        if validate_url(supabase_url):
            break
        print_error("Invalid URL format. Please enter a valid URL.")
    
    while True:
        supabase_anon_key = input("Enter your Supabase anon key: ")
        if validate_api_key(supabase_anon_key):
            break
        print_error("Invalid API key format. It should be at least 10 characters long.")
    
    while True:
        supabase_service_role_key = input("Enter your Supabase service role key: ")
        if validate_api_key(supabase_service_role_key):
            break
        print_error("Invalid API key format. It should be at least 10 characters long.")
    
    return {
        'SUPABASE_URL': supabase_url,
        'SUPABASE_ANON_KEY': supabase_anon_key,
        'SUPABASE_SERVICE_ROLE_KEY': supabase_service_role_key,
    }

def collect_daytona_info():
    """Collect Daytona API key"""
    print_info("You'll need to create a Daytona account before continuing")
    print_info("Visit https://app.daytona.io/ to create one")
    print_info("Then, generate an API key from 'Keys' menu")
    print_info("After that, go to Images (https://app.daytona.io/dashboard/images)")
    print_info("Click '+Create Image'")
    print_info("Enter 'kortix/suna:0.1.2' as the image name")
    print_info("Set '/usr/bin/supervisord -n -c /etc/supervisor/conf.d/supervisord.conf' as the Entrypoint")
    
    input("Press Enter to continue once you've completed these steps...")
    
    while True:
        daytona_api_key = input("Enter your Daytona API key: ")
        if validate_api_key(daytona_api_key):
            break
        print_error("Invalid API key format. It should be at least 10 characters long.")
    
    return {
        'DAYTONA_API_KEY': daytona_api_key,
        'DAYTONA_SERVER_URL': "https://app.daytona.io/api",
        'DAYTONA_TARGET': "us",
    }

def collect_llm_api_keys():
    """Collect LLM API keys for various providers"""
    print_info("You need at least one LLM provider API key to use Suna")
    print_info("Available LLM providers: OpenAI, Anthropic, Groq, OpenRouter")
    
    # Display provider selection options
    print(f"\n{Colors.CYAN}Select LLM providers to configure:{Colors.ENDC}")
    print(f"{Colors.CYAN}[1] {Colors.GREEN}OpenAI{Colors.ENDC}")
    print(f"{Colors.CYAN}[2] {Colors.GREEN}Anthropic{Colors.ENDC} {Colors.CYAN}(recommended for best performance){Colors.ENDC}")
    print(f"{Colors.CYAN}[3] {Colors.GREEN}Groq{Colors.ENDC}")
    print(f"{Colors.CYAN}[4] {Colors.GREEN}OpenRouter{Colors.ENDC} {Colors.CYAN}(access to multiple models){Colors.ENDC}")
    print(f"{Colors.CYAN}[5] {Colors.GREEN}AWS Bedrock{Colors.ENDC}")
    print(f"{Colors.CYAN}Enter numbers separated by commas (e.g., 1,2,4){Colors.ENDC}\n")
    
    while True:
        providers_input = input("Select providers (required, at least one): ")
        selected_providers = []
        
        try:
            # Parse the input, handle both comma-separated and space-separated
            provider_numbers = [int(p.strip()) for p in providers_input.replace(',', ' ').split()]
            
            for num in provider_numbers:
                if num == 1:
                    selected_providers.append('OPENAI')
                elif num == 2:
                    selected_providers.append('ANTHROPIC')
                elif num == 3:
                    selected_providers.append('GROQ')
                elif num == 4:
                    selected_providers.append('OPENROUTER')
                elif num == 5:
                    selected_providers.append('AWS_BEDROCK')
            
            if selected_providers:
                break
            else:
                print_error("Please select at least one provider.")
        except ValueError:
            print_error("Invalid input. Please enter provider numbers (e.g., 1,2,4).")
    
    # Collect API keys for selected providers
    api_keys = {}
    model_info = {}
    
    # Model aliases for reference
    model_aliases = {
        'OPENAI': ['openai/gpt-4o', 'openai/gpt-4o-mini'],
        'ANTHROPIC': ['anthropic/claude-3-7-sonnet-latest', 'anthropic/claude-3-5-sonnet-latest'],
        'GROQ': ['groq/llama-3.1-70b-versatile', 'groq/llama-3.1-405b-reasoning-preview'],
        'OPENROUTER': ['openrouter/google/gemini-2.5-pro-preview', 'openrouter/deepseek/deepseek-chat-v3-0324:free', 'openrouter/openai/gpt-4o-2024-11-20'],
        'AWS_BEDROCK': ['anthropic.claude-3-7-sonnet-20250219-v1:0', 'anthropic.claude-3-5-sonnet-20241022-v2:0']
    }
    
    for provider in selected_providers:
        print_info(f"\nConfiguring {provider}")
        
        if provider == 'OPENAI':
            while True:
                api_key = input("Enter your OpenAI API key: ")
                if validate_api_key(api_key):
                    api_keys['OPENAI_API_KEY'] = api_key
                    
                    # Recommend default model
                    print(f"\n{Colors.CYAN}Recommended OpenAI models:{Colors.ENDC}")
                    for i, model in enumerate(model_aliases['OPENAI'], 1):
                        print(f"{Colors.CYAN}[{i}] {Colors.GREEN}{model}{Colors.ENDC}")
                    
                    model_choice = input("Select default model (1-4) or press Enter for gpt-4o: ").strip()
                    if not model_choice:
                        model_info['default_model'] = 'openai/gpt-4o'
                    elif model_choice.isdigit() and 1 <= int(model_choice) <= len(model_aliases['OPENAI']):
                        model_info['default_model'] = model_aliases['OPENAI'][int(model_choice) - 1]
                    else:
                        model_info['default_model'] = 'openai/gpt-4o'
                        print_warning(f"Invalid selection, using default: openai/gpt-4o")
                    break
                print_error("Invalid API key format. It should be at least 10 characters long.")
        
        elif provider == 'ANTHROPIC':
            while True:
                api_key = input("Enter your Anthropic API key: ")
                if validate_api_key(api_key):
                    api_keys['ANTHROPIC_API_KEY'] = api_key
                    
                    # Recommend default model
                    print(f"\n{Colors.CYAN}Recommended Anthropic models:{Colors.ENDC}")
                    for i, model in enumerate(model_aliases['ANTHROPIC'], 1):
                        print(f"{Colors.CYAN}[{i}] {Colors.GREEN}{model}{Colors.ENDC}")
                    
                    model_choice = input("Select default model (1-3) or press Enter for claude-3-7-sonnet: ").strip()
                    if not model_choice or model_choice == '1':
                        model_info['default_model'] = 'anthropic/claude-3-7-sonnet-latest'
                    elif model_choice.isdigit() and 1 <= int(model_choice) <= len(model_aliases['ANTHROPIC']):
                        model_info['default_model'] = model_aliases['ANTHROPIC'][int(model_choice) - 1]
                    else:
                        model_info['default_model'] = 'anthropic/claude-3-7-sonnet-latest'
                        print_warning(f"Invalid selection, using default: anthropic/claude-3-7-sonnet-latest")
                    break
                print_error("Invalid API key format. It should be at least 10 characters long.")
        
        elif provider == 'GROQ':
            while True:
                api_key = input("Enter your Groq API key: ")
                if validate_api_key(api_key):
                    api_keys['GROQ_API_KEY'] = api_key
                    
                    # Recommend default model
                    print(f"\n{Colors.CYAN}Recommended Groq models:{Colors.ENDC}")
                    for i, model in enumerate(model_aliases['GROQ'], 1):
                        print(f"{Colors.CYAN}[{i}] {Colors.GREEN}{model}{Colors.ENDC}")
                    
                    model_choice = input("Select default model (1-2) or press Enter for llama-3.1-70b: ").strip()
                    if not model_choice or model_choice == '1':
                        model_info['default_model'] = 'groq/llama-3.1-70b-versatile'
                    elif model_choice == '2':
                        model_info['default_model'] = 'groq/llama-3.1-405b-reasoning-preview'
                    else:
                        model_info['default_model'] = 'groq/llama-3.1-70b-versatile'
                        print_warning(f"Invalid selection, using default: groq/llama-3.1-70b-versatile")
                    break
                print_error("Invalid API key format. It should be at least 10 characters long.")
        
        elif provider == 'OPENROUTER':
            while True:
                api_key = input("Enter your OpenRouter API key: ")
                if validate_api_key(api_key):
                    api_keys['OPENROUTER_API_KEY'] = api_key
                    api_keys['OPENROUTER_API_BASE'] = 'https://openrouter.ai/api/v1'

                    # Recommend default model
                    print(f"\n{Colors.CYAN}Recommended OpenRouter models:{Colors.ENDC}")
                    for i, model in enumerate(model_aliases['OPENROUTER'], 1):
                        print(f"{Colors.CYAN}[{i}] {Colors.GREEN}{model}{Colors.ENDC}")
                    
                    model_choice = input("Select default model (1-3) or press Enter for gemini-2.5-flash: ").strip()
                    if not model_choice or model_choice == '1':
                        model_info['default_model'] = 'openrouter/google/gemini-2.5-flash-preview'
                    elif model_choice.isdigit() and 1 <= int(model_choice) <= len(model_aliases['OPENROUTER']):
                        model_info['default_model'] = model_aliases['OPENROUTER'][int(model_choice) - 1]
                    else:
                        model_info['default_model'] = 'openrouter/google/gemini-2.5-flash-preview'
                        print_warning(f"Invalid selection, using default: openrouter/google/gemini-2.5-flash-preview")
                    break
                print_error("Invalid API key format. It should be at least 10 characters long.")
        
        elif provider == 'AWS_BEDROCK':
            print_info("For AWS Bedrock, you'll need AWS credentials and region")
            
            aws_access_key = input("Enter your AWS Access Key ID: ")
            aws_secret_key = input("Enter your AWS Secret Access Key: ")
            aws_region = input("Enter your AWS Region (e.g., us-west-2): ") or "us-west-2"
            
            if aws_access_key and aws_secret_key:
                api_keys['AWS_ACCESS_KEY_ID'] = aws_access_key
                api_keys['AWS_SECRET_ACCESS_KEY'] = aws_secret_key
                api_keys['AWS_REGION_NAME'] = aws_region
                
                # Recommend default model for AWS Bedrock
                print(f"\n{Colors.CYAN}Recommended AWS Bedrock models:{Colors.ENDC}")
                for i, model in enumerate(model_aliases['AWS_BEDROCK'], 1):
                    print(f"{Colors.CYAN}[{i}] {Colors.GREEN}{model}{Colors.ENDC}")
                
                model_choice = input("Select default model (1-2) or press Enter for claude-3-7-sonnet: ").strip()
                if not model_choice or model_choice == '1':
                    model_info['default_model'] = 'bedrock/anthropic.claude-3-7-sonnet-20250219-v1:0'
                elif model_choice == '2':
                    model_info['default_model'] = 'bedrock/amazon.titan-text-lite-v1'
                else:
                    model_info['default_model'] = 'bedrock/anthropic.claude-3-7-sonnet-20250219-v1:0'
                    print_warning(f"Invalid selection, using default: bedrock/anthropic.claude-3-7-sonnet-20250219-v1:0")
            else:
                print_warning("AWS credentials incomplete, Bedrock will not be configured correctly")
    
    # If no default model has been set, check which provider was selected and set an appropriate default
    if 'default_model' not in model_info:
        if 'ANTHROPIC_API_KEY' in api_keys:
            model_info['default_model'] = 'anthropic/claude-3-7-sonnet-latest'
        elif 'OPENAI_API_KEY' in api_keys:
            model_info['default_model'] = 'openai/gpt-4o'
        elif 'OPENROUTER_API_KEY' in api_keys:
            model_info['default_model'] = 'openrouter/google/gemini-2.5-flash-preview'
        elif 'GROQ_API_KEY' in api_keys:
            model_info['default_model'] = 'groq/llama-3.1-70b-versatile'
        elif 'AWS_ACCESS_KEY_ID' in api_keys:
            model_info['default_model'] = 'bedrock/anthropic.claude-3-7-sonnet-20250219-v1:0'
    
    print_success(f"Using {model_info['default_model']} as the default model")
    
    # Add the default model to the API keys dictionary
    api_keys['MODEL_TO_USE'] = model_info['default_model']
    
    return api_keys

def collect_search_api_keys():
    """Collect search API keys (now required, not optional)"""
    print_info("You'll need to obtain API keys for search and web scraping")
    print_info("Visit https://tavily.com/ to get a Tavily API key")
    print_info("Visit https://firecrawl.dev/ to get a Firecrawl API key")
    
    while True:
        tavily_api_key = input("Enter your Tavily API key: ")
        if validate_api_key(tavily_api_key):
            break
        print_error("Invalid API key format. It should be at least 10 characters long.")
    
    while True:
        firecrawl_api_key = input("Enter your Firecrawl API key: ")
        if validate_api_key(firecrawl_api_key):
            break
        print_error("Invalid API key format. It should be at least 10 characters long.")
    
    # Ask if user is self-hosting Firecrawl
    is_self_hosted = input("Are you self-hosting Firecrawl? (y/n): ").lower().strip() == 'y'
    firecrawl_url = "https://api.firecrawl.dev"  # Default URL
    
    if is_self_hosted:
        while True:
            custom_url = input("Enter your Firecrawl URL (e.g., https://your-firecrawl-instance.com): ")
            if validate_url(custom_url):
                firecrawl_url = custom_url
                break
            print_error("Invalid URL format. Please enter a valid URL.")
    
    return {
        'TAVILY_API_KEY': tavily_api_key,
        'FIRECRAWL_API_KEY': firecrawl_api_key,
        'FIRECRAWL_URL': firecrawl_url,
    }

def collect_rapidapi_keys():
    """Collect RapidAPI key (optional)"""
    print_info("To enable API services like LinkedIn, and others, you'll need a RapidAPI key")
    print_info("Each service requires individual activation in your RapidAPI account:")
    print_info("1. Locate the service's `base_url` in its corresponding file (e.g., https://linkedin-data-scraper.p.rapidapi.com in backend/agent/tools/data_providers/LinkedinProvider.py)")
    print_info("2. Visit that specific API on the RapidAPI marketplace")
    print_info("3. Subscribe to th`e service (many offer free tiers with limited requests)")
    print_info("4. Once subscribed, the service will be available to your agent through the API Services tool")
    print_info("A RapidAPI key is optional for API services like LinkedIn")
    print_info("Visit https://rapidapi.com/ to get your API key if needed")
    print_info("You can leave this blank and add it later if desired")
    
    rapid_api_key = input("Enter your RapidAPI key (optional, press Enter to skip): ")
    
    # Allow empty key
    if not rapid_api_key:
        print_info("Skipping RapidAPI key setup. You can add it later if needed.")
    else:
        # Validate if not empty
        if not validate_api_key(rapid_api_key, allow_empty=True):
            print_warning("The API key format seems invalid, but continuing anyway.")
    
    return {
        'RAPID_API_KEY': rapid_api_key,
    }

def configure_backend_env(env_vars, use_docker=True):
    """Configure backend .env file"""
    env_path = os.path.join('backend', '.env')
    
    # Redis configuration (based on deployment method)
    redis_host = 'redis' if use_docker else 'localhost'
    redis_config = {
        'REDIS_HOST': redis_host,
        'REDIS_PORT': '6379',
        'REDIS_PASSWORD': '',
        'REDIS_SSL': 'false',
    }
    
    # Organize all configuration
    all_config = {}
    
    # Create a string with the formatted content
    env_content = """# Generated by Suna setup script

# Environment Mode
# Valid values: local, staging, production
ENV_MODE=local

#DATABASE
"""

    # Supabase section
    for key, value in env_vars['supabase'].items():
        env_content += f"{key}={value}\n"
    
    # Redis section
    env_content += "\n# REDIS\n"
    for key, value in redis_config.items():
        env_content += f"{key}={value}\n"
    
    # LLM section
    env_content += "\n# LLM Providers:\n"
    # Add empty values for all LLM providers we support
    all_llm_keys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'MODEL_TO_USE']
    # Add AWS keys separately
    aws_keys = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION_NAME']
    
    # First add the keys that were provided
    for key, value in env_vars['llm'].items():
        if key in all_llm_keys:
            env_content += f"{key}={value}\n"
            # Remove from the list once added
            if key in all_llm_keys:
                all_llm_keys.remove(key)
    
    # Add empty values for any remaining LLM keys
    for key in all_llm_keys:
        env_content += f"{key}=\n"
    
    # AWS section
    env_content += "\n# AWS Bedrock\n"
    for key in aws_keys:
        value = env_vars['llm'].get(key, '')
        env_content += f"{key}={value}\n"
    
    # Additional OpenRouter params
    if 'OR_SITE_URL' in env_vars['llm'] or 'OR_APP_NAME' in env_vars['llm']:
        env_content += "\n# OpenRouter Additional Settings\n"
        if 'OR_SITE_URL' in env_vars['llm']:
            env_content += f"OR_SITE_URL={env_vars['llm']['OR_SITE_URL']}\n"
        if 'OR_APP_NAME' in env_vars['llm']:
            env_content += f"OR_APP_NAME={env_vars['llm']['OR_APP_NAME']}\n"
    
    # DATA APIs section
    env_content += "\n# DATA APIS\n"
    for key, value in env_vars['rapidapi'].items():
        env_content += f"{key}={value}\n"
    
    # Web search section
    env_content += "\n# WEB SEARCH\n"
    tavily_key = env_vars['search'].get('TAVILY_API_KEY', '')
    env_content += f"TAVILY_API_KEY={tavily_key}\n"
    
    # Web scrape section
    env_content += "\n# WEB SCRAPE\n"
    firecrawl_key = env_vars['search'].get('FIRECRAWL_API_KEY', '')
    firecrawl_url = env_vars['search'].get('FIRECRAWL_URL', '')
    env_content += f"FIRECRAWL_API_KEY={firecrawl_key}\n"
    env_content += f"FIRECRAWL_URL={firecrawl_url}\n"
    
    # Daytona section
    env_content += "\n# Sandbox container provider:\n"
    for key, value in env_vars['daytona'].items():
        env_content += f"{key}={value}\n"
    
    # Add next public URL at the end
    env_content += f"NEXT_PUBLIC_URL=http://localhost:3000\n"
    
    # Write to file
    with open(env_path, 'w') as f:
        f.write(env_content)
    
    print_success(f"Backend .env file created at {env_path}")
    print_info(f"Redis host is set to: {redis_host}")

def configure_frontend_env(env_vars, use_docker=True):
    """Configure frontend .env.local file"""
    env_path = os.path.join('frontend', '.env.local')
    
    # Use the appropriate backend URL based on start method
    backend_url = "http://backend:8000/api" if use_docker else "http://localhost:8000/api"
    
    config = {
        'NEXT_PUBLIC_SUPABASE_URL': env_vars['supabase']['SUPABASE_URL'],
        'NEXT_PUBLIC_SUPABASE_ANON_KEY': env_vars['supabase']['SUPABASE_ANON_KEY'],
        'NEXT_PUBLIC_BACKEND_URL': backend_url,
        'NEXT_PUBLIC_URL': 'http://localhost:3000',
    }
    
    # Write to file
    with open(env_path, 'w') as f:
        for key, value in config.items():
            f.write(f"{key}={value}\n")
    
    print_success(f"Frontend .env.local file created at {env_path}")
    print_info(f"Backend URL is set to: {backend_url}")

def setup_supabase():
    """Setup Supabase database"""
    print_info("Setting up Supabase database...")
    
    # Check if the Supabase CLI is installed
    try:
        subprocess.run(
            ['supabase', '--version'],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True
        )
    except (subprocess.SubprocessError, FileNotFoundError):
        print_error("Supabase CLI is not installed.")
        print_info("Please install it by following instructions at https://supabase.com/docs/guides/cli/getting-started")
        print_info("After installing, run this setup again")
        sys.exit(1)
    
    # Extract project reference from Supabase URL
    supabase_url = os.environ.get('SUPABASE_URL')
    if not supabase_url:
        # Get from main function if environment variable not set
        env_path = os.path.join('backend', '.env')
        if os.path.exists(env_path):
            with open(env_path, 'r') as f:
                for line in f:
                    if line.startswith('SUPABASE_URL='):
                        supabase_url = line.strip().split('=', 1)[1]
                        break

    project_ref = None
    if supabase_url:
        # Extract project reference from URL (format: https://[project_ref].supabase.co)
        match = re.search(r'https://([^.]+)\.supabase\.co', supabase_url)
        if match:
            project_ref = match.group(1)
            print_success(f"Extracted project reference '{project_ref}' from your Supabase URL")
    
    # If extraction failed, ask the user
    if not project_ref:
        print_info("Could not extract project reference from Supabase URL")
        print_info("Get your Supabase project reference from the Supabase dashboard")
        print_info("It's the portion after 'https://' and before '.supabase.co' in your project URL")
        project_ref = input("Enter your Supabase project reference: ")
    
    # Change the working directory to backend
    backend_dir = os.path.join(os.getcwd(), 'backend')
    print_info(f"Changing to backend directory: {backend_dir}")
    
    try:
        # Login to Supabase CLI (interactive)
        print_info("Logging into Supabase CLI...")
        subprocess.run(['supabase', 'login'], check=True)
        
        # Link to project
        print_info(f"Linking to Supabase project {project_ref}...")
        subprocess.run(
            ['supabase', 'link', '--project-ref', project_ref],
            cwd=backend_dir,
            check=True
        )
        
        # Push database migrations
        print_info("Pushing database migrations...")
        subprocess.run(['supabase', 'db', 'push'], cwd=backend_dir, check=True)
        
        print_success("Supabase database setup completed")
        
        # Reminder for manual step
        print_warning("IMPORTANT: You need to manually expose the 'basejump' schema in Supabase")
        print_info("Go to the Supabase web platform -> choose your project -> Project Settings -> Data API")
        print_info("In the 'Exposed Schema' section, add 'basejump' if not already there")
        input("Press Enter once you've completed this step...")
        
    except subprocess.SubprocessError as e:
        print_error(f"Failed to setup Supabase: {e}")
        sys.exit(1)

def install_dependencies():
    """Install frontend and backend dependencies"""
    print_info("Installing required dependencies...")
    
    try:
        # Install frontend dependencies
        print_info("Installing frontend dependencies...")
        subprocess.run(
            ['npm', 'install'], 
            cwd='frontend',
            check=True
        )
        print_success("Frontend dependencies installed successfully")
        
        # Lock dependencies
        print_info("Locking dependencies...")
        subprocess.run(
            ['poetry', 'lock'],
            cwd='backend',
            check=True
        )
        # Install backend dependencies
        print_info("Installing backend dependencies...")
        subprocess.run(
            ['poetry', 'install'], 
            cwd='backend',
            check=True
        )
        print_success("Backend dependencies installed successfully")
        
        return True
    except subprocess.SubprocessError as e:
        print_error(f"Failed to install dependencies: {e}")
        print_info("You may need to install them manually.")
        return False

def start_suna():
    """Start Suna using Docker Compose or manual startup"""
    print_info("You can start Suna using either Docker Compose or by manually starting the frontend and backend servers.")
    
    print(f"\n{Colors.CYAN}How would you like to start Suna?{Colors.ENDC}")
    print(f"{Colors.CYAN}[1] {Colors.GREEN}Docker Compose{Colors.ENDC} {Colors.CYAN}(recommended, starts all services){Colors.ENDC}")
    print(f"{Colors.CYAN}[2] {Colors.GREEN}Manual startup{Colors.ENDC} {Colors.CYAN}(requires Redis & separate terminals){Colors.ENDC}\n")
    
    while True:
        start_method = input("Enter your choice (1 or 2): ")
        if start_method in ["1", "2"]:
            break
        print_error("Invalid selection. Please enter '1' for Docker Compose or '2' for Manual startup.")
    
    use_docker = start_method == "1"
    
    if use_docker:
        print_info("Starting Suna with Docker Compose...")
        
        try:
            # GitHub repository environment variable setup
            github_repo = None
            
            print(f"\n{Colors.CYAN}Do you want to use pre-built images or build locally?{Colors.ENDC}")
            print(f"{Colors.CYAN}[1] {Colors.GREEN}Pre-built images{Colors.ENDC} {Colors.CYAN}(faster){Colors.ENDC}")
            print(f"{Colors.CYAN}[2] {Colors.GREEN}Build locally{Colors.ENDC} {Colors.CYAN}(customizable){Colors.ENDC}\n")
            
            while True:
                build_choice = input("Enter your choice (1 or 2): ")
                if build_choice in ["1", "2"]:
                    break
                print_error("Invalid selection. Please enter '1' for pre-built images or '2' for building locally.")
                
            use_prebuilt = build_choice == "1"
            
            if use_prebuilt:
                # Get GitHub repository name from user
                print_info("For pre-built images, you need to specify a GitHub repository name")
                print_info("Example format: your-github-username/repo-name")
                
                github_repo = input("Enter GitHub repository name: ")
                if not github_repo or "/" not in github_repo:
                    print_warning("Invalid GitHub repository format. Using a default value.")
                    # Create a random GitHub repository name as fallback
                    random_name = ''.join(random.choices(string.ascii_lowercase, k=8))
                    github_repo = f"user/{random_name}"
                
                # Set the environment variable
                os.environ["GITHUB_REPOSITORY"] = github_repo
                print_info(f"Using GitHub repository: {github_repo}")
                
                # Start with pre-built images
                print_info("Using pre-built images...")
                subprocess.run(['docker', 'compose', '-f', 'docker-compose.ghcr.yaml', 'up', '-d'], check=True)
            else:
                # Start with docker-compose (build images locally)
                print_info("Building images locally...")
                subprocess.run(['docker', 'compose', 'up', '-d'], check=True)
            
            # Wait for services to be ready
            print_info("Waiting for services to start...")
            time.sleep(10)  # Give services some time to start
            
            # Check if services are running
            result = subprocess.run(
                ['docker', 'compose', 'ps'],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
                text=True
            )
            
            if "backend" in result.stdout and "frontend" in result.stdout:
                print_success("Suna services are up and running!")
            else:
                print_warning("Some services might not be running correctly. Check 'docker compose ps' for details.")
            
        except subprocess.SubprocessError as e:
            print_error(f"Failed to start Suna: {e}")
            sys.exit(1)
            
        return use_docker
    else:
        print_info("For manual startup, you'll need to:")
        print_info("1. Start Redis in Docker (required for the backend)")
        print_info("2. Start the frontend with npm run dev")
        print_info("3. Start the backend with poetry run python3.11 api.py")
        print_warning("Note: Redis must be running before starting the backend")
        print_info("Detailed instructions will be provided at the end of setup")
        
        return use_docker

def final_instructions(use_docker=True, env_vars=None):
    """Show final instructions"""
    print(f"\n{Colors.GREEN}{Colors.BOLD}✨ Suna Setup Complete! ✨{Colors.ENDC}\n")
    
    # Display LLM configuration info if available
    if env_vars and 'llm' in env_vars and 'MODEL_TO_USE' in env_vars['llm']:
        default_model = env_vars['llm']['MODEL_TO_USE']
        print_info(f"Suna is configured to use {Colors.GREEN}{default_model}{Colors.ENDC} as the default LLM model")
    
    if use_docker:
        print_info("Your Suna instance is now running!")
        print_info("Access it at: http://localhost:3000")
        print_info("Create an account using Supabase authentication to start using Suna")
        print("\nUseful Docker commands:")
        print(f"{Colors.CYAN}  docker compose ps{Colors.ENDC}         - Check the status of Suna services")
        print(f"{Colors.CYAN}  docker compose logs{Colors.ENDC}       - View logs from all services")
        print(f"{Colors.CYAN}  docker compose logs -f{Colors.ENDC}    - Follow logs from all services")
        print(f"{Colors.CYAN}  docker compose down{Colors.ENDC}       - Stop Suna services")
        print(f"{Colors.CYAN}  docker compose up -d{Colors.ENDC}      - Start Suna services (after they've been stopped)")
    else:
        print_info("Suna setup is complete but services are not running yet.")
        print_info("To start Suna, you need to:")
        
        print_info("1. Start Redis (required for backend):")
        print(f"{Colors.CYAN}    cd backend")
        print(f"    docker compose up redis -d{Colors.ENDC}")
        
        print_info("2. In one terminal:")
        print(f"{Colors.CYAN}    cd frontend")
        print(f"    npm run dev{Colors.ENDC}")
        
        print_info("3. In another terminal:")
        print(f"{Colors.CYAN}    cd backend")
        print(f"    poetry run python3.11 api.py{Colors.ENDC}")
        
        print_info("4. Once all services are running, access Suna at: http://localhost:3000")
        print_info("5. Create an account using Supabase authentication to start using Suna")

def main():
    total_steps = 8  # Reduced by 1 since we're skipping the clone step
    current_step = 1
    
    # Print banner
    print_banner()
    print("This wizard will guide you through setting up Suna, an open-source generalist AI agent.\n")
    
    # Step 1: Check requirements
    print_step(current_step, total_steps, "Checking requirements")
    check_requirements()
    check_docker_running()
    
    # Check if we're in the Suna repository
    if not check_suna_directory():
        print_error("This setup script must be run from the Suna repository root directory.")
        print_info("Please clone the repository first with:")
        print_info("  git clone https://github.com/kortix-ai/suna.git")
        print_info("  cd suna")
        print_info("Then run this setup script again.")
        sys.exit(1)
    
    current_step += 1
    
    # Collect all environment variables
    print_step(current_step, total_steps, "Collecting Supabase information")
    supabase_info = collect_supabase_info()
    # Set Supabase URL in environment for later use
    os.environ['SUPABASE_URL'] = supabase_info['SUPABASE_URL']
    current_step += 1
    
    print_step(current_step, total_steps, "Collecting Daytona information")
    daytona_info = collect_daytona_info()
    current_step += 1
    
    print_step(current_step, total_steps, "Collecting LLM API keys")
    llm_api_keys = collect_llm_api_keys()
    current_step += 1
    
    print_step(current_step, total_steps, "Collecting search and web scraping API keys")
    search_api_keys = collect_search_api_keys()
    current_step += 1
    
    print_step(current_step, total_steps, "Collecting RapidAPI key")
    rapidapi_keys = collect_rapidapi_keys()
    current_step += 1
    
    # Combine all environment variables
    env_vars = {
        'supabase': supabase_info,
        'daytona': daytona_info,
        'llm': llm_api_keys,
        'search': search_api_keys,
        'rapidapi': rapidapi_keys,
    }
    
    # Setup Supabase database
    setup_supabase()
    current_step += 1
    
    # Install dependencies before starting Suna
    print_step(current_step, total_steps, "Installing dependencies")
    install_dependencies()
    
    # Configure environment files with the correct settings before starting
    print_info("Configuring environment files...")
    configure_backend_env(env_vars, True)  # Always create for Docker first
    configure_frontend_env(env_vars, True)
    
    # Now ask how to start Suna
    print_step(current_step, total_steps, "Starting Suna")
    use_docker = start_suna()
    
    # Update environment files if needed for non-Docker setup
    if not use_docker:
        print_info("Updating environment files for manual startup...")
        configure_backend_env(env_vars, use_docker)
        configure_frontend_env(env_vars, use_docker)
    
    # Final instructions
    final_instructions(use_docker, env_vars)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\nSetup interrupted. You can resume setup anytime by running this script again.")
        sys.exit(1)