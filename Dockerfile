FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY openapi.yaml ./
COPY src ./src
COPY mcp ./mcp
USER node
ENV HOST=0.0.0.0
EXPOSE 4000 4100 4200 4300
CMD ["node", "src/dev.ts"]
