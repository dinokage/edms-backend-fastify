// audit-service/server.js
import Fastify from 'fastify'

const fastify = Fastify({
  logger: true
})
import Redis from 'ioredis';

// Database setup
import pgPromise from 'pg-promise';
const pgp = pgPromise({
  connect(client) {
    fastify.log.debug(`Connected to database: ${client.database}`);
  },
disconnect(client) {
    fastify.log.debug(`Disconnected from database: ${client.database}`);
  },
  query(e) {
    fastify.log.debug(`QUERY: ${e.query}`);
  }
});

const db = pgp({
  host: process.env.DB_HOST || 'postgres',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'edms',
  user: process.env.DB_USER || 'admin',
  password: process.env.DB_PASSWORD || 'password'
});

// Redis setup for real-time audit streaming
const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379');

// Authentication middleware
async function authenticate(request, reply) {
  try {
    const token = request.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      reply.code(401).send({ error: 'No token provided' });
      return;
    }
    // Mock user for now - should validate JWT
    request.user = { 
      id: 'user-123', 
      username: 'testuser',
      roles: ['auditor', 'user']
    };
  } catch (error) {
    reply.code(401).send({ error: 'Invalid token' });
  }
}

// Authorization middleware for audit access
async function requireAuditAccess(request, reply) {
  const userRoles = request.user.roles || [];
  const hasAuditAccess = userRoles.some(role => 
    ['admin', 'auditor', 'compliance_officer'].includes(role)
  );
  
  if (!hasAuditAccess) {
    reply.code(403).send({ error: 'Insufficient permissions to access audit logs' });
    return;
  }
}

fastify.decorate('authenticate', authenticate);
fastify.decorate('requireAuditAccess', requireAuditAccess);

// Utility functions
function getClientInfo(request) {
  return {
    ip_address: request.ip,
    user_agent: request.headers['user-agent'],
    session_id: request.headers['x-session-id'] || null
  };
}

async function logAuditEvent(userId, entityType, entityId, action, oldValues = null, newValues = null, request = null) {
  try {
    const clientInfo = request ? getClientInfo(request) : {};
    
    const auditLog = await db.one(`
      INSERT INTO audit_logs (
        user_id, entity_type, entity_id, action, 
        old_values, new_values, ip_address, user_agent, session_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [
      userId,
      entityType,
      entityId,
      action,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      clientInfo.ip_address,
      clientInfo.user_agent,
      clientInfo.session_id
    ]);
    
    // Publish to Redis for real-time monitoring
    await redis.publish('audit_events', JSON.stringify({
      ...auditLog,
      timestamp: new Date()
    }));
    
    return auditLog;
    
  } catch (error) {
    fastify.log.error('Failed to log audit event:', error);
    throw error;
  }
}

// Schemas
const auditSearchSchema = {
  querystring: {
    type: 'object',
    properties: {
      userId: { type: 'string' },
      entityType: { type: 'string' },
      entityId: { type: 'string' },
      action: { type: 'string' },
      dateFrom: { type: 'string', format: 'date-time' },
      dateTo: { type: 'string', format: 'date-time' },
      ipAddress: { type: 'string' },
      page: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 1000 }
    }
  }
};

const complianceEventSchema = {
  body: {
    type: 'object',
    required: ['documentId', 'eventType', 'complianceStatus'],
    properties: {
      documentId: { type: 'string' },
      eventType: { type: 'string' },
      regulationReference: { type: 'string' },
      complianceStatus: { 
        type: 'string', 
        enum: ['compliant', 'non_compliant', 'pending_review'] 
      },
      evidence: { type: 'object' },
      reviewNotes: { type: 'string' }
    }
  }
};

// Routes

// Get audit logs with filtering
fastify.get('/logs', {
  preHandler: [authenticate, requireAuditAccess],
  schema: auditSearchSchema
}, async (request, reply) => {
  try {
    const {
      userId, entityType, entityId, action, dateFrom, dateTo, ipAddress,
      page = 1, limit = 50
    } = request.query;
    
    let query = `
      SELECT al.*, u.username, u.first_name, u.last_name,
             COUNT(*) OVER() as total_count
      FROM audit_logs al
      LEFT JOIN users u ON al.user_id = u.id
      WHERE 1=1
    `;
    
    const params = [];
    let paramIndex = 1;
    
    if (userId) {
      query += ` AND al.user_id = $${paramIndex}`;
      params.push(userId);
      paramIndex++;
    }
    
    if (entityType) {
      query += ` AND al.entity_type = $${paramIndex}`;
      params.push(entityType);
      paramIndex++;
    }
    
    if (entityId) {
      query += ` AND al.entity_id = $${paramIndex}`;
      params.push(entityId);
      paramIndex++;
    }
    
    if (action) {
      query += ` AND al.action ILIKE $${paramIndex}`;
      params.push(`%${action}%`);
      paramIndex++;
    }
    
    if (dateFrom) {
      query += ` AND al.timestamp >= $${paramIndex}`;
      params.push(dateFrom);
      paramIndex++;
    }
    
    if (dateTo) {
      query += ` AND al.timestamp <= $${paramIndex}`;
      params.push(dateTo);
      paramIndex++;
    }
    
    if (ipAddress) {
      query += ` AND al.ip_address = $${paramIndex}`;
      params.push(ipAddress);
      paramIndex++;
    }
    
    const offset = (page - 1) * limit;
    query += ` ORDER BY al.timestamp DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);
    
    const results = await db.any(query, params);
    
    const totalCount = results.length > 0 ? parseInt(results[0].total_count) : 0;
    const auditLogs = results.map(row => {
      const { total_count, ...log } = row;
      return {
        ...log,
        old_values: log.old_values ? JSON.parse(log.old_values) : null,
        new_values: log.new_values ? JSON.parse(log.new_values) : null
      };
    });
    
    reply.send({
      auditLogs,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit)
      }
    });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to retrieve audit logs' });
  }
});

// Get audit trail for specific entity
fastify.get('/trail/:entityType/:entityId', {
  preHandler: [authenticate, requireAuditAccess]
}, async (request, reply) => {
  try {
    const { entityType, entityId } = request.params;
    const { page = 1, limit = 100 } = request.query;
    
    const offset = (page - 1) * limit;
    
    const auditTrail = await db.any(`
      SELECT al.*, u.username, u.first_name, u.last_name,
             COUNT(*) OVER() as total_count
      FROM audit_logs al
      LEFT JOIN users u ON al.user_id = u.id
      WHERE al.entity_type = $1 AND al.entity_id = $2
      ORDER BY al.timestamp ASC
      LIMIT $3 OFFSET $4
    `, [entityType, entityId, limit, offset]);
    
    const totalCount = auditTrail.length > 0 ? parseInt(auditTrail[0].total_count) : 0;
    const trail = auditTrail.map(row => {
      const { total_count, ...log } = row;
      return {
        ...log,
        old_values: log.old_values ? JSON.parse(log.old_values) : null,
        new_values: log.new_values ? JSON.parse(log.new_values) : null
      };
    });
    
    reply.send({
      entityType,
      entityId,
      auditTrail: trail,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit)
      }
    });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to retrieve audit trail' });
  }
});

// Manual audit log entry (for external integrations)
fastify.post('/logs', {
  preHandler: [authenticate, requireAuditAccess],
  schema: {
    body: {
      type: 'object',
      required: ['entityType', 'entityId', 'action'],
      properties: {
        entityType: { type: 'string' },
        entityId: { type: 'string' },
        action: { type: 'string' },
        oldValues: { type: 'object' },
        newValues: { type: 'object' },
        notes: { type: 'string' }
      }
    }
  }
}, async (request, reply) => {
  try {
    const { entityType, entityId, action, oldValues, newValues, notes } = request.body;
    
    const auditLog = await logAuditEvent(
      request.user.id,
      entityType,
      entityId,
      action,
      oldValues,
      newValues ? { ...newValues, notes } : { notes },
      request
    );
    
    reply.code(201).send({
      message: 'Audit log created successfully',
      auditLog: {
        id: auditLog.id,
        timestamp: auditLog.timestamp
      }
    });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to create audit log' });
  }
});

// Get compliance events
fastify.get('/compliance', {
  preHandler: [authenticate, requireAuditAccess]
}, async (request, reply) => {
  try {
    const {
      documentId, eventType, complianceStatus, regulationReference,
      dateFrom, dateTo, page = 1, limit = 50
    } = request.query;
    
    let query = `
      SELECT ce.*, d.title as document_title, d.file_name,
             u.username as reviewed_by_username,
             COUNT(*) OVER() as total_count
      FROM compliance_events ce
      JOIN documents d ON ce.document_id = d.id
      LEFT JOIN users u ON ce.reviewed_by = u.id
      WHERE 1=1
    `;
    
    const params = [];
    let paramIndex = 1;
    
    if (documentId) {
      query += ` AND ce.document_id = $${paramIndex}`;
      params.push(documentId);
      paramIndex++;
    }
    
    if (eventType) {
      query += ` AND ce.event_type = $${paramIndex}`;
      params.push(eventType);
      paramIndex++;
    }
    
    if (complianceStatus) {
      query += ` AND ce.compliance_status = $${paramIndex}`;
      params.push(complianceStatus);
      paramIndex++;
    }
    
    if (regulationReference) {
      query += ` AND ce.regulation_reference ILIKE $${paramIndex}`;
      params.push(`%${regulationReference}%`);
      paramIndex++;
    }
    
    if (dateFrom) {
      query += ` AND ce.recorded_at >= $${paramIndex}`;
      params.push(dateFrom);
      paramIndex++;
    }
    
    if (dateTo) {
      query += ` AND ce.recorded_at <= $${paramIndex}`;
      params.push(dateTo);
      paramIndex++;
    }
    
    const offset = (page - 1) * limit;
    query += ` ORDER BY ce.recorded_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);
    
    const results = await db.any(query, params);
    
    const totalCount = results.length > 0 ? parseInt(results[0].total_count) : 0;
    const complianceEvents = results.map(row => {
      const { total_count, ...event } = row;
      return {
        ...event,
        evidence: event.evidence ? JSON.parse(event.evidence) : null
      };
    });
    
    reply.send({
      complianceEvents,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit)
      }
    });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to retrieve compliance events' });
  }
});

// Create compliance event
fastify.post('/compliance', {
  preHandler: [authenticate, requireAuditAccess],
  schema: complianceEventSchema
}, async (request, reply) => {
  try {
    const {
      documentId, eventType, regulationReference, complianceStatus,
      evidence, reviewNotes
    } = request.body;
    
    // Validate document exists
    const document = await db.oneOrNone('SELECT id FROM documents WHERE id = $1', [documentId]);
    if (!document) {
      return reply.code(404).send({ error: 'Document not found' });
    }
    
    const complianceEvent = await db.one(`
      INSERT INTO compliance_events (
        document_id, event_type, regulation_reference, compliance_status,
        evidence, reviewed_by
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [
      documentId,
      eventType,
      regulationReference,
      complianceStatus,
      evidence ? JSON.stringify({ ...evidence, reviewNotes }) : JSON.stringify({ reviewNotes }),
      request.user.id
    ]);
    
    // Log the compliance event creation
    await logAuditEvent(
      request.user.id,
      'compliance_event',
      complianceEvent.id,
      'CREATE',
      null,
      {
        documentId,
        eventType,
        complianceStatus,
        regulationReference
      },
      request
    );
    
    reply.code(201).send({
      message: 'Compliance event created successfully',
      complianceEvent
    });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to create compliance event' });
  }
});

// Update compliance event status
fastify.put('/compliance/:eventId', {
  preHandler: [authenticate, requireAuditAccess],
  schema: {
    body: {
      type: 'object',
      required: ['complianceStatus'],
      properties: {
        complianceStatus: { 
          type: 'string', 
          enum: ['compliant', 'non_compliant', 'pending_review'] 
        },
        evidence: { type: 'object' },
        reviewNotes: { type: 'string' }
      }
    }
  }
}, async (request, reply) => {
  try {
    const { eventId } = request.params;
    const { complianceStatus, evidence, reviewNotes } = request.body;
    
    // Get current event for audit trail
    const currentEvent = await db.oneOrNone('SELECT * FROM compliance_events WHERE id = $1', [eventId]);
    if (!currentEvent) {
      return reply.code(404).send({ error: 'Compliance event not found' });
    }
    
    const updatedEvent = await db.one(`
      UPDATE compliance_events 
      SET compliance_status = $1, 
          evidence = COALESCE($2, evidence),
          reviewed_by = $3,
          reviewed_at = NOW()
      WHERE id = $4
      RETURNING *
    `, [
      complianceStatus,
      evidence ? JSON.stringify({ ...evidence, reviewNotes }) : null,
      request.user.id,
      eventId
    ]);
    
    // Log the update
    await logAuditEvent(
      request.user.id,
      'compliance_event',
      eventId,
      'UPDATE',
      {
        compliance_status: currentEvent.compliance_status,
        reviewed_by: currentEvent.reviewed_by
      },
      {
        compliance_status: complianceStatus,
        reviewed_by: request.user.id,
        reviewNotes
      },
      request
    );
    
    reply.send({
      message: 'Compliance event updated successfully',
      complianceEvent: updatedEvent
    });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to update compliance event' });
  }
});

// Get audit statistics and analytics
fastify.get('/analytics', {
  preHandler: [authenticate, requireAuditAccess]
}, async (request, reply) => {
  try {
    const { dateFrom, dateTo, entityType } = request.query;
    
    let dateFilter = '';
    const params = [];
    let paramIndex = 1;
    
    if (dateFrom) {
      dateFilter += ` AND timestamp >= $${paramIndex}`;
      params.push(dateFrom);
      paramIndex++;
    }
    
    if (dateTo) {
      dateFilter += ` AND timestamp <= $${paramIndex}`;
      params.push(dateTo);
      paramIndex++;
    }
    
    if (entityType) {
      dateFilter += ` AND entity_type = $${paramIndex}`;
      params.push(entityType);
      paramIndex++;
    }
    
    // Overall statistics
    const overallStats = await db.one(`
      SELECT 
        COUNT(*) as total_events,
        COUNT(DISTINCT user_id) as unique_users,
        COUNT(DISTINCT entity_type) as unique_entity_types,
        COUNT(DISTINCT DATE(timestamp)) as active_days
      FROM audit_logs
      WHERE 1=1 ${dateFilter}
    `, params);
    
    // Action breakdown
    const actionBreakdown = await db.any(`
      SELECT action, COUNT(*) as count
      FROM audit_logs
      WHERE 1=1 ${dateFilter}
      GROUP BY action
      ORDER BY count DESC
    `, params);
    
    // Entity type breakdown
    const entityBreakdown = await db.any(`
      SELECT entity_type, COUNT(*) as count
      FROM audit_logs
      WHERE 1=1 ${dateFilter}
      GROUP BY entity_type
      ORDER BY count DESC
    `, params);
    
    // Top users by activity
    const topUsers = await db.any(`
      SELECT u.username, u.first_name, u.last_name, COUNT(*) as activity_count
      FROM audit_logs al
      JOIN users u ON al.user_id = u.id
      WHERE 1=1 ${dateFilter}
      GROUP BY u.id, u.username, u.first_name, u.last_name
      ORDER BY activity_count DESC
      LIMIT 10
    `, params);
    
    // Daily activity trend (last 30 days)
    const dailyActivity = await db.any(`
      SELECT DATE(timestamp) as date, COUNT(*) as activity_count
      FROM audit_logs
      WHERE timestamp >= NOW() - INTERVAL '30 days' ${dateFilter.replace('timestamp >=', 'AND timestamp >=')}
      GROUP BY DATE(timestamp)
      ORDER BY date
    `, params);
    
    // Compliance status overview
    const complianceOverview = await db.one(`
      SELECT 
        COUNT(*) as total_compliance_events,
        COUNT(CASE WHEN compliance_status = 'compliant' THEN 1 END) as compliant_count,
        COUNT(CASE WHEN compliance_status = 'non_compliant' THEN 1 END) as non_compliant_count,
        COUNT(CASE WHEN compliance_status = 'pending_review' THEN 1 END) as pending_review_count
      FROM compliance_events
      WHERE 1=1
    `);
    
    reply.send({
      dateRange: { from: dateFrom, to: dateTo },
      overallStats,
      actionBreakdown,
      entityBreakdown,
      topUsers,
      dailyActivity,
      complianceOverview
    });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to retrieve audit analytics' });
  }
});

// Export audit logs for external compliance tools
fastify.get('/export', {
  preHandler: [authenticate, requireAuditAccess]
}, async (request, reply) => {
  try {
    const { format = 'json', dateFrom, dateTo, entityType } = request.query;
    
    let query = `
      SELECT al.*, u.username, u.first_name, u.last_name
      FROM audit_logs al
      LEFT JOIN users u ON al.user_id = u.id
      WHERE 1=1
    `;
    
    const params = [];
    let paramIndex = 1;
    
    if (dateFrom) {
      query += ` AND al.timestamp >= $${paramIndex}`;
      params.push(dateFrom);
      paramIndex++;
    }
    
    if (dateTo) {
      query += ` AND al.timestamp <= $${paramIndex}`;
      params.push(dateTo);
      paramIndex++;
    }
    
    if (entityType) {
      query += ` AND al.entity_type = $${paramIndex}`;
      params.push(entityType);
      paramIndex++;
    }
    
    query += ` ORDER BY al.timestamp ASC`;
    
    const auditLogs = await db.any(query, params);
    
    // Process the data for export
    const exportData = auditLogs.map(log => ({
      id: log.id,
      timestamp: log.timestamp,
      user: {
        id: log.user_id,
        username: log.username,
        fullName: log.first_name && log.last_name ? 
          `${log.first_name} ${log.last_name}` : null
      },
      entity: {
        type: log.entity_type,
        id: log.entity_id
      },
      action: log.action,
      changes: {
        old: log.old_values ? JSON.parse(log.old_values) : null,
        new: log.new_values ? JSON.parse(log.new_values) : null
      },
      context: {
        ipAddress: log.ip_address,
        userAgent: log.user_agent,
        sessionId: log.session_id
      }
    }));
    
    if (format === 'csv') {
      // Convert to CSV format
      const csvHeaders = [
        'ID', 'Timestamp', 'Username', 'Entity Type', 'Entity ID', 
        'Action', 'IP Address', 'User Agent'
      ];
      
      let csvContent = csvHeaders.join(',') + '\n';
      
      exportData.forEach(log => {
        const row = [
          log.id,
          log.timestamp,
          log.user.username || '',
          log.entity.type,
          log.entity.id,
          log.action,
          log.context.ipAddress || '',
          `"${(log.context.userAgent || '').replace(/"/g, '""')}"`
        ];
        csvContent += row.join(',') + '\n';
      });
      
      reply
        .header('Content-Type', 'text/csv')
        .header('Content-Disposition', `attachment; filename="audit_logs_${Date.now()}.csv"`)
        .send(csvContent);
    } else {
      // JSON format
      reply
        .header('Content-Type', 'application/json')
        .header('Content-Disposition', `attachment; filename="audit_logs_${Date.now()}.json"`)
        .send({
          exportMetadata: {
            generatedAt: new Date(),
            generatedBy: request.user.username,
            filters: { dateFrom, dateTo, entityType },
            totalRecords: exportData.length
          },
          auditLogs: exportData
        });
    }
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to export audit logs' });
  }
});

// Real-time audit event streaming via Server-Sent Events
fastify.get('/stream', {
  preHandler: [authenticate, requireAuditAccess]
}, async (request, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });
  
  // Send initial connection message
  reply.raw.write('data: {"type":"connected","message":"Audit stream connected"}\n\n');
  
  // Subscribe to audit events
  const subscriber = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  await subscriber.subscribe('audit_events');
  
  subscriber.on('message', (channel, message) => {
    if (channel === 'audit_events') {
      reply.raw.write(`data: ${message}\n\n`);
    }
  });
  
  // Handle client disconnect
  request.raw.on('close', () => {
    subscriber.unsubscribe('audit_events');
    subscriber.disconnect();
  });
});

// Health check
fastify.get('/health', async (request, reply) => {
  try {
    await db.one('SELECT 1');
    await redis.ping();
    reply.send({ status: 'healthy', service: 'audit-service' });
  } catch (error) {
    reply.code(503).send({ status: 'unhealthy', service: 'audit-service' });
  }
});

// Expose audit logging function for other services
fastify.post('/log-event', {
  preHandler: authenticate,
  schema: {
    body: {
      type: 'object',
      required: ['entityType', 'entityId', 'action'],
      properties: {
        entityType: { type: 'string' },
        entityId: { type: 'string' },
        action: { type: 'string' },
        oldValues: { type: 'object' },
        newValues: { type: 'object' }
      }
    }
  }
}, async (request, reply) => {
  try {
    const { entityType, entityId, action, oldValues, newValues } = request.body;
    
    const auditLog = await logAuditEvent(
      request.user.id,
      entityType,
      entityId,
      action,
      oldValues,
      newValues,
      request
    );
    
    reply.send({
      success: true,
      auditLogId: auditLog.id
    });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to log audit event' });
  }
});

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: process.env.PORT || 3006, host: '0.0.0.0' });
    fastify.log.info('Audit service running on port 3006');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();