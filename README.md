# Pulumi Kubernetes Guestbook with Prometheus & Grafana Monitoring

This Pulumi TypeScript project deploys the classic Kubernetes Guestbook application (Redis Master, Redis Replicas, and PHP Frontend) extended with full observability using Prometheus and Grafana via the kube-prometheus-stack Helm chart and Kubernetes ServiceMonitor resources.

## Architecture Overview

1. Guestbook Application (guestbook namespace)
   - Redis Master: Deployment & Service (port 6379)
   - Redis Replica: Deployment & Service (port 6379)
   - Frontend: Deployment & Service (port 80)

2. Prometheus & Grafana Monitoring Stack (monitoring namespace)
   - Helm Chart: kube-prometheus-stack
   - Grafana exposed as LoadBalancer service
   - Prometheus scraping via ServiceMonitor custom resources

3. Stack Outputs
   - grafanaUrl
   - grafanaAdminUsername
   - grafanaAdminPassword
   - frontendUrl

## Prerequisites

- Pulumi CLI (https://www.pulumi.com/docs/get-started/install/)
- Node.js (https://nodejs.org/)
- kubectl (https://kubernetes.io/docs/tasks/tools/) connected to a Kubernetes cluster (Minikube, Kind, EKS, GKE, AKS)

## Deployment Instructions

1. Install Node.js dependencies:
   npm install

2. Initialize Pulumi stack:
   pulumi stack init dev

3. Configure optional secrets or parameters:
   pulumi config set --secret grafanaAdminPassword "YourCustomPassword123!"
   pulumi config set grafanaServiceType LoadBalancer

4. Deploy the stack:
   pulumi up

## Grafana Access Details & Credentials

- Access URL: Check stack output `grafanaUrl` or run:
  `pulumi stack output grafanaUrl`
- Default Admin Username: `admin`
- Default Admin Password:
  `pulumi stack output --show-secrets grafanaAdminPassword`

### Local Cluster / Port Forwarding Option
If using Minikube/Kind or if LoadBalancer external IP is pending:
- Access Grafana: `kubectl port-forward -n monitoring svc/prometheus-stack-grafana 3000:80` (open http://localhost:3000)
- Access Guestbook: `kubectl port-forward -n guestbook svc/frontend 8080:80` (open http://localhost:8080)

## Clean Up

To destroy all deployed Kubernetes resources:
pulumi destroy
pulumi stack rm dev
