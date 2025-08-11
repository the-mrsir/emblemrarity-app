# v8 Dockerfile (optional): reproducible Playwright runtime
FROM mcr.microsoft.com/playwright:v1.46.0-jammy

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* /app/
RUN npm ci --omit=dev || npm install --omit=dev
# playwright already installed in base image

COPY . /app

EXPOSE 3000
CMD ["npm", "start"]
