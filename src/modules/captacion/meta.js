import { hmacHex, igualSeguro, sha256 } from '../../util.js';

/** Comprueba la cabecera X-Hub-Signature-256 que Meta añade a cada webhook. */
export function firmaMetaValida(cuerpoCrudo, cabecera, appSecret) {
  if (!appSecret || !cabecera || !cuerpoCrudo) return false;
  const esperada = `sha256=${hmacHex(appSecret, cuerpoCrudo)}`;
  return igualSeguro(esperada, cabecera);
}

/** Extrae los avisos de nuevos leads (campo "leadgen") de un webhook de página. */
export function extraerLeadgen(cuerpo) {
  if (cuerpo?.object !== 'page') return [];
  const avisos = [];
  for (const entrada of cuerpo.entry ?? []) {
    for (const cambio of entrada.changes ?? []) {
      if (cambio.field === 'leadgen' && cambio.value?.leadgen_id) avisos.push(cambio.value);
    }
  }
  return avisos;
}

/** Extrae los mensajes entrantes de un webhook de WhatsApp Business. */
export function extraerMensajesWhatsapp(cuerpo) {
  if (cuerpo?.object !== 'whatsapp_business_account') return [];
  const mensajes = [];
  for (const entrada of cuerpo.entry ?? []) {
    for (const cambio of entrada.changes ?? []) {
      for (const mensaje of cambio.value?.messages ?? []) {
        mensajes.push({ de: mensaje.from, texto: mensaje.text?.body ?? mensaje.button?.text ?? '', tipo: mensaje.type, id: mensaje.id });
      }
    }
  }
  return mensajes;
}

/** Descarga los datos de un lead de formulario instantáneo (requiere permiso leads_retrieval). */
export async function descargarLeadMeta(config, leadgenId, fetchImpl = fetch) {
  if (!config.meta.accessToken) throw new Error('META_ACCESS_TOKEN no configurado: no se puede descargar el lead.');
  const campos = 'created_time,field_data,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,platform';
  const url = `https://graph.facebook.com/${config.meta.graphVersion}/${encodeURIComponent(leadgenId)}?fields=${campos}`;
  const respuesta = await fetchImpl(url, { headers: { Authorization: `Bearer ${config.meta.accessToken}` } });
  const datos = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) throw new Error(`Graph API ${respuesta.status}: ${JSON.stringify(datos.error ?? datos)}`);
  return datos;
}

/** Convierte field_data de Meta a los campos internos según config/captacion.json. */
export function mapearCamposMeta(leadMeta, camposMeta) {
  const resultado = {};
  for (const campo of leadMeta.field_data ?? []) {
    const destino = camposMeta[campo.name];
    if (destino) resultado[destino] = campo.values?.[0] ?? null;
  }
  return resultado;
}

const hash = (valor) => (valor ? [sha256(String(valor).trim().toLowerCase())] : undefined);

/**
 * Envía un evento de etapa del CRM a la API de Conversiones de Meta para que la campaña optimice
 * hacia leads que se convierten en clientes, no hacia formularios rellenados.
 */
export async function enviarEventoConversion(config, { lead, evento, valorCent = null }, fetchImpl = fetch) {
  if (!config.meta.datasetId || !config.meta.accessToken) return { estado: 'omitido_sin_configuracion' };
  const userData = {
    em: hash(lead.email),
    ph: hash(lead.telefono),
    ...(lead.atribucion?.meta_lead_id ? { lead_id: Number(lead.atribucion.meta_lead_id) || lead.atribucion.meta_lead_id } : {}),
    ...(lead.atribucion?.fbc ? { fbc: lead.atribucion.fbc } : {}),
  };
  const datos = {
    event_name: evento,
    event_time: Math.floor(Date.now() / 1000),
    event_id: `${lead.id}:${evento}`,
    action_source: 'system_generated',
    user_data: userData,
    custom_data: {
      event_source: 'crm',
      lead_event_source: 'Bustabad CRM',
      ...(valorCent != null ? { value: valorCent / 100, currency: 'EUR' } : {}),
    },
  };
  const cuerpo = { data: [datos], ...(config.meta.testEventCode ? { test_event_code: config.meta.testEventCode } : {}) };
  const url = `https://graph.facebook.com/${config.meta.graphVersion}/${config.meta.datasetId}/events`;
  const respuesta = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.meta.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  const resultado = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) throw new Error(`API de Conversiones ${respuesta.status}: ${JSON.stringify(resultado.error ?? resultado)}`);
  return { estado: 'enviado', ...resultado };
}
