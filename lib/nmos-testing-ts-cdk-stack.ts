

import cdk = require ('@aws-cdk/core')
import { Vpc } from '@aws-cdk/aws-ec2';
import { Cluster } from '@aws-cdk/aws-ecs';
import { ContainerImage } from '@aws-cdk/aws-ecs';
import { ApplicationLoadBalancedFargateService } from '@aws-cdk/aws-ecs-patterns';
import { PrivateDnsNamespace} from '@aws-cdk/aws-servicediscovery';
import { Service } from '@aws-cdk/aws-servicediscovery';
import { Duration } from '@aws-cdk/core';
import { Repository } from '@aws-cdk/aws-ecr';
import { CfnApplication, CfnConfigurationProfile, CfnDeployment, CfnDeploymentStrategy, CfnEnvironment, CfnHostedConfigurationVersion } from '@aws-cdk/aws-appconfig';
import { Policy, PolicyStatement, Role, ServicePrincipal } from '@aws-cdk/aws-events/node_modules/@aws-cdk/aws-iam';


export class NmosTestingTsCdkStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here

    const vpc = new Vpc(this, "nmos-test-vpc", {maxAzs: 2});
	
	  const cluster = new Cluster(this, 'nmos-test-cluster',{vpc});

    let domain = "local";
    let nmostestport = 4000;
	  const hostedZoneNamespace = new PrivateDnsNamespace(this, 'nmos-test-namespace', {
      vpc, name : domain 
    });

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
# Domain name to use for the local DNS server and mock Node
# This must match the domain name used for certificates in HTTPS mode
CONFIG.DNS_DOMAIN = `
+ domain +
`

# The testing tool uses multiple ports to run mock services. This sets the lowest of these, which also runs the GUI
# Note that changing this from the default of 5000 also requires changes to supporting files such as
# test_data/BCP00301/ca/intermediate/openssl.cnf and any generated certificates.
# The mock DNS server port cannot be modified from the default of 53.
CONFIG.PORT_BASE = `
+ nmostestport 
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


    const testingFargateService = new ApplicationLoadBalancedFargateService(this, "nmosTestingFargateService", {
      cluster,
      openListener : true,
      assignPublicIp: true,
      publicLoadBalancer : true,
      serviceName : "nmos-testing",
      taskImageOptions: {
        //image: ContainerImage.fromRegistry("registry.hub.docker.com/amwa/nmos-testing"),
        image: ContainerImage.fromEcrRepository(Repository.fromRepositoryName(this, "nmos-testing-repository", "nmos-testing")),
        environment: testEnvironment,
        containerPort : nmostestport,
      }
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
    
    testingFargateService.service.taskDefinition.taskRole.attachInlinePolicy(accessPolicy);

    const testingDnsService = new Service(this, "nmos-testing", {
      name : "nmos-testing", 
      namespace : hostedZoneNamespace, 
      dnsTtl : Duration.seconds(10)
    })

    testingFargateService.service.associateCloudMapService({
      service : testingDnsService
    })

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

    const registryDnsService = new Service(this, "nmos-registry", {
      name : "nmos-registry", 
      namespace : hostedZoneNamespace, 
      dnsTtl : Duration.seconds(10)
    })

    registryFargateService.service.associateCloudMapService({
      service : registryDnsService
    })

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

    const virtualNodeDnsService = new Service(this, "nmos-virtnode", {
      name : "nmos-virtnode", 
      namespace : hostedZoneNamespace, 
      dnsTtl : Duration.seconds(10)
    })

    virtualNodeFargateService.service.associateCloudMapService({
      service : virtualNodeDnsService
    })


  }
}
