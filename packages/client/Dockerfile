# syntax=docker/dockerfile:1

# --- build stage ---
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm install

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/client packages/client

# The server URL is baked into the bundle at build time.
ARG VITE_SERVER_URL=http://localhost:3001
ENV VITE_SERVER_URL=$VITE_SERVER_URL
RUN npm run build -w @skyteam/shared && npm run build -w @skyteam/client

# --- runtime stage ---
FROM nginx:alpine AS runtime
COPY packages/client/nginx.conf /etc/nginx/conf.d/default.conf
COPY packages/client/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/packages/client/dist /usr/share/nginx/html
EXPOSE 80
