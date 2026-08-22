FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web ./web
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
COPY server ./server
COPY src ./src
COPY simulator ./simulator
COPY --from=build /app/dist ./dist
EXPOSE 8080 9100
CMD ["node", "server/index.mjs"]
