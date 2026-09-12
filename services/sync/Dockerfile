FROM node:20-alpine
WORKDIR /srv
# Repo-root build context (see docker-compose.yml). Install only the
# sync-service workspace + its local @ucm/protocol dep so the image
# doesn't pull the Expo/Android workspace.
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/protocol/tsconfig.json ./packages/protocol/
COPY services/sync/package.json ./services/sync/
COPY services/sync/tsconfig.json ./services/sync/
# Drop the android workspace from the image build (huge expo deps,
# not needed by the server). Keep protocol + sync workspaces only.
RUN node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.workspaces=['packages/protocol','services/sync'];fs.writeFileSync('package.json',JSON.stringify(p,null,2))" \
  && npm install --omit=dev
COPY packages/protocol/src ./packages/protocol/src
COPY services/sync/src ./services/sync/src
RUN npm run build --workspace=@ucm/protocol --workspace=@ucm/sync-service
ENV PORT=3000
EXPOSE 3000
CMD ["node", "services/sync/dist/index.js"]
