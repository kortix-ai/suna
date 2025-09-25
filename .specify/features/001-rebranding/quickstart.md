# Quickstart: Automated Rebranding System

## Prerequisites
- Python 3.11 or higher
- Write permissions in project directory
- New brand assets prepared (logos, icons, etc.)

## 1. Prepare Your Brand Assets

Create a directory with your new brand images:
```bash
mkdir new_brand_assets
```

Add the following files (matching existing filenames):
- `kortix-logo.svg` → Your main logo
- `kortix-logo-white.svg` → White version of logo
- `kortix-symbol.svg` → Symbol/icon version
- `favicon.png` → Browser favicon (32x32)
- `banner.png` → Marketing banner
- `icon.png` → Mobile app icon
- Additional files as needed

## 2. Create Configuration File

Create `my_brand_config.json`:
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

## 3. Test with Dry Run

Preview all changes without modifying files:
```bash
python rebrand.py --config my_brand_config.json --dry-run
```

Review the output to ensure:
- ✅ All expected files are found
- ✅ Text replacements look correct
- ✅ Image files are matched properly
- ✅ No unexpected changes

## 4. Execute Rebranding

Run the actual rebranding:
```bash
python rebrand.py --config my_brand_config.json
```

The script will:
1. Create a timestamped backup directory
2. Process all text files for brand references
3. Replace image assets
4. Rename files containing brand names
5. Generate a detailed report

## 5. Verify Results

Check the changes:
```bash
# View the summary
cat rebrand_report_*.json | python -m json.tool | head -50

# Check a few key files
grep -i "acmecorp" frontend/src/lib/site.ts
ls frontend/public/*logo*

# Verify the application still works
npm run dev  # or your start command
```

## 6. Update Environment Variables

If using environment variables, update them:
```bash
# In .env files
KORTIX_ADMIN_API_KEY → ACMECORP_ADMIN_API_KEY

# In deployment configs
sed -i 's/KORTIX_/ACMECORP_/g' docker-compose.yml
```

## Common Options

### Minimal Command
```bash
# Just provide brand name, uses defaults for everything else
python rebrand.py --brand-name "AcmeCorp" --dry-run
```

### With Custom Assets
```bash
# Specify where new images are located
python rebrand.py --brand-name "AcmeCorp" --new-assets-dir ./my-brand-images
```

### Skip Backup (Faster, Less Safe)
```bash
# Not recommended for production
python rebrand.py --config my_brand_config.json --no-backup
```

## Troubleshooting

### Permission Errors
If you see "Permission denied" errors:
```bash
# Check file permissions
find . -type f ! -perm -u+w

# Run with sudo (careful!)
sudo python rebrand.py --config my_brand_config.json
```

### Missing Assets
If image replacement fails:
1. Verify asset filenames match exactly
2. Check new_assets_dir path is correct
3. Use --dry-run to see expected files

### Restore from Backup
If something goes wrong:
```bash
# Find your backup
ls -la backup_rebrand_*

# Restore files
cp -r backup_rebrand_YYYYMMDD_HHMMSS/* .
```

## Test Validation

Run these tests to confirm successful rebranding:

### Test 1: No Old Brand References
```bash
# Should return no results
grep -r "Kortix" --include="*.py" --include="*.ts" --include="*.tsx" .
grep -r "Suna" --include="*.py" --include="*.ts" --include="*.tsx" .
```

### Test 2: New Brand Present
```bash
# Should find multiple results
grep -r "AcmeCorp" --include="*.py" --include="*.ts" --include="*.tsx" . | wc -l
```

### Test 3: Images Updated
```bash
# Check file modification times
ls -la frontend/public/*.svg frontend/public/*.png
```

### Test 4: Application Starts
```bash
# Backend
cd backend && python -c "import api; print('Backend OK')"

# Frontend
cd frontend && npm run build
```

## Next Steps

After successful rebranding:

1. **Commit Changes**: Review and commit to version control
2. **Update Documentation**: Update README and other docs if needed
3. **Test Thoroughly**: Run full test suite
4. **Deploy**: Follow normal deployment process
5. **Monitor**: Check logs for any brand-related errors

## Support

For issues or questions:
- Check the detailed report: `rebrand_report_*.json`
- Review backup files if restoration needed
- Validate configuration syntax
- Ensure all asset files are present