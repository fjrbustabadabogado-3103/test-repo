# Bustabad Abogados · Captación y contratación automatizadas (Ley de Segunda Oportunidad)

Aplicación que automatiza los cinco primeros módulos del negocio:

1. **Captación**: formulario web y formularios instantáneos de Meta (Facebook/Instagram), con atribución por campaña y envío de las etapas del CRM a la API de Conversiones de Meta.
2. **Cualificación y agenda**: semáforo automático basado en el TRLC, respuesta por WhatsApp en segundos, reserva de la consulta online, recordatorios, seguimientos y gestión de ausencias.
3. **Contratación y cobro**: hoja de encargo generada desde el panel, firma electrónica con código de un solo uso, pago de la entrada (tarjeta o SEPA) y cobro automático de las cuotas.
4. **Recogida de documentos**: portal del cliente con la lista de documentos adaptada a su caso, subida desde el móvil con almacenamiento cifrado, revisión por el abogado y recordatorios hasta completar el expediente.
5. **Preparación del expediente**: relación de acreedores e inventario (con extracción opcional por IA que el abogado revisa), indicadores para decidir la vía, comprobaciones antes de presentar y borradores en Word de la memoria, el inventario, la relación de acreedores y la solicitud de concurso.

Sin credenciales funciona **entero en local**: los WhatsApp y correos se guardan en la bandeja de salida (tabla `salida`) y los pagos son simulados.

## Verla en el navegador sin instalar nada (GitHub Codespaces)

1. En GitHub, abre el repositorio y elige la rama `feature/documentos-lso`.
2. Pulsa **Code → Codespaces → Create codespace on feature/documentos-lso**.
3. Espera 1 o 2 minutos: se instala y arranca sola, y se abre una pestaña con la aplicación. Si no se abre, ve a la pestaña **Ports** y pulsa el globo del puerto 3000.
4. Panel del despacho: añade `/admin` a la dirección y entra con el token `dev-admin`.

Los mensajes de WhatsApp y correo no se envían de verdad: se ven en el panel, en la ficha de cada lead («Mensajes enviados»). Los pagos son simulados. Cuando termines, para el codespace desde github.com/codespaces para no consumir horas.

## Puesta en marcha

Requisitos: Node.js 22.13 o superior (usa el SQLite integrado de Node; no hay dependencias nativas).

```bash
npm install
cp .env.example .env      # rellenar según la sección "Integraciones"
npm start                 # http://localhost:3000
npm test                  # 42 pruebas: reglas, agenda, pagos, firmas, documentos, preparación y flujo completo
```

Las variables de entorno se leen del entorno del proceso. Para usar el fichero `.env` en local: `node --env-file=.env src/index.js`.

| Página | Para quién |
|---|---|
| `/` | Página de captación con el cuestionario de viabilidad |
| `/reservar/:token` | Reserva de la consulta (enlace personal que recibe cada lead) |
| `/encargo/:token` | Hoja de encargo: firma, pago, cuotas y desistimiento |
| `/expediente/:token` | Portal del cliente para sus datos y documentos |
| `/admin` | Panel del despacho: métricas, leads, ficha y envío de propuestas (en desarrollo el token es `dev-admin`) |
| `/admin/expediente/:id` | Preparación del expediente: acreedores, bienes, memoria, comprobaciones y borradores en Word |
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
        ▼
Inicio del servicio (inmediato si lo pidió; si no, al terminar los 14 días de desistimiento)
        ▼
Portal de documentos: datos para la memoria + lista adaptada al caso ──► recordatorios cada 3 días
        ▼
Todo aportado ──► "pendiente de revisión" ──► el abogado valida o pide corregir (con motivo, por WhatsApp)
        ▼
Todo validado ──► DOCUMENTACIÓN COMPLETA ──► aviso para preparar la solicitud
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
| `documentos.json` | Documentos que se piden, cuándo (según el cuestionario o los datos del portal), cómo conseguir cada uno, límites de tamaño y frecuencia de recordatorios. |

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

## Módulo 4 · Recogida de documentos

- **Cuándo se abre:** al empezar el servicio. Si el cliente pidió inicio inmediato, al cobrar la entrada; si no, al terminar el plazo de desistimiento. También se puede abrir a mano desde la ficha del lead.
- **Lista adaptada al caso**, según el cuestionario y los datos que el cliente rellena en el portal: hipoteca, inmuebles, vehículos, demandas, matrimonio, divorcio, actividad como autónomo o antecedentes.
- **Datos para la memoria del art. 7.1º TRLC:** domicilio, estado civil, cónyuge o pareja, fecha y régimen económico, situación laboral y causas de la insolvencia.
- **Seguridad de los archivos:**
  - se comprueba el formato real del archivo (PDF, JPG, PNG, HEIC o WEBP), no lo que diga el navegador;
  - límites de tamaño por archivo y por expediente;
  - cifrado AES-256-GCM en disco con `ARCHIVOS_CLAVE`, y cada descarga desde el panel queda registrada en el historial.
- **Revisión:** el abogado valida cada documento o pide corregirlo con un motivo, que el cliente recibe por WhatsApp y ve en el portal. El poder del procurador puede validarse sin archivo si se otorgó apud acta.
- **Fin:** cuando todo está validado, el expediente pasa a *documentación completa*, se paran los recordatorios y se avisa al equipo para preparar la solicitud.

## Módulo 5 · Preparación del expediente

Desde la ficha del lead, «Preparar expediente» abre la pantalla de trabajo del abogado:

- **Relación de acreedores (art. 7.3º TRLC):** cada acreedor con identidad, NIF, domicilio, correo electrónico, cuantía, vencimiento, garantías y reclamación judicial. La clase del crédito (privilegio especial del art. 270, privilegio general del art. 280, ordinario o subordinado) la elige el abogado.
- **Inventario (art. 7.2º TRLC):** naturaleza, lugar, datos registrales, valor de adquisición, valor de mercado y cargas. Si un bien es embargable lo decide el abogado.
- **Extracción con IA (opcional):** con `IA_EXTRACCION=activada`, el botón «Extraer datos» envía el documento (PDF, JPG, PNG o WEBP) a Claude Opus 5.5.
  - Devuelve acreedores y bienes en un formato validado, cada uno con la cita literal del documento.
  - Las propuestas entran siempre como **«sin revisar»** y no se puede presentar hasta que el abogado las confirma.
  - Si el modelo rechaza un documento, la API lo reintenta automáticamente con otro modelo (parámetro `fallbacks: "default"`).
  - Los fallos de red se reintentan unas cuantas veces y, si persisten, quedan registrados para introducir los datos a mano.
- **Indicadores para decidir la vía:**
  - pasivo, crédito público no exonerable (art. 489.1.5º, límite aplicado por separado a Hacienda y a la Seguridad Social), alimentos, deuda con garantía real, activo y bienes libres y embargables;
  - indicios de concurso sin masa según las letras a), c) y d) del art. 37 bis. Estos indicadores no deciden nada: los valora el abogado.
- **Comprobaciones antes de presentar:** cada carencia se muestra con la norma que la exige (arts. 6.2, 7, 37 bis, 44, 45, 486, 501 y 510 TRLC; art. 87 LOPJ). Solo con todo completo se puede marcar «listo para presentar», y a partir de ahí el expediente queda bloqueado hasta que se reabra.
- **Borradores en Word:** memoria, inventario, relación de acreedores y solicitud de concurso dirigida a la Sección de lo Mercantil del Tribunal de Instancia de la capital de provincia (art. 87.1 y 87.7 LOPJ, redacción de la LO 1/2025). Son borradores para revisar.
  - No he encontrado en el BOE el modelo oficial de solicitud que menciona el art. 6.2 TRLC; el borrador avisa de que hay que comprobar si debe usarse.

**Protección de datos:** la extracción con IA envía documentos del cliente a Anthropic. Antes de activarla, firma el contrato de encargado del tratamiento (art. 28 RGPD) y revisa sus condiciones de conservación de datos.

**Importante:** guarda `ARCHIVOS_CLAVE` en un lugar seguro y haz copia de seguridad de `ARCHIVOS_DIR` junto con la base de datos. Sin la clave, los documentos no se pueden recuperar.

## Base legal aplicada (comprobada en el BOE consolidado)

| Norma | Dónde se aplica |
|---|---|
| TRLC arts. 486, 487, 488 y 489 | Semáforo: solo persona natural, excepciones de buena fe, plazos de nueva exoneración, deudas no exonerables y límite de 10.000 € de crédito público (íntegros los primeros 5.000 € y el 50 % del resto) |
| TRLC art. 510 | La hoja de encargo informa de que el procurador es obligatorio y presupuesta su provisión de fondos |
| TRLC art. 6.2 | Se pide el poder especial del procurador (notarial o apud acta, también por comparecencia electrónica) |
| TRLC art. 7 | Datos de la memoria (incluidos cónyuge y régimen económico), documentos para el inventario (cuentas, inmuebles, vehículos) y para la relación de acreedores (contratos, reclamaciones, CIRBE, procedimientos judiciales) |
| TRLC art. 8 | A los autónomos se les pide la contabilidad si están obligados a llevarla |
| TRLC art. 45 | Certificado de empadronamiento para acreditar el domicilio que fija el juzgado competente |
| TRLC art. 501.3 | Declaraciones de la renta de los tres últimos años |
| TRLC arts. 1, 2, 3, 44, 270 y 280 | Borrador de solicitud (presupuestos, insolvencia actual, legitimación, competencia) y clases de crédito que elige el abogado |
| LOPJ art. 87 (LO 1/2025) | La solicitud se dirige a la Sección de lo Mercantil del Tribunal de Instancia de la capital de provincia, con las excepciones de los apartados 2, 3 y 4 |
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
- [ ] Generar `ARCHIVOS_CLAVE` (`openssl rand -base64 32`), guardarla a salvo y revisar los textos de `config/documentos.json` (sobre todo «cómo conseguirlo»).
- [ ] Decidir la firma: la actual es una firma electrónica simple reforzada con código de un solo uso y evidencias. Si se quiere más fuerza probatoria, integrar un prestador cualificado.

## Estructura

```
src/
  modules/captacion/      formulario web, webhooks y API de Conversiones de Meta
  modules/cualificacion/  semáforo TRLC, agenda, reservas y secuencias automáticas
  modules/contratacion/   hoja de encargo, firma, pagos, cuotas y desistimiento
  modules/documentos/     expediente, lista de documentos, almacén cifrado y revisión
  modules/preparacion/    acreedores, bienes, indicadores, extracción con IA y borradores en Word
  messaging/              WhatsApp Cloud API y correo (modo consola sin credenciales)
  jobs/worker.js          tareas programadas con reintentos
  metricas.js             embudo, tasas, velocidad de respuesta y coste por cliente
web/                      páginas públicas y panel
config/                   reglas de negocio editables
test/                     pruebas (node:test)
```

## Siguientes módulos

6. Seguimiento procesal y plazos (arts. 37 ter y 501 TRLC).
7. Cierre, reseñas y recomendaciones.
