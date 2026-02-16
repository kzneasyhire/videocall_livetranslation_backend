cat > Dockerfile <<'EOF'
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY app ./app
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "app/index.js"]
EOF
