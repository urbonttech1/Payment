# Activar Tap to Pay con Square: paso a paso

Cómo dejar a los iPhone de los choferes cobrando en persona con Square. La parte de OAuth se hace **una sola vez**; el resto son ajustes en el panel.

> **Qué hay detrás, en una frase:** el SDK de Square en el teléfono no usa el token del servidor, sino un token OAuth de 24 horas con tres permisos. El servidor lo pide con un *refresh token* que sale de autorizar la cuenta una vez. Por eso hacen falta tres datos: **Application ID, secreto y refresh token**.

## Antes de empezar, comprueba

- [ ] `curl -s https://payments.urbont.com/healthz` muestra la versión `2.4.1` o superior. Si no, el panel no enseña los campos nuevos.
- [ ] Tienes sesión en Square como **el vendedor de URBONT** (la cuenta dueña de los cobros) y acceso al panel de desarrolladores.
- [ ] Tienes el repositorio `urbont-payments` con `npm install` hecho.
- [ ] Tienes el panel de administración como **propietario**.

## 1. Datos de la aplicación en Square

En [developer.squareup.com](https://developer.squareup.com) → la aplicación → **OAuth** → pestaña **Production**:

| Dato | Valor |
|---|---|
| **Application ID** | `sq0idp-nqKO8v5Snt_ulP_4VL88hA` |
| **Application secret** | Cópialo con su botón. **No lo pegues en chats ni correos.** |
| **Redirect URL** | Tiene que haber uno registrado. Copia su valor exacto. |

## 2. Obtener el refresh token

En una terminal, dentro de `urbont-payments`:

```bash
export SQUARE_APPLICATION_ID=sq0idp-nqKO8v5Snt_ulP_4VL88hA
export SQUARE_ENVIRONMENT=production
export SQUARE_OAUTH_REDIRECT_URL='<la Redirect URL exacta>'
npx tsx scripts/square-oauth.ts
```

1. Imprime una URL. Ábrela, inicia sesión como el vendedor de URBONT y **acepta los permisos**.
2. Square te redirige a la Redirect URL. La página puede dar error o 404: es normal. **Copia la URL completa de la barra de direcciones** (lleva `?code=…`).
   El código vale **5 minutos y un solo uso**: haz el paso siguiente enseguida.
3. Canjéalo:

   ```bash
   read -rs SQUARE_APPLICATION_SECRET && export SQUARE_APPLICATION_SECRET   # pega el secreto (no se ve) y Enter
   npx tsx scripts/square-oauth.ts 'LA_URL_COPIADA'
   unset SQUARE_APPLICATION_SECRET
   ```

Imprime el **Refresh token** y la cuenta autorizada. **Comprueba que es la de URBONT.**

Si dice que el código ya se usó o caducó, repite desde el principio de este paso.

## 3. El interruptor

Panel → **Pagos → Configuración → Interruptor**:

- Deja marcado **solo `tap_to_pay`**.
- Porcentaje **100**.
- Guarda.

Para este flujo es todo o nada. Si marcas más flujos, el 100 % los mueve también al micro.

## 4. Las credenciales de Square

Panel → **Pagos → Configuración → Credenciales → Square**.

> ⚠️ **Al guardar se reemplaza todo el conjunto, no solo lo nuevo.** El panel no enseña los secretos, así que hay que escribir de nuevo **también los que ya estaban**.

Rellena todo:

| Campo | De dónde sale |
|---|---|
| Token de acceso | Square → Credentials → Production access token |
| Localización (`L…`) | Square → Locations |
| Entorno | Vacío = producción |
| **Clave de firma del webhook** | Square → Webhooks → la del endpoint |
| Application ID (Tap to Pay) | Paso 1 |
| Secreto de la aplicación (Tap to Pay) | Paso 1 |
| Refresh token (Tap to Pay) | Paso 2 |

Si la **clave de firma del webhook** queda vacía, el micro deja de verificar los avisos de Square.

Pulsa **Probar y guardar**. Si algo no vale, el panel lo dice y no cambia nada. Guardadas, las credenciales van cifradas.

## 5. Comprobar

- En un minuto el micro las recoge.
- En un iPhone de prueba, abre la app y cobra un viaje: debe salir la **hoja de Square**, no el error rojo de Stripe («Your account cannot currently make live charges»).

## Si algo falla

| Síntoma | Causa probable |
|---|---|
| El panel no muestra los tres campos de Tap to Pay | El micro desplegado es anterior a 2.4.0 |
| Square dice que el código ya se usó o caducó | Pasaron más de 5 minutos, o se canjeó dos veces: repetir el paso 2 |
| Square dice que falta el Redirect URL | Registrarlo en la página de OAuth de Square y repetir el paso 2 |
| «Probar y guardar» falla | El token de acceso o la localización están mal o faltan: recuerda reescribirlos |
| Sigue saliendo Stripe | El interruptor no está en 100 %, o las credenciales no se guardaron |

## Seguridad

- El secreto y el refresh token permiten cobrar en la cuenta de URBONT. Van **de Square o de tu terminal al panel**, nunca por chat ni correo.
- Si el secreto se compartió fuera de lo previsto: «Replace» en la página de OAuth de Square y repetir el paso 4 con todos los campos.
