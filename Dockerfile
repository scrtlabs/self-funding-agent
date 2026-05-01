# Build stage
FROM node:18-alpine AS builder

# Install curl for healthcheck
RUN apk add --no-cache curl

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm install

# Copy source code
COPY src ./src
COPY client ./client

# Build TypeScript server and React client
RUN npm run build

# Production stage
FROM node:18-alpine

# Install curl for healthcheck
RUN apk add --no-cache curl

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm install --production

# Copy built files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/client/dist ./client/dist

# Create data directory for wallet storage
RUN mkdir -p /data && chmod 700 /data

# Expose port
EXPOSE 3002

# Start the agent
CMD ["node", "dist/funding-agent.js"]
