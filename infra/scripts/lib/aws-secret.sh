# Sourced by the env sync scripts; not executable on its own.

# put_or_create_secret <region> <name> <description>: write the JSON payload on
# stdin as the secret's new value, creating the secret first when it is
# missing. Echoes `updated` or `created`; never prints the payload.
put_or_create_secret() {
  if aws secretsmanager describe-secret --region "$1" --secret-id "$2" >/dev/null 2>&1 </dev/null; then
    aws secretsmanager put-secret-value --region "$1" \
      --secret-id "$2" --secret-string file:///dev/stdin >/dev/null || return
    echo updated
  else
    aws secretsmanager create-secret --region "$1" \
      --name "$2" --secret-string file:///dev/stdin \
      --description "$3" >/dev/null || return
    echo created
  fi
}
