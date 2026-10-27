import { rellenar, fechaLarga, escaparHtml } from '../util.js';
import { crearWhatsapp, crearEmail } from './proveedores.js';

/**
 * Envía las plantillas de config/mensajes.json por WhatsApp (preferente) o correo, respetando:
 *  - la baja del destinatario (responde BAJA),
 *  - el consentimiento para comunicaciones comerciales (art. 21 LSSI) en las plantillas marcadas `comercial`.
 */
export function crearMensajeria({ config, store, whatsapp, email, log = console }) {
  const wa = whatsapp ?? crearWhatsapp(config, { log });
  const correo = email ?? crearEmail(config, { log });

  function variablesLead(lead, extra = {}) {
    const cita = store.citaActiva(lead.id);
    return {
      despacho: config.despacho.nombreComercial,
      nombre: (lead.nombre ?? '').split(' ')[0] || 'hola',
      nombre_completo: lead.nombre ?? '',
      telefono: lead.telefono ?? '',
      provincia: lead.provincia ?? '',
      semaforo: lead.semaforo,
      origen: lead.origen,
      deuda_total: lead.respuestas?.deuda_total != null ? `${lead.respuestas.deuda_total} €` : 'sin indicar',
      enlace_reserva: `${config.baseUrl}/reservar/${lead.token_reserva}`,
      enlace_admin: `${config.baseUrl}/admin#lead=${lead.id}`,
      fecha_cita: cita ? fechaLarga(cita.inicio, config.agenda.zona) : '',
      enlace_cita: cita?.url_videollamada ?? '',
      ...extra,
    };
  }

  async function entregar({ leadId, plantillaClave, plantilla, variables, destinoWhatsapp, destinoEmail }) {
    const texto = rellenar(plantilla.texto, variables);
    const asunto = rellenar(plantilla.asunto ?? config.despacho.nombreComercial, variables);
    if (destinoWhatsapp && plantilla.whatsapp) {
      const parametros = (plantilla.parametros ?? []).map((p) => variables[p] ?? '');
      try {
        const respuesta = await wa.enviarPlantilla({ destino: destinoWhatsapp, plantilla: plantilla.whatsapp, parametros, texto });
        store.registrarSalida({ leadId, canal: 'whatsapp', proveedor: wa.nombre, destino: destinoWhatsapp, plantilla: plantillaClave, contenido: texto, estado: respuesta.estado, respuesta });
        return { canal: 'whatsapp', ...respuesta };
      } catch (error) {
        store.registrarSalida({ leadId, canal: 'whatsapp', proveedor: wa.nombre, destino: destinoWhatsapp, plantilla: plantillaClave, contenido: texto, estado: 'error', respuesta: { error: error.message } });
        if (!destinoEmail) throw error;
        log.warn?.(`WhatsApp falló para ${plantillaClave}; se intenta por correo: ${error.message}`);
      }
    }
    if (destinoEmail) {
      const html = `<p>${escaparHtml(texto).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>')}</p>`;
      const respuesta = await correo.enviar({ destino: destinoEmail, asunto, texto, html });
      store.registrarSalida({ leadId, canal: 'email', proveedor: correo.nombre, destino: destinoEmail, plantilla: plantillaClave, contenido: texto, estado: respuesta.estado, respuesta });
      return { canal: 'email', ...respuesta };
    }
    return { canal: null, estado: 'sin_destino' };
  }

  return {
    variablesLead,

    /** Envía una plantilla a un lead. Devuelve { estado } con 'omitido_*' si no procede enviarla. */
    async enviar(lead, plantillaClave, extra = {}) {
      const plantilla = config.mensajes[plantillaClave];
      if (!plantilla) throw new Error(`Plantilla desconocida: ${plantillaClave}`);
      if (lead.anonimizado) return { estado: 'omitido_anonimizado' };
      if (lead.baja && plantillaClave !== 'codigo_firma') return { estado: 'omitido_baja' };
      // art. 21.2 LSSI: con relación contractual previa se pueden enviar comunicaciones sobre servicios propios similares, con baja sencilla.
      const exentoPorContrato = plantilla.excepcionClientes === true && ['cliente', 'firmado'].includes(lead.etapa);
      if (plantilla.comercial && !lead.consentimiento_comunicaciones && !exentoPorContrato) return { estado: 'omitido_sin_consentimiento' };
      const resultado = await entregar({
        leadId: lead.id,
        plantillaClave,
        plantilla,
        variables: variablesLead(lead, extra),
        destinoWhatsapp: lead.telefono,
        destinoEmail: lead.email,
      });
      if (!lead.primer_contacto && resultado.canal) store.actualizarLead(lead.id, { primer_contacto: store.ahora() });
      return resultado;
    },

    /** Envía un correo con HTML propio (p. ej. la confirmación del encargo en soporte duradero, art. 98.7 TRLGDCU). */
    async enviarCorreoDocumento(lead, { asunto, texto, html }) {
      if (!lead.email) return { estado: 'sin_email' };
      const respuesta = await correo.enviar({ destino: lead.email, asunto, texto, html });
      store.registrarSalida({ leadId: lead.id, canal: 'email', proveedor: correo.nombre, destino: lead.email, plantilla: 'documento', contenido: asunto, estado: respuesta.estado, respuesta });
      return respuesta;
    },

    /** Aviso interno al equipo (setter / abogado). */
    async avisarEquipo(plantillaClave, lead, extra = {}) {
      const plantilla = config.mensajes[plantillaClave];
      const variables = { ...variablesLead(lead, extra), nombre: lead.nombre ?? '(sin nombre)' };
      const resultados = [];
      for (const telefono of config.equipo.whatsapp) {
        resultados.push(await entregar({ leadId: lead.id, plantillaClave, plantilla, variables, destinoWhatsapp: telefono }).catch((e) => ({ estado: 'error', error: e.message })));
      }
      for (const destino of config.equipo.email) {
        resultados.push(await entregar({ leadId: lead.id, plantillaClave, plantilla, variables, destinoEmail: destino }).catch((e) => ({ estado: 'error', error: e.message })));
      }
      if (resultados.length === 0) log.info?.(`[equipo] ${rellenar(plantilla.texto, variables)}`);
      return resultados;
    },
  };
}
