import { cambiarEtapa } from '../../etapas.js';
import { sumarMinutos, sumarDias } from '../../util.js';

const ABIERTO_SIN_CITA = ['nuevo', 'contactado', 'cualificado'];

function programarMensaje(ctx, lead, plantilla, cuando, { grupo, condicion, extra } = {}) {
  ctx.store.programar('mensaje', cuando, { plantilla, grupo, condicion, extra }, lead.id);
}

/** Lead recién entrado: respuesta inmediata, aviso al equipo y secuencia de seguimiento. */
export function alCrearLead(ctx, lead) {
  const ahora = ctx.reloj();
  const tiempos = ctx.config.captacion.seguimientos;

  ctx.store.programar('aviso_equipo', ahora, { plantilla: 'aviso_equipo_lead' }, lead.id);

  if (lead.semaforo === 'rojo') {
    // Nunca se comunica automáticamente que un caso "no es viable": lo decide un abogado.
    programarMensaje(ctx, lead, 'revision_manual', ahora);
    return lead;
  }

  if (lead.semaforo === 'verde') lead = cambiarEtapa(ctx, lead, 'cualificado', { motivo: 'semáforo verde' });

  programarMensaje(ctx, lead, 'bienvenida', ahora);
  for (const plantilla of ['seguimiento_1', 'seguimiento_2', 'seguimiento_3']) {
    programarMensaje(ctx, lead, plantilla, sumarMinutos(ahora, tiempos[plantilla]), {
      grupo: 'seguimiento', condicion: { etapas: ABIERTO_SIN_CITA },
    });
  }
  ctx.store.programar('marcar_perdido', sumarMinutos(ahora, tiempos.marcarPerdidoTrasMinutos), {
    grupo: 'seguimiento', motivo: 'sin respuesta tras la secuencia de seguimiento', condicion: { etapas: ABIERTO_SIN_CITA },
  }, lead.id);
  return lead;
}

/** Cita reservada (o reprogramada): confirmación y recordatorios. */
export function alReservarCita(ctx, lead, cita) {
  const ahora = ctx.reloj();
  ctx.store.cancelarTareas(lead.id, 'seguimiento');
  ctx.store.cancelarTareas(lead.id, 'no_asistio');
  ctx.store.cancelarTareas(lead.id, 'cita');
  lead = cambiarEtapa(ctx, lead, 'agendado', { citaId: cita.id });

  programarMensaje(ctx, lead, 'cita_confirmada', ahora);
  const condicion = { citaId: cita.id, citaEstado: 'reservada' };
  for (const [plantilla, minutosAntes] of [['recordatorio_24h', 24 * 60], ['recordatorio_1h', 60]]) {
    const cuando = sumarMinutos(cita.inicio, -minutosAntes);
    if (cuando > ahora) programarMensaje(ctx, lead, plantilla, cuando, { grupo: 'cita', condicion });
  }
  ctx.store.programar('aviso_equipo', ahora, { plantilla: 'aviso_equipo_evento', extra: { evento: 'Nueva consulta reservada' } }, lead.id);
  return lead;
}

/** El lead no se presentó a la consulta. */
export function alNoAsistir(ctx, lead, cita) {
  const ahora = ctx.reloj();
  if (cita) ctx.store.actualizarCita(cita.id, { estado: 'no_asistio' });
  ctx.store.cancelarTareas(lead.id, 'cita');
  lead = cambiarEtapa(ctx, lead, 'no_asistio', { citaId: cita?.id });
  const condicion = { etapas: ['no_asistio'] };
  programarMensaje(ctx, lead, 'no_asistio_1', ahora, { grupo: 'no_asistio', condicion });
  programarMensaje(ctx, lead, 'no_asistio_2', sumarDias(ahora, 2), { grupo: 'no_asistio', condicion });
  ctx.store.programar('marcar_perdido', sumarDias(ahora, 7), {
    grupo: 'no_asistio', motivo: 'no asistió y no reprogramó', condicion,
  }, lead.id);
  return lead;
}

export function alAsistir(ctx, lead, cita) {
  if (cita) ctx.store.actualizarCita(cita.id, { estado: 'realizada' });
  ctx.store.cancelarTareas(lead.id, 'cita');
  return cambiarEtapa(ctx, lead, 'asistio', { citaId: cita?.id });
}

/** Hoja de encargo enviada: recordatorios de firma y aviso si se queda parada. */
export function alEnviarPropuesta(ctx, lead, encargo) {
  const ahora = ctx.reloj();
  ctx.store.cancelarTareas(lead.id, 'propuesta');
  lead = cambiarEtapa(ctx, lead, 'propuesta', { encargoId: encargo.id });
  const condicion = { encargoId: encargo.id, encargoEstado: 'enviado' };
  programarMensaje(ctx, lead, 'propuesta_enviada', ahora, { extra: { enlace_encargo: urlEncargo(ctx, encargo) } });
  for (const dias of [1, 3]) {
    programarMensaje(ctx, lead, 'propuesta_recordatorio', sumarDias(ahora, dias), {
      grupo: 'propuesta', condicion, extra: { enlace_encargo: urlEncargo(ctx, encargo) },
    });
  }
  ctx.store.programar('aviso_equipo', sumarDias(ahora, 5), {
    plantilla: 'aviso_equipo_evento', grupo: 'propuesta', condicion, extra: { evento: 'Hoja de encargo sin firmar tras 5 días' },
  }, lead.id);
  return lead;
}

/** El lead ha contestado por WhatsApp: se paran los automatismos comerciales y se avisa a una persona. */
export function alResponder(ctx, lead, texto) {
  ctx.store.registrarEvento(lead.id, 'mensaje_entrante', { texto: String(texto).slice(0, 500) });
  ctx.store.cancelarTareas(lead.id, 'seguimiento');
  ctx.store.cancelarTareas(lead.id, 'no_asistio');
  ctx.store.programar('aviso_equipo', ctx.reloj(), { plantilla: 'aviso_equipo_evento', extra: { evento: 'El lead ha respondido por WhatsApp' } }, lead.id);
  return lead;
}

/** Baja de comunicaciones (art. 21.2 LSSI: procedimiento sencillo y gratuito para oponerse). */
export function alDarseDeBaja(ctx, lead) {
  ctx.store.cancelarTareas(lead.id, 'seguimiento');
  ctx.store.cancelarTareas(lead.id, 'no_asistio');
  ctx.store.registrarEvento(lead.id, 'baja_comunicaciones', {});
  return ctx.store.actualizarLead(lead.id, { baja: true, consentimiento_comunicaciones: false });
}

export function urlEncargo(ctx, encargo) {
  return `${ctx.config.baseUrl}/encargo/${encargo.token}`;
}
