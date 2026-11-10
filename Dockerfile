# URBONT PAYMENTS — imagen de producción
#
# A diferencia de urbont-api, aquí NO se copia ningún `.env`: las variables las
# inyecta ECS en el arranque, desde la definición de tarea (ver taskdef.json).
# Una imagen con secretos dentro los deja en una capa inmutable que cualquiera
# con `docker pull` puede leer, y en un servicio de pagos eso son las claves del
# procesador.

FROM node:22-alpine AS builder

WORKDIR /app

RUN npm install -g pnpm@11

# El pnpm-workspace.yaml va antes del install: su `allowBuilds` autoriza el
# script de instalación de esbuild, que pnpm 10+ bloquea por defecto.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --no-frozen-lockfile

COPY . .
RUN pnpm run build

FROM node:22-alpine AS production

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g pnpm@11 \
 && pnpm install --no-frozen-lockfile --prod --ignore-scripts \
 && pnpm store prune

COPY --from=builder /app/dist ./dist
# Las migraciones son .sql: el compilador no las toca. El `build` ya las copia
# a dist; esto lo repite a propósito, para que la imagen no dependa de ese
# detalle del script de build.
COPY --from=builder /app/db/migrations ./dist/db/migrations

# No corre como root: si alguien logra ejecutar algo aquí, que sea sin permisos.
USER node

EXPOSE 8080

CMD ["node", "dist/src/main.js"]
