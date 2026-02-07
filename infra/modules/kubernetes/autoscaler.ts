import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

export class ClusterAutoscaler extends pulumi.ComponentResource {
  public readonly chart: k8s.helm.v3.Release;

  constructor(
    name: string,
    config: {
      clusterName: string;
      namespace: string;
      serviceAccountName: string;
      roleArn: pulumi.Input<string>;
      region: string;
    },
    provider: k8s.Provider,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("suna:k8s:ClusterAutoscaler", name, {}, opts);

    this.chart = new k8s.helm.v3.Release(`${name}-helm`, {
      chart: "cluster-autoscaler",
      namespace: config.namespace,
      repositoryOpts: {
        repo: "https://kubernetes.github.io/autoscaler",
      },
      values: {
        autoDiscovery: {
          clusterName: config.clusterName,
        },
        awsRegion: config.region,
        rbac: {
          serviceAccount: {
            create: true,
            name: config.serviceAccountName,
            annotations: {
              "eks.amazonaws.com/role-arn": config.roleArn,
            },
          },
        },
        extraArgs: {
          "balance-similar-node-groups": true,
          "skip-nodes-with-system-pods": false,
          "scale-down-delay-after-add": "5m",
          "scale-down-unneeded-time": "5m",
          "scale-down-utilization-threshold": "0.65",
          "max-graceful-termination-sec": "120",
          "expander": "least-waste",
        },
        resources: {
          requests: { cpu: "50m", memory: "128Mi" },
          limits: { cpu: "100m", memory: "256Mi" },
        },
      },
    }, { provider, parent: this });

    this.registerOutputs({});
  }
}
