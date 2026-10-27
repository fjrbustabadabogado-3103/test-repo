(() => {
  const ETAPAS = ['nuevo', 'contactado', 'cualificado', 'agendado', 'asistio', 'no_asistio', 'propuesta', 'firmado', 'cliente', 'perdido', 'descartado', 'desistido'];
  const NOMBRE_ETAPA = {
    nuevo: 'Nuevo', contactado: 'Contactado', cualificado: 'Cualificado', agendado: 'Cita reservada', asistio: 'Consulta hecha', no_asistio: 'No asistió',
    propuesta: 'Propuesta enviada', firmado: 'Firmado (pago pendiente)', cliente: 'Cliente', perdido: 'Perdido', descartado: 'Descartado', desistido: 'Desistió',
  };
  let token = sessionStorage.getItem('adminToken') || '';
  let leadActivo = (location.hash.match(/lead=([\w-]+)/) || [])[1] || null;
  let avisoFicha = null;

  const $ = (id) => document.getElementById(id);
  const euros = (cent) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format((cent ?? 0) / 100);
  const fecha = (iso) => (iso ? new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Madrid' }).format(new Date(iso)) : '—');

  function el(tag, propiedades = {}, ...hijos) {
    const nodo = Object.assign(document.createElement(tag), propiedades);
    for (const hijo of hijos.flat()) if (hijo != null) nodo.append(hijo);
    return nodo;
  }

  async function api(ruta, opciones = {}) {
    const respuesta = await fetch(`/admin/api${ruta}`, {
      ...opciones,
      headers: { Authorization: `Bearer ${token}`, ...(opciones.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    if (respuesta.status === 401) {
      sessionStorage.removeItem('adminToken');
      $('acceso').classList.remove('oculto');
      $('app').classList.add('oculto');
      throw new Error('Token no válido');
    }
    const cuerpo = await respuesta.json();
    if (!respuesta.ok) throw new Error(cuerpo.error || 'Error');
    return cuerpo;
  }

  function chip(semaforo) {
    return el('span', { className: `chip ${semaforo}`, textContent: semaforo });
  }

  async function cargarMetricas() {
    const dias = Number($('periodo').value);
    const desde = new Date(Date.now() - dias * 86400000).toISOString();
    const m = await api(`/metricas?desde=${encodeURIComponent(desde)}`);
    const pct = (v) => (v == null ? '—' : `${v} %`);
    const kpis = [
      ['Leads', m.leads],
      ['Cualificados', pct(m.tasas.cualificacion)],
      ['Reservan cita', pct(m.tasas.agendamiento)],
      ['Asisten', pct(m.tasas.asistencia)],
      ['Contratan tras consulta', pct(m.tasas.cierreSobreConsultas)],
      ['Clientes', m.embudo.cliente],
      ['Min. hasta 1.er contacto', m.minutosHastaPrimerContacto.mediana == null ? '—' : Math.round(m.minutosHastaPrimerContacto.mediana * 10) / 10],
      ['Cobrado', euros(m.economia.cobradoCent)],
      ['Coste por lead', m.economia.costePorLeadCent == null ? '—' : euros(m.economia.costePorLeadCent)],
      ['Coste por cliente', m.economia.costePorClienteCent == null ? '—' : euros(m.economia.costePorClienteCent)],
    ];
    $('kpis').replaceChildren(...kpis.map(([etiqueta, valor]) => el('div', { className: 'kpi' }, el('div', { className: 'valor', textContent: String(valor) }), el('div', { className: 'etiqueta', textContent: etiqueta }))));
  }

  async function cargarLeads() {
    const params = new URLSearchParams();
    if ($('filtro-semaforo').value) params.set('semaforo', $('filtro-semaforo').value);
    if ($('filtro-etapa').value) params.set('etapa', $('filtro-etapa').value);
    const leads = await api(`/leads?${params}`);
    $('leads').replaceChildren(...leads.map((l) => {
      const fila = el('tr', { className: l.id === leadActivo ? 'activo' : '' },
        el('td', {}, chip(l.semaforo)),
        el('td', { textContent: l.nombre ?? '(sin nombre)' }),
        el('td', { textContent: NOMBRE_ETAPA[l.etapa] ?? l.etapa }),
        el('td', { className: 'num', textContent: l.deuda != null ? euros(l.deuda * 100) : '—' }),
        el('td', { textContent: l.campana ? `${l.origen} · ${l.campana}` : l.origen }),
        el('td', { textContent: fecha(l.creado) }));
      fila.addEventListener('click', () => abrirLead(l.id));
      return fila;
    }));
  }

  function seccion(titulo, ...contenido) {
    return [el('h3', { textContent: titulo }), ...contenido];
  }

  async function abrirLead(id) {
    leadActivo = id;
    history.replaceState(null, '', `#lead=${id}`);
    const d = await api(`/leads/${id}`);
    const l = d.lead;
    const r = l.respuestas;
    const sino = (v) => (v == null ? '—' : v ? 'Sí' : 'No');

    const acciones = el('div', { className: 'filtros' });
    for (const etapa of d.etapasManuales.length && !d.etapasBloqueadas.includes(l.etapa) ? d.etapasManuales : []) {
      if (etapa === l.etapa) continue;
      const boton = el('button', { className: 'boton pequeno secundario', textContent: NOMBRE_ETAPA[etapa] });
      boton.addEventListener('click', async () => {
        const motivo = ['perdido', 'descartado'].includes(etapa) ? prompt('Motivo (opcional):') : null;
        await api(`/leads/${id}/etapa`, { method: 'POST', body: JSON.stringify({ etapa, motivo }) });
        await Promise.all([cargarLeads(), cargarMetricas()]);
        await abrirLead(id);
      });
      acciones.append(boton);
    }

    const formPropuesta = el('form', { className: 'rejilla' },
      el('label', { className: 'campo', textContent: 'Honorarios totales (€)' }, el('input', { name: 'honorarios', type: 'number', min: '1', step: '0.01', required: true })),
      el('label', { className: 'campo', textContent: 'Entrada a la firma (€)' }, el('input', { name: 'entrada', type: 'number', min: '1', step: '0.01', required: true })),
      el('label', { className: 'campo', textContent: 'N.º de cuotas mensuales' }, el('input', { name: 'numCuotas', type: 'number', min: '0', max: '36', value: '10', required: true })),
      el('label', { className: 'campo', textContent: 'Provisión procurador (€)' }, el('input', { name: 'provisionProcurador', type: 'number', min: '0', step: '0.01', value: '0' })),
      el('button', { className: 'boton', type: 'submit', textContent: 'Generar y enviar hoja de encargo' }));
    const estadoPropuesta = el('p', { className: 'estado' });
    formPropuesta.addEventListener('submit', async (evento) => {
      evento.preventDefault();
      try {
        const datos = Object.fromEntries(new FormData(formPropuesta));
        datos.numCuotas = Number(datos.numCuotas);
        const res = await api(`/leads/${id}/propuesta`, { method: 'POST', body: JSON.stringify(datos) });
        avisoFicha = `Hoja de encargo enviada al cliente. Enlace: ${res.url}`;
        await cargarLeads();
        await abrirLead(id);
      } catch (error) {
        estadoPropuesta.textContent = error.message;
        estadoPropuesta.className = 'estado error';
      }
    });

    const motivos = (l.motivos?.lista ?? []).map((m) => el('li', {}, el('strong', { textContent: `${m.nivel.toUpperCase()}: ` }), m.texto, m.base ? el('span', { className: 'nota', textContent: ` (${m.base})` }) : null));

    const aviso = avisoFicha ? el('p', { className: 'estado ok', textContent: avisoFicha }) : null;
    avisoFicha = null;
    $('ficha').replaceChildren(...[
      el('h2', {}, chip(l.semaforo), ` ${l.nombre ?? '(sin nombre)'} · ${l.puntuacion}/100`),
      aviso,
      el('p', {}, `${NOMBRE_ETAPA[l.etapa] ?? l.etapa} · `, el('a', { href: `tel:+${l.telefono}`, textContent: l.telefono ? `+${l.telefono}` : 'sin teléfono' }), ` · ${l.email ?? 'sin email'} · ${l.provincia ?? ''}`),
      el('p', { className: 'nota' }, `Comunicaciones: ${l.baja ? 'BAJA' : l.consentimiento_comunicaciones ? 'aceptadas' : 'no aceptadas'} · Reserva: `, el('a', { href: d.enlaceReserva, target: '_blank', textContent: 'enlace' })),
      acciones,
      ...seccion('Cualificación', el('ul', { className: 'motivos' }, motivos.length ? motivos : el('li', { textContent: 'Sin alertas.' }))),
      ...seccion('Respuestas', el('table', { className: 'datos' }, ...[
        ['Tipo de deudor', r.tipo_deudor], ['Deuda total', r.deuda_total != null ? euros(r.deuda_total * 100) : '—'], ['Acreedores', r.num_acreedores ?? '—'],
        ['Hacienda', euros((r.deuda_hacienda ?? 0) * 100)], ['Seguridad Social', euros((r.deuda_seguridad_social ?? 0) * 100)], ['Ingresos/mes', r.ingresos_mensuales != null ? euros(r.ingresos_mensuales * 100) : '—'],
        ['Hipoteca', sino(r.vivienda_hipotecada)], ['Alimentos', sino(r.deuda_alimentos)], ['Antecedentes', sino(r.antecedentes)], ['Exoneración previa', sino(r.exoneracion_previa)],
      ].map(([k, v]) => el('tr', {}, el('th', { textContent: k }), el('td', { textContent: String(v) }))))),
      ...seccion('Citas', el('ul', { className: 'historial' }, d.citas.length ? d.citas.map((c) => el('li', {}, `${fecha(c.inicio)} · ${c.estado} · `, el('a', { href: c.url_videollamada, target: '_blank', textContent: 'videollamada' }))) : el('li', { textContent: 'Sin citas.' }))),
      ...seccion('Hoja de encargo', formPropuesta, estadoPropuesta,
        ...d.encargos.map((e) => el('div', { className: 'aviso' }, `${e.estado.toUpperCase()} · ${euros(e.honorarios_cent)} · ${e.num_cuotas} cuotas · `, el('a', { href: e.url, target: '_blank', textContent: 'ver' }),
          el('ul', { className: 'historial' }, e.pagos.map((p) => el('li', { textContent: `${p.tipo === 'entrada' ? 'Entrada' : `Cuota ${p.numero}`} · ${euros(p.importe_cent)} · ${p.vencimiento} · ${p.estado}` })))))),
      ...seccion('Próximas tareas automáticas', el('ul', { className: 'historial' }, d.tareas.length ? d.tareas.map((t) => el('li', { textContent: `${fecha(t.vence)} · ${t.tipo}${t.datos.plantilla ? ` (${t.datos.plantilla})` : ''}` })) : el('li', { textContent: 'Ninguna.' }))),
      ...seccion('Historial', el('ul', { className: 'historial' }, [...d.eventos].reverse().map((e) => el('li', { textContent: `${fecha(e.fecha)} · ${e.tipo}${e.datos.a ? ` → ${e.datos.a}` : ''}${e.datos.plantilla ? ` · ${e.datos.plantilla}` : ''}` })))),
      ...seccion('Mensajes enviados', el('ul', { className: 'historial' }, d.salida.map((s) => el('li', { textContent: `${fecha(s.fecha)} · ${s.canal}/${s.proveedor} · ${s.plantilla} · ${s.estado}` })))),
    ].filter(Boolean));
  }

  async function iniciar() {
    $('acceso').classList.add('oculto');
    $('app').classList.remove('oculto');
    await Promise.all([cargarMetricas(), cargarLeads()]);
    if (leadActivo) await abrirLead(leadActivo).catch(() => {});
  }

  for (const etapa of ETAPAS) $('filtro-etapa').add(new Option(NOMBRE_ETAPA[etapa], etapa));
  $('filtro-semaforo').addEventListener('change', cargarLeads);
  $('filtro-etapa').addEventListener('change', cargarLeads);
  $('periodo').addEventListener('change', cargarMetricas);
  $('form-acceso').addEventListener('submit', (evento) => {
    evento.preventDefault();
    token = new FormData(evento.target).get('token');
    sessionStorage.setItem('adminToken', token);
    iniciar().catch((error) => alert(error.message));
  });
  $('form-gasto').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const datos = Object.fromEntries(new FormData(evento.target));
    await api('/gasto', { method: 'POST', body: JSON.stringify(datos) }).then(cargarMetricas).catch((error) => alert(error.message));
  });
  if (token) iniciar().catch(() => {});
})();
