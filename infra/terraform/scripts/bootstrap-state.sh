#!/usr/bin/env bash
# Create the S3 bucket + DynamoDB lock table that hold Terraform remote state.
# Idempotent — skips anything that already exists. Run once per AWS account.
set -euo pipefail

REGION="${AWS_REGION:-us-west-2}"
BUCKET="${TF_STATE_BUCKET:-kortix-terraform-state}"
TABLE="${TF_LOCK_TABLE:-kortix-terraform-locks}"

echo "Region: $REGION  Bucket: $BUCKET  Lock table: $TABLE"

# ── S3 bucket ────────────────────────────────────────────────────────────────
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "  bucket exists: $BUCKET"
else
  echo "  creating bucket: $BUCKET"
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION"
fi
echo "  enabling versioning + encryption + public-access-block"
aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# ── DynamoDB lock table ──────────────────────────────────────────────────────
if aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" >/dev/null 2>&1; then
  echo "  lock table exists: $TABLE"
else
  echo "  creating lock table: $TABLE"
  aws dynamodb create-table --table-name "$TABLE" --region "$REGION" \
    --attribute-definitions AttributeName=LockID,AttributeType=S \
    --key-schema AttributeName=LockID,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST
fi

echo "Done. cd into an environment and run: terraform init"
