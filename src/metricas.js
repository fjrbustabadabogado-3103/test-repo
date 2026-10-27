const PASOS = ['cualificado', 'agendado', 'asistio', 'propuesta', 'firmado', 'cliente'];

function mediana(valores) {
  if (valores.length === 0) return null;
  const ordenados = [...valores].sort((a, b) => a - b);
  const mitad = Math.floor(ordenados.length / 2);
  return ordenados.length % 2 ? ordenados[mitad] : (ordenados[mitad - 1] + ordenados[mitad]) / 2;
}

const porcentaje = (parte, total) => (total ? Math.round((parte / total) * 1000) / 10 : null);

/** Embudo de los leads creados entre `desde` y `hasta` (ISO), con coste por lead y por cliente si hay gasto registrado. */
export function calcularMetricas(store, desde, hasta) {
  const leads = store.leadsCreadosEntre(desde, hasta);
  const alcanzadas = Object.fromEntries(PASOS.map((p) => [p, 0]));
  const porOrigen = {};
  const porCampana = {};
  const semaforos = { verde: 0, amarillo: 0, rojo: 0 };
  const minutosPrimerContacto = [];
  let noAsistio = 0;

  for (const lead of leads) {
    semaforos[lead.semaforo] += 1;
    const etapas = new Set(store.eventos(lead.id).filter((e) => e.tipo === 'etapa').map((e) => e.datos.a));
    etapas.add(lead.etapa);
    if (etapas.has('no_asistio')) noAsistio += 1;
    for (const paso of PASOS) if (etapas.has(paso)) alcanzadas[paso] += 1;

    const origen = lead.origen;
    const campana = lead.atribucion?.meta_campaign_name ?? lead.atribucion?.utm_campaign ?? '(sin campaña)';
    for (const [mapa, clave] of [[porOrigen, origen], [porCampana, campana]]) {
      mapa[clave] ??= { leads: 0, clientes: 0 };
      mapa[clave].leads += 1;
      if (etapas.has('cliente')) mapa[clave].clientes += 1;
    }
    if (lead.primer_contacto) minutosPrimerContacto.push((new Date(lead.primer_contacto) - new Date(lead.creado)) / 60_000);
  }

  const cobrado = store.pagosCobradosEntre(desde, hasta).reduce((suma, p) => suma + p.importe_cent, 0);
  const gasto = store.gastoEntreMeses(desde.slice(0, 7), hasta.slice(0, 7)).reduce((suma, g) => suma + g.importe_cent, 0);
  const total = leads.length;
  const citasCerradas = alcanzadas.asistio + noAsistio;

  return {
    periodo: { desde, hasta },
    leads: total,
    semaforos,
    embudo: alcanzadas,
    tasas: {
      cualificacion: porcentaje(semaforos.verde + semaforos.amarillo, total),
      agendamiento: porcentaje(alcanzadas.agendado, total),
      asistencia: porcentaje(alcanzadas.asistio, citasCerradas),
      cierreSobreConsultas: porcentaje(alcanzadas.cliente, alcanzadas.asistio),
      leadACliente: porcentaje(alcanzadas.cliente, total),
    },
    minutosHastaPrimerContacto: { mediana: mediana(minutosPrimerContacto), muestras: minutosPrimerContacto.length },
    porOrigen,
    porCampana,
    economia: {
      cobradoCent: cobrado,
      gastoPublicidadCent: gasto,
      costePorLeadCent: total && gasto ? Math.round(gasto / total) : null,
      costePorClienteCent: alcanzadas.cliente && gasto ? Math.round(gasto / alcanzadas.cliente) : null,
    },
  };
}
