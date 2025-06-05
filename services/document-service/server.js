// document-service/server.js
import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
const fastify = Fastify({
  logger: true,
});
// const multer = require('multer');
import crypto from "crypto";
import path from "path";
import * as Minio from "minio";

// Database setup
import pgPromise from "pg-promise";
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
  host: process.env.DB_HOST || "localhost",
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || "edms",
  user: process.env.DB_USER || "admin",
  password: process.env.DB_PASSWORD || "password",
});

// MinIO setup
const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || "localhost",
  port: parseInt(process.env.MINIO_PORT) || 9000,
  useSSL: process.env.MINIO_USE_SSL === "true",
  accessKey: process.env.MINIO_ACCESS_KEY || "minioadmin",
  secretKey: process.env.MINIO_SECRET_KEY || "minioadmin123",
});

const BUCKET_NAME = process.env.MINIO_BUCKET || "edms-documents";

// Initialize MinIO bucket
async function initializeBucket() {
  try {
    const exists = await minioClient.bucketExists(BUCKET_NAME);
    if (!exists) {
      await minioClient.makeBucket(BUCKET_NAME, "us-east-1");
      console.log(`Bucket ${BUCKET_NAME} created successfully`);
    }
  } catch (error) {
    console.error("Error initializing MinIO bucket:", error);
  }
}

// Authentication middleware (simplified - should validate JWT)
async function authenticate(request, reply) {
  try {
    const token = request.headers.authorization?.replace("Bearer ", "");
    if (!token) {
      reply.code(401).send({ error: "No token provided" });
      return;
    }

    // TODO: Validate JWT token and get user info
    // For now, we'll mock the user
    request.user = { id: "user-123", username: "testuser" };
  } catch (error) {
    reply.code(401).send({ error: "Invalid token" });
  }
}

fastify.decorate("authenticate", authenticate);

// Register multipart support
fastify.register(fastifyMultipart, {
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
  },
});

// Utility functions
function generateFileChecksum(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function generateMinioPath(projectId, documentType, filename) {
  const timestamp = Date.now();
  const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, "_");
  return `${projectId}/${documentType}/${timestamp}_${sanitizedFilename}`;
}

// Schemas
const uploadSchema = {
  querystring: {
    type: "object",
    required: ["projectId", "documentTypeId"],
    properties: {
      projectId: { type: "string" },
      documentTypeId: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      tags: { type: "string" }, // comma-separated
    },
  },
};

const searchSchema = {
  querystring: {
    type: "object",
    properties: {
      q: { type: "string" },
      projectId: { type: "string" },
      documentTypeId: { type: "string" },
      status: { type: "string" },
      tags: { type: "string" },
      page: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
  },
};

// Routes

// Upload Document
fastify.post(
  "/upload",
  {
    preHandler: authenticate,
    schema: uploadSchema,
  },
  async (request, reply) => {
    try {
      const data = await request.file();

      if (!data) {
        return reply.code(400).send({ error: "No file provided" });
      }

      const { projectId, documentTypeId, title, description, tags } =
        request.query;

      // Validate document type
      const docType = await db.oneOrNone(
        "SELECT * FROM document_types WHERE id = $1",
        [documentTypeId]
      );
      if (!docType) {
        return reply.code(400).send({ error: "Invalid document type" });
      }

      // Validate file extension
      const fileExtension = path.extname(data.filename).toLowerCase();
      if (
        docType.allowed_extensions &&
        !docType.allowed_extensions.includes(fileExtension)
      ) {
        return reply.code(400).send({
          error: `File type ${fileExtension} not allowed for this document type`,
        });
      }

      // Read file buffer
      const buffer = await data.toBuffer();

      // Validate file size
      if (buffer.length > docType.max_size_mb * 1024 * 1024) {
        return reply.code(400).send({
          error: `File size exceeds maximum allowed size of ${docType.max_size_mb}MB`,
        });
      }

      // Generate checksum and MinIO path
      const checksum = generateFileChecksum(buffer);
      const minioPath = generateMinioPath(
        projectId,
        docType.name,
        data.filename
      );

      // Upload to MinIO
      await minioClient.putObject(
        BUCKET_NAME,
        minioPath,
        buffer,
        buffer.length,
        {
          "Content-Type": data.mimetype,
          "Original-Filename": data.filename,
        }
      );

      // Save document metadata to database
      const document = await db.one(
        `
      INSERT INTO documents (
        project_id, document_type_id, title, description, file_name,
        file_size, mime_type, minio_path, checksum, uploaded_by,
        status, tags, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `,
        [
          projectId,
          documentTypeId,
          title || data.filename,
          description || "",
          data.filename,
          buffer.length,
          data.mimetype,
          minioPath,
          checksum,
          request.user.id,
          "uploaded",
          tags ? tags.split(",").map((tag) => tag.trim()) : [],
          {
            originalName: data.filename,
            uploadedAt: new Date().toISOString(),
          },
        ]
      );

      reply.code(201).send({
        message: "Document uploaded successfully",
        document: {
          id: document.id,
          title: document.title,
          fileName: document.file_name,
          fileSize: document.file_size,
          mimeType: document.mime_type,
          status: document.status,
          uploadedAt: document.created_at,
        },
      });
    } catch (error) {
      fastify.log.error(error);
      reply.code(500).send({ error: "Failed to upload document" });
    }
  }
);

// Download Document
fastify.get(
  "/download/:documentId",
  {
    preHandler: authenticate,
  },
  async (request, reply) => {
    try {
      const { documentId } = request.params;

      // Get document metadata
      const document = await db.oneOrNone(
        "SELECT * FROM documents WHERE id = $1",
        [documentId]
      );

      if (!document) {
        return reply.code(404).send({ error: "Document not found" });
      }

      // TODO: Check user permissions

      // Get file from MinIO
      const fileStream = await minioClient.getObject(
        BUCKET_NAME,
        document.minio_path
      );

      reply
        .header("Content-Type", document.mime_type)
        .header(
          "Content-Disposition",
          `attachment; filename="${document.file_name}"`
        )
        .send(fileStream);
    } catch (error) {
      fastify.log.error(error);
      reply.code(500).send({ error: "Failed to download document" });
    }
  }
);

// Get Document Details
fastify.get(
  "/:documentId",
  {
    preHandler: authenticate,
  },
  async (request, reply) => {
    try {
      const { documentId } = request.params;

      const document = await db.oneOrNone(
        `
      SELECT d.*, dt.name as document_type_name, p.name as project_name,
             u.username as uploaded_by_username
      FROM documents d
      JOIN document_types dt ON d.document_type_id = dt.id
      JOIN projects p ON d.project_id = p.id
      JOIN users u ON d.uploaded_by = u.id
      WHERE d.id = $1
    `,
        [documentId]
      );

      if (!document) {
        return reply.code(404).send({ error: "Document not found" });
      }

      reply.send({ document });
    } catch (error) {
      fastify.log.error(error);
      reply.code(500).send({ error: "Failed to get document" });
    }
  }
);

// Search Documents
fastify.get(
  "/search",
  {
    preHandler: authenticate,
    schema: searchSchema,
  },
  async (request, reply) => {
    try {
      const {
        q,
        projectId,
        documentTypeId,
        status,
        tags,
        page = 1,
        limit = 20,
      } = request.query;

      let query = `
      SELECT d.*, dt.name as document_type_name, p.name as project_name,
             u.username as uploaded_by_username,
             COUNT(*) OVER() as total_count
      FROM documents d
      JOIN document_types dt ON d.document_type_id = dt.id
      JOIN projects p ON d.project_id = p.id
      JOIN users u ON d.uploaded_by = u.id
      WHERE 1=1
    `;

      const params = [];
      let paramIndex = 1;

      // Add search conditions
      if (q) {
        query += ` AND (d.title ILIKE $${paramIndex} OR d.description ILIKE $${paramIndex} OR d.file_name ILIKE $${paramIndex})`;
        params.push(`%${q}%`);
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

      if (status) {
        query += ` AND d.status = $${paramIndex}`;
        params.push(status);
        paramIndex++;
      }

      if (tags) {
        query += ` AND d.tags && $${paramIndex}`;
        params.push(tags.split(",").map((tag) => tag.trim()));
        paramIndex++;
      }

      // Add pagination
      const offset = (page - 1) * limit;
      query += ` ORDER BY d.created_at DESC LIMIT $${paramIndex} OFFSET $${
        paramIndex + 1
      }`;
      params.push(limit, offset);

      const results = await db.any(query, params);

      const totalCount =
        results.length > 0 ? parseInt(results[0].total_count) : 0;
      const documents = results.map((row) => {
        const { total_count, ...document } = row;
        return document;
      });

      reply.send({
        documents,
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit),
        },
      });
    } catch (error) {
      fastify.log.error(error);
      reply.code(500).send({ error: "Failed to search documents" });
    }
  }
);

// Update Document Metadata
fastify.put(
  "/:documentId",
  {
    preHandler: authenticate,
    schema: {
      body: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          metadata: { type: "object" },
        },
      },
    },
  },
  async (request, reply) => {
    try {
      const { documentId } = request.params;
      const { title, description, tags, metadata } = request.body;

      // Check if document exists
      const document = await db.oneOrNone(
        "SELECT * FROM documents WHERE id = $1",
        [documentId]
      );
      if (!document) {
        return reply.code(404).send({ error: "Document not found" });
      }

      // TODO: Check user permissions

      const updates = [];
      const values = [documentId];
      let paramIndex = 2;

      if (title !== undefined) {
        updates.push(`title = $${paramIndex++}`);
        values.push(title);
      }
      if (description !== undefined) {
        updates.push(`description = $${paramIndex++}`);
        values.push(description);
      }
      if (tags !== undefined) {
        updates.push(`tags = $${paramIndex++}`);
        values.push(tags);
      }
      if (metadata !== undefined) {
        updates.push(`metadata = metadata || $${paramIndex++}`);
        values.push(JSON.stringify(metadata));
      }

      if (updates.length === 0) {
        return reply.code(400).send({ error: "No valid fields to update" });
      }

      updates.push("updated_at = NOW()");

      const updatedDocument = await db.one(
        `
      UPDATE documents 
      SET ${updates.join(", ")}
      WHERE id = $1
      RETURNING *
    `,
        values
      );

      reply.send({ document: updatedDocument });
    } catch (error) {
      fastify.log.error(error);
      reply.code(500).send({ error: "Failed to update document" });
    }
  }
);

// Delete Document
fastify.delete(
  "/:documentId",
  {
    preHandler: authenticate,
  },
  async (request, reply) => {
    try {
      const { documentId } = request.params;

      const document = await db.oneOrNone(
        "SELECT * FROM documents WHERE id = $1",
        [documentId]
      );
      if (!document) {
        return reply.code(404).send({ error: "Document not found" });
      }

      // TODO: Check user permissions

      // Delete from MinIO
      await minioClient.removeObject(BUCKET_NAME, document.minio_path);

      // Delete from database
      await db.none("DELETE FROM documents WHERE id = $1", [documentId]);

      reply.send({ message: "Document deleted successfully" });
    } catch (error) {
      fastify.log.error(error);
      reply.code(500).send({ error: "Failed to delete document" });
    }
  }
);

// Get Document Types
fastify.get(
  "/types",
  {
    preHandler: authenticate,
  },
  async (request, reply) => {
    try {
      const documentTypes = await db.any(
        "SELECT * FROM document_types ORDER BY name"
      );
      reply.send({ documentTypes });
    } catch (error) {
      fastify.log.error(error);
      reply.code(500).send({ error: "Failed to get document types" });
    }
  }
);

// Get Projects
fastify.get(
  "/projects",
  {
    preHandler: authenticate,
  },
  async (request, reply) => {
    try {
      const projects = await db.any(
        "SELECT * FROM projects WHERE status = $1 ORDER BY name",
        ["active"]
      );
      reply.send({ projects });
    } catch (error) {
      fastify.log.error(error);
      reply.code(500).send({ error: "Failed to get projects" });
    }
  }
);

// Health check
fastify.get("/health", async (request, reply) => {
  try {
    await db.one("SELECT 1");
    await minioClient.listBuckets(); // Test MinIO connection
    reply.send({ status: "healthy", service: "document-service" });
  } catch (error) {
    reply.code(503).send({ status: "unhealthy", service: "document-service" });
  }
});

// Initialize and start server
const start = async () => {
  try {
    await initializeBucket();
    await fastify.listen({ port: process.env.PORT || 3002, host: "0.0.0.0" });
    fastify.log.info("Document service running on port 3002");
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
