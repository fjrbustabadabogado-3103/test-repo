import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function leerJson(nombre) {
  return JSON.parse(readFileSync(join(ROOT, 'config', `${nombre}.json`), 'utf8'));
}

function lista(valor) {
  return (valor ?? '').split(',').map((v) => v.trim()).filter(Boolean);
}

/**
 * Carga la configuración desde variables de entorno y los ficheros de config/.
 * `overrides` permite a los tests sustituir cualquier sección.
 */
export function loadConfig(env = process.env, overrides = {}) {
  const produccion = env.NODE_ENV === 'production';
  const port = Number(env.PORT ?? 3000);
  // En GitHub Codespaces, los enlaces deben usar la dirección pública del puerto reenviado.
  const urlPorDefecto = env.CODESPACE_NAME
    ? `https://${env.CODESPACE_NAME}-${port}.${env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN ?? 'app.github.dev'}`
    : `http://localhost:${port}`;
  const config = {
    produccion,
    port,
    baseUrl: (env.BASE_URL ?? urlPorDefecto).replace(/\/$/, ''),
    dbPath: env.DB_PATH ?? join(ROOT, 'data', 'crm.sqlite'),
    // Proxies cuya cabecera X-Forwarded-For se acepta (IP real del cliente en las evidencias de firma). Por defecto, solo redes privadas,
    // como la del proxy HTTPS de deploy/; así nadie puede falsear su IP desde internet.
    trustProxy: env.TRUST_PROXY ?? 'loopback,linklocal,uniquelocal',
    adminToken: env.ADMIN_TOKEN || (produccion ? '' : 'dev-admin'),
    appSecret: env.APP_SECRET || (produccion ? '' : 'dev-secret'),
    intervaloWorkerMs: Number(env.WORKER_INTERVAL_MS ?? 15000),
    meta: {
      graphVersion: env.META_GRAPH_VERSION ?? 'v21.0',
      verifyToken: env.META_VERIFY_TOKEN ?? '',
      appSecret: env.META_APP_SECRET ?? '',
      accessToken: env.META_ACCESS_TOKEN ?? '',
      datasetId: env.META_DATASET_ID ?? '',
      testEventCode: env.META_TEST_EVENT_CODE ?? '',
    },
    whatsapp: {
      token: env.WHATSAPP_TOKEN ?? '',
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? '',
      idioma: env.WHATSAPP_IDIOMA ?? 'es',
    },
    email: {
      resendApiKey: env.RESEND_API_KEY ?? '',
      from: env.EMAIL_FROM ?? 'Bustabad Abogados <hola@example.com>',
    },
    equipo: {
      whatsapp: lista(env.EQUIPO_WHATSAPP),
      email: lista(env.EQUIPO_EMAIL),
    },
    pagos: {
      proveedor: env.PAGOS_PROVEEDOR ?? 'simulado',
      stripeSecretKey: env.STRIPE_SECRET_KEY ?? '',
      stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET ?? '',
    },
    despacho: leerJson('despacho'),
    cualificacion: leerJson('cualificacion'),
    agenda: leerJson('agenda'),
    mensajes: leerJson('mensajes'),
    captacion: leerJson('captacion'),
    documentos: leerJson('documentos'),
    calendario: leerJson('calendario'),
    procesal: leerJson('procesal'),
    cierre: leerJson('cierre'),
    ia: {
      // Extracción de datos de documentos con la API de Claude. Requiere credenciales de Anthropic y contrato de encargo (art. 28 RGPD).
      activada: env.IA_EXTRACCION === 'activada',
    },
    preparacion: {
      costePrevistoProcedimientoEuros: env.COSTE_PREVISTO_PROCEDIMIENTO ? Number(env.COSTE_PREVISTO_PROCEDIMIENTO) : null,
    },
    archivos: {
      directorio: env.ARCHIVOS_DIR ?? join(ROOT, 'data', 'archivos'),
      // Clave AES-256 en base64 (32 bytes) para cifrar los documentos de los clientes y las copias de seguridad.
      clave: env.ARCHIVOS_CLAVE ?? '',
    },
    copias: {
      // Copia diaria cifrada de la base de datos. Siempre activa en producción.
      activadas: produccion || env.COPIAS === 'activadas',
      directorio: env.COPIAS_DIR ?? join(dirname(env.DB_PATH ?? join(ROOT, 'data', 'crm.sqlite')), 'copias'),
      hora: env.COPIAS_HORA ?? '03:00',
      retencionDias: Number(env.COPIAS_RETENCION_DIAS ?? 30),
    },
    ...overrides,
  };
  return config;
}

/** Devuelve la lista de problemas que impiden arrancar en producción. */
export function problemasProduccion(config) {
  const problemas = [];
  if (!config.adminToken || config.adminToken.length < 24) problemas.push('ADMIN_TOKEN ausente o demasiado corto (mínimo 24 caracteres).');
  if (!config.appSecret || config.appSecret.length < 24) problemas.push('APP_SECRET ausente o demasiado corto (mínimo 24 caracteres).');
  if (!config.baseUrl.startsWith('https://')) problemas.push('BASE_URL debe usar https:// en producción.');
  if (JSON.stringify(config.despacho).includes('COMPLETAR')) problemas.push('config/despacho.json contiene valores COMPLETAR (datos del art. 48.1 EGAE).');
  if (config.pagos.proveedor === 'simulado') problemas.push('PAGOS_PROVEEDOR=simulado no se permite en producción.');
  if (config.meta.verifyToken && !config.meta.appSecret) problemas.push('META_APP_SECRET es obligatorio si se activa el webhook de Meta.');
  if (config.pagos.proveedor === 'stripe' && !config.pagos.stripeWebhookSecret) problemas.push('STRIPE_WEBHOOK_SECRET es obligatorio con Stripe.');
  if (Buffer.from(config.archivos.clave, 'base64').length !== 32) problemas.push('ARCHIVOS_CLAVE debe ser una clave de 32 bytes en base64 (openssl rand -base64 32).');
  if (!config.whatsapp.token && !config.email.resendApiKey) problemas.push('No hay ningún canal de mensajería: configure WHATSAPP_TOKEN o RESEND_API_KEY (sin ellos los mensajes a los clientes no salen).');
  if (config.equipo.whatsapp.length + config.equipo.email.length === 0) problemas.push('Indique EQUIPO_WHATSAPP o EQUIPO_EMAIL para recibir los avisos (leads nuevos, plazos, impagos).');
  return problemas;
}

/** Ajustes recomendados que no impiden arrancar, pero conviene revisar antes de abrir al público. */
export function avisosProduccion(config) {
  const avisos = [];
  if (!config.whatsapp.token && config.email.resendApiKey) avisos.push('Sin WhatsApp (WHATSAPP_TOKEN): los mensajes saldrán solo por correo.');
  if (config.whatsapp.token && !config.email.resendApiKey) avisos.push('Sin correo (RESEND_API_KEY): los mensajes saldrán solo por WhatsApp.');
  if (config.email.resendApiKey && /example\.com/.test(config.email.from)) avisos.push('EMAIL_FROM sigue con la dirección de ejemplo.');
  if (!config.meta.verifyToken) avisos.push('Webhook de Meta sin configurar (META_VERIFY_TOKEN): los leads de formularios instantáneos no entrarán solos.');
  if (config.meta.verifyToken && !config.meta.datasetId) avisos.push('Sin META_DATASET_ID: no se envían conversiones a Meta para optimizar campañas.');
  const sinFestivos = Object.entries(config.calendario.autonomicos ?? {}).filter(([, anios]) => Object.values(anios).some((v) => v === null)).map(([ccaa]) => ccaa);
  if (sinFestivos.length) avisos.push(`Festivos autonómicos sin cargar en config/calendario.json (${sinFestivos.length} comunidades): los plazos se marcarán «verificar».`);
  if (!config.cierre.resenas?.urlGoogle) avisos.push('Sin enlace de reseñas de Google en config/cierre.json.');
  if (!config.copias.activadas) avisos.push('Copias de seguridad desactivadas.');
  return avisos;
}
