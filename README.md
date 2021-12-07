# aws-cdk-appmesh-example

code for the dev.to article: https://dev.to/jaecktec/aws-app-mesh-in-5-steps-1bmc


### note: 
if you want to skip reading and just want to see the finished code visit my [GitHub](https://github.com/jaecktec/aws-cdk-appmesh-example/tree/final)

##prerequisites:
- docker installed
- node and npm installed
- AWS account
- a few spare bucks (AWS is not for free)

##Introduction:
### what's fargate
I'm not copy-pasting the marketing description here. What is interesting in the end is how it affects your day-to-day job. 
The most important features are: 
- host your Docker images at ease
- utilize AWS cloud-native features 
- don't waste time in managing EC2 instances 
- quick deployment and advanced rollout features when using [aws-code-deploy](https://aws.amazon.com/de/codedeploy/)

### what does a service mesh for you:
A service mesh helps you with:
- service discovery (routing between Microservices), 
- streamlined logging and tracing between Microservices
- help with resilience by routing traffic away from failed instances (usually you'd implement this with a load balancer). 
- enables you to easily implement features like canary deployments and blue/green testing

### how does it do that?
These features are archived by deploying a managed proxy alongside your application which intercepts traffic from and to your application. The proxy takes care of fetching the mesh configuration, routing the requests, and registering your instance to the mesh. The deployment is often referred to as 'sidecar' since you have one proxy per service instance. 

### how is it supposed to work in amazon 
Amazon supports Service-Meshes by giving you access to a managed [envoy-proxy](https://www.envoyproxy.io/) hosting.  
What you need to do: 
- you deploy an envoy proxy as a side-car image next to your application container. 
- you utilize the fargate-proxy config and reroute traffic to the envoy-proxy
- you define virtual services/gateways/routes to stitch your mesh together  

### terminology in AWS
- **virtual node:** represents a compute instance like a fargate container
- **virtual service:** represents a logical group (1..n) of nodes
- **virtual route:** uses parameter (HTTP/GRPC) to route traffic to specific nodes/services
- **virtual gateway:** specifies an incoming or outgoing gateway from app-mesh

AWS Showcase: 
![Aws showcase](https://d1.awsstatic.com/diagrams/image%20(9).c86b0113dde0d2dbdc99a1ffad59805d86b5cb82.png)



### resources 
some great resources I used to build my service mesh are:
- [What's a service mesh?](https://www.redhat.com/en/topics/microservices/what-is-a-service-mesh)
- [AWS Cloud Containers Conference - Deep Dive on Configuring AWS App Mesh](https://youtu.be/qM4uf9l5lus)



## Step 1, preparation.
I've prepared two microservices with a small react app that polls two endpoints. 

![BFF Architecture](https://dev-to-uploads.s3.amazonaws.com/uploads/articles/y7tkxtb17402noiyvevz.png)

let's clone the GitHub repository
```
git clone git@github.com:jaecktec/aws-cdk-appmesh-example.git
cd aws-cdk-appmesh-example
```

Quick walkthrough:
### infrastructure folder
contains AWS CDK infrastructure such as: 
- fargate cluster, services and task-defs
- private DNS namespace
- ALB
used to host a small web app that accesses a non-exposed microservice through a gateway. 

### services
contains some microservices alongside Dockerfiles

### services/color-teller-backend
rudimentary expressjs service which returns the environment variable 'COLOR' on [GET]/color and 200 on [GET]/health

### services/color-teller-client
small react-app whith polls /gateway/color/color and /version and a expressjs services that exposes two endpoints, one /gateway/color/* which is a http-proxy to an endpoint defined in an env-variable called `COLOR_BACKEND` + a version endpoint which returns the env-variable called `VERSION`


### test your prerequisites
open the infrastructure folder:
```
cd infrastructure
```
and run 
```
npm i
npx cdk deploy
```
this might take a few seconds, once you're asked to confirm, confirm by entering `y` and hit enter.

once everything got deployed you should see an HTTP address, open this in the browser. If everything worked you should see a `Color Teller` showing `vanilla red`

![Sample image of deployed app](https://dev-to-uploads.s3.amazonaws.com/uploads/articles/eeaw8kt0evraloq6oslv.png)

to not hit conflicts, let's clean up:

```
npx cdk destroy
```

Feel free to browse through the code but please don't judge me on the microservices, they were hacked together in a local coffee shop (not ⭐️🪣, I'm not that wealthy)

### Step 1: create mesh
In our first step, we will create our `Mesh` and modify `createService` to accept and use the mesh. 

before the first `createService` call add
```
const mesh = new Mesh(this, 'mesh');
```
this will create an app-mesh for us

### Step 2: create a virtual node
now modify the signature of `createService` to accept a `Mesh` and return a `VirtualNode`:
```
// ...
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
// ...
```

now inside the `createService` function we can create our VirtualNode and return it

```
const bgNode = new VirtualNode(this, `${id}-virtual-node`, {
  mesh,
  virtualNodeName: `${id}-virtual-node`,
  accessLog: AccessLog.fromFilePath('/dev/stdout'),
  serviceDiscovery: ServiceDiscovery.cloudMap(service.cloudMapService!),
  listeners: [VirtualNodeListener.http({
    port: appPort,
    healthCheck: HealthCheck.http({
      path: 'health', // no forward slash, this makes them appear in x-ray later on... this took me 3 hours to figure out (╯°□°)╯︵ ┻━┻
    }),
  })],
});

return {
  service,
  port: appPort,
  privateDnsName: `${id}.${namespace.namespaceName}`,
  node: bgNode
}
```

### Step 3: attach an envoy-sidecar image
in addition we need to add a new containerDefinition for the envoy-proxy. AWS provides the envoi-proxy image under region-specific paths, however, I chose to use the global image.
A thing that is easy to miss: We need to add the managed policy `AWSAppMeshEnvoyAccess` to the taskRole

```
const virtualNodeName = `${id}-virtual-node`;
const envoyContainer = taskDef.addContainer('envoy', {
  image: ContainerImage.fromRegistry('public.ecr.aws/appmesh/aws-appmesh-envoy:v1.19.1.0-prod'),
  essential: true,
  environment: {
    'APPMESH_RESOURCE_ARN': `arn:aws:appmesh:${Aws.REGION}:${Aws.ACCOUNT_ID}:mesh/${mesh.meshName}/virtualNode/${virtualNodeName}`,
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
  user: '1337', // important later for the proxy config
  logging: new AwsLogDriver({
    streamPrefix: `${id}/envoy/`,
  }),
});
taskDef.taskRole.addManagedPolicy(
  ManagedPolicy.fromAwsManagedPolicyName('AWSAppMeshEnvoyAccess'),
);
envoyContainer.addUlimits({ name: UlimitName.NOFILE, hardLimit: 15000, softLimit: 15000 });
appContainer.addContainerDependencies({
  container: envoyContainer,
});
```

now we have our envoy-sidecar deployed. However, the traffic needs to be routed through the proxy so it can do its job. For that, we will add a `proxyConfiguration` to the `TaskDef`
```
proxyConfiguration: new AppMeshProxyConfiguration({
  containerName: 'envoy',
  properties: {
    ignoredUID: 1337, // user from envoy-container
    appPorts: [ appPort ],
    proxyIngressPort: 15000,
    proxyEgressPort: 15001,
    egressIgnoredIPs: [ '169.254.170.2', '169.254.169.254' ],
  },
}),
```

### Step 4: create virtual service
In this step, we will create our virtual service and add some routing. *we could not have the router however, it enables you easily modify it to tinker around with routing*

```
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
```

and call the method right after creating the `createService` invocation.
```
// [...]
const backendVService = this.createVirtualService('color-service', mesh, backendNode, namespace);
// [...]
```

now our service will be available (from a meshified node) under the DNS name `color-service.service.local`

next step we also need to update the environment variable in our gateway service so it knows where to find our color-backend:

```
COLOR_BACKEND: `http://${backendVService.virtualServiceName}:${backendPort}`,
```

and we need to tell the virtual node of the gateway service that we require to access the service
(you also need to name the node attribute from the creteService function)
```
// [...]
const { service: clientFGService, port: appPort, node: clientNode } = this.createService(
      'client-1',
// [...]
clientNode.addBackend(Backend.virtualService(backendVService));
// [...]
```

now let's deploy the stack and check our result:
```
npx cdk deploy
```

The routing will be taken care of by app-mesh. Theoretically, we're done however, the ALB still directly routs the traffic to one of the microservices, so technically it is exposed (and we don't get normalized metrics for it). 

### Step 5: create an ingress gateway
In this step, we will deploy an envoy-proxy as the ingress gateway. We just need to deploy envoy-proxy as the main container, expose the application port (8080) and configure it as a `VirtualGateway`

These are a lot of steps that are just a tutorial of deploying an app as a fargate-container. 
Important here is:
- taskRole needs managed policy `AWSAppMeshEnvoyAccess`
- app port is 8080 however, the health check port is 9901. That means, we need to explicitly allow communication on 9901 between ALB and the APP
- health url is /server_info (for ALB)

```
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

  const container = taskDef.addContainer('ingress-app', {
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
      APPMESH_VIRTUAL_NODE_NAME: `mesh/${mesh.meshName}/virtualGateway/${gateway.virtualGatewayName}`, // important, otherwhise envoiy can't fetch the config
      AWS_REGION: Aws.REGION,
    },
    memoryLimitMiB: 320, // limit examples from the official docs
    cpu: 208, // limit examples from the official docs
  });
  // limit examples from the official docs
  container.addUlimits({
    name: UlimitName.NOFILE,
    hardLimit: 1024000,
    softLimit: 1024000,
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
  // required so the service can fetch the documentation
  taskDef.taskRole.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AWSAppMeshEnvoyAccess'));

  return {gateway, fgService: service};
}
```

Lastly, we just need to remove the ALB ListenerTarget pointing to our clientService. The call of the function `createIngressService` will attach a ListenerTarget pointing to our gateway. 

for this we quickly create a virtual service for our clientService as well:

```
const clientVService = this.createVirtualService('client-service', mesh, clientNode, namespace);
```

create the ingress service with our previously created method:
```
const {gateway: virtualGateway, fgService: virtualGatewayFGService} = this.createIngressService(cluster, listener, mesh);
```

and point the VirtualGateway to it:
```
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
```

### Bonus - AWS-X-Ray:
using x-ray is very easy, we only need to deploy an x-ray sidecar image and enable envoy x-ray:

First, let's modify both `createService` and `createIngressService` to deploy the x-ray sidecar image and grant XRay policies to the taskRole
```
taskDef.addContainer(`${id}-xray`, {
  image: ContainerImage.fromRegistry('public.ecr.aws/xray/aws-xray-daemon:latest'),
  essential: false,
  memoryReservationMiB: 256,
  environment: {
    AWS_REGION: Aws.REGION,
  },
  user: '1337', // X-Ray traffic should not go through Envoy proxy
  logging: new AwsLogDriver({
    streamPrefix: id + '-xray-',
  }),
  portMappings: [ {
    containerPort: 2000,
    protocol: Protocol.UDP,
  } ],
});
```
and 
```
taskDef.addContainer(`ingress-xray`, {
  image: ContainerImage.fromRegistry('public.ecr.aws/xray/aws-xray-daemon:latest'),
  essential: false,
  memoryReservationMiB: 256,
  environment: {
    AWS_REGION: Aws.REGION,
  },
  user: '1337', // X-Ray traffic should not go through Envoy proxy
  logging: new AwsLogDriver({
    streamPrefix: 'ingress-xray-',
  }),
  portMappings: [ {
    containerPort: 2000,
    protocol: Protocol.UDP,
  } ],
});
taskDef.taskRole.addManagedPolicy(
  ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'),
);
```
(note: only that the id property got replaced by a constant)

now we need to enable x-ray on all the envoy containers by adding the env var `'ENABLE_ENVOY_XRAY_TRACING': '1'` to the envoy-sidecar image (right underneath `APPMESH_RESOURCE_ARN`) 


Finally, let's run
```
npx cdk deploy
```

Open the website and wait a minute. 
Now let's go to the [x-ray console](https://eu-west-1.console.aws.amazon.com/xray/home) and check the results:

![Alt Text](https://dev-to-uploads.s3.amazonaws.com/uploads/articles/pues3ztoa50bu4682xjh.png)

## What's next

Now that you have your mesh configured: What can you do with it?
### First:
You could deploy multiple instances (virtual nodes / fg services) and play around with the routing. 
For example, you can route by cookie or play around with the weights and see what happens. 

second: I intentionally put everything into one file, so it's easy to browse and to understand, but it screams for a refactoring :) 

third: 
if you want to access a 3rd party API you can also add monitoring for that by providing a virtual service. I haven't tested this, however [the docs mention it](https://aws.amazon.com/blogs/containers/service-connectivity-inside-and-outside-the-mesh-using-aws-app-mesh-ecs-fargate/). 
