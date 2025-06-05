// notification-service/server.js
import Fastify from 'fastify'
import fastifyWebsocket from '@fastify/websocket';
const fastify = Fastify({
  logger: true
})
import nodemailer from 'nodemailer';
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

// Redis setup for pub/sub and real-time notifications
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const redisPub = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// Email configuration
const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// WebSocket support for real-time notifications
fastify.register(fastifyWebsocket);

// Store active WebSocket connections
const activeConnections = new Map();

// Authentication middleware
async function authenticate(request, reply) {
  try {
    const token = request.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      reply.code(401).send({ error: 'No token provided' });
      return;
    }
    // Mock user for now - should validate JWT
    request.user = { id: 'user-123', username: 'testuser', email: 'test@example.com' };
  } catch (error) {
    reply.code(401).send({ error: 'Invalid token' });
  }
}

fastify.decorate('authenticate', authenticate);

// Template processing utility
function processTemplate(template, data) {
  let processed = template;
  
  // Simple template variable replacement
  Object.keys(data).forEach(key => {
    const regex = new RegExp(`{{${key}}}`, 'g');
    processed = processed.replace(regex, data[key] || '');
  });
  
  // Handle nested object properties like {{user.name}}
  const nestedRegex = /{{(\w+)\.(\w+)}}/g;
  processed = processed.replace(nestedRegex, (match, obj, prop) => {
    if (data[obj] && data[obj][prop]) {
      return data[obj][prop];
    }
    return match;
  });
  
  return processed;
}

// Send email notification
async function sendEmailNotification(to, subject, htmlBody, textBody) {
  try {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      fastify.log.warn('Email credentials not configured, skipping email send');
      return { status: 'skipped', reason: 'Email not configured' };
    }
    
    const mailOptions = {
      from: process.env.SMTP_USER,
      to,
      subject,
      html: htmlBody,
      text: textBody || htmlBody.replace(/<[^>]*>/g, '') // Strip HTML for text version
    };
    
    const result = await emailTransporter.sendMail(mailOptions);
    return { status: 'sent', messageId: result.messageId };
    
  } catch (error) {
    fastify.log.error('Failed to send email:', error);
    throw error;
  }
}

// Send real-time notification via WebSocket
async function sendRealtimeNotification(userId, notification) {
  try {
    const userConnections = activeConnections.get(userId) || [];
    
    userConnections.forEach(ws => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: 'notification',
          data: notification
        }));
      }
    });
    
    // Also publish to Redis for other instances
    await redisPub.publish('realtime_notifications', JSON.stringify({
      userId,
      notification
    }));
    
  } catch (error) {
    fastify.log.error('Failed to send realtime notification:', error);
  }
}

// Listen for events from other services
redis.subscribe('workflow_events', 'document_events', 'system_events');

redis.on('message', async (channel, message) => {
  try {
    const event = JSON.parse(message);
    await processEvent(channel, event);
  } catch (error) {
    fastify.log.error('Failed to process event:', error);
  }
});

// Process events and create notifications
async function processEvent(channel, event) {
  try {
    let templateName = '';
    let recipients = [];
    let templateData = {};
    
    switch (channel) {
      case 'workflow_events':
        if (event.event === 'workflow_started') {
          templateName = 'Approval Required';
          // Get approvers for the current step
          const approvers = await db.any(`
            SELECT DISTINCT u.id, u.email, u.username
            FROM workflow_instances wi
            JOIN approval_steps ast ON wi.id = ast.workflow_instance_id
            JOIN users u ON (ast.approver_user_id = u.id OR ast.delegated_to = u.id)
            WHERE wi.id = $1 AND ast.status = 'pending' AND ast.step_number = wi.current_step
          `, [event.data.workflowId]);
          
          recipients = approvers;
          templateData = {
            document: { title: event.data.documentTitle },
            workflow: { priority: event.data.priority },
            user: { name: event.data.initiatedBy }
          };
        } else if (event.event === 'workflow_action') {
          if (event.data.action === 'approve') {
            templateName = 'Document Approved';
          } else if (event.data.action === 'reject') {
            templateName = 'Document Rejected';
          }
          
          // Notify document owner
          const documentOwner = await db.oneOrNone(`
            SELECT u.id, u.email, u.username
            FROM documents d
            JOIN users u ON d.uploaded_by = u.id
            WHERE d.id = (
              SELECT document_id FROM workflow_instances WHERE id = $1
            )
          `, [event.data.workflowId]);
          
          if (documentOwner) {
            recipients = [documentOwner];
            templateData = {
              document: { title: event.data.documentTitle },
              user: { name: event.data.performedBy },
              reason: event.data.comments || ''
            };
          }
        }
        break;
        
      case 'document_events':
        if (event.event === 'document_uploaded') {
          templateName = 'Document Upload';
          // Notify project members or managers
          const projectMembers = await db.any(`
            SELECT DISTINCT u.id, u.email, u.username
            FROM users u
            JOIN user_roles ur ON u.id = ur.user_id
            JOIN roles r ON ur.role_id = r.id
            WHERE r.name IN ('manager', 'admin')
          `);
          
          recipients = projectMembers;
          templateData = {
            document: { title: event.data.documentTitle },
            project: { name: event.data.projectName },
            user: { name: event.data.uploadedBy }
          };
        }
        break;
    }
    
    if (templateName && recipients.length > 0) {
      await createNotifications(templateName, recipients, templateData);
    }
    
  } catch (error) {
    fastify.log.error('Failed to process event:', error);
  }
}

// Create and send notifications
async function createNotifications(templateName, recipients, templateData) {
  try {
    // Get notification template
    const template = await db.oneOrNone(
      'SELECT * FROM notification_templates WHERE name = $1 AND is_active = true',
      [templateName]
    );
    
    if (!template) {
      fastify.log.warn(`Notification template '${templateName}' not found`);
      return;
    }
    
    for (const recipient of recipients) {
      const subject = processTemplate(template.subject_template, templateData);
      const message = processTemplate(template.body_template, templateData);
      
      // Create notification record
      const notification = await db.one(`
        INSERT INTO notifications (
          user_id, template_id, subject, message, notification_type, data
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `, [
        recipient.id,
        template.id,
        subject,
        message,
        template.notification_type,
        JSON.stringify(templateData)
      ]);
      
      // Send based on notification type
      if (template.notification_type === 'email') {
        try {
          await sendEmailNotification(recipient.email, subject, message);
          await db.none(
            'UPDATE notifications SET status = $1, sent_at = NOW() WHERE id = $2',
            ['sent', notification.id]
          );
        } catch (error) {
          await db.none(
            'UPDATE notifications SET status = $1 WHERE id = $2',
            ['failed', notification.id]
          );
        }
      }
      
      // Always send real-time notification for immediate feedback
      await sendRealtimeNotification(recipient.id, {
        id: notification.id,
        subject,
        message,
        type: template.notification_type,
        createdAt: notification.created_at
      });
    }
    
  } catch (error) {
    fastify.log.error('Failed to create notifications:', error);
  }
}

// Routes

// WebSocket endpoint for real-time notifications
fastify.register(async function (fastify) {
  fastify.get('/ws', { websocket: true }, (connection, req) => {
    // TODO: Extract user ID from token in real implementation
    const userId = 'user-123'; // Mock user ID
    
    // Store connection
    if (!activeConnections.has(userId)) {
      activeConnections.set(userId, []);
    }
    activeConnections.get(userId).push(connection.socket);
    
    connection.socket.on('close', () => {
      // Remove connection
      const userConnections = activeConnections.get(userId) || [];
      const index = userConnections.indexOf(connection.socket);
      if (index > -1) {
        userConnections.splice(index, 1);
      }
      if (userConnections.length === 0) {
        activeConnections.delete(userId);
      }
    });
    
    // Send initial connection confirmation
    connection.socket.send(JSON.stringify({
      type: 'connected',
      message: 'Connected to notification service'
    }));
  });
});

// Get user notifications
fastify.get('/notifications', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { 
      status, type, unreadOnly, 
      page = 1, limit = 20 
    } = request.query;
    
    let query = `
      SELECT n.*, nt.name as template_name
      FROM notifications n
      LEFT JOIN notification_templates nt ON n.template_id = nt.id
      WHERE n.user_id = $1
    `;
    
    const params = [request.user.id];
    let paramIndex = 2;
    
    if (status) {
      query += ` AND n.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }
    
    if (type) {
      query += ` AND n.notification_type = $${paramIndex}`;
      params.push(type);
      paramIndex++;
    }
    
    if (unreadOnly === 'true') {
      query += ` AND n.read_at IS NULL`;
    }
    
    const countQuery = query.replace('SELECT n.*, nt.name as template_name', 'SELECT COUNT(*)');
    const totalCount = await db.one(countQuery, params);
    
    const offset = (page - 1) * limit;
    query += ` ORDER BY n.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);
    
    const notifications = await db.any(query, params);
    
    reply.send({
      notifications,
      pagination: {
        page,
        limit,
        total: parseInt(totalCount.count),
        totalPages: Math.ceil(parseInt(totalCount.count) / limit)
      }
    });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to get notifications' });
  }
});

// Mark notification as read
fastify.put('/notifications/:notificationId/read', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { notificationId } = request.params;
    
    const result = await db.result(`
      UPDATE notifications 
      SET read_at = NOW() 
      WHERE id = $1 AND user_id = $2 AND read_at IS NULL
    `, [notificationId, request.user.id]);
    
    if (result.rowCount === 0) {
      return reply.code(404).send({ error: 'Notification not found or already read' });
    }
    
    reply.send({ message: 'Notification marked as read' });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to mark notification as read' });
  }
});

// Mark all notifications as read
fastify.put('/notifications/read-all', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const result = await db.result(`
      UPDATE notifications 
      SET read_at = NOW() 
      WHERE user_id = $1 AND read_at IS NULL
    `, [request.user.id]);
    
    reply.send({ 
      message: 'All notifications marked as read',
      updatedCount: result.rowCount
    });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to mark all notifications as read' });
  }
});

// Delete notification
fastify.delete('/notifications/:notificationId', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { notificationId } = request.params;
    
    const result = await db.result(
      'DELETE FROM notifications WHERE id = $1 AND user_id = $2',
      [notificationId, request.user.id]
    );
    
    if (result.rowCount === 0) {
      return reply.code(404).send({ error: 'Notification not found' });
    }
    
    reply.send({ message: 'Notification deleted successfully' });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to delete notification' });
  }
});

// Send manual notification (admin only)
fastify.post('/send', {
  preHandler: authenticate,
  schema: {
    body: {
      type: 'object',
      required: ['recipients', 'subject', 'message', 'notificationType'],
      properties: {
        recipients: { 
          type: 'array', 
          items: { type: 'string' },
          minItems: 1
        },
        subject: { type: 'string', maxLength: 255 },
        message: { type: 'string' },
        notificationType: { 
          type: 'string', 
          enum: ['email', 'in_app', 'both'] 
        },
        priority: { 
          type: 'string', 
          enum: ['low', 'normal', 'high'], 
          default: 'normal' 
        }
      }
    }
  }
}, async (request, reply) => {
  try {
    const { recipients, subject, message, notificationType, priority = 'normal' } = request.body;
    
    // TODO: Check if user has admin role
    
    const sentNotifications = [];
    
    for (const recipientId of recipients) {
      // Validate recipient exists
      const recipient = await db.oneOrNone(
        'SELECT id, email, username FROM users WHERE id = $1 AND is_active = true',
        [recipientId]
      );
      
      if (!recipient) {
        fastify.log.warn(`Recipient ${recipientId} not found or inactive`);
        continue;
      }
      
      // Create notification record
      const notification = await db.one(`
        INSERT INTO notifications (
          user_id, subject, message, notification_type, status, data
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `, [
        recipient.id,
        subject,
        message,
        notificationType === 'both' ? 'email' : notificationType,
        'pending',
        JSON.stringify({ priority, sentBy: request.user.username })
      ]);
      
      // Send email if required
      if (notificationType === 'email' || notificationType === 'both') {
        try {
          await sendEmailNotification(recipient.email, subject, message);
          await db.none(
            'UPDATE notifications SET status = $1, sent_at = NOW() WHERE id = $2',
            ['sent', notification.id]
          );
        } catch (error) {
          await db.none(
            'UPDATE notifications SET status = $1 WHERE id = $2',
            ['failed', notification.id]
          );
        }
      }
      
      // Send real-time notification
      if (notificationType === 'in_app' || notificationType === 'both') {
        await sendRealtimeNotification(recipient.id, {
          id: notification.id,
          subject,
          message,
          type: 'manual',
          priority,
          createdAt: notification.created_at
        });
      }
      
      sentNotifications.push({
        recipientId: recipient.id,
        recipientUsername: recipient.username,
        notificationId: notification.id
      });
    }
    
    reply.code(201).send({
      message: 'Notifications sent successfully',
      sentCount: sentNotifications.length,
      notifications: sentNotifications
    });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to send notifications' });
  }
});

// Get notification templates (admin only)
fastify.get('/templates', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const templates = await db.any(`
      SELECT * FROM notification_templates 
      ORDER BY event_type, name
    `);
    
    reply.send({ templates });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to get templates' });
  }
});

// Create notification template (admin only)
fastify.post('/templates', {
  preHandler: authenticate,
  schema: {
    body: {
      type: 'object',
      required: ['name', 'eventType', 'subjectTemplate', 'bodyTemplate', 'notificationType'],
      properties: {
        name: { type: 'string', maxLength: 255 },
        eventType: { type: 'string', maxLength: 100 },
        subjectTemplate: { type: 'string' },
        bodyTemplate: { type: 'string' },
        notificationType: { 
          type: 'string', 
          enum: ['email', 'sms', 'push', 'in_app'] 
        }
      }
    }
  }
}, async (request, reply) => {
  try {
    const { name, eventType, subjectTemplate, bodyTemplate, notificationType } = request.body;
    
    const template = await db.one(`
      INSERT INTO notification_templates (
        name, event_type, subject_template, body_template, notification_type
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [name, eventType, subjectTemplate, bodyTemplate, notificationType]);
    
    reply.code(201).send({ template });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to create template' });
  }
});

// Get notification statistics
fastify.get('/stats', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { dateFrom, dateTo } = request.query;
    
    let dateFilter = '';
    const params = [request.user.id];
    let paramIndex = 2;
    
    if (dateFrom) {
      dateFilter += ` AND created_at >= $${paramIndex}`;
      params.push(dateFrom);
      paramIndex++;
    }
    
    if (dateTo) {
      dateFilter += ` AND created_at <= $${paramIndex}`;
      params.push(dateTo + ' 23:59:59');
      paramIndex++;
    }
    
    const stats = await db.one(`
      SELECT 
        COUNT(*) as total_notifications,
        COUNT(CASE WHEN read_at IS NULL THEN 1 END) as unread_count,
        COUNT(CASE WHEN status = 'sent' THEN 1 END) as sent_count,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_count,
        COUNT(CASE WHEN notification_type = 'email' THEN 1 END) as email_count,
        COUNT(CASE WHEN notification_type = 'in_app' THEN 1 END) as in_app_count
      FROM notifications 
      WHERE user_id = $1 ${dateFilter}
    `, params);
    
    reply.send({ stats });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to get notification statistics' });
  }
});

// Test email configuration
fastify.post('/test-email', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { email = request.user.email } = request.body;
    
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return reply.code(400).send({ error: 'Email configuration is missing' });
    }
    
    await sendEmailNotification(
      email,
      'EDMS Notification Test',
      '<h1>Test Email</h1><p>This is a test email from the EDMS notification service.</p>'
    );
    
    reply.send({ message: 'Test email sent successfully', email });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to send test email' });
  }
});

// Health check
fastify.get('/health', async (request, reply) => {
  try {
    await db.one('SELECT 1');
    await redis.ping();
    
    // Test email configuration if provided
    let emailStatus = 'not_configured';
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
      try {
        await emailTransporter.verify();
        emailStatus = 'configured';
      } catch (error) {
        emailStatus = 'error';
      }
    }
    
    reply.send({ 
      status: 'healthy', 
      service: 'notification-service',
      email: emailStatus,
      activeConnections: Array.from(activeConnections.keys()).length
    });
  } catch (error) {
    reply.code(503).send({ status: 'unhealthy', service: 'notification-service' });
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  fastify.log.info('Received SIGTERM, shutting down gracefully');
  
  // Close WebSocket connections
  activeConnections.forEach((connections, userId) => {
    connections.forEach(ws => {
      if (ws.readyState === ws.OPEN) {
        ws.close();
      }
    });
  });
  
  await fastify.close();
  process.exit(0);
});

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: process.env.PORT || 3005, host: '0.0.0.0' });
    fastify.log.info('Notification service running on port 3005');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();