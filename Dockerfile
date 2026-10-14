# Build stage: dev dependencies are only needed to compile TypeScript.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: production dependencies and the compiled output only.
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Never run as root.
USER node

# Overridden by the platform ($PORT) on most hosts.
ENV PORT=3000 HOST=0.0.0.0
EXPOSE 3000

# Config comes from real environment variables in production; no .env is copied in
# (.dockerignore excludes it), so a stray local token can never reach the image.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The HTTP server: serves REST, OpenAPI and MCP-over-HTTP at POST /mcp.
CMD ["node", "dist/server.js"]
