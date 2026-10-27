import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

// ----------------------------------------------------------------------------
// Configuration Parameters
// ----------------------------------------------------------------------------
const config = new pulumi.Config();
const adminPass = config.getSecret("grafanaAdminPassword") || pulumi.secret("GrafanaAdminPass2026!");
const serviceType = config.get("grafanaServiceType") || "LoadBalancer";

// ----------------------------------------------------------------------------
// 1. Create Kubernetes Namespaces
// ----------------------------------------------------------------------------
const appNamespace = new k8s.core.v1.Namespace("guestbook-ns", {
    metadata: { name: "guestbook" }
});

const monitoringNamespace = new k8s.core.v1.Namespace("monitoring-ns", {
    metadata: { name: "monitoring" }
});

const nsName = appNamespace.metadata.name;
const monNsName = monitoringNamespace.metadata.name;

// ----------------------------------------------------------------------------
// 2. Deploy Redis Master (Backend State Store)
// ----------------------------------------------------------------------------
const redisMasterLabels = { app: "redis", role: "master", tier: "backend" };

const redisMasterDeployment = new k8s.apps.v1.Deployment("redis-master-dep", {
    metadata: {
        namespace: nsName,
        labels: redisMasterLabels,
    },
    spec: {
        selector: { matchLabels: redisMasterLabels },
        replicas: 1,
        template: {
            metadata: {
                labels: redisMasterLabels,
                annotations: {
                    "prometheus.io/scrape": "true",
                    "prometheus.io/port": "6379",
                },
            },
            spec: {
                containers: [{
                    name: "master",
                    image: "redis:6.0-alpine",
                    resources: {
                        requests: { cpu: "100m", memory: "100Mi" },
                        limits: { cpu: "200m", memory: "200Mi" },
                    },
                    ports: [{ containerPort: 6379, name: "redis" }],
                }],
            },
        },
    },
}, { parent: appNamespace });

const redisMasterService = new k8s.core.v1.Service("redis-master-svc", {
    metadata: {
        name: "redis-master",
        namespace: nsName,
        labels: redisMasterLabels,
    },
    spec: {
        ports: [{ port: 6379, targetPort: 6379, name: "redis" }],
        selector: redisMasterLabels,
    },
}, { parent: redisMasterDeployment });

// ----------------------------------------------------------------------------
// 3. Deploy Redis Replicas (Read Scaling)
// ----------------------------------------------------------------------------
const redisReplicaLabels = { app: "redis", role: "replica", tier: "backend" };

const redisReplicaDeployment = new k8s.apps.v1.Deployment("redis-replica-dep", {
    metadata: {
        namespace: nsName,
        labels: redisReplicaLabels,
    },
    spec: {
        selector: { matchLabels: redisReplicaLabels },
        replicas: 2,
        template: {
            metadata: {
                labels: redisReplicaLabels,
                annotations: {
                    "prometheus.io/scrape": "true",
                    "prometheus.io/port": "6379",
                },
            },
            spec: {
                containers: [{
                    name: "replica",
                    image: "gcr.io/google_samples/gb-redisslave:v3",
                    resources: {
                        requests: { cpu: "100m", memory: "100Mi" },
                        limits: { cpu: "200m", memory: "200Mi" },
                    },
                    env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                    ports: [{ containerPort: 6379, name: "redis" }],
                }],
            },
        },
    },
}, { parent: appNamespace });

const redisReplicaService = new k8s.core.v1.Service("redis-replica-svc", {
    metadata: {
        name: "redis-replica",
        namespace: nsName,
        labels: redisReplicaLabels,
    },
    spec: {
        ports: [{ port: 6379, targetPort: 6379, name: "redis" }],
        selector: redisReplicaLabels,
    },
}, { parent: redisReplicaDeployment });

// ----------------------------------------------------------------------------
// 4. Deploy Guestbook Frontend
// ----------------------------------------------------------------------------
const frontendLabels = { app: "guestbook", tier: "frontend" };

const frontendDeployment = new k8s.apps.v1.Deployment("frontend-dep", {
    metadata: {
        namespace: nsName,
        labels: frontendLabels,
    },
    spec: {
        selector: { matchLabels: frontendLabels },
        replicas: 3,
        template: {
            metadata: {
                labels: frontendLabels,
                annotations: {
                    "prometheus.io/scrape": "true",
                    "prometheus.io/port": "80",
                    "prometheus.io/path": "/metrics",
                },
            },
            spec: {
                containers: [{
                    name: "php-redis",
                    image: "gcr.io/google-samples/gb-frontend:v4",
                    resources: {
                        requests: { cpu: "100m", memory: "100Mi" },
                        limits: { cpu: "200m", memory: "200Mi" },
                    },
                    env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                    ports: [{ containerPort: 80, name: "http" }],
                }],
            },
        },
    },
}, { parent: appNamespace });

const frontendService = new k8s.core.v1.Service("frontend-svc", {
    metadata: {
        name: "frontend",
        namespace: nsName,
        labels: { ...frontendLabels, "release": "prometheus-stack" },
    },
    spec: {
        type: "LoadBalancer",
        ports: [{ port: 80, targetPort: 80, name: "http" }],
        selector: frontendLabels,
    },
}, { parent: frontendDeployment });

// ----------------------------------------------------------------------------
// 5. Deploy Prometheus & Grafana Stack via Helm Chart
// ----------------------------------------------------------------------------
const prometheusStack = new k8s.helm.v3.Chart("prometheus-stack", {
    namespace: monNsName,
    chart: "kube-prometheus-stack",
    version: "55.5.0",
    fetchOpts: {
        repo: "https://prometheus-community.github.io/helm-charts",
    },
    values: {
        fullnameOverride: "prometheus-stack",
        grafana: {
            enabled: true,
            adminPassword: adminPass,
            service: {
                type: serviceType,
                port: 80,
            },
            additionalDataSources: [{
                name: "Prometheus",
                type: "prometheus",
                url: "http://prometheus-stack-prometheus.monitoring.svc.cluster.local:9090",
                access: "proxy",
                isDefault: true,
            }],
        },
        prometheus: {
            enabled: true,
            service: {
                type: "ClusterIP",
                port: 9090,
            },
            prometheusSpec: {
                serviceMonitorSelectorNilUsesHelmValues: false,
                podMonitorSelectorNilUsesHelmValues: false,
                serviceMonitorNamespaceSelector: {},
                podMonitorNamespaceSelector: {},
            },
        },
        nodeExporter: { enabled: true },
        kubeStateMetrics: { enabled: true },
    },
}, { parent: monitoringNamespace });

// ----------------------------------------------------------------------------
// 6. Define ServiceMonitors for Prometheus Metrics Scraping
// ----------------------------------------------------------------------------
const frontendServiceMonitor = new k8s.apiextensions.CustomResource("frontend-service-monitor", {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
        name: "guestbook-frontend-monitor",
        namespace: nsName,
        labels: {
            app: "guestbook",
            release: "prometheus-stack",
        },
    },
    spec: {
        selector: {
            matchLabels: frontendLabels,
        },
        namespaceSelector: {
            matchNames: [nsName],
        },
        endpoints: [{
            port: "http",
            interval: "15s",
            path: "/metrics",
        }],
    },
}, { parent: frontendService, dependsOn: [prometheusStack] });

const redisServiceMonitor = new k8s.apiextensions.CustomResource("redis-service-monitor", {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
        name: "guestbook-redis-monitor",
        namespace: nsName,
        labels: {
            app: "redis",
            release: "prometheus-stack",
        },
    },
    spec: {
        selector: {
            matchLabels: { app: "redis" },
        },
        namespaceSelector: {
            matchNames: [nsName],
        },
        endpoints: [{
            port: "redis",
            interval: "15s",
        }],
    },
}, { parent: appNamespace, dependsOn: [prometheusStack] });

// ----------------------------------------------------------------------------
// 7. Stack Outputs
// ----------------------------------------------------------------------------
export const frontendUrl = frontendService.status.apply(status => {
    const ingress = status?.loadBalancer?.ingress?.[0];
    if (ingress?.ip) return "http://" + ingress.ip + ":80";
    if (ingress?.hostname) return "http://" + ingress.hostname + ":80";
    return "Pending LoadBalancer allocation (use: kubectl port-forward -n guestbook svc/frontend 8080:80)";
});

const grafanaService = k8s.core.v1.Service.get("grafana-service-ref", 
    pulumi.interpolate`${monNsName}/prometheus-stack-grafana`, 
    { parent: prometheusStack }
);

export const grafanaUrl = grafanaService.status.apply(status => {
    const ingress = status?.loadBalancer?.ingress?.[0];
    if (ingress?.ip) return "http://" + ingress.ip + ":80";
    if (ingress?.hostname) return "http://" + ingress.hostname + ":80";
    return "Pending LoadBalancer allocation (use: kubectl port-forward -n monitoring svc/prometheus-stack-grafana 3000:80)";
});

export const grafanaAdminUsername = "admin";
export const grafanaAdminPassword = adminPass;
export const prometheusInternalUrl = "http://prometheus-stack-prometheus.monitoring.svc.cluster.local:9090";
