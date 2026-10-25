import { condicionSeCumple, cambiarEtapa } from '../etapas.js';
import { descargarLeadMeta, enviarEventoConversion } from '../modules/captacion/meta.js';
import { registrarLead, leadDesdeMeta } from '../modules/captacion/intake.js';
import { registrarPagoCobrado, registrarPagoFallido } from '../modules/contratacion/encargos.js';
import { abrirExpediente, recordarDocumentos } from '../modules/documentos/expedientes.js';
import { ejecutarExtraccion } from '../modules/preparacion/preparacion.js';
import { sumarDias, sumarMinutos } from '../util.js';

const MAX_INTENTOS = 6;

function crearManejadores(ctx) {
  return {
    async mensaje(tarea, lead) {
      if (!condicionSeCumple(ctx, lead, tarea.datos.condicion)) return 'omitida';
      const resultado = await ctx.mensajeria.enviar(lead, tarea.datos.plantilla, tarea.datos.extra ?? {});
      ctx.store.registrarEvento(lead.id, 'mensaje', { plantilla: tarea.datos.plantilla, canal: resultado.canal, estado: resultado.estado });
      return resultado.estado;
    },

    async aviso_equipo(tarea, lead) {
      if (!condicionSeCumple(ctx, lead, tarea.datos.condicion)) return 'omitida';
      await ctx.mensajeria.avisarEquipo(tarea.datos.plantilla, lead, tarea.datos.extra ?? {});
      return 'enviado';
    },

    async marcar_perdido(tarea, lead) {
      if (!condicionSeCumple(ctx, lead, tarea.datos.condicion)) return 'omitida';
      cambiarEtapa(ctx, lead, 'perdido', { motivo: tarea.datos.motivo, automatico: true });
      return 'hecho';
    },

    async evento_meta(tarea, lead) {
      const resultado = await enviarEventoConversion(ctx.config, { lead, evento: tarea.datos.evento, valorCent: tarea.datos.valorCent }, ctx.fetch);
      ctx.store.registrarEvento(lead.id, 'evento_meta', { evento: tarea.datos.evento, estado: resultado.estado });
      return resultado.estado;
    },

    async importar_lead_meta(tarea) {
      const leadMeta = await descargarLeadMeta(ctx.config, tarea.datos.leadgenId, ctx.fetch);
      const { lead, duplicado } = registrarLead(ctx, leadDesdeMeta(leadMeta, ctx.config.captacion.camposMeta));
      return duplicado ? `duplicado:${lead.id}` : `creado:${lead.id}`;
    },

    async cobrar_cuota(tarea) {
      const pago = ctx.store.pago(tarea.datos.pagoId);
      if (!pago || pago.estado === 'pagado' || pago.estado === 'procesando') return 'omitida';
      const encargo = ctx.store.encargo(pago.encargo_id);
      if (encargo.estado !== 'activo') return 'omitida';
      try {
        const resultado = await ctx.pagos.cobrarCuota({ pago, encargo });
        ctx.store.actualizarPago(pago.id, { referencia: resultado.referencia, proveedor: ctx.pagos.nombre });
        if (resultado.estado === 'pagado') await registrarPagoCobrado(ctx, pago.id);
        else if (resultado.estado === 'procesando') ctx.store.actualizarPago(pago.id, { estado: 'procesando' });
        else await registrarPagoFallido(ctx, pago.id, 'cobro rechazado');
        return resultado.estado;
      } catch (error) {
        await registrarPagoFallido(ctx, pago.id, error.message);
        return 'fallido';
      }
    },

    async abrir_expediente(tarea) {
      const encargo = ctx.store.encargo(tarea.datos.encargoId);
      if (!encargo || encargo.estado !== 'activo') return 'omitida';
      abrirExpediente(ctx, encargo);
      return 'hecho';
    },

    async recordatorio_documentos(tarea, lead) {
      return recordarDocumentos(ctx, tarea, lead);
    },

    async extraer_ia(tarea) {
      return ejecutarExtraccion(ctx, tarea.datos.extraccionId, tarea.intentos);
    },

    async purga_rgpd() {
      const meses = ctx.config.despacho.protegerDatos.plazoConservacionLeadsMeses ?? 12;
      const antesDe = sumarDias(ctx.reloj(), -30 * meses).toISOString();
      const total = ctx.store.anonimizarLeadsCerrados(antesDe);
      ctx.store.programar('purga_rgpd', sumarDias(ctx.reloj(), 1));
      return `anonimizados:${total}`;
    },
  };
}

/** Procesa las tareas vencidas. Cada tarea fallida se reintenta con espera creciente. */
export function crearWorker(ctx) {
  const manejadores = crearManejadores(ctx);
  let enCurso = null;
  let temporizador = null;

  async function procesarLote() {
    let procesadas = 0;
    for (const tarea of ctx.store.tareasVencidas()) {
      const manejador = manejadores[tarea.tipo];
      try {
        if (!manejador) throw new Error(`Tipo de tarea desconocido: ${tarea.tipo}`);
        const lead = tarea.lead_id ? ctx.store.lead(tarea.lead_id) : null;
        if (tarea.lead_id && (!lead || lead.anonimizado)) {
          ctx.store.completarTarea(tarea.id);
          continue;
        }
        await manejador(tarea, lead);
        ctx.store.completarTarea(tarea.id);
      } catch (error) {
        const intentos = tarea.intentos + 1;
        ctx.log.error?.(`Tarea ${tarea.id} (${tarea.tipo}) falló (intento ${intentos}): ${error.message}`);
        if (intentos >= MAX_INTENTOS) ctx.store.fallarTarea(tarea.id, intentos, error.message);
        else ctx.store.reintentarTarea(tarea.id, intentos, sumarMinutos(ctx.reloj(), Math.min(2 ** intentos, 360)).toISOString(), error.message);
      }
      procesadas += 1;
    }
    return procesadas;
  }

  return {
    /** Procesa hasta vaciar la cola de tareas vencidas (serializado: nunca dos pasadas a la vez). */
    async procesar() {
      if (enCurso) return enCurso;
      enCurso = (async () => {
        let total = 0;
        for (let lote = await procesarLote(); lote > 0; lote = await procesarLote()) total += lote;
        return total;
      })().finally(() => { enCurso = null; });
      return enCurso;
    },
    /** Despierta el worker sin esperar al siguiente intervalo (respuesta en segundos al lead). */
    despertar() {
      setImmediate(() => this.procesar().catch((e) => ctx.log.error?.(e)));
    },
    iniciar(intervaloMs) {
      if (!ctx.store.hayTareaPendiente('purga_rgpd')) ctx.store.programar('purga_rgpd', ctx.reloj());
      temporizador = setInterval(() => this.procesar().catch((e) => ctx.log.error?.(e)), intervaloMs);
      temporizador.unref?.();
    },
    detener() {
      clearInterval(temporizador);
      return enCurso ?? Promise.resolve();
    },
  };
}
