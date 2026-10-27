import Fastify from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store, ETAPAS } from './store.js';
import { loadConfig } from './config.js';
import { crearMensajeria } from './messaging/mensajeria.js';
import { crearPagos, firmaStripeValida } from './modules/contratacion/pagos.js';
import { crearWorker } from './jobs/worker.js';
import { registrarLead, leadDesdeWeb } from './modules/captacion/intake.js';
import { firmaMetaValida, extraerLeadgen, extraerMensajesWhatsapp } from './modules/captacion/meta.js';
import { huecosDisponibles, reservarCita } from './modules/cualificacion/reservas.js';
import { generarIcs } from './modules/cualificacion/agenda.js';
import { alNoAsistir, alAsistir, alResponder, alDarseDeBaja } from './modules/cualificacion/secuencias.js';
import {
  crearPropuesta, encargoParaFirmar, solicitarCodigo, firmarEncargo, enlacePago, registrarPagoCobrado, registrarPagoFallido, desistir,
} from './modules/contratacion/encargos.js';
import { cambiarEtapa } from './etapas.js';
import { calcularMetricas } from './metricas.js';
import { paginaEncargo, paginaPrivacidad, paginaMensaje, paginaExpediente, paginaValoracion } from './paginas.js';
import { crearAlmacen } from './modules/documentos/almacen.js';
import {
  abrirExpediente, expedienteParaCliente, resumenExpediente, guardarDatos, subirArchivo, eliminarArchivo, revisarDocumento, urlPortal,
} from './modules/documentos/expedientes.js';
import {
  resumenPreparacion, expedienteParaPreparar, guardarDatosPreparacion, crearPartida, editarPartida, borrarPartida, solicitarExtraccion, marcarListo,
} from './modules/preparacion/preparacion.js';
import { crearClienteIa } from './modules/preparacion/extraccion.js';
import { generarDocumento } from './modules/preparacion/documentos-word.js';
import {
  cierreParaCliente, vistaCliente, registrarValoracion, revocarTestimonio, registrarClicResena, archivarExpediente,
  eliminarDocumentosExpediente, resumenCierre, metricasCierre, testimoniosAutorizados,
} from './modules/cierre/cierre.js';
import {
  resumenSeguimiento, actualizarDatosProcedimiento, registrarActuacion, marcarPlazo, agendaPlazos, seguimientoParaCliente,
  icsPlazos, claveCalendario, claveCalendarioValida,
} from './modules/seguimiento/procedimientos.js';
import { igualSeguro, aCentimos, normalizarTelefono, fechaLarga, escaparHtml } from './util.js';

const PAGINAS_ESTATICAS = { '/admin': 'admin.html', '/admin/expediente/:id': 'admin-expediente.html' };
const JS = 'text/javascript; charset=utf-8';
const ESTATICOS = { 'estilos.css': 'text/css; charset=utf-8', 'landing.js': JS, 'admin.js': JS, 'reservar.js': JS, 'encargo.js': JS, 'expediente.js': JS, 'admin-expediente.js': JS, 'valoracion.js': JS,
  'marca.svg': 'image/svg+xml', 'favicon.svg': 'image/svg+xml' };
// Fuentes servidas desde el propio dominio (sin llamadas a terceros). sifonn-pro.woff2 es opcional: la aporta el despacho.
const FUENTES = ['poppins-400.woff2', 'poppins-600.woff2', 'poppins-700.woff2', 'sifonn-pro.woff2'];
const ETAPAS_MANUALES = ['contactado', 'cualificado', 'asistio', 'no_asistio', 'perdido', 'descartado', 'nuevo'];
// Con hoja de encargo firmada, la etapa la gobiernan la firma, los pagos y el desistimiento.
const ETAPAS_BLOQUEADAS = ['firmado', 'cliente', 'desistido'];

/**
 * Construye la aplicación. Todas las dependencias externas se pueden inyectar (tests).
 */
export function construirApp({ config = loadConfig(), store, reloj = () => new Date(), fetchImpl = fetch, mensajeria, pagos, almacen, ia, log } = {}) {
  const app = Fastify({ logger: log === undefined ? { level: config.produccion ? 'info' : 'warn' } : log, trustProxy: config.trustProxy, bodyLimit: 256 * 1024 });
  const ctx = {
    config,
    reloj,
    fetch: fetchImpl,
    log: app.log,
    store: store ?? new Store(config.dbPath, reloj),
  };
  ctx.mensajeria = mensajeria ?? crearMensajeria({ config, store: ctx.store, log: app.log });
  ctx.pagos = pagos ?? crearPagos(config, { fetchImpl });
  ctx.almacen = almacen ?? crearAlmacen(config);
  ctx.ia = ia ?? (config.ia?.activada ? crearClienteIa() : null);
  ctx.worker = crearWorker(ctx);
  app.decorate('ctx', ctx);

  // Conserva el cuerpo crudo: las firmas de Meta y Stripe se calculan sobre los bytes recibidos.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, cuerpo, hecho) => {
    req.cuerpoCrudo = cuerpo;
    try {
      hecho(null, cuerpo ? JSON.parse(cuerpo) : {});
    } catch {
      hecho(Object.assign(new Error('JSON no válido'), { statusCode: 400 }));
    }
  });

  app.setErrorHandler((error, req, reply) => {
    const estado = error.statusCode ?? 500;
    if (estado >= 500) req.log.error(error);
    reply.code(estado).send({ error: estado >= 500 ? 'Error interno. Inténtelo de nuevo en unos minutos.' : error.message, ...(error.faltas ? { faltas: error.faltas } : {}) });
  });

  app.addHook('onSend', async (req, reply, cuerpo) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    return cuerpo;
  });

  const dirWeb = config.paths?.web ?? join(import.meta.dirname, '..', 'web');
  const web = (archivo) => readFileSync(join(dirWeb, archivo), 'utf8');
  const html = (reply, contenido) => reply.type('text/html; charset=utf-8').send(contenido);

  // ---------------- Páginas públicas ----------------

  for (const [ruta, archivo] of Object.entries(PAGINAS_ESTATICAS)) app.get(ruta, async (req, reply) => html(reply, web(archivo)));

  app.get('/', async (req, reply) => {
    const d = config.despacho;
    const valores = { despacho: d.nombreComercial, titular: d.titular.nombre, numeroColegiado: d.titular.numeroColegiado, colegio: d.titular.colegio };
    return html(reply, web('landing.html').replace(/\{\{(\w+)\}\}/g, (_, clave) => escaparHtml(valores[clave] ?? '')));
  });

  const conSifonn = existsSync(join(dirWeb, 'fuentes', 'sifonn-pro.woff2'));
  const fuenteSifonn = '@font-face { font-family: "Sifonn Pro"; font-weight: 400 700; font-display: swap; src: url("/static/fuentes/sifonn-pro.woff2") format("woff2"); }\n';

  app.get('/static/:archivo', async (req, reply) => {
    const tipo = ESTATICOS[req.params.archivo];
    if (!tipo) return reply.code(404).send('No encontrado');
    const contenido = web(req.params.archivo);
    return reply.type(tipo).header('Cache-Control', 'public, max-age=300')
      .send(req.params.archivo === 'estilos.css' && conSifonn ? fuenteSifonn + contenido : contenido);
  });

  app.get('/static/fuentes/:archivo', async (req, reply) => {
    const ruta = join(dirWeb, 'fuentes', req.params.archivo);
    if (!FUENTES.includes(req.params.archivo) || !existsSync(ruta)) return reply.code(404).send('No encontrado');
    return reply.type('font/woff2').header('Cache-Control', 'public, max-age=31536000, immutable').send(readFileSync(ruta));
  });

  app.get('/privacidad', async (req, reply) => html(reply, paginaPrivacidad(config)));
  // Comprobación de vida para Docker y monitores externos (sin registrar cada consulta).
  app.get('/health', { logLevel: 'warn' }, async () => {
    ctx.store.db.prepare('SELECT 1').get();
    return { ok: true };
  });

  // ---------------- Módulo 1 · Captación ----------------

  app.post('/api/leads', async (req, reply) => {
    const { lead, duplicado } = registrarLead(ctx, leadDesdeWeb(req.body ?? {}));
    ctx.worker.despertar();
    const puedeReservar = lead.semaforo !== 'rojo';
    return reply.code(duplicado ? 200 : 201).send({
      ok: true,
      reserva: puedeReservar ? `/reservar/${lead.token_reserva}` : null,
    });
  });

  app.get('/webhooks/meta', async (req, reply) => {
    const { 'hub.mode': modo, 'hub.verify_token': token, 'hub.challenge': reto } = req.query;
    if (modo === 'subscribe' && config.meta.verifyToken && igualSeguro(token, config.meta.verifyToken)) return reply.type('text/plain').send(reto);
    return reply.code(403).send('Prohibido');
  });

  app.post('/webhooks/meta', async (req, reply) => {
    if (!firmaMetaValida(req.cuerpoCrudo, req.headers['x-hub-signature-256'], config.meta.appSecret)) return reply.code(401).send('Firma no válida');
    for (const aviso of extraerLeadgen(req.body)) {
      ctx.store.programar('importar_lead_meta', reloj(), { leadgenId: String(aviso.leadgen_id), formId: aviso.form_id, adId: aviso.ad_id });
    }
    for (const mensaje of extraerMensajesWhatsapp(req.body)) {
      const lead = ctx.store.leadPorTelefono(normalizarTelefono(mensaje.de));
      if (!lead) continue;
      if (/^\s*(baja|stop)\s*\.?\s*$/i.test(mensaje.texto)) alDarseDeBaja(ctx, lead);
      else alResponder(ctx, lead, mensaje.texto);
    }
    ctx.worker.despertar();
    return reply.send('EVENT_RECEIVED');
  });

  // ---------------- Módulo 2 · Agenda ----------------

  app.get('/reservar/:token', async (req, reply) => {
    const lead = ctx.store.leadPorTokenReserva(req.params.token);
    if (!lead || lead.anonimizado) return html(reply.code(404), paginaMensaje(config, 'Enlace no válido', 'Este enlace de reserva no existe o ha caducado.'));
    return html(reply, web('reservar.html'));
  });

  app.get('/api/reservas/:token', async (req, reply) => {
    const lead = ctx.store.leadPorTokenReserva(req.params.token);
    if (!lead || lead.anonimizado) return reply.code(404).send({ error: 'Enlace no válido.' });
    const cita = ctx.store.citaActiva(lead.id);
    return {
      nombre: (lead.nombre ?? '').split(' ')[0],
      zona: config.agenda.zona,
      duracionMinutos: config.agenda.duracionMinutos,
      citaActual: cita ? { inicio: cita.inicio, texto: fechaLarga(cita.inicio, config.agenda.zona), url: cita.url_videollamada, codigo: cita.codigo } : null,
      huecos: huecosDisponibles(ctx).map((h) => ({ inicio: h.inicio, fecha: h.fecha })),
    };
  });

  app.post('/api/reservas/:token', async (req) => {
    const cita = reservarCita(ctx, req.params.token, req.body?.inicio);
    ctx.worker.despertar();
    return { ok: true, inicio: cita.inicio, texto: fechaLarga(cita.inicio, config.agenda.zona), url: cita.url_videollamada, ics: `/api/citas/${cita.codigo}.ics` };
  });

  app.get('/api/citas/:archivo', async (req, reply) => {
    const cita = req.params.archivo.endsWith('.ics') ? ctx.store.citaPorCodigo(req.params.archivo.slice(0, -4)) : null;
    if (!cita) return reply.code(404).send('No encontrada');
    return reply.type('text/calendar; charset=utf-8').header('Content-Disposition', 'attachment; filename="consulta.ics"').send(generarIcs({
      codigo: cita.codigo, inicio: cita.inicio, fin: cita.fin, url: cita.url_videollamada,
      titulo: `Consulta de diagnóstico · ${config.despacho.nombreComercial}`,
      descripcion: `Videollamada: ${cita.url_videollamada}`,
    }));
  });

  // ---------------- Módulo 3 · Contratación ----------------

  app.get('/encargo/:token', async (req, reply) => {
    const encargo = encargoParaFirmar(ctx, req.params.token);
    if (encargo.estado === 'anulado') return html(reply, paginaMensaje(config, 'Propuesta sustituida', 'Esta hoja de encargo ha sido sustituida por una más reciente. Revise el último enlace que le hemos enviado.'));
    return html(reply, paginaEncargo(ctx, encargo, ctx.store.pagosDeEncargo(encargo.id), req.query));
  });

  app.post('/api/encargos/:token/codigo', async (req) => solicitarCodigo(ctx, req.params.token));

  app.post('/api/encargos/:token/firmar', async (req) => {
    const b = req.body ?? {};
    const { urlPago } = await firmarEncargo(ctx, req.params.token, {
      codigo: b.codigo, nombre: b.nombre, dni: b.dni, aceptaHoja: b.aceptaHoja === true, aceptaPago: b.aceptaPago === true,
      inicioInmediato: b.inicioInmediato === true, documentoSha256: b.documentoSha256, ip: req.ip, userAgent: req.headers['user-agent'],
    });
    ctx.worker.despertar();
    return { ok: true, urlPago };
  });

  app.post('/api/encargos/:token/pagar', async (req) => {
    const encargo = ctx.store.encargoPorToken(req.params.token);
    if (!encargo || !['firmado', 'activo'].includes(encargo.estado)) throw Object.assign(new Error('No hay pagos pendientes.'), { statusCode: 400 });
    const { url } = await enlacePago(ctx, encargo, encargo.estado === 'firmado' ? 'entrada' : 'cuota', req.body?.pagoId ?? null);
    return { ok: true, urlPago: url };
  });

  app.post('/api/encargos/:token/desistir', async (req) => {
    if (req.body?.confirmo !== true) throw Object.assign(new Error('Confirme que desea desistir.'), { statusCode: 400 });
    desistir(ctx, req.params.token, { ip: req.ip, userAgent: req.headers['user-agent'] });
    ctx.worker.despertar();
    return { ok: true };
  });

  app.get('/pago/ok', async (req, reply) => html(reply, paginaMensaje(config, 'Pago recibido', 'Gracias. En cuanto el banco confirme el pago le escribiremos con los siguientes pasos de su expediente.', req.query.encargo ? `/encargo/${encodeURIComponent(req.query.encargo)}` : null)));

  if (config.pagos.proveedor === 'simulado' && !config.produccion) {
    app.get('/pago-simulado/:id', async (req, reply) => {
      const pago = ctx.store.pago(req.params.id);
      if (!pago) return reply.code(404).send('No encontrado');
      await registrarPagoCobrado(ctx, pago.id, { referencia: `sim_${pago.id}` });
      ctx.worker.despertar();
      const encargo = ctx.store.encargo(pago.encargo_id);
      return reply.redirect(`/pago/ok?encargo=${encodeURIComponent(encargo.token)}`);
    });
  }

  app.post('/webhooks/stripe', async (req, reply) => {
    if (!firmaStripeValida(req.cuerpoCrudo, req.headers['stripe-signature'], config.pagos.stripeWebhookSecret, Math.floor(reloj().getTime() / 1000))) {
      return reply.code(400).send('Firma no válida');
    }
    const evento = req.body;
    const objeto = evento.data?.object ?? {};
    const pagoId = objeto.metadata?.pago_id;
    if (pagoId) {
      switch (evento.type) {
        case 'checkout.session.completed':
          if (objeto.payment_status === 'paid') await registrarPagoCobrado(ctx, pagoId, { referencia: objeto.id, paymentIntent: objeto.payment_intent });
          else ctx.store.actualizarPago(pagoId, { estado: 'procesando' });
          break;
        case 'checkout.session.async_payment_succeeded':
          await registrarPagoCobrado(ctx, pagoId, { referencia: objeto.id, paymentIntent: objeto.payment_intent });
          break;
        case 'checkout.session.async_payment_failed':
          await registrarPagoFallido(ctx, pagoId, 'adeudo SEPA rechazado');
          break;
        case 'payment_intent.succeeded':
          if (ctx.store.pago(pagoId)?.tipo === 'cuota') await registrarPagoCobrado(ctx, pagoId, { referencia: objeto.id });
          break;
        case 'payment_intent.payment_failed':
          if (ctx.store.pago(pagoId)?.tipo === 'cuota') await registrarPagoFallido(ctx, pagoId, objeto.last_payment_error?.message ?? 'pago rechazado');
          break;
        default:
          break;
      }
    }
    ctx.worker.despertar();
    return { received: true };
  });

  // ---------------- Módulo 4 · Recogida de documentos ----------------

  const limiteSubida = config.documentos.maxMbPorArchivo * 1024 * 1024 + 1024;
  app.addContentTypeParser(/^(application\/pdf|application\/octet-stream|image\/[\w.+-]+)$/, { parseAs: 'buffer', bodyLimit: limiteSubida }, (req, cuerpo, hecho) => hecho(null, cuerpo));

  app.get('/expediente/:token', async (req, reply) => {
    const expediente = ctx.store.expedientePorToken(req.params.token);
    if (!expediente) return html(reply.code(404), paginaMensaje(config, 'Enlace no válido', 'Este enlace no corresponde a ningún expediente.'));
    return html(reply, paginaExpediente(ctx, expediente));
  });

  app.get('/api/expedientes/:token', async (req) => {
    const expediente = expedienteParaCliente(ctx, req.params.token);
    return { ...resumenExpediente(ctx, expediente), seguimiento: seguimientoParaCliente(ctx, expediente) };
  });

  // ---------------- Módulo 7 · Valoración, reseñas y recomendaciones ----------------

  app.get('/valoracion/:token', async (req, reply) => {
    const cierre = ctx.store.cierrePorToken(req.params.token);
    if (!cierre) return html(reply.code(404), paginaMensaje(config, 'Enlace no válido', 'Este enlace de valoración no existe.'));
    return html(reply, paginaValoracion(ctx, cierre));
  });

  app.get('/api/valoracion/:token', async (req) => vistaCliente(ctx, cierreParaCliente(ctx, req.params.token)));

  app.post('/api/valoracion/:token', async (req) => {
    const vista = registrarValoracion(ctx, req.params.token, req.body, { ip: req.ip, userAgent: req.headers['user-agent'] });
    ctx.worker.despertar();
    return vista;
  });

  app.post('/api/valoracion/:token/revocar', async (req) => {
    const vista = revocarTestimonio(ctx, req.params.token);
    ctx.worker.despertar();
    return vista;
  });

  app.get('/resena/:token', async (req, reply) => {
    const url = registrarClicResena(ctx, req.params.token);
    if (!url) return html(reply.code(404), paginaMensaje(config, 'Enlace no disponible', 'Gracias por su interés. El enlace para dejar su opinión no está disponible en este momento.'));
    return reply.redirect(url);
  });

  // ---------------- Módulo 6 · Calendario de plazos (suscripción desde Google Calendar u Outlook) ----------------

  app.get('/calendario/plazos.ics', async (req, reply) => {
    if (!claveCalendarioValida(ctx, req.query.clave)) return reply.code(404).send('No encontrado');
    return reply.type('text/calendar; charset=utf-8').header('Cache-Control', 'no-store').send(icsPlazos(ctx));
  });

  app.post('/api/expedientes/:token/datos', async (req) => {
    const resumen = guardarDatos(ctx, req.params.token, req.body);
    ctx.worker.despertar();
    return resumen;
  });

  app.put('/api/expedientes/:token/documentos/:documentoId', { bodyLimit: limiteSubida }, async (req) => {
    if (!Buffer.isBuffer(req.body)) throw Object.assign(new Error('Envíe el archivo como PDF o imagen.'), { statusCode: 415 });
    let nombre = 'documento';
    try { nombre = decodeURIComponent(req.headers['x-nombre-archivo'] ?? 'documento'); } catch { /* nombre por defecto */ }
    const resumen = await subirArchivo(ctx, req.params.token, req.params.documentoId, { contenido: req.body, nombre });
    ctx.worker.despertar();
    return resumen;
  });

  app.delete('/api/expedientes/:token/archivos/:archivoId', async (req) => eliminarArchivo(ctx, req.params.token, req.params.archivoId));

  // ---------------- Panel de administración ----------------

  app.register(async (admin) => {
    admin.addHook('onRequest', async (req, reply) => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!config.adminToken || !igualSeguro(token, config.adminToken)) return reply.code(401).send({ error: 'No autorizado' });
    });

    admin.get('/leads', async (req) => ctx.store.listarLeads({ etapa: req.query.etapa, semaforo: req.query.semaforo }).map((l) => ({
      id: l.id, creado: l.creado, origen: l.origen, etapa: l.etapa, semaforo: l.semaforo, puntuacion: l.puntuacion, nombre: l.nombre,
      telefono: l.telefono, provincia: l.provincia, deuda: l.respuestas.deuda_total, campana: l.atribucion.meta_campaign_name ?? l.atribucion.utm_campaign ?? null,
    })));

    admin.get('/leads/:id', async (req, reply) => {
      const lead = ctx.store.lead(req.params.id);
      if (!lead) return reply.code(404).send({ error: 'No encontrado' });
      const encargos = ctx.store.encargosDeLead(lead.id).map(({ documento_html, otp_hash, ...resto }) => ({
        ...resto, url: `${config.baseUrl}/encargo/${resto.token}`, pagos: ctx.store.pagosDeEncargo(resto.id),
      }));
      const expediente = ctx.store.expedienteDeLead(lead.id);
      return {
        expediente: expediente ? { id: expediente.id, url: urlPortal(ctx, expediente), ...resumenExpediente(ctx, expediente) } : null,
        lead, eventos: ctx.store.eventos(lead.id), citas: ctx.store.citasDeLead(lead.id), encargos,
        tareas: ctx.store.tareasPendientes(lead.id), salida: ctx.store.salida(lead.id), enlaceReserva: `${config.baseUrl}/reservar/${lead.token_reserva}`,
        etapasManuales: ETAPAS_MANUALES,
        etapasBloqueadas: ETAPAS_BLOQUEADAS,
      };
    });

    admin.post('/leads/:id/etapa', async (req, reply) => {
      const lead = ctx.store.lead(req.params.id);
      if (!lead) return reply.code(404).send({ error: 'No encontrado' });
      const { etapa, motivo } = req.body ?? {};
      if (!ETAPAS_MANUALES.includes(etapa) || !ETAPAS.includes(etapa)) return reply.code(400).send({ error: 'Etapa no permitida' });
      if (ETAPAS_BLOQUEADAS.includes(lead.etapa)) return reply.code(400).send({ error: 'El lead tiene una hoja de encargo firmada: su etapa depende de la firma y los pagos.' });
      const cita = ctx.store.citaActiva(lead.id);
      if (etapa === 'no_asistio') alNoAsistir(ctx, lead, cita);
      else if (etapa === 'asistio') alAsistir(ctx, lead, cita);
      else {
        if (['perdido', 'descartado'].includes(etapa)) ctx.store.cancelarTareas(lead.id);
        cambiarEtapa(ctx, lead, etapa, { motivo: motivo ?? null, manual: true });
      }
      ctx.worker.despertar();
      return { ok: true, lead: ctx.store.lead(lead.id) };
    });

    admin.post('/leads/:id/propuesta', async (req) => {
      const b = req.body ?? {};
      const encargo = crearPropuesta(ctx, req.params.id, {
        honorarios: b.honorarios, entrada: b.entrada, numCuotas: b.numCuotas, provisionProcurador: b.provisionProcurador,
      });
      ctx.worker.despertar();
      return { ok: true, encargoId: encargo.id, url: `${config.baseUrl}/encargo/${encargo.token}` };
    });

    admin.get('/metricas', async (req) => {
      const hasta = req.query.hasta ? new Date(req.query.hasta) : reloj();
      const desde = req.query.desde ? new Date(req.query.desde) : new Date(hasta.getTime() - 30 * 86_400_000);
      return calcularMetricas(ctx.store, desde.toISOString(), hasta.toISOString());
    });

    admin.post('/gasto', async (req, reply) => {
      const { mes, origen, importe } = req.body ?? {};
      const centimos = aCentimos(importe);
      if (!/^\d{4}-\d{2}$/.test(mes ?? '') || !origen || centimos == null) return reply.code(400).send({ error: 'Indique mes (AAAA-MM), origen e importe.' });
      ctx.store.guardarGasto(mes, String(origen).slice(0, 40), centimos);
      return { ok: true };
    });

    admin.get('/salida', async () => ctx.store.salida());

    admin.post('/leads/:id/expediente', async (req, reply) => {
      const lead = ctx.store.lead(req.params.id);
      const encargo = lead && ctx.store.encargosDeLead(lead.id).find((e) => e.estado === 'activo');
      if (!encargo) return reply.code(400).send({ error: 'El lead no tiene un encargo activo (firmado y con la entrada cobrada).' });
      const expediente = abrirExpediente(ctx, encargo);
      ctx.worker.despertar();
      return { ok: true, url: urlPortal(ctx, expediente) };
    });

    // ---- Módulo 5 · Preparación del expediente ----
    admin.get('/expedientes/:id/preparacion', async (req) => resumenPreparacion(ctx, expedienteParaPreparar(ctx, req.params.id)));

    admin.put('/expedientes/:id/preparacion', async (req) => guardarDatosPreparacion(ctx, req.params.id, req.body));

    for (const tabla of ['acreedores', 'bienes']) {
      admin.post(`/expedientes/:id/${tabla}`, async (req) => crearPartida(ctx, req.params.id, tabla, req.body));
      admin.patch(`/${tabla}/:id`, async (req) => editarPartida(ctx, tabla, req.params.id, req.body));
      admin.delete(`/${tabla}/:id`, async (req) => {
        borrarPartida(ctx, tabla, req.params.id);
        return { ok: true };
      });
    }

    admin.post('/expedientes/:id/extracciones', async (req) => {
      const extraccion = solicitarExtraccion(ctx, req.params.id, req.body?.archivoId);
      ctx.worker.despertar();
      return extraccion;
    });

    admin.post('/expedientes/:id/listo', async (req) => {
      const datos = marcarListo(ctx, req.params.id, req.body?.listo === true);
      ctx.worker.despertar();
      return datos;
    });

    admin.get('/expedientes/:id/documentos/:tipo', async (req, reply) => {
      const expediente = expedienteParaPreparar(ctx, req.params.id);
      const { contenido, nombre } = await generarDocumento(ctx, expediente, req.params.tipo);
      ctx.store.registrarEvento(expediente.lead_id, 'borrador_generado', { tipo: req.params.tipo });
      return reply
        .type('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
        .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(nombre)}`)
        .header('Cache-Control', 'no-store')
        .send(contenido);
    });

    // ---- Módulo 6 · Seguimiento procesal y plazos ----
    admin.get('/expedientes/:id/seguimiento', async (req) => resumenSeguimiento(ctx, req.params.id));

    admin.put('/expedientes/:id/procedimiento', async (req) => {
      actualizarDatosProcedimiento(ctx, req.params.id, req.body);
      return resumenSeguimiento(ctx, req.params.id);
    });

    admin.post('/expedientes/:id/actuaciones', async (req) => {
      registrarActuacion(ctx, req.params.id, req.body);
      ctx.worker.despertar();
      return resumenSeguimiento(ctx, req.params.id);
    });

    admin.post('/plazos/:id', async (req) => marcarPlazo(ctx, req.params.id, { estado: req.body?.estado, notas: req.body?.notas }));

    admin.get('/plazos', async () => ({
      plazos: agendaPlazos(ctx),
      calendario: `${config.baseUrl}/calendario/plazos.ics?clave=${claveCalendario(ctx)}`,
    }));

    // ---- Módulo 7 · Cierre ----
    admin.get('/expedientes/:id/cierre', async (req) => ({ cierre: resumenCierre(ctx, req.params.id) }));

    admin.post('/expedientes/:id/archivar', async (req) => {
      archivarExpediente(ctx, req.params.id);
      return { cierre: resumenCierre(ctx, req.params.id) };
    });

    admin.post('/expedientes/:id/eliminar-documentos', async (req) => {
      const resultado = await eliminarDocumentosExpediente(ctx, req.params.id);
      return { ...resultado, cierre: resumenCierre(ctx, req.params.id) };
    });

    admin.get('/cierre', async () => ({ metricas: metricasCierre(ctx), testimonios: testimoniosAutorizados(ctx) }));

    admin.post('/documentos/:id/revision', async (req) => {
      const documento = revisarDocumento(ctx, req.params.id, { decision: req.body?.decision, motivo: req.body?.motivo });
      ctx.worker.despertar();
      return { ok: true, documento };
    });

    admin.get('/archivos/:id', async (req, reply) => {
      const archivo = ctx.store.archivo(req.params.id);
      if (!archivo || archivo.eliminado) return reply.code(404).send({ error: 'No encontrado' });
      const contenido = await ctx.almacen.leer(archivo);
      const documento = ctx.store.documento(archivo.documento_id);
      const expediente = ctx.store.expediente(documento.expediente_id);
      ctx.store.registrarEvento(expediente.lead_id, 'archivo_consultado', { archivoId: archivo.id });
      return reply
        .type(archivo.tipo_mime)
        .header('Content-Disposition', `${req.query.ver ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(archivo.nombre)}`)
        .header('Cache-Control', 'no-store')
        .send(contenido);
    });
  }, { prefix: '/admin/api' });

  app.addHook('onClose', async () => {
    await ctx.worker.detener();
    if (!store) ctx.store.cerrar();
  });

  return app;
}
