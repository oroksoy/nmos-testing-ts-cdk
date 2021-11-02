

import cdk = require ('@aws-cdk/core')
import { CfnApplication, CfnConfigurationProfile, CfnDeployment, CfnDeploymentStrategy, CfnEnvironment, CfnHostedConfigurationVersion } from '@aws-cdk/aws-appconfig';
import { NestedStackProps } from '@aws-cdk/core';


interface AppConfigProps extends NestedStackProps {
    domain : string,
    nmostestport: number,
    registryport: number,
    nodeport: number,
    testEnvironment: {[key:string] : string },
}

export class NmosTestingAppConfigStack extends cdk.NestedStack {

    domain: string;
    nmostestport: number;
    testEnvironment: {[key:string] : string };
    
    constructor(scope: cdk.Construct, id: string, props: AppConfigProps) {
        super(scope, id, props);

        // The code that defines your stack goes here

        //Create the environment variables for the sidecar service to find AppConfig Configuration
        let appName: string = "nmos-test";
        let appEnv: string = 'prod';
        let appConfig: string = "nmos-test-user-config";
        let appClientID: string = "1";

        //let testEnvironment : {[key:string] : string} = {};
        props.testEnvironment["NMOS_TEST_APPLICATION"] = appName;
        props.testEnvironment["NMOS_TEST_ENV"] = appEnv;
        props.testEnvironment["NMOS_TEST_CONFIG"] = appConfig;
        props.testEnvironment["NMOS_TEST_CLIENT_ID"] = appClientID;

        //Create the AppConfig configuration 
        const appConfigApp = new CfnApplication(this, 'nmos-test-appconfig', {
            name: appName
        });

        const appConfigEnv = new CfnEnvironment(this, 'nmos-test-prod', {
            applicationId: appConfigApp.ref, 
            name:appEnv
        });
        
        const appConfigDeploymetStrategy = new CfnDeploymentStrategy(this, 'nmos-test-appconfig-deployment-strategy',{
            deploymentDurationInMinutes: 0,
            growthFactor:100,
            name:'Custom.AllAtOnce',
            replicateTo:'NONE'
        });

        const testConfigProfile = new CfnConfigurationProfile(this, 'nmos-test-config-profile', {
            applicationId: appConfigApp.ref, 
            name:appConfig, 
            locationUri:'hosted'
        });

        const testConfigProfileVersion = new CfnHostedConfigurationVersion (this, 'nmos-test-config-profile-version',{
            applicationId: appConfigApp.ref,
            configurationProfileId: testConfigProfile.ref,
            contentType: 'text/plain',
            content: `
from . import Config as CONFIG

# Domain name to use for the local DNS server and mock Node
# This must match the domain name used for certificates in HTTPS mode
CONFIG.DNS_DOMAIN = "${props.domain}"

# The testing tool uses multiple ports to run mock services. This sets the lowest of these, which also runs the GUI
# Note that changing this from the default of 5000 also requires changes to supporting files such as
# test_data/BCP00301/ca/intermediate/openssl.cnf and any generated certificates.
# The mock DNS server port cannot be modified from the default of 53.
CONFIG.PORT_BASE = ${props.nmostestport}` 
        })

        //let nmosAppName: string = 'easy-nmos';
        //let nmosAppEnv: string = 'prod';
        let nmosAppConfig: string = 'easy-nmos-config';
        //let nmosAppClientID: string = '1';

        props.testEnvironment["EASY_NMOS_APPLICATION"] = appName;
        props.testEnvironment["EASY_NMOS_ENV"] = appEnv;
        props.testEnvironment["EASY_NMOS_CONFIG"] = nmosAppConfig;
        props.testEnvironment["EASY_NMOS_CLIENT_ID"] = appClientID;

        const registryConfigProfile = new CfnConfigurationProfile(this, 'nmos-registry-config-profile', {
            applicationId: appConfigApp.ref, 
            name: nmosAppConfig, 
            locationUri: 'hosted'
        });
    
        const registryConfigProfileVersion = new CfnHostedConfigurationVersion (this, 'nmos-registry-config-profile-version',{
            applicationId: appConfigApp.ref,
            configurationProfileId: registryConfigProfile.ref,
            contentType: 'text/plain',
            content: `
{
    "pri": 10,
    "logging_level": 0,
    "http_trace": false,
    "label": "nvidia-container",
    "http_port": ${props.registryport},
    "query_ws_port": 8011,
    "registration_expiry_interval": 12,
    "domain":${props.domain}
}` 
        });

        //let nmosNodeAppName: string = 'easy-nmos-node';
        //let nmosNodeEnv: string = 'prod';
        let nmosNodeConfig: string = 'easy-nmos-node-config';
        //let nmosNodeClientID: string = '1';

        props.testEnvironment["EASY_NMOS_NODE_APPLICATION"] = appName;
        props.testEnvironment["EASY_NMOS_NODE_ENV"] = appEnv;
        props.testEnvironment["EASY_NMOS_NODE_CONFIG"] = nmosNodeConfig;
        props.testEnvironment["EASY_NMOS_NODE_CLIENT_ID"] = appClientID

        const nodeConfigProfile = new CfnConfigurationProfile(this, 'nmos-node-config-profile', {
            applicationId: appConfigApp.ref, 
            name: nmosNodeConfig, 
            locationUri:'hosted'
        });
    
        const nodeConfigProfileVersion = new CfnHostedConfigurationVersion (this, 'nmos-node-config-profile-version',{
            applicationId: appConfigApp.ref,
            configurationProfileId: nodeConfigProfile.ref,
            contentType: 'text/plain',
            content: `
{
    "logging_level": 0,
    "http_port": ${props.nodeport},
    "events_ws_port": 11001,
    "label": "nvidia-container-node",
    "how_many": 5,
    "domain": ${props.domain}
}`
        });

        
        const testConfigDeployment = new CfnDeployment(this, 'nmos-test-appconfig-deployment',{
            applicationId: appConfigApp.ref,
            environmentId: appConfigEnv.ref,
            configurationProfileId: testConfigProfile.ref,
            configurationVersion: '1',
            deploymentStrategyId: appConfigDeploymetStrategy.ref
        });

        testConfigDeployment.node.addDependency(testConfigProfileVersion);

        const registryConfigDeployment = new CfnDeployment(this, 'nmos-registry-appconfig-deployment',{
            applicationId: appConfigApp.ref,
            environmentId: appConfigEnv.ref,
            configurationProfileId: registryConfigProfile.ref,
            configurationVersion: '1',
            deploymentStrategyId: appConfigDeploymetStrategy.ref
        });

        registryConfigDeployment.node.addDependency(registryConfigProfileVersion);
        registryConfigDeployment.node.addDependency(testConfigDeployment);
 
        const nodeConfigDeployment = new CfnDeployment(this, 'nmos-node-appconfig-deployment',{
            applicationId: appConfigApp.ref,
            environmentId: appConfigEnv.ref,
            configurationProfileId: nodeConfigProfile.ref,
            configurationVersion: '1',
            deploymentStrategyId: appConfigDeploymetStrategy.ref
        });
    
        nodeConfigDeployment.node.addDependency(nodeConfigProfileVersion);
        nodeConfigDeployment.node.addDependency(registryConfigDeployment);

  }
}
