import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluar, exonerablePublico } from '../src/modules/cualificacion/scoring.js';
import { normalizarRespuestas } from '../src/modules/captacion/intake.js';
import { normalizarTelefono, interpretarImporte, validarDniNie, interpretarSiNo } from '../src/util.js';

const reglas = JSON.parse(readFileSync(new URL('../config/cualificacion.json', import.meta.url)));
const base = {
  tipo_deudor: 'particular', deuda_total: 40000, num_acreedores: 4, deuda_hacienda: 0, deuda_seguridad_social: 0,
  deuda_alimentos: false, vivienda_hipotecada: false, antecedentes: false, exoneracion_previa: false, ingresos_mensuales: 1200,
};
const codigos = (resultado) => resultado.motivos.map((m) => m.codigo);

test('crédito público exonerable según el art. 489.1.5º TRLC', () => {
  const limite = reglas.limiteExoneracionPublica;
  assert.equal(exonerablePublico(0, limite), 0);
  assert.equal(exonerablePublico(3000, limite), 3000);
  assert.equal(exonerablePublico(5000, limite), 5000);
  assert.equal(exonerablePublico(10000, limite), 7500);
  assert.equal(exonerablePublico(15000, limite), 10000);
  assert.equal(exonerablePublico(40000, limite), 10000);
});

test('caso típico viable: semáforo verde', () => {
  const r = evaluar(base, reglas);
  assert.equal(r.semaforo, 'verde');
  assert.ok(r.puntuacion >= 90);
});

test('deuda de sociedad: rojo (art. 486, solo persona natural)', () => {
  const r = evaluar({ ...base, tipo_deudor: 'sociedad' }, reglas);
  assert.equal(r.semaforo, 'rojo');
  assert.ok(codigos(r).includes('persona_juridica'));
});

test('deuda por debajo del umbral comercial: rojo', () => {
  assert.equal(evaluar({ ...base, deuda_total: 4000 }, reglas).semaforo, 'rojo');
});

test('antecedentes y exoneración previa: revisión manual (amarillo), nunca descarte automático', () => {
  assert.equal(evaluar({ ...base, antecedentes: true }, reglas).semaforo, 'amarillo');
  assert.equal(evaluar({ ...base, exoneracion_previa: true }, reglas).semaforo, 'amarillo');
});

test('mucha deuda pública no exonerable: amarillo por bajo porcentaje exonerable', () => {
  const r = evaluar({ ...base, deuda_total: 30000, deuda_hacienda: 30000 }, reglas);
  assert.equal(r.estimacion.publicoNoExonerable, 20000);
  assert.equal(r.estimacion.porcentajeExonerable, 33);
  assert.equal(r.semaforo, 'amarillo');
});

test('hipoteca y alimentos se informan sin cambiar el semáforo', () => {
  const r = evaluar({ ...base, vivienda_hipotecada: true, deuda_alimentos: true }, reglas);
  assert.equal(r.semaforo, 'verde');
  assert.ok(codigos(r).includes('vivienda') && codigos(r).includes('alimentos'));
});

test('normaliza respuestas de texto libre (formularios de Meta)', () => {
  const r = normalizarRespuestas({
    tipo_deudor: 'Soy autónomo', deuda_total: 'Entre 15.000 € y 30.000 €', num_acreedores: 'Más de 6',
    deuda_hacienda: 'No', antecedentes: 'No', vivienda_hipotecada: 'Sí', ingresos_mensuales: 'menos de 1.000 €',
  });
  assert.equal(r.tipo_deudor, 'autonomo');
  assert.equal(r.deuda_total, 22500);
  assert.equal(r.num_acreedores, 6);
  assert.equal(r.deuda_hacienda, 0);
  assert.equal(r.antecedentes, false);
  assert.equal(r.vivienda_hipotecada, true);
  assert.equal(r.ingresos_mensuales, 750);
});

test('utilidades: teléfono, importes, sí/no y DNI/NIE', () => {
  assert.equal(normalizarTelefono('600 11 12 22'), '34600111222');
  assert.equal(normalizarTelefono('+34 600111222'), '34600111222');
  assert.equal(normalizarTelefono('0034600111222'), '34600111222');
  assert.equal(normalizarTelefono('123'), null);
  assert.equal(interpretarImporte('60k'), 60000);
  assert.equal(interpretarImporte('15.000,50 €'), 15000);
  assert.equal(interpretarSiNo('Sí, acepto'), true);
  assert.equal(validarDniNie('12345678z'), '12345678Z');
  assert.equal(validarDniNie('X-1234567-L'), 'X1234567L');
  assert.equal(validarDniNie('12345678A'), null);
});
