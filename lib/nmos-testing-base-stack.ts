
import cdk = require ('@aws-cdk/core')
import { NestedStackProps, RemovalPolicy } from '@aws-cdk/core';
import { FileSystem } from '@aws-cdk/aws-efs'
import { InstanceType, Vpc } from '@aws-cdk/aws-ec2';
import { AsgCapacityProvider, Cluster, EcsOptimizedImage } from '@aws-cdk/aws-ecs';
import { AutoScalingGroup } from '@aws-cdk/aws-autoscaling'
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
        //This has to be an EC2 Service because of directory specific host mounts
        //We need to add capacity to the cluster
        const autoScalingGroup = new AutoScalingGroup(this, 'cluster-asg', {
            vpc: this.vpc,
            instanceType: new InstanceType('t3a.xlarge'),
            machineImage: EcsOptimizedImage.amazonLinux2(),
            minCapacity: 1,
            maxCapacity: 1
        })
        autoScalingGroup.applyRemovalPolicy(RemovalPolicy.DESTROY);
        
        const asgCapacityProvider = new AsgCapacityProvider(this, 'cluster-asg-capacity-provider', {
            autoScalingGroup: autoScalingGroup,
            enableManagedTerminationProtection: false
        })
        this.cluster.addAsgCapacityProvider(asgCapacityProvider);

        //Crete the configuration variables to use in the container configuration files
        this.hostedZoneNamespace = new PrivateDnsNamespace(this, 'nmos-test-namespace', {
            vpc: this.vpc, 
            name : props.domain 
        });
    }
}