# ---- build the React client ----
FROM node:22-alpine AS client
WORKDIR /client
COPY client/package*.json ./
RUN npm ci
COPY client ./
RUN npm run build

# ---- API + worker image (same image, different command) ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/src ./src
COPY server/migrations ./migrations
COPY --from=client /client/dist ./public
EXPOSE 3000
CMD ["sh", "-c", "node src/migrate.js && node src/seed.js && node src/index.js"]
