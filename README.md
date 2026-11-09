# URBONT PAYMENTS

Capa de abstracción de pagos de URBONT. La aplicación habla siempre con este
servicio, y es este servicio el que habla con Stripe, Square, Adyen, Finix,
PayPal o ACH según convenga.

Propiedad de **URBONT Mobility Technology Inc.**

---

## Por qué existe

Hoy el dinero se mueve desde `urbont-api` con unas noventa y cinco llamadas
directas al SDK de Stripe repartidas por catorce archivos, y con ocho clientes
de Stripe distintos creados cada uno por su cuenta. Cambiar de procesador
significaría tocarlos todos, y el nombre del procesador está hasta en los
nombres de columna.

Aquí hay un solo contrato —[`src/providers/provider.port.ts`](src/providers/provider.port.ts)—
y cada procesador es un adaptador que lo implementa. Añadir uno no toca ni una
línea de `urbont-api` ni de la app.

## Cómo está organizado

```
src/
  config/      Configuración validada al arrancar (sin ella, no arranca)
  db/          Pool de Postgres, limitado al esquema `payments`
  health/      /healthz (mira la base) y /readyz
  providers/
    provider.port.ts       El contrato único
    provider.registry.ts   Qué procesador atiende cada operación
    stripe/                Adaptador Stripe        ← fase 2
  payments/    Casos de uso: autorizar, capturar, reembolsar   ← fase 2
  ledger/      Libro de cobros, asientos e idempotencia        ← fases 2 y 4
  internal/    Lo que llama urbont-api, firmado                ← fase 3
  splits/      Reparto: chofer, valet, plataforma              ← fase 4
  payees/      La cuenta de cobro de cada persona, por procesador ← fase 4
  webhooks/    Avisos del procesador: firma, idempotencia y aviso a urbont-api ← fase 6
  reconciliation/ Cuadre contra el extracto del procesador     ← fase 6
db/migrations/ Esquema `payments`, aplicado al arrancar
```

## Lo que expone

Nada de esto lo llama la app: sólo `urbont-api`, y firmado (ver
`src/internal/firma.ts`).

| | |
|---|---|
| `POST /internal/charges` | Autoriza o cobra. La clave de idempotencia va en la cabecera `Idempotency-Key` y es la dirección del cobro a partir de ahí. |
| `GET /internal/charges/:clave` | El cobro, o 404. Es la pregunta «¿este cobro es tuyo?». |
| `POST /internal/charges/:clave/capture` | Cobra lo retenido. Con un importe mayor, sube antes la autorización. |
| `POST /internal/charges/:clave/void` | Suelta una retención. |
| `POST /internal/charges/:clave/refund` | Devuelve dinero ya cobrado. |
| `POST /internal/charges/:clave/settle` | Reparte lo capturado entre chofer, valet y URBONT. Con `dryRun`, sólo calcula. |
| `GET /internal/charges/:clave/splits` | El reparto, tal como esté. |
| `POST /internal/webhooks/retry` | Reintenta los avisos del procesador que quedaron pendientes. |
| `POST /internal/reconciliation/run` | Cuadra un período contra el extracto del procesador. |
| `POST /webhooks/:provider` | Los avisos del procesador. **Sin firma de URBONT**: lo que autentica aquí es la firma del procesador, que comprueba su adaptador contra el cuerpo crudo. |
| `GET /healthz`, `GET /readyz` | Sondas. Sin firma. |

El importe nunca viaja en el cuerpo de `settle`: sale de lo que el libro dice
que se capturó.

Las dos tareas de `/internal` las dispara el cron de `urbont-api` y no un reloj
propio: el servicio corre con dos tareas en ECS, y un `setInterval` dentro haría
el cuadre dos veces.

En la otra dirección, el servicio llama a
`POST <URBONT_API_URL>/api/internal/payments/events` cuando un aviso del
procesador cambia algo, firmado con el mismo canon. Lo que viaja es un evento de
**URBONT** (`payment.captured`, `refund.succeeded`, `chargeback.opened`), no uno
de Stripe: añadir Square no toca ni una línea de `urbont-api`.

## Las dos reglas que gobiernan el diseño

1. **Una operación sobre un cobro existente va siempre al procesador que lo
   originó.** Capturar, reembolsar o disputar un cobro de Stripe sigue yendo a
   Stripe aunque el procesador por defecto ya sea otro. Sin esto, cambiar de
   proveedor rompería los cobros vivos y las disputas, que tardan hasta 120
   días en cerrarse.
2. **El importe y el destinatario nunca vienen de fuera.** El servicio recibe
   identificadores de URBONT y resuelve cuánto y a quién contra su propia base
   de datos. Es lo que cierra, por construcción, los fallos que la auditoría de
   septiembre encontró en `urbont-api`.

   Para el reparto, esto significa dos cosas concretas: lo que se reparte es lo
   que el libro dice que se capturó, y la cuenta de cobro de una persona se
   registra **una vez** y después manda la registrada. Cambiarla es una
   operación explícita, no un efecto colateral de pagar un viaje.

Y una invariante que las pruebas comprueban en cada reparto: **la suma de las
partes es exactamente lo capturado**, y **los asientos de un cobro suman cero**.
Un reparto que no cuadra es dinero que aparece o desaparece.

## Puesta en marcha

```bash
pnpm install
cp .env.example .env     # completar DATABASE_URL y SERVICE_SHARED_SECRET
pnpm migrate             # aplica el esquema `payments`
pnpm dev                 # http://localhost:8080/healthz
```

| Comando | Qué hace |
|---|---|
| `pnpm dev` | Arranca con recarga en caliente |
| `pnpm build` | Compila a `dist/` |
| `pnpm start` | Ejecuta lo compilado |
| `pnpm migrate` | Aplica las migraciones sin arrancar el servicio |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest |

Las migraciones se aplican solas al arrancar, **antes** de abrir el puerto: un
servicio de pagos que acepta peticiones con el esquema a medias deja cobros
huérfanos.

## Despliegue

ECS Fargate ARM64 en el cluster `urbont` que ya existe, detrás del mismo ALB
que `urbont-api`, con una regla de host para `payments.urbont.com`. Dos tareas
mínimo: a diferencia de `urbont-api`, este servicio no guarda estado en memoria.

Los secretos **no van dentro de la imagen**: ECS los inyecta desde AWS Secrets
Manager (ver [`taskdef.json`](taskdef.json)). El despliegue lo hace GitHub
Actions con OIDC, sin claves de larga vida.

El procedimiento completo, paso a paso, está en
[`docs/DESPLIEGUE.md`](docs/DESPLIEGUE.md).

## Seguridad

- El servicio **no se expone a la app móvil**. Sólo lo llaman `urbont-api` y los
  webhooks de los procesadores.
- Las llamadas entre servicios van firmadas con `SERVICE_SHARED_SECRET`.
- El usuario de base de datos sólo tiene permisos sobre el esquema `payments`.
- Los webhooks se verifican con el cuerpo crudo; sin eso, la firma no vale nada.
- Nada de datos de tarjeta toca este servicio: sólo referencias del procesador.
