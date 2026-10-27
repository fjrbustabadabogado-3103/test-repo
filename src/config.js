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
  const config = {
    produccion,
    port: Number(env.PORT ?? 3000),
    baseUrl: (env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    dbPath: env.DB_PATH ?? join(ROOT, 'data', 'crm.sqlite'),
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
  return problemas;
}
