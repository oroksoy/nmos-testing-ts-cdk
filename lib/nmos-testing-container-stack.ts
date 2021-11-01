
import { Vpc } from '@aws-cdk/aws-ec2';
import { Cluster } from '@aws-cdk/aws-ecs';
import { FileSystem } from '@aws-cdk/aws-efs';
import { PrivateDnsNamespace, Service } from '@aws-cdk/aws-servicediscovery';
import { NestedStack, NestedStackProps, Construct } from '@aws-cdk/core'
import { LogGroup } from '@aws-cdk/aws-logs';
import { Duration, RemovalPolicy } from '@aws-cdk/core';
import { FargateTaskDefinition, ContainerImage, LogDriver } from '@aws-cdk/aws-ecs'
import { ApplicationLoadBalancedFargateService } from '@aws-cdk/aws-ecs-patterns'
import { Repository } from '@aws-cdk/aws-ecr'
import { Policy, PolicyStatement } from '@aws-cdk/aws-iam'



interface ContainerProps extends NestedStackProps {
    vpc: Vpc,
    domain : string,
    hostedZoneNamespace: PrivateDnsNamespace
    cluster: Cluster,
    testEnvironment : {[key:string] : string},
    nmostestport: number
}

export class NmosTestingContainerStack extends NestedStack {

    constructor(scope: Construct, id: string, props: ContainerProps) {
        super(scope, id, props);

        const sidecarLogGroup = new LogGroup(this, 'sidecar-log-group', {
            removalPolicy: RemovalPolicy.DESTROY
        })

        const sidecarTaskDefinition = new FargateTaskDefinition(this, "sidecarTaskDefinition");

        const sidecarContainer = sidecarTaskDefinition.addContainer("sidecarContainer", {
            image: ContainerImage.fromEcrRepository(Repository.fromRepositoryName(this, "sidecarRepository", "sidecar-container")),
            environment: props.testEnvironment,
            portMappings: [{containerPort: 3000}],
            logging: LogDriver.awsLogs({
                streamPrefix: 'Sidecar',
                logGroup: sidecarLogGroup
            }),
        });

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
        sidecarTaskDefinition.addVolume(efsVolume);
    
        //Create the sidecar container that is going to write all the configuration files
        const sidecarContainerService = new ApplicationLoadBalancedFargateService(this, "sidecarService", {
            cluster: props.cluster,
            openListener : true,
            publicLoadBalancer : true,
            serviceName : "sidecar-service",
            taskDefinition: sidecarTaskDefinition,
        });
    
    
        //update the security group for the EFS volume to allow the Service to connect to the EFS volume
        fileSystem.connections.allowDefaultPortFrom(sidecarContainerService.service);
    
        //mount the Volume from the sidecar container in the sidecar container task definition
        sidecarContainer.addMountPoints({
            containerPath: "/nmosConfigs",
            readOnly: false,
            sourceVolume: efsVolume.name
            //sourceVolume: containerVolume.name
        });
        
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
        
        sidecarContainerService.service.taskDefinition.taskRole.attachInlinePolicy(accessPolicy);
    


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
        });
    
        const testingEFSVolume = {
            name: "testingVolume",
            efsVolumeConfiguration: {
            fileSystemId: fileSystem.fileSystemId,
            rootDirectory: '/nmos-testing'
            }
        }
        testingTaskDefinition.addVolume(testingEFSVolume);

        //Create the testing container that is going to write all the configuration files
        const testingFargateService = new ApplicationLoadBalancedFargateService(this, "testingService", {
            cluster: props.cluster,
            openListener : true,
            publicLoadBalancer : true,
            serviceName : "testing-service",
            taskDefinition: testingTaskDefinition
        });
    
        testingFargateService.node.addDependency(sidecarContainerService);

        //update the security group for the EFS volume to allow the Service to connect to the EFS volume
        fileSystem.connections.allowDefaultPortFrom(testingFargateService.service);

        //mount the Volume from the testing container in the testing container task definition
        testingContainer.addMountPoints({
        containerPath: "/config",
            readOnly: false,
            sourceVolume: testingEFSVolume.name
        });
        
        //Set the DNS SD settings for the nmos testing tool
        const testingDnsService = new Service(this, "nmos-testing", {
            name : "nmos-testing", 
            namespace : props.hostedZoneNamespace, 
            dnsTtl : Duration.seconds(10)
        })
    
        testingFargateService.service.associateCloudMapService({
            service : testingDnsService
        })


        ////////////////////////////Next Service
        //create the Easy NMOS Registry service
        const registryTaskDefinition = new FargateTaskDefinition(this, "registryDefinition");
        const registryContainer = registryTaskDefinition.addContainer("registryContainer", {
            image: ContainerImage.fromRegistry("registry.hub.docker.com/rhastie/nmos-cpp"),
            environment: props.testEnvironment,
            portMappings: [{containerPort: 8010}],
            logging: LogDriver.awsLogs({
                streamPrefix: 'Registry'
                ,logGroup: testingLogGroup
            }),
        })

        const registryEFSVolume = {
            name: "testingVolume",
            efsVolumeConfiguration: {
                fileSystemId: fileSystem.fileSystemId,
                rootDirectory: '/easy-nmos-registry'
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
            containerPath: "/home",
            readOnly: false,
            sourceVolume: registryEFSVolume.name
        });

        registryFargateService.node.addDependency(sidecarContainerService);

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
        //create the Virtual Node container from Easy NMOS
        let environment : {[key:string] : string} = {};
        environment["RUN_NODE"] = "TRUE";

        const virtualNodeFargateService = new ApplicationLoadBalancedFargateService(this, "nmosVirtualNodeFargateService", {
            cluster: props.cluster,
            openListener : true,
            publicLoadBalancer : true,
            serviceName : "nmos-virtnode",
            taskImageOptions: {
                image: ContainerImage.fromRegistry("registry.hub.docker.com/rhastie/nmos-cpp"),
                environment : environment,
                containerPort : 11000
            }
        });

        virtualNodeFargateService.node.addDependency(sidecarContainerService);


        //set the DNS SD settings for the virtual node
        const virtualNodeDnsService = new Service(this, "nmos-virtnode", {
            name : "nmos-virtnode", 
            namespace : props.hostedZoneNamespace, 
            dnsTtl : Duration.seconds(10)
        })

        virtualNodeFargateService.service.associateCloudMapService({
            service : virtualNodeDnsService
        })
*/  
    }  
}