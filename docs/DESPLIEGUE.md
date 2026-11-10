# URBONT PAYMENTS — despliegue en AWS

Región `us-east-1`, cuenta `083414536603`, perfil `urbont`. El servicio va en el
cluster ECS **`urbont`** que ya existe y cuelga del **mismo ALB** que
`urbont-api`, así que no hay balanceador nuevo que pagar.

Todos los comandos son de una sola vez: una vez creada la infraestructura, los
despliegues los hace GitHub Actions.

---

## Lo que cambia respecto a `urbont-api`

| | `urbont-api` | `urbont-payments` |
|---|---|---|
| Tareas | 1 (su código no soporta más) | **2**, con autoescalado |
| Secretos | dentro de la imagen (`COPY .env`) | **Secrets Manager** |
| Despliegue | a mano desde el portátil | **GitHub Actions + OIDC** |
| Red | subred pública con IP pública | **subred privada** |

Las dos primeras no son preferencias. Una imagen con el `.env` dentro deja las
claves en una capa que cualquiera con `docker pull` puede leer; en un servicio
de pagos esas claves son el dinero. Y un despliegue manual de dinero sin
registro de quién lo hizo ni desde qué commit no es auditable.

---

## Paso 1 — Secretos

```bash
for nombre in DATABASE_URL SERVICE_SHARED_SECRET STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_WEBHOOK_SECRET_CONNECT; do
  aws secretsmanager create-secret \
    --name "urbont/payments/$nombre" \
    --description "URBONT PAYMENTS — $nombre" \
    --region us-east-1 --profile urbont
done
```

Y se les pone valor uno a uno (nunca en el historial del shell: con `fd` o
desde la consola):

```bash
aws secretsmanager put-secret-value \
  --secret-id urbont/payments/SERVICE_SHARED_SECRET \
  --secret-string "$(openssl rand -hex 32)" \
  --region us-east-1 --profile urbont
```

`DATABASE_URL` apunta al mismo Postgres de Supabase, pero con **un usuario
propio** (paso 2).

### Lo que NO es secreto y va en el taskdef

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
  `AmazonECSTaskExecutionRolePolicy` más permiso de lectura sobre los cuatro
  secretos de `urbont/payments/*`.
- **`urbontPaymentsTaskRole`** — el del propio contenedor. Sin políticas: el
  servicio no llama a ninguna API de AWS.
- **`urbontPaymentsDeployRole`** — el que asume GitHub por OIDC. Confía sólo en
  `repo:urbonttech1/payments:ref:refs/heads/master`, y puede hacer push a ECR y
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
      "StringLike": { "token.actions.githubusercontent.com:sub": "repo:urbonttech1/payments:ref:refs/heads/master" }
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

El certificado de `payments.urbont.com` se añade al listener existente
(`aws elbv2 add-listener-certificates`), y en Route 53 va un registro A alias al
mismo ALB.

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

> `assignPublicIp=DISABLED` exige que las subredes tengan salida a internet por
> NAT o endpoints de VPC, porque el servicio llama a la API del procesador. Si
> el NAT Gateway (unos $33/mes) no entra en el presupuesto ahora, se arranca con
> `ENABLED` en subred pública y un grupo de seguridad que sólo acepta entrada
> desde el del ALB, y se anota como deuda.

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
| Secrets Manager (4 secretos) | ~$1.60 |
| **Total** | **~$34** |

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
