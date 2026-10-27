/**
 * Calendario procesal y cómputo de plazos.
 *
 * Normas aplicadas (comprobadas en el BOE consolidado):
 *  - art. 130.2 LEC: inhábiles los sábados y domingos, del 24 de diciembre al 6 de enero (ambos inclusive), los días de fiesta
 *    nacional, los festivos laborales de la comunidad autónoma o localidad, y todos los días de agosto.
 *  - art. 133 LEC: el plazo corre desde el día siguiente al acto de comunicación y se cuenta el día del vencimiento; un plazo que
 *    empieza al terminar otro corre desde el día siguiente al vencimiento de este; se excluyen los inhábiles; los meses se cuentan
 *    de fecha a fecha (si no hay día equivalente, el último del mes); si concluye en inhábil, se prorroga al siguiente hábil.
 *    En actuaciones urgentes (art. 131.2) agosto no es inhábil y solo se excluyen sábados, domingos y festivos.
 *  - art. 135.5 LEC: los escritos sujetos a plazo pueden presentarse hasta las 15:00 del día hábil siguiente al vencimiento.
 *  - art. 45.1 RD 2001/1983: fiestas nacionales no sustituibles por las comunidades autónomas (letras a, b y c).
 *
 * Los festivos autonómicos y locales cambian cada año: los carga el despacho en config/calendario.json y en cada procedimiento.
 * Si faltan para algún año que cruza el plazo, el resultado lo advierte para que el letrado verifique el vencimiento.
 */

/** Domingo de Pascua (algoritmo gregoriano anónimo). Devuelve 'AAAA-MM-DD'. */
export function domingoDePascua(anio) {
  const a = anio % 19;
  const b = Math.floor(anio / 100);
  const c = anio % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return isoDe(anio, mes, dia);
}

function isoDe(anio, mes, dia) {
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

function aFecha(iso) {
  const [a, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d));
}

export function sumarDiasIso(iso, dias) {
  const fecha = aFecha(iso);
  fecha.setUTCDate(fecha.getUTCDate() + dias);
  return fecha.toISOString().slice(0, 10);
}

/** Fiestas nacionales no sustituibles (art. 45.1.a, b y c RD 2001/1983), incluido el Viernes Santo. */
export function fiestasNacionales(anio) {
  const fijas = ['01-01', '05-01', '08-15', '10-12', '11-01', '12-06', '12-08', '12-25'].map((md) => `${anio}-${md}`);
  return new Set([...fijas, sumarDiasIso(domingoDePascua(anio), -2)]);
}

/**
 * @param {string} iso fecha AAAA-MM-DD
 * @param {{ autonomicos?: Record<string, string[] | null>, locales?: string[], urgente?: boolean }} calendario
 */
export function esInhabil(iso, { autonomicos = {}, locales = [], urgente = false } = {}) {
  const fecha = aFecha(iso);
  const diaSemana = fecha.getUTCDay();
  if (diaSemana === 0 || diaSemana === 6) return true;
  const anio = fecha.getUTCFullYear();
  if (fiestasNacionales(anio).has(iso)) return true;
  if ((autonomicos[String(anio)] ?? []).includes(iso)) return true;
  if (locales.includes(iso)) return true;
  if (urgente) return false;
  const mesDia = iso.slice(5);
  if (iso.slice(5, 7) === '08') return true;
  if (mesDia >= '12-24' || mesDia <= '01-06') return true;
  return false;
}

export function siguienteHabil(iso, calendario) {
  let dia = iso;
  while (esInhabil(dia, calendario)) dia = sumarDiasIso(dia, 1);
  return dia;
}

/**
 * Calcula el vencimiento de un plazo procesal.
 * @param {{ diesAQuo: string, cantidad: number, unidad: 'habiles'|'meses'|'naturales', urgente?: boolean,
 *           autonomicos?: Record<string, string[]|null>, locales?: string[], ccaa?: string }} p
 *   diesAQuo: fecha del acto de comunicación o, en un plazo encadenado, del vencimiento del plazo anterior.
 * @returns {{ inicio: string, vence: string, limitePresentacion: string, avisos: string[] }}
 */
export function calcularPlazo({ diesAQuo, cantidad, unidad, urgente = false, autonomicos = {}, locales = [], ccaa = null }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(diesAQuo ?? '')) throw new Error('Fecha inicial no válida.');
  if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 366) throw new Error('Cantidad no válida.');
  const calendario = { autonomicos, locales, urgente };
  let inicio = sumarDiasIso(diesAQuo, 1);
  let vence;

  if (unidad === 'habiles') {
    let contados = 0;
    let dia = diesAQuo;
    inicio = null;
    while (contados < cantidad) {
      dia = sumarDiasIso(dia, 1);
      if (esInhabil(dia, calendario)) continue;
      contados += 1;
      inicio ??= dia;
    }
    vence = dia;
  } else if (unidad === 'meses') {
    const base = aFecha(diesAQuo);
    const objetivoMes = base.getUTCMonth() + cantidad;
    const ultimo = new Date(Date.UTC(base.getUTCFullYear(), objetivoMes + 1, 0)).getUTCDate();
    vence = new Date(Date.UTC(base.getUTCFullYear(), objetivoMes, Math.min(base.getUTCDate(), ultimo))).toISOString().slice(0, 10);
    vence = siguienteHabil(vence, calendario);
  } else if (unidad === 'naturales') {
    vence = sumarDiasIso(diesAQuo, cantidad);
  } else {
    throw new Error('Unidad no válida.');
  }

  const avisos = [];
  const anios = new Set();
  for (let dia = diesAQuo; dia <= sumarDiasIso(vence, 10); dia = sumarDiasIso(dia, 1)) anios.add(dia.slice(0, 4));
  const faltan = [...anios].filter((a) => autonomicos[a] == null);
  if (faltan.length) avisos.push(`Faltan los festivos autonómicos${ccaa ? ` de ${ccaa}` : ''} de ${faltan.join(', ')}: verifique el vencimiento.`);
  if (locales.length === 0) avisos.push('No se han indicado los festivos locales de la sede del juzgado: verifique el vencimiento.');
  if (unidad === 'naturales') avisos.push('Plazo en días naturales: compruebe que la norma no lo fija en días hábiles.');

  return { inicio, vence, limitePresentacion: siguienteHabil(sumarDiasIso(vence, 1), calendario), avisos };
}

/** Días hábiles que quedan desde `hoy` (excluido) hasta `vence` (incluido). 0 = vence hoy; negativo = vencido. */
export function diasHabilesRestantes(hoy, vence, calendario) {
  if (vence === hoy) return 0;
  if (vence < hoy) {
    let n = 0;
    for (let dia = vence; dia < hoy; dia = sumarDiasIso(dia, 1)) if (!esInhabil(sumarDiasIso(dia, 1), calendario)) n -= 1;
    return Math.min(-1, n);
  }
  let n = 0;
  for (let dia = hoy; dia < vence; dia = sumarDiasIso(dia, 1)) if (!esInhabil(sumarDiasIso(dia, 1), calendario)) n += 1;
  return n;
}
