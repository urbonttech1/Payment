# URBONT PAYMENTS — despliegue en AWS

Región `us-east-1`, cuenta `083414536603`, perfil `urbont`. El servicio va en el
cluster ECS **`urbont`** que ya existe y cuelga del **mismo ALB** que
`urbont-api`, así que no hay balanceador nuevo que pagar.

Todos los comandos son de una sola vez: una vez creada la infraestructura, los
despliegues los hace GitHub Actions.

---

## Estado — 10 nov 2026

**Creado y en pie:**

| | |
|---|---|
| ECR | `urbont-payments`, con política de las 10 últimas imágenes. Primera imagen subida: `d8bc041` |
| Logs | `/ecs/urbont-payments`, 30 días de retención |
| Roles | `urbontPaymentsExecutionRole`, `urbontPaymentsTaskRole`, `urbontPaymentsDeployRole` (OIDC) |
| Proveedor OIDC | `token.actions.githubusercontent.com` |
| Grupo de seguridad | `urbont-payments-task-sg` (`sg-0c22b4af8e7a93b99`): entra el 8080 **sólo** desde el SG del ALB |
| Target group | `urbont-payments-tg`, health check `/healthz` |
| Regla del ALB | prioridad 20, host `payments.urbont.com` → el target group |
| Certificado ACM | `payments.urbont.com`, **PENDING_VALIDATION** |
| Servicio ECS | `urbont-payments`, **0 tareas** |

**Lo que falta, y es de Felipe:**

1. **Las cinco variables de entorno** del paso 1. Sin `DATABASE_URL` y
   `SERVICE_SHARED_SECRET` el servicio se niega a arrancar a propósito, que es
   por lo que está en 0 tareas y no reiniciándose en bucle.
2. **El usuario `urbont_payments` en Supabase** (paso 2), que es de donde sale
   `DATABASE_URL`.
3. **Dos registros DNS en Spaceship** (paso 5), que es donde vive `urbont.com`:
   el CNAME de validación del certificado y el de `payments.urbont.com`.
4. **`PAYMENTS_SERVICE_URL` y `PAYMENTS_SERVICE_SECRET` en `urbont-api`**, con
   el mismo valor de `SERVICE_SHARED_SECRET`, y redesplegarla. Hasta entonces
   la API no sabe que el micro existe.

Después: subir a 2 tareas y registrar el autoescalado (paso 6).

---

## Lo que cambia respecto a `urbont-api`

| | `urbont-api` | `urbont-payments` |
|---|---|---|
| Tareas | 1 (su código no soporta más) | **2**, con autoescalado |
| Secretos | dentro de la imagen (`COPY .env`) | **fuera de la imagen**, en la definición de tarea |
| Despliegue | a mano desde el portátil | **GitHub Actions + OIDC** |
| Red | subred pública, SG abierto por el ALB | subred pública, **SG propio** que sólo abre el 8080 al ALB |

Que los secretos salgan de la imagen no es una preferencia: una imagen con el
`.env` dentro los deja en una capa inmutable que cualquiera con `docker pull`
puede leer, y en un servicio de pagos esas claves son el dinero. En la
definición de tarea siguen siendo legibles para quien tenga permisos de ECS
—por eso lo normal sería Secrets Manager— pero ya no viajan con la imagen ni
están en el repositorio. Y un despliegue manual de dinero, sin registro de quién
lo hizo ni desde qué commit, no es auditable.

---

## Paso 1 — Variables de entorno

**Decisión tomada el 10 nov 2026: sin Secrets Manager.** Los valores van en la
propia definición de tarea. Hay que saber lo que eso significa: quedan en texto
plano para cualquiera que pueda hacer `ecs:DescribeTaskDefinition`, y en todas
las revisiones anteriores, que no se borran. Cambiar de opinión más adelante es
mover cinco valores a secretos y volver a registrar la definición.

Lo que **no** cambia: los valores no están en el repositorio. `taskdef.json`
los lleva vacíos, y el despliegue automático parte de la definición **viva** en
ECS, no del fichero, justo para no borrarlos en cada push.

Las cinco que hay que poner:

| | |
|---|---|
| `DATABASE_URL` | El Postgres de Supabase con el usuario propio del paso 2 |
| `SERVICE_SHARED_SECRET` | 32 bytes (`openssl rand -hex 32`). **El mismo valor** va en `PAYMENTS_SERVICE_SECRET` de `urbont-api` |
| `CREDENTIALS_KEY` | 32 bytes. Es lo que cifra las credenciales que se pegan en el panel; sin ella el panel no puede guardar ninguna pasarela |
| `STRIPE_SECRET_KEY` | La misma cuenta que usa `urbont-api` hoy |
| `STRIPE_WEBHOOK_SECRET` | El del endpoint que apunte al micro (paso 7) |

Se ponen editando `environment` en la consola de ECS (definición de tarea →
crear revisión nueva) o, sin pasar por el historial del shell, con un fichero:

```bash
aws ecs describe-task-definition --task-definition urbont-payments \
  --query 'taskDefinition' --output json > /tmp/td.json
# editar /tmp/td.json: poner los valores en `environment`
aws ecs register-task-definition --cli-input-json file:///tmp/td.json \
  --region us-east-1 --profile urbont
aws ecs update-service --cluster urbont --service urbont-payments \
  --task-definition urbont-payments --desired-count 2 \
  --region us-east-1 --profile urbont
```

### Lo que no es secreto y ya está puesto

`PLATFORM_COMMISSION_RATE` (0.15, que es lo que de verdad se cobra hoy) y
`STRIPE_TERMINAL_LOCATION_ID`, la *location* de Stripe Terminal para Tap to Pay.
Sin esa location el token del lector sale genérico: vale para el lector simulado
y no para cobrar en un iPhone de verdad. Es la misma que ya usa `urbont-api`.

## Paso 2 — Usuario de base de datos

En el SQL editor de Supabase. El servicio escribe en su esquema y sólo lee de
`public` lo que necesita para conciliar:

```sql
CREATE USER urbont_payments WITH PASSWORD '<generada>';

CREATE SCHEMA IF NOT EXISTS payments AUTHORIZATION urbont_payments;
GRANT ALL ON SCHEMA payments TO urbont_payments;
GRANT ALL ON ALL TABLES IN SCHEMA payments TO urbont_payments;
ALTER DEFAULT PRIVILEGES IN SCHEMA payments GRANT ALL ON TABLES TO urbont_payments;

-- Sólo lectura de los viajes, para cuadrar importes. Nada de escritura.
GRANT USAGE ON SCHEMA public TO urbont_payments;
GRANT SELECT ON public.rides, public.profiles TO urbont_payments;
```

## Paso 3 — Repositorio de imágenes

```bash
aws ecr create-repository \
  --repository-name urbont-payments \
  --image-scanning-configuration scanOnPush=true \
  --region us-east-1 --profile urbont

aws ecr put-lifecycle-policy \
  --repository-name urbont-payments \
  --lifecycle-policy-text '{"rules":[{"rulePriority":1,"description":"Conservar las ultimas 10","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":10},"action":{"type":"expire"}}]}' \
  --region us-east-1 --profile urbont
```

## Paso 4 — Roles

Tres roles, cada uno con lo justo:

- **`urbontPaymentsExecutionRole`** — el que usa ECS para arrancar la tarea:
  `AmazonECSTaskExecutionRolePolicy` más `logs:CreateLogGroup` sobre su propio
  grupo. Sin Secrets Manager no necesita leer ningún secreto.
- **`urbontPaymentsTaskRole`** — el del propio contenedor. Sin políticas: el
  servicio no llama a ninguna API de AWS.
- **`urbontPaymentsDeployRole`** — el que asume GitHub por OIDC. Confía sólo en
  `repo:urbonttech1/Payment:ref:refs/heads/master` —con la P mayúscula: el
  claim `sub` distingue mayúsculas—, y puede hacer push a ECR y
  actualizar este servicio, nada más.

```bash
# Proveedor OIDC de GitHub (una sola vez en la cuenta; si ya existe, se salta)
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 \
  --profile urbont
```

Confianza de `urbontPaymentsDeployRole`:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::083414536603:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": "repo:urbonttech1/Payment:ref:refs/heads/master" }
    }
  }]
}
```

## Paso 5 — Target group y regla en el ALB

El ALB ya existe (`urbont-api-alb`). Se le añade un target group y una regla por
host, sin tocar lo que ya sirve a la API:

```bash
TG_ARN=$(aws elbv2 create-target-group \
  --name urbont-payments-tg \
  --protocol HTTP --port 8080 \
  --vpc-id $VPC --target-type ip \
  --health-check-path /healthz \
  --health-check-interval-seconds 30 \
  --health-check-timeout-seconds 10 \
  --healthy-threshold-count 2 --unhealthy-threshold-count 3 \
  --query 'TargetGroups[0].TargetGroupArn' --output text \
  --region us-east-1 --profile urbont)

# Sin stickiness: este servicio no guarda estado en memoria y puede atender
# cualquier petición desde cualquier tarea.
aws elbv2 modify-target-group-attributes --target-group-arn $TG_ARN \
  --attributes Key=deregistration_delay.timeout_seconds,Value=20 \
  --region us-east-1 --profile urbont

aws elbv2 create-rule \
  --listener-arn $LISTENER_HTTPS_ARN \
  --priority 20 \
  --conditions Field=host-header,Values=payments.urbont.com \
  --actions Type=forward,TargetGroupArn=$TG_ARN \
  --region us-east-1 --profile urbont
```

**El DNS de `urbont.com` no está en Route 53**, sino en Spaceship (`launch1/2.
spaceship.net`), así que los dos registros los añade una persona a mano allí:

1. El **CNAME de validación** que pide ACM, o el certificado se queda en
   `PENDING_VALIDATION` y caduca a los 72 días sin emitirse.
2. `payments.urbont.com` **CNAME** → `urbont-api-alb-1133054372.us-east-1.elb.amazonaws.com`.

Con el certificado ya `ISSUED`, se añade al listener que ya existe:

```bash
aws elbv2 add-listener-certificates --listener-arn $LISTENER_HTTPS_ARN \
  --certificates CertificateArn=$CERT_ARN --region us-east-1 --profile urbont
```

Sin ese paso el ALB responde a `payments.urbont.com` con el certificado de
`api.urbont.com` y el TLS falla antes de llegar a ninguna ruta.

## Paso 6 — Servicio

```bash
aws ecs register-task-definition --cli-input-json file://taskdef.json \
  --region us-east-1 --profile urbont

aws ecs create-service \
  --cluster urbont --service-name urbont-payments \
  --task-definition urbont-payments \
  --desired-count 2 \
  --launch-type FARGATE \
  --health-check-grace-period-seconds 60 \
  --deployment-configuration minimumHealthyPercent=100,maximumPercent=200 \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_A,$SUBNET_B],securityGroups=[$SG_TASK],assignPublicIp=DISABLED}" \
  --load-balancers "targetGroupArn=$TG_ARN,containerName=payments,containerPort=8080" \
  --region us-east-1 --profile urbont
```

> **Se desplegó con `assignPublicIp=ENABLED`**, en las mismas subredes públicas
> que `urbont-api`. `DISABLED` exige salida a internet por NAT o endpoints de
> VPC —el servicio llama a la API del procesador— y el NAT Gateway son unos
> $33/mes, más que todo el resto junto. Lo que protege la tarea mientras tanto
> es su grupo de seguridad: el 8080 sólo acepta entrada desde el SG del ALB.
> Queda anotado como deuda.

Autoescalado por CPU:

```bash
aws application-autoscaling register-scalable-target \
  --service-namespace ecs --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/urbont/urbont-payments \
  --min-capacity 2 --max-capacity 6 \
  --region us-east-1 --profile urbont

aws application-autoscaling put-scaling-policy \
  --service-namespace ecs --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/urbont/urbont-payments \
  --policy-name cpu-70 --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration \
    '{"TargetValue":70,"PredefinedMetricSpecification":{"PredefinedMetricType":"ECSServiceAverageCPUUtilization"}}' \
  --region us-east-1 --profile urbont
```

## Paso 7 — Comprobar

```bash
curl -s https://payments.urbont.com/healthz | jq
# {"status":"ok","service":"urbont-payments","checks":{"db":"ok"},...}
```

Si responde `503` con `checks.db: "caída"`, el servicio está vivo pero no llega
a Postgres: casi siempre es el grupo de seguridad o el `DATABASE_URL` del
secreto.

---

## Coste mensual

| Componente | |
|---|---|
| Fargate ARM64 0.5 vCPU / 1 GB × 2 tareas | ~$29 |
| ECR + CloudWatch Logs | ~$3 |
| ALB | $0 — se reutiliza el de la API |
| **Total** | **~$32** |

Un NAT Gateway añadiría $33 si se opta por subred privada de verdad.

---

## Operación

Un despliegue es un push a `master`: GitHub Actions comprueba tipos y tests,
construye para ARM64, sube a ECR con el SHA del commit y espera a que el
servicio quede estable.

Para volver atrás, se vuelve a desplegar la definición de tarea anterior:

```bash
aws ecs update-service --cluster urbont --service urbont-payments \
  --task-definition urbont-payments:<revisión anterior> \
  --region us-east-1 --profile urbont
```

Logs: `aws logs tail /ecs/urbont-payments --follow --region us-east-1 --profile urbont`
