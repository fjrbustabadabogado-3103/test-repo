import { ETAPAS } from './store.js';

/**
 * Cambia la etapa de un lead, deja constancia en el historial y, si la etapa está mapeada en
 * config/captacion.json → eventosMeta, programa el envío del evento a la API de Conversiones.
 */
export function cambiarEtapa(ctx, lead, etapa, datos = {}) {
  if (!ETAPAS.includes(etapa)) throw new Error(`Etapa desconocida: ${etapa}`);
  if (lead.etapa === etapa) return lead;
  const cambios = { etapa };
  if (['perdido', 'descartado', 'desistido'].includes(etapa)) cambios.motivo_cierre = datos.motivo ?? null;
  const actualizado = ctx.store.actualizarLead(lead.id, cambios);
  ctx.store.registrarEvento(lead.id, 'etapa', { de: lead.etapa, a: etapa, ...datos });
  const eventoMeta = ctx.config.captacion.eventosMeta?.[etapa];
  if (eventoMeta) ctx.store.programar('evento_meta', ctx.reloj(), { evento: eventoMeta, valorCent: datos.valorCent ?? null }, lead.id);
  return actualizado;
}

/** Comprueba si una tarea programada sigue teniendo sentido cuando llega su hora. */
export function condicionSeCumple(ctx, lead, condicion = {}) {
  if (!lead) return false;
  if (condicion.etapas && !condicion.etapas.includes(lead.etapa)) return false;
  if (condicion.citaId) {
    const cita = ctx.store.cita(condicion.citaId);
    if (!cita || cita.estado !== (condicion.citaEstado ?? 'reservada')) return false;
  }
  if (condicion.encargoId) {
    const encargo = ctx.store.encargo(condicion.encargoId);
    if (!encargo || encargo.estado !== (condicion.encargoEstado ?? 'enviado')) return false;
  }
  return true;
}
