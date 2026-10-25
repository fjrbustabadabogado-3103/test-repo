import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import JSZip from 'jszip';
import { entornoConArchivos, hastaCliente } from './helpers.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');
const DATOS = {
  domicilio: 'Calle Mayor 1, 2º B, 28013 Madrid', estado_civil: 'soltero', situacion_laboral: 'asalariado', personas_a_cargo: '0',
  tiene_inmuebles: 'no', tiene_vehiculos: 'no', procedimientos_judiciales: 'no', causas: 'Despido en 2024 y gastos médicos.',
};

const SALIDA_IA = {
  acreedores: [
    { nombre: 'Banco Ejemplo, S.A.', nif: 'A00000000', domicilio: 'Paseo de la Castellana 1, Madrid', email: null, tipo: 'financiera', concepto: 'Préstamo personal', importe_euros: 12500.5, vencimiento: '2025-03-01', garantia: 'ninguna', garantia_detalle: null, procedimiento_judicial: null, cita: 'Préstamo personal ... 12.500,50 €' },
    { nombre: 'Agencia Tributaria', nif: null, domicilio: null, email: null, tipo: 'aeat', concepto: 'IRPF 2023', importe_euros: 20000, vencimiento: 'marzo', garantia: 'ninguna', garantia_detalle: null, procedimiento_judicial: null, cita: 'Deuda pendiente 20.000,00' },
  ],
  bienes: [{ tipo: 'cuenta', descripcion: 'Cuenta corriente ES00 ****', ubicacion: null, datos_registrales: null, valor_euros: 150.2, cargas: null, cita: 'Saldo 150,20' }],
  observaciones: 'La segunda página está borrosa.',
};

function iaFalsa(respuesta = { stop_reason: 'end_turn', model: 'claude-opus-5-5', parsed_output: SALIDA_IA }) {
  const llamadas = [];
  return {
    llamadas,
    beta: {
      messages: {
        async parse(params) {
          llamadas.push(params);
          if (respuesta instanceof Error) throw respuesta;
          return respuesta;
        },
      },
    },
  };
}

async function hastaDocumentacionCompleta(e) {
  const { lead } = await hastaCliente(e);
  const exp = e.store.expedienteDeLead(lead.id);
  await e.app.inject({ method: 'POST', url: `/api/expedientes/${exp.token}/datos`, payload: DATOS });
  for (const doc of e.store.documentosDeExpediente(exp.id).filter((d) => d.obligatorio && d.estado !== 'no_aplica')) {
    await e.app.inject({
      method: 'PUT', url: `/api/expedientes/${exp.token}/documentos/${doc.id}`, payload: PDF,
      headers: { 'content-type': 'application/pdf', 'x-nombre-archivo': `${doc.clave}.pdf` },
    });
    await e.admin('POST', `/documentos/${doc.id}/revision`, { decision: 'validar' });
  }
  await e.procesar();
  return { lead, expediente: e.store.expediente(exp.id) };
}

const archivoDe = (e, expediente, clave) => {
  const doc = e.store.documentosDeExpediente(expediente.id).find((d) => d.clave === clave);
  return e.store.archivosDeDocumento(doc.id)[0];
};

test('extracción con IA: llamada al modelo y propuestas pendientes de revisión', async () => {
  const ia = iaFalsa();
  const e = entornoConArchivos({ ia, config: { ia: { activada: true } } });
  const { expediente } = await hastaDocumentacionCompleta(e);
  const archivo = archivoDe(e, expediente, 'cirbe');

  const r = await e.admin('POST', `/expedientes/${expediente.id}/extracciones`, { archivoId: archivo.id });
  assert.equal(r.statusCode, 200, r.body);
  await e.procesar();

  const [llamada] = ia.llamadas;
  assert.equal(llamada.model, 'claude-opus-5-5');
  assert.equal(llamada.fallbacks, 'default');
  assert.ok(llamada.betas.includes('server-side-fallback-2026-07-01'));
  assert.equal(llamada.output_config.effort, 'medium');
  assert.ok(llamada.output_config.format, 'salida estructurada con esquema');
  const [documento] = llamada.messages[0].content;
  assert.equal(documento.type, 'document');
  assert.equal(documento.source.media_type, 'application/pdf');
  assert.ok(Buffer.from(documento.source.data, 'base64').equals(PDF), 'se envía el documento descifrado');
  assert.match(llamada.system, /no instrucciones/);

  const resumen = (await e.admin('GET', `/expedientes/${expediente.id}/preparacion`)).json();
  assert.equal(resumen.acreedores.length, 2);
  const banco = resumen.acreedores.find((a) => a.tipo === 'financiera');
  assert.equal(banco.importe_cent, 1250050);
  assert.equal(banco.vencimiento, '2025-03-01');
  assert.equal(banco.origen, 'ia');
  assert.equal(banco.revisado, false, 'las propuestas nunca entran revisadas');
  assert.equal(banco.archivo_id, archivo.id);
  assert.equal(resumen.acreedores.find((a) => a.tipo === 'aeat').vencimiento, null, 'una fecha mal formada se descarta, no se inventa');
  assert.equal(resumen.bienes[0].valor_mercado_cent, 15020);
  assert.equal(resumen.extracciones[0].estado, 'completada');
  assert.equal(resumen.extracciones[0].resumen.observaciones, 'La segunda página está borrosa.');
  await e.app.close();
});

test('extracción con IA: rechazo del modelo, formato no admitido, errores transitorios y desactivada', async () => {
  const rechazo = iaFalsa({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, parsed_output: null });
  const e = entornoConArchivos({ ia: rechazo, config: { ia: { activada: true } } });
  const { expediente } = await hastaDocumentacionCompleta(e);
  await e.admin('POST', `/expedientes/${expediente.id}/extracciones`, { archivoId: archivoDe(e, expediente, 'dni').id });
  await e.procesar();
  const [x] = e.store.extraccionesDeExpediente(expediente.id);
  assert.equal(x.estado, 'error');
  assert.match(x.error, /a mano/);

  // Error de red: la tarea se reintenta y la extracción sigue pendiente
  const sinRed = iaFalsa(new Anthropic.APIConnectionError({ message: 'sin red' }));
  const e2 = entornoConArchivos({ ia: sinRed, config: { ia: { activada: true } } });
  const { expediente: exp2 } = await hastaDocumentacionCompleta(e2);
  await e2.admin('POST', `/expedientes/${exp2.id}/extracciones`, { archivoId: archivoDe(e2, exp2, 'dni').id });
  await e2.procesar();
  assert.equal(e2.store.extraccionesDeExpediente(exp2.id)[0].estado, 'pendiente');
  for (let i = 0; i < 6; i += 1) {
    e2.avanzar(400);
    await e2.procesar();
  }
  assert.equal(e2.store.extraccionesDeExpediente(exp2.id)[0].estado, 'error', 'tras varios intentos queda como error, no pendiente para siempre');

  // Desactivada
  const e3 = entornoConArchivos();
  const { expediente: exp3 } = await hastaDocumentacionCompleta(e3);
  const desactivada = await e3.admin('POST', `/expedientes/${exp3.id}/extracciones`, { archivoId: archivoDe(e3, exp3, 'dni').id });
  assert.equal(desactivada.statusCode, 400);
  await Promise.all([e.app.close(), e2.app.close(), e3.app.close()]);
});

test('alta manual, validación e indicadores (crédito público, alimentos, garantía real, concurso sin masa)', async () => {
  const e = entornoConArchivos();
  const { expediente } = await hastaDocumentacionCompleta(e);
  const crear = (tabla, cuerpo) => e.admin('POST', `/expedientes/${expediente.id}/${tabla}`, cuerpo);

  assert.equal((await crear('acreedores', { nombre: 'X', email: 'no-es-email' })).statusCode, 400);
  assert.equal((await crear('acreedores', { nombre: 'X', vencimiento: '01/02/2025' })).statusCode, 400);
  assert.equal((await crear('acreedores', { nombre: 'X', tipo: 'inventado' })).statusCode, 400);

  await crear('acreedores', { nombre: 'Agencia Tributaria', tipo: 'aeat', importe: 20000 });
  await crear('acreedores', { nombre: 'TGSS', tipo: 'seguridad_social', importe: 3000 });
  await crear('acreedores', { nombre: 'Ex cónyuge', tipo: 'alimentos', importe: 2000 });
  await crear('acreedores', { nombre: 'Banco', tipo: 'financiera', importe: 50000, garantia: 'hipotecaria' });
  await crear('acreedores', { nombre: 'Financiera', tipo: 'financiera', importe: 10000 });
  const cuenta = (await crear('bienes', { tipo: 'cuenta', descripcion: 'Cuenta nómina', valor_mercado: 300 })).json();

  let ind = (await e.admin('GET', `/expedientes/${expediente.id}/preparacion`)).json().indicadores;
  assert.equal(ind.pasivoCent, 8500000);
  assert.equal(ind.publicoNoExonerableCent, 1000000, 'AEAT: 20.000 € de los que solo 10.000 € son exonerables (art. 489.1.5º)');
  assert.equal(ind.alimentosCent, 200000);
  assert.equal(ind.garantiaRealCent, 5000000);
  assert.equal(ind.exonerableEstimadoCent, 8500000 - 1000000 - 200000 - 5000000);
  assert.equal(ind.pendientesEmbargabilidad, 1);
  assert.deepEqual(ind.indiciosSinMasa, []);

  await e.admin('PATCH', `/bienes/${cuenta.id}`, { embargable: false });
  ind = (await e.admin('GET', `/expedientes/${expediente.id}/preparacion`)).json().indicadores;
  assert.equal(ind.indiciosSinMasa[0].letra, 'a', 'sin bienes embargables (art. 37 bis.a)');
  await e.app.close();
});

test('comprobaciones antes de presentar, marcar listo, bloqueo de edición y reapertura', async () => {
  const e = entornoConArchivos();
  const { expediente } = await hastaDocumentacionCompleta(e);
  const base = `/expedientes/${expediente.id}`;

  const prep = (await e.admin('GET', `${base}/preparacion`)).json();
  assert.equal(prep.preparacion.tribunal, 'Sección de lo Mercantil del Tribunal de Instancia de Madrid', 'órgano según la provincia (art. 87 LOPJ)');
  assert.equal(prep.preparacion.causas, DATOS.causas, 'las causas que escribió el cliente se precargan');

  const intento = await e.admin('POST', `${base}/listo`, { listo: true });
  assert.equal(intento.statusCode, 400);
  const textos = intento.json().faltas.map((f) => f.texto).join(' | ');
  assert.match(textos, /No hay acreedores/);
  assert.match(textos, /historia económica/);
  assert.match(textos, /Elija la vía/);

  const acreedor = (await e.admin('POST', `${base}/acreedores`, { nombre: 'Banco Ejemplo', tipo: 'financiera', importe: 9000 })).json();
  let faltas = (await e.admin('GET', `${base}/preparacion`)).json().faltas.map((f) => f.texto).join(' | ');
  assert.match(faltas, /falta domicilio, vencimiento/);
  assert.match(faltas, /sin revisar/);

  await e.admin('PATCH', `/acreedores/${acreedor.id}`, { domicilio: 'Calle Banco 1, Madrid', vencimiento: '2025-01-10', revisado: true });
  const bien = (await e.admin('POST', `${base}/bienes`, { tipo: 'cuenta', descripcion: 'Cuenta nómina', valor_mercado: 100 })).json();
  await e.admin('PATCH', `/bienes/${bien.id}`, { embargable: false, revisado: true });
  const guardado = await e.admin('PUT', `${base}/preparacion`, {
    historia: 'Trabajó como administrativa hasta 2024.', ruta: 'sin_masa', procurador: 'Dña. Procuradora Ejemplo', poder: 'apud acta electrónico',
  });
  assert.equal(guardado.statusCode, 200, guardado.body);
  faltas = (await e.admin('GET', `${base}/preparacion`)).json().faltas;
  assert.deepEqual(faltas, []);

  const listo = await e.admin('POST', `${base}/listo`, { listo: true });
  assert.equal(listo.statusCode, 200, listo.body);
  assert.ok(listo.json().listo);
  assert.equal((await e.admin('PATCH', `/acreedores/${acreedor.id}`, { importe: 1 })).statusCode, 400, 'no se edita un expediente listo');
  assert.equal((await e.admin('POST', `${base}/listo`, { listo: false })).statusCode, 200);
  assert.equal((await e.admin('PATCH', `/acreedores/${acreedor.id}`, { importe: 9100 })).statusCode, 200);
  await e.app.close();
});

test('borradores en Word con los datos del expediente', async () => {
  const e = entornoConArchivos();
  const { expediente } = await hastaDocumentacionCompleta(e);
  const base = `/expedientes/${expediente.id}`;
  await e.admin('POST', `${base}/acreedores`, { nombre: 'Banco Ejemplo', tipo: 'financiera', importe: 9000, domicilio: 'Calle Banco 1', vencimiento: '2025-01-10' });
  await e.admin('POST', `${base}/bienes`, { tipo: 'cuenta', descripcion: 'Cuenta nómina', valor_mercado: 100 });
  await e.admin('PUT', `${base}/preparacion`, { historia: 'Trabajó como administrativa hasta 2024.', ruta: 'sin_masa', procurador: 'Dña. Procuradora Ejemplo' });

  const textoDe = async (tipo) => {
    const r = await e.admin('GET', `${base}/documentos/${tipo}`);
    assert.equal(r.statusCode, 200, `${tipo}: ${r.body}`);
    assert.match(r.headers['content-type'], /wordprocessingml/);
    const zip = await JSZip.loadAsync(r.rawPayload);
    return (await zip.file('word/document.xml').async('string')).replace(/<[^>]+>/g, ' ');
  };

  const memoria = await textoDe('memoria');
  assert.match(memoria, /María López Fernández/);
  assert.match(memoria, /12345678Z/);
  assert.match(memoria, /Despido en 2024/);
  assert.match(memoria, /BORRADOR/);
  assert.match(await textoDe('acreedores'), /Banco Ejemplo/);
  assert.match(await textoDe('inventario'), /Cuenta nómina/);
  const solicitud = await textoDe('solicitud');
  assert.match(solicitud, /SECCIÓN DE LO MERCANTIL DEL TRIBUNAL DE INSTANCIA DE MADRID/);
  assert.match(solicitud, /art\. 37 bis TRLC/);
  assert.match(solicitud, /modelo oficial/);
  assert.equal((await e.admin('GET', `${base}/documentos/otro`)).statusCode, 404);
  assert.ok(e.store.eventos(expediente.lead_id).some((ev) => ev.tipo === 'borrador_generado'));
  await e.app.close();
});

test('las rutas de preparación exigen token y la página carga', async () => {
  const e = entornoConArchivos();
  const { expediente } = await hastaDocumentacionCompleta(e);
  assert.equal((await e.app.inject({ url: `/admin/api/expedientes/${expediente.id}/preparacion` })).statusCode, 401);
  assert.equal((await e.app.inject({ url: `/admin/api/expedientes/${expediente.id}/documentos/memoria` })).statusCode, 401);
  assert.equal((await e.admin('GET', '/expedientes/no-existe/preparacion')).statusCode, 404);
  const pagina = await e.app.inject({ url: `/admin/expediente/${expediente.id}` });
  assert.equal(pagina.statusCode, 200);
  assert.equal((await e.app.inject({ url: '/static/admin-expediente.js' })).statusCode, 200);
  await e.app.close();
});
