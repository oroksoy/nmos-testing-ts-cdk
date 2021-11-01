import { Stack, Construct, StackProps } from '@aws-cdk/core';
import { NmosTestingAppConfigStack } from './nmos-testing-AppConfig-stack';
import { NmosTestingBaseStack } from './nmos-testing-base-stack';
import { NmosTestingContainerStack } from './nmos-testing-container-stack';

export class NMOSTestingStack extends Stack {

    base: NmosTestingBaseStack;
    appconfig : NmosTestingAppConfigStack;
    containers: NmosTestingContainerStack;
    

    
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        const domain = "nmos-test";
        const nmostestport = 4000;
        let testEnvironment : {[key:string] : string} = {};

        this.base = new NmosTestingBaseStack(this, "BaseStack", {domain: domain});
        const {vpc, hostedZoneNamespace, cluster } = this.base;

        console.log(testEnvironment);
        this.appconfig = new NmosTestingAppConfigStack(this, "AppConfigStack", {domain:domain, nmostestport: nmostestport, testEnvironment: testEnvironment});
        console.log(testEnvironment);
        
        this.containers = new NmosTestingContainerStack(this, "ContainerSTack", {
            vpc: vpc,
            domain: domain,
            hostedZoneNamespace: hostedZoneNamespace,
            cluster: cluster,
            testEnvironment: testEnvironment,
            nmostestport: nmostestport
        })
        console.log(testEnvironment);

        //this.containers.addDependency(this.base);
        //this.containers.addDependency(this.appconfig);
        
    }



}