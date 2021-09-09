import { Repository } from '@aws-cdk/aws-ecr';
import { Aws, CfnOutput, Construct, Duration, RemovalPolicy, Stack, StackProps } from '@aws-cdk/core';
import { IVpc, Port, SecurityGroup, SubnetType, Vpc } from '@aws-cdk/aws-ec2';
import { AwsLogDriver, Cluster, ContainerImage, FargateService, FargateTaskDefinition, UlimitName } from '@aws-cdk/aws-ecs';
import { ApplicationListener, ApplicationLoadBalancer, ApplicationProtocol, ListenerCondition, Protocol as ELBProtocol } from '@aws-cdk/aws-elasticloadbalancingv2';
import { DnsRecordType, PrivateDnsNamespace } from '@aws-cdk/aws-servicediscovery';
import { Mesh, VirtualGateway, VirtualGatewayListener } from '@aws-cdk/aws-appmesh';
import { ManagedPolicy } from '@aws-cdk/aws-iam';
import { resolve } from 'path';


export class InfrastructureStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // fargate cluster
    const vpc = Vpc.fromLookup(this, 'default-vpc', { isDefault: true });
    const cluster = new Cluster(this, 'Cluster', {
      vpc: vpc,
    });

    const alb = new ApplicationLoadBalancer(this, 'public-alb', {
      vpc,
      internetFacing: true,
    });
    new CfnOutput(this, 'alb-dns-name', { value: `http://${alb.loadBalancerDnsName}` });

    const listener = alb.addListener('http-listener', {
      port: 80,
      protocol: ApplicationProtocol.HTTP,
    });

    const namespace = new PrivateDnsNamespace(this, 'test-namespace', {
      vpc,
      name: 'service.local',
    });

    const { service: backendFGService, privateDnsName: backendDnsName, port: backendPort } = this.createService(
      'backend-1',
      cluster,
      ContainerImage.fromAsset(resolve(__dirname, '..', '..', 'services', 'color-teller-backend')),
      namespace,
      {
        COLOR: 'red',
      }
    )

    const { service: clientFGService, port: appPort } = this.createService(
      'client-1',
      cluster,
      ContainerImage.fromAsset(resolve(__dirname, '..', '..', 'services', 'color-teller-client')),
      namespace,
      {
        COLOR_BACKEND: `http://${backendDnsName}:${backendPort}`,
        VERSION: 'vanilla'
      }
    )



    listener.addTargets('default', {
      port: appPort,
      protocol: ApplicationProtocol.HTTP,
      healthCheck: {
        protocol: ELBProtocol.HTTP,
        interval: Duration.seconds(10),
        port: `${appPort}`,
        path: '/health',
      },
      targets: [clientFGService],
    });

    backendFGService.connections.allowFrom(clientFGService, Port.tcp(3000));
  }

  private createService(
    id: string,
    cluster: Cluster,
    image: ContainerImage,
    namespace: PrivateDnsNamespace,
    envOverwrite: { [key: string]: string } = {},
  ): {
    service: FargateService,
    port: number,
    privateDnsName: string,
  } {
    const taskDef = new FargateTaskDefinition(this, `${id}-fargate-task-def`, {
      memoryLimitMiB: 1024,
    });
    const appPort = 3000;
    taskDef.addContainer(`${id}-app`, {
      image,
      logging: new AwsLogDriver({ streamPrefix: `${id}-app-` }),
      portMappings: [{ containerPort: appPort }],
      environment: {
        'PORT': `${appPort}`,
        ...envOverwrite
      }
    });
    const service = new FargateService(this, `${id}-service`, {
      cluster,
      assignPublicIp: true, // for public vpc
      minHealthyPercent: 0, // for zero downtime rolling deployment set desiredcount=2 and minHealty = 50
      desiredCount: 1,
      taskDefinition: taskDef,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      securityGroups: [new SecurityGroup(this, `${id}-default-sg`, {
        securityGroupName: `${id}-fargate-service`,
        vpc: cluster.vpc,
      })],
      // enables our service to be detectable by the id
      cloudMapOptions: {
        name: id,
        cloudMapNamespace: namespace,
        dnsTtl: Duration.seconds(10),
        dnsRecordType: DnsRecordType.A,
        containerPort: appPort,
      },
    });
    return {
      service,
      port: appPort,
      privateDnsName: `${id}.${namespace.namespaceName}`
    }
  }
}
