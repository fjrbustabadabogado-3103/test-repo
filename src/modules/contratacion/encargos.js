import { randomInt } from 'node:crypto';
import { calcularPlanPagos, renderizarHojaEncargo, huellaDocumento } from './hoja-encargo.js';
import { alEnviarPropuesta } from '../cualificacion/secuencias.js';
import { localAUtc } from '../cualificacion/agenda.js';
import { ErrorValidacion } from '../captacion/intake.js';
import { cambiarEtapa } from '../../etapas.js';
import { nuevoId } from '../../store.js';
import {
  aCentimos, euros, hmacHex, igualSeguro, sumarDias, sumarMinutos, textoCorto, validarDniNie, escaparHtml, fechaLarga,
} from '../../util.js';

const MINUTOS_OTP = 10;
const MAX_INTENTOS_OTP = 5;
const MAX_ENVIOS_OTP = 5;
const DIAS_DESISTIMIENTO = 14; // art. 104 TRLGDCU: 14 días naturales desde la celebración del contrato de servicios.
const ETAPAS_PROPUESTA = ['nuevo', 'contactado', 'cualificado', 'agendado', 'asistio', 'propuesta'];

const noEncontrado = () => Object.assign(new Error('Hoja de encargo no encontrada.'), { statusCode: 404 });

export function crearPropuesta(ctx, leadId, datos) {
  const lead = ctx.store.lead(leadId);
  if (!lead || lead.anonimizado) throw noEncontrado();
  if (!ETAPAS_PROPUESTA.includes(lead.etapa)) throw new ErrorValidacion(`No se puede enviar una propuesta a un lead en etapa "${lead.etapa}".`);
  if (!lead.nombre) throw new ErrorValidacion('El lead no tiene nombre: complételo antes de generar la hoja de encargo.');

  const honorariosCent = aCentimos(datos.honorarios);
  const entradaCent = aCentimos(datos.entrada);
  const provisionCent = aCentimos(datos.provisionProcurador ?? 0);
  const numCuotas = Number(datos.numCuotas);
  if (honorariosCent == null || entradaCent == null || provisionCent == null) throw new ErrorValidacion('Importes no válidos.');

  const ahora = ctx.reloj();
  const h = ctx.config.despacho.honorarios;
  let plan;
  try {
    plan = calcularPlanPagos({ honorariosCent, entradaCent, numCuotas, desde: ahora, diaCobro: h.diaCobroCuotas });
  } catch (error) {
    throw new ErrorValidacion(error.message);
  }

  for (const anterior of ctx.store.encargosDeLead(lead.id)) {
    if (anterior.estado === 'enviado') ctx.store.actualizarEncargo(anterior.id, { estado: 'anulado' });
  }

  const borrador = { id: nuevoId(), honorarios_cent: honorariosCent, provision_procurador_cent: provisionCent };
  const consulta = ctx.store.citasDeLead(lead.id).filter((c) => c.estado === 'realizada').at(-1);
  const html = renderizarHojaEncargo({
    despacho: ctx.config.despacho, lead, encargo: borrador, plan, fechaConsulta: consulta?.inicio, fechaEmision: ahora.toISOString(),
  });
  const encargo = ctx.store.crearEncargo({
    id: borrador.id,
    lead_id: lead.id,
    honorarios_cent: honorariosCent,
    entrada_cent: entradaCent,
    num_cuotas: numCuotas,
    provision_procurador_cent: provisionCent,
    documento_html: html,
    documento_sha256: huellaDocumento(html),
    plan,
    caduca: sumarDias(ahora, h.validezPropuestaDias ?? 10).toISOString(),
  });
  ctx.store.registrarEvento(lead.id, 'propuesta_creada', { encargoId: encargo.id, honorarios: honorariosCent, cuotas: numCuotas });
  alEnviarPropuesta(ctx, lead, encargo);
  return encargo;
}

export function encargoParaFirmar(ctx, token) {
  const encargo = ctx.store.encargoPorToken(token);
  if (!encargo) throw noEncontrado();
  if (encargo.estado === 'enviado' && new Date(encargo.caduca) < ctx.reloj()) {
    return ctx.store.actualizarEncargo(encargo.id, { estado: 'caducado' });
  }
  return encargo;
}

const hashOtp = (ctx, encargoId, codigo) => hmacHex(ctx.config.appSecret, `${encargoId}:${codigo}`);

/** Envía al cliente un código de un solo uso para identificarle en la firma (art. 98.9 TRLGDCU). */
export async function solicitarCodigo(ctx, token) {
  const encargo = encargoParaFirmar(ctx, token);
  if (encargo.estado !== 'enviado') throw new ErrorValidacion('Esta hoja de encargo ya no admite firma.');
  if (encargo.otp_envios >= MAX_ENVIOS_OTP) throw Object.assign(new Error('Ha solicitado demasiados códigos. Contacte con el despacho.'), { statusCode: 429 });
  const codigo = String(randomInt(0, 1_000_000)).padStart(6, '0');
  ctx.store.actualizarEncargo(encargo.id, {
    otp_hash: hashOtp(ctx, encargo.id, codigo),
    otp_caduca: sumarMinutos(ctx.reloj(), MINUTOS_OTP).toISOString(),
    otp_intentos: 0,
    otp_envios: encargo.otp_envios + 1,
  });
  const lead = ctx.store.lead(encargo.lead_id);
  const resultado = await ctx.mensajeria.enviar(lead, 'codigo_firma', { codigo });
  ctx.store.registrarEvento(lead.id, 'codigo_firma_enviado', { encargoId: encargo.id, canal: resultado.canal });
  if (!resultado.canal) throw new ErrorValidacion('No tenemos un teléfono o correo al que enviar el código. Contacte con el despacho.');
  return { canal: resultado.canal };
}

/**
 * Firma electrónica de la hoja de encargo con código de un solo uso y contratación con obligación de pago.
 * Requisitos: confirmación expresa de la obligación de pago (art. 98.2 TRLGDCU), solicitud expresa si se quiere
 * empezar durante el plazo de desistimiento (art. 98.8) y prueba de la identidad y del documento firmado (art. 98.9).
 */
export async function firmarEncargo(ctx, token, datos) {
  const encargo = encargoParaFirmar(ctx, token);
  if (encargo.estado !== 'enviado') throw new ErrorValidacion('Esta hoja de encargo ya no admite firma.');
  if (datos.aceptaHoja !== true) throw new ErrorValidacion('Debe confirmar que ha leído y acepta la hoja de encargo.');
  if (datos.aceptaPago !== true) throw new ErrorValidacion('Debe confirmar que la contratación implica una obligación de pago.');
  const nombre = textoCorto(datos.nombre, 120);
  if (!nombre || nombre.length < 5) throw new ErrorValidacion('Escriba su nombre y apellidos completos.');
  const dni = validarDniNie(datos.dni);
  if (!dni) throw new ErrorValidacion('El DNI o NIE no es válido.');
  if (datos.documentoSha256 !== encargo.documento_sha256) throw new ErrorValidacion('La hoja de encargo ha cambiado. Recargue la página antes de firmar.');

  if (!encargo.otp_hash || new Date(encargo.otp_caduca) < ctx.reloj()) throw new ErrorValidacion('El código ha caducado. Solicite uno nuevo.');
  if (encargo.otp_intentos >= MAX_INTENTOS_OTP) throw Object.assign(new Error('Demasiados intentos. Solicite un código nuevo.'), { statusCode: 429 });
  if (!igualSeguro(hashOtp(ctx, encargo.id, String(datos.codigo ?? '').trim()), encargo.otp_hash)) {
    ctx.store.actualizarEncargo(encargo.id, { otp_intentos: encargo.otp_intentos + 1 });
    throw new ErrorValidacion('El código no es correcto.');
  }

  const ahora = ctx.reloj();
  const inicioInmediato = datos.inicioInmediato === true;
  const lead = ctx.store.lead(encargo.lead_id);
  const evidencia = {
    fecha: ahora.toISOString(),
    nombre,
    dni,
    documentoSha256: encargo.documento_sha256,
    codigoVerificadoPor: ctx.store.salida(lead.id).filter((s) => s.plantilla === 'codigo_firma').at(-1)?.canal ?? null,
    aceptaHoja: true,
    aceptaObligacionPago: true,
    solicitaInicioInmediato: inicioInmediato,
    ip: datos.ip ?? null,
    userAgent: textoCorto(datos.userAgent, 400),
  };
  const firmado = ctx.store.actualizarEncargo(encargo.id, {
    estado: 'firmado',
    firmado: ahora.toISOString(),
    evidencia_firma: evidencia,
    inicio_inmediato: inicioInmediato ? 1 : 0,
    fecha_inicio_servicio: (inicioInmediato ? ahora : sumarDias(ahora, DIAS_DESISTIMIENTO)).toISOString(),
    otp_hash: null,
  });
  for (const linea of encargo.plan) {
    ctx.store.crearPago({ encargo_id: encargo.id, tipo: linea.tipo, numero: linea.numero, importe_cent: linea.importe_cent, vencimiento: linea.vencimiento });
  }
  ctx.store.cancelarTareas(lead.id, 'propuesta');
  ctx.store.registrarEvento(lead.id, 'encargo_firmado', { encargoId: encargo.id, inicioInmediato });
  cambiarEtapa(ctx, lead, 'firmado', { encargoId: encargo.id });

  await enviarConfirmacion(ctx, lead, firmado).catch((error) => {
    ctx.log.error?.(`No se pudo enviar la confirmación del encargo ${encargo.id}: ${error.message}`);
    ctx.store.programar('aviso_equipo', ctx.reloj(), { plantilla: 'aviso_equipo_evento', extra: { evento: 'Revisar: no se envió la confirmación de la hoja de encargo' } }, lead.id);
  });
  ctx.store.programar('aviso_equipo', ctx.reloj(), { plantilla: 'aviso_equipo_evento', extra: { evento: 'Hoja de encargo firmada' } }, lead.id);

  const { url } = await enlacePago(ctx, firmado, 'entrada');
  return { urlPago: url, encargo: firmado };
}

/** Confirmación del contrato en soporte duradero (art. 98.7 TRLGDCU): documento íntegro + datos de la firma. */
async function enviarConfirmacion(ctx, lead, encargo) {
  const ev = encargo.evidencia_firma;
  const inicio = encargo.inicio_inmediato
    ? 'Ha solicitado expresamente que empecemos a trabajar ya, dentro del plazo de desistimiento.'
    : `Empezaremos a trabajar cuando termine el plazo de desistimiento, el ${fechaLarga(encargo.fecha_inicio_servicio, ctx.config.agenda.zona)}.`;
  const html = `<p>Hola ${escaparHtml(lead.nombre)}, le confirmamos la contratación. Conserve este correo.</p>
<p><strong>Firma:</strong> ${escaparHtml(ev.nombre)} (${escaparHtml(ev.dni)}), ${escaparHtml(fechaLarga(ev.fecha, ctx.config.agenda.zona))}, verificada con código de un solo uso.<br>
<strong>Huella SHA-256 del documento firmado:</strong> <code>${escaparHtml(ev.documentoSha256)}</code><br>${escaparHtml(inicio)}</p>
<p>Puede consultar su hoja de encargo, sus pagos o ejercer el desistimiento en: <a href="${escaparHtml(`${ctx.config.baseUrl}/encargo/${encargo.token}`)}">su área de encargo</a>.</p>
<hr>${encargo.documento_html}`;
  await ctx.mensajeria.enviarCorreoDocumento(lead, {
    asunto: `${ctx.config.despacho.nombreComercial} · Confirmación de su hoja de encargo`,
    texto: `Confirmación de su hoja de encargo. Firmada por ${ev.nombre} (${ev.dni}) el ${ev.fecha}. Huella: ${ev.documentoSha256}. ${inicio}`,
    html,
  });
}

/** Crea (o recrea) el enlace de pago de la entrada o de una cuota pendiente. */
export async function enlacePago(ctx, encargo, tipo = 'entrada', pagoId = null) {
  const pago = pagoId ? ctx.store.pago(pagoId) : ctx.store.pagoPendienteDeTipo(encargo.id, tipo);
  if (!pago || pago.encargo_id !== encargo.id || pago.estado === 'pagado') throw new ErrorValidacion('No hay ningún pago pendiente.');
  const lead = ctx.store.lead(encargo.lead_id);
  const intentos = pago.intentos + 1;
  const { referencia, url } = await ctx.pagos.crearCobro({ pago: { ...pago, intentos }, encargo, lead });
  ctx.store.actualizarPago(pago.id, { estado: 'enlace_enviado', proveedor: ctx.pagos.nombre, referencia, url_pago: url, intentos });
  return { url, pago: ctx.store.pago(pago.id) };
}

/** Pago cobrado (webhook de Stripe o pago simulado). Idempotente. */
export async function registrarPagoCobrado(ctx, pagoId, { referencia = null, paymentIntent = null } = {}) {
  const pago = ctx.store.pago(pagoId);
  if (!pago || pago.estado === 'pagado') return pago;
  ctx.store.actualizarPago(pago.id, { estado: 'pagado', pagado: ctx.store.ahora(), ...(referencia ? { referencia } : {}) });
  const encargo = ctx.store.encargo(pago.encargo_id);
  const lead = ctx.store.lead(encargo.lead_id);
  ctx.store.registrarEvento(lead.id, 'pago_cobrado', { pagoId, tipo: pago.tipo, numero: pago.numero, importe: pago.importe_cent });

  if (pago.tipo === 'entrada' && encargo.estado === 'firmado') {
    const cambios = { estado: 'activo' };
    if (paymentIntent && ctx.pagos.metodoGuardado) {
      const guardado = await ctx.pagos.metodoGuardado(paymentIntent);
      Object.assign(cambios, { pago_cliente_ref: guardado.cliente, pago_metodo_ref: guardado.metodo, pago_metodo_tipo: guardado.tipo });
    }
    ctx.store.actualizarEncargo(encargo.id, cambios);
    for (const cuota of ctx.store.pagosDeEncargo(encargo.id).filter((p) => p.tipo === 'cuota')) {
      ctx.store.programar('cobrar_cuota', localAUtc(cuota.vencimiento, '09:00', ctx.config.agenda.zona), { pagoId: cuota.id, grupo: 'cobros' }, lead.id);
    }
    cambiarEtapa(ctx, lead, 'cliente', { encargoId: encargo.id, valorCent: encargo.honorarios_cent });
    ctx.store.programar('mensaje', ctx.reloj(), { plantilla: 'bienvenida_cliente' }, lead.id);
    ctx.store.programar('aviso_equipo', ctx.reloj(), { plantilla: 'aviso_equipo_evento', extra: { evento: `Entrada cobrada (${euros(pago.importe_cent)}): abrir expediente` } }, lead.id);
  }
  return ctx.store.pago(pagoId);
}

/** Cobro fallido de una cuota: aviso al cliente con enlace de pago y reintento. */
export async function registrarPagoFallido(ctx, pagoId, motivo) {
  const pago = ctx.store.pago(pagoId);
  if (!pago || pago.estado === 'pagado') return pago;
  const actualizado = ctx.store.actualizarPago(pago.id, { estado: 'fallido', intentos: pago.intentos + 1 });
  const encargo = ctx.store.encargo(pago.encargo_id);
  const lead = ctx.store.lead(encargo.lead_id);
  ctx.store.registrarEvento(lead.id, 'pago_fallido', { pagoId, motivo: textoCorto(motivo, 300) });
  if (pago.tipo !== 'cuota') return actualizado;
  await ctx.mensajeria.enviar(lead, 'pago_fallido', {
    concepto: `n.º ${pago.numero}`, importe: euros(pago.importe_cent), enlace_pago: `${ctx.config.baseUrl}/encargo/${encargo.token}`,
  });
  if (actualizado.intentos < 3) {
    ctx.store.programar('cobrar_cuota', sumarDias(ctx.reloj(), 3), { pagoId: pago.id, grupo: 'cobros' }, lead.id);
  } else {
    ctx.store.programar('aviso_equipo', ctx.reloj(), { plantilla: 'aviso_equipo_evento', extra: { evento: `Cuota ${pago.numero} impagada tras 3 intentos` } }, lead.id);
  }
  return actualizado;
}

/** Desistimiento del consumidor dentro de los 14 días naturales (arts. 102 y 104 TRLGDCU). */
export function desistir(ctx, token, { ip = null, userAgent = null } = {}) {
  const encargo = ctx.store.encargoPorToken(token);
  if (!encargo) throw noEncontrado();
  if (!['firmado', 'activo'].includes(encargo.estado)) throw new ErrorValidacion('Esta hoja de encargo no admite desistimiento.');
  const limite = sumarDias(encargo.firmado, DIAS_DESISTIMIENTO);
  if (ctx.reloj() > limite) throw new ErrorValidacion('El plazo de desistimiento de 14 días naturales ha terminado. Contacte con el despacho.');
  const ahora = ctx.store.ahora();
  ctx.store.actualizarEncargo(encargo.id, { estado: 'desistido', desistido: ahora });
  const lead = ctx.store.lead(encargo.lead_id);
  ctx.store.cancelarTareas(lead.id);
  ctx.store.registrarEvento(lead.id, 'desistimiento', {
    encargoId: encargo.id, ip, userAgent: textoCorto(userAgent, 400), inicioInmediato: Boolean(encargo.inicio_inmediato),
    nota: encargo.inicio_inmediato
      ? 'Solicitó inicio inmediato: calcular el importe proporcional del servicio prestado (art. 108.4 TRLGDCU) y reembolsar el resto.'
      : 'Sin inicio inmediato: reembolsar íntegramente lo cobrado.',
  });
  cambiarEtapa(ctx, lead, 'desistido', { motivo: 'desistimiento del consumidor' });
  ctx.store.programar('aviso_equipo', ctx.reloj(), { plantilla: 'aviso_equipo_evento', extra: { evento: 'DESISTIMIENTO: tramitar reembolso' } }, lead.id);
  return ctx.store.encargo(encargo.id);
}
