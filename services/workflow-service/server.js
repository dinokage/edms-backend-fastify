// workflow-service/server.js
import Fastify from 'fastify'

const fastify = Fastify({
  logger: true
})
import Redis from 'ioredis';

// Database setup
import pgPromise from 'pg-promise';
const pgp = pgPromise({
  capSQL: true, // Capitalize SQL keywords
  connect(client) {
    fastify.log.debug(`Connected to database: ${client.database}`);
  },
  disconnect(client) {
    fastify.log.debug(`Disconnected from database: ${client.database}`);
  },
  query(e) {
    fastify.log.debug('Executing query:', e.query);
  },
  error(e) {
    fastify.log.error('Database error:', e);
  }
});
const db = pgp({
  host: process.env.DB_HOST || 'postgres',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'edms',
  user: process.env.DB_USER || 'admin',
  password: process.env.DB_PASSWORD || 'password'
});

// Redis setup for notifications and caching
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// Authentication middleware
async function authenticate(request, reply) {
  try {
    const token = request.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      reply.code(401).send({ error: 'No token provided' });
      return;
    }
    // Mock user for now - should validate JWT
    request.user = { id: 'user-123', username: 'testuser', roles: ['engineer'] };
  } catch (error) {
    reply.code(401).send({ error: 'Invalid token' });
  }
}

fastify.decorate('authenticate', authenticate);

// Utility functions
async function sendNotification(event, data) {
  try {
    await redis.publish('workflow_events', JSON.stringify({ event, data, timestamp: new Date() }));
  } catch (error) {
    fastify.log.error('Failed to send notification:', error);
  }
}

async function evaluateWorkflowConditions(workflow, context) {
  // Simple condition evaluation - can be extended with more complex logic
  const conditions = workflow.workflow_config.conditions || {};
  
  for (const [condition, value] of Object.entries(conditions)) {
    switch (condition) {
      case 'document_type':
        if (context.documentType !== value) return false;
        break;
      case 'file_size_mb':
        if (context.fileSize > value * 1024 * 1024) return false;
        break;
      case 'project_status':
        if (context.projectStatus !== value) return false;
        break;
    }
  }
  
  return true;
}

async function getNextApprovers(workflowConfig, stepNumber) {
  const steps = workflowConfig.steps || [];
  const currentStep = steps.find(step => step.step === stepNumber);
  
  if (!currentStep) return [];
  
  const approvers = [];
  
  if (currentStep.approver_user_id) {
    approvers.push({ type: 'user', id: currentStep.approver_user_id });
  }
  
  if (currentStep.approver_role) {
    const usersInRole = await db.any(`
      SELECT u.id, u.username, u.email
      FROM users u
      JOIN user_roles ur ON u.id = ur.user_id
      JOIN roles r ON ur.role_id = r.id
      WHERE r.name = $1 AND u.is_active = true
    `, [currentStep.approver_role]);
    
    usersInRole.forEach(user => {
      approvers.push({ type: 'role', id: user.id, username: user.username, email: user.email });
    });
  }
  
  return approvers;
}

// Schemas
const startWorkflowSchema = {
  body: {
    type: 'object',
    required: ['documentId', 'templateId'],
    properties: {
      documentId: { type: 'string' },
      templateId: { type: 'string' },
      priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
      dueDate: { type: 'string', format: 'date-time' },
      comments: { type: 'string' }
    }
  }
};

const approvalActionSchema = {
  body: {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['approve', 'reject', 'delegate'] },
      comments: { type: 'string' },
      delegateTo: { type: 'string' }
    }
  }
};

// Routes

// Get workflow templates
fastify.get('/templates', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { documentTypeId, isActive = true } = request.query;
    
    let query = `
      SELECT wt.*, dt.name as document_type_name,
             u.username as created_by_username
      FROM workflow_templates wt
      LEFT JOIN document_types dt ON wt.document_type_id = dt.id
      JOIN users u ON wt.created_by = u.id
      WHERE 1=1
    `;
    
    const params = [];
    let paramIndex = 1;
    
    if (isActive !== undefined) {
      query += ` AND wt.is_active = $${paramIndex}`;
      params.push(isActive);
      paramIndex++;
    }
    
    if (documentTypeId) {
      query += ` AND wt.document_type_id = $${paramIndex}`;
      params.push(documentTypeId);
      paramIndex++;
    }
    
    query += ' ORDER BY wt.name';
    
    const templates = await db.any(query, params);
    
    reply.send({ templates });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to get workflow templates' });
  }
});

// Create workflow template
fastify.post('/templates', {
  preHandler: authenticate,
  schema: {
    body: {
      type: 'object',
      required: ['name', 'workflowConfig'],
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        documentTypeId: { type: 'string' },
        workflowConfig: { type: 'object' }
      }
    }
  }
}, async (request, reply) => {
  try {
    const { name, description, documentTypeId, workflowConfig } = request.body;
    
    // Validate workflow config structure
    if (!workflowConfig.steps || !Array.isArray(workflowConfig.steps)) {
      return reply.code(400).send({ error: 'Invalid workflow configuration: steps array required' });
    }
    
    const template = await db.one(`
      INSERT INTO workflow_templates (name, description, document_type_id, workflow_config, created_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [name, description, documentTypeId, JSON.stringify(workflowConfig), request.user.id]);
    
    reply.code(201).send({ template });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to create workflow template' });
  }
});

// Start workflow for document
fastify.post('/start', {
  preHandler: authenticate,
  schema: startWorkflowSchema
}, async (request, reply) => {
  try {
    const { documentId, templateId, priority = 'normal', dueDate, comments } = request.body;
    
    // Validate document exists
    const document = await db.oneOrNone(`
      SELECT d.*, dt.name as document_type_name, p.name as project_name
      FROM documents d
      JOIN document_types dt ON d.document_type_id = dt.id
      JOIN projects p ON d.project_id = p.id
      WHERE d.id = $1
    `, [documentId]);
    
    if (!document) {
      return reply.code(404).send({ error: 'Document not found' });
    }
    
    // Get workflow template
    const template = await db.oneOrNone('SELECT * FROM workflow_templates WHERE id = $1 AND is_active = true', [templateId]);
    if (!template) {
      return reply.code(404).send({ error: 'Workflow template not found or inactive' });
    }
    
    // Check if document already has active workflow
    const activeWorkflow = await db.oneOrNone(
      'SELECT id FROM workflow_instances WHERE document_id = $1 AND status IN ($2, $3)',
      [documentId, 'pending', 'in_progress']
    );
    
    if (activeWorkflow) {
      return reply.code(409).send({ error: 'Document already has an active workflow' });
    }
    
    // Evaluate workflow conditions
    const context = {
      documentType: document.document_type_name,
      fileSize: document.file_size,
      projectStatus: 'active' // This could come from project data
    };
    
    const conditionsMet = await evaluateWorkflowConditions(template, context);
    if (!conditionsMet) {
      return reply.code(400).send({ error: 'Document does not meet workflow conditions' });
    }
    
    // Start the workflow
    const workflowInstance = await db.tx(async t => {
      // Create workflow instance
      const instance = await t.one(`
        INSERT INTO workflow_instances (
          document_id, template_id, status, initiated_by, 
          priority, due_date
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `, [documentId, templateId, 'pending', request.user.id, priority, dueDate]);
      
      // Create approval steps
      const steps = template.workflow_config.steps || [];
      for (const stepConfig of steps) {
        const approvers = await getNextApprovers(template.workflow_config, stepConfig.step);
        
        for (const approver of approvers) {
          await t.none(`
            INSERT INTO approval_steps (
              workflow_instance_id, step_number, step_name,
              approver_user_id, approver_role_id, status
            )
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [
            instance.id,
            stepConfig.step,
            stepConfig.name || `Step ${stepConfig.step}`,
            approver.type === 'user' || approver.type === 'role' ? approver.id : null,
            approver.type === 'role' ? null : null, // Role ID would need to be handled differently
            'pending'
          ]);
        }
      }
      
      // Update document status
      await t.none('UPDATE documents SET status = $1 WHERE id = $2', ['review', documentId]);
      
      return instance;
    });
    
    // Send notification
    await sendNotification('workflow_started', {
      workflowId: workflowInstance.id,
      documentId,
      documentTitle: document.title,
      initiatedBy: request.user.username,
      priority
    });
    
    reply.code(201).send({
      message: 'Workflow started successfully',
      workflowInstance: {
        id: workflowInstance.id,
        documentId,
        status: workflowInstance.status,
        currentStep: workflowInstance.current_step,
        priority: workflowInstance.priority
      }
    });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to start workflow' });
  }
});

// Get workflow instances
fastify.get('/instances', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { 
      status, documentId, assignedToMe, 
      page = 1, limit = 20 
    } = request.query;
    
    let query = `
      SELECT wi.*, d.title as document_title, d.file_name,
             p.name as project_name, wt.name as template_name,
             u.username as initiated_by_username,
             COUNT(*) OVER() as total_count
      FROM workflow_instances wi
      JOIN documents d ON wi.document_id = d.id
      JOIN projects p ON d.project_id = p.id
      JOIN workflow_templates wt ON wi.template_id = wt.id
      JOIN users u ON wi.initiated_by = u.id
    `;
    
    const conditions = [];
    const params = [];
    let paramIndex = 1;
    
    if (status) {
      conditions.push(`wi.status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }
    
    if (documentId) {
      conditions.push(`wi.document_id = $${paramIndex}`);
      params.push(documentId);
      paramIndex++;
    }
    
    if (assignedToMe === 'true') {
      query += ` 
        JOIN approval_steps ast ON wi.id = ast.workflow_instance_id
      `;
      conditions.push(`ast.approver_user_id = $${paramIndex}`);
      conditions.push(`ast.status = 'pending'`);
      conditions.push(`ast.step_number = wi.current_step`);
      params.push(request.user.id);
      paramIndex++;
    }
    
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    
    const offset = (page - 1) * limit;
    query += ` ORDER BY wi.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);
    
    const instances = await db.any(query, params);
    
    const totalCount = instances.length > 0 ? parseInt(instances[0].total_count) : 0;
    const workflowList = instances.map(row => {
      const { total_count, ...workflow } = row;
      return workflow;
    });
    
    reply.send({
      workflows: workflowList,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit)
      }
    });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to get workflow instances' });
  }
});

// Get workflow instance details
fastify.get('/instances/:workflowId', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { workflowId } = request.params;
    
    const workflow = await db.oneOrNone(`
      SELECT wi.*, d.title as document_title, d.file_name,
             p.name as project_name, wt.name as template_name,
             wt.workflow_config, u.username as initiated_by_username
      FROM workflow_instances wi
      JOIN documents d ON wi.document_id = d.id
      JOIN projects p ON d.project_id = p.id
      JOIN workflow_templates wt ON wi.template_id = wt.id
      JOIN users u ON wi.initiated_by = u.id
      WHERE wi.id = $1
    `, [workflowId]);
    
    if (!workflow) {
      return reply.code(404).send({ error: 'Workflow not found' });
    }
    
    // Get approval steps
    const steps = await db.any(`
      SELECT ast.*, u.username as approver_username,
             u.email as approver_email,
             du.username as delegated_to_username
      FROM approval_steps ast
      LEFT JOIN users u ON ast.approver_user_id = u.id
      LEFT JOIN users du ON ast.delegated_to = du.id
      WHERE ast.workflow_instance_id = $1
      ORDER BY ast.step_number
    `, [workflowId]);
    
    reply.send({
      workflow: {
        ...workflow,
        steps
      }
    });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to get workflow details' });
  }
});

// Approve/Reject workflow step
fastify.post('/instances/:workflowId/steps/:stepId/action', {
  preHandler: authenticate,
  schema: approvalActionSchema
}, async (request, reply) => {
  try {
    const { workflowId, stepId } = request.params;
    const { action, comments, delegateTo } = request.body;
    
    // Get workflow and step details
    const workflowStep = await db.oneOrNone(`
      SELECT wi.*, ast.*, d.title as document_title
      FROM workflow_instances wi
      JOIN approval_steps ast ON wi.id = ast.workflow_instance_id
      JOIN documents d ON wi.document_id = d.id
      WHERE wi.id = $1 AND ast.id = $2
    `, [workflowId, stepId]);
    
    if (!workflowStep) {
      return reply.code(404).send({ error: 'Workflow step not found' });
    }
    
    // Check if user is authorized to approve this step
    if (workflowStep.approver_user_id !== request.user.id && 
        workflowStep.delegated_to !== request.user.id) {
      // Check if user has the required role
      const userRoles = request.user.roles || [];
      const hasRequiredRole = await db.oneOrNone(`
        SELECT 1 FROM roles r 
        JOIN user_roles ur ON r.id = ur.role_id
        WHERE ur.user_id = $1 AND r.name = ANY($2)
      `, [request.user.id, userRoles]);
      
      if (!hasRequiredRole) {
        return reply.code(403).send({ error: 'Not authorized to perform this action' });
      }
    }
    
    if (workflowStep.status !== 'pending') {
      return reply.code(400).send({ error: 'Step has already been processed' });
    }
    
    // Process the action
    const result = await db.tx(async t => {
      let newStatus = workflowStep.status;
      let newWorkflowStatus = workflowStep.status;
      let nextStep = workflowStep.current_step;
      
      if (action === 'approve') {
        // Update step status
        await t.none(`
          UPDATE approval_steps 
          SET status = 'approved', comments = $1, approved_at = NOW()
          WHERE id = $2
        `, [comments, stepId]);
        
        // Check if this was the last step in current stage
        const remainingSteps = await t.oneOrNone(`
          SELECT COUNT(*) as count
          FROM approval_steps
          WHERE workflow_instance_id = $1 
            AND step_number = $2 
            AND status = 'pending'
        `, [workflowId, workflowStep.current_step]);
        
        if (parseInt(remainingSteps.count) === 0) {
          // Move to next step
          const maxStep = await t.oneOrNone(`
            SELECT MAX(step_number) as max_step
            FROM approval_steps
            WHERE workflow_instance_id = $1
          `, [workflowId]);
          
          if (workflowStep.current_step >= parseInt(maxStep.max_step)) {
            // Workflow completed
            newWorkflowStatus = 'completed';
            await t.none(`
              UPDATE workflow_instances 
              SET status = 'completed', completed_at = NOW()
              WHERE id = $1
            `, [workflowId]);
            
            // Update document status
            await t.none(`
              UPDATE documents SET status = 'approved' 
              WHERE id = $1
            `, [workflowStep.document_id]);
            
          } else {
            // Move to next step
            nextStep = workflowStep.current_step + 1;
            newWorkflowStatus = 'in_progress';
            await t.none(`
              UPDATE workflow_instances 
              SET current_step = $1, status = 'in_progress'
              WHERE id = $2
            `, [nextStep, workflowId]);
          }
        }
        
      } else if (action === 'reject') {
        // Update step and workflow status
        await t.none(`
          UPDATE approval_steps 
          SET status = 'rejected', comments = $1, approved_at = NOW()
          WHERE id = $2
        `, [comments, stepId]);
        
        await t.none(`
          UPDATE workflow_instances 
          SET status = 'cancelled', completed_at = NOW()
          WHERE id = $1
        `, [workflowId]);
        
        // Update document status
        await t.none(`
          UPDATE documents SET status = 'rejected' 
          WHERE id = $1
        `, [workflowStep.document_id]);
        
        newWorkflowStatus = 'cancelled';
        
      } else if (action === 'delegate') {
        if (!delegateTo) {
          throw new Error('Delegate target is required');
        }
        
        // Validate delegate target exists
        const delegateUser = await t.oneOrNone('SELECT id FROM users WHERE id = $1 AND is_active = true', [delegateTo]);
        if (!delegateUser) {
          throw new Error('Invalid delegate target');
        }
        
        await t.none(`
          UPDATE approval_steps 
          SET status = 'delegated', delegated_to = $1, comments = $2
          WHERE id = $3
        `, [delegateTo, comments, stepId]);
        
        newStatus = 'delegated';
      }
      
      return { newStatus, newWorkflowStatus, nextStep };
    });
    
    // Send notification
    await sendNotification('workflow_action', {
      workflowId,
      stepId,
      action,
      performedBy: request.user.username,
      documentTitle: workflowStep.document_title,
      comments
    });
    
    reply.send({
      message: `Step ${action}ed successfully`,
      workflowId,
      stepId,
      action,
      newStatus: result.newWorkflowStatus,
      currentStep: result.nextStep
    });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to process workflow action' });
  }
});

// Get pending approvals for user
fastify.get('/pending-approvals', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { page = 1, limit = 20 } = request.query;
    
    const offset = (page - 1) * limit;
    const approvals = await db.any(`
      SELECT wi.id as workflow_id, wi.priority, wi.due_date,
             d.id as document_id, d.title as document_title, d.file_name,
             p.name as project_name, ast.id as step_id, ast.step_name,
             ast.step_number, u.username as initiated_by,
             COUNT(*) OVER() as total_count
      FROM workflow_instances wi
      JOIN documents d ON wi.document_id = d.id
      JOIN projects p ON d.project_id = p.id
      JOIN approval_steps ast ON wi.id = ast.workflow_instance_id
      JOIN users u ON wi.initiated_by = u.id
      WHERE wi.status IN ('pending', 'in_progress')
        AND ast.status = 'pending'
        AND ast.step_number = wi.current_step
        AND (ast.approver_user_id = $1 OR ast.delegated_to = $1)
      ORDER BY wi.priority DESC, wi.due_date ASC NULLS LAST, wi.created_at ASC
      LIMIT $2 OFFSET $3
    `, [request.user.id, limit, offset]);
    
    const totalCount = approvals.length > 0 ? parseInt(approvals[0].total_count) : 0;
    const approvalList = approvals.map(row => {
      const { total_count, ...approval } = row;
      return approval;
    });
    
    reply.send({
      pendingApprovals: approvalList,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit)
      }
    });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to get pending approvals' });
  }
});

// Health check
fastify.get('/health', async (request, reply) => {
  try {
    await db.one('SELECT 1');
    await redis.ping();
    reply.send({ status: 'healthy', service: 'workflow-service' });
  } catch (error) {
    reply.code(503).send({ status: 'unhealthy', service: 'workflow-service' });
  }
});

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: process.env.PORT || 3003, host: '0.0.0.0' });
    fastify.log.info('Workflow service running on port 3003');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();