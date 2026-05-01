# Build stage
FROM node:18-alpine AS builder

# Install curl for healthcheck
RUN apk add --no-cache curl

# Build arguments for git info
ARG GIT_COMMIT=unknown
ARG GIT_COMMIT_FULL=unknown
ARG GIT_BRANCH=unknown
ARG GIT_TAG=
ARG BUILD_TIME=unknown

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
COPY generate-build-info.sh ./

# Make script executable
RUN chmod +x generate-build-info.sh

# Generate build info with provided git information
RUN VERSION=$(node -p "require('./package.json').version") && \
    mkdir -p src && \
    echo "{" > src/build-info.json && \
    echo "  \"version\": \"${VERSION}\"," >> src/build-info.json && \
    echo "  \"gitCommit\": \"${GIT_COMMIT}\"," >> src/build-info.json && \
    echo "  \"gitCommitFull\": \"${GIT_COMMIT_FULL}\"," >> src/build-info.json && \
    echo "  \"gitBranch\": \"${GIT_BRANCH}\"," >> src/build-info.json && \
    echo "  \"gitTag\": \"${GIT_TAG}\"," >> src/build-info.json && \
    echo "  \"buildTime\": \"${BUILD_TIME}\"" >> src/build-info.json && \
    echo "}" >> src/build-info.json && \
    echo "✅ Build info generated:" && \
    cat src/build-info.json

# Build TypeScript server and React client (skip prebuild since we already generated build-info)
RUN npm run build:server && npm run build:client

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
