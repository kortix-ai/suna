#!/usr/bin/env python3
"""
Domain Research CLI -- Free domain availability checking, WHOIS/RDAP lookup.
Zero credentials required. Uses RDAP (1195+ TLDs) with whois CLI fallback.

Usage:
  python3 domain-lookup.py <command> [options]

Commands:
  check <domain1,domain2,...>          Check domain availability
  search <keyword> [--tlds .com,.net]  Search keyword across TLDs
  whois <domain>                       Full WHOIS/RDAP lookup
  expiry <domain>                      Check expiration date
  nameservers <domain>                 Get nameservers
  bulk <file>                          Check domains from file (one per line)
"""

import sys
import json
import argparse
import subprocess
import urllib.request
import urllib.error
import re
import os
import time
from pathlib import Path
from typing import Optional, Dict, Any, List, Tuple
from concurrent.futures import ThreadPoolExecutor, as_completed

# ─── RDAP BOOTSTRAP ──────────────────────────────────────────
# Instead of querying rdap.org (which rate-limits aggressively),
# we download the IANA bootstrap file once and query registry
# RDAP servers directly. Each registry only serves its own TLDs
# so rate limits are generous.

IANA_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json"
RDAP_FALLBACK = "https://rdap.org/domain/"  # Last resort only

# Cache bootstrap data in memory (loaded once per run)
_rdap_bootstrap: Optional[Dict[str, str]] = None  # tld -> rdap_base_url
_bootstrap_loaded = False

# Cache file: avoid re-downloading every single run
_CACHE_DIR = Path.home() / ".cache" / "domain-research"
_CACHE_FILE = _CACHE_DIR / "rdap-bootstrap.json"
_CACHE_MAX_AGE = 86400 * 7  # 7 days


def _load_bootstrap() -> Dict[str, str]:
    """Load TLD -> RDAP URL mapping from IANA bootstrap. Cached to disk."""
    global _rdap_bootstrap, _bootstrap_loaded
    if _bootstrap_loaded and _rdap_bootstrap is not None:
        return _rdap_bootstrap

    # Try disk cache first
    mapping = _load_bootstrap_cache()
    if mapping:
        _rdap_bootstrap = mapping
        _bootstrap_loaded = True
        return mapping

    # Download fresh
    mapping = _download_bootstrap()
    if mapping:
        _save_bootstrap_cache(mapping)
        _rdap_bootstrap = mapping
        _bootstrap_loaded = True
        return mapping

    # Empty fallback — will use rdap.org
    _rdap_bootstrap = {}
    _bootstrap_loaded = True
    return _rdap_bootstrap


def _load_bootstrap_cache() -> Optional[Dict[str, str]]:
    """Load cached bootstrap from disk if fresh enough."""
    try:
        if _CACHE_FILE.exists():
            age = time.time() - _CACHE_FILE.stat().st_mtime
            if age < _CACHE_MAX_AGE:
                with open(_CACHE_FILE) as f:
                    return json.load(f)
    except Exception:
        pass
    return None


def _save_bootstrap_cache(mapping: Dict[str, str]):
    """Save bootstrap to disk cache."""
    try:
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        with open(_CACHE_FILE, "w") as f:
            json.dump(mapping, f)
    except Exception:
        pass  # Non-critical


def _download_bootstrap() -> Optional[Dict[str, str]]:
    """Download IANA RDAP bootstrap and build TLD -> URL mapping."""
    try:
        req = urllib.request.Request(IANA_BOOTSTRAP_URL)
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        mapping = {}
        for entry in data.get("services", []):
            tlds, urls = entry
            rdap_url = urls[0] if urls else None
            if rdap_url:
                # Ensure trailing slash
                if not rdap_url.endswith("/"):
                    rdap_url += "/"
                for tld in tlds:
                    mapping[tld.lower()] = rdap_url
        return mapping
    except Exception:
        return None


def _get_rdap_url(domain: str) -> str:
    """Get the best RDAP URL for a domain. Registry-direct when possible."""
    bootstrap = _load_bootstrap()
    tld = domain.rsplit(".", 1)[-1].lower() if "." in domain else ""

    if tld in bootstrap:
        base = bootstrap[tld]
        return f"{base}domain/{domain}"

    # Fallback to rdap.org proxy
    return f"{RDAP_FALLBACK}{domain}"


# ─── WHOIS PATTERNS ──────────────────────────────────────────

# Patterns indicating domain is available (order matters: more specific first)
AVAIL_PATTERNS = re.compile(
    r"(?:"
    r"^No match for "                           # Verisign .com/.net
    r"|^NOT FOUND\b"                            # Various registries
    r"|^No Data Found"                          # Some registries
    r"|^The queried object does not exist"      # CentralNic (.store, .online, etc.)
    r"|^No entries found"                       # DENIC .de
    r"|^Domain not found"                       # Various
    r"|^No such domain"                         # Various
    r"|^Status:\s*(?:free|available|AVAILABLE)"  # Some ccTLD registries
    r"|^%% No matching objects"                 # RIPE-style
    r"|^This domain name has not been registered" # .hk
    r"|^The domain has not been registered"     # .tw
    r"|^Object does not exist"                  # Various
    r"|DOMAIN NOT FOUND"                        # Various (case-insensitive handled by flag)
    r"|is free$"                                # Some registries
    r"|^not registered"                         # Some registries
    r")",
    re.IGNORECASE | re.MULTILINE,
)

# Patterns indicating domain is taken — these are strong positive signals
TAKEN_PATTERNS = re.compile(
    r"(?:"
    r"^Domain Name:\s*\S+"                      # Standard WHOIS domain record
    r"|^Registry Domain ID:\s*\S+"              # ICANN registries
    r"|^Registrar:\s*\S+"                       # Has a registrar = registered
    r"|^Creation Date:\s*\S+"                   # Has creation date = registered
    r"|^Registry Expiry Date:\s*\S+"            # Has expiry = registered
    r"|^Registrar Registration Expiration Date:" # Alternative expiry format
    r"|^created:\s*\S+"                         # ccTLD format
    r"|^registered:\s*\S+"                      # .uk format
    r"|^Registration Date:\s*\S+"               # Some registries
    r"|^Domain Status:\s*\S+"                   # ICANN status flags
    r"|^Registered on:\s*\S+"                   # .uk
    r")",
    re.IGNORECASE | re.MULTILINE,
)


DEFAULT_TLDS = [
    ".com", ".net", ".org", ".io", ".co", ".ai", ".dev", ".app",
    ".xyz", ".me", ".tech", ".cloud", ".sh", ".so", ".gg",
    ".info", ".biz", ".us", ".online", ".site", ".store",
]


# ─── RDAP LOOKUP ─────────────────────────────────────────────

def rdap_lookup(domain: str, retries: int = 2) -> Tuple[Optional[Dict], int]:
    """Query RDAP for a domain via its registry server. Returns (data_or_None, http_status)."""
    url = _get_rdap_url(domain)
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, headers={"Accept": "application/rdap+json,application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                body = resp.read().decode("utf-8")
                return json.loads(body), resp.status
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None, 404
            if e.code in (429, 502, 503) and attempt < retries:
                time.sleep(1.5 * (attempt + 1))
                continue
            return None, e.code
        except Exception:
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
                continue
            return None, 0
    return None, 0


# ─── WHOIS LOOKUP ────────────────────────────────────────────

def _run_whois(domain: str, server: Optional[str] = None) -> Optional[str]:
    """Run whois CLI, optionally targeting a specific server."""
    try:
        cmd = ["whois"]
        if server:
            cmd += ["-h", server]
        cmd.append(domain)
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        return result.stdout + result.stderr
    except FileNotFoundError:
        return None
    except subprocess.TimeoutExpired:
        return None
    except Exception:
        return None


# Known registry whois servers for TLDs where the default whois referral chain fails
_REGISTRY_WHOIS = {
    ".me": "whois.nic.me",
    ".io": "whois.nic.io",
    ".co": "whois.registry.co",
    ".sh": "whois.nic.sh",
    ".gg": "whois.gg",
    ".so": "whois.nic.so",
    ".cc": "ccwhois.verisign-grs.com",
    ".tv": "tvwhois.verisign-grs.com",
    ".us": "whois.nic.us",
    ".in": "whois.registry.in",
    ".de": "whois.denic.de",
    ".uk": "whois.nic.uk",
    ".eu": "whois.eu",
    ".ca": "whois.cira.ca",
    ".au": "whois.auda.org.au",
    ".nl": "whois.domain-registry.nl",
    ".br": "whois.registro.br",
    ".fr": "whois.nic.fr",
    ".it": "whois.nic.it",
    ".jp": "whois.jprs.jp",
    ".ru": "whois.tcinet.ru",
    ".cn": "whois.cnnic.cn",
}


def whois_lookup(domain: str) -> Optional[str]:
    """Run whois CLI for a domain. Follows referrals and queries registry directly."""
    tld = "." + domain.rsplit(".", 1)[-1].lower() if "." in domain else ""

    # Strategy 1: For known problematic TLDs, go straight to the registry
    if tld in _REGISTRY_WHOIS:
        registry_output = _run_whois(domain, _REGISTRY_WHOIS[tld])
        if registry_output and len(registry_output.strip()) > 20:
            return registry_output

    # Strategy 2: Default whois command (follows IANA referrals on most systems)
    output = _run_whois(domain)
    if output is None:
        return None

    # Check if we only got TLD-level info with no domain data
    has_domain_data = bool(re.search(
        r"^(?:Domain Name|Registry Domain ID|Registrar|Creation Date|"
        r"Domain Status|created:|registered:):\s*\S",
        output, re.MULTILINE | re.IGNORECASE
    ))

    if has_domain_data:
        return output

    # Parse "refer:" from IANA response and follow it
    refer_match = re.search(r"^refer:\s*(\S+)", output, re.MULTILINE | re.IGNORECASE)
    if refer_match:
        registry_output = _run_whois(domain, refer_match.group(1))
        if registry_output and len(registry_output.strip()) > 20:
            return registry_output

    # Also try "whois:" field (some IANA entries use this instead of "refer:")
    whois_match = re.search(r"^whois:\s*(\S+)", output, re.MULTILINE | re.IGNORECASE)
    if whois_match and whois_match.group(1).strip():
        registry_output = _run_whois(domain, whois_match.group(1))
        if registry_output and len(registry_output.strip()) > 20:
            return registry_output

    return output


def check_availability_whois(domain: str) -> str:
    """Check availability via whois CLI. Returns 'available'|'taken'|'unknown'."""
    output = whois_lookup(domain)
    if output is None:
        return "unknown"

    # Check available first (specific patterns)
    if AVAIL_PATTERNS.search(output):
        # But make sure there's no actual domain data contradicting "not found"
        # (some whois servers print "not found" in footer even for registered domains)
        if not TAKEN_PATTERNS.search(output):
            return "available"

    # Check taken
    if TAKEN_PATTERNS.search(output):
        return "taken"

    # Last resort: if we got substantial output (>500 chars) with no clear signal,
    # it's likely a registered domain with unusual formatting
    if len(output.strip()) > 500:
        return "taken"

    return "unknown"


# ─── DOMAIN CHECK (COMBINED) ─────────────────────────────────

# TLDs that have NO RDAP support — skip RDAP entirely, go straight to whois
_NO_RDAP_TLDS = {"io", "co", "me", "sh", "so", "gg", "cc", "tv", "us", "uk", "eu",
                 "de", "fr", "it", "nl", "br", "jp", "ru", "cn", "ca", "au", "in"}

# TLDs where RDAP 404 is authoritative (the registry itself serves RDAP)
# For these, we trust 404 = available without whois double-check
_RDAP_AUTHORITATIVE_TLDS = {
    "com", "net", "org", "ai", "dev", "app", "xyz", "tech", "cloud",
    "info", "biz", "online", "site", "store",
    # Google TLDs
    "page", "how", "new", "day", "mov", "zip", "phd", "prof", "esq",
    # Other well-known gTLDs
    "blog", "shop", "art", "design", "agency", "studio", "media",
}


def check_domain(domain: str) -> Tuple[str, str, Optional[Dict]]:
    """Check a single domain. Returns (status, method, rdap_data)."""
    tld = domain.rsplit(".", 1)[-1].lower() if "." in domain else ""

    # For TLDs with no RDAP, go straight to whois
    if tld in _NO_RDAP_TLDS:
        status = check_availability_whois(domain)
        return status, "whois", None

    # Try RDAP (queries registry directly, not rdap.org)
    data, http_status = rdap_lookup(domain)

    if http_status == 200 and data:
        return "taken", "RDAP", data

    if http_status == 404:
        # For authoritative TLDs, trust RDAP 404 = available
        if tld in _RDAP_AUTHORITATIVE_TLDS:
            return "available", "RDAP", None
        # For others, double-check with whois
        whois_status = check_availability_whois(domain)
        if whois_status == "taken":
            return "taken", "whois", None
        return "available", "RDAP+whois", None

    # RDAP failed (rate limit, timeout, etc.) — fall back to whois
    whois_status = check_availability_whois(domain)
    if whois_status != "unknown":
        return whois_status, "whois", None

    # Both failed — try rdap.org as absolute last resort
    fallback_url = f"{RDAP_FALLBACK}{domain}"
    req = urllib.request.Request(fallback_url, headers={"Accept": "application/rdap+json,application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return "taken", "RDAP", data
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return "available", "RDAP", None
    except Exception:
        pass

    return "unknown", "?", None


# ─── RDAP PARSERS ────────────────────────────────────────────

def parse_rdap_events(data: Dict) -> Dict[str, str]:
    """Extract dates from RDAP events."""
    dates = {}
    for event in data.get("events", []):
        action = event.get("eventAction", "")
        date = event.get("eventDate", "")
        if action and date:
            dates[action] = date[:10]
    return dates


def parse_rdap_nameservers(data: Dict) -> List[str]:
    """Extract nameservers from RDAP data."""
    ns_list = []
    for ns in data.get("nameservers", []):
        name = ns.get("ldhName", "")
        if name:
            ns_list.append(name.lower())
    return ns_list


def parse_rdap_registrar(data: Dict) -> str:
    """Extract registrar from RDAP entities."""
    for entity in data.get("entities", []):
        roles = entity.get("roles", [])
        if "registrar" in roles:
            vcard = entity.get("vcardArray", [])
            if len(vcard) > 1:
                for field in vcard[1]:
                    if field[0] == "fn":
                        return field[3]
            for pid in entity.get("publicIds", []):
                return pid.get("identifier", "")
            handle = entity.get("handle", "")
            if handle:
                return handle
    return "?"


def parse_rdap_status(data: Dict) -> List[str]:
    """Extract status flags."""
    return data.get("status", [])


# ─── COMMANDS ────────────────────────────────────────────────

def cmd_check(args):
    """Check domain availability."""
    domains = [d.strip() for d in args.domains.split(",") if d.strip()]
    if not domains:
        print("ERROR: No domains provided.")
        sys.exit(1)

    # Pre-load bootstrap once before parallel work
    _load_bootstrap()

    print(f"{'Domain':<45} {'Status':<15} {'Method'}")
    print("-" * 72)

    def check_one(domain):
        status, method, _ = check_domain(domain)
        return domain, status, method

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(check_one, d): d for d in domains}
        results = []
        for future in as_completed(futures):
            results.append(future.result())

    result_map = {r[0]: r for r in results}
    for domain in domains:
        if domain in result_map:
            _, status, method = result_map[domain]
            status_str = "AVAILABLE" if status == "available" else ("TAKEN" if status == "taken" else "UNKNOWN")
            print(f"{domain:<45} {status_str:<15} {method}")


def cmd_search(args):
    """Search keyword across TLDs."""
    keyword = args.keyword.lower().strip()
    if not keyword:
        print("ERROR: No keyword provided.")
        sys.exit(1)

    tlds = [t.strip() for t in args.tlds.split(",")] if args.tlds else DEFAULT_TLDS
    tlds = [t if t.startswith(".") else f".{t}" for t in tlds]
    domains = [f"{keyword}{tld}" for tld in tlds]

    # Pre-load bootstrap once before parallel work
    _load_bootstrap()

    print(f"Searching: {keyword}")
    print(f"{'Domain':<45} {'Status':<15} {'Method'}")
    print("-" * 72)

    def check_one(domain):
        status, method, _ = check_domain(domain)
        return domain, status, method

    # Process in batches — generous since we query registries directly now
    batch_size = 8
    all_results = []
    for i in range(0, len(domains), batch_size):
        batch = domains[i:i+batch_size]
        with ThreadPoolExecutor(max_workers=6) as pool:
            futures = {pool.submit(check_one, d): d for d in batch}
            for future in as_completed(futures):
                all_results.append(future.result())
        if i + batch_size < len(domains):
            time.sleep(0.2)

    result_map = {r[0]: r for r in all_results}
    avail_count = 0
    for domain in domains:
        if domain in result_map:
            _, status, method = result_map[domain]
            status_str = "AVAILABLE" if status == "available" else ("TAKEN" if status == "taken" else "UNKNOWN")
            if status == "available":
                avail_count += 1
            print(f"{domain:<45} {status_str:<15} {method}")

    print(f"\n{avail_count} available out of {len(domains)} checked")


def cmd_whois(args):
    """Full WHOIS/RDAP lookup for a domain."""
    domain = args.domain.lower().strip()

    # Pre-load bootstrap
    _load_bootstrap()

    # Try RDAP first
    data, status = rdap_lookup(domain)
    if status == 404:
        print(f"{domain}: AVAILABLE (not registered)")
        return

    if status == 200 and data:
        print(f"Domain:      {data.get('ldhName', domain)}")

        events = parse_rdap_events(data)
        if "registration" in events:
            print(f"Registered:  {events['registration']}")
        if "expiration" in events:
            print(f"Expires:     {events['expiration']}")
        if "last changed" in events:
            print(f"Updated:     {events['last changed']}")

        registrar = parse_rdap_registrar(data)
        print(f"Registrar:   {registrar}")

        statuses = parse_rdap_status(data)
        if statuses:
            print(f"Status:      {', '.join(statuses)}")

        ns_list = parse_rdap_nameservers(data)
        if ns_list:
            print(f"Nameservers:")
            for ns in ns_list:
                print(f"  {ns}")

        for entity in data.get("entities", []):
            roles = entity.get("roles", [])
            vcard = entity.get("vcardArray", [])
            if len(vcard) > 1 and roles:
                role_str = "/".join(roles)
                for field in vcard[1]:
                    if field[0] == "fn" and field[3]:
                        print(f"Contact ({role_str}): {field[3]}")
                        break

        print(f"\nSource: RDAP")
        return

    # Fallback to whois CLI
    output = whois_lookup(domain)
    if output is None:
        print(f"ERROR: Could not look up {domain} (whois not installed or timed out)")
        return

    if AVAIL_PATTERNS.search(output) and not TAKEN_PATTERNS.search(output):
        print(f"{domain}: AVAILABLE (not registered)")
        return

    # Parse common fields from whois output
    print(f"Domain:      {domain}")

    fields = [
        ("Registrar", r"Registrar:\s*(.+)"),
        ("Created", r"Creat(?:ion|ed)\s*(?:Date)?:\s*(.+)"),
        ("Expires", r"(?:Expir(?:y|ation)|Registry Expiry)\s*(?:Date)?:\s*(.+)"),
        ("Updated", r"Updated?\s*(?:Date)?:\s*(.+)"),
        ("Status", r"(?:Domain )?Status:\s*(.+)"),
    ]

    seen_status = False
    for label, pattern in fields:
        matches = re.findall(pattern, output, re.IGNORECASE | re.MULTILINE)
        if matches:
            if label == "Status":
                if not seen_status:
                    seen_status = True
                    for m in matches[:3]:
                        print(f"Status:      {m.strip()}")
            else:
                print(f"{label + ':':<13}{matches[0].strip()}")

    ns_matches = re.findall(r"Name Server:\s*(.+)", output, re.IGNORECASE)
    if not ns_matches:
        ns_matches = re.findall(r"nserver:\s*(.+)", output, re.IGNORECASE)
    if ns_matches:
        print(f"Nameservers:")
        for ns in ns_matches[:6]:
            print(f"  {ns.strip().lower()}")

    print(f"\nSource: whois CLI")


def cmd_expiry(args):
    """Check domain expiration."""
    domain = args.domain.lower().strip()

    _load_bootstrap()

    data, status = rdap_lookup(domain)
    if status == 404:
        print(f"{domain}: AVAILABLE (not registered)")
        return

    if status == 200 and data:
        events = parse_rdap_events(data)
        exp = events.get("expiration", "?")
        reg = events.get("registration", "?")
        print(f"Domain:      {domain}")
        print(f"Registered:  {reg}")
        print(f"Expires:     {exp}")

        if exp != "?":
            try:
                from datetime import datetime, date
                exp_date = datetime.strptime(exp, "%Y-%m-%d").date()
                today = date.today()
                delta = (exp_date - today).days
                if delta > 0:
                    print(f"Days left:   {delta}")
                elif delta == 0:
                    print(f"Days left:   EXPIRES TODAY")
                else:
                    print(f"Days left:   EXPIRED {abs(delta)} days ago")
            except Exception:
                pass
        return

    # Whois fallback
    output = whois_lookup(domain)
    if output is None:
        print(f"ERROR: Could not look up {domain}")
        return

    if AVAIL_PATTERNS.search(output) and not TAKEN_PATTERNS.search(output):
        print(f"{domain}: AVAILABLE (not registered)")
        return

    print(f"Domain:      {domain}")
    exp_match = re.search(r"(?:Expir(?:y|ation)|Registry Expiry)\s*(?:Date)?:\s*(.+)", output, re.IGNORECASE)
    if exp_match:
        print(f"Expires:     {exp_match.group(1).strip()}")
    else:
        print(f"Expires:     ? (could not parse)")

    reg_match = re.search(r"Creat(?:ion|ed)\s*(?:Date)?:\s*(.+)", output, re.IGNORECASE)
    if reg_match:
        print(f"Registered:  {reg_match.group(1).strip()}")


def cmd_nameservers(args):
    """Get nameservers for a domain."""
    domain = args.domain.lower().strip()

    _load_bootstrap()

    data, status = rdap_lookup(domain)
    if status == 404:
        print(f"{domain}: AVAILABLE (not registered)")
        return

    if status == 200 and data:
        ns_list = parse_rdap_nameservers(data)
        if ns_list:
            print(f"Nameservers for {domain}:")
            for ns in ns_list:
                print(f"  {ns}")
        else:
            print(f"{domain}: No nameservers in RDAP data")
        return

    # Whois fallback
    output = whois_lookup(domain)
    if output is None:
        print(f"ERROR: Could not look up {domain}")
        return

    if AVAIL_PATTERNS.search(output) and not TAKEN_PATTERNS.search(output):
        print(f"{domain}: AVAILABLE (not registered)")
        return

    ns_matches = re.findall(r"Name Server:\s*(.+)", output, re.IGNORECASE)
    if not ns_matches:
        ns_matches = re.findall(r"nserver:\s*(.+)", output, re.IGNORECASE)

    if ns_matches:
        print(f"Nameservers for {domain}:")
        for ns in ns_matches[:6]:
            print(f"  {ns.strip().lower()}")
    else:
        print(f"{domain}: Could not find nameservers")


def cmd_bulk(args):
    """Check domains from a file (one per line)."""
    filepath = args.file
    if not os.path.isfile(filepath):
        print(f"ERROR: File not found: {filepath}")
        sys.exit(1)

    with open(filepath, "r") as f:
        domains = [line.strip() for line in f if line.strip() and not line.startswith("#")]

    if not domains:
        print("ERROR: No domains in file.")
        sys.exit(1)

    _load_bootstrap()

    print(f"Checking {len(domains)} domains from {filepath}")
    print(f"{'Domain':<45} {'Status':<15} {'Method'}")
    print("-" * 72)

    avail_count = 0
    taken_count = 0

    def check_one(domain):
        status, method, _ = check_domain(domain)
        return domain, status, method

    batch_size = 10
    all_results = []
    for i in range(0, len(domains), batch_size):
        batch = domains[i:i+batch_size]
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = {pool.submit(check_one, d): d for d in batch}
            for future in as_completed(futures):
                all_results.append(future.result())
        if i + batch_size < len(domains):
            time.sleep(0.3)

    result_map = {r[0]: r for r in all_results}
    for domain in domains:
        if domain in result_map:
            _, status, method = result_map[domain]
            status_str = "AVAILABLE" if status == "available" else ("TAKEN" if status == "taken" else "UNKNOWN")
            if status == "available":
                avail_count += 1
            elif status == "taken":
                taken_count += 1
            print(f"{domain:<45} {status_str:<15} {method}")

    print(f"\nSummary: {avail_count} available, {taken_count} taken, {len(domains) - avail_count - taken_count} unknown")


# ─── MAIN ────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Domain Research CLI -- Free RDAP + WHOIS lookup, zero credentials",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subs = parser.add_subparsers(dest="command")

    p = subs.add_parser("check", help="Check domain availability")
    p.add_argument("domains", help="Comma-separated domains")

    p = subs.add_parser("search", help="Search keyword across TLDs")
    p.add_argument("keyword", help="Keyword to search")
    p.add_argument("--tlds", default=None, help="Comma-separated TLDs (e.g. .com,.net,.io)")

    p = subs.add_parser("whois", help="Full WHOIS/RDAP lookup")
    p.add_argument("domain", help="Domain to look up")

    p = subs.add_parser("expiry", help="Check domain expiration")
    p.add_argument("domain", help="Domain to check")

    p = subs.add_parser("nameservers", help="Get nameservers")
    p.add_argument("domain", help="Domain to check")

    p = subs.add_parser("bulk", help="Bulk check from file")
    p.add_argument("file", help="File with one domain per line")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    cmd_map = {
        "check": cmd_check,
        "search": cmd_search,
        "whois": cmd_whois,
        "expiry": cmd_expiry,
        "nameservers": cmd_nameservers,
        "bulk": cmd_bulk,
    }

    func = cmd_map.get(args.command)
    if func:
        func(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
