import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { LightsailConfig } from "./types";

export class LightsailInstance extends pulumi.ComponentResource {
  public readonly instance: aws.lightsail.Instance;
  public readonly ports: aws.lightsail.InstancePublicPorts;
  public readonly instanceName: pulumi.Output<string>;
  public readonly publicIpAddress: pulumi.Output<string>;
  public readonly privateIpAddress: pulumi.Output<string>;

  constructor(
    name: string,
    config: LightsailConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("suna:lightsail:Instance", name, {}, opts);

    this.instance = new aws.lightsail.Instance(`${name}-instance`, {
      name: config.name,
      availabilityZone: config.availabilityZone,
      blueprintId: config.blueprintId,
      bundleId: config.bundleId,
      keyPairName: config.keyPairName,
      tags: {
        ...config.tags,
        Environment: config.environment,
        Name: config.name,
      },
    }, { parent: this });

    this.ports = new aws.lightsail.InstancePublicPorts(`${name}-ports`, {
      instanceName: this.instance.name,
      portInfos: [{
        protocol: "tcp",
        fromPort: 22,
        toPort: 22,
        cidrs: ["0.0.0.0/0"],
      }],
    }, { parent: this });

    this.instanceName = this.instance.name;
    this.publicIpAddress = this.instance.publicIpAddress;
    this.privateIpAddress = this.instance.privateIpAddress;

    this.registerOutputs({
      instanceName: this.instanceName,
      publicIpAddress: this.publicIpAddress,
      privateIpAddress: this.privateIpAddress,
    });
  }
}
