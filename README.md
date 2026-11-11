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
    square/                Adaptador Square        ← fase 7
    conformidad.ts         Las pruebas que todo adaptador tiene que pasar
  payments/    Casos de uso: autorizar, capturar, reembolsar   ← fase 2
  ledger/      Libro de cobros, asientos e idempotencia        ← fases 2 y 4
  internal/    Lo que llama urbont-api, firmado                ← fase 3
  splits/      Reparto: chofer, valet, plataforma              ← fase 4
  payees/      La cuenta de cobro de cada persona, por procesador ← fase 4
  webhooks/    Avisos del procesador: firma, idempotencia y aviso a urbont-api ← fase 6
  reconciliation/ Cuadre contra el extracto del procesador     ← fase 6
  (el cobro presencial vive en payments/ e internal/)          ← fase 8
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
| `POST /internal/terminal/session` | El token con el que el teléfono del chofer se vuelve lector. |
| `POST /internal/terminal/charges` | Prepara un cobro presencial. Lo remata el SDK del teléfono. |
| `POST /internal/webhooks/retry` | Reintenta los avisos del procesador que quedaron pendientes. |
| `POST /internal/reconciliation/run` | Cuadra un período contra el extracto del procesador. |
| `POST /webhooks/:provider` | Los avisos del procesador. **Sin firma de URBONT**: lo que autentica aquí es la firma del procesador, que comprueba su adaptador contra el cuerpo crudo. |
| `GET /healthz`, `GET /readyz` | Sondas. Sin firma. Las dos dicen la **versión** que está sirviendo. |

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

## Añadir un procesador

Un procesador es un módulo que implementa `PaymentProvider`. Para que eso sea
verdad y no una aspiración, hay una **suite de conformidad**
(`src/providers/conformidad.ts`) que todo adaptador tiene que pasar: se
implementa el arnés con el transporte falso que se quiera y se llama a
`pruebasDeConformidad`. El de Stripe es el ejemplo a copiar
(`src/providers/stripe/stripe.conformidad.test.ts`).

Lo que comprueba no es teórico. Cada regla está ahí porque su incumplimiento ya
costó dinero en este proyecto: que el cobro no lleve el reparto dentro, que todo
lo que mueve dinero lleve clave de idempotencia, y que una retención no vuelva
como cobrada. Y la propia suite tiene pruebas (`conformidad.test.ts`), porque
una que pase siempre da una confianza falsa.

### Lo que enseñó el segundo adaptador

Square pasa la suite entera, y eso es la buena noticia: el contrato aguanta un
procesador que por dentro funciona distinto. Lo valioso son las diferencias que
sólo aparecen al escribirlo, y que están **declaradas en `capabilities`** en vez
de descubrirse en producción.

| | Stripe | Square |
|---|---|---|
| Crear el cobro | el servidor lo crea, la app lo confirma con el `clientSecret` | **la app tokeniza primero** y manda el token en la creación |
| Capturar menos | `amount_to_capture` | bajar el importe aprobado y completar (dos llamadas) |
| Subir el importe | `paymentIntents.update` | el mismo `UpdatePayment` |
| Pagar al chofer | transferencia por beneficiario | **no se puede por aquí** |
| Guardar una tarjeta | `SetupIntent` desde el servidor | **no se puede por aquí**: necesita token de la app |
| Metadata | 50 claves | no existe: sólo `reference_id` y una nota |
| Tap to Pay | token de sesión del servidor | su SDK usa el token OAuth; no hay equivalente |

Las tres filas en negrita son las que importan antes de encender nada:

- **El reparto.** Square no transfiere a terceros: el reparto va dentro del
  cobro (`appFeeMoney`), con el chofer como vendedor. El contrato no lleva
  beneficiario en el cobro —a propósito— así que un cobro hecho por Square **no
  se puede repartir con el motor de hoy**. El adaptador lo dice en
  `capabilities` (`payouts: false`, `splitAtCapture: false`) y `transfer()`
  lanza en voz alta, de modo que el reparto queda fallido a la vista en vez de
  darse por pagado. Esa es una regla nueva de la suite: *o sabe pagarle al
  chofer, o se niega en voz alta*.
- **El cobro del viaje por Square necesita cambio de app**, porque hoy la app
  no manda ningún token de tarjeta.
- **Una tarjeta pertenece al procesador que la guardó.** Hoy el registro elige
  el procesador de un cobro con tarjeta guardada por capacidad, no por quién
  guardó la tarjeta. Con `savedCards: false` en Square no puede pasar nada malo,
  pero el día que haya dos procesadores que guarden tarjetas, esa elección tiene
  que hacerse por el dueño de la tarjeta.

Las credenciales de un procesador nuevo **no son variables de entorno**: se
pegan en el panel (URBONT PAYMENTS → Configuración), se prueban contra el
procesador antes de guardarse y se guardan cifradas. Lo único que hay que
escribir en el servicio es su lista de campos (`CAMPOS` en
`src/config/credentials.service.ts`) y el panel dibuja el formulario solo.

## Desplegar

```bash
git push && docker build --platform linux/arm64 -t 083414536603.dkr.ecr.us-east-1.amazonaws.com/urbont-payments:latest . && docker push 083414536603.dkr.ecr.us-east-1.amazonaws.com/urbont-payments:latest && aws ecs update-service --cluster urbont --service urbont-payments --force-new-deployment --region us-east-1 --profile urbont
```

`--platform linux/arm64` no es opcional: las tareas corren en Fargate ARM64 y
una imagen de otra arquitectura falla al arrancar, no al construir.

Tarda unos dos minutos en relevar las dos tareas. Para comprobar qué quedó
sirviendo, `curl -s https://payments.urbont.com/healthz` dice la versión.

Para volver atrás, las revisiones viejas de la definición no se borran:

```bash
aws ecs update-service --cluster urbont --service urbont-payments \
  --task-definition urbont-payments:7 --region us-east-1 --profile urbont
```

## La versión

Manda `src/version.ts`, una constante en el código. No se lee de
`npm_package_version` porque en producción el proceso lo arranca ECS con `node
dist/src/main.js`, no npm, y esa variable llegaría vacía justo donde se
consulta. `package.json` la copia, y una prueba falla si se separan.

Se ve en `/healthz`, en `/readyz`, en la línea del arranque y en el panel de
Stripe junto a cada cobro que este servicio crea. Con eso, «¿está desplegado lo
último?» se responde con un `curl`:

```bash
curl -s https://payments.urbont.com/healthz
# {"status":"ok","service":"urbont-payments","version":"1.0.0","checks":{"db":"ok"},…}
```

Se sube el tercer número cuando el cambio no se nota desde fuera; el segundo
cuando el servicio hace algo nuevo (otra pasarela, otro flujo, otra ruta); el
primero cuando algo que ya usaba alguien deja de funcionar igual: una ruta de
`/internal` que cambia de forma, el canon de la firma, o el contrato de los
adaptadores.

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
