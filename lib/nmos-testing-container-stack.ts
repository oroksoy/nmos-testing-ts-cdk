
import { Instance, InstanceType, InstanceClass, InstanceSize, Vpc, AmazonLinuxImage, AmazonLinuxGeneration, AmazonLinuxCpuType, SecurityGroup, Peer, Port, SubnetType, MultipartUserData} from '@aws-cdk/aws-ec2';
import { Cluster, FargateService } from '@aws-cdk/aws-ecs';
import { FileSystem } from '@aws-cdk/aws-efs';
import { PrivateDnsNamespace, Service } from '@aws-cdk/aws-servicediscovery';
import { NestedStack, NestedStackProps, Construct, Duration, RemovalPolicy } from '@aws-cdk/core'
import { LogGroup } from '@aws-cdk/aws-logs';
import { FargateTaskDefinition, ContainerImage, LogDriver, ContainerDependency, ContainerDependencyCondition, Host } from '@aws-cdk/aws-ecs'
import { ApplicationLoadBalancedFargateService, ApplicationLoadBalancedServiceRecordType, ApplicationMultipleTargetGroupsFargateService } from '@aws-cdk/aws-ecs-patterns'
import { Repository } from '@aws-cdk/aws-ecr'
import { Policy, PolicyStatement } from '@aws-cdk/aws-iam'
import { ApplicationLoadBalancer, ListenerCondition } from '@aws-cdk/aws-elasticloadbalancingv2'



interface ContainerProps extends NestedStackProps {
    vpc: Vpc,
    domain : string,
    hostedZoneNamespace: PrivateDnsNamespace
    cluster: Cluster,
    testEnvironment : {[key:string] : string},
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

        ///////////////////////////Test Instance setup
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



        //////////// Creating Testing service        
        const testingLogGroup = new LogGroup(this, "nmos-test-log-group",{
            removalPolicy: RemovalPolicy.DESTROY
        })

        const testingTaskDefinition = new FargateTaskDefinition(this, "testingTaskDefinition");
        
        const testingContainer = testingTaskDefinition.addContainer("testingContainer", {
            image: ContainerImage.fromRegistry("registry.hub.docker.com/amwa/nmos-testing"),
            environment: props.testEnvironment,
            portMappings: [{containerPort: props.nmostestport}],
            logging: LogDriver.awsLogs({
                streamPrefix: 'Testing'
                ,logGroup: testingLogGroup
            }),
            //healthCheck: {command: [ "CMD-SHELL", `curl -f http://localhost:${props.nmosnodeport}/ || exit 1` ]}
        });

        const sidecarContainer = testingTaskDefinition.addContainer("sidecarContainer", {
            image: ContainerImage.fromEcrRepository(Repository.fromRepositoryName(this, "sidecarRepository", "sidecar-container")),
            environment: props.testEnvironment,
            portMappings: [{containerPort: props.sidecarport}],
            logging: LogDriver.awsLogs({
                streamPrefix: 'Sidecar',
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
*/
        testingContainer.addVolumesFrom({
            readOnly: true, 
            sourceContainer: sidecarContainer.containerName
        })

        testingContainer.addMountPoints({
            containerPath: "/config",
                readOnly: false,
                sourceVolume: hostVolume.name
        });
/*    
        const testingEFSVolume = {
            name: "testingVolume",
            efsVolumeConfiguration: {
            fileSystemId: fileSystem.fileSystemId,
            rootDirectory: '/nmos-testing'
            }
        }
        testingTaskDefinition.addVolume(testingEFSVolume);
*/


        const testingService = new FargateService(this, "testingService2",{
            cluster: props.cluster,
            taskDefinition: testingTaskDefinition,
            desiredCount: 1,
            serviceName: "testing-service-2"
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
    
        //testingFargateService.service.taskDefinition.taskRole.attachInlinePolicy(accessPolicy);

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


/*
        ////////////////////////////Registry Service
        //create the Easy NMOS Registry service
        const registryTaskDefinition = new FargateTaskDefinition(this, "registryDefinition");
        const registryContainer = registryTaskDefinition.addContainer("registryContainer", {
            image: ContainerImage.fromRegistry("registry.hub.docker.com/rhastie/nmos-cpp"),
            environment: props.testEnvironment,
            portMappings: [{containerPort: props.nmosregistryport}],
            logging: LogDriver.awsLogs({
                streamPrefix: 'Registry'
                ,logGroup: testingLogGroup
            }),
        })

        const registryEFSVolume = {
            name: "registryVolume",
            efsVolumeConfiguration: {
                fileSystemId: fileSystem.fileSystemId,
                rootDirectory: '/easy-nmos-registry/config.json'
            }
        }
        registryTaskDefinition.addVolume(registryEFSVolume);

        const registryFargateService = new ApplicationLoadBalancedFargateService(this, "nmosRegistryFargateService", {
            cluster: props.cluster,
            openListener : true,
            //assignPublicIp : true,
            publicLoadBalancer : true,
            serviceName : "nmos-registry",
            taskDefinition: registryTaskDefinition
        });

        fileSystem.connections.allowDefaultPortFrom(registryFargateService.service);

        registryContainer.addMountPoints({
            containerPath: "/home/registry.json",
            readOnly: false,
            sourceVolume: registryEFSVolume.name
        });

        //registryFargateService.node.addDependency(sidecarContainerService);

        //set the DNS SD settings for the registry service
        const registryDnsService = new Service(this, "nmos-registry", {
            name : "nmos-registry", 
            namespace : props.hostedZoneNamespace, 
            dnsTtl : Duration.seconds(10)
        });

        registryFargateService.service.associateCloudMapService({
            service : registryDnsService
        })

/*
        ////////////Virtual Node Service
        //create the Virtual Node container from Easy NMOS
        let environment : {[key:string] : string} = {};
        environment["RUN_NODE"] = "TRUE";

        const nodeTaskDefinition = new FargateTaskDefinition(this, "nodeDefinition");
        const nodeContainer = nodeTaskDefinition.addContainer("nodeContainer", {
            image: ContainerImage.fromRegistry("registry.hub.docker.com/rhastie/nmos-cpp"),
            environment: props.testEnvironment,
            portMappings: [{containerPort: props.nmosnodeport}],
            logging: LogDriver.awsLogs({
                streamPrefix: 'Node'
                ,logGroup: testingLogGroup
            }),
        })

        const nodeEFSVolume = {
            name: "nodeVolume",
            efsVolumeConfiguration: {
                fileSystemId: fileSystem.fileSystemId,
                rootDirectory: '/easy-nmos-node/config.json'
            }
        }

        nodeTaskDefinition.addVolume(nodeEFSVolume);

        const nodeFargateService = new ApplicationLoadBalancedFargateService(this, "nmosVirtualNodeFargateService", {
            cluster: props.cluster,
            openListener : true,
            publicLoadBalancer : true,
            serviceName : "nmos-virtnode",
            taskDefinition: nodeTaskDefinition
        });

        fileSystem.connections.allowDefaultPortFrom(nodeFargateService.service);

        nodeContainer.addMountPoints({
            containerPath: "/home/config.json",
            readOnly: false,
            sourceVolume: nodeEFSVolume.name
        });

        nodeFargateService.node.addDependency(sidecarContainerService);

        //set the DNS SD settings for the virtual node
        const virtualNodeDnsService = new Service(this, "nmos-virtnode", {
            name : "nmos-virtnode", 
            namespace : props.hostedZoneNamespace, 
            dnsTtl : Duration.seconds(10)
        })

        nodeFargateService.service.associateCloudMapService({
            service : virtualNodeDnsService
        })

 */       

    }  
}