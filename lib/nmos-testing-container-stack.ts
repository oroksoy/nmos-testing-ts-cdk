
import { Instance, InstanceType, InstanceClass, InstanceSize, Vpc, AmazonLinuxImage, AmazonLinuxGeneration, AmazonLinuxCpuType, SecurityGroup, Peer, Port, SubnetType, MultipartUserData} from '@aws-cdk/aws-ec2';
import { AsgCapacityProvider, Cluster, Ec2Service, Ec2TaskDefinition, EcsOptimizedImage, FargateService, NetworkMode } from '@aws-cdk/aws-ecs';
import { FileSystem } from '@aws-cdk/aws-efs';
import { PrivateDnsNamespace, Service } from '@aws-cdk/aws-servicediscovery';
import { NestedStack, NestedStackProps, Construct, Duration, RemovalPolicy } from '@aws-cdk/core'
import { LogGroup } from '@aws-cdk/aws-logs';
import { FargateTaskDefinition, ContainerImage, LogDriver, ContainerDependencyCondition } from '@aws-cdk/aws-ecs'
import { ApplicationLoadBalancedFargateService, ApplicationLoadBalancedServiceRecordType, ApplicationMultipleTargetGroupsFargateService } from '@aws-cdk/aws-ecs-patterns'
import { Repository } from '@aws-cdk/aws-ecr'
import { Policy, PolicyStatement } from '@aws-cdk/aws-iam'
import { ApplicationLoadBalancer, ListenerCondition } from '@aws-cdk/aws-elasticloadbalancingv2'



interface ContainerProps extends NestedStackProps {
    vpc: Vpc,
    domain : string,
    hostedZoneNamespace: PrivateDnsNamespace
    cluster: Cluster,
    environment : {[key:string] : string},
    sidecarport: number,
    nmostestport: number,
    nmosregistryport: number,
    nmosnodeport: number
}

export class NmosTestingContainerStack extends NestedStack {

    constructor(scope: Construct, id: string, props: ContainerProps) {
        super(scope, id, props);

        const sidecarLogGroup = new LogGroup(this, 'sidecar-log-group', {
            removalPolicy: RemovalPolicy.DESTROY
        })

        const testingLogGroup = new LogGroup(this, "nmos-test-log-group",{
            removalPolicy: RemovalPolicy.DESTROY
        })


        ///////////////AppConfig Access Policy setup
        //create the service first then find the default task role created for the service then modify the policy for that role
        // Create the access policy
        const accessStatement1 = new PolicyStatement({
            actions: [
                'appconfig:GetEnvironment', 
                'appconfig:GetHostedConfigurationVersion', 
                'appconfig:GetConfiguration', 
                'appconfig:GetApplication', 
                'appconfig:GetConfigurationProfile'
            ],
            resources: ["*"]
        });
    
        const accessPolicy = new Policy(this, "AccessPolicy", {
            statements: [accessStatement1]
        });

        //////////// Creating Testing service
        let testEnvironmentString = JSON.stringify(props.environment);
        let testEnvironment = JSON.parse(testEnvironmentString);
        testEnvironment["SIDECAR_ACTION"] = 'test-config';


        const testingTaskDefinition = new FargateTaskDefinition(this, "testingTaskDefinition");
        
        const testingContainer = testingTaskDefinition.addContainer("testingContainer", {
            image: ContainerImage.fromRegistry("registry.hub.docker.com/amwa/nmos-testing"),
            environment: testEnvironment,
            portMappings: [{containerPort: props.nmostestport}],
            logging: LogDriver.awsLogs({
                streamPrefix: 'Testing'
                ,logGroup: testingLogGroup
            }),
            //healthCheck: {command: [ "CMD-SHELL", `curl -f http://localhost:${props.nmosnodeport}/ || exit 1` ]}
        });

        const sidecarContainer = testingTaskDefinition.addContainer("sidecarContainer", {
            //image: ContainerImage.fromEcrRepository(Repository.fromRepositoryName(this, "sidecarRepository", "sidecar-container")),
            image: ContainerImage.fromRegistry("registry.hub.docker.com/oroksoy/nmos-sidecar"),
            environment: testEnvironment,
            portMappings: [{containerPort: props.sidecarport}],
            logging: LogDriver.awsLogs({
                streamPrefix: 'Testing-Sidecar',
                logGroup: sidecarLogGroup
            }),
            healthCheck: {command: [ "CMD-SHELL", `curl -f http://localhost:${props.sidecarport}/ || exit 1` ]}
        });

        testingContainer.addContainerDependencies({
            container: sidecarContainer, 
            condition: ContainerDependencyCondition.HEALTHY
        })

        const hostVolume = {
            name: "hostVolume",
            host: {}
        }
        testingTaskDefinition.addVolume(hostVolume);

        //mount the Volume from the sidecar container in the sidecar container task definition
        sidecarContainer.addMountPoints({
            containerPath: "/config",
            readOnly: false,
            sourceVolume: hostVolume.name
        });

        testingContainer.addVolumesFrom({
            readOnly: true, 
            sourceContainer: sidecarContainer.containerName
        })

        testingContainer.addMountPoints({
            containerPath: "/config",
                readOnly: false,
                sourceVolume: hostVolume.name
        });

        const testingService = new FargateService(this, "testingService",{
            cluster: props.cluster,
            taskDefinition: testingTaskDefinition,
            desiredCount: 1,
            serviceName: "testing-service"
        })

        const loadBalancer = new ApplicationLoadBalancer(this, "testingLoadBalancer",{
            vpc: props.vpc,
            internetFacing:true,
        })
        const listener = loadBalancer.addListener('testingListener', {
            port: 80
        })
        const targetGroup1 = listener.addTargets("testingTarget",{
            port: 80,
            targets: [testingService.loadBalancerTarget({
                containerName: 'testingContainer',
                containerPort: props.nmostestport
            })]
        })
        const targetGroup2 = listener.addTargets("sidecarTarget", {
            port: 80,
            conditions: [ListenerCondition.pathPatterns(['/sidecar/*'])],
            priority: 100,
            targets: [testingService.loadBalancerTarget({
                containerName: 'sidecarContainer',
                containerPort: props.sidecarport
            })]
        })
        testingService.taskDefinition.taskRole.attachInlinePolicy(accessPolicy);
    
        //update the security group for the EFS volume to allow the Service to connect to the EFS volume
        //fileSystem.connections.allowDefaultPortFrom(testingFargateService.service);
        
        //Set the DNS SD settings for the nmos testing tool
        const testingDnsService = new Service(this, "nmos-testing", {
            name : "nmos-testing", 
            namespace : props.hostedZoneNamespace, 
            dnsTtl : Duration.seconds(10)
        })
    
        testingService.associateCloudMapService({
            service: testingDnsService
        })

        ////////////////////////////Registry Service
        //create the Easy NMOS Registry service
        let registryEnvironmentString = JSON.stringify(props.environment);
        let registryEnvironment = JSON.parse(registryEnvironmentString);
        registryEnvironment["SIDECAR_ACTION"] = 'registry-config';

        const registryTaskDefinition = new Ec2TaskDefinition(this, "registryDefinition", {
            networkMode: NetworkMode.AWS_VPC
        });
        const registryContainer = registryTaskDefinition.addContainer("registryContainer", {
            image: ContainerImage.fromRegistry("registry.hub.docker.com/rhastie/nmos-cpp"),
            environment: registryEnvironment,
            portMappings: [{containerPort: props.nmosregistryport}],
            logging: LogDriver.awsLogs({
                streamPrefix: 'Registry'
                ,logGroup: testingLogGroup
            }),
            memoryReservationMiB: 256
        })

        const registrySidecarContainer = registryTaskDefinition.addContainer("registrySidecarContainer", {
            //image: ContainerImage.fromEcrRepository(Repository.fromRepositoryName(this, "sidecarRepository2", "sidecar-container")),
            image: ContainerImage.fromRegistry("registry.hub.docker.com/oroksoy/nmos-sidecar"),
            environment: registryEnvironment,
            portMappings: [{containerPort: props.sidecarport}],
            logging: LogDriver.awsLogs({
                streamPrefix: 'Regisry-Sidecar',
                logGroup: sidecarLogGroup
            }),
            memoryReservationMiB: 256,
            healthCheck: {command: [ "CMD-SHELL", `curl -f http://localhost:${props.sidecarport}/ || exit 1` ]}
        });

        registryContainer.addContainerDependencies({
            container: registrySidecarContainer, 
            condition: ContainerDependencyCondition.HEALTHY
        })

        //mount the Volume from the sidecar container in the sidecar container task definition
        const registrySidecarHostVolume = {
            name: "registrySidecarHostVolume",
            host: {sourcePath: '/easyregistry'}
        }
        registryTaskDefinition.addVolume(registrySidecarHostVolume);

        registrySidecarContainer.addMountPoints({
            containerPath: "/easyregistry",
            readOnly: false,
            sourceVolume: registrySidecarHostVolume.name
        });

        const registryHostVolume = {
            name: "registryHostVolume",
            host: {sourcePath: "/easyregistry/registry.json"}
        }
        registryTaskDefinition.addVolume(registryHostVolume);

        registryContainer.addMountPoints({
            containerPath: "/home/registry.json",
                readOnly: false,
                sourceVolume: registryHostVolume.name
        });

        const registryService = new Ec2Service(this, "registryService",{
            cluster: props.cluster,
            taskDefinition: registryTaskDefinition,
            desiredCount: 1,
            serviceName: "registry-service"
        })

        const registryLoadBalancer = new ApplicationLoadBalancer(this, "registryLoadBalancer",{
            vpc: props.vpc,
            internetFacing:true,
        })
        const registryListener = registryLoadBalancer.addListener('registryListener', {
            port: 80
        })
        const registryTargetGroup1 = registryListener.addTargets("registryTarget",{
            port: 80,
            targets: [registryService.loadBalancerTarget({
                containerName: 'registryContainer',
                containerPort: props.nmosregistryport
            })]
        })
        const registryTargetGroup2 = registryListener.addTargets("registrySidecarTarget", {
            port: 80,
            conditions: [ListenerCondition.pathPatterns(['/sidecar/*'])],
            priority: 100,
            targets: [registryService.loadBalancerTarget({
                containerName: 'registrySidecarContainer',
                containerPort: props.sidecarport
            })]
        })
        registryService.taskDefinition.taskRole.attachInlinePolicy(accessPolicy);

        //set the DNS SD settings for the registry service
        const registryDnsService = new Service(this, "nmos-registry", {
            name : "nmos-registry", 
            namespace : props.hostedZoneNamespace, 
            dnsTtl : Duration.seconds(10)
        });

        registryService.associateCloudMapService({
            service : registryDnsService
        })


        ////////////Virtual Node Service
        //create the Virtual Node container from Easy NMOS
        let nodeEnvironmentString = JSON.stringify(props.environment);
        let nodeEnvironment = JSON.parse(nodeEnvironmentString);
        nodeEnvironment["SIDECAR_ACTION"] = 'node-config';
        nodeEnvironment["RUN_NODE"] = "TRUE";

        const nodeTaskDefinition = new Ec2TaskDefinition(this, "nodeDefinition", {
            networkMode: NetworkMode.AWS_VPC
        });
        const nodeContainer = nodeTaskDefinition.addContainer("nodeContainer", {
            image: ContainerImage.fromRegistry("registry.hub.docker.com/rhastie/nmos-cpp"),
            environment: nodeEnvironment,
            portMappings: [{containerPort: props.nmosnodeport}],
            logging: LogDriver.awsLogs({
                streamPrefix: 'Node'
                ,logGroup: testingLogGroup
            }),
            memoryReservationMiB: 256
        })

        const nodeSidecarContainer = nodeTaskDefinition.addContainer("nodeSidecarContainer", {
            //image: ContainerImage.fromEcrRepository(Repository.fromRepositoryName(this, "sidecarRepository3", "sidecar-container")),
            image: ContainerImage.fromRegistry("registry.hub.docker.com/oroksoy/nmos-sidecar"),
            environment: nodeEnvironment,
            portMappings: [{containerPort: props.sidecarport}],
            logging: LogDriver.awsLogs({
                streamPrefix: 'Regisry-Sidecar',
                logGroup: sidecarLogGroup
            }),
            memoryReservationMiB: 256,
            healthCheck: {command: [ "CMD-SHELL", `curl -f http://localhost:${props.sidecarport}/ || exit 1` ]}
        });

        nodeContainer.addContainerDependencies({
            container: nodeSidecarContainer, 
            condition: ContainerDependencyCondition.HEALTHY
        })

        //mount the Volume from the sidecar container in the sidecar container task definition
        const nodeSidecarHostVolume = {
            name: "nodeSidecarHostVolume",
            host: {sourcePath: '/easynode'}
        }
        nodeTaskDefinition.addVolume(nodeSidecarHostVolume);

        nodeSidecarContainer.addMountPoints({
            containerPath: "/easynode",
            readOnly: false,
            sourceVolume: nodeSidecarHostVolume.name
        });

        const nodeHostVolume = {
            name: "nodeHostVolume",
            host: {sourcePath: "/easynode/node.json"}
        }
        nodeTaskDefinition.addVolume(nodeHostVolume);

        nodeContainer.addMountPoints({
            containerPath: "/home/node.json",
                readOnly: false,
                sourceVolume: nodeHostVolume.name
        });

        const nodeService = new Ec2Service(this, "nodeService",{
            cluster: props.cluster,
            taskDefinition: nodeTaskDefinition,
            desiredCount: 1,
            serviceName: "node-service"
        })

        const nodeLoadBalancer = new ApplicationLoadBalancer(this, "nodeLoadBalancer",{
            vpc: props.vpc,
            internetFacing:true,
        })
        const nodeListener = nodeLoadBalancer.addListener('nodeListener', {
            port: 80
        })
        const nodeTargetGroup1 = nodeListener.addTargets("nodeTarget",{
            port: 80,
            targets: [nodeService.loadBalancerTarget({
                containerName: 'nodeContainer',
                containerPort: props.nmosnodeport
            })]
        })
        const nodeTargetGroup2 = nodeListener.addTargets("nodeSidecarTarget", {
            port: 80,
            conditions: [ListenerCondition.pathPatterns(['/sidecar/*'])],
            priority: 100,
            targets: [nodeService.loadBalancerTarget({
                containerName: 'nodeSidecarContainer',
                containerPort: props.sidecarport
            })]
        })
        nodeService.taskDefinition.taskRole.attachInlinePolicy(accessPolicy);

        //set the DNS SD settings for the node service
        const nodeDnsService = new Service(this, "nmos-virtnode", {
            name : "nmos-virtnode", 
            namespace : props.hostedZoneNamespace, 
            dnsTtl : Duration.seconds(10)
        });

        nodeService.associateCloudMapService({
            service : nodeDnsService
        })

/////////////Graveyard of code
        /*
        ///////////////////////////Test Instance setup
        const fileSystem = new FileSystem(this, 'config-filesystem',{
            vpc: props.vpc,
            removalPolicy: RemovalPolicy.DESTROY
          });
    
        const efsVolume = {
            name: "sidecarVolume",
            efsVolumeConfiguration: {
                fileSystemId: fileSystem.fileSystemId,
            }
        }

        const ami = new AmazonLinuxImage({
            generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
            cpuType: AmazonLinuxCpuType.ARM_64
          });


        const mySecurityGroup = new SecurityGroup(this, 'SecurityGroup', {
            vpc: props.vpc,
            description: 'Allow ssh access to ec2 instances',
            allowAllOutbound: true   // Can be set to false
          });
        mySecurityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(22), 'allow ssh access from the world');


        let mountPoint = '/mnt/efs/fs';
        
        const userDataScript = `
#!/bin/bash

sudo su
yum install -y amazon-efs-utils
yum install -y nfs-utils
file_system_id=${fileSystem.fileSystemId}
efs_mount_point=${mountPoint}
sudo mkdir -p $efs_mount_point
test -f /sbin/mount.efs && echo ${fileSystem.fileSystemId}:/ ${mountPoint} efs defaults,_netdev >> /etc/fstab || echo ${fileSystem.fileSystemId}.efs.us-east-2.amazonaws.com:/ ${mountPoint} nfs4 nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,noresvport,_netdev 0 0 >> /etc/fstab
mount -a -t efs,nfs4 defaults
`     

        const instance = new Instance(this, 'test-instance', {
            vpc: props.vpc,
            instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MICRO),
            machineImage: ami,
            securityGroup: mySecurityGroup,
            vpcSubnets: {subnetType: SubnetType.PUBLIC},
            keyName: 'nmos-keypair'
        })

        fileSystem.connections.allowDefaultPortFrom(instance);
        instance.addUserData(userDataScript)

                //mount the Volume from the testing container in the testing container task definition
        /*    
        const testingEFSVolume = {
            name: "testingVolume",
            efsVolumeConfiguration: {
            fileSystemId: fileSystem.fileSystemId,
            rootDirectory: '/nmos-testing'
            }
        }
        testingTaskDefinition.addVolume(testingEFSVolume);
    
        const testingEFSVolume = {
            name: "testingVolume",
            efsVolumeConfiguration: {
            fileSystemId: fileSystem.fileSystemId,
            rootDirectory: '/nmos-testing'
            }
        }
        testingTaskDefinition.addVolume(testingEFSVolume);
*/
    }  
}