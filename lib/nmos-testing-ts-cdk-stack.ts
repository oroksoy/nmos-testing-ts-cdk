

import cdk = require ('@aws-cdk/core')
import { Vpc } from '@aws-cdk/aws-ec2';
import { Cluster, FargateTaskDefinition, LogDriver, TaskDefinition } from '@aws-cdk/aws-ecs';
import { ContainerImage } from '@aws-cdk/aws-ecs';
import { ApplicationLoadBalancedFargateService } from '@aws-cdk/aws-ecs-patterns';
import { PrivateDnsNamespace} from '@aws-cdk/aws-servicediscovery';
import { Service } from '@aws-cdk/aws-servicediscovery';
import { Duration, RemovalPolicy } from '@aws-cdk/core';
import { FileSystem } from '@aws-cdk/aws-efs'
import { Repository } from '@aws-cdk/aws-ecr';
import { CfnApplication, CfnConfigurationProfile, CfnDeployment, CfnDeploymentStrategy, CfnEnvironment, CfnHostedConfigurationVersion } from '@aws-cdk/aws-appconfig';
import { Policy, PolicyStatement } from '@aws-cdk/aws-iam';
import { LogGroup } from '@aws-cdk/aws-logs';


export class NmosTestingTsCdkStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here

    const vpc = new Vpc(this, "nmos-test-vpc", {maxAzs: 2});
	
	  const cluster = new Cluster(this, 'nmos-test-cluster',{vpc});

    //Crete the configuration variables to use in the container configuration files
    let domain = "local";
    let nmostestport = 4000;
	  const hostedZoneNamespace = new PrivateDnsNamespace(this, 'nmos-test-namespace', {
      vpc: vpc, 
      name : domain 
    });

    //Create the environment variables for the sidecar service to find AppConfig Configuration
    let appName: string = "nmos-test";
    let appEnv: string = 'prod';
    let appConfig: string = "nmos-test-user-config";
    let appClientID: string = "1";

    let testEnvironment : {[key:string] : string} = {};
    testEnvironment["NMOS_TEST_APPLICATION"] = appName;
    testEnvironment["NMOS_TEST_ENV"] = appEnv;
    testEnvironment["NMOS_TEST_CONFIG"] = appConfig;
    testEnvironment["NMOS_TEST_CLIENT_ID"] = appClientID;
    testEnvironment["PYTHONUNBUFFERED"] = '1';

    //Create the AppConfig configuration 
    const appConfigApp = new CfnApplication(this, 'nmos-test-appconfig', {
      name: appName
    });

    const appConfigEnv = new CfnEnvironment(this, 'nmos-test-prod', {
      applicationId: appConfigApp.ref, 
      name:appEnv
    });

    const appConfigProfile = new CfnConfigurationProfile(this, 'nmos-test-config-profile', {
      applicationId: appConfigApp.ref, 
      name:appConfig, 
      locationUri:'hosted'
    });

    const appconfigProfileVersion = new CfnHostedConfigurationVersion (this, 'nmos-test-config-profile-version',{
      applicationId: appConfigApp.ref,
      configurationProfileId: appConfigProfile.ref,
      contentType: 'text/plain',
      content: `
from . import Config as CONFIG

# Domain name to use for the local DNS server and mock Node
# This must match the domain name used for certificates in HTTPS mode
CONFIG.DNS_DOMAIN = "${domain}"

# The testing tool uses multiple ports to run mock services. This sets the lowest of these, which also runs the GUI
# Note that changing this from the default of 5000 also requires changes to supporting files such as
# test_data/BCP00301/ca/intermediate/openssl.cnf and any generated certificates.
# The mock DNS server port cannot be modified from the default of 53.
CONFIG.PORT_BASE = ${nmostestport}` 
    })

    const appConfigDeploymetStrategy = new CfnDeploymentStrategy(this, 'nmos-test-appconfig-deployment-strategy',{
      deploymentDurationInMinutes: 0,
      growthFactor:100,
      name:'Custom.AllAtOnce',
      replicateTo:'NONE'
    })

    const appConfigDeployment = new CfnDeployment(this, 'nmos-test-appconfig-deployment',{
      applicationId: appConfigApp.ref,
      environmentId: appConfigEnv.ref,
      configurationProfileId: appConfigProfile.ref,
      configurationVersion: '1',
      deploymentStrategyId: appConfigDeploymetStrategy.ref
    })


    //Create the sidecar container Task Definition for the sidecar service
    const sidecarLogGroup = new LogGroup(this, 'sidecar-log-group', {
      removalPolicy: RemovalPolicy.DESTROY
    })
    
    const containerVolume = {
      name: 'containerVolume'
    }
    const sidecarTaskDefinition = new FargateTaskDefinition(this, "sidecarTaskDefinition", {
      volumes: [containerVolume]
    });
    const sidecarContainer = sidecarTaskDefinition.addContainer("sidecarContainer", {
      image: ContainerImage.fromEcrRepository(Repository.fromRepositoryName(this, "sidecarRepository", "sidecar-container")),
      environment: testEnvironment,
      portMappings: [{containerPort: 3000}],
      logging: LogDriver.awsLogs({
        streamPrefix: 'Sidecar'
        ,logGroup: sidecarLogGroup
      }),
    });
    
    const fileSystem = new FileSystem(this, 'config-filesystem',{
      vpc: vpc,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const efsVolume = {
      name: "sidecarVolume",
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
      }
    }
    //sidecarTaskDefinition.addVolume(containerVolume);
    sidecarTaskDefinition.addVolume(efsVolume);

    //Create the sidecar container that is going to write all the configuration files
    const sidecarContainerService = new ApplicationLoadBalancedFargateService(this, "sidecarService", {
      cluster,
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

    //Create the service running the NMOS Testing tool
    const testingLogGroup = new LogGroup(this, "nmos-test-log-group",{
      removalPolicy: RemovalPolicy.DESTROY
    })
   
    const testingTaskDefinition = new FargateTaskDefinition(this, "testingTaskDefinition");
    const testingContainer = testingTaskDefinition.addContainer("testingContainer", {
      image: ContainerImage.fromRegistry("registry.hub.docker.com/amwa/nmos-testing"),
      environment: testEnvironment,
      portMappings: [{containerPort: nmostestport}],
      logging: LogDriver.awsLogs({
        streamPrefix: 'Testing'
        ,logGroup: testingLogGroup
      })
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
      cluster,
      openListener : true,
      //assignPublicIp : true,
      publicLoadBalancer : true,
      serviceName : "testing-service",
      taskDefinition: testingTaskDefinition,
    });

    //update the security group for the EFS volume to allow the Service to connect to the EFS volume
    fileSystem.connections.allowDefaultPortFrom(testingFargateService.service);

    //mount the Volume from the testing container in the testing container task definition
    testingContainer.addMountPoints({
      containerPath: "/config",
      readOnly: false,
      sourceVolume: testingEFSVolume.name
    });

/*
    const testingFargateService = new ApplicationLoadBalancedFargateService(this, "nmosTestingFargateService", {
      cluster,
      openListener : true,
      assignPublicIp: true,
      publicLoadBalancer : true,
      serviceName : "nmos-testing",
      taskImageOptions: {
        image: ContainerImage.fromRegistry("registry.hub.docker.com/amwa/nmos-testing"),
        //image: ContainerImage.fromEcrRepository(Repository.fromRepositoryName(this, "nmos-testing-repository", "nmos-testing")),
        environment: testEnvironment,
        containerPort : nmostestport,
        logDriver: LogDriver.awsLogs({
          streamPrefix: 'nmos-test'
          ,logGroup: testingLogGroup
        })
      }
    });
    */

    
    //Set the DNS SD settings for the nmos testing tool
    const testingDnsService = new Service(this, "nmos-testing", {
      name : "nmos-testing", 
      namespace : hostedZoneNamespace, 
      dnsTtl : Duration.seconds(10)
    })

    testingFargateService.service.associateCloudMapService({
      service : testingDnsService
    })


/*
    //create the Easy NMOS Registry service
    const registryFargateService = new ApplicationLoadBalancedFargateService(this, "nmosRegistryFargateService", {
      cluster,
      openListener : true,
      publicLoadBalancer : true,
      serviceName : "nmos-registry",
      taskImageOptions: {
        image: ContainerImage.fromRegistry("registry.hub.docker.com/rhastie/nmos-cpp"),
        containerPort : 8010
      }
    });

    //set the DNS SD settings for the registry service
    const registryDnsService = new Service(this, "nmos-registry", {
      name : "nmos-registry", 
      namespace : hostedZoneNamespace, 
      dnsTtl : Duration.seconds(10)
    })

    registryFargateService.service.associateCloudMapService({
      service : registryDnsService
    })

    //create the Virtual Node container from Easy NMOS
    let environment : {[key:string] : string} = {};
    environment["RUN_NODE"] = "TRUE";

    const virtualNodeFargateService = new ApplicationLoadBalancedFargateService(this, "nmosVirtualNodeFargateService", {
      cluster,
      openListener : true,
      publicLoadBalancer : true,
      serviceName : "nmos-virtnode",
      taskImageOptions: {
        image: ContainerImage.fromRegistry("registry.hub.docker.com/rhastie/nmos-cpp"),
        environment : environment,
        containerPort : 11000
      }
    });

    //set the DNS SD settings for the virtual node
    const virtualNodeDnsService = new Service(this, "nmos-virtnode", {
      name : "nmos-virtnode", 
      namespace : hostedZoneNamespace, 
      dnsTtl : Duration.seconds(10)
    })

    virtualNodeFargateService.service.associateCloudMapService({
      service : virtualNodeDnsService
    })
*/


  }
}
