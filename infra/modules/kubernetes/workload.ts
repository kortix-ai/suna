import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { WorkloadConfig } from "./types";

export class ApiWorkload extends pulumi.ComponentResource {
  public readonly namespace: k8s.core.v1.Namespace;
  public readonly deployment: k8s.apps.v1.Deployment;
  public readonly service: k8s.core.v1.Service;
  public readonly hpa: k8s.autoscaling.v2.HorizontalPodAutoscaler;
  public readonly pdb: k8s.policy.v1.PodDisruptionBudget;
  public readonly ingress?: k8s.networking.v1.Ingress;

  constructor(
    name: string,
    config: WorkloadConfig,
    provider: k8s.Provider,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("suna:k8s:ApiWorkload", name, {}, opts);

    const providerOpt = { provider, parent: this };

    this.namespace = new k8s.core.v1.Namespace(`${name}-ns`, {
      metadata: {
        name: config.namespace,
        labels: {
          "app.kubernetes.io/managed-by": "pulumi",
        },
      },
    }, providerOpt);

    const secret = new k8s.core.v1.Secret(`${name}-secret`, {
      metadata: {
        name: config.envSecretName,
        namespace: this.namespace.metadata.name,
      },
      type: "Opaque",
      stringData: {
        SUNA_SECRETS_ARN: pulumi.output(config.secretsArn).apply(s => s),
      },
    }, providerOpt);

    const appLabels = {
      "app.kubernetes.io/name": config.name,
      "app.kubernetes.io/component": "api",
    };

    this.deployment = new k8s.apps.v1.Deployment(`${name}-deploy`, {
      metadata: {
        name: config.name,
        namespace: this.namespace.metadata.name,
        labels: appLabels,
      },
      spec: {
        replicas: config.replicas,
        selector: { matchLabels: appLabels },
        strategy: {
          type: "RollingUpdate",
          rollingUpdate: {
            maxUnavailable: 0,
            maxSurge: "25%",
          },
        },
        template: {
          metadata: { labels: appLabels },
          spec: {
            nodeSelector: config.nodeSelector,
            tolerations: config.tolerations?.map(t => ({
              key: t.key,
              operator: t.operator,
              value: t.value,
              effect: t.effect,
            })),
            topologySpreadConstraints: [{
              maxSkew: 1,
              topologyKey: "kubernetes.io/hostname",
              whenUnsatisfiable: "ScheduleAnyway",
              labelSelector: { matchLabels: appLabels },
            }],
            terminationGracePeriodSeconds: 120,
            containers: [{
              name: config.name,
              image: config.image,
              ports: [{ containerPort: config.port, name: "http" }],
              env: [
                {
                  name: "WORKERS",
                  value: config.workersPerPod.toString(),
                },
              ],
              envFrom: [{
                secretRef: { name: config.envSecretName },
              }],
              resources: {
                requests: {
                  cpu: config.cpu.request,
                  memory: config.memory.request,
                },
                limits: {
                  cpu: config.cpu.limit,
                  memory: config.memory.limit,
                },
              },
              readinessProbe: {
                httpGet: {
                  path: config.healthCheckPath,
                  port: "http",
                },
                initialDelaySeconds: 15,
                periodSeconds: 10,
                timeoutSeconds: 5,
                failureThreshold: 3,
              },
              livenessProbe: {
                httpGet: {
                  path: config.healthCheckPath,
                  port: "http",
                },
                initialDelaySeconds: 30,
                periodSeconds: 30,
                timeoutSeconds: 5,
                failureThreshold: 3,
              },
              startupProbe: {
                httpGet: {
                  path: config.healthCheckPath,
                  port: "http",
                },
                initialDelaySeconds: 10,
                periodSeconds: 10,
                timeoutSeconds: 5,
                failureThreshold: 12,
              },
            }],
          },
        },
      },
    }, { ...providerOpt, ignoreChanges: ["spec.replicas"] });

    this.service = new k8s.core.v1.Service(`${name}-svc`, {
      metadata: {
        name: config.name,
        namespace: this.namespace.metadata.name,
        labels: appLabels,
      },
      spec: {
        type: "ClusterIP",
        selector: appLabels,
        ports: [{
          port: 80,
          targetPort: config.port,
          protocol: "TCP",
          name: "http",
        }],
      },
    }, providerOpt);

    this.pdb = new k8s.policy.v1.PodDisruptionBudget(`${name}-pdb`, {
      metadata: {
        name: config.name,
        namespace: this.namespace.metadata.name,
      },
      spec: {
        minAvailable: "50%",
        selector: { matchLabels: appLabels },
      },
    }, providerOpt);

    this.hpa = new k8s.autoscaling.v2.HorizontalPodAutoscaler(`${name}-hpa`, {
      metadata: {
        name: config.name,
        namespace: this.namespace.metadata.name,
      },
      spec: {
        scaleTargetRef: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          name: config.name,
        },
        minReplicas: config.hpa.minReplicas,
        maxReplicas: config.hpa.maxReplicas,
        metrics: [
          {
            type: "Resource",
            resource: {
              name: "cpu",
              target: {
                type: "Utilization",
                averageUtilization: config.hpa.cpuTargetPercent,
              },
            },
          },
          ...(config.hpa.memoryTargetPercent ? [{
            type: "Resource",
            resource: {
              name: "memory",
              target: {
                type: "Utilization",
                averageUtilization: config.hpa.memoryTargetPercent,
              },
            },
          }] : []),
        ],
        behavior: {
          scaleDown: {
            stabilizationWindowSeconds: 300,
            policies: [{
              type: "Percent",
              value: 25,
              periodSeconds: 60,
            }],
          },
          scaleUp: {
            stabilizationWindowSeconds: 30,
            policies: [{
              type: "Percent",
              value: 100,
              periodSeconds: 60,
            }],
          },
        },
      },
    }, providerOpt);

    if (config.ingress.enabled) {
      const defaultAnnotations: Record<string, string> = {
        "kubernetes.io/ingress.class": "alb",
        "alb.ingress.kubernetes.io/scheme": "internet-facing",
        "alb.ingress.kubernetes.io/target-type": "ip",
        "alb.ingress.kubernetes.io/healthcheck-path": config.healthCheckPath,
        "alb.ingress.kubernetes.io/healthcheck-interval-seconds": "15",
        "alb.ingress.kubernetes.io/healthy-threshold-count": "2",
        "alb.ingress.kubernetes.io/unhealthy-threshold-count": "3",
        "alb.ingress.kubernetes.io/listen-ports": '[{"HTTP": 80}, {"HTTPS": 443}]',
        "alb.ingress.kubernetes.io/ssl-redirect": "443",
      };

      this.ingress = new k8s.networking.v1.Ingress(`${name}-ingress`, {
        metadata: {
          name: config.name,
          namespace: this.namespace.metadata.name,
          annotations: {
            ...defaultAnnotations,
            ...config.ingress.annotations,
          },
        },
        spec: {
          ingressClassName: "alb",
          rules: [{
            host: config.ingress.host,
            http: {
              paths: [{
                path: "/",
                pathType: "Prefix",
                backend: {
                  service: {
                    name: config.name,
                    port: { number: 80 },
                  },
                },
              }],
            },
          }],
        },
      }, providerOpt);
    }

    this.registerOutputs({
      namespaceName: this.namespace.metadata.name,
      deploymentName: this.deployment.metadata.name,
      serviceName: this.service.metadata.name,
    });
  }
}
