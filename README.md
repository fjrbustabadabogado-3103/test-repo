# Bustabad Abogados · Captación y contratación automatizadas (Ley de Segunda Oportunidad)

Aplicación que automatiza los tres primeros módulos del negocio:

1. **Captación**: formulario web y formularios instantáneos de Meta (Facebook/Instagram), con atribución por campaña y envío de las etapas del CRM a la API de Conversiones de Meta.
2. **Cualificación y agenda**: semáforo automático basado en el TRLC, respuesta por WhatsApp en segundos, reserva de la consulta online, recordatorios, seguimientos y gestión de ausencias.
3. **Contratación y cobro**: hoja de encargo generada desde el panel, firma electrónica con código de un solo uso, pago de la entrada (tarjeta o SEPA) y cobro automático de las cuotas.

Sin credenciales funciona **entero en local**: los WhatsApp y correos se guardan en la bandeja de salida (tabla `salida`) y los pagos son simulados.

## Puesta en marcha

Requisitos: Node.js 22.13 o superior (usa el SQLite integrado de Node; no hay dependencias nativas).

```bash
npm install
cp .env.example .env      # rellenar según la sección "Integraciones"
npm start                 # http://localhost:3000
npm test                  # 26 pruebas: reglas, agenda, pagos, firmas y flujo completo
```

Las variables de entorno se leen del entorno del proceso. Para usar el fichero `.env` en local: `node --env-file=.env src/index.js`.

| Página | Para quién |
|---|---|
| `/` | Página de captación con el cuestionario de viabilidad |
| `/reservar/:token` | Reserva de la consulta (enlace personal que recibe cada lead) |
| `/encargo/:token` | Hoja de encargo: firma, pago, cuotas y desistimiento |
| `/admin` | Panel del despacho: métricas, leads, ficha y envío de propuestas (en desarrollo el token es `dev-admin`) |
| `/privacidad` | Política de privacidad generada desde `config/despacho.json` |

## Cómo funciona el flujo

```
Formulario (web o Meta) ──► semáforo TRLC ──► WhatsApp inmediato con enlace de reserva + aviso al equipo
        │                         │
        │                  rojo: mensaje neutro y revisión por un abogado (nunca se descarta automáticamente)
        ▼
Seguimientos a las 3 h, 24 h y 72 h si no reserva (solo con consentimiento) ──► "perdido" a los 7 días
        ▼
Reserva ──► confirmación + recordatorios 24 h y 1 h ──► el abogado marca "Consulta hecha" o "No asistió"
        │                                                       │
        │                                    secuencia para reprogramar (día 0 y día 2)
        ▼
Panel: honorarios, entrada y cuotas ──► hoja de encargo por WhatsApp (recordatorios a 1 y 3 días)
        ▼
Firma con código de un solo uso ──► confirmación por correo ──► pago de la entrada ──► CLIENTE
        ▼
Cuotas cobradas automáticamente en su vencimiento · reintentos y aviso si fallan
```

Si el lead responde por WhatsApp, se detienen los automatismos comerciales y se avisa a una persona. Si responde **BAJA**, no recibe más mensajes comerciales.

## Configuración del negocio (`config/`)

| Fichero | Contenido |
|---|---|
| `despacho.json` | Datos de identificación del art. 48.1 EGAE, qué incluye y qué no el encargo, IVA, día de cobro, cláusula de impago y plazo de conservación de datos. **Sustituir todos los `COMPLETAR`**: la aplicación no arranca en producción si queda alguno. |
| `cualificacion.json` | Umbral comercial de deuda mínima, acreedores mínimos y límites del crédito público exonerable. |
| `agenda.json` | Horario de consultas, duración, festivos y enlace de videollamada. Por defecto usa salas de Jitsi; para mayor confidencialidad, sustituirlo por la sala propia del despacho (Google Meet, Teams…). |
| `mensajes.json` | Textos de cada mensaje y nombre de la plantilla de WhatsApp correspondiente. |
| `captacion.json` | Correspondencia de campos del formulario de Meta, tiempos de seguimiento y nombres de los eventos que se envían a Meta. |

## Integraciones

### Meta: formularios instantáneos + API de Conversiones
1. Crear una app en Meta for Developers con los productos *Webhooks* y *Lead Ads* (permiso `leads_retrieval`).
2. Webhook de la página, campo `leadgen`: URL `https://TU-DOMINIO/webhooks/meta`, token de verificación = `META_VERIFY_TOKEN`.
3. `META_APP_SECRET` (se verifica la firma `X-Hub-Signature-256` de cada aviso) y `META_ACCESS_TOKEN` (token de sistema con acceso a la página).
4. En el formulario instantáneo, nombrar las preguntas personalizadas como en `config/captacion.json` (`deuda_total`, `numero_acreedores`, `tipo_deudor`…) e incluir una casilla `acepta_comunicaciones`.
5. API de Conversiones: `META_DATASET_ID`. Cada cambio de etapa (cualificado, cita, consulta, firma, cliente) se envía con `action_source: system_generated` y el `lead_id` de Meta, para optimizar las campañas hacia **clientes** y no hacia formularios. Comprobarlo primero con `META_TEST_EVENT_CODE` en el Administrador de eventos.

### WhatsApp Cloud API
1. `WHATSAPP_TOKEN` y `WHATSAPP_PHONE_NUMBER_ID`.
2. Crear y aprobar en WhatsApp Manager una plantilla por cada entrada de `config/mensajes.json` (campo `whatsapp`), con las variables `{{1}}`, `{{2}}`… en el orden de `parametros`. Los mensajes que inicia la empresa fuera de la ventana de 24 h tienen que ser plantillas aprobadas.
3. Suscribir el mismo webhook (`/webhooks/meta`) al campo `messages` para recibir respuestas y bajas.
4. `EQUIPO_WHATSAPP`: teléfonos que reciben el aviso de "lead caliente, llamar ya".

### Correo
`RESEND_API_KEY` y `EMAIL_FROM`. Se usa como alternativa a WhatsApp y para la confirmación del contrato en soporte duradero. Se puede sustituir por otro proveedor modificando `src/messaging/proveedores.js`.

### Stripe (pagos)
1. `PAGOS_PROVEEDOR=stripe`, `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET`.
2. Webhook `https://TU-DOMINIO/webhooks/stripe` con los eventos `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `payment_intent.succeeded` y `payment_intent.payment_failed`.
3. Activar tarjeta y adeudo SEPA en el panel de Stripe. La entrada se paga en Checkout guardando el método de pago, y las cuotas se cargan solas en su vencimiento.
4. **Probar todo el ciclo en modo test de Stripe antes de cobrar a clientes reales**: el código de Stripe se ha probado con respuestas simuladas, no contra la API real.

## Base legal aplicada (comprobada en el BOE consolidado)

| Norma | Dónde se aplica |
|---|---|
| TRLC arts. 486, 487, 488 y 489 | Semáforo: solo persona natural, excepciones de buena fe, plazos de nueva exoneración, deudas no exonerables y límite de 10.000 € de crédito público (íntegros los primeros 5.000 € y el 50 % del resto) |
| TRLC art. 510 | La hoja de encargo informa de que el procurador es obligatorio y presupuesta su provisión de fondos |
| EGAE (RD 135/2021) art. 20 | Textos sin promesas de resultado ni incitación al pleito |
| EGAE art. 48 | Identificación del profesional, viabilidad, honorarios en hoja de encargo, costas e información del asunto |
| TRLGDCU art. 98.2 | El botón de firma dice "pedido con obligación de pago" y se confirma expresamente la obligación de pago |
| TRLGDCU arts. 98.8, 103.a y 108.4 | Casilla opcional para empezar durante el plazo de desistimiento, con el aviso de pago proporcional |
| TRLGDCU art. 98.7 y 98.9 | Confirmación por correo con el documento íntegro; identificación con código de un solo uso, DNI y huella SHA-256 del documento |
| TRLGDCU art. 104 | Desistimiento online durante 14 días naturales desde la firma; el servicio empieza al terminar ese plazo si no se pide antes |
| LSSI art. 21 | Los seguimientos comerciales solo se envían con consentimiento y con baja respondiendo BAJA |
| RGPD art. 28 | Hay que firmar un contrato de encargado con cada proveedor (Meta, Stripe, correo, alojamiento) |
| RD 1007/2023 (Veri\*factu) | La aplicación **no emite facturas**: conectar un programa de facturación certificado a los pagos cobrados |

## Antes de pasar a producción

- [ ] Completar `config/despacho.json` y **revisar la plantilla de la hoja de encargo** (`src/modules/contratacion/hoja-encargo.js`) y la política de privacidad (`src/paginas.js`). Son plantillas base, no sustituyen la revisión del abogado.
- [ ] Revisar con un abogado el modelo de formulario de desistimiento frente al anexo I.B del TRLGDCU.
- [ ] `NODE_ENV=production`, `ADMIN_TOKEN` y `APP_SECRET` largos y aleatorios, y `BASE_URL` con https.
- [ ] Alojamiento en la UE, copias de seguridad diarias de `DB_PATH` y contratos de encargado del tratamiento.
- [ ] Plantillas de WhatsApp aprobadas, webhooks verificados y un ciclo completo en modo test de Stripe.
- [ ] Decidir la firma: la actual es una firma electrónica simple reforzada con código de un solo uso y evidencias. Si se quiere más fuerza probatoria, integrar un prestador cualificado.

## Estructura

```
src/
  modules/captacion/      formulario web, webhooks y API de Conversiones de Meta
  modules/cualificacion/  semáforo TRLC, agenda, reservas y secuencias automáticas
  modules/contratacion/   hoja de encargo, firma, pagos, cuotas y desistimiento
  messaging/              WhatsApp Cloud API y correo (modo consola sin credenciales)
  jobs/worker.js          tareas programadas con reintentos
  metricas.js             embudo, tasas, velocidad de respuesta y coste por cliente
web/                      páginas públicas y panel
config/                   reglas de negocio editables
test/                     pruebas (node:test)
```

## Siguientes módulos

4. Recogida de documentos (portal con lista de documentos y recordatorios).
5. Preparación del expediente (memoria, inventario y relación de acreedores del art. 7 TRLC a partir de los documentos).
6. Seguimiento procesal y plazos (arts. 37 ter y 501 TRLC).
7. Cierre, reseñas y recomendaciones.
