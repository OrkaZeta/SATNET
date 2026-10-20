FROM node:24-alpine AS build
WORKDIR /app

COPY package.json ./
RUN node -e "const fs=require('node:fs'); const p=JSON.parse(fs.readFileSync('package.json','utf8')); p.name='satnet'; fs.writeFileSync('package.json', JSON.stringify(p));" \
    && npm install --no-package-lock --no-audit --no-fund

COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
