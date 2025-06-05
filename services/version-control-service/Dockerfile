# services/version-control-service/Dockerfile

# Use official Node.js LTS (Long Term Support) Alpine image
FROM node:20-alpine

# Set working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json (if available)
# This is done before copying the rest of the code to leverage Docker layer caching
COPY package*.json ./

# Install dependencies
# Using npm ci for faster, reliable, reproducible builds
RUN npm ci --only=production && npm cache clean --force

# Copy the rest of the application code
COPY . .

# Create a non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S versioncontrol -u 1001 -G nodejs

# Create necessary directories and set permissions
RUN mkdir -p /app/logs /app/temp && \
    chown -R versioncontrol:nodejs /app

# Switch to non-root user
USER versioncontrol

# Expose the port that the service runs on
EXPOSE 3008

# Add labels for better container management
LABEL maintainer="EDMS Team"
LABEL service="version-control-service"
LABEL version="1.0.0"
LABEL description="Version control service for EDMS document management"

# Health check to ensure the service is running properly
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3008/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => { process.exit(1) })"

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3008

# Start the application
CMD ["npm", "start"]