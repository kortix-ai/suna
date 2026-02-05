#!/bin/bash
set -e

cd "$(dirname "$0")/../environments/prod"

echo "=== Suna Production Infrastructure Setup ==="
echo ""
echo "This script will configure your Pulumi secrets for production."
echo "Make sure you have the AWS CLI configured and Pulumi logged in."
echo ""

if [ ! -f "Pulumi.prod.yaml" ]; then
    echo "Creating Pulumi.prod.yaml from example..."
    cp Pulumi.prod.yaml.example Pulumi.prod.yaml
fi

echo "Setting up required secrets..."
echo ""

read -p "Enter Secrets Manager ARN: " SECRETS_ARN
pulumi config set --secret secretsManagerArn "$SECRETS_ARN"

read -p "Enter Cloudflare Tunnel ID: " TUNNEL_ID
pulumi config set --secret cloudflareTunnelId "$TUNNEL_ID"

echo ""
echo "Setting up required configuration..."
echo ""

read -p "Enter VPC ID: " VPC_ID
pulumi config set vpcId "$VPC_ID"

read -p "Enter private subnet IDs (comma-separated): " PRIVATE_SUBNETS
pulumi config set --plaintext privateSubnets "[\"${PRIVATE_SUBNETS//,/\",\"}\"]"

read -p "Enter public subnet IDs (comma-separated): " PUBLIC_SUBNETS
pulumi config set --plaintext publicSubnets "[\"${PUBLIC_SUBNETS//,/\",\"}\"]"

read -p "Enter ALB Security Group ID: " ALB_SG
pulumi config set albSecurityGroupId "$ALB_SG"

read -p "Enter ECS Security Group ID: " ECS_SG
pulumi config set ecsSecurityGroupId "$ECS_SG"

read -p "Enter Target Group ARN: " TG_ARN
pulumi config set targetGroupArn "$TG_ARN"

read -p "Enter Load Balancer ARN (e.g., app/name/id): " LB_ARN
pulumi config set loadBalancerArn "$LB_ARN"

read -p "Enter ALB DNS Name: " ALB_DNS
pulumi config set albDnsName "$ALB_DNS"

read -p "Enter Container Image URL: " IMAGE
pulumi config set containerImage "$IMAGE"

read -p "Enter Lightsail Key Pair Name: " KEY_NAME
pulumi config set lightsailKeyPairName "$KEY_NAME"

read -p "Enter alert email addresses (comma-separated): " EMAILS
pulumi config set --plaintext alertEmails "[\"${EMAILS//,/\",\"}\"]"

echo ""
echo "=== Configuration Complete ==="
echo ""
echo "Review your config with: pulumi config"
echo "Preview changes with: pulumi preview"
echo "Deploy with: pulumi up"
