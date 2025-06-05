// search-service/server.js
import Fastify from 'fastify'

const fastify = Fastify({
  logger: true
})

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
    request.user = { id: 'user-123', username: 'testuser' };
  } catch (error) {
    reply.code(401).send({ error: 'Invalid token' });
  }
}

fastify.decorate('authenticate', authenticate);

// // Utility functions
// function buildSearchVector(text) {
//   // Simple text processing for search vector
//   return text
//     .toLowerCase()
//     .replace(/[^\w\s]/g, ' ')
//     .split(/\s+/)
//     .filter(word => word.length > 2)
//     .join(' ');
// }

function highlightSearchTerms(text, searchTerms) {
  if (!text || !searchTerms) return text;
  
  const terms = searchTerms.split(/\s+/).filter(term => term.length > 2);
  let highlightedText = text;
  
  terms.forEach(term => {
    const regex = new RegExp(`(${term})`, 'gi');
    highlightedText = highlightedText.replace(regex, '<mark>$1</mark>');
  });
  
  return highlightedText;
}

function calculateRelevanceScore(document, searchTerms) {
  let score = 0;
  const terms = searchTerms.toLowerCase().split(/\s+/).filter(term => term.length > 2);
  
  terms.forEach(term => {
    // Title matches get highest score
    if (document.title.toLowerCase().includes(term)) {
      score += 10;
    }
    
    // Description matches get medium score
    if (document.description && document.description.toLowerCase().includes(term)) {
      score += 5;
    }
    
    // Filename matches get low score
    if (document.file_name.toLowerCase().includes(term)) {
      score += 3;
    }
    
    // Tag matches get medium score
    if (document.tags && document.tags.some(tag => tag.toLowerCase().includes(term))) {
      score += 7;
    }
    
    // Metadata matches get low score
    if (document.metadata && JSON.stringify(document.metadata).toLowerCase().includes(term)) {
      score += 2;
    }
  });
  
  return score;
}

// Schemas
const searchSchema = {
  querystring: {
    type: 'object',
    properties: {
      q: { type: 'string' },
      projectId: { type: 'string' },
      documentTypeId: { type: 'string' },
      status: { type: 'string' },
      tags: { type: 'string' }, // comma-separated
      dateFrom: { type: 'string', format: 'date' },
      dateTo: { type: 'string', format: 'date' },
      fileType: { type: 'string' },
      uploadedBy: { type: 'string' },
      sortBy: { type: 'string', enum: ['relevance', 'date', 'title', 'size'] },
      sortOrder: { type: 'string', enum: ['asc', 'desc'] },
      page: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100 }
    }
  }
};

const saveSearchSchema = {
  body: {
    type: 'object',
    required: ['name', 'queryParams'],
    properties: {
      name: { type: 'string', maxLength: 255 },
      queryParams: { type: 'object' },
      isPublic: { type: 'boolean' }
    }
  }
};

// Routes

// Full-text search
fastify.get('/documents', {
  preHandler: authenticate,
  schema: searchSchema
}, async (request, reply) => {
  try {
    const startTime = Date.now();
    const {
      q, projectId, documentTypeId, status, tags, dateFrom, dateTo,
      fileType, uploadedBy, sortBy = 'relevance', sortOrder = 'desc',
      page = 1, limit = 20
    } = request.query;
    
    let query = `
      SELECT d.*, dt.name as document_type_name, p.name as project_name,
             u.username as uploaded_by_username,
             u.first_name || ' ' || u.last_name as uploaded_by_full_name,
             COUNT(*) OVER() as total_count
      FROM documents d
      JOIN document_types dt ON d.document_type_id = dt.id
      JOIN projects p ON d.project_id = p.id
      JOIN users u ON d.uploaded_by = u.id
    `;
    
    const conditions = [];
    const params = [];
    let paramIndex = 1;
    
    // Full-text search
    if (q) {
      query += `
        LEFT JOIN search_indexes si ON d.id = si.document_id
      `;
      conditions.push(`(
        d.title ILIKE $${paramIndex} OR 
        d.description ILIKE $${paramIndex} OR
        d.file_name ILIKE $${paramIndex} OR
        si.content_vector @@ plainto_tsquery($${paramIndex + 1}) OR
        si.metadata_vector @@ plainto_tsquery($${paramIndex + 1})
      )`);
      params.push(`%${q}%`, q);
      paramIndex += 2;
    }
    
    // Project filter
    if (projectId) {
      conditions.push(`d.project_id = $${paramIndex}`);
      params.push(projectId);
      paramIndex++;
    }
    
    // Document type filter
    if (documentTypeId) {
      conditions.push(`d.document_type_id = $${paramIndex}`);
      params.push(documentTypeId);
      paramIndex++;
    }
    
    // Status filter
    if (status) {
      conditions.push(`d.status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }
    
    // Tags filter
    if (tags) {
      const tagArray = tags.split(',').map(tag => tag.trim());
      conditions.push(`d.tags && $${paramIndex}`);
      params.push(tagArray);
      paramIndex++;
    }
    
    // Date range filter
    if (dateFrom) {
      conditions.push(`d.created_at >= $${paramIndex}`);
      params.push(dateFrom);
      paramIndex++;
    }
    
    if (dateTo) {
      conditions.push(`d.created_at <= $${paramIndex}`);
      params.push(dateTo + ' 23:59:59');
      paramIndex++;
    }
    
    // File type filter
    if (fileType) {
      conditions.push(`d.mime_type ILIKE $${paramIndex}`);
      params.push(`%${fileType}%`);
      paramIndex++;
    }
    
    // Uploaded by filter
    if (uploadedBy) {
      conditions.push(`u.username ILIKE $${paramIndex}`);
      params.push(`%${uploadedBy}%`);
      paramIndex++;
    }
    
    // Add WHERE clause if conditions exist
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    
    // Sorting
    let orderBy = '';
    switch (sortBy) {
      case 'date':
        orderBy = `d.created_at ${sortOrder.toUpperCase()}`;
        break;
      case 'title':
        orderBy = `d.title ${sortOrder.toUpperCase()}`;
        break;
      case 'size':
        orderBy = `d.file_size ${sortOrder.toUpperCase()}`;
        break;
      case 'relevance':
      default:
        if (q) {
          orderBy = `
            CASE 
              WHEN d.title ILIKE $${params.indexOf(`%${q}%`) + 1} THEN 3
              WHEN d.description ILIKE $${params.indexOf(`%${q}%`) + 1} THEN 2
              WHEN d.file_name ILIKE $${params.indexOf(`%${q}%`) + 1} THEN 1
              ELSE 0
            END DESC, d.created_at DESC
          `;
        } else {
          orderBy = 'd.created_at DESC';
        }
        break;
    }
    
    query += ` ORDER BY ${orderBy}`;
    
    // Pagination
    const offset = (page - 1) * limit;
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);
    
    const results = await db.any(query, params);
    const executionTime = Date.now() - startTime;
    
    const totalCount = results.length > 0 ? parseInt(results[0].total_count) : 0;
    let documents = results.map(row => {
      const { total_count, ...document } = row;
      return document;
    });
    
    // Calculate relevance scores and add highlights if searching
    if (q) {
      documents = documents.map(doc => ({
        ...doc,
        relevanceScore: calculateRelevanceScore(doc, q),
        highlights: {
          title: highlightSearchTerms(doc.title, q),
          description: highlightSearchTerms(doc.description, q),
          fileName: highlightSearchTerms(doc.file_name, q)
        }
      }));
      
      // Re-sort by relevance if that's the sort criteria
      if (sortBy === 'relevance') {
        documents.sort((a, b) => {
          if (sortOrder === 'desc') {
            return b.relevanceScore - a.relevanceScore;
          }
          return a.relevanceScore - b.relevanceScore;
        });
      }
    }
    
    // Log search analytics
    try {
      await db.none(`
        INSERT INTO search_analytics (user_id, query, filters, results_count, execution_time_ms)
        VALUES ($1, $2, $3, $4, $5)
      `, [
        request.user.id,
        q || '',
        JSON.stringify(request.query),
        totalCount,
        executionTime
      ]);
    } catch (analyticsError) {
      fastify.log.warn('Failed to log search analytics:', analyticsError);
    }
    
    reply.send({
      documents,
      searchQuery: q || '',
      filters: {
        projectId, documentTypeId, status, tags, dateFrom, dateTo, fileType, uploadedBy
      },
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit)
      },
      meta: {
        executionTimeMs: executionTime,
        sortBy,
        sortOrder
      }
    });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Search failed' });
  }
});

// Advanced search with complex filters
fastify.post('/documents/advanced', {
  preHandler: authenticate,
  schema: {
    body: {
      type: 'object',
      properties: {
        textQuery: { type: 'string' },
        filters: {
          type: 'object',
          properties: {
            projects: { type: 'array', items: { type: 'string' } },
            documentTypes: { type: 'array', items: { type: 'string' } },
            statuses: { type: 'array', items: { type: 'string' } },
            tags: { type: 'array', items: { type: 'string' } },
            dateRange: {
              type: 'object',
              properties: {
                from: { type: 'string', format: 'date' },
                to: { type: 'string', format: 'date' }
              }
            },
            sizeRange: {
              type: 'object',
              properties: {
                min: { type: 'integer' },
                max: { type: 'integer' }
              }
            },
            uploadedBy: { type: 'array', items: { type: 'string' } },
            metadata: { type: 'object' }
          }
        },
        sortBy: { type: 'string', enum: ['relevance', 'date', 'title', 'size'] },
        sortOrder: { type: 'string', enum: ['asc', 'desc'] },
        page: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 100 }
      }
    }
  }
}, async (request, reply) => {
  try {
    const startTime = Date.now();
    const {
      textQuery, filters = {}, sortBy = 'relevance', sortOrder = 'desc',
      page = 1, limit = 20
    } = request.body;
    
    let query = `
      SELECT d.*, dt.name as document_type_name, p.name as project_name,
             u.username as uploaded_by_username,
             COUNT(*) OVER() as total_count
      FROM documents d
      JOIN document_types dt ON d.document_type_id = dt.id
      JOIN projects p ON d.project_id = p.id
      JOIN users u ON d.uploaded_by = u.id
    `;
    
    const conditions = [];
    const params = [];
    let paramIndex = 1;
    
    // Text search
    if (textQuery) {
      query += ` LEFT JOIN search_indexes si ON d.id = si.document_id`;
      conditions.push(`(
        d.title ILIKE $${paramIndex} OR 
        d.description ILIKE $${paramIndex} OR
        si.content_vector @@ plainto_tsquery($${paramIndex + 1})
      )`);
      params.push(`%${textQuery}%`, textQuery);
      paramIndex += 2;
    }
    
    // Project filters
    if (filters.projects && filters.projects.length > 0) {
      conditions.push(`d.project_id = ANY($${paramIndex})`);
      params.push(filters.projects);
      paramIndex++;
    }
    
    // Document type filters
    if (filters.documentTypes && filters.documentTypes.length > 0) {
      conditions.push(`d.document_type_id = ANY($${paramIndex})`);
      params.push(filters.documentTypes);
      paramIndex++;
    }
    
    // Status filters
    if (filters.statuses && filters.statuses.length > 0) {
      conditions.push(`d.status = ANY($${paramIndex})`);
      params.push(filters.statuses);
      paramIndex++;
    }
    
    // Tag filters
    if (filters.tags && filters.tags.length > 0) {
      conditions.push(`d.tags && $${paramIndex}`);
      params.push(filters.tags);
      paramIndex++;
    }
    
    // Date range filter
    if (filters.dateRange) {
      if (filters.dateRange.from) {
        conditions.push(`d.created_at >= $${paramIndex}`);
        params.push(filters.dateRange.from);
        paramIndex++;
      }
      if (filters.dateRange.to) {
        conditions.push(`d.created_at <= $${paramIndex}`);
        params.push(filters.dateRange.to + ' 23:59:59');
        paramIndex++;
      }
    }
    
    // Size range filter
    if (filters.sizeRange) {
      if (filters.sizeRange.min !== undefined) {
        conditions.push(`d.file_size >= $${paramIndex}`);
        params.push(filters.sizeRange.min);
        paramIndex++;
      }
      if (filters.sizeRange.max !== undefined) {
        conditions.push(`d.file_size <= $${paramIndex}`);
        params.push(filters.sizeRange.max);
        paramIndex++;
      }
    }
    
    // Uploaded by filter
    if (filters.uploadedBy && filters.uploadedBy.length > 0) {
      conditions.push(`u.id = ANY($${paramIndex})`);
      params.push(filters.uploadedBy);
      paramIndex++;
    }
    
    // Metadata filter
    if (filters.metadata && Object.keys(filters.metadata).length > 0) {
      conditions.push(`d.metadata @> $${paramIndex}`);
      params.push(JSON.stringify(filters.metadata));
      paramIndex++;
    }
    
    // Add WHERE clause
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    
    // Sorting
    let orderBy = 'd.created_at DESC';
    switch (sortBy) {
      case 'date':
        orderBy = `d.created_at ${sortOrder.toUpperCase()}`;
        break;
      case 'title':
        orderBy = `d.title ${sortOrder.toUpperCase()}`;
        break;
      case 'size':
        orderBy = `d.file_size ${sortOrder.toUpperCase()}`;
        break;
    }
    
    query += ` ORDER BY ${orderBy}`;
    
    // Pagination
    const offset = (page - 1) * limit;
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);
    
    const results = await db.any(query, params);
    const executionTime = Date.now() - startTime;
    
    const totalCount = results.length > 0 ? parseInt(results[0].total_count) : 0;
    const documents = results.map(row => {
      const { total_count, ...document } = row;
      return document;
    });
    
    // Log search analytics
    try {
      await db.none(`
        INSERT INTO search_analytics (user_id, query, filters, results_count, execution_time_ms)
        VALUES ($1, $2, $3, $4, $5)
      `, [
        request.user.id,
        textQuery || '',
        JSON.stringify({ textQuery, filters }),
        totalCount,
        executionTime
      ]);
    } catch (analyticsError) {
      fastify.log.warn('Failed to log search analytics:', analyticsError);
    }
    
    reply.send({
      documents,
      searchQuery: textQuery || '',
      appliedFilters: filters,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit)
      },
      meta: {
        executionTimeMs: executionTime,
        sortBy,
        sortOrder
      }
    });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Advanced search failed' });
  }
});

// Save search query
fastify.post('/saved-searches', {
  preHandler: authenticate,
  schema: saveSearchSchema
}, async (request, reply) => {
  try {
    const { name, queryParams, isPublic = false } = request.body;
    
    const savedSearch = await db.one(`
      INSERT INTO saved_searches (user_id, name, query_params, is_public)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [request.user.id, name, JSON.stringify(queryParams), isPublic]);
    
    reply.code(201).send({ savedSearch });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to save search' });
  }
});

// Get saved searches
fastify.get('/saved-searches', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { includePublic = true } = request.query;
    
    let query = `
      SELECT ss.*, u.username as created_by_username
      FROM saved_searches ss
      JOIN users u ON ss.user_id = u.id
      WHERE ss.user_id = $1
    `;
    
    const params = [request.user.id];
    
    if (includePublic === 'true') {
      query += ` OR ss.is_public = true`;
    }
    
    query += ` ORDER BY ss.created_at DESC`;
    
    const savedSearches = await db.any(query, params);
    
    reply.send({ savedSearches });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to get saved searches' });
  }
});

// Execute saved search
fastify.get('/saved-searches/:searchId/execute', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { searchId } = request.params;
    const { page = 1, limit = 20 } = request.query;
    
    const savedSearch = await db.oneOrNone(
      'SELECT * FROM saved_searches WHERE id = $1 AND (user_id = $2 OR is_public = true)',
      [searchId, request.user.id]
    );
    
    if (!savedSearch) {
      return reply.code(404).send({ error: 'Saved search not found' });
    }
    
    // Execute the saved search by forwarding to the search endpoint
    const searchParams = {
      ...savedSearch.query_params,
      page,
      limit
    };
    
    // Forward to the main search endpoint
    request.query = searchParams;
    return fastify.inject({
      method: 'GET',
      url: '/documents',
      headers: request.headers,
      query: searchParams
    }).then(response => {
      reply.send(response.json());
    });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to execute saved search' });
  }
});

// Delete saved search
fastify.delete('/saved-searches/:searchId', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { searchId } = request.params;
    
    const result = await db.result(
      'DELETE FROM saved_searches WHERE id = $1 AND user_id = $2',
      [searchId, request.user.id]
    );
    
    if (result.rowCount === 0) {
      return reply.code(404).send({ error: 'Saved search not found' });
    }
    
    reply.send({ message: 'Saved search deleted successfully' });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to delete saved search' });
  }
});

// Get search suggestions/autocomplete
fastify.get('/suggestions', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { q, type = 'all', limit = 10 } = request.query;
    
    if (!q || q.length < 2) {
      return reply.send({ suggestions: [] });
    }
    
    const suggestions = [];
    
    if (type === 'all' || type === 'documents') {
      // Document title suggestions
      const titleSuggestions = await db.any(`
        SELECT DISTINCT title as suggestion, 'document_title' as type
        FROM documents
        WHERE title ILIKE $1
        ORDER BY title
        LIMIT $2
      `, [`%${q}%`, Math.floor(limit / 3)]);
      
      suggestions.push(...titleSuggestions);
    }
    
    if (type === 'all' || type === 'tags') {
      // Tag suggestions
      const tagSuggestions = await db.any(`
        SELECT DISTINCT unnest(tags) as suggestion, 'tag' as type
        FROM documents
        WHERE unnest(tags) ILIKE $1
        ORDER BY unnest(tags)
        LIMIT $2
      `, [`%${q}%`, Math.floor(limit / 3)]);
      
      suggestions.push(...tagSuggestions);
    }
    
    if (type === 'all' || type === 'users') {
      // User suggestions
      const userSuggestions = await db.any(`
        SELECT DISTINCT username as suggestion, 'user' as type
        FROM users
        WHERE username ILIKE $1 AND is_active = true
        ORDER BY username
        LIMIT $2
      `, [`%${q}%`, Math.floor(limit / 3)]);
      
      suggestions.push(...userSuggestions);
    }
    
    reply.send({
      query: q,
      suggestions: suggestions.slice(0, limit)
    });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to get suggestions' });
  }
});

// Get search analytics
fastify.get('/analytics', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { dateFrom, dateTo, limit = 100 } = request.query;
    
    let query = `
      SELECT query, COUNT(*) as search_count,
             AVG(results_count) as avg_results,
             AVG(execution_time_ms) as avg_execution_time
      FROM search_analytics
      WHERE user_id = $1
    `;
    
    const params = [request.user.id];
    let paramIndex = 2;
    
    if (dateFrom) {
      query += ` AND searched_at >= $${paramIndex}`;
      params.push(dateFrom);
      paramIndex++;
    }
    
    if (dateTo) {
      query += ` AND searched_at <= $${paramIndex}`;
      params.push(dateTo + ' 23:59:59');
      paramIndex++;
    }
    
    query += `
      GROUP BY query
      HAVING COUNT(*) > 1
      ORDER BY search_count DESC
      LIMIT $${paramIndex}
    `;
    params.push(limit);
    
    const analytics = await db.any(query, params);
    
    // Get recent searches
    const recentSearches = await db.any(`
      SELECT query, results_count, execution_time_ms, searched_at
      FROM search_analytics
      WHERE user_id = $1
      ORDER BY searched_at DESC
      LIMIT 20
    `, [request.user.id]);
    
    reply.send({
      popularQueries: analytics,
      recentSearches
    });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to get search analytics' });
  }
});

// Reindex document for search
fastify.post('/reindex/:documentId', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { documentId } = request.params;
    
    // Get document details
    const document = await db.oneOrNone(`
      SELECT d.*, dt.name as document_type_name
      FROM documents d
      JOIN document_types dt ON d.document_type_id = dt.id
      WHERE d.id = $1
    `, [documentId]);
    
    if (!document) {
      return reply.code(404).send({ error: 'Document not found' });
    }
    
    // Create search vectors
    const contentText = [
      document.title,
      document.description || '',
      document.file_name,
      document.document_type_name,
      (document.tags || []).join(' ')
    ].join(' ');
    
    const metadataText = JSON.stringify(document.metadata || {});
    
    // Update or insert search index
    await db.none(`
      INSERT INTO search_indexes (document_id, content_vector, metadata_vector)
      VALUES ($1, to_tsvector('english', $2), to_tsvector('english', $3))
      ON CONFLICT (document_id) DO UPDATE SET
        content_vector = to_tsvector('english', $2),
        metadata_vector = to_tsvector('english', $3),
        indexed_at = NOW()
    `, [documentId, contentText, metadataText]);
    
    reply.send({ message: 'Document reindexed successfully', documentId });
    
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to reindex document' });
  }
});

// Health check
fastify.get('/health', async (request, reply) => {
  try {
    await db.one('SELECT 1');
    reply.send({ status: 'healthy', service: 'search-service' });
  } catch (error) {
    reply.code(503).send({ status: 'unhealthy', service: 'search-service' });
  }
});

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: process.env.PORT || 3004, host: '0.0.0.0' });
    fastify.log.info('Search service running on port 3004');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();