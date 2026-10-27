import { ErrorValidacion } from '../captacion/intake.js';
import { sumarDiasIso } from '../seguimiento/calendario.js';
import { localAUtc } from '../cualificacion/agenda.js';
import { textoCorto } from '../../util.js';

const noEncontrado = () => Object.assign(new Error('No encontrado.'), { statusCode: 404 });
const FIRMAS = ['nombre', 'iniciales', 'anonimo'];
export const TEXTO_CONSENTIMIENTO_TESTIMONIO = 'Autorizo a que el despacho publique este testimonio en su web, redes sociales y publicidad, con la firma que he elegido. '
  + 'Puedo retirar esta autorización en cualquier momento desde este mismo enlace, igual de fácil que la he dado (art. 7.3 RGPD). '
  + 'Sin esta autorización el despacho no puede mencionar que soy cliente (art. 20.2.e del Estatuto General de la Abogacía).';

function hoy(ctx) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: ctx.config.agenda.zona, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(ctx.reloj()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

const aLas = (ctx, fecha, hora = '10:00') => localAUtc(fecha, hora, ctx.config.agenda.zona);

export const urlValoracion = (ctx, cierre) => `${ctx.config.baseUrl}/valoracion/${cierre.token}`;
export const urlResena = (ctx, cierre) => `${ctx.config.baseUrl}/resena/${cierre.token}`;
export const urlReferido = (ctx, cierre) => `${ctx.config.baseUrl}/?ref=${cierre.codigo_referido}`;

function asegurarCierre(ctx, expediente, motivo, servicioCompletado = null) {
  return ctx.store.cierre(expediente.id)
    ?? ctx.store.crearCierre({ expediente_id: expediente.id, lead_id: expediente.lead_id, motivo, servicio_completado: servicioCompletado });
}

/**
 * Resolución favorable: se pide la valoración y, dentro de los 30 días naturales siguientes al servicio (art. 20.4 TRLGDCU),
 * la reseña. La petición va a todos los clientes, valoren como valoren: no se filtra a los satisfechos.
 */
export function iniciarCierre(ctx, expediente, { motivo, fecha }) {
  const cierre = asegurarCierre(ctx, expediente, motivo, fecha);
  if (motivo !== 'exoneracion_concedida') return cierre;
  const { valoracion, resenas } = ctx.config.cierre;
  const primerDia = Math.min(valoracion.diasTrasResolucion, resenas.ventanaDias - 1);
  ctx.store.programar('cierre_mensaje', aLas(ctx, sumarDiasIso(fecha, primerDia)), { expedienteId: expediente.id, plantilla: 'valoracion_solicitud', grupo: 'cierre' }, expediente.lead_id);
  for (const dias of resenas.recordatoriosDias ?? []) {
    if (dias >= resenas.ventanaDias) continue;
    ctx.store.programar('cierre_mensaje', aLas(ctx, sumarDiasIso(fecha, dias)), { expedienteId: expediente.id, plantilla: 'resena_recordatorio', grupo: 'cierre' }, expediente.lead_id);
  }
  ctx.store.registrarEvento(expediente.lead_id, 'cierre_iniciado', { motivo, fecha });
  return cierre;
}

/** Tarea programada: envía la petición de valoración o el recordatorio de reseña si sigue teniendo sentido. */
export async function enviarMensajeCierre(ctx, tarea, lead) {
  const cierre = ctx.store.cierre(tarea.datos.expedienteId);
  if (!cierre?.servicio_completado) return 'omitida';
  const limite = sumarDiasIso(cierre.servicio_completado, ctx.config.cierre.resenas.ventanaDias);
  if (hoy(ctx) > limite) return 'omitida_fuera_de_plazo';
  if (tarea.datos.plantilla === 'resena_recordatorio') {
    if (cierre.resena_clic || !ctx.config.cierre.resenas.urlGoogle) return 'omitida';
  }
  if (tarea.datos.plantilla === 'valoracion_solicitud' && cierre.valorado) return 'omitida';
  const resultado = await ctx.mensajeria.enviar(lead, tarea.datos.plantilla, { enlace_valoracion: urlValoracion(ctx, cierre), enlace_resena: urlResena(ctx, cierre) });
  ctx.store.registrarEvento(lead.id, 'mensaje', { plantilla: tarea.datos.plantilla, canal: resultado.canal, estado: resultado.estado });
  return resultado.estado;
}

export function cierreParaCliente(ctx, token) {
  const cierre = ctx.store.cierrePorToken(token);
  if (!cierre) throw noEncontrado();
  return cierre;
}

/** Valoración del cliente (0 a 10), comentario y, por separado, testimonio con autorización expresa. */
export function registrarValoracion(ctx, token, cuerpo, { ip = null, userAgent = null } = {}) {
  const cierre = cierreParaCliente(ctx, token);
  if (cierre.valorado) throw Object.assign(new Error('Ya nos ha enviado su valoración. ¡Gracias!'), { statusCode: 409 });
  const b = cuerpo ?? {};
  const nps = Number(b.nps);
  if (!Number.isInteger(nps) || nps < 0 || nps > 10) throw new ErrorValidacion('Elija una puntuación del 0 al 10.');
  const cambios = { nps, comentario: textoCorto(b.comentario, 1000), valorado: ctx.store.ahora() };

  if (b.testimonio?.autoriza === true) {
    const texto = textoCorto(b.testimonio.texto, 1500);
    if (!texto || texto.length < 20) throw new ErrorValidacion('Escriba su testimonio (al menos 20 caracteres) o desmarque la autorización.');
    if (!FIRMAS.includes(b.testimonio.firma)) throw new ErrorValidacion('Elija cómo quiere firmar el testimonio.');
    cambios.testimonio = {
      texto, firma: b.testimonio.firma, autorizado: true, fecha: ctx.store.ahora(), consentimiento: TEXTO_CONSENTIMIENTO_TESTIMONIO,
      ip, userAgent: textoCorto(userAgent, 300),
    };
  }
  const actualizado = ctx.store.actualizarCierre(cierre.expediente_id, cambios);
  ctx.store.registrarEvento(cierre.lead_id, 'valoracion', { nps, testimonio: Boolean(cambios.testimonio) });
  if (nps <= ctx.config.cierre.valoracion.umbralAlertaNps) {
    ctx.store.programar('aviso_equipo', ctx.reloj(), { plantilla: 'aviso_equipo_evento', extra: { evento: `Cliente poco satisfecho (${nps}/10): llamar` } }, cierre.lead_id);
  }
  return vistaCliente(ctx, actualizado);
}

/** Retirada del consentimiento para el testimonio, tan sencilla como darlo (art. 7.3 RGPD). */
export function revocarTestimonio(ctx, token) {
  const cierre = cierreParaCliente(ctx, token);
  if (!cierre.testimonio?.autorizado) throw new ErrorValidacion('No hay ningún testimonio autorizado.');
  const actualizado = ctx.store.actualizarCierre(cierre.expediente_id, { testimonio: { ...cierre.testimonio, autorizado: false, revocado: ctx.store.ahora() } });
  ctx.store.registrarEvento(cierre.lead_id, 'testimonio_revocado', {});
  ctx.store.programar('aviso_equipo', ctx.reloj(), { plantilla: 'aviso_equipo_evento', extra: { evento: 'Testimonio revocado: retirarlo de la web, redes y publicidad' } }, cierre.lead_id);
  return vistaCliente(ctx, actualizado);
}

export function registrarClicResena(ctx, token) {
  const cierre = cierreParaCliente(ctx, token);
  const url = ctx.config.cierre.resenas.urlGoogle;
  if (!url) return null;
  if (!cierre.resena_clic) {
    ctx.store.actualizarCierre(cierre.expediente_id, { resena_clic: ctx.store.ahora() });
    ctx.store.registrarEvento(cierre.lead_id, 'resena_clic', {});
  }
  return url;
}

export function vistaCliente(ctx, cierre) {
  const lead = ctx.store.lead(cierre.lead_id);
  return {
    nombre: (lead.nombre ?? '').split(' ')[0],
    valorado: Boolean(cierre.valorado),
    nps: cierre.nps,
    resena: ctx.config.cierre.resenas.urlGoogle ? urlResena(ctx, cierre) : null,
    referido: urlReferido(ctx, cierre),
    testimonio: cierre.testimonio ? { texto: cierre.testimonio.texto, autorizado: cierre.testimonio.autorizado, firma: cierre.testimonio.firma } : null,
    consentimiento: TEXTO_CONSENTIMIENTO_TESTIMONIO,
  };
}

// ---------------- Archivo y conservación ----------------

function programarFinConservacion(ctx, expediente, desde) {
  const anios = ctx.config.cierre.conservacion.aniosTrasCierre;
  const [a, m, d] = desde.split('-').map(Number);
  const conservarHasta = new Date(Date.UTC(a + anios, m - 1, d)).toISOString().slice(0, 10);
  ctx.store.actualizarCierre(expediente.id, { archivado: desde, conservar_hasta: conservarHasta });
  ctx.store.programar('fin_conservacion', aLas(ctx, conservarHasta, '09:00'), { expedienteId: expediente.id }, expediente.lead_id);
  return conservarHasta;
}

/** Fin de la relación por desistimiento: se fija el plazo de conservación (art. 1964.2 CC, configurable). */
export function registrarFinPorDesistimiento(ctx, expediente) {
  asegurarCierre(ctx, expediente, 'desistimiento');
  if (!ctx.store.cierre(expediente.id).archivado) programarFinConservacion(ctx, expediente, hoy(ctx));
}

/** Archiva el expediente tras la resolución: cierra el portal, registra la actuación y fija la conservación. */
export function archivarExpediente(ctx, expedienteId) {
  const expediente = ctx.store.expediente(expedienteId);
  if (!expediente) throw noEncontrado();
  const procedimiento = ctx.store.procedimientoDeExpediente(expediente.id);
  if (!procedimiento || !['exoneracion_concedida', 'exoneracion_denegada'].includes(procedimiento.estado)) {
    throw new ErrorValidacion('Solo se archiva tras la resolución sobre la exoneración.');
  }
  const pendientes = ctx.store.plazosDeProcedimiento(procedimiento.id).filter((p) => p.estado === 'pendiente' && p.parte === 'nuestro');
  if (pendientes.length) throw new ErrorValidacion(`Hay ${pendientes.length} plazo(s) propio(s) pendiente(s): resuélvalos antes de archivar.`);
  if (ctx.store.cierre(expediente.id)?.archivado) throw new ErrorValidacion('El expediente ya está archivado.');

  const fecha = hoy(ctx);
  ctx.store.transaccion(() => {
    ctx.store.crearActuacion({ procedimiento_id: procedimiento.id, tipo: 'archivo', fecha, titulo: ctx.config.procesal.actuaciones.archivo?.titulo ?? 'Archivo', visible_cliente: false });
    ctx.store.actualizarProcedimiento(procedimiento.id, { estado: 'archivado' });
    ctx.store.actualizarExpediente(expediente.id, { estado: 'cerrado' });
    asegurarCierre(ctx, expediente, procedimiento.estado === 'exoneracion_concedida' ? 'exoneracion_concedida' : 'exoneracion_denegada');
  });
  const conservarHasta = programarFinConservacion(ctx, expediente, fecha);
  ctx.store.registrarEvento(expediente.lead_id, 'expediente_archivado', { conservarHasta });
  return ctx.store.cierre(expediente.id);
}

export function avisarFinConservacion(ctx, tarea) {
  const cierre = ctx.store.cierre(tarea.datos.expedienteId);
  if (!cierre || cierre.documentos_eliminados) return 'omitida';
  ctx.store.actualizarCierre(cierre.expediente_id, { aviso_conservacion: ctx.store.ahora() });
  ctx.store.programar('aviso_equipo', ctx.reloj(), {
    plantilla: 'aviso_equipo_evento', extra: { evento: 'Fin del plazo de conservación: revise y, si procede, elimine los documentos del expediente' },
  }, cierre.lead_id);
  return 'avisado';
}

/** Elimina los documentos cifrados del expediente una vez cumplido el plazo de conservación. */
export async function eliminarDocumentosExpediente(ctx, expedienteId) {
  const cierre = ctx.store.cierre(expedienteId);
  if (!cierre?.conservar_hasta) throw new ErrorValidacion('El expediente no está archivado.');
  if (hoy(ctx) < cierre.conservar_hasta) throw new ErrorValidacion(`Los documentos deben conservarse hasta el ${cierre.conservar_hasta}.`);
  if (cierre.documentos_eliminados) throw new ErrorValidacion('Los documentos ya se eliminaron.');
  let eliminados = 0;
  for (const doc of ctx.store.documentosDeExpediente(expedienteId)) {
    for (const archivo of ctx.store.archivosDeDocumento(doc.id)) {
      await ctx.almacen.borrar(archivo);
      ctx.store.marcarArchivoEliminado(archivo.id);
      eliminados += 1;
    }
  }
  ctx.store.actualizarCierre(expedienteId, { documentos_eliminados: ctx.store.ahora() });
  ctx.store.registrarEvento(cierre.lead_id, 'documentos_eliminados', { archivos: eliminados });
  return { eliminados };
}

// ---------------- Panel ----------------

export function resumenCierre(ctx, expedienteId) {
  const cierre = ctx.store.cierre(expedienteId);
  if (!cierre) return null;
  return {
    ...cierre,
    urlValoracion: urlValoracion(ctx, cierre),
    urlReferido: urlReferido(ctx, cierre),
    referidos: ctx.store.leadsConReferido(cierre.codigo_referido).length,
    puedeEliminar: Boolean(cierre.conservar_hasta && !cierre.documentos_eliminados && hoy(ctx) >= cierre.conservar_hasta),
  };
}

/** Satisfacción y recomendaciones de todo el despacho. Los referidos se cuentan, nunca se comunican al cliente que recomendó (secreto profesional). */
export function metricasCierre(ctx) {
  const cierres = ctx.store.cierres();
  const valorados = cierres.filter((c) => c.nps != null);
  const promotores = valorados.filter((c) => c.nps >= 9).length;
  const detractores = valorados.filter((c) => c.nps <= 6).length;
  const referidos = cierres.flatMap((c) => ctx.store.leadsConReferido(c.codigo_referido));
  return {
    cierres: cierres.length,
    valoraciones: valorados.length,
    nps: valorados.length ? Math.round(((promotores - detractores) / valorados.length) * 100) : null,
    clicsResena: cierres.filter((c) => c.resena_clic).length,
    testimoniosAutorizados: cierres.filter((c) => c.testimonio?.autorizado).length,
    leadsReferidos: referidos.length,
    clientesReferidos: referidos.filter((l) => l.etapa === 'cliente').length,
  };
}

export function testimoniosAutorizados(ctx) {
  return ctx.store.cierres().filter((c) => c.testimonio?.autorizado).map((c) => {
    const lead = ctx.store.lead(c.lead_id);
    const partes = (lead.nombre ?? '').split(/\s+/).filter(Boolean);
    const firma = { nombre: lead.nombre, iniciales: partes.map((p) => `${p[0]}.`).join(' '), anonimo: 'Cliente del despacho' }[c.testimonio.firma];
    return { expedienteId: c.expediente_id, texto: c.testimonio.texto, firma, autorizadoEl: c.testimonio.fecha, nps: c.nps };
  });
}
