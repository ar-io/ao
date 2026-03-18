FROM node:22-slim

RUN apt-get update && apt-get install -y procps && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY *.js .

RUN mkdir -p /data

CMD ["node", "index.js"]
