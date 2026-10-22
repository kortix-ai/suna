# Unique resource names (were "this"). Drata's IaC scanner merges resources by
# type and name across every root. With project-snapshots-bucket also declaring
# aws_s3_bucket "this", it reported critical 8011 (public access) and high 8003
# (versioning) on this bucket, which has both (aws_s3_bucket_public_access_block,
# aws_s3_bucket_versioning). The moved blocks keep every environment's bucket
# and key in place: no destroy, no re-create.
moved {
  from = aws_s3_bucket.this
  to   = aws_s3_bucket.audit_archive
}

moved {
  from = aws_s3_bucket_public_access_block.this
  to   = aws_s3_bucket_public_access_block.audit_archive
}

moved {
  from = aws_s3_bucket_ownership_controls.this
  to   = aws_s3_bucket_ownership_controls.audit_archive
}

moved {
  from = aws_s3_bucket_versioning.this
  to   = aws_s3_bucket_versioning.audit_archive
}

moved {
  from = aws_s3_bucket_object_lock_configuration.this
  to   = aws_s3_bucket_object_lock_configuration.audit_archive
}

moved {
  from = aws_kms_key.this
  to   = aws_kms_key.audit_archive
}

moved {
  from = aws_kms_alias.this
  to   = aws_kms_alias.audit_archive
}

moved {
  from = aws_s3_bucket_server_side_encryption_configuration.this
  to   = aws_s3_bucket_server_side_encryption_configuration.audit_archive
}

moved {
  from = aws_s3_bucket_lifecycle_configuration.this
  to   = aws_s3_bucket_lifecycle_configuration.audit_archive
}

moved {
  from = aws_s3_bucket_policy.this
  to   = aws_s3_bucket_policy.audit_archive
}
