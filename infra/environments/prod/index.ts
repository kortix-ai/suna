import * as pulumi from "@pulumi/pulumi";

import { COMMON_TAGS } from "../../modules/constants";
import {
  SunaEksCluster,
  ApiWorkload,
  ClusterAutoscaler,
  EksIamRoles,
  AlbControllerIamRole,
  ClusterAutoscalerIamRole,
} from "../../modules/kubernetes";
import { EksMonitoring } from "../../modules/monitoring";

const config = new pulumi.Config();
const awsConfig = new pulumi.Config("aws");
const environment = "prod";
const region = awsConfig.require("region");

const networkConfig = {
  vpcId: config.require("vpcId"),
  publicSubnets: config.requireObject<string[]>("publicSubnets"),
  privateSubnets: config.requireObject<string[]>("privateSubnets"),
};

const serviceConfig = {
  name: config.get("serviceName") || "suna-api",
  containerImage: config.require("containerImage"),
  containerPort: config.getNumber("containerPort") || 8000,
  healthCheckPath: config.get("healthCheckPath") || "/v1/health-docker",
};

const eksConfig = {
  version: config.get("eksVersion") || "1.31",
  apiNodeInstanceType: config.get("apiNodeInstanceType") || "c7i.xlarge",
  apiNodeMin: config.getNumber("apiNodeMin") || 2,
  apiNodeMax: config.getNumber("apiNodeMax") || 8,
  apiNodeDesired: config.getNumber("apiNodeDesired") || 3,
};

const podConfig = {
  replicas: config.getNumber("podReplicas") || 4,
  cpuRequest: config.get("podCpuRequest") || "500m",
  cpuLimit: config.get("podCpuLimit") || "1500m",
  memoryRequest: config.get("podMemoryRequest") || "2Gi",
  memoryLimit: config.get("podMemoryLimit") || "3Gi",
  workersPerPod: config.getNumber("workersPerPod") || 2,
};

const monitoringConfig = {
  cpuWarning: config.getNumber("cpuWarningThreshold") || 70,
  cpuCritical: config.getNumber("cpuCriticalThreshold") || 85,
  memoryWarning: config.getNumber("memoryWarningThreshold") || 75,
  memoryCritical: config.getNumber("memoryCriticalThreshold") || 90,
  alertEmails: config.requireObject<string[]>("alertEmails"),
};

const secretsManagerArn = config.requireSecret("secretsManagerArn");
const cloudflareTunnelId = config.requireSecret("cloudflareTunnelId");

const iamRoles = new EksIamRoles("suna-eks-iam", {
  serviceName: serviceConfig.name,
  secretsArn: secretsManagerArn,
  tags: COMMON_TAGS,
});

const eksClusterName = "suna-eks";
const namespace = "suna";

const eksCluster = new SunaEksCluster("suna-eks", {
  name: eksClusterName,
  environment,
  version: eksConfig.version,
  vpcId: networkConfig.vpcId,
  privateSubnetIds: networkConfig.privateSubnets,
  publicSubnetIds: networkConfig.publicSubnets,
  nodeRole: iamRoles.nodeRole,
  instanceProfile: iamRoles.nodeInstanceProfile,
  tags: COMMON_TAGS,
  apiNodeGroup: {
    name: "suna-api-nodes",
    instanceTypes: [eksConfig.apiNodeInstanceType],
    capacityType: "ON_DEMAND",
    scalingConfig: {
      minSize: eksConfig.apiNodeMin,
      maxSize: eksConfig.apiNodeMax,
      desiredSize: eksConfig.apiNodeDesired,
    },
    labels: { pool: "api" },
    tags: {
      NodeGroup: "api",
      [`k8s.io/cluster-autoscaler/${eksClusterName}`]: "owned",
      "k8s.io/cluster-autoscaler/enabled": "true",
    },
  },
});

const albControllerRole = new AlbControllerIamRole("suna-alb-controller", {
  clusterName: eksClusterName,
  oidcProviderArn: eksCluster.oidcProviderArn,
  oidcProviderUrl: eksCluster.oidcProviderUrl,
  namespace: "kube-system",
  serviceAccountName: "aws-load-balancer-controller",
  tags: COMMON_TAGS,
});

const clusterAutoscalerRole = new ClusterAutoscalerIamRole("suna-cas", {
  clusterName: eksClusterName,
  oidcProviderArn: eksCluster.oidcProviderArn,
  oidcProviderUrl: eksCluster.oidcProviderUrl,
  namespace: "kube-system",
  serviceAccountName: "cluster-autoscaler",
  tags: COMMON_TAGS,
});

const clusterAutoscaler = new ClusterAutoscaler("suna-cas", {
  clusterName: eksClusterName,
  namespace: "kube-system",
  serviceAccountName: "cluster-autoscaler",
  roleArn: clusterAutoscalerRole.roleArn,
  region,
}, eksCluster.k8sProvider);

const apiWorkload = new ApiWorkload("suna-api", {
  name: serviceConfig.name,
  namespace,
  image: serviceConfig.containerImage,
  port: serviceConfig.containerPort,
  replicas: podConfig.replicas,
  cpu: { request: podConfig.cpuRequest, limit: podConfig.cpuLimit },
  memory: { request: podConfig.memoryRequest, limit: podConfig.memoryLimit },
  healthCheckPath: serviceConfig.healthCheckPath,
  envSecretName: "suna-env",
  secretsArn: secretsManagerArn,
  workersPerPod: podConfig.workersPerPod,
  hpa: {
    minReplicas: podConfig.replicas,
    maxReplicas: 15,
    cpuTargetPercent: 70,
  },
  ingress: {
    enabled: true,
    host: config.get("primaryDomain") || "api-eks.kortix.com",
    annotations: {
      "alb.ingress.kubernetes.io/certificate-arn": config.get("acmCertificateArn") || "",
      "alb.ingress.kubernetes.io/subnets": networkConfig.publicSubnets.join(","),
    },
  },
  tags: COMMON_TAGS,
}, eksCluster.k8sProvider);

const monitoring = new EksMonitoring("suna-api-monitoring", {
  clusterName: eksClusterName,
  deploymentName: serviceConfig.name,
  namespace,
  environment,
  cpuThresholdWarning: monitoringConfig.cpuWarning,
  cpuThresholdCritical: monitoringConfig.cpuCritical,
  memoryThresholdWarning: monitoringConfig.memoryWarning,
  memoryThresholdCritical: monitoringConfig.memoryCritical,
  alertEmails: monitoringConfig.alertEmails,
  tags: COMMON_TAGS,
});

export const outputs = {
  environment,

  eks: {
    clusterName: eksCluster.clusterName,
    clusterArn: eksCluster.clusterArn,
    kubeconfig: eksCluster.kubeconfig,
  },

  workload: {
    namespace,
    deploymentName: serviceConfig.name,
    replicas: podConfig.replicas,
    cpuRequest: podConfig.cpuRequest,
    memoryRequest: podConfig.memoryRequest,
    workersPerPod: podConfig.workersPerPod,
  },

  nodeGroups: {
    api: {
      instanceType: eksConfig.apiNodeInstanceType,
      min: eksConfig.apiNodeMin,
      max: eksConfig.apiNodeMax,
      capacityType: "ON_DEMAND",
    },
  },

  monitoring: {
    alertTopicArn: monitoring.alertTopic.arn,
    dashboardUrl: pulumi.interpolate`https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#dashboards:name=${serviceConfig.name}-${environment}`,
  },

  cloudflare: {
    tunnelCname: cloudflareTunnelId.apply(id => `${id}.cfargotunnel.com`),
  },

  endpoints: {
    primary: config.get("primaryDomain") || "api-eks.kortix.com",
    lightsail: config.get("lightsailDomain") || "api-lightsail.kortix.com",
  },
};
