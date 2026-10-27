# Puesta en producción

Guía para publicar la herramienta en un servidor propio con dirección HTTPS. Son unas dos horas la primera vez, sin contar la aprobación de las plantillas de WhatsApp ni la verificación de Stripe, que dependen de terceros.

## Cómo queda montado

```
Internet ──HTTPS──▶ Caddy (certificado automático) ──▶ aplicación (Node.js) ──▶ /data
                       puertos 80 y 443                  sin puerto público       ├─ crm.sqlite        base de datos
                                                                                   ├─ archivos/         documentos cifrados
                                                                                   └─ copias/           copia diaria cifrada
```

- Todo va en dos contenedores Docker (`deploy/docker-compose.yml`).
- **Caddy** obtiene y renueva solo el certificado HTTPS, redirige `http://` a `https://` y añade la cabecera HSTS.
- La **aplicación** no está expuesta directamente a internet. Solo acepta la IP del cliente que le pasa Caddy, que es la que queda en las evidencias de firma y desistimiento.
- **Copias de seguridad:** cada día a las 03:00 (hora de Madrid) se guarda una copia de la base de datos, comprimida y cifrada con `ARCHIVOS_CLAVE`, y se conservan 30 días. La primera se hace al arrancar por primera vez.
- **Arranque seguro:** la aplicación **no arranca en producción** si falta algo imprescindible: claves, datos del art. 48.1 EGAE, pasarela de pago real, un canal de mensajería o a quién avisar.

## 1. Antes de empezar

| Necesita | Para qué |
|---|---|
| Un subdominio, por ejemplo `segundaoportunidad.bustabadabogados.es` | La dirección de la página de captación y del panel |
| Un servidor (VPS) **en la UE** con Ubuntu 24.04 LTS, 2 GB de RAM y 1–2 vCPU | Alojamiento. Ver el apartado 2 |
| Cuenta de Resend (correo) y/o WhatsApp Business Cloud API | Mensajes a clientes. Hace falta al menos uno |
| Cuenta de Stripe verificada, con tarjeta y adeudo SEPA activados | Cobro de la entrada y las cuotas |
| Cuenta publicitaria de Meta con formularios instantáneos (opcional) | Entrada automática de leads de Facebook e Instagram |
| Contrato de encargado del tratamiento (art. 28 RGPD) con cada proveedor | Alojamiento, correo, WhatsApp/Meta, Stripe y, si se usa, Anthropic |

## 2. Elegir el servidor

Los datos de los clientes (situación económica, documentos de identidad, deudas) son personales y sensibles para el negocio. Por eso:

- **Elija un centro de datos en la UE** y un proveedor que firme contrato de encargado del tratamiento (art. 28 RGPD).
- **Active las copias automáticas del servidor** que ofrezca el proveedor. Las copias diarias de la aplicación se guardan en el mismo disco: protegen frente a errores y borrados, pero no frente a la pérdida del servidor.

Dos ejemplos de proveedores europeos con centros de datos propios en la UE:
- **Hetzner** (empresa alemana): centros en Falkenstein y Núremberg (Alemania) y Helsinki (Finlandia), con copias automáticas del servidor ([ubicaciones](https://docs.hetzner.com/cloud/general/locations/), [centros de datos](https://docs.hetzner.com/general/infrastructure-and-availability/data-centers-and-connection/)).
- **OVHcloud** (empresa francesa): regiones en Gravelines, Roubaix y Estrasburgo, en Francia ([regiones](https://www.ovhcloud.com/en/about-us/global-infrastructure/regions-new/)).

Si prefiere alojamiento en España, pida al proveedor confirmación por escrito de la ubicación del centro de datos antes de contratar.

## 3. Completar la configuración del despacho

Hágalo en el repositorio y súbalo a `main`, para que el servidor lo reciba con cada actualización:

1. `config/despacho.json`: sustituya todos los `COMPLETAR` (titular, NIF, colegio, número de colegiado, domicilio profesional, contacto de privacidad).
2. `config/agenda.json`: horario de consultas y sala de videollamada propia (`urlVideollamada`).
3. `config/calendario.json`: festivos autonómicos de 2026 y 2027.
4. `config/cierre.json`: enlace de reseñas de la ficha de Google (`resenas.urlGoogle`).
5. `web/marca.svg` y `web/favicon.svg`: el logotipo original. Si hay licencia web de Sifonn Pro, añada también `web/fuentes/sifonn-pro.woff2`.

Revise con criterio jurídico la hoja de encargo, la política de privacidad, el formulario de desistimiento, los mensajes y los borradores en Word antes de abrir al público.

## 4. Preparar el servidor

Conéctese por SSH y ejecute:

```sh
# Docker (método oficial: https://docs.docker.com/engine/install/ubuntu/)
curl -fsSL https://get.docker.com | sh

# Cortafuegos: solo SSH y web
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable

# Código de la aplicación
git clone https://github.com/fjrbustabadabogado-3103/test-repo.git /opt/despacho
```

Si el repositorio es privado, cree en GitHub una *deploy key* de solo lectura para el servidor (Settings → Deploy keys) y clone por SSH.

En el proveedor de DNS, cree un registro **A** del subdominio con la IP del servidor (y **AAAA** si tiene IPv6). Espere a que resuelva (`ping segundaoportunidad.bustabadabogados.es`) antes del paso 6: Caddy necesita que el dominio apunte al servidor para obtener el certificado.

## 5. Claves y servicios

```sh
cd /opt/despacho/deploy
./crear-env.sh      # crea deploy/.env con ADMIN_TOKEN, APP_SECRET y ARCHIVOS_CLAVE aleatorias
nano .env           # complete DOMINIO, EMAIL_CERTIFICADOS, mensajería, equipo y Stripe
```

> **Guarde `ADMIN_TOKEN` y `ARCHIVOS_CLAVE` en un gestor de contraseñas, fuera del servidor.** Sin `ARCHIVOS_CLAVE` no se pueden abrir los documentos de los clientes ni las copias de seguridad. Nadie, tampoco el proveedor, puede recuperarla.

Compruebe la configuración sin arrancar nada:

```sh
docker compose build
docker compose run --rm --no-deps app npm run comprobar
```

El resultado tiene dos partes:
- **Impiden arrancar:** hay que resolverlos.
- **Conviene revisar:** la aplicación funciona, pero falta algo recomendable, como los festivos o el enlace de reseñas.

## 6. Arrancar

```sh
docker compose up -d
docker compose ps          # app «healthy» y caddy «Up»
docker compose logs -f app # Ctrl+C para salir
```

Abra `https://SU-DOMINIO` (portada) y `https://SU-DOMINIO/admin` (panel; entre con `ADMIN_TOKEN`).

## 7. Conectar los servicios externos

| Servicio | Dónde | Valor |
|---|---|---|
| Stripe | Developers → Webhooks → Add endpoint | URL `https://SU-DOMINIO/webhooks/stripe`. Eventos: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `payment_intent.succeeded`, `payment_intent.payment_failed`. El *signing secret* va en `STRIPE_WEBHOOK_SECRET` |
| Meta (formularios instantáneos) | App de Meta → Webhooks → Page → `leadgen` | URL `https://SU-DOMINIO/webhooks/meta` y el mismo `META_VERIFY_TOKEN` del `.env` |
| WhatsApp (respuestas y bajas) | App de Meta → WhatsApp → Configuración → Webhook → `messages` | La misma URL `https://SU-DOMINIO/webhooks/meta` |
| Plantillas de WhatsApp | WhatsApp Manager | Una por cada mensaje de `config/mensajes.json` (campo `whatsapp`), en español. Hay que esperar a que Meta las apruebe |
| Calendario de plazos | Panel → Plazos procesales | Copie la URL `.ics` en Google Calendar u Outlook («Añadir calendario desde URL») |

Después de cambiar el `.env`: `docker compose up -d` (recrea la aplicación con los valores nuevos).

## 8. Prueba completa antes de atender clientes

Primero con las claves **de prueba** de Stripe (`sk_test_…`) y su *signing secret* de prueba. Recorra el flujo con su propio teléfono:
1. Cuestionario en la portada.
2. Llegada del mensaje y reserva de la consulta.
3. Desde el panel, propuesta de hoja de encargo.
4. Firma con el código recibido.
5. Pago de la entrada con la tarjeta de prueba de Stripe.
6. Apertura del expediente y subida de un documento.
7. Una actuación procesal y el plazo resultante.
8. Desistimiento de prueba.

Compruebe que llegan los avisos al equipo. Después cambie a las claves reales (`sk_live_…`) y vuelva a crear el webhook en modo real.

## 9. Mantenimiento

**Actualizar** tras fusionar cambios en `main`:

```sh
cd /opt/despacho && git pull && cd deploy && docker compose up -d --build
```

**Copias de seguridad:**

```sh
docker compose exec app npm run -s restaurar -- --listar                      # copias disponibles
docker compose cp app:/data/copias ./copias-$(date +%F)                      # bajar una copia al servidor
scp -r root@SERVIDOR:/opt/despacho/deploy/copias-AAAA-MM-DD ./               # y desde su ordenador
```

Las copias van cifradas: se pueden guardar en cualquier sitio, pero solo se abren con `ARCHIVOS_CLAVE`. Se recomienda bajar una al mes a un lugar distinto del servidor.

**Restaurar** la base de datos desde una copia:

```sh
docker compose stop app
docker compose run --rm --no-deps app npm run -s restaurar -- /data/copias/copia-AAAAMMDD-HHMMSS.sqlite.gz.cifrado /data/crm.sqlite --forzar
docker compose start app
```

El script comprueba la integridad e indica cuántos leads, encargos, expedientes y plazos contiene. Los documentos (`/data/archivos`) se recuperan con las copias automáticas del servidor.

**Vigilancia:** dé de alta `https://SU-DOMINIO/health` en un servicio de monitorización de disponibilidad. Responde `{"ok":true}` si la aplicación y la base de datos funcionan; si deja de responder, le avisará.

## 10. Problemas frecuentes

| Síntoma | Causa y solución |
|---|---|
| `docker compose ps` muestra la aplicación reiniciándose | Falta algo imprescindible. `docker compose logs app` lo enumera; `npm run comprobar` (paso 5) da el detalle |
| Error de certificado o la web no carga | El DNS aún no apunta al servidor o los puertos 80/443 están cerrados. `docker compose logs caddy` |
| No llegan los mensajes | Plantillas de WhatsApp sin aprobar o dominio de correo sin verificar en Resend. En la ficha del lead, «Mensajes enviados» muestra el estado de cada envío (`error` si falló) |
| Los pagos no cambian de estado | Webhook de Stripe con otra URL, otros eventos o un *signing secret* distinto del de `STRIPE_WEBHOOK_SECRET` |
| Los plazos aparecen como «verificar» | Faltan los festivos autonómicos del año en `config/calendario.json` o los locales del procedimiento |
