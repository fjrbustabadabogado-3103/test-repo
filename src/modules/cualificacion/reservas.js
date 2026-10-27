import { generarHuecos } from './agenda.js';
import { alReservarCita } from './secuencias.js';
import { ErrorValidacion } from '../captacion/intake.js';
import { nuevoToken } from '../../store.js';
import { rellenar, sumarDias } from '../../util.js';

const ETAPAS_QUE_PUEDEN_RESERVAR = ['nuevo', 'contactado', 'cualificado', 'agendado', 'no_asistio', 'perdido'];

export function huecosDisponibles(ctx) {
  const ahora = ctx.reloj();
  const hasta = sumarDias(ahora, ctx.config.agenda.diasVista + 1).toISOString();
  const ocupadas = ctx.store.citasReservadasEntre(ahora.toISOString(), hasta);
  return generarHuecos(ctx.config.agenda, ahora, ocupadas);
}

/** Reserva (o reprograma) la consulta de diagnóstico de un lead. */
export function reservarCita(ctx, tokenReserva, inicioIso) {
  const resultado = ctx.store.transaccion(() => {
    const lead = ctx.store.leadPorTokenReserva(tokenReserva);
    if (!lead || lead.anonimizado) throw Object.assign(new Error('Enlace de reserva no válido.'), { statusCode: 404 });
    if (!ETAPAS_QUE_PUEDEN_RESERVAR.includes(lead.etapa)) {
      throw new ErrorValidacion('Su consulta ya se ha realizado. Si necesita otra cita, responda a nuestro último mensaje.');
    }
    const hueco = huecosDisponibles(ctx).find((h) => h.inicio === new Date(inicioIso).toISOString());
    if (!hueco) throw Object.assign(new Error('Ese horario ya no está disponible. Elija otro, por favor.'), { statusCode: 409 });

    const anterior = ctx.store.citaActiva(lead.id);
    if (anterior) {
      ctx.store.actualizarCita(anterior.id, { estado: 'reprogramada' });
      ctx.store.registrarEvento(lead.id, 'cita_reprogramada', { citaId: anterior.id });
    }
    const codigo = nuevoToken(9);
    const cita = ctx.store.crearCita({
      lead_id: lead.id,
      codigo,
      inicio: hueco.inicio,
      fin: hueco.fin,
      url_videollamada: rellenar(ctx.config.agenda.urlVideollamada, { codigo }),
    });
    ctx.store.registrarEvento(lead.id, 'cita_reservada', { citaId: cita.id, inicio: cita.inicio });
    return { lead, cita };
  });
  alReservarCita(ctx, resultado.lead, resultado.cita);
  return resultado.cita;
}
