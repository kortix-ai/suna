#!/usr/bin/env python3
"""
Kortix Deployment Helper
Interactive script to help choose and deploy to the right platform
"""

import os
import sys
import subprocess
from typing import Dict, List, Tuple

class Colors:
    HEADER = '\033[95m'
    OKBLUE = '\033[94m'
    OKCYAN = '\033[96m'
    OKGREEN = '\033[92m'
    WARNING = '\033[93m'
    FAIL = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'
    UNDERLINE = '\033[4m'

def print_header(text: str):
    print(f"\n{Colors.HEADER}{Colors.BOLD}{'='*60}{Colors.ENDC}")
    print(f"{Colors.HEADER}{Colors.BOLD}{text.center(60)}{Colors.ENDC}")
    print(f"{Colors.HEADER}{Colors.BOLD}{'='*60}{Colors.ENDC}\n")

def print_success(text: str):
    print(f"{Colors.OKGREEN}✓ {text}{Colors.ENDC}")

def print_info(text: str):
    print(f"{Colors.OKCYAN}ℹ {text}{Colors.ENDC}")

def print_warning(text: str):
    print(f"{Colors.WARNING}⚠ {text}{Colors.ENDC}")

def print_error(text: str):
    print(f"{Colors.FAIL}✗ {text}{Colors.ENDC}")

def ask_question(question: str, options: List[Tuple[str, str]]) -> str:
    """Ask multiple choice question"""
    print(f"\n{Colors.BOLD}{question}{Colors.ENDC}\n")
    for i, (key, desc) in enumerate(options, 1):
        print(f"  {i}. {key}: {desc}")
    
    while True:
        try:
            choice = input(f"\n{Colors.OKCYAN}Enter choice (1-{len(options)}): {Colors.ENDC}")
            idx = int(choice) - 1
            if 0 <= idx < len(options):
                return options[idx][0]
        except (ValueError, IndexError):
            pass
        print_error("Invalid choice. Please try again.")

def check_prerequisites() -> Dict[str, bool]:
    """Check if required tools are installed"""
    print_header("Checking Prerequisites")
    
    tools = {
        'docker': 'docker --version',
        'git': 'git --version',
        'node': 'node --version',
        'python': 'python --version'
    }
    
    results = {}
    for tool, command in tools.items():
        try:
            subprocess.run(command.split(), capture_output=True, check=True)
            print_success(f"{tool} is installed")
            results[tool] = True
        except (subprocess.CalledProcessError, FileNotFoundError):
            print_error(f"{tool} is NOT installed")
            results[tool] = False
    
    return results

def recommend_platform(budget: str, expertise: str, scale: str) -> Tuple[str, str]:
    """Recommend deployment platform based on answers"""
    
    # Budget-first recommendations
    if budget == "< $50":
        if expertise in ["Beginner", "Intermediate"]:
            return "Fly.io", "Best balance of cost and ease for your needs"
        else:
            return "Self-hosted VPS", "Maximum control at minimum cost"
    
    elif budget == "$50-150":
        if expertise == "Beginner":
            return "Render", "Easiest to deploy, great documentation"
        elif scale == "< 100 users":
            return "Railway", "Excellent developer experience"
        else:
            return "Fly.io", "Good performance, scales well"
    
    elif budget == "$150-300":
        if expertise == "Beginner":
            return "Render Pro", "Managed platform with auto-scaling"
        elif scale in ["< 100 users", "100-1K users"]:
            return "DigitalOcean", "Predictable pricing, good performance"
        else:
            return "GCP Cloud Run", "Serverless, handles burst traffic well"
    
    else:  # $300+
        if scale in ["10K+ users", "1K-10K users"]:
            return "AWS ECS", "Production-grade, excellent auto-scaling"
        else:
            return "AWS ECS", "Enterprise features, best ecosystem"

def get_deployment_recommendation():
    """Main recommendation flow"""
    print_header("Kortix Deployment Helper")
    print_info("This wizard will help you choose the best deployment platform")
    
    # Check prerequisites
    prereqs = check_prerequisites()
    if not all(prereqs.values()):
        print_warning("\nSome prerequisites are missing. Please install them first.")
        missing = [tool for tool, installed in prereqs.items() if not installed]
        print(f"Missing tools: {', '.join(missing)}")
        sys.exit(1)
    
    # Ask questions
    print_header("Quick Questions")
    
    budget = ask_question(
        "What's your monthly budget?",
        [
            ("< $50", "Hobby/learning project"),
            ("$50-150", "Solo developer/small team"),
            ("$150-300", "Growing startup"),
            ("$300+", "Funded company/enterprise")
        ]
    )
    
    expertise = ask_question(
        "What's your technical expertise?",
        [
            ("Beginner", "New to deployments"),
            ("Intermediate", "Comfortable with Docker/cloud basics"),
            ("Advanced", "Experience with AWS/GCP/Azure"),
            ("Expert", "DevOps professional")
        ]
    )
    
    scale = ask_question(
        "Expected number of users?",
        [
            ("< 100 users", "MVP/early stage"),
            ("100-1K users", "Growing user base"),
            ("1K-10K users", "Established product"),
            ("10K+ users", "Large scale")
        ]
    )
    
    priority = ask_question(
        "What's your top priority?",
        [
            ("Speed", "Deploy as fast as possible"),
            ("Cost", "Minimize expenses"),
            ("Scale", "Handle growth easily"),
            ("Control", "Maximum flexibility")
        ]
    )
    
    # Get recommendation
    platform, reason = recommend_platform(budget, expertise, scale)
    
    # Show results
    print_header("Recommendation")
    print(f"{Colors.BOLD}Platform: {Colors.OKGREEN}{platform}{Colors.ENDC}")
    print(f"{Colors.BOLD}Reason: {Colors.ENDC}{reason}\n")
    
    # Show deployment guide
    show_quick_guide(platform)
    
    # Offer to continue
    print(f"\n{Colors.BOLD}Next Steps:{Colors.ENDC}")
    print(f"1. Review detailed guide: docs/DEPLOYMENT-OPTIONS.md")
    print(f"2. Check decision matrix: docs/DEPLOYMENT-DECISION-GUIDE.md")
    print(f"3. Follow platform setup for {platform}")

def show_quick_guide(platform: str):
    """Show quick setup guide for platform"""
    guides = {
        "Render": """
Quick Start for Render:
1. Go to https://dashboard.render.com
2. Connect your GitHub repository
3. Create render.yaml (see docs/DEPLOYMENT-OPTIONS.md)
4. Add environment variables in dashboard
5. Deploy!

Estimated setup time: 15-30 minutes
Monthly cost: ~$100-180
        """,
        
        "Railway": """
Quick Start for Railway:
1. Install CLI: npm i -g @railway/cli
2. Run: railway login
3. Run: railway init
4. Add services in dashboard
5. Deploy: railway up

Estimated setup time: 20-40 minutes
Monthly cost: ~$100-180
        """,
        
        "Fly.io": """
Quick Start for Fly.io:
1. Install: curl -L https://fly.io/install.sh | sh
2. Login: flyctl auth login
3. Create fly.toml configs (see docs)
4. Deploy: flyctl deploy
5. Scale: flyctl scale count 2

Estimated setup time: 30-60 minutes
Monthly cost: ~$80-150
        """,
        
        "AWS ECS": """
Quick Start for AWS ECS:
1. Follow comprehensive guide: docs/DEPLOYMENT-AWS.md
2. Estimated setup time: 4-8 hours
3. Monthly cost: ~$260-400

This is a complex setup. Consider:
- Starting with Render/Railway first
- Hiring DevOps consultant
- Using infrastructure-as-code (Terraform)
        """,
        
        "Self-hosted VPS": """
Quick Start for Self-Hosted:
1. Get VPS (Hetzner/Linode/DigitalOcean)
2. SSH into server
3. Install Docker: curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh
4. Clone repo: git clone https://github.com/your-org/kortix.git
5. Setup .env files
6. Run: docker compose up -d
7. Configure Nginx + SSL

Estimated setup time: 2-4 hours
Monthly cost: ~$31-120
        """,
        
        "DigitalOcean": """
Quick Start for DigitalOcean:
1. Create account at https://digitalocean.com
2. Install doctl CLI
3. Create .do/app.yaml (see docs)
4. Deploy: doctl apps create --spec .do/app.yaml
5. Configure environment variables

Estimated setup time: 1-2 hours
Monthly cost: ~$150-250
        """,
        
        "GCP Cloud Run": """
Quick Start for Google Cloud Run:
1. Install gcloud CLI
2. Run: gcloud init
3. Enable APIs: gcloud services enable run.googleapis.com
4. Build: gcloud builds submit
5. Deploy: gcloud run deploy

Estimated setup time: 2-3 hours
Monthly cost: ~$150-300
        """
    }
    
    print(f"\n{Colors.OKCYAN}{guides.get(platform, 'See docs for details')}{Colors.ENDC}")

def main():
    try:
        get_deployment_recommendation()
    except KeyboardInterrupt:
        print(f"\n\n{Colors.WARNING}Deployment helper cancelled.{Colors.ENDC}")
        sys.exit(0)
    except Exception as e:
        print_error(f"An error occurred: {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    main()


