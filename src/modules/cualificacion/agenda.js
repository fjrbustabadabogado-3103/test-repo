/**
 * Generación de huecos de consulta respetando la zona horaria del despacho (horario de verano incluido).
 */

function partesEnZona(fecha, zona) {
  const partes = new Intl.DateTimeFormat('en-GB', {
    timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(fecha);
  const valor = Object.fromEntries(partes.map((p) => [p.type, p.value]));
  return {
    anio: Number(valor.year), mes: Number(valor.month), dia: Number(valor.day),
    hora: Number(valor.hour), minuto: Number(valor.minute), segundo: Number(valor.second),
    diaSemana: { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[valor.weekday],
  };
}

/** Diferencia en minutos entre la hora local de `zona` y UTC en el instante `fecha`. */
function desfaseMinutos(fecha, zona) {
  const p = partesEnZona(fecha, zona);
  const comoUtc = Date.UTC(p.anio, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
  return Math.round((comoUtc - Math.floor(fecha.getTime() / 1000) * 1000) / 60_000);
}

/** Convierte una fecha y hora locales de `zona` ("2026-11-03", "09:30") al instante UTC correspondiente. */
export function localAUtc(fechaIso, horaMinuto, zona) {
  const [anio, mes, dia] = fechaIso.split('-').map(Number);
  const [hora, minuto] = horaMinuto.split(':').map(Number);
  const supuesto = Date.UTC(anio, mes - 1, dia, hora, minuto);
  let instante = new Date(supuesto - desfaseMinutos(new Date(supuesto), zona) * 60_000);
  // Segunda pasada para los días de cambio de hora.
  instante = new Date(supuesto - desfaseMinutos(instante, zona) * 60_000);
  return instante;
}

function fechaLocalIso(fecha, zona) {
  const p = partesEnZona(fecha, zona);
  return `${p.anio}-${String(p.mes).padStart(2, '0')}-${String(p.dia).padStart(2, '0')}`;
}

function siguienteDia(fechaIso) {
  const [a, m, d] = fechaIso.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + 1)).toISOString().slice(0, 10);
}

function diaSemanaIso(fechaIso) {
  const [a, m, d] = fechaIso.split('-').map(Number);
  const dia = new Date(Date.UTC(a, m - 1, d)).getUTCDay();
  return dia === 0 ? 7 : dia;
}

/**
 * @param {object} agenda config/agenda.json
 * @param {Date} ahora
 * @param {{inicio: string, fin: string}[]} ocupadas citas reservadas que se solapan con la ventana
 * @returns {{inicio: string, fin: string, fecha: string}[]}
 */
export function generarHuecos(agenda, ahora, ocupadas = []) {
  const { zona, duracionMinutos, diasVista, antelacionMinimaHoras, plazasPorHueco = 1 } = agenda;
  const festivos = new Set(agenda.festivos ?? []);
  const limiteInferior = ahora.getTime() + antelacionMinimaHoras * 3_600_000;
  const huecos = [];
  let fecha = fechaLocalIso(ahora, zona);

  for (let i = 0; i < diasVista; i += 1, fecha = siguienteDia(fecha)) {
    if (festivos.has(fecha)) continue;
    const tramos = agenda.horario[String(diaSemanaIso(fecha))] ?? [];
    for (const [desde, hasta] of tramos) {
      const finTramo = localAUtc(fecha, hasta, zona).getTime();
      for (let t = localAUtc(fecha, desde, zona).getTime(); t + duracionMinutos * 60_000 <= finTramo; t += duracionMinutos * 60_000) {
        if (t < limiteInferior) continue;
        const inicio = t;
        const fin = t + duracionMinutos * 60_000;
        const solapes = ocupadas.filter((c) => new Date(c.inicio).getTime() < fin && new Date(c.fin).getTime() > inicio).length;
        if (solapes >= plazasPorHueco) continue;
        huecos.push({ inicio: new Date(inicio).toISOString(), fin: new Date(fin).toISOString(), fecha });
      }
    }
  }
  return huecos;
}

/** Fichero .ics para que el cliente añada la cita a su calendario. */
export function generarIcs({ codigo, inicio, fin, titulo, descripcion, url }) {
  const formato = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const escapar = (texto) => String(texto).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Bustabad Abogados//Captacion LSO//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${codigo}@bustabad-lso`,
    `DTSTAMP:${formato(new Date().toISOString())}`,
    `DTSTART:${formato(inicio)}`,
    `DTEND:${formato(fin)}`,
    `SUMMARY:${escapar(titulo)}`,
    `DESCRIPTION:${escapar(descripcion)}`,
    `URL:${url}`,
    `LOCATION:${escapar(url)}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}
