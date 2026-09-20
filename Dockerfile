FROM node:22-alpine

WORKDIR /app

# Устанавливаем зависимости
COPY package*.json ./
RUN npm ci

# Копируем исходники и собираем проект
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Удаляем devDependencies для минимизации размера образа
RUN npm prune --production

# Создаем папку под базу данных
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/index.js"]
