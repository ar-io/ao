FROM node:22-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Production stage
FROM node:22-slim

WORKDIR /app

# Install build dependencies for better-sqlite3 native module
RUN apt-get update && \
    apt-get install -y python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=3000
ENV VERIFICATION_DB_DIR=/data/verification

EXPOSE 3000

CMD ["node", "dist/index.js"]
