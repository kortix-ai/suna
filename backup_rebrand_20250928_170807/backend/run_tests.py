#!/usr/bin/env python3
import os
import sys
import subprocess
import argparse
from pathlib import Path
from typing import List, Optional


def find_test_files(root_dir: Path = Path("./")) -> List[Path]:
    test_files = []
    
    for pattern in ["*.test.py", "test_*.py"]:
        for path in root_dir.rglob(pattern):
            if ".venv" not in str(path) and "__pycache__" not in str(path):
                test_files.append(path)
    
    return sorted(list(set(test_files)))


def run_pytest(
    test_files: List[Path],
    markers: Optional[str] = None,
    coverage: bool = False,
    verbose: bool = True,
    failfast: bool = False
) -> int:
    if not test_files:
        print("❌ No test files found!")
        return 1
    
    cmd = ["uv", "run", "pytest"]
    
    cmd.extend([str(f) for f in test_files])
    
    if verbose:
        cmd.append("-v")
    
    if failfast:
        cmd.append("-x")
    
    if markers:
        cmd.extend(["-m", markers])
    
    if coverage:
        cmd.extend([
            "--cov=core",
            "--cov=billing",
            "--cov-report=term-missing",
            "--cov-report=html",
            "--cov-report=xml"
        ])
    
    cmd.append("--tb=short")
    
    print(f"🔍 Found {len(test_files)} test file(s):")
    for f in test_files:
        print(f"   • {f}")
    print()
    print(f"🚀 Running: {' '.join(cmd)}")
    print("=" * 60)
    
    result = subprocess.run(cmd)
    return result.returncode


def main():
    parser = argparse.ArgumentParser(
        description="Run backend tests automatically",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s                     # Run all tests
  %(prog)s --unit              # Run only unit tests
  %(prog)s --integration       # Run only integration tests
  %(prog)s --llm               # Run only LLM tests (requires API keys)
  %(prog)s --coverage          # Run with coverage report
  %(prog)s --path core/services  # Run tests only in specific directory
        """
    )
    
    parser.add_argument(
        "--unit",
        action="store_true",
        help="Run only unit tests (fast, no external dependencies)"
    )
    parser.add_argument(
        "--integration",
        action="store_true",
        help="Run only integration tests"
    )
    parser.add_argument(
        "--llm",
        action="store_true",
        help="Run only LLM tests (requires API keys)"
    )
    parser.add_argument(
        "--all-markers",
        action="store_true",
        help="Run all test types sequentially"
    )
    parser.add_argument(
        "--coverage",
        action="store_true",
        help="Generate coverage report"
    )
    parser.add_argument(
        "--path",
        type=str,
        help="Specific path to search for tests (e.g., 'core/services')"
    )
    parser.add_argument(
        "--failfast",
        "-x",
        action="store_true",
        help="Stop on first test failure"
    )
    parser.add_argument(
        "--quiet",
        "-q",
        action="store_true",
        help="Less verbose output"
    )
    
    args = parser.parse_args()
    
    search_path = Path(args.path) if args.path else Path("./")
    
    print("🧪 Backend Test Runner")
    print("=" * 60)
    
    test_files = find_test_files(search_path)
    
    if not test_files:
        print(f"❌ No .test.py files found in {search_path}")
        return 1
    
    exit_code = 0
    
    if args.all_markers:
        marker_types = [
            ("unit", "Unit Tests (fast, no dependencies)"),
            ("integration", "Integration Tests"),
            ("llm", "LLM Tests (requires API keys)")
        ]
        
        for marker, description in marker_types:
            print(f"\n📋 Running {description}...")
            print("-" * 40)
            code = run_pytest(
                test_files,
                markers=marker,
                coverage=args.coverage,
                verbose=not args.quiet,
                failfast=args.failfast
            )
            if code != 0:
                exit_code = code
                if args.failfast:
                    break
    
    elif args.unit:
        print("\n📋 Running Unit Tests...")
        exit_code = run_pytest(
            test_files,
            markers="unit",
            coverage=args.coverage,
            verbose=not args.quiet,
            failfast=args.failfast
        )
    
    elif args.integration:
        print("\n📋 Running Integration Tests...")
        exit_code = run_pytest(
            test_files,
            markers="integration",
            coverage=args.coverage,
            verbose=not args.quiet,
            failfast=args.failfast
        )
    
    elif args.llm:
        if not (os.getenv("ANTHROPIC_API_KEY") or os.getenv("OPENAI_API_KEY")):
            print("⚠️  Warning: No API keys found (ANTHROPIC_API_KEY or OPENAI_API_KEY)")
            print("   LLM tests will be skipped.")
        
        print("\n📋 Running LLM Tests...")
        exit_code = run_pytest(
            test_files,
            markers="llm",
            coverage=args.coverage,
            verbose=not args.quiet,
            failfast=args.failfast
        )
    
    else:
        print("\n📋 Running All Tests...")
        exit_code = run_pytest(
            test_files,
            coverage=args.coverage,
            verbose=not args.quiet,
            failfast=args.failfast
        )
    
    print("\n" + "=" * 60)
    if exit_code == 0:
        print("✅ All tests passed!")
        if args.coverage:
            print("📊 Coverage report: htmlcov/index.html")
    else:
        print("❌ Some tests failed")
    
    return exit_code


if __name__ == "__main__":
    sys.exit(main()) 