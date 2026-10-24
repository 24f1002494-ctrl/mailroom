FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
# Mount a persistent volume at /data: decisions, evaluations and receipts must survive restarts.
VOLUME /data
EXPOSE 8080
CMD ["node", "src/core.js"]
