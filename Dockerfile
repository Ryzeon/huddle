FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/portal/package.json packages/portal/
COPY packages/protocol/package.json packages/protocol/


RUN npm install --no-audit --no-fund --ignore-scripts

COPY tsconfig.base.json ./
COPY scripts scripts
COPY packages packages
COPY brand brand
RUN npm run build:site

FROM nginx:alpine
COPY --from=build /app/site /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
