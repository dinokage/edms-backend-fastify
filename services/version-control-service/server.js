// version-control-service/server.js
import Fastify from 'fastify'
import fastifyMultipart from '@fastify/multipart';
const fastify = Fastify({
  logger: true
})
import * as Minio from 'minio'


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
import crypto from 'crypto';
// Initialize database connection
if (!process.env.DB_HOST || !process.env.DB_NAME || !process.env.DB_USER || !process.env.DB_PASSWORD) {
  throw new Error('Database connection details are not set in environment variables');
}

const db = pgp({
  host: process.env.DB_HOST || 'postgres',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'edms',
  user: process.env.DB_USER || 'admin',
  password: process.env.DB_PASSWORD || 'password'
});

// MinIO setup
const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || 'localhost',
  port: parseInt(process.env.MINIO_PORT) || 9000,
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin123'
});

const BUCKET_NAME = process.env.MINIO_BUCKET || 'edms-documents';

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

// Register multipart support for file uploads
fastify.register(fastifyMultipart, {
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  }
});

// Utility functions
function generateFileChecksum(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function generateVersionPath(documentId, versionNumber, filename) {
  const timestamp = Date.now();
  const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
  return `versions/${documentId}/v${versionNumber}_${timestamp}_${sanitizedFilename}`;
}

// Routes

// Get document version history
fastify.get('/documents/:documentId/versions', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { documentId } = request.params;
    const { page = 1, limit = 20 } = request.query;

    // Check if document exists
    const document = await db.oneOrNone('SELECT * FROM documents WHERE id = $1', [documentId]);
    if (!document) {
      return reply.code(404).send({ error: 'Document not found' });
    }

    // Get version history with pagination
    const offset = (page - 1) * limit;
    const versions = await db.any(`
      SELECT dv.*, u.username as uploaded_by_username,
             COUNT(*) OVER() as total_count
      FROM document_versions dv
      JOIN users u ON dv.uploaded_by = u.id
      WHERE dv.document_id = $1
      ORDER BY dv.version_number DESC
      LIMIT $2 OFFSET $3
    `, [documentId, limit, offset]);

    const totalCount = versions.length > 0 ? parseInt(versions[0].total_count) : 0;
    const versionList = versions.map(row => {
      const { total_count, ...version } = row;
      return version;
    });

    reply.send({
      documentId,
      versions: versionList,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit)
      }
    });

  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to get version history' });
  }
});

// Create new version
fastify.post('/documents/:documentId/versions', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { documentId } = request.params;
    const data = await request.file();
    
    if (!data) {
      return reply.code(400).send({ error: 'No file provided' });
    }

    const { changesDescription } = request.query;

    // Check if document exists
    const document = await db.oneOrNone('SELECT * FROM documents WHERE id = $1', [documentId]);
    if (!document) {
      return reply.code(404).send({ error: 'Document not found' });
    }

    // Get the next version number
    const latestVersion = await db.oneOrNone(
      'SELECT MAX(version_number) as max_version FROM document_versions WHERE document_id = $1',
      [documentId]
    );
    const nextVersion = (latestVersion?.max_version || document.current_version) + 1;

    // Read file buffer and validate
    const buffer = await data.toBuffer();
    const checksum = generateFileChecksum(buffer);

    // Check if this version already exists (same checksum)
    const existingVersion = await db.oneOrNone(
      'SELECT * FROM document_versions WHERE document_id = $1 AND checksum = $2',
      [documentId, checksum]
    );

    if (existingVersion) {
      return reply.code(409).send({ 
        error: 'This file version already exists',
        existingVersion: existingVersion.version_number
      });
    }

    // Generate MinIO path for new version
    const versionPath = generateVersionPath(documentId, nextVersion, data.filename);

    // Upload new version to MinIO
    await minioClient.putObject(BUCKET_NAME, versionPath, buffer, buffer.length, {
      'Content-Type': data.mimetype,
      'Original-Filename': data.filename,
      'Document-ID': documentId,
      'Version-Number': nextVersion.toString()
    });

    // Start transaction
    await db.tx(async t => {
      // Create new version record
      const newVersion = await t.one(`
        INSERT INTO document_versions (
          document_id, version_number, file_name, file_size,
          minio_path, checksum, changes_description, uploaded_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [
        documentId,
        nextVersion,
        data.filename,
        buffer.length,
        versionPath,
        checksum,
        changesDescription || '',
        request.user.id
      ]);

      // Update document with new current version and file info
      await t.none(`
        UPDATE documents 
        SET current_version = $1, file_name = $2, file_size = $3,
            minio_path = $4, checksum = $5, updated_at = NOW()
        WHERE id = $6
      `, [nextVersion, data.filename, buffer.length, versionPath, checksum, documentId]);

      return newVersion;
    });

    reply.code(201).send({
      message: 'New version created successfully',
      version: {
        documentId,
        versionNumber: nextVersion,
        fileName: data.filename,
        fileSize: buffer.length,
        changesDescription: changesDescription || ''
      }
    });

  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to create new version' });
  }
});

// Get specific version
fastify.get('/documents/:documentId/versions/:versionNumber', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { documentId, versionNumber } = request.params;

    const version = await db.oneOrNone(`
      SELECT dv.*, u.username as uploaded_by_username,
             u.first_name || ' ' || u.last_name as uploaded_by_full_name
      FROM document_versions dv
      JOIN users u ON dv.uploaded_by = u.id
      WHERE dv.document_id = $1 AND dv.version_number = $2
    `, [documentId, parseInt(versionNumber)]);

    if (!version) {
      return reply.code(404).send({ error: 'Version not found' });
    }

    reply.send({ version });

  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to get version' });
  }
});

// Download specific version
fastify.get('/documents/:documentId/versions/:versionNumber/download', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { documentId, versionNumber } = request.params;

    const version = await db.oneOrNone(
      'SELECT * FROM document_versions WHERE document_id = $1 AND version_number = $2',
      [documentId, parseInt(versionNumber)]
    );

    if (!version) {
      return reply.code(404).send({ error: 'Version not found' });
    }

    // Get file from MinIO
    const fileStream = await minioClient.getObject(BUCKET_NAME, version.minio_path);

    reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="v${versionNumber}_${version.file_name}"`)
      .send(fileStream);

  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to download version' });
  }
});

// Compare versions
fastify.get('/documents/:documentId/versions/:version1/compare/:version2', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { documentId, version1, version2 } = request.params;

    const versions = await db.any(`
      SELECT dv.*, u.username as uploaded_by_username
      FROM document_versions dv
      JOIN users u ON dv.uploaded_by = u.id
      WHERE dv.document_id = $1 AND dv.version_number IN ($2, $3)
      ORDER BY dv.version_number
    `, [documentId, parseInt(version1), parseInt(version2)]);

    if (versions.length !== 2) {
      return reply.code(404).send({ error: 'One or both versions not found' });
    }

    const [olderVersion, newerVersion] = versions;

    // Basic comparison metadata
    const comparison = {
      documentId,
      olderVersion: {
        number: olderVersion.version_number,
        fileName: olderVersion.file_name,
        fileSize: olderVersion.file_size,
        checksum: olderVersion.checksum,
        uploadedBy: olderVersion.uploaded_by_username,
        uploadedAt: olderVersion.created_at,
        changes: olderVersion.changes_description
      },
      newerVersion: {
        number: newerVersion.version_number,
        fileName: newerVersion.file_name,
        fileSize: newerVersion.file_size,
        checksum: newerVersion.checksum,
        uploadedBy: newerVersion.uploaded_by_username,
        uploadedAt: newerVersion.created_at,
        changes: newerVersion.changes_description
      },
      differences: {
        sameChecksum: olderVersion.checksum === newerVersion.checksum,
        sizeChange: newerVersion.file_size - olderVersion.file_size,
        nameChanged: olderVersion.file_name !== newerVersion.file_name,
        timeDifference: new Date(newerVersion.created_at) - new Date(olderVersion.created_at)
      }
    };

    reply.send({ comparison });

  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to compare versions' });
  }
});

// Restore specific version (make it current)
fastify.post('/documents/:documentId/versions/:versionNumber/restore', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { documentId, versionNumber } = request.params;
    const { createNewVersion = true } = request.body;

    const version = await db.oneOrNone(
      'SELECT * FROM document_versions WHERE document_id = $1 AND version_number = $2',
      [documentId, parseInt(versionNumber)]
    );

    if (!version) {
      return reply.code(404).send({ error: 'Version not found' });
    }

    const document = await db.oneOrNone('SELECT * FROM documents WHERE id = $1', [documentId]);
    if (!document) {
      return reply.code(404).send({ error: 'Document not found' });
    }

    await db.tx(async t => {
      if (createNewVersion) {
        // Create a new version entry for the restoration
        const nextVersion = await t.one(
          'SELECT COALESCE(MAX(version_number), 0) + 1 as next_version FROM document_versions WHERE document_id = $1',
          [documentId]
        );

        // Copy the version file in MinIO
        const newVersionPath = generateVersionPath(documentId, nextVersion.next_version, version.file_name);
        
        // Get the file content from the version to restore
        const fileStream = await minioClient.getObject(BUCKET_NAME, version.minio_path);
        const chunks = [];
        for await (const chunk of fileStream) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);

        // Upload as new version
        await minioClient.putObject(BUCKET_NAME, newVersionPath, buffer, buffer.length, {
          'Content-Type': 'application/octet-stream',
          'Original-Filename': version.file_name,
          'Document-ID': documentId,
          'Version-Number': nextVersion.next_version.toString(),
          'Restored-From-Version': versionNumber.toString()
        });

        // Create new version record
        await t.none(`
          INSERT INTO document_versions (
            document_id, version_number, file_name, file_size,
            minio_path, checksum, changes_description, uploaded_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          documentId,
          nextVersion.next_version,
          version.file_name,
          version.file_size,
          newVersionPath,
          version.checksum,
          `Restored from version ${versionNumber}`,
          request.user.id
        ]);

        // Update document to point to the new version
        await t.none(`
          UPDATE documents 
          SET current_version = $1, file_name = $2, file_size = $3,
              minio_path = $4, checksum = $5, updated_at = NOW()
          WHERE id = $6
        `, [nextVersion.next_version, version.file_name, version.file_size, newVersionPath, version.checksum, documentId]);

      } else {
        // Simply update the document to point to the existing version
        await t.none(`
          UPDATE documents 
          SET current_version = $1, file_name = $2, file_size = $3,
              minio_path = $4, checksum = $5, updated_at = NOW()
          WHERE id = $6
        `, [version.version_number, version.file_name, version.file_size, version.minio_path, version.checksum, documentId]);
      }
    });

    reply.send({
      message: `Version ${versionNumber} restored successfully`,
      documentId,
      restoredVersion: parseInt(versionNumber),
      createdNewVersion: createNewVersion
    });

  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to restore version' });
  }
});

// Delete specific version
fastify.delete('/documents/:documentId/versions/:versionNumber', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { documentId, versionNumber } = request.params;

    const version = await db.oneOrNone(
      'SELECT * FROM document_versions WHERE document_id = $1 AND version_number = $2',
      [documentId, parseInt(versionNumber)]
    );

    if (!version) {
      return reply.code(404).send({ error: 'Version not found' });
    }

    // Check if this is the current version
    const document = await db.oneOrNone('SELECT current_version FROM documents WHERE id = $1', [documentId]);
    if (document && document.current_version === parseInt(versionNumber)) {
      return reply.code(400).send({ error: 'Cannot delete the current version' });
    }

    // Check if there are dependencies
    const dependencies = await db.any(
      'SELECT * FROM version_relationships WHERE parent_version_id = $1 OR child_version_id = $1',
      [version.id]
    );

    if (dependencies.length > 0) {
      return reply.code(400).send({ 
        error: 'Cannot delete version with dependencies',
        dependencies: dependencies.length
      });
    }

    await db.tx(async t => {
      // Delete version record
      await t.none('DELETE FROM document_versions WHERE id = $1', [version.id]);

      // Delete file from MinIO
      await minioClient.removeObject(BUCKET_NAME, version.minio_path);
    });

    reply.send({
      message: `Version ${versionNumber} deleted successfully`,
      documentId,
      deletedVersion: parseInt(versionNumber)
    });

  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to delete version' });
  }
});

// Get version relationships
fastify.get('/documents/:documentId/versions/:versionNumber/relationships', {
  preHandler: authenticate
}, async (request, reply) => {
  try {
    const { documentId, versionNumber } = request.params;

    const version = await db.oneOrNone(
      'SELECT id FROM document_versions WHERE document_id = $1 AND version_number = $2',
      [documentId, parseInt(versionNumber)]
    );

    if (!version) {
      return reply.code(404).send({ error: 'Version not found' });
    }

    const relationships = await db.any(`
      SELECT vr.*, 
             pv.version_number as parent_version_number,
             cv.version_number as child_version_number,
             pd.title as parent_document_title,
             cd.title as child_document_title
      FROM version_relationships vr
      LEFT JOIN document_versions pv ON vr.parent_version_id = pv.id
      LEFT JOIN document_versions cv ON vr.child_version_id = cv.id
      LEFT JOIN documents pd ON pv.document_id = pd.id
      LEFT JOIN documents cd ON cv.document_id = cd.id
      WHERE vr.parent_version_id = $1 OR vr.child_version_id = $1
    `, [version.id]);

    reply.send({
      documentId,
      versionNumber: parseInt(versionNumber),
      relationships
    });

  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to get version relationships' });
  }
});

// Health check
fastify.get('/health', async (request, reply) => {
  try {
    await db.one('SELECT 1');
    await minioClient.listBuckets();
    reply.send({ status: 'healthy', service: 'version-control-service' });
  } catch (error) {
    reply.code(503).send({ status: 'unhealthy', service: 'version-control-service' });
  }
});

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: process.env.PORT || 3008, host: '0.0.0.0' });
    fastify.log.info('Version Control service running on port 3008');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();