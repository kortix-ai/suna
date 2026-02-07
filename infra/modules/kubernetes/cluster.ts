import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";
import { EksClusterConfig, NodeGroupConfig } from "./types";

export class SunaEksCluster extends pulumi.ComponentResource {
  public readonly cluster: eks.Cluster;
  public readonly kubeconfig: pulumi.Output<object>;
  public readonly clusterName: pulumi.Output<string>;
  public readonly clusterArn: pulumi.Output<string>;
  public readonly oidcProviderArn: pulumi.Output<string>;
  public readonly oidcProviderUrl: pulumi.Output<string>;
  public readonly k8sProvider: k8s.Provider;

  constructor(
    name: string,
    config: EksClusterConfig & {
      nodeRole: aws.iam.Role;
      instanceProfile: aws.iam.InstanceProfile;
      apiNodeGroup: NodeGroupConfig;
    },
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("suna:eks:Cluster", name, {}, opts);

    this.cluster = new eks.Cluster(`${name}-cluster`, {
      name: config.name,
      version: config.version,
      vpcId: config.vpcId,
      privateSubnetIds: config.privateSubnetIds,
      publicSubnetIds: config.publicSubnetIds,
      instanceRoles: [config.nodeRole],
      nodeAssociatePublicIpAddress: false,
      endpointPrivateAccess: true,
      endpointPublicAccess: true,
      enabledClusterLogTypes: [
        "api",
        "audit",
        "authenticator",
        "controllerManager",
        "scheduler",
      ],
      tags: {
        ...config.tags,
        Environment: config.environment,
      },
      skipDefaultNodeGroup: true,
      createOidcProvider: true,
    }, { parent: this });

    const apiMng = new eks.ManagedNodeGroup(`${name}-api-nodes`, {
      cluster: this.cluster,
      nodeGroupName: config.apiNodeGroup.name,
      instanceTypes: config.apiNodeGroup.instanceTypes,
      capacityType: config.apiNodeGroup.capacityType,
      scalingConfig: {
        minSize: config.apiNodeGroup.scalingConfig.minSize,
        maxSize: config.apiNodeGroup.scalingConfig.maxSize,
        desiredSize: config.apiNodeGroup.scalingConfig.desiredSize,
      },
      labels: config.apiNodeGroup.labels,
      nodeRoleArn: config.nodeRole.arn,
      tags: {
        ...config.tags,
        ...config.apiNodeGroup.tags,
      },
    }, { parent: this });

    this.k8sProvider = new k8s.Provider(`${name}-k8s-provider`, {
      kubeconfig: this.cluster.kubeconfigJson,
    }, { parent: this });

    new aws.eks.Addon(`${name}-cw-observability`, {
      clusterName: this.cluster.eksCluster.name,
      addonName: "amazon-cloudwatch-observability",
      resolveConflictsOnCreate: "OVERWRITE",
      resolveConflictsOnUpdate: "OVERWRITE",
      tags: config.tags,
    }, { parent: this, dependsOn: [apiMng] });

    this.kubeconfig = this.cluster.kubeconfig;
    this.clusterName = this.cluster.eksCluster.name;
    this.clusterArn = this.cluster.eksCluster.arn;

    const oidcProvider = this.cluster.core.oidcProvider!;
    this.oidcProviderArn = oidcProvider.apply(p => p!.arn);
    this.oidcProviderUrl = oidcProvider.apply(p => p!.url);

    this.registerOutputs({
      kubeconfig: this.kubeconfig,
      clusterName: this.clusterName,
      clusterArn: this.clusterArn,
      oidcProviderArn: this.oidcProviderArn,
      oidcProviderUrl: this.oidcProviderUrl,
    });
  }
}
