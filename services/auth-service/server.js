// auth-service/server.js
import Fastify from 'fastify'

const fastify = Fastify({
  logger: true
})
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

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

// JWT Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

// Schemas for validation
const loginSchema = {
  body: {
    type: 'object',
    required: ['username', 'password'],
    properties: {
      username: { type: 'string', minLength: 3 },
      password: { type: 'string', minLength: 6 }
    }
  }
};

const registerSchema = {
  body: {
    type: 'object',
    required: ['username', 'email', 'password', 'firstName', 'lastName'],
    properties: {
      username: { type: 'string', minLength: 3 },
      email: { type: 'string', format: 'email' },
      password: { type: 'string', minLength: 6 },
      firstName: { type: 'string', minLength: 1 },
      lastName: { type: 'string', minLength: 1 }
    }
  }
};

// Authentication middleware
async function authenticate(request, reply) {
  try {
    const token = request.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      reply.code(401).send({ error: 'No token provided' });
      return;
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await db.oneOrNone('SELECT * FROM users WHERE id = $1 AND is_active = true', [decoded.userId]);
    
    if (!user) {
      reply.code(401).send({ error: 'Invalid token' });
      return;
    }

    request.user = user;
  } catch (error) {
    reply.code(401).send({ error: 'Invalid token' });
  }
}

// Register authentication decorator
fastify.decorate('authenticate', authenticate);

// Routes

// User Registration
fastify.post('/register', { schema: registerSchema }, async (request, reply) => {
  try {
    const { username, email, password, firstName, lastName } = request.body;

    // Check if user exists
    const existingUser = await db.oneOrNone(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );

    if (existingUser) {
      return reply.code(409).send({ error: 'User already exists' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user
    const newUser = await db.one(`
      INSERT INTO users (username, email, password_hash, first_name, last_name)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, username, email, first_name, last_name, created_at
    `, [username, email, passwordHash, firstName, lastName]);

    // Assign default role
    await db.none(`
      INSERT INTO user_roles (user_id, role_id)
      SELECT $1, id FROM roles WHERE name = 'user'
    `, [newUser.id]);

    reply.code(201).send({
      message: 'User created successfully',
      user: newUser
    });
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Internal server error', details: error.message });
  }
});

// User Login
fastify.post('/login', { schema: loginSchema }, async (request, reply) => {
  try {
    const { username, password } = request.body;

    // Get user with roles
    const user = await db.oneOrNone(`
      SELECT u.*, 
             COALESCE(
               json_agg(
                 json_build_object(
                   'id', r.id,
                   'name', r.name,
                   'permissions', r.permissions
                 )
               ) FILTER (WHERE r.id IS NOT NULL), 
               '[]'
             ) as roles
      FROM users u
      LEFT JOIN user_roles ur ON u.id = ur.user_id
      LEFT JOIN roles r ON ur.role_id = r.id
      WHERE (u.username = $1 OR u.email = $1) AND u.is_active = true
      GROUP BY u.id
    `, [username]);

    if (!user) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    // Generate JWT token
    const token = jwt.sign(
      { 
        userId: user.id, 
        username: user.username,
        roles: user.roles 
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    reply.send({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        roles: user.roles
      }
    });
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Internal server error', details: error.message });
  }
});

// Token Validation
fastify.get('/validate', { preHandler: authenticate }, async (request, reply) => {
  reply.send({
    valid: true,
    user: {
      id: request.user.id,
      username: request.user.username,
      email: request.user.email
    }
  });
});

// Get User Profile
fastify.get('/profile', { preHandler: authenticate }, async (request, reply) => {
  try {
    const userWithRoles = await db.one(`
      SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.created_at,
             COALESCE(
               json_agg(
                 json_build_object(
                   'id', r.id,
                   'name', r.name,
                   'permissions', r.permissions
                 )
               ) FILTER (WHERE r.id IS NOT NULL), 
               '[]'
             ) as roles
      FROM users u
      LEFT JOIN user_roles ur ON u.id = ur.user_id
      LEFT JOIN roles r ON ur.role_id = r.id
      WHERE u.id = $1
      GROUP BY u.id
    `, [request.user.id]);

    reply.send({ user: userWithRoles });
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Internal server error', details: error.message });
  }
});

// Update User Profile
fastify.put('/profile', { 
  preHandler: authenticate,
  schema: {
    body: {
      type: 'object',
      properties: {
        firstName: { type: 'string', minLength: 1 },
        lastName: { type: 'string', minLength: 1 },
        email: { type: 'string', format: 'email' }
      }
    }
  }
}, async (request, reply) => {
  try {
    const { firstName, lastName, email } = request.body;
    const updates = [];
    const values = [request.user.id];
    let paramIndex = 2;

    if (firstName) {
      updates.push(`first_name = $${paramIndex++}`);
      values.push(firstName);
    }
    if (lastName) {
      updates.push(`last_name = $${paramIndex++}`);
      values.push(lastName);
    }
    if (email) {
      updates.push(`email = $${paramIndex++}`);
      values.push(email);
    }

    if (updates.length === 0) {
      return reply.code(400).send({ error: 'No valid fields to update' });
    }

    const updatedUser = await db.one(`
      UPDATE users 
      SET ${updates.join(', ')}, updated_at = NOW()
      WHERE id = $1
      RETURNING id, username, email, first_name, last_name, updated_at
    `, values);

    reply.send({ user: updatedUser });
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Internal server error', details: error.message });
  }
});

// Change Password
fastify.put('/change-password', {
  preHandler: authenticate,
  schema: {
    body: {
      type: 'object',
      required: ['currentPassword', 'newPassword'],
      properties: {
        currentPassword: { type: 'string' },
        newPassword: { type: 'string', minLength: 6 }
      }
    }
  }
}, async (request, reply) => {
  try {
    const { currentPassword, newPassword } = request.body;

    // Verify current password
    const isValidPassword = await bcrypt.compare(currentPassword, request.user.password_hash);
    if (!isValidPassword) {
      return reply.code(400).send({ error: 'Current password is incorrect' });
    }

    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, 12);

    // Update password
    await db.none('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [newPasswordHash, request.user.id]);

    reply.send({ message: 'Password updated successfully' });
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Internal server error', details: error.message });
  }
});

// Health check
fastify.get('/health', async (request, reply) => {
  try {
    await db.one('SELECT 1');
    reply.send({ status: 'healthy', service: 'auth-service' });
  } catch (error) {
    reply.code(503).send({ status: 'unhealthy', service: 'auth-service' });
  }
});

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: process.env.PORT || 3001, host: '0.0.0.0' });
    fastify.log.info('Auth service running on port 3001');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();