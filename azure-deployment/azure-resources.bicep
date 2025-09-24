// Kusor Azure Infrastructure as Code (Bicep)
// This template creates all necessary Azure resources for Kusor deployment

@description('The name prefix for all resources')
param namePrefix string = 'kusor'

@description('The location for all resources')
param location string = resourceGroup().location

@description('Supabase URL')
@secure()
param supabaseUrl string

@description('Supabase Anonymous Key')
@secure()
param supabaseAnonKey string

@description('Supabase Service Key')
@secure()
param supabaseServiceKey string

@description('Environment (dev, staging, prod)')
param environment string = 'prod'

// Variables
var resourceSuffix = '${namePrefix}-${environment}'
var containerRegistryName = replace('${resourceSuffix}registry', '-', '')
var redisName = '${resourceSuffix}-redis'
var containerAppEnvName = '${resourceSuffix}-env'
var logAnalyticsName = '${resourceSuffix}-logs'

// Container Registry
resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: containerRegistryName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: true
  }
}

// Log Analytics Workspace
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: logAnalyticsName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

// Redis Cache
resource redisCache 'Microsoft.Cache/Redis@2023-08-01' = {
  name: redisName
  location: location
  properties: {
    sku: {
      name: 'Basic'
      family: 'C'
      capacity: 0
    }
    enableNonSslPort: false
    minimumTlsVersion: '1.2'
    redisConfiguration: {
      'maxmemory-policy': 'allkeys-lru'
    }
  }
}

// Container App Environment
resource containerAppEnvironment 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: containerAppEnvName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

// Backend Container App
resource backendContainerApp 'Microsoft.App/containerApps@2023-05-01' = {
  name: '${resourceSuffix}-backend'
  location: location
  properties: {
    managedEnvironmentId: containerAppEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8000
        allowInsecure: false
        traffic: [
          {
            weight: 100
            latestRevision: true
          }
        ]
      }
      registries: [
        {
          server: containerRegistry.properties.loginServer
          username: containerRegistry.listCredentials().username
          passwordSecretRef: 'registry-password'
        }
      ]
      secrets: [
        {
          name: 'registry-password'
          value: containerRegistry.listCredentials().passwords[0].value
        }
        {
          name: 'redis-connection-string'
          value: 'redis://:${redisCache.listKeys().primaryKey}@${redisCache.properties.hostName}:6380'
        }
        {
          name: 'supabase-url'
          value: supabaseUrl
        }
        {
          name: 'supabase-service-key'
          value: supabaseServiceKey
        }
      ]
    }
    template: {
      containers: [
        {
          image: '${containerRegistry.properties.loginServer}/${resourceSuffix}-backend:latest'
          name: 'backend'
          env: [
            {
              name: 'REDIS_URL'
              secretRef: 'redis-connection-string'
            }
            {
              name: 'SUPABASE_URL'
              secretRef: 'supabase-url'
            }
            {
              name: 'SUPABASE_SERVICE_KEY'
              secretRef: 'supabase-service-key'
            }
            {
              name: 'ENV_MODE'
              value: 'production'
            }
            {
              name: 'LOG_LEVEL'
              value: 'info'
            }
          ]
          resources: {
            cpu: json('2.0')
            memory: '4.0Gi'
          }
          probes: [
            {
              type: 'Readiness'
              httpGet: {
                path: '/api/health'
                port: 8000
              }
              initialDelaySeconds: 60
              periodSeconds: 15
              timeoutSeconds: 30
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/api/health'
                port: 8000
              }
              initialDelaySeconds: 120
              periodSeconds: 30
              timeoutSeconds: 30
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 5
        rules: [
          {
            name: 'http-rule'
            http: {
              metadata: {
                concurrentRequests: '100'
              }
            }
          }
        ]
      }
    }
  }
}

// Frontend Container App
resource frontendContainerApp 'Microsoft.App/containerApps@2023-05-01' = {
  name: '${resourceSuffix}-frontend'
  location: location
  properties: {
    managedEnvironmentId: containerAppEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        allowInsecure: false
        traffic: [
          {
            weight: 100
            latestRevision: true
          }
        ]
      }
      registries: [
        {
          server: containerRegistry.properties.loginServer
          username: containerRegistry.listCredentials().username
          passwordSecretRef: 'registry-password'
        }
      ]
      secrets: [
        {
          name: 'registry-password'
          value: containerRegistry.listCredentials().passwords[0].value
        }
        {
          name: 'supabase-url'
          value: supabaseUrl
        }
        {
          name: 'supabase-anon-key'
          value: supabaseAnonKey
        }
      ]
    }
    template: {
      containers: [
        {
          image: '${containerRegistry.properties.loginServer}/${resourceSuffix}-frontend:latest'
          name: 'frontend'
          env: [
            {
              name: 'NEXT_PUBLIC_SUPABASE_URL'
              secretRef: 'supabase-url'
            }
            {
              name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY'
              secretRef: 'supabase-anon-key'
            }
            {
              name: 'NEXT_PUBLIC_API_URL'
              value: 'https://${backendContainerApp.properties.configuration.ingress.fqdn}'
            }
            {
              name: 'NODE_ENV'
              value: 'production'
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
          probes: [
            {
              type: 'Readiness'
              httpGet: {
                path: '/'
                port: 3000
              }
              initialDelaySeconds: 10
              periodSeconds: 5
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
        rules: [
          {
            name: 'http-rule'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ]
      }
    }
  }
}

// Worker Container App
resource workerContainerApp 'Microsoft.App/containerApps@2023-05-01' = {
  name: '${resourceSuffix}-worker'
  location: location
  properties: {
    managedEnvironmentId: containerAppEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [
        {
          server: containerRegistry.properties.loginServer
          username: containerRegistry.listCredentials().username
          passwordSecretRef: 'registry-password'
        }
      ]
      secrets: [
        {
          name: 'registry-password'
          value: containerRegistry.listCredentials().passwords[0].value
        }
        {
          name: 'redis-connection-string'
          value: 'redis://:${redisCache.listKeys().primaryKey}@${redisCache.properties.hostName}:6380'
        }
        {
          name: 'supabase-url'
          value: supabaseUrl
        }
        {
          name: 'supabase-service-key'
          value: supabaseServiceKey
        }
      ]
    }
    template: {
      containers: [
        {
          image: '${containerRegistry.properties.loginServer}/${resourceSuffix}-backend:latest'
          name: 'worker'
          command: ['uv', 'run', 'dramatiq', '--skip-logging', '--processes', '2', '--threads', '2', 'run_agent_background']
          env: [
            {
              name: 'REDIS_URL'
              secretRef: 'redis-connection-string'
            }
            {
              name: 'SUPABASE_URL'
              secretRef: 'supabase-url'
            }
            {
              name: 'SUPABASE_SERVICE_KEY'
              secretRef: 'supabase-service-key'
            }
            {
              name: 'ENV_MODE'
              value: 'production'
            }
            {
              name: 'LOG_LEVEL'
              value: 'info'
            }
          ]
          resources: {
            cpu: json('1.5')
            memory: '3.0Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
        rules: [
          {
            name: 'redis-queue'
            custom: {
              type: 'redis'
              metadata: {
                address: '${redisCache.properties.hostName}:6380'
                listName: 'default'
                listLength: '5'
              }
              auth: [
                {
                  secretRef: 'redis-connection-string'
                  triggerParameter: 'password'
                }
              ]
            }
          }
        ]
      }
    }
  }
}

// Outputs
output containerRegistryName string = containerRegistry.name
output containerRegistryLoginServer string = containerRegistry.properties.loginServer
output redisHostName string = redisCache.properties.hostName
output frontendUrl string = 'https://${frontendContainerApp.properties.configuration.ingress.fqdn}'
output backendUrl string = 'https://${backendContainerApp.properties.configuration.ingress.fqdn}'
output resourceGroupName string = resourceGroup().name
