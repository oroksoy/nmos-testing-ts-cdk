
import cdk = require ('@aws-cdk/core')
import { Vpc } from '@aws-cdk/aws-ec2'
import { NestedStackProps, RemovalPolicy } from '@aws-cdk/core';
import { FileSystem } from '@aws-cdk/aws-efs'
import { Cluster } from '@aws-cdk/aws-ecs';
import { PrivateDnsNamespace } from '@aws-cdk/aws-servicediscovery'


interface BaseProps extends NestedStackProps {
    domain : string;
}

export class NmosTestingBaseStack extends cdk.NestedStack {
    vpc: Vpc;
    hostedZoneNamespace: PrivateDnsNamespace;
    cluster: Cluster;
    fileSystem: FileSystem;

    constructor(scope: cdk.Construct, id: string, props: BaseProps) {
        super(scope, id, props);

        this.vpc = new Vpc(this, "nmos-test-vpc", {maxAzs: 2});
        
        this.cluster = new Cluster(this, 'nmos-test-cluster',{vpc: this.vpc});

        //Crete the configuration variables to use in the container configuration files
        this.hostedZoneNamespace = new PrivateDnsNamespace(this, 'nmos-test-namespace', {
            vpc: this.vpc, 
            name : props.domain 
        });
    }
}