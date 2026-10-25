import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Normaliza un teléfono a dígitos con prefijo internacional (formato que usa WhatsApp Cloud API). Prefijo por defecto: España. */
export function normalizarTelefono(valor, prefijo = '34') {
  if (!valor) return null;
  let digitos = String(valor).replace(/[^\d+]/g, '');
  if (digitos.startsWith('+')) digitos = digitos.slice(1);
  else if (digitos.startsWith('00')) digitos = digitos.slice(2);
  else if (digitos.length === 9) digitos = prefijo + digitos;
  digitos = digitos.replace(/\D/g, '');
  return digitos.length >= 10 && digitos.length <= 15 ? digitos : null;
}

export function normalizarEmail(valor) {
  if (!valor) return null;
  const email = String(valor).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

/** Interpreta importes escritos de forma libre: "15.000 €", "entre 10.000 y 30.000", "más de 60k". */
export function interpretarImporte(valor) {
  if (valor == null || valor === '') return null;
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  const texto = String(valor).toLowerCase();
  if (/^\s*(no|ninguna?|0)\s*$/.test(texto)) return 0;
  const numeros = [...texto.matchAll(/(\d{1,3}(?:[.\s]\d{3})+|\d+)(?:,\d+)?\s*(k|mil)?/g)].map((m) => {
    const base = Number(m[1].replace(/[.\s]/g, ''));
    return m[2] ? base * 1000 : base;
  });
  if (numeros.length === 0) return null;
  if (numeros.length >= 2) return Math.round((numeros[0] + numeros[1]) / 2);
  if (/menos de|hasta|<\s*\d/.test(texto)) return Math.round(numeros[0] * 0.75);
  return numeros[0];
}

export function interpretarSiNo(valor) {
  if (typeof valor === 'boolean') return valor;
  if (valor == null || valor === '') return null;
  const texto = String(valor).trim().toLowerCase();
  const fin = '(?=$|[\\s,.;:!])';
  if (new RegExp(`^(s[ií]|yes|true|1|acepto)${fin}`).test(texto)) return true;
  if (new RegExp(`^(no|false|0)${fin}`).test(texto)) return false;
  return null;
}

export function interpretarTipoDeudor(valor) {
  const texto = String(valor ?? '').toLowerCase();
  if (/sociedad|empresa|\bs\.?l\.?\b|\bs\.?a\.?\b|mercantil/.test(texto)) return 'sociedad';
  if (/aut[oó]nom/.test(texto)) return 'autonomo';
  return 'particular';
}

export function escaparHtml(valor) {
  return String(valor ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function euros(centimos) {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format((centimos ?? 0) / 100);
}

export function aCentimos(eurosValor) {
  const numero = Number(eurosValor);
  if (!Number.isFinite(numero) || numero < 0) return null;
  return Math.round(numero * 100);
}

export function fechaLarga(iso, zona = 'Europe/Madrid') {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: zona, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}

export function fechaCorta(iso, zona = 'Europe/Madrid') {
  return new Intl.DateTimeFormat('es-ES', { timeZone: zona, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso));
}

/** Sustituye {{variable}} por su valor. Las variables desconocidas quedan vacías. */
export function rellenar(plantilla, variables) {
  return String(plantilla).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, nombre) => (variables[nombre] == null ? '' : String(variables[nombre])));
}

export const sha256 = (texto) => createHash('sha256').update(texto).digest('hex');

export const hmacHex = (secreto, texto) => createHmac('sha256', secreto).update(texto).digest('hex');

export function igualSeguro(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function sumarMinutos(fecha, minutos) {
  return new Date(new Date(fecha).getTime() + minutos * 60_000);
}

export function sumarDias(fecha, dias) {
  return sumarMinutos(fecha, dias * 24 * 60);
}

export function textoCorto(valor, maximo = 200) {
  if (valor == null) return null;
  const texto = String(valor).trim();
  return texto ? texto.slice(0, maximo) : null;
}

const LETRAS_DNI = 'TRWAGMYFPDXBNJZSQVHLCKE';

/** Valida DNI o NIE españoles (letra de control incluida). Devuelve el documento normalizado o null. */
export function validarDniNie(valor) {
  const doc = String(valor ?? '').toUpperCase().replace(/[\s.-]/g, '');
  const m = /^([XYZ]?)(\d{7,8})([A-Z])$/.exec(doc);
  if (!m) return null;
  const [, prefijo, numero, letra] = m;
  if (prefijo && numero.length !== 7) return null;
  if (!prefijo && numero.length !== 8) return null;
  const base = Number(`${prefijo ? 'XYZ'.indexOf(prefijo) : ''}${numero}`);
  return LETRAS_DNI[base % 23] === letra ? doc : null;
}
