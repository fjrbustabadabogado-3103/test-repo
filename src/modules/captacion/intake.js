import { evaluar } from '../cualificacion/scoring.js';
import { alCrearLead } from '../cualificacion/secuencias.js';
import { mapearCamposMeta } from './meta.js';
import {
  normalizarTelefono, normalizarEmail, interpretarImporte, interpretarSiNo, interpretarTipoDeudor, textoCorto, sumarDias,
} from '../../util.js';

const ATRIBUCION = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'fbc', 'pagina', 'ref'];
const DIAS_DEDUPLICACION = 30;

export class ErrorValidacion extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.statusCode = 400;
  }
}

/** Respuestas del cuestionario en su forma interna, venga de la web o de Meta. */
export function normalizarRespuestas(bruto) {
  const entero = (v) => {
    const n = interpretarImporte(v);
    return n == null ? null : Math.round(n);
  };
  return {
    tipo_deudor: interpretarTipoDeudor(bruto.tipo_deudor),
    deuda_total: entero(bruto.deuda_total),
    num_acreedores: entero(bruto.num_acreedores),
    deuda_hacienda: entero(bruto.deuda_hacienda) ?? 0,
    deuda_seguridad_social: entero(bruto.deuda_seguridad_social) ?? 0,
    deuda_alimentos: interpretarSiNo(bruto.deuda_alimentos),
    vivienda_hipotecada: interpretarSiNo(bruto.vivienda_hipotecada),
    antecedentes: interpretarSiNo(bruto.antecedentes),
    exoneracion_previa: interpretarSiNo(bruto.exoneracion_previa),
    ingresos_mensuales: entero(bruto.ingresos_mensuales),
  };
}

/**
 * Registra un lead (deduplicando), lo puntúa y arranca su secuencia.
 * @returns {{lead: object, duplicado: boolean}}
 */
export function registrarLead(ctx, entrada) {
  const telefono = normalizarTelefono(entrada.telefono);
  const email = normalizarEmail(entrada.email);
  if (!telefono && !email) throw new ErrorValidacion('Indique un teléfono o un correo electrónico válidos.');
  if (!entrada.consentimientoRgpd) throw new ErrorValidacion('Debe aceptar la política de privacidad para que podamos atender su consulta.');

  const desde = sumarDias(ctx.reloj(), -DIAS_DEDUPLICACION).toISOString();
  const existente = ctx.store.leadDuplicado({ telefono, email }, desde);
  if (existente) {
    ctx.store.registrarEvento(existente.id, 'lead_repetido', { origen: entrada.origen });
    return { lead: existente, duplicado: true };
  }

  const respuestas = normalizarRespuestas(entrada.respuestas ?? {});
  const resultado = evaluar(respuestas, ctx.config.cualificacion);
  const atribucion = {};
  for (const clave of ATRIBUCION) {
    const valor = textoCorto(entrada.atribucion?.[clave], 300);
    if (valor) atribucion[clave] = valor;
  }
  for (const clave of ['meta_lead_id', 'meta_form_id', 'meta_ad_id', 'meta_ad_name', 'meta_campaign_id', 'meta_campaign_name', 'meta_adset_name', 'plataforma']) {
    const valor = textoCorto(entrada.atribucion?.[clave], 300);
    if (valor) atribucion[clave] = valor;
  }
  if (atribucion.fbclid && !atribucion.fbc) atribucion.fbc = `fb.1.${ctx.reloj().getTime()}.${atribucion.fbclid}`;

  const lead = ctx.store.crearLead({
    origen: entrada.origen,
    semaforo: resultado.semaforo,
    puntuacion: resultado.puntuacion,
    motivos: { lista: resultado.motivos, estimacion: resultado.estimacion },
    nombre: textoCorto(entrada.nombre, 120),
    telefono,
    email,
    provincia: textoCorto(entrada.provincia, 60),
    respuestas,
    atribucion,
    consentimiento_rgpd: true,
    consentimiento_comunicaciones: Boolean(entrada.consentimientoComunicaciones),
  });
  ctx.store.registrarEvento(lead.id, 'lead_creado', {
    origen: lead.origen, semaforo: lead.semaforo, puntuacion: lead.puntuacion,
    consentimientoComunicaciones: lead.consentimiento_comunicaciones,
  });
  return { lead: alCrearLead(ctx, lead), duplicado: false };
}

/** Entrada desde el formulario de la web (POST /api/leads). */
export function leadDesdeWeb(cuerpo) {
  return {
    origen: 'web',
    nombre: cuerpo.nombre,
    telefono: cuerpo.telefono,
    email: cuerpo.email,
    provincia: cuerpo.provincia,
    respuestas: cuerpo,
    consentimientoRgpd: cuerpo.acepta_privacidad === true || cuerpo.acepta_privacidad === 'on',
    consentimientoComunicaciones: cuerpo.acepta_comunicaciones === true || cuerpo.acepta_comunicaciones === 'on',
    atribucion: cuerpo.atribucion ?? {},
  };
}

/**
 * Entrada desde un formulario instantáneo de Meta. La política de privacidad se enlaza obligatoriamente
 * en el propio formulario de Meta; el consentimiento para comunicaciones comerciales debe recogerse con
 * una casilla personalizada (campo `acepta_comunicaciones`).
 */
export function leadDesdeMeta(leadMeta, camposMeta) {
  const campos = mapearCamposMeta(leadMeta, camposMeta);
  return {
    origen: leadMeta.platform === 'ig' ? 'instagram' : 'meta',
    nombre: campos.nombre,
    telefono: campos.telefono,
    email: campos.email,
    provincia: campos.provincia,
    respuestas: campos,
    consentimientoRgpd: true,
    consentimientoComunicaciones: interpretarSiNo(campos.consentimiento_comunicaciones) === true,
    atribucion: {
      meta_lead_id: leadMeta.id,
      meta_form_id: leadMeta.form_id,
      meta_ad_id: leadMeta.ad_id,
      meta_ad_name: leadMeta.ad_name,
      meta_campaign_id: leadMeta.campaign_id,
      meta_campaign_name: leadMeta.campaign_name,
      meta_adset_name: leadMeta.adset_name,
      plataforma: leadMeta.platform,
      utm_source: leadMeta.platform === 'ig' ? 'instagram' : 'facebook',
      utm_campaign: leadMeta.campaign_name,
    },
  };
}
