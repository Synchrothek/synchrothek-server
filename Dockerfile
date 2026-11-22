FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:26-alpine
# npm wird zur Laufzeit nicht gebraucht. Das mitgelieferte npm bringt eigene
# Abhängigkeiten mit, deren Schwachstellen sonst den Image-Scan auslösen.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/health || exit 1
# Node führt TypeScript direkt aus (Type Stripping), ein Build-Schritt ist nicht nötig
CMD ["node", "src/index.ts"]
