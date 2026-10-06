# WeatherOrNot: one small Node process and a SQLite file.
# Mount a persistent volume at /data so the database and its backups survive deploys.
FROM node:22-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/weatherornot.db
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--no-warnings=ExperimentalWarning", "src/server.js"]
