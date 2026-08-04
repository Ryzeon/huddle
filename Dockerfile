# El portal son archivos estáticos: se compilan una vez y los sirve nginx.
# No hay servidor de aplicación porque no hay nada que ejecutar en el servidor.

FROM node:22-alpine AS build
WORKDIR /app

# Las dependencias primero: cambian mucho menos que el código.
COPY package.json package-lock.json* ./
COPY packages/portal/package.json packages/portal/
COPY packages/protocol/package.json packages/protocol/
RUN npm install --no-audit --no-fund

COPY tsconfig.base.json tsconfig.json ./
COPY scripts scripts
COPY packages packages
# El HTML pide el favicon desde /brand/, así que la marca entra en el sitio.
COPY brand brand
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/site /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
