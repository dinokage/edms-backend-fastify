// api-gateway/server.js
import Fastify from 'fastify'

const fastify = Fastify({
  logger: true
})

import Redis from 'ioredis';

import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import axios from 'axios';

// Service configuration
const SERVICES = {
  auth: {
    url: process.env.AUTH_SERVICE_URL || 'http://localhost:3001',
    prefix: '/api/auth'
  },
  document: {
    url: process.env.DOCUMENT_SERVICE_URL || 'http://localhost:3002',
    prefix: '/api/documents'
  },
  versionControl: {
    url: process.env.VERSION_CONTROL_SERVICE_URL || 'http://localhost:3008',
    prefix: '/api/versions'
  },
  workflow: {
    url: process.env.WORKFLOW_SERVICE_URL || 'http://localhost:3003',
    prefix: '/api/workflow'
  },
  search: {
    url: process.env.SEARCH_SERVICE_URL || 'http://localhost:3004',
    prefix: '/api/search'
  },
  notification: {
    url: process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3005',
    prefix: '/api/notifications'
  },
  audit: {
    url: process.env.AUDIT_SERVICE_URL || 'http://localhost:3006',
    prefix: '/api/audit'
  },
  reporting: {
    url: process.env.REPORTING_SERVICE_URL || 'http://localhost:3007',
    prefix: '/api/reports'
  }
};

// Register CORS
fastify.register(fastifyCors, {
  origin: process.env.CORS_ORIGIN || true,
  credentials: true
});

// Register rate limiting
fastify.register(fastifyRateLimit, {
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  timeWindow: process.env.RATE_LIMIT_WINDOW || '1 minute',
  redis: process.env.REDIS_URL ? Redis.createClient(process.env.REDIS_URL) : null
});

// Register request logging
fastify.addHook('onRequest', async (request, reply) => {
  request.startTime = Date.now();
});

fastify.addHook('onResponse', async (request, reply) => {
  const duration = Date.now() - request.startTime;
  fastify.log.info({
    method: request.method,
    url: request.url,
    statusCode: reply.statusCode,
    duration: `${duration}ms`,
    userAgent: request.headers['user-agent']
  });
});

// Authentication middleware
async function authenticate(request, reply) {
  try {
    const token = request.headers.authorization;
    if (!token) {
      return reply.code(401).send({ error: 'No authorization token provided' });
    }

    // Validate token with auth service
    const response = await axios.get(`${SERVICES.auth.url}/validate`, {
      headers: { authorization: token }
    });

    request.user = response.data.user;
  } catch (error) {
    return reply.code(401).send({ error: 'Invalid authorization token' });
  }
}

// Service proxy function
async function proxyToService(serviceKey, request, reply) {
  try {
    const service = SERVICES[serviceKey];
    if (!service) {
      fastify.log.error(`Service not found: ${serviceKey}`);
      return reply.code(404).send({ error: 'Service not found' });
    }

    // Build target URL
    const targetPath = request.url.replace(service.prefix, '');
    const targetUrl = `${service.url}${targetPath}`;

    fastify.log.debug(`Proxying ${request.method} ${request.url} to ${targetUrl}`);

    // Prepare headers
    const headers = { ...request.headers };
    delete headers.host;
    delete headers['content-length'];

    // Prepare request config
    const config = {
      method: request.method,
      url: targetUrl,
      headers,
      params: request.query,
      timeout: 30000, // 30 seconds
      validateStatus: () => true // Don't throw on HTTP errors
    };

    // Handle request body for POST/PUT requests
    if (['POST', 'PUT', 'PATCH'].includes(request.method.toUpperCase())) {
      if (request.headers['content-type'] && request.headers['content-type'].includes('multipart/form-data')) {
        config.data = request.body;
        config.headers['content-type'] = request.headers['content-type'];
      } else {
        config.data = request.body;
      }
    }

    // Make the request to the target service
    const response = await axios(config);

    // Forward response headers
    Object.keys(response.headers).forEach(key => {
      if (!['content-encoding', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) {
        reply.header(key, response.headers[key]);
      }
    });

    // Send response
    reply.code(response.status).send(response.data);

  } catch (error) {
    // Enhanced error logging with more details
    fastify.log.error('Proxy error details:', {
      serviceKey,
      url: request.url,
      method: request.method,
      targetService: SERVICES[serviceKey]?.url,
      errorCode: error.code,
      errorMessage: error.message,
      errorStack: error.stack,
      response: error.response ? {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      } : null
    });
    
    if (error.code === 'ECONNREFUSED') {
      fastify.log.error(`Connection refused to service ${serviceKey} at ${SERVICES[serviceKey]?.url}`);
      return reply.code(503).send({ 
        error: 'Service temporarily unavailable',
        service: serviceKey,
        details: `Cannot connect to ${serviceKey} service`
      });
    }
    
    if (error.code === 'ENOTFOUND') {
      fastify.log.error(`DNS resolution failed for service ${serviceKey} at ${SERVICES[serviceKey]?.url}`);
      return reply.code(503).send({ 
        error: 'Service host not found',
        service: serviceKey,
        details: `DNS resolution failed for ${serviceKey} service`
      });
    }

    if (error.code === 'ETIMEDOUT') {
      fastify.log.error(`Request timeout for service ${serviceKey}`);
      return reply.code(504).send({ 
        error: 'Service request timeout',
        service: serviceKey
      });
    }
    
    if (error.response) {
      fastify.log.error(`Service ${serviceKey} returned error:`, {
        status: error.response.status,
        data: error.response.data
      });
      return reply.code(error.response.status).send(error.response.data);
    }
    
    // Generic error
    fastify.log.error(`Unexpected error proxying to ${serviceKey}:`, error);
    return reply.code(500).send({ 
      error: 'Internal gateway error',
      service: serviceKey,
      details: error.message
    });
  }
}

// Health check aggregator
fastify.get('/health', async (request, reply) => {
  const healthChecks = {};
  
  for (const [serviceName, config] of Object.entries(SERVICES)) {
    try {
      const response = await axios.get(`${config.url}/health`, { timeout: 5000 });
      healthChecks[serviceName] = {
        status: 'healthy',
        responseTime: response.headers['x-response-time'] || 'unknown'
      };
    } catch (error) {
      healthChecks[serviceName] = {
        status: 'unhealthy',
        error: error.message
      };
    }
  }

  const allHealthy = Object.values(healthChecks).every(check => check.status === 'healthy');
  
  reply.code(allHealthy ? 200 : 503).send({
    status: allHealthy ? 'healthy' : 'degraded',
    gateway: 'healthy',
    services: healthChecks,
    timestamp: new Date().toISOString()
  });
});

// Authentication routes (no auth required)
fastify.register(async function (fastify) {
  fastify.post('/api/auth/login', async (request, reply) => {
    return proxyToService('auth', request, reply);
  });

  fastify.post('/api/auth/register', async (request, reply) => {
    return proxyToService('auth', request, reply);
  });
});

// Protected routes
fastify.register(async function (fastify) {
  // Add authentication to all routes in this context
  fastify.addHook('preHandler', authenticate);

  // Auth service routes
  fastify.get('/api/auth/profile', async (request, reply) => {
    return proxyToService('auth', request, reply);
  });

  fastify.put('/api/auth/profile', async (request, reply) => {
    return proxyToService('auth', request, reply);
  });

  fastify.put('/api/auth/change-password', async (request, reply) => {
    return proxyToService('auth', request, reply);
  });

  fastify.get('/api/auth/validate', async (request, reply) => {
    return proxyToService('auth', request, reply);
  });

  // Document service routes
  fastify.register(async function (fastify) {
    fastify.addContentTypeParser('multipart/form-data', { bodyLimit: 100 * 1024 * 1024 }, (req, payload, done) => {
      done(null, payload);
    });

    fastify.post('/api/documents/upload', async (request, reply) => {
      return proxyToService('document', request, reply);
    });

    fastify.get('/api/documents/search', async (request, reply) => {
      return proxyToService('document', request, reply);
    });

    fastify.get('/api/documents/types', async (request, reply) => {
      return proxyToService('document', request, reply);
    });

    fastify.get('/api/documents/projects', async (request, reply) => {
      return proxyToService('document', request, reply);
    });

    fastify.get('/api/documents/download/:documentId', async (request, reply) => {
      return proxyToService('document', request, reply);
    });

    fastify.get('/api/documents/:documentId', async (request, reply) => {
      return proxyToService('document', request, reply);
    });

    fastify.put('/api/documents/:documentId', async (request, reply) => {
      return proxyToService('document', request, reply);
    });

    fastify.delete('/api/documents/:documentId', async (request, reply) => {
      return proxyToService('document', request, reply);
    });
  });

  // Version Control service routes
  fastify.register(async function (fastify) {
    // Document version history
    fastify.get('/api/versions/documents/:documentId/versions', async (request, reply) => {
      return proxyToService('versionControl', request, reply);
    });

    // Create new version
    fastify.post('/api/versions/documents/:documentId/versions', async (request, reply) => {
      return proxyToService('versionControl', request, reply);
    });

    // Get specific version
    fastify.get('/api/versions/documents/:documentId/versions/:versionNumber', async (request, reply) => {
      return proxyToService('versionControl', request, reply);
    });

    // Download specific version
    fastify.get('/api/versions/documents/:documentId/versions/:versionNumber/download', async (request, reply) => {
      return proxyToService('versionControl', request, reply);
    });

    // Compare versions
    fastify.get('/api/versions/documents/:documentId/versions/:version1/compare/:version2', async (request, reply) => {
      return proxyToService('versionControl', request, reply);
    });

    // Restore version
    fastify.post('/api/versions/documents/:documentId/versions/:versionNumber/restore', async (request, reply) => {
      return proxyToService('versionControl', request, reply);
    });

    // Delete version
    fastify.delete('/api/versions/documents/:documentId/versions/:versionNumber', async (request, reply) => {
      return proxyToService('versionControl', request, reply);
    });

    // Get version relationships
    fastify.get('/api/versions/documents/:documentId/versions/:versionNumber/relationships', async (request, reply) => {
      return proxyToService('versionControl', request, reply);
    });
  });

  // Workflow service routes
  fastify.get('/api/workflow/*', async (request, reply) => {
    return proxyToService('workflow', request, reply);
  });

  fastify.post('/api/workflow/*', async (request, reply) => {
    return proxyToService('workflow', request, reply);
  });

  fastify.put('/api/workflow/*', async (request, reply) => {
    return proxyToService('workflow', request, reply);
  });

  // Search service routes
  fastify.get('/api/search/*', async (request, reply) => {
    return proxyToService('search', request, reply);
  });

  fastify.post('/api/search/*', async (request, reply) => {
    return proxyToService('search', request, reply);
  });

  // Notification service routes
  fastify.get('/api/notifications/*', async (request, reply) => {
    return proxyToService('notification', request, reply);
  });

  fastify.post('/api/notifications/*', async (request, reply) => {
    return proxyToService('notification', request, reply);
  });

  // Audit service routes
  fastify.get('/api/audit/*', async (request, reply) => {
    return proxyToService('audit', request, reply);
  });

  fastify.post('/api/audit/*', async (request, reply) => {
    return proxyToService('audit', request, reply);
  });

  // Reporting service routes
  fastify.get('/api/reports/*', async (request, reply) => {
    return proxyToService('reporting', request, reply);
  });

  fastify.post('/api/reports/*', async (request, reply) => {
    return proxyToService('reporting', request, reply);
  });
});

// Global error handler
fastify.setErrorHandler((error, request, reply) => {
  fastify.log.error(error);
  
  if (error.statusCode) {
    reply.code(error.statusCode).send({ error: error.message });
  } else {
    reply.code(500).send({ error: 'Internal server error', details: error.message });
  }
});

// API documentation endpoint
fastify.get('/api/docs', async (request, reply) => {
  const documentation = {
    title: 'EDMS API Gateway',
    version: '1.0.0',
    description: 'Engineering Document Management System API',
    services: Object.keys(SERVICES),
    endpoints: {
      authentication: {
        'POST /api/auth/login': 'User login',
        'POST /api/auth/register': 'User registration',
        'GET /api/auth/profile': 'Get user profile',
        'PUT /api/auth/profile': 'Update user profile',
        'PUT /api/auth/change-password': 'Change password'
      },
      documents: {
        'POST /api/documents/upload': 'Upload document',
        'GET /api/documents/search': 'Search documents',
        'GET /api/documents/:id': 'Get document details',
        'PUT /api/documents/:id': 'Update document metadata',
        'DELETE /api/documents/:id': 'Delete document',
        'GET /api/documents/download/:id': 'Download document'
      },
      versions: {
        'GET /api/versions/documents/:id/versions': 'Get document version history',
        'POST /api/versions/documents/:id/versions': 'Create new version',
        'GET /api/versions/documents/:id/versions/:version': 'Get specific version',
        'GET /api/versions/documents/:id/versions/:version/download': 'Download specific version',
        'GET /api/versions/documents/:id/versions/:v1/compare/:v2': 'Compare versions',
        'POST /api/versions/documents/:id/versions/:version/restore': 'Restore version',
        'DELETE /api/versions/documents/:id/versions/:version': 'Delete version'
      },
      workflow: {
        'GET /api/workflow/instances': 'Get workflow instances',
        'POST /api/workflow/start': 'Start workflow',
        'PUT /api/workflow/approve/:id': 'Approve workflow step'
      }
    }
  };

  reply.send(documentation);
});

// Circuit breaker implementation
class CircuitBreaker {
  constructor(threshold = 5, timeout = 60000) {
    this.threshold = threshold;
    this.timeout = timeout;
    this.failureCount = 0;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.nextAttempt = Date.now();
  }

  async call(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        throw new Error('Circuit breaker is OPEN');
      }
      this.state = 'HALF_OPEN';
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  onSuccess() {
    this.failureCount = 0;
    this.state = 'CLOSED';
  }

  onFailure() {
    this.failureCount++;
    if (this.failureCount >= this.threshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.timeout;
    }
  }
}

// Service circuit breakers
const circuitBreakers = {};
Object.keys(SERVICES).forEach(service => {
  circuitBreakers[service] = new CircuitBreaker();
});

// Start server
const start = async () => {
  try {
    await fastify.listen({ 
      port: process.env.PORT || 3000, 
      host: process.env.HOST || '0.0.0.0' 
    });
    fastify.log.info('API Gateway running on port 3000');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();