---
name: domain-research
description: "Free domain research and availability checking. No API keys or credentials required. Uses RDAP (1195+ TLDs) with whois CLI fallback for universal coverage. Checks if domains are available, searches keywords across TLDs, performs WHOIS/RDAP lookups, checks expiry dates, and finds nameservers. Use when the agent needs to: check if a domain is available, search for domains, find who owns a domain, check domain expiration, get nameservers, bulk check domains, or do any domain research. Triggers on: 'check domain', 'is domain available', 'search domains', 'domain availability', 'who owns this domain', 'whois', 'domain expiry', 'when does domain expire', 'nameservers for', 'domain research', 'find domains for', 'domain ideas', 'bulk domain check'."
---

# Domain Research

Free domain availability checking and WHOIS/RDAP lookup. Zero credentials. Works out of the box.

**How it works:** RDAP protocol (1195+ TLDs, JSON, fast) with `whois` CLI fallback for TLDs RDAP doesn't cover (.io, .co, .me, .sh, .gg, .so, etc). Parallel lookups for speed.

---

## CLI Script

```bash
SCRIPT="skills/domain-research/scripts/domain-lookup.py"
```

No env vars, no API keys, no setup. Just run it.

---

## Commands

### Check availability

```bash
# Single or multiple domains (comma-separated)
python3 "$SCRIPT" check "example.com"
python3 "$SCRIPT" check "myproject.com,myproject.io,myproject.ai,myproject.dev"
```

### Search keyword across TLDs

```bash
# Default: .com .net .org .io .co .ai .dev .app .xyz .me .tech .cloud + more
python3 "$SCRIPT" search "myproject"

# Custom TLDs
python3 "$SCRIPT" search "myproject" --tlds ".com,.io,.ai,.dev,.app,.co"
```

### WHOIS / RDAP lookup

```bash
# Full registration details (registrar, dates, status, nameservers, contacts)
python3 "$SCRIPT" whois google.com
python3 "$SCRIPT" whois kortix.ai
```

### Expiry check

```bash
# When does it expire? How many days left?
python3 "$SCRIPT" expiry kortix.ai
```

### Nameservers

```bash
python3 "$SCRIPT" nameservers google.com
```

### Bulk check from file

```bash
# File with one domain per line
python3 "$SCRIPT" bulk domains.txt
```

---

## How it works internally

1. **RDAP first** -- queries `rdap.org/domain/{domain}`. HTTP 200 = taken, 404 = available. Returns structured JSON.
2. **whois fallback** -- for TLDs without RDAP support, runs `whois` CLI and pattern-matches response.
3. **Parallel** -- uses thread pool (8 workers) for batch checks.
4. **Rate-aware** -- bulk mode pauses between batches.

### RDAP coverage (1195+ TLDs)
.com, .net, .org, .ai, .dev, .app, .xyz, .tech, .cloud, .gay, .wtf, .bot, .news, .space, .capital, and 1180+ more gTLDs.

### whois fallback covers
.io, .co, .me, .sh, .gg, .so, and other ccTLDs that RDAP doesn't support yet.

---

## Rules

- **No credentials needed.** Just run the script.
- **Present results clearly.** Highlight available domains. Show method used (RDAP/whois).
- **For keyword search,** default to common TLDs unless the user specifies otherwise.
- **For WHOIS lookups,** show registrar, dates, status, nameservers. Contacts are often redacted (GDPR).
- **Rate limits:** RDAP has no documented limit but be reasonable. whois registries may throttle after ~50 queries/minute.
- **Cannot register/buy domains.** This is research only. Direct the user to a registrar to purchase.
