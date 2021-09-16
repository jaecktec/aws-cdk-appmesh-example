import { AccessLog, Backend, GatewayRouteSpec, HealthCheck, HttpGatewayRoutePathMatch, Mesh, RouteSpec, ServiceDiscovery, VirtualGateway, VirtualGatewayListener, VirtualNode, VirtualNodeListener, VirtualRouter, VirtualRouterListener, VirtualService, VirtualServiceProvider } from '@aws-cdk/aws-appmesh';
import { Port, SecurityGroup, SubnetType, Vpc } from '@aws-cdk/aws-ec2';
import { AppMeshProxyConfiguration, AwsLogDriver, Cluster, ContainerImage, FargateService, FargateTaskDefinition, Protocol, UlimitName } from '@aws-cdk/aws-ecs';
import { ApplicationListener, ApplicationLoadBalancer, ApplicationProtocol, Protocol as ELBProtocol } from '@aws-cdk/aws-elasticloadbalancingv2';
import { ManagedPolicy } from '@aws-cdk/aws-iam';
import { DnsRecordType, NamespaceType, PrivateDnsNamespace, Service } from '@aws-cdk/aws-servicediscovery';
import { Aws, CfnOutput, Construct, Duration, Stack, StackProps } from '@aws-cdk/core';
import { resolve } from 'path';


export class InfrastructureStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // fargate clusterø
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


    const mesh = new Mesh(this, 'mesh', {
      meshName: 'sample-mesh',
    });

    const { service: backendFGService, port: backendPort, node: backendNode } = this.createService(
      'backend-1',
      cluster,
      ContainerImage.fromAsset(resolve(__dirname, '..', '..', 'services', 'color-teller-backend')),
      namespace,
      mesh,
      {
        COLOR: 'red',
      }
    );
    const backendVService = this.createVirtualService('color-service', mesh, backendNode, namespace);


    const { service: clientFGService, port: appPort, node: clientNode } = this.createService(
      'client-1',
      cluster,
      ContainerImage.fromAsset(resolve(__dirname, '..', '..', 'services', 'color-teller-client')),
      namespace,
      mesh,
      {
        COLOR_BACKEND: `http://${backendVService.virtualServiceName}:${backendPort}`,
        VERSION: 'vanilla'
      }
    );
    const clientVService = this.createVirtualService('client-service', mesh, clientNode, namespace);


    clientNode.addBackend(Backend.virtualService(backendVService));
    backendFGService.connections.allowFrom(clientFGService, Port.tcp(backendPort));

    const { gateway: virtualGateway, fgService: virtualGatewayFGService } = this.createIngressService(cluster, listener, mesh);


    const clientVRouter = new VirtualRouter(this, 'client-virtual-router', {
      mesh,
      listeners: [VirtualRouterListener.http(3000)],
    });

    clientVRouter.addRoute('default', {
      routeSpec: RouteSpec.http({
        weightedTargets: [{
          weight: 1,
          virtualNode: clientNode,
        }],
      }),
    });

    virtualGateway.addGatewayRoute('web-route', {
      routeSpec: GatewayRouteSpec.http({
        routeTarget: clientVService,
        match: {
          path: HttpGatewayRoutePathMatch.startsWith('/'),
        },
      }),
    });
    clientFGService.connections.allowFrom(virtualGatewayFGService, Port.tcp(appPort));

  }
  private createService(
    id: string,
    cluster: Cluster,
    image: ContainerImage,
    namespace: PrivateDnsNamespace,
    mesh: Mesh,
    envOverwrite: { [key: string]: string } = {},
  ): {
    service: FargateService,
    port: number,
    privateDnsName: string,
    node: VirtualNode,
  } {
    const appPort = 3000;
    const taskDef = new FargateTaskDefinition(this, `${id}-fargate-task-def`, {
      memoryLimitMiB: 1024,
      proxyConfiguration: new AppMeshProxyConfiguration({
        containerName: 'envoy',
        properties: {
          ignoredUID: 1337,
          appPorts: [appPort],
          proxyIngressPort: 15000,
          proxyEgressPort: 15001,
          egressIgnoredIPs: ['169.254.170.2', '169.254.169.254'],
        },
      }),
    });
    const appContainer = taskDef.addContainer('app', {
      image,
      logging: new AwsLogDriver({ streamPrefix: `${id}-app-` }),
      portMappings: [{ containerPort: appPort, hostPort: appPort }],
      environment: {
        'PORT': `${appPort}`,
        ...envOverwrite
      }
    });
    const virtualNodeName = `${id}-virtual-node`;
    const envoyContainer = taskDef.addContainer('envoy', {
      image: ContainerImage.fromRegistry('public.ecr.aws/appmesh/aws-appmesh-envoy:v1.19.1.0-prod'),
      essential: true,
      environment: {
        // https://docs.aws.amazon.com/app-mesh/latest/userguide/envoy-config.html
        APPMESH_RESOURCE_ARN: `arn:aws:appmesh:${Aws.REGION}:${Aws.ACCOUNT_ID}:mesh/${mesh.meshName}/virtualNode/${virtualNodeName}`,
        ENABLE_ENVOY_STATS_TAGS: '1',
        ENABLE_ENVOY_XRAY_TRACING: '1',
        'ENVOY_LOG_LEVEL': 'debug',
      },
      healthCheck: {
        command: [
          'CMD-SHELL',
          'curl -s http://localhost:9901/server_info | grep state | grep -q LIVE',
        ],
        interval: Duration.seconds(5),
        timeout: Duration.seconds(2),
        startPeriod: Duration.seconds(10),
        retries: 3,
      },
      user: '1337',
      logging: new AwsLogDriver({
        streamPrefix: `${id}-envoy-`,
      }),
    });

    envoyContainer.addUlimits({ name: UlimitName.NOFILE, hardLimit: 15000, softLimit: 15000 });
    appContainer.addContainerDependencies({
      container: envoyContainer,
    });

    taskDef.addContainer(`${id}-xray`, {
      image: ContainerImage.fromRegistry('public.ecr.aws/xray/aws-xray-daemon:latest'),
      memoryReservationMiB: 256,
      environment: {
        AWS_REGION: Aws.REGION,
      },
      user: '1337', // X-Ray traffic should not go through Envoy proxy
      logging: new AwsLogDriver({
        streamPrefix: id + '-xray-',
      }),
      portMappings: [{
        containerPort: 2000,
        protocol: Protocol.UDP,
      }],
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
      cloudMapOptions: {
        name: id,
        cloudMapNamespace: namespace,
        containerPort: appPort,
        dnsRecordType: DnsRecordType.SRV,
      },
    });

    const bgNode = new VirtualNode(this, `${id}-virtual-node`, {
      mesh,
      virtualNodeName: virtualNodeName,
      accessLog: AccessLog.fromFilePath('/dev/stdout'),
      serviceDiscovery: ServiceDiscovery.cloudMap(service.cloudMapService!),
      listeners: [VirtualNodeListener.http({
        port: appPort,
        connectionPool: {
          maxConnections: 1024,
          maxPendingRequests: 1024,
        },
        healthCheck: HealthCheck.http({
          path: 'health',
        }),
      })],
    });

    taskDef.taskRole.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'));
    taskDef.taskRole.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AWSAppMeshEnvoyAccess'));
    return {
      service,
      port: appPort,
      privateDnsName: `${id}.${namespace.namespaceName}`,
      node: bgNode
    }
  }


  private createVirtualService(
    serviceName: string,
    mesh: Mesh,
    backendNode: VirtualNode,
    namespace: PrivateDnsNamespace,
  ): VirtualService {
    const router = new VirtualRouter(this, `${serviceName}-virtual-router`, {
      mesh,
      listeners: [VirtualRouterListener.http(3000)],
    });

    router.addRoute('default', {
      routeSpec: RouteSpec.http({
        weightedTargets: [{
          weight: 1,
          virtualNode: backendNode,
        }],
      }),
    });

    const service = new VirtualService(this, serviceName, {
      virtualServiceProvider: VirtualServiceProvider.virtualRouter(router),
      virtualServiceName: `${serviceName}.${namespace.namespaceName}`,
    });
    // https://docs.aws.amazon.com/app-mesh/latest/userguide/troubleshoot-connectivity.html#ts-connectivity-dns-resolution-virtual-service
    new Service(this, `${serviceName}-dummy-service`, {
      namespace,
      name: serviceName,
      dnsRecordType: DnsRecordType.A,
      description: 'The dummy for App Mesh',
    }).registerIpInstance('dummy-instance', { ipv4: '10.10.10.10' });

    return service;
  }

  private createIngressService(
    cluster: Cluster,
    listener: ApplicationListener,
    mesh: Mesh,
  ): {
    gateway: VirtualGateway,
    fgService: FargateService,
  } {
    const port = 8080;
    const gateway = new VirtualGateway(this, 'virtual-gateway', {
      mesh,
      listeners: [VirtualGatewayListener.http({ port })],
    });

    const taskDef = new FargateTaskDefinition(this, 'ingress-fargate-task-def', {
      memoryLimitMiB: 512,
    });

    const container = taskDef.addContainer('app', {
      // most up-to-date envoy image at the point of writing the article
      image: ContainerImage.fromRegistry('public.ecr.aws/appmesh/aws-appmesh-envoy:v1.19.1.0-prod'),
      logging: new AwsLogDriver({ streamPrefix: 'ingress-app-' }),
      portMappings: [
        { containerPort: port },
        { containerPort: 9901 }, // for health check
      ],
      healthCheck: {
        // health check from Documentation
        command: ['CMD-SHELL', 'curl -s http://localhost:9901/server_info | grep state | grep -q LIVE || exit 1'],
        interval: Duration.seconds(5),
        timeout: Duration.seconds(2),
        startPeriod: Duration.seconds(10),
        retries: 3,
      },
      environment: {
        APPMESH_RESOURCE_ARN: `arn:aws:appmesh:${Aws.REGION}:${Aws.ACCOUNT_ID}:mesh/${mesh.meshName}/virtualGateway/${gateway.virtualGatewayName}`,
        AWS_REGION: Aws.REGION,
        // ENABLE_ENVOY_STATS_TAGS: '1',
        // ENABLE_ENVOY_XRAY_TRACING: '1',
      },
      user: '1337',
      memoryLimitMiB: 320, // limit examples from the official docs
      cpu: 208, // limit examples from the official docs
    });
    // limit examples from the official docs
    container.addUlimits({
      name: UlimitName.NOFILE,
      hardLimit: 1024000,
      softLimit: 1024000,
    });

    taskDef.addContainer(`ingress-xray`, {
      image: ContainerImage.fromRegistry('public.ecr.aws/xray/aws-xray-daemon:latest'),
      memoryReservationMiB: 256,
      user: '1337',
      environment: {
        AWS_REGION: Aws.REGION,
      },
      logging: new AwsLogDriver({
        streamPrefix: 'ingress-xray-',
      }),
      portMappings: [{
        containerPort: 2000,
        protocol: Protocol.UDP,
      }],
    });


    const service = new FargateService(this, 'ingress-service', {
      cluster,
      assignPublicIp: true, // for public vpc
      minHealthyPercent: 0, // for zero downtime rolling deployment set desiredcount=2 and minHealty = 50
      desiredCount: 1,
      taskDefinition: taskDef,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      securityGroups: [new SecurityGroup(this, 'ingress-default-sg', {
        securityGroupName: 'ingress-fargate-service',
        vpc: cluster.vpc,
      })],
    });
    listener.addTargets('ingress-gateway-target', {
      port,
      protocol: ApplicationProtocol.HTTP,
      healthCheck: {
        protocol: ELBProtocol.HTTP,
        interval: Duration.seconds(10),
        // health port from aws-envoy docs
        port: '9901',
        // health check path from aws-envoy docs
        path: '/server_info',
      },
      targets: [service],
      deregistrationDelay: Duration.seconds(0), // not needed, just speeds up the deployment for this example
    });

    // required so the ALB can reach the health-check endpoint
    service.connections.allowFrom(listener, Port.tcp(9901));
    taskDef.taskRole.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AWSAppMeshEnvoyAccess'));
    taskDef.taskRole.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'));
    taskDef.taskRole.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'));

    return { gateway, fgService: service };
  }
}
