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

        const domain = "nmostest.com";
        const nmostestport = 4000;
        const sidecarport = 3000;
        const nmosregistryport = 80;
        const nmosnodeport = 80;
        let environment : {[key:string] : string} = {};

        this.base = new NmosTestingBaseStack(this, "BaseStack", {domain: domain});
        const {vpc, hostedZoneNamespace, cluster } = this.base;

        console.log(environment);
        this.appconfig = new NmosTestingAppConfigStack(this, "AppConfigStack", {
            domain:domain, 
            nmostestport: nmostestport,
            registryport: nmosregistryport,
            nodeport: nmosnodeport, 
            environment: environment
        });
        console.log(environment);
        
        this.containers = new NmosTestingContainerStack(this, "ContainerSTack", {
            vpc: vpc,
            domain: domain,
            hostedZoneNamespace: hostedZoneNamespace,
            cluster: cluster,
            environment: environment,
            sidecarport: sidecarport,
            nmostestport: nmostestport,
            nmosregistryport: nmosregistryport,
            nmosnodeport: nmosnodeport
        })
        console.log(environment);

        this.containers.addDependency(this.base);
        this.containers.addDependency(this.appconfig);
        
    }



}