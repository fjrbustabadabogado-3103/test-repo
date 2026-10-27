import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearEntorno, LEAD_VERDE } from './helpers.js';
import { hmacHex } from '../src/util.js';

const plantillasEnviadas = (store, leadId) => store.salida(leadId).map((s) => s.plantilla);

async function crearLead(entorno, datos = LEAD_VERDE) {
  const respuesta = await entorno.app.inject({ method: 'POST', url: '/api/leads', payload: datos });
  await entorno.procesar();
  return respuesta;
}

test('flujo completo: lead → cita → consulta → hoja de encargo → firma → entrada → cuotas', async () => {
  const e = crearEntorno();
  const alta = await crearLead(e);
  assert.equal(alta.statusCode, 201);
  const { reserva } = alta.json();
  assert.match(reserva, /^\/reservar\//);

  const [lead] = e.store.listarLeads();
  assert.equal(lead.semaforo, 'verde');
  assert.equal(lead.etapa, 'cualificado');
  assert.equal(lead.telefono, '34600111222');
  assert.equal(lead.atribucion.utm_campaign, 'lso-madrid');
  assert.ok(lead.primer_contacto, 'respuesta automática inmediata');
  assert.ok(plantillasEnviadas(e.store, lead.id).includes('bienvenida'));
  assert.ok(plantillasEnviadas(e.store, lead.id).includes('aviso_equipo_lead') === false, 'sin equipo configurado el aviso solo va al log');

  // Reserva de cita
  const token = reserva.split('/').pop();
  const huecos = (await e.app.inject({ url: `/api/reservas/${token}` })).json().huecos;
  assert.ok(huecos.length > 0);
  const reservada = await e.app.inject({ method: 'POST', url: `/api/reservas/${token}`, payload: { inicio: huecos[3].inicio } });
  assert.equal(reservada.statusCode, 200, reservada.body);
  await e.procesar();
  assert.equal(e.store.lead(lead.id).etapa, 'agendado');
  const pendientes = e.store.tareasPendientes(lead.id).map((t) => t.datos.plantilla);
  assert.ok(!pendientes.includes('seguimiento_1'), 'los seguimientos se cancelan al reservar');
  assert.ok(pendientes.includes('recordatorio_1h'));
  assert.ok(plantillasEnviadas(e.store, lead.id).includes('cita_confirmada'));

  // El mismo hueco ya no está disponible
  const repetida = await e.app.inject({ method: 'POST', url: `/api/reservas/${token}`, payload: { inicio: huecos[3].inicio } });
  assert.equal(repetida.statusCode, 409);

  const ics = await e.app.inject({ url: reservada.json().ics });
  assert.equal(ics.statusCode, 200);
  assert.match(ics.body, /BEGIN:VCALENDAR/);

  // Recordatorio 1 h antes
  e.fijar(new Date(new Date(huecos[3].inicio).getTime() - 59 * 60_000).toISOString());
  await e.procesar();
  assert.ok(plantillasEnviadas(e.store, lead.id).includes('recordatorio_1h'));

  // El abogado marca la consulta como realizada y envía la propuesta
  assert.equal((await e.admin('POST', `/leads/${lead.id}/etapa`, { etapa: 'asistio' })).statusCode, 200);
  const propuesta = await e.admin('POST', `/leads/${lead.id}/propuesta`, { honorarios: 2900, entrada: 500, numCuotas: 8, provisionProcurador: 250 });
  assert.equal(propuesta.statusCode, 200, propuesta.body);
  await e.procesar();
  assert.equal(e.store.lead(lead.id).etapa, 'propuesta');
  assert.ok(plantillasEnviadas(e.store, lead.id).includes('propuesta_enviada'));

  const tokenEncargo = propuesta.json().url.split('/').pop();
  const pagina = await e.app.inject({ url: `/encargo/${tokenEncargo}` });
  assert.equal(pagina.statusCode, 200);
  assert.match(pagina.body, /pedido con obligación de pago/i);
  const encargo = e.store.encargoPorToken(tokenEncargo);

  // Firma con código de un solo uso
  assert.equal((await e.app.inject({ method: 'POST', url: `/api/encargos/${tokenEncargo}/codigo`, payload: {} })).statusCode, 200);
  const mensajeCodigo = e.store.salida(lead.id).find((s) => s.plantilla === 'codigo_firma').contenido;
  const codigo = mensajeCodigo.match(/\b(\d{6})\b/)[1];
  const firma = (extra) => e.app.inject({
    method: 'POST', url: `/api/encargos/${tokenEncargo}/firmar`,
    payload: { nombre: 'María López Fernández', dni: '12345678Z', aceptaHoja: true, aceptaPago: true, inicioInmediato: true, documentoSha256: encargo.documento_sha256, codigo, ...extra },
  });
  assert.equal((await firma({ codigo: codigo === '000000' ? '111111' : '000000' })).statusCode, 400, 'código incorrecto');
  assert.equal((await firma({ aceptaPago: false })).statusCode, 400, 'sin confirmar la obligación de pago (art. 98.2 TRLGDCU)');
  assert.equal((await firma({ dni: '12345678A' })).statusCode, 400, 'DNI con letra incorrecta');
  const firmada = await firma();
  assert.equal(firmada.statusCode, 200, firmada.body);
  const { urlPago } = firmada.json();
  assert.match(urlPago, /\/pago-simulado\//);

  const tras = e.store.encargo(encargo.id);
  assert.equal(tras.estado, 'firmado');
  assert.equal(tras.evidencia_firma.dni, '12345678Z');
  assert.equal(tras.evidencia_firma.documentoSha256, encargo.documento_sha256);
  assert.equal(tras.evidencia_firma.solicitaInicioInmediato, true);
  assert.ok(e.store.salida(lead.id).some((s) => s.plantilla === 'documento'), 'confirmación en soporte duradero (art. 98.7)');
  assert.equal((await firma()).statusCode, 400, 'no se puede firmar dos veces');

  // Pago de la entrada
  const pagoEntrada = await e.app.inject({ url: new URL(urlPago).pathname });
  assert.equal(pagoEntrada.statusCode, 302);
  await e.procesar();
  assert.equal(e.store.lead(lead.id).etapa, 'cliente');
  assert.equal(e.store.encargo(encargo.id).estado, 'activo');
  const pagos = e.store.pagosDeEncargo(encargo.id);
  assert.equal(pagos.length, 9);
  assert.equal(pagos.reduce((s, p) => s + p.importe_cent, 0), 290000);
  assert.ok(plantillasEnviadas(e.store, lead.id).includes('bienvenida_cliente'));

  // Cobro automático de la primera cuota en su vencimiento
  const primera = pagos.find((p) => p.tipo === 'cuota' && p.numero === 1);
  e.fijar(`${primera.vencimiento}T12:00:00Z`);
  await e.procesar();
  assert.equal(e.store.pago(primera.id).estado, 'pagado');

  const retroceso = await e.admin('POST', `/leads/${lead.id}/etapa`, { etapa: 'nuevo' });
  assert.equal(retroceso.statusCode, 400, 'un cliente no vuelve a etapas comerciales a mano');

  // Métricas del embudo
  e.avanzar(1);
  const metricas = (await e.admin('GET', `/metricas?desde=2026-10-01T00:00:00Z&hasta=${encodeURIComponent(e.reloj().toISOString())}`)).json();
  assert.equal(metricas.leads, 1);
  assert.equal(metricas.embudo.cliente, 1);
  assert.equal(metricas.tasas.cierreSobreConsultas, 100);
  assert.equal(metricas.economia.cobradoCent, 50000 + primera.importe_cent);

  await e.app.close();
});

test('desistimiento dentro de 14 días: cancela cobros pendientes', async () => {
  const e = crearEntorno();
  await crearLead(e);
  const [lead] = e.store.listarLeads();
  const { url } = (await e.admin('POST', `/leads/${lead.id}/propuesta`, { honorarios: 1200, entrada: 300, numCuotas: 3 })).json();
  const token = url.split('/').pop();
  await e.app.inject({ method: 'POST', url: `/api/encargos/${token}/codigo`, payload: {} });
  const codigo = e.store.salida(lead.id).find((s) => s.plantilla === 'codigo_firma').contenido.match(/\b(\d{6})\b/)[1];
  const encargo = e.store.encargoPorToken(token);
  const { urlPago } = (await e.app.inject({
    method: 'POST', url: `/api/encargos/${token}/firmar`,
    payload: { nombre: 'María López Fernández', dni: '12345678Z', aceptaHoja: true, aceptaPago: true, documentoSha256: encargo.documento_sha256, codigo },
  })).json();
  await e.app.inject({ url: new URL(urlPago).pathname });
  await e.procesar();
  assert.equal(e.store.encargo(encargo.id).inicio_inmediato, 0, 'sin solicitud expresa el servicio empieza tras el plazo');

  e.avanzar(60 * 24 * 10);
  const sinConfirmar = await e.app.inject({ method: 'POST', url: `/api/encargos/${token}/desistir`, payload: {} });
  assert.equal(sinConfirmar.statusCode, 400);
  const desistido = await e.app.inject({ method: 'POST', url: `/api/encargos/${token}/desistir`, payload: { confirmo: true } });
  assert.equal(desistido.statusCode, 200, desistido.body);
  assert.equal(e.store.lead(lead.id).etapa, 'desistido');
  assert.ok(!e.store.tareasPendientes(lead.id).some((t) => t.tipo === 'cobrar_cuota'));
  await e.app.close();
});

test('desistimiento fuera de plazo se rechaza', async () => {
  const e = crearEntorno();
  await crearLead(e);
  const [lead] = e.store.listarLeads();
  const { url } = (await e.admin('POST', `/leads/${lead.id}/propuesta`, { honorarios: 1000, entrada: 1000, numCuotas: 0 })).json();
  const token = url.split('/').pop();
  await e.app.inject({ method: 'POST', url: `/api/encargos/${token}/codigo`, payload: {} });
  const codigo = e.store.salida(lead.id).find((s) => s.plantilla === 'codigo_firma').contenido.match(/\b(\d{6})\b/)[1];
  const encargo = e.store.encargoPorToken(token);
  await e.app.inject({
    method: 'POST', url: `/api/encargos/${token}/firmar`,
    payload: { nombre: 'María López Fernández', dni: '12345678Z', aceptaHoja: true, aceptaPago: true, documentoSha256: encargo.documento_sha256, codigo },
  });
  e.avanzar(60 * 24 * 15);
  const tarde = await e.app.inject({ method: 'POST', url: `/api/encargos/${token}/desistir`, payload: { confirmo: true } });
  assert.equal(tarde.statusCode, 400);
  await e.app.close();
});

test('seguimientos: solo con consentimiento, y se detienen al reservar o al pedir la baja', async () => {
  const e = crearEntorno();
  await crearLead(e, { ...LEAD_VERDE, acepta_comunicaciones: false });
  await crearLead(e, { ...LEAD_VERDE, telefono: '600999888', email: 'otro@example.com', nombre: 'Luis Pérez' });
  const sinConsentimiento = e.store.listarLeads().find((l) => l.nombre.startsWith('María'));
  const conConsentimiento = e.store.listarLeads().find((l) => l.nombre.startsWith('Luis'));

  e.avanzar(181);
  await e.procesar();
  assert.ok(!plantillasEnviadas(e.store, sinConsentimiento.id).includes('seguimiento_1'), 'art. 21 LSSI');
  assert.ok(plantillasEnviadas(e.store, conConsentimiento.id).includes('seguimiento_1'));

  // Responde BAJA por WhatsApp
  const e2 = crearEntorno({ env: { META_APP_SECRET: 'secreto-app' } });
  await crearLead(e2);
  const [lead] = e2.store.listarLeads();
  const cuerpo = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ from: '34600111222', type: 'text', text: { body: 'BAJA' } }] } }] }] });
  const respuesta = await e2.app.inject({
    method: 'POST', url: '/webhooks/meta', payload: cuerpo,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${hmacHex('secreto-app', cuerpo)}` },
  });
  assert.equal(respuesta.statusCode, 200);
  assert.equal(e2.store.lead(lead.id).baja, true);
  e2.avanzar(60 * 24 * 4);
  await e2.procesar();
  assert.ok(!plantillasEnviadas(e2.store, lead.id).some((p) => p.startsWith('seguimiento')));
  await e.app.close();
  await e2.app.close();
});

test('sin reserva en 7 días el lead pasa a perdido automáticamente', async () => {
  const e = crearEntorno();
  await crearLead(e);
  const [lead] = e.store.listarLeads();
  e.avanzar(60 * 24 * 7 + 1);
  await e.procesar();
  assert.equal(e.store.lead(lead.id).etapa, 'perdido');
  await e.app.close();
});

test('lead rojo: mensaje neutro, sin enlace de reserva, aviso al equipo', async () => {
  const e = crearEntorno();
  const respuesta = await crearLead(e, { ...LEAD_VERDE, tipo_deudor: 'sociedad' });
  assert.equal(respuesta.statusCode, 201);
  assert.equal(respuesta.json().reserva, null);
  const [lead] = e.store.listarLeads();
  assert.equal(lead.semaforo, 'rojo');
  assert.deepEqual(plantillasEnviadas(e.store, lead.id), ['revision_manual']);
  await e.app.close();
});

test('validación y deduplicación del formulario web', async () => {
  const e = crearEntorno();
  const sinPrivacidad = await e.app.inject({ method: 'POST', url: '/api/leads', payload: { ...LEAD_VERDE, acepta_privacidad: false } });
  assert.equal(sinPrivacidad.statusCode, 400);
  const sinContacto = await e.app.inject({ method: 'POST', url: '/api/leads', payload: { ...LEAD_VERDE, telefono: '', email: '' } });
  assert.equal(sinContacto.statusCode, 400);
  assert.equal((await crearLead(e)).statusCode, 201);
  assert.equal((await crearLead(e)).statusCode, 200, 'el duplicado no crea otro lead');
  assert.equal(e.store.listarLeads().length, 1);
  await e.app.close();
});

test('lead desde formulario instantáneo de Meta: webhook firmado → descarga → alta y evento de conversión', async () => {
  const llamadas = [];
  const fetchImpl = async (url, opciones = {}) => {
    llamadas.push({ url: String(url), opciones });
    if (String(url).includes('/LEAD123')) {
      return new Response(JSON.stringify({
        id: 'LEAD123', platform: 'ig', campaign_name: 'LSO Nacional', ad_name: 'Video 1',
        field_data: [
          { name: 'full_name', values: ['Ana Ruiz Gómez'] }, { name: 'phone_number', values: ['+34611222333'] },
          { name: 'email', values: ['ana@example.com'] }, { name: 'deuda_total', values: ['Entre 30.000 y 60.000 €'] },
          { name: 'numero_acreedores', values: ['4'] }, { name: 'tipo_deudor', values: ['Particular'] },
          { name: 'acepta_comunicaciones', values: ['Sí'] },
        ],
      }), { status: 200 });
    }
    if (String(url).endsWith('/DATASET1/events')) return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const e = crearEntorno({ fetchImpl, env: { META_APP_SECRET: 'secreto-app', META_ACCESS_TOKEN: 'tok', META_DATASET_ID: 'DATASET1', META_VERIFY_TOKEN: 'verifica' } });

  const verificacion = await e.app.inject({ url: '/webhooks/meta?hub.mode=subscribe&hub.verify_token=verifica&hub.challenge=42' });
  assert.equal(verificacion.body, '42');
  assert.equal((await e.app.inject({ url: '/webhooks/meta?hub.mode=subscribe&hub.verify_token=mal&hub.challenge=42' })).statusCode, 403);

  const cuerpo = JSON.stringify({ object: 'page', entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: 'LEAD123', form_id: 'F1' } }] }] });
  const sinFirma = await e.app.inject({ method: 'POST', url: '/webhooks/meta', payload: cuerpo, headers: { 'content-type': 'application/json' } });
  assert.equal(sinFirma.statusCode, 401);
  const firmado = await e.app.inject({
    method: 'POST', url: '/webhooks/meta', payload: cuerpo,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${hmacHex('secreto-app', cuerpo)}` },
  });
  assert.equal(firmado.statusCode, 200);
  await e.procesar();

  const [lead] = e.store.listarLeads();
  assert.equal(lead.origen, 'instagram');
  assert.equal(lead.nombre, 'Ana Ruiz Gómez');
  assert.equal(lead.respuestas.deuda_total, 45000);
  assert.equal(lead.atribucion.meta_lead_id, 'LEAD123');
  assert.equal(lead.consentimiento_comunicaciones, true);
  const evento = llamadas.find((l) => l.url.endsWith('/DATASET1/events'));
  assert.ok(evento, 'se envía el evento de etapa a la API de Conversiones');
  const datos = JSON.parse(evento.opciones.body).data[0];
  assert.equal(datos.event_name, 'lead_cualificado');
  assert.equal(datos.action_source, 'system_generated');
  assert.equal(datos.user_data.lead_id, 'LEAD123');
  assert.equal(datos.custom_data.event_source, 'crm');
  await e.app.close();
});

test('el panel exige token', async () => {
  const e = crearEntorno();
  assert.equal((await e.app.inject({ url: '/admin/api/leads' })).statusCode, 401);
  assert.equal((await e.app.inject({ url: '/admin/api/leads', headers: { authorization: 'Bearer malo' } })).statusCode, 401);
  assert.equal((await e.admin('GET', '/leads')).statusCode, 200);
  await e.app.close();
});

test('páginas públicas responden con cabeceras de seguridad', async () => {
  const e = crearEntorno();
  for (const url of ['/', '/privacidad', '/admin', '/static/estilos.css', '/static/landing.js']) {
    const r = await e.app.inject({ url });
    assert.equal(r.statusCode, 200, url);
    assert.ok(r.headers['content-security-policy'], url);
  }
  assert.equal((await e.app.inject({ url: '/static/../config/despacho.json' })).statusCode, 404);
  assert.equal((await e.app.inject({ url: '/reservar/no-existe' })).statusCode, 404);
  const landing = await e.app.inject({ url: '/' });
  assert.ok(!landing.body.includes('{{'), 'placeholders rellenados');
  await e.app.close();
});
