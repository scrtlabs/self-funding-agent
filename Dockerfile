FROM node:18-alpine

# Install curl for healthcheck
RUN apk add --no-cache curl

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application code
COPY funding-agent.js .
COPY funding-dashboard.html .

# Create data directory for wallet storage
RUN mkdir -p /data && chmod 700 /data

# Expose port
EXPOSE 3002

# Start the agent
CMD ["node", "funding-agent.js"]
