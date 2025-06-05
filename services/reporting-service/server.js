// reporting-service/server.js
import Fastify from 'fastify'

const fastify = Fastify({
  logger: true
})
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
// const path = require('path');

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
      roles: ['manager', 'user']
    };
  } catch (error) {
    reply.code(401).send({ error: 'Invalid token' });
  }
}

fastify.decorate('authenticate', authenticate);

// Utility functions
function processQueryTemplate(template, parameters) {
  let processedQuery = template;
  
  Object.keys(parameters).forEach(key => {
    const placeholder = `{{${key}}}`;
    let value = parameters[key];
    
    // Handle different data types
    if (typeof value === 'string') {
      value = `'${value.replace(/'/g, "''")}'`; // Escape single quotes
    } else if (value instanceof Date) {
      value = `'${value.toISOString()}'`;
    } else if (Array.isArray(value)) {
      value = `(${value.map(v => typeof v === 'string' ? `'${v}'` : v).join(',')})`;
    }
    
    processedQuery = processedQuery.replace(new RegExp(placeholder, 'g'), value);
  });
  
  return processedQuery;
}

async function generatePDFReport(reportData, title) {
  const doc = new PDFDocument();
  const chunks = [];
  
  doc.on('data', chunk => chunks.push(chunk));
  doc.on('end', () => {});
  
  // Header
  doc.fontSize(18).text(title, { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'right' });
  doc.moveDown(2);
  
  // Add content based on report type
  if (reportData.summary) {
    doc.fontSize(14).text('Summary', { underline: true });
    doc.moveDown();
    
    Object.entries(reportData.summary).forEach(([key, value]) => {
      doc.fontSize(12).text(`${key}: ${value}`);
    });
    doc.moveDown();
  }
  
  if (reportData.data && Array.isArray(reportData.data)) {
    doc.fontSize(14).text('Data', { underline: true });
    doc.moveDown();
    
    // Simple table-like format
    reportData.data.slice(0, 50).forEach((row, index) => { // Limit to 50 rows for PDF
      if (index === 0 && typeof row === 'object') {
        // Headers
        doc.fontSize(11).text(Object.keys(row).join(' | '), { continued: false });
        doc.text('─'.repeat(80));
      }
      
      if (typeof row === 'object') {
        doc.fontSize(10).text(Object.values(row).join(' | '));
      } else {
        doc.fontSize(10).text(row.toString());
      }
    });
  }
  
  doc.end();
  
  return new Promise((resolve) => {
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
  });
}

async function generateExcelReport(reportData, title) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Report');
  
  // Add title
  worksheet.addRow([title]);
  worksheet.addRow([`Generated on: ${new Date().toLocaleDateString()}`]);
  worksheet.addRow([]);
  
  // Add summary if available
  if (reportData.summary) {
    worksheet.addRow(['Summary']);
    Object.entries(reportData.summary).forEach(([key, value]) => {
      worksheet.addRow([key, value]);
    });
    worksheet.addRow([]);
  }
  
  // Add data
  if (reportData.data && Array.isArray(reportData.data) && reportData.data.length > 0) {
    const firstRow = reportData.data[0];
    
    if (typeof firstRow === 'object') {
      // Add headers
      worksheet.addRow(Object.keys(firstRow));
      
      // Add data rows
      reportData.data.forEach(row => {
        worksheet.addRow(Object.values(row));
      });
    }
  }
  
  // Style the worksheet
  worksheet.getRow(1).font = { bold: true, size: 14 };
  worksheet.getRow(4).font = { bold: true };
  
  const buffer = await workbook.xlsx.writeBuffer();
  return buffer;
}

function validateQuerySafety(query) {
  // Basic SQL injection prevention
  const dangerousPatterns = [
    /;\s*(drop|delete|truncate|alter|create|insert|update)\s+/i,
    /union\s+select/i,
    /exec\s*\(/i,
    /xp_cmdshell/i,
    /sp_executesql/i
  ];
  
  return !dangerousPatterns.some(pattern => pattern.test(query));
}

// Schemas
const executeReportSchema = {
  body: {
    type: 'object',
    required: ['reportDefinitionId'],
    properties: {
      reportDefinitionId: { type: 'string' },
      parameters: { type: 'object' },
      outputFormat: { type: 'string', enum: ['json', 'csv', 'pdf', 'excel'] }
    }
  }
};

const createReportDefinitionSchema = {
  body: {
    type: 'object',
    required: ['name', 'reportType', 'queryTemplate'],
    properties: {
      name: { type: 'string', maxLength: 255 },
      description: { type: 'string' },
      reportType: { type: 'string', enum: ['compliance', 'activity', 'performance', 'custom'] },
      queryTemplate: { type: 'string' },
      parametersSchema: { type: 'object' },
      outputFormat: { type: 'string', enum: ['json', 'csv', 'pdf', 'excel'] },
      isPublic: { type: 'boolean' }
    }
  }
};

// Routes

// Get available report definitions
fastify.get('/definitions', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { reportType, isPublic } = request.query;
    
    let query = `
      SELECT rd.*, u.username as created_by_username,
             COUNT(re.id) as execution_count
      FROM report_definitions rd
      JOIN users u ON rd.created_by = u.id
      LEFT JOIN report_executions re ON rd.id = re.report_definition_id
      WHERE (rd.created_by = $1 OR rd.is_public = true)
    `;
    
    const params = [request.user.id];
    let paramIndex = 2;
    
    if (reportType) {
      query += ` AND rd.report_type = $${paramIndex}`;
      params.push(reportType);
      paramIndex++;
    }
    
    if (isPublic !== undefined) {
      query += ` AND rd.is_public = $${paramIndex}`;
      params.push(isPublic === 'true');
      paramIndex++;
    }
    
    query += ` GROUP BY rd.id, u.username ORDER BY rd.created_at DESC`;
    
    const definitions = await db.any(query, params);
    
    reply.send({
      reportDefinitions: definitions.map(def => ({
        ...def,
        parameters_schema: def.parameters_schema || {},
        execution_count: parseInt(def.execution_count) || 0
      }))
    });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to get report definitions' });
  }
});

// Create new report definition
fastify.post('/definitions', {
  preHandler: authenticate,
  schema: createReportDefinitionSchema
}, async (request, reply) => {
  try {
    const {
      name, description, reportType, queryTemplate, parametersSchema,
      outputFormat = 'json', isPublic = false
    } = request.body;
    
    // Validate query template safety
    if (!validateQuerySafety(queryTemplate)) {
      return reply.code(400).send({ error: 'Query template contains potentially dangerous operations' });
    }
    
    // Test query template with empty parameters
    try {
      const testQuery = processQueryTemplate(queryTemplate, parametersSchema || {});
      await db.any('EXPLAIN ' + testQuery);
    } catch (error) {
      return reply.code(400).send({ 
        error: 'Invalid query template', 
        details: error.message 
      });
    }
    
    const reportDefinition = await db.one(`
      INSERT INTO report_definitions (
        name, description, report_type, query_template, 
        parameters_schema, output_format, is_public, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      name, description, reportType, queryTemplate,
      JSON.stringify(parametersSchema || {}), outputFormat, isPublic, request.user.id
    ]);
    
    reply.code(201).send({ reportDefinition });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to create report definition' });
  }
});

// Execute report
fastify.post('/execute', {
  preHandler: authenticate,
  schema: executeReportSchema
}, async (request, reply) => {
  try {
    const { reportDefinitionId, parameters = {}, outputFormat } = request.body;
    
    // Get report definition
    const reportDef = await db.oneOrNone(`
      SELECT * FROM report_definitions 
      WHERE id = $1 AND (created_by = $2 OR is_public = true)
    `, [reportDefinitionId, request.user.id]);
    
    if (!reportDef) {
      return reply.code(404).send({ error: 'Report definition not found' });
    }
    
    const startTime = Date.now();
    
    // Start report execution record
    const execution = await db.one(`
      INSERT INTO report_executions (
        report_definition_id, executed_by, parameters, status
      )
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [reportDefinitionId, request.user.id, JSON.stringify(parameters), 'running']);
    
    try {
      // Process query template
      const processedQuery = processQueryTemplate(reportDef.query_template, parameters);
      
      // Execute query
      const queryResult = await db.any(processedQuery);
      const executionTime = Date.now() - startTime;
      
      // Prepare result data
      const resultData = {
        reportId: execution.id,
        reportName: reportDef.name,
        executedAt: execution.started_at,
        executedBy: request.user.username,
        parameters,
        executionTimeMs: executionTime,
        data: queryResult,
        summary: {
          totalRecords: queryResult.length,
          executionTime: `${executionTime}ms`
        }
      };
      
      // Handle different output formats
      const format = outputFormat || reportDef.output_format || 'json';
      
      let outputData;
      let contentType;
      let filename;
      
      switch (format) {
        case 'csv':
          if (queryResult.length > 0 && typeof queryResult[0] === 'object') {
            const headers = Object.keys(queryResult[0]);
            let csvContent = headers.join(',') + '\n';
            
            queryResult.forEach(row => {
              const values = headers.map(header => {
                const value = row[header];
                if (value === null || value === undefined) return '';
                if (typeof value === 'string' && value.includes(',')) {
                  return `"${value.replace(/"/g, '""')}"`;
                }
                return value;
              });
              csvContent += values.join(',') + '\n';
            });
            
            outputData = csvContent;
            contentType = 'text/csv';
            filename = `report_${execution.id}.csv`;
          } else {
            outputData = 'No data available';
            contentType = 'text/plain';
            filename = `report_${execution.id}.txt`;
          }
          break;
          
        case 'pdf':
          outputData = await generatePDFReport(resultData, reportDef.name);
          contentType = 'application/pdf';
          filename = `report_${execution.id}.pdf`;
          break;
          
        case 'excel':
          outputData = await generateExcelReport(resultData, reportDef.name);
          contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
          filename = `report_${execution.id}.xlsx`;
          break;
          
        default: // json
          outputData = resultData;
          contentType = 'application/json';
          break;
      }
      
      // Update execution record
      await db.none(`
        UPDATE report_executions 
        SET status = $1, result_data = $2, execution_time_ms = $3, completed_at = NOW()
        WHERE id = $4
      `, ['completed', JSON.stringify({ recordCount: queryResult.length }), executionTime, execution.id]);
      
      // Send response based on format
      if (format === 'json') {
        reply.send(outputData);
      } else {
        reply
          .header('Content-Type', contentType)
          .header('Content-Disposition', `attachment; filename="${filename}"`)
          .send(outputData);
      }
      
    } catch (queryError) {
      // Update execution record with error
      await db.none(`
        UPDATE report_executions 
        SET status = $1, result_data = $2, completed_at = NOW()
        WHERE id = $3
      `, ['failed', JSON.stringify({ error: queryError.message }), execution.id]);
      
      throw queryError;
    }
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to execute report', details: error.message });
  }
});

// Get report execution history
fastify.get('/executions', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { reportDefinitionId, status, page = 1, limit = 20 } = request.query;
    
    let query = `
      SELECT re.*, rd.name as report_name, u.username as executed_by_username,
             COUNT(*) OVER() as total_count
      FROM report_executions re
      JOIN report_definitions rd ON re.report_definition_id = rd.id
      JOIN users u ON re.executed_by = u.id
      WHERE re.executed_by = $1
    `;
    
    const params = [request.user.id];
    let paramIndex = 2;
    
    if (reportDefinitionId) {
      query += ` AND re.report_definition_id = $${paramIndex}`;
      params.push(reportDefinitionId);
      paramIndex++;
    }
    
    if (status) {
      query += ` AND re.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }
    
    const offset = (page - 1) * limit;
    query += ` ORDER BY re.started_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);
    
    const results = await db.any(query, params);
    
    const totalCount = results.length > 0 ? parseInt(results[0].total_count) : 0;
    const executions = results.map(row => {
      const { total_count, ...execution } = row;
      return {
        ...execution,
        parameters: execution.parameters ? JSON.parse(execution.parameters) : {},
        result_data: execution.result_data ? JSON.parse(execution.result_data) : null
      };
    });
    
    reply.send({
      executions,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit)
      }
    });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to get execution history' });
  }
});

// Get specific execution details
fastify.get('/executions/:executionId', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { executionId } = request.params;
    
    const execution = await db.oneOrNone(`
      SELECT re.*, rd.name as report_name, rd.description,
             u.username as executed_by_username
      FROM report_executions re
      JOIN report_definitions rd ON re.report_definition_id = rd.id
      JOIN users u ON re.executed_by = u.id
      WHERE re.id = $1 AND re.executed_by = $2
    `, [executionId, request.user.id]);
    
    if (!execution) {
      return reply.code(404).send({ error: 'Execution not found' });
    }
    
    reply.send({
      execution: {
        ...execution,
        parameters: execution.parameters ? JSON.parse(execution.parameters) : {},
        result_data: execution.result_data ? JSON.parse(execution.result_data) : null
      }
    });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to get execution details' });
  }
});

// Pre-built reports

// Document activity report
fastify.get('/documents/activity', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { dateFrom, dateTo, projectId, documentTypeId, outputFormat = 'json' } = request.query;
    
    let query = `
      SELECT d.title, d.file_name, d.status, d.created_at as upload_date,
             p.name as project_name, dt.name as document_type,
             u.username as uploaded_by,
             COALESCE(wi.status, 'no_workflow') as workflow_status
      FROM documents d
      JOIN projects p ON d.project_id = p.id
      JOIN document_types dt ON d.document_type_id = dt.id
      JOIN users u ON d.uploaded_by = u.id
      LEFT JOIN workflow_instances wi ON d.id = wi.document_id
      WHERE 1=1
    `;
    
    const params = [];
    let paramIndex = 1;
    
    if (dateFrom) {
      query += ` AND d.created_at >= $${paramIndex}`;
      params.push(dateFrom);
      paramIndex++;
    }
    
    if (dateTo) {
      query += ` AND d.created_at <= $${paramIndex}`;
      params.push(dateTo + ' 23:59:59');
      paramIndex++;
    }
    
    if (projectId) {
      query += ` AND d.project_id = $${paramIndex}`;
      params.push(projectId);
      paramIndex++;
    }
    
    if (documentTypeId) {
      query += ` AND d.document_type_id = $${paramIndex}`;
      params.push(documentTypeId);
      paramIndex++;
    }
    
    query += ` ORDER BY d.created_at DESC`;
    
    const results = await db.any(query, params);
    
    const reportData = {
      reportName: 'Document Activity Report',
      generatedAt: new Date(),
      filters: { dateFrom, dateTo, projectId, documentTypeId },
      summary: {
        totalDocuments: results.length,
        uploadedToday: results.filter(r => 
          new Date(r.upload_date).toDateString() === new Date().toDateString()
        ).length,
        pendingApproval: results.filter(r => r.workflow_status === 'pending').length,
        approved: results.filter(r => r.status === 'approved').length
      },
      data: results
    };
    
    if (outputFormat === 'json') {
      reply.send(reportData);
    } else if (outputFormat === 'csv') {
      const headers = ['Title', 'File Name', 'Status', 'Upload Date', 'Project', 'Type', 'Uploaded By'];
      let csvContent = headers.join(',') + '\n';
      
      results.forEach(row => {
        const values = [
          `"${row.title}"`,
          `"${row.file_name}"`,
          row.status,
          row.upload_date,
          `"${row.project_name}"`,
          `"${row.document_type}"`,
          row.uploaded_by
        ];
        csvContent += values.join(',') + '\n';
      });
      
      reply
        .header('Content-Type', 'text/csv')
        .header('Content-Disposition', 'attachment; filename="document_activity_report.csv"')
        .send(csvContent);
    }
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to generate document activity report' });
  }
});

// Compliance status report
fastify.get('/compliance/status', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { documentTypeId, complianceStatus, outputFormat = 'json' } = request.query;
    
    let query = `
      SELECT d.title, d.file_name, dt.name as document_type,
             ce.event_type, ce.compliance_status, ce.regulation_reference,
             ce.recorded_at, u.username as reviewed_by
      FROM documents d
      JOIN document_types dt ON d.document_type_id = dt.id
      LEFT JOIN compliance_events ce ON d.id = ce.document_id
      LEFT JOIN users u ON ce.reviewed_by = u.id
      WHERE 1=1
    `;
    
    const params = [];
    let paramIndex = 1;
    
    if (documentTypeId) {
      query += ` AND d.document_type_id = $${paramIndex}`;
      params.push(documentTypeId);
      paramIndex++;
    }
    
    if (complianceStatus) {
      query += ` AND ce.compliance_status = $${paramIndex}`;
      params.push(complianceStatus);
      paramIndex++;
    }
    
    query += ` ORDER BY d.created_at DESC`;
    
    const results = await db.any(query, params);
    
    const reportData = {
      reportName: 'Compliance Status Report',
      generatedAt: new Date(),
      filters: { documentTypeId, complianceStatus },
      summary: {
        totalDocuments: results.length,
        compliant: results.filter(r => r.compliance_status === 'compliant').length,
        nonCompliant: results.filter(r => r.compliance_status === 'non_compliant').length,
        pendingReview: results.filter(r => r.compliance_status === 'pending_review').length,
        noComplianceRecord: results.filter(r => !r.compliance_status).length
      },
      data: results
    };
    
    reply.send(reportData);
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to generate compliance status report' });
  }
});

// User activity report
fastify.get('/users/activity', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { dateFrom, dateTo, userId, outputFormat = 'json' } = request.query;
    
    let query = `
      SELECT u.username, u.first_name, u.last_name,
             COUNT(d.id) as documents_uploaded,
             COUNT(wi.id) as workflows_initiated,
             COUNT(ast.id) as approvals_completed,
             MAX(al.timestamp) as last_activity
      FROM users u
      LEFT JOIN documents d ON u.id = d.uploaded_by
      LEFT JOIN workflow_instances wi ON u.id = wi.initiated_by
      LEFT JOIN approval_steps ast ON u.id = ast.approver_user_id AND ast.status IN ('approved', 'rejected')
      LEFT JOIN audit_logs al ON u.id = al.user_id
      WHERE u.is_active = true
    `;
    
    const params = [];
    let paramIndex = 1;
    
    if (dateFrom) {
      query += ` AND (
        d.created_at >= $${paramIndex} OR 
        wi.started_at >= $${paramIndex} OR 
        ast.approved_at >= $${paramIndex}
      )`;
      params.push(dateFrom);
      paramIndex++;
    }
    
    if (dateTo) {
      const endDate = dateTo + ' 23:59:59';
      query += ` AND (
        d.created_at <= $${paramIndex} OR 
        wi.started_at <= $${paramIndex} OR 
        ast.approved_at <= $${paramIndex}
      )`;
      params.push(endDate);
      paramIndex++;
    }
    
    if (userId) {
      query += ` AND u.id = $${paramIndex}`;
      params.push(userId);
      paramIndex++;
    }
    
    query += ` GROUP BY u.id, u.username, u.first_name, u.last_name ORDER BY last_activity DESC NULLS LAST`;
    
    const results = await db.any(query, params);
    
    const reportData = {
      reportName: 'User Activity Report',
      generatedAt: new Date(),
      filters: { dateFrom, dateTo, userId },
      summary: {
        totalUsers: results.length,
        activeUsers: results.filter(r => r.last_activity).length,
        totalDocumentsUploaded: results.reduce((sum, r) => sum + parseInt(r.documents_uploaded), 0),
        totalWorkflowsInitiated: results.reduce((sum, r) => sum + parseInt(r.workflows_initiated), 0),
        totalApprovalsCompleted: results.reduce((sum, r) => sum + parseInt(r.approvals_completed), 0)
      },
      data: results
    };
    
    reply.send(reportData);
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to generate user activity report' });
  }
});

// System performance metrics
fastify.get('/system/performance', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { dateFrom = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() } = request.query;
    
    // Get various performance metrics
    const [
      documentStats,
      workflowStats,
      searchStats,
      storageStats
    ] = await Promise.all([
      // Document statistics
      db.one(`
        SELECT 
          COUNT(*) as total_documents,
          COUNT(CASE WHEN created_at >= $1 THEN 1 END) as new_documents,
          AVG(file_size) as avg_file_size,
          SUM(file_size) as total_storage
        FROM documents
      `, [dateFrom]),
      
      // Workflow statistics
      db.one(`
        SELECT 
          COUNT(*) as total_workflows,
          COUNT(CASE WHEN started_at >= $1 THEN 1 END) as new_workflows,
          AVG(EXTRACT(EPOCH FROM (completed_at - started_at))/3600) as avg_completion_hours,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_workflows
        FROM workflow_instances
      `, [dateFrom]),
      
      // Search statistics
      db.one(`
        SELECT 
          COUNT(*) as total_searches,
          AVG(execution_time_ms) as avg_search_time_ms,
          AVG(results_count) as avg_results_count
        FROM search_analytics
        WHERE searched_at >= $1
      `, [dateFrom]),
      
      // Storage statistics by document type
      db.any(`
        SELECT dt.name as document_type,
               COUNT(d.id) as document_count,
               SUM(d.file_size) as total_size,
               AVG(d.file_size) as avg_size
        FROM documents d
        JOIN document_types dt ON d.document_type_id = dt.id
        WHERE d.created_at >= $1
        GROUP BY dt.id, dt.name
        ORDER BY total_size DESC
      `, [dateFrom])
    ]);
    
    reply.send({
      reportName: 'System Performance Metrics',
      generatedAt: new Date(),
      period: { from: dateFrom, to: new Date() },
      metrics: {
        documents: documentStats,
        workflows: workflowStats,
        search: searchStats,
        storageByType: storageStats
      }
    });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to generate performance metrics' });
  }
});

// Health check
fastify.get('/health', async (request, reply) => {
  try {
    await db.one('SELECT 1');
    reply.send({ status: 'healthy', service: 'reporting-service' });
  } catch (error) {
    reply.code(503).send({ status: 'unhealthy', service: 'reporting-service' });
  }
});

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: process.env.PORT || 3007, host: '0.0.0.0' });
    fastify.log.info('Reporting service running on port 3007');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();