FROM node:20-alpine
WORKDIR /srv
COPY package.json ./
RUN npm install --omit=dev
COPY dist ./dist
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/index.js"]
