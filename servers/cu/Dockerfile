FROM node:22

WORKDIR /usr/app

# Install dependencies
COPY ./package.json .
COPY ./package-lock.json .
RUN npm install --omit=dev

# Copy application source
COPY ./src ./src

# Install required system packages
RUN apt-get update && apt-get install -y sqlite3 jq && rm -rf /var/lib/apt/lists/*

# Copy database files from the host
COPY ./largest_nonces.db /usr/app/largest_nonces.db
COPY ./kinesis_largest_nonces.db /usr/app/kinesis_largest_nonces.db

# Copy scripts
COPY restart_server.sh /usr/app/restart_server.sh
COPY collect_process_data.sh /usr/app/collect_process_data.sh

# Ensure scripts have execute permissions
RUN chmod +x /usr/app/restart_server.sh /usr/app/collect_process_data.sh

# Create necessary directories
RUN mkdir -p /db/ /file-checkpoints/

# Set environment variables
ENV NODE_ENV=development

# Expose server port
EXPOSE 6363

# Install tini for proper signal handling
RUN npm install -g tini

# Use tini as the entrypoint
ENTRYPOINT ["/usr/bin/tini", "--"]

# Start the restart script
CMD ["/usr/app/restart_server.sh"]
