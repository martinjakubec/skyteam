# syntax=docker/dockerfile:1
FROM node:22-alpine
WORKDIR /app

# Install workspace dependencies using only the manifests first, so this layer
# is cached unless a package.json actually changes.
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm install

# Copy the sources the server needs and build the shared package (the server
# imports its compiled dist output).
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/server packages/server
RUN npm run build -w @skyteam/shared

ENV NODE_ENV=production
EXPOSE 3001
CMD ["npm", "run", "start", "-w", "@skyteam/server"]
