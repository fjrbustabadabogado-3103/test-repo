import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localAUtc, generarHuecos, generarIcs } from '../src/modules/cualificacion/agenda.js';
import { calcularPlanPagos, renderizarHojaEncargo } from '../src/modules/contratacion/hoja-encargo.js';
import { firmaStripeValida } from '../src/modules/contratacion/pagos.js';
import { firmaMetaValida } from '../src/modules/captacion/meta.js';
import { hmacHex } from '../src/util.js';
import { loadConfig } from '../src/config.js';

const agenda = {
  zona: 'Europe/Madrid', duracionMinutos: 30, diasVista: 3, antelacionMinimaHoras: 2, plazasPorHueco: 1,
  horario: { 1: [['09:30', '11:00']], 2: [['09:30', '10:30']] }, festivos: ['2026-10-27'], urlVideollamada: '',
};

test('hora local de Madrid a UTC, con horario de verano e invierno', () => {
  assert.equal(localAUtc('2026-07-01', '09:30', 'Europe/Madrid').toISOString(), '2026-07-01T07:30:00.000Z');
  assert.equal(localAUtc('2026-11-02', '09:30', 'Europe/Madrid').toISOString(), '2026-11-02T08:30:00.000Z');
  assert.equal(localAUtc('2026-03-29', '09:30', 'Europe/Madrid').toISOString(), '2026-03-29T07:30:00.000Z');
});

test('huecos: respeta antelación mínima, festivos y citas ocupadas', () => {
  // Lunes 26/10/2026 a las 08:00 de Madrid → primer hueco posible a las 10:00.
  const ahora = new Date('2026-10-26T07:00:00Z');
  const ocupadas = [{ inicio: '2026-10-26T09:30:00Z', fin: '2026-10-26T10:00:00Z' }];
  const huecos = generarHuecos(agenda, ahora, ocupadas);
  assert.deepEqual(huecos.map((h) => h.inicio), ['2026-10-26T09:00:00.000Z']);
  assert.ok(huecos.every((h) => h.fecha !== '2026-10-27'), 'el festivo no tiene huecos');
});

test('fichero .ics válido', () => {
  const ics = generarIcs({ codigo: 'abc', inicio: '2026-10-26T09:00:00.000Z', fin: '2026-10-26T09:30:00.000Z', titulo: 'Consulta, LSO', descripcion: 'x', url: 'https://meet.example/abc' });
  assert.match(ics, /DTSTART:20261026T090000Z/);
  assert.match(ics, /SUMMARY:Consulta\\, LSO/);
});

test('plan de pagos: la suma cuadra y las fechas caen el día de cobro', () => {
  const plan = calcularPlanPagos({ honorariosCent: 250000, entradaCent: 50000, numCuotas: 3, desde: '2026-01-31T10:00:00Z', diaCobro: 31 });
  assert.equal(plan.reduce((s, p) => s + p.importe_cent, 0), 250000);
  assert.deepEqual(plan.map((p) => p.importe_cent), [50000, 66666, 66666, 66668]);
  assert.deepEqual(plan.map((p) => p.vencimiento), ['2026-01-31', '2026-03-31', '2026-04-30', '2026-05-31']);
  const tardio = calcularPlanPagos({ honorariosCent: 2000, entradaCent: 1000, numCuotas: 1, desde: '2026-10-25T10:00:00Z', diaCobro: 5 });
  assert.equal(tardio[1].vencimiento, '2026-12-05', 'la primera cuota no cae a 11 días de la firma');
  assert.throws(() => calcularPlanPagos({ honorariosCent: 1000, entradaCent: 2000, numCuotas: 1, desde: new Date() }));
  assert.throws(() => calcularPlanPagos({ honorariosCent: 3000, entradaCent: 1000, numCuotas: 0, desde: new Date() }));
});

test('la hoja de encargo escapa los datos del cliente e incluye la información obligatoria', () => {
  const config = loadConfig({ NODE_ENV: 'test' });
  const plan = calcularPlanPagos({ honorariosCent: 300000, entradaCent: 60000, numCuotas: 8, desde: '2026-10-26T10:00:00Z' });
  const html = renderizarHojaEncargo({
    despacho: config.despacho,
    lead: { nombre: '<script>alert(1)</script>', telefono: '34600111222', email: 'a@b.es' },
    encargo: { id: '1234abcd-0000', honorarios_cent: 300000, provision_procurador_cent: 30000 },
    plan, fechaEmision: '2026-10-26T10:00:00Z',
  });
  assert.ok(!html.includes('<script>'));
  for (const texto of ['art. 48.4 EGAE', 'art. 510 TRLC', '14 días naturales', 'art. 108.4 TRLGDCU', 'Modelo de formulario de desistimiento', 'no garantiza el resultado']) {
    assert.ok(html.includes(texto), `falta: ${texto}`);
  }
});

test('firmas de webhooks de Meta y Stripe', () => {
  const cuerpo = '{"object":"page"}';
  assert.ok(firmaMetaValida(cuerpo, `sha256=${hmacHex('secreto', cuerpo)}`, 'secreto'));
  assert.ok(!firmaMetaValida(cuerpo, `sha256=${hmacHex('otro', cuerpo)}`, 'secreto'));
  assert.ok(!firmaMetaValida(cuerpo, undefined, 'secreto'));

  const t = 1_800_000_000;
  const cabecera = `t=${t},v1=${hmacHex('whsec', `${t}.${cuerpo}`)}`;
  assert.ok(firmaStripeValida(cuerpo, cabecera, 'whsec', t + 10));
  assert.ok(!firmaStripeValida(cuerpo, cabecera, 'whsec', t + 1000), 'caducada');
  assert.ok(!firmaStripeValida(`${cuerpo} `, cabecera, 'whsec', t), 'cuerpo alterado');
});
