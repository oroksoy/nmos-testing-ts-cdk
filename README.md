# Welcome to the CDK Typescript project for the NMOS testing tool in the cloud!

There are several prerequisites before staring to work with the CDK.

	1.  AWS CLI
	2.  AWS CDK
	3.  NPM


## AWC CLI

Please install the AWS Command Line Interface (CLI) on your computer. 

		https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html

The AWS CLI will allow you to interact with your AWS environment from the command line of your computers terminal.  
	
## AWS CDK
	
The AWS CDK is the development kit that was used to create an application that will create the infrastructure components required to run the NMOS testing tool on AWS.  This is one more level of abstraction as the application here creates the Cloudformation scripts used to create the infrastructure for the NMOS testing tool.  The CDK was chosen because it can also generate Terraform configuration files that can then be used to create infrastructure on other cloud providers' platforms.  We chose to build the container platform on a full managed container service from AWS called Fargate.  Fargate would not work in Azure or GCP but the CDK gives us the ability to build a Kubernetes cluster relatively easily if there was the need.  There is a very useful quide to the AWS CDK here:
	
	https://docs.aws.amazon.com/cdk/latest/guide/getting_started.html
	
Install the AWS CDK Toolkit globally using the following Node Package Manager command.  (This assumes NPM as the package manager.  Please install CDK using your native package manager or install npm on your system)

		npm install -g aws-cdk
		
Run the following command to verify correct installation and print the version number of the AWS CDK.
		
		cdk --version
		
## Typescript

Download Typescript

	https://www.typescriptlang.org/download
	
## NPM and Node for execution

Download and install NPM and Node.js

	https://docs.npmjs.com/downloading-and-installing-node-js-and-npm

## NMOS Testing CDK Application

Download the NMOS testing CDK project from the git repository.  This is an NPM project that will build on your environment.  Build the app using the following command.

	npm run build

## Build your Infrastructure Stack on AWS

You are now ready to create the infrastructure on your AWS cloud environment.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

It is a [Maven](https://maven.apache.org/) based project, so you can open this project with any Maven compatible Java IDE to build and run tests.


You can run the following command to see the components that will be created when executed.

	cdk synth
	
You can run the following command to create the components in your AWS account.  There are several assumptions to be aware of.  This application will create a new VPC on your account with the 10.0.0.0/16 private IP range.  That range does not overlap with the default VPC in your account but if you have created another VPC, please be aware of this overlap and consider another account.

We do believe that AWS accounts are a proper boundary for projects.  You can view the components created using this script by logging onto the AWS console with your account's administrative user.  We have not explicitly restricted permissions anywhere.  Your organization which manages AWS accounts can impose permission boundaries on those accounts if there is a need to limit access to certain AWS services.  

	cdk deploy
	
## Destroy the infrastructure Stack on AWS

You can destroy all components created by this application with the following command.

	cdk destroy
	
## Update resources.

As updates are made to this CDK application you will have the opportunity to update an infrastructure stack that was created earlier.  You can view the implications of any changes by running the following command

	cdk diff
	
If you want to deploy the updated resources the AWS CDK documentation states that "cdk deploy" should automatically detect differences and update the stack.  We have found that this does not work for the Fargate container manager used by this application.  In order to update, we have destroyed the infrastructure and recreated it.

	cdk destroy
	cdk deploy

## Running the testing tool and other containers

The NMOS testing tool will automatically run.  The application will create a load balancer in front of a container cluster that automatically downloads the latest amwa/nmos-testing container from the docker registry.  The container responds on port 5000 but we have mapped the container port to the load balancer port 80 because the load balancer is only going to serve this container.

	
	Log onto your AWS console
	
	Go to the EC2 service.
	
	Scroll down on the left side and click on Load Balancers
	
	Click on the Load Balancer created by the NMOS-testing stack.
	
	In the Description tab for the load balancer you can copy the DNS name for the load balancer
		(You can easily copy the DNS name by clicking on the two overlapping files icon at the end of the DNS name
	
	Paste the DNS name into your browser and access the testing tool running in the cloud
	
We updated the testing tool deployment to include the Easy NMOS components posted by Richard Hastie.  (https://github.com/rhastie/easy-nmos).  There are now three load balancers in front of three container services.  One container runs the NMOS Testing tool. One container runs the registry and controller.  One container runs the virtual node.

Browse to the NMOS Controller

	http://${Load balancer dns name for Registry}/admin

Browse to the AMWA NMOS Testing Tool

	http://${Load balancer dns name for Testing tool}/

Browse to the APIs of the NMOS Registry

	http://${Load balancer dns name for Registry}/x-nmos

Browse to the APIs of the NMOS Node

	http://${Load balancer dns name for Virtual Node}/x-nmos


## Service discovery

(Under Contruction.  We are working through the DNS configs for the containers and the whole enviroment.  We referred to "local" as the domain name, but will work to change that based on configuration and this readme might not keep pace with the changes at certain times.)

We have taken advantage of the AWS Service Discovery functionality provided by Route 53.  Each of the containers have registered themselves in "local" hosted zone under their respective discovery names.

AMWA NMOS Testing Tool

	nmos-testing.local

NMOS Registry

	nmos-registry.local

NMOS Node

	nmos-virtnode.local
	
The containers making the DNS SD call will advertise in the VPC.  AWS automatically creates the Route 53 (DNS) A records that map to the private IP address of the network interface attached to the container.  Because we have incorporated Service discovery with the Elastic Container Service (ECS), AWS will automatically remap the name-IP pairs as instances change do to health or load.

In this implementation of the deployment, we have created a Private Hosted Zone for our VPC in order to manage cost.  The containers in this implementation will be able to find each other and the User Interfaces associated with each of the services are still reachable from the public internet through the Load Balancers.  This means, however, that the DNS SD records are not propagating to the public internet.  Devices outside of this VPC will not be able to discover this registry with DNS SD.

We see operational challenges in a broadcast environment with an implementation where a device from the public internet would connect directly with a registry or controller.  Remote News and Sports operations would benefit from this capability if the operational reliability and security challenges can be managed.  AWS Route 53 does offer split window hosted zones and we might be able to demonstrate use case where devices inside the hosted zone find each other with a broader namespace and devices outside the hosted zone are able to reach an advertisement for a more specific namespace from the public internet.
	

## Configurations

The nmos-testing-AppConfig-stack.ts has the configuration settings for each of the containers.  This stack puts the configuration in AWS AppConfig.  If you log into the AWS console and navigate to AppConfig, you can view the configurations for each of the different containers under different configuration versions.

There is a sidecar container that is deployed with each service whose sole function is to read the configuraiton from AppConfig and create a config file in a host volume.  The main container is built to be dependent on the sidecar container finishing this activity.  The sidecar container itself listens on a path off the load balancer.

http://${load-balancer-address}/sidecar will output the configuraiton that the sidecar read from AppConfig and wrote to the config file in the host mount.


We picked AppConfig because it was built for this.  S3 could have just as easily been a pick.



Enjoy!




