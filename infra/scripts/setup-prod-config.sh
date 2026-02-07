#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROD_DIR="$SCRIPT_DIR/../environments/prod"
ENV_FILE="$PROD_DIR/.env"

cd "$PROD_DIR"

echo "=== Suna Production Infrastructure Setup (EKS) ==="
echo ""

if [ ! -f "$ENV_FILE" ]; then
    echo "Error: .env file not found at $ENV_FILE"
    echo ""
    echo "Create one with:"
    echo "  cp $PROD_DIR/.env.example $ENV_FILE"
    echo ""
    echo "Then fill in the values and re-run this script."
    exit 1
fi

while IFS='=' read -r key value; do
    [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
    key=$(echo "$key" | xargs)
    value=$(echo "$value" | xargs | sed 's/^"//;s/"$//')
    export "$key=$value"
done < "$ENV_FILE"

echo "Loaded .env from $ENV_FILE"
echo ""

REQUIRED_VARS=(VPC_ID PUBLIC_SUBNETS PRIVATE_SUBNETS SECRETS_MANAGER_ARN CLOUDFLARE_TUNNEL_ID DOCKER_IMAGE ALERT_EMAILS)
for var in "${REQUIRED_VARS[@]}"; do
    if [ -z "${!var}" ]; then
        echo "Error: $var is not set in .env"
        exit 1
    fi
done

echo "All required variables found. Setting Pulumi config..."
echo ""

to_json_array() {
    local input="$1"
    echo "$input" | sed 's/ *, */","/g' | sed 's/^/["/' | sed 's/$/"]/'
}

pulumi config set aws:region us-west-2
echo "  aws:region = us-west-2"

pulumi config set vpcId "$VPC_ID"
echo "  vpcId = $VPC_ID"

PUBLIC_JSON=$(to_json_array "$PUBLIC_SUBNETS")
pulumi config set --path publicSubnets "$PUBLIC_JSON"
echo "  publicSubnets = $PUBLIC_JSON"

PRIVATE_JSON=$(to_json_array "$PRIVATE_SUBNETS")
pulumi config set --path privateSubnets "$PRIVATE_JSON"
echo "  privateSubnets = $PRIVATE_JSON"

pulumi config set --secret secretsManagerArn "$SECRETS_MANAGER_ARN"
echo "  secretsManagerArn = [secret]"

pulumi config set --secret cloudflareTunnelId "$CLOUDFLARE_TUNNEL_ID"
echo "  cloudflareTunnelId = [secret]"

pulumi config set containerImage "$DOCKER_IMAGE"
echo "  containerImage = $DOCKER_IMAGE"

EMAILS_JSON=$(to_json_array "$ALERT_EMAILS")
pulumi config set --path alertEmails "$EMAILS_JSON"
echo "  alertEmails = $EMAILS_JSON"


[ -n "$EKS_VERSION" ] && pulumi config set eksVersion "$EKS_VERSION" && echo "  eksVersion = $EKS_VERSION"
[ -n "$API_NODE_INSTANCE_TYPE" ] && pulumi config set apiNodeInstanceType "$API_NODE_INSTANCE_TYPE" && echo "  apiNodeInstanceType = $API_NODE_INSTANCE_TYPE"
[ -n "$API_NODE_MIN" ] && pulumi config set apiNodeMin "$API_NODE_MIN" && echo "  apiNodeMin = $API_NODE_MIN"
[ -n "$API_NODE_MAX" ] && pulumi config set apiNodeMax "$API_NODE_MAX" && echo "  apiNodeMax = $API_NODE_MAX"
[ -n "$API_NODE_DESIRED" ] && pulumi config set apiNodeDesired "$API_NODE_DESIRED" && echo "  apiNodeDesired = $API_NODE_DESIRED"
[ -n "$BURST_NODE_MAX" ] && pulumi config set burstNodeMax "$BURST_NODE_MAX" && echo "  burstNodeMax = $BURST_NODE_MAX"
[ -n "$POD_REPLICAS" ] && pulumi config set podReplicas "$POD_REPLICAS" && echo "  podReplicas = $POD_REPLICAS"
[ -n "$POD_CPU_REQUEST" ] && pulumi config set podCpuRequest "$POD_CPU_REQUEST" && echo "  podCpuRequest = $POD_CPU_REQUEST"
[ -n "$POD_CPU_LIMIT" ] && pulumi config set podCpuLimit "$POD_CPU_LIMIT" && echo "  podCpuLimit = $POD_CPU_LIMIT"
[ -n "$POD_MEMORY_REQUEST" ] && pulumi config set podMemoryRequest "$POD_MEMORY_REQUEST" && echo "  podMemoryRequest = $POD_MEMORY_REQUEST"
[ -n "$POD_MEMORY_LIMIT" ] && pulumi config set podMemoryLimit "$POD_MEMORY_LIMIT" && echo "  podMemoryLimit = $POD_MEMORY_LIMIT"
[ -n "$WORKERS_PER_POD" ] && pulumi config set workersPerPod "$WORKERS_PER_POD" && echo "  workersPerPod = $WORKERS_PER_POD"
[ -n "$ACM_CERTIFICATE_ARN" ] && pulumi config set acmCertificateArn "$ACM_CERTIFICATE_ARN" && echo "  acmCertificateArn = $ACM_CERTIFICATE_ARN"
[ -n "$PRIMARY_DOMAIN" ] && pulumi config set primaryDomain "$PRIMARY_DOMAIN" && echo "  primaryDomain = $PRIMARY_DOMAIN"
[ -n "$LIGHTSAIL_DOMAIN" ] && pulumi config set lightsailDomain "$LIGHTSAIL_DOMAIN" && echo "  lightsailDomain = $LIGHTSAIL_DOMAIN"
[ -n "$CPU_WARNING_THRESHOLD" ] && pulumi config set cpuWarningThreshold "$CPU_WARNING_THRESHOLD" && echo "  cpuWarningThreshold = $CPU_WARNING_THRESHOLD"
[ -n "$CPU_CRITICAL_THRESHOLD" ] && pulumi config set cpuCriticalThreshold "$CPU_CRITICAL_THRESHOLD" && echo "  cpuCriticalThreshold = $CPU_CRITICAL_THRESHOLD"
[ -n "$MEMORY_WARNING_THRESHOLD" ] && pulumi config set memoryWarningThreshold "$MEMORY_WARNING_THRESHOLD" && echo "  memoryWarningThreshold = $MEMORY_WARNING_THRESHOLD"
[ -n "$MEMORY_CRITICAL_THRESHOLD" ] && pulumi config set memoryCriticalThreshold "$MEMORY_CRITICAL_THRESHOLD" && echo "  memoryCriticalThreshold = $MEMORY_CRITICAL_THRESHOLD"

echo ""
echo "=== Configuration Complete ==="
echo ""
echo "Review your config with:  pulumi config"
echo "Preview changes with:     pulumi preview"
echo "Deploy with:              pulumi up"
