(() => {
  const token = sessionStorage.getItem('adminToken');
  if (!token) {
    location.href = '/admin';
    return;
  }
  const expedienteId = location.pathname.split('/').pop();
  const $ = (id) => document.getElementById(id);
  const euros = (cent) => (cent == null ? '—' : new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cent / 100));
  const aEuros = (cent) => (cent == null ? '' : String(cent / 100));

  const TIPOS_ACREEDOR = { financiera: 'Entidad financiera', aeat: 'Hacienda (AEAT)', seguridad_social: 'Seguridad Social', otra_administracion: 'Otra administración', alimentos: 'Alimentos', proveedor: 'Proveedor', particular: 'Particular', otro: 'Otro' };
  const GARANTIAS = { ninguna: 'Ninguna', hipotecaria: 'Hipotecaria', prendaria: 'Prendaria', personal: 'Personal (avales)', reserva_dominio: 'Reserva de dominio', otra: 'Otra' };
  const CLASES = { '': 'Sin clasificar', privilegio_especial: 'Privilegio especial (art. 270)', privilegio_general: 'Privilegio general (art. 280)', ordinario: 'Ordinario', subordinado: 'Subordinado' };
  const TIPOS_BIEN = { cuenta: 'Cuenta bancaria', inmueble: 'Inmueble', vehiculo: 'Vehículo', salario: 'Salario o pensión', otro: 'Otro' };
  const DOCUMENTOS = { memoria: 'Memoria', inventario: 'Inventario', acreedores: 'Relación de acreedores', solicitud: 'Solicitud de concurso' };
  let datos = null;

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
      location.href = '/admin';
      throw new Error('Sesión caducada');
    }
    const cuerpo = await respuesta.json().catch(() => ({}));
    if (!respuesta.ok) throw Object.assign(new Error(cuerpo.error || 'Error'), { faltas: cuerpo.faltas });
    return cuerpo;
  }

  async function descargar(url, nombre) {
    const respuesta = await fetch(`/admin/api${url}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!respuesta.ok) return alert('No se pudo descargar.');
    const disposicion = respuesta.headers.get('content-disposition') ?? '';
    const sugerido = decodeURIComponent((disposicion.match(/filename\*=UTF-8''([^;]+)/) || [])[1] ?? nombre);
    const enlace = el('a', { href: URL.createObjectURL(await respuesta.blob()), download: sugerido });
    document.body.append(enlace);
    enlace.click();
    enlace.remove();
  }

  const campo = (etiqueta, control) => el('label', { className: 'campo', textContent: etiqueta }, control);
  const entrada = (name, valor, extra = {}) => el('input', { name, value: valor ?? '', ...extra });
  function selector(name, opciones, valor) {
    const s = el('select', { name });
    for (const [v, t] of Object.entries(opciones)) s.add(new Option(t, v, false, (valor ?? '') === v));
    return s;
  }

  function tarjetaPartida(tabla, partida) {
    const esAcreedor = tabla === 'acreedores';
    const form = el('form', { className: 'rejilla' });
    if (esAcreedor) {
      form.append(
        campo('Acreedor', entrada('nombre', partida.nombre)),
        campo('NIF', entrada('nif', partida.nif)),
        campo('Domicilio', entrada('domicilio', partida.domicilio)),
        campo('Email', entrada('email', partida.email, { type: 'email' })),
        campo('Tipo', selector('tipo', TIPOS_ACREEDOR, partida.tipo)),
        campo('Concepto', entrada('concepto', partida.concepto)),
        campo('Importe (€)', entrada('importe', aEuros(partida.importe_cent), { type: 'number', step: '0.01', min: '0' })),
        campo('Vencimiento', entrada('vencimiento', partida.vencimiento, { type: 'date' })),
        campo('Garantía', selector('garantia', GARANTIAS, partida.garantia)),
        campo('Detalle de la garantía', entrada('garantia_detalle', partida.garantia_detalle)),
        campo('Reclamación judicial y estado', entrada('procedimiento_judicial', partida.procedimiento_judicial)),
        campo('Clase (decide el letrado)', selector('clase', CLASES, partida.clase)),
      );
    } else {
      form.append(
        campo('Tipo', selector('tipo', TIPOS_BIEN, partida.tipo)),
        campo('Descripción', entrada('descripcion', partida.descripcion)),
        campo('Lugar', entrada('ubicacion', partida.ubicacion)),
        campo('Datos registrales', entrada('datos_registrales', partida.datos_registrales)),
        campo('Valor de adquisición (€)', entrada('valor_adquisicion', aEuros(partida.valor_adquisicion_cent), { type: 'number', step: '0.01', min: '0' })),
        campo('Valor de mercado (€)', entrada('valor_mercado', aEuros(partida.valor_mercado_cent), { type: 'number', step: '0.01', min: '0' })),
        campo('Cargas y gravámenes', entrada('cargas', partida.cargas)),
        campo('Importe de las cargas (€)', entrada('cargas_importe', aEuros(partida.cargas_cent), { type: 'number', step: '0.01', min: '0' })),
        campo('¿Embargable? (decide el letrado)', selector('embargable', { '': 'Sin decidir', si: 'Sí', no: 'No' }, partida.embargable == null ? '' : partida.embargable ? 'si' : 'no')),
      );
    }
    form.append(campo('Notas internas', entrada('notas', partida.notas)));
    const revisado = el('input', { type: 'checkbox', name: 'revisado', checked: partida.revisado });
    const estado = el('p', { className: 'estado' });
    const guardar = el('button', { className: 'boton pequeno', type: 'submit', textContent: 'Guardar' });
    const borrar = el('button', { className: 'enlace-boton', type: 'button', textContent: 'Eliminar' });
    form.append(el('label', { className: 'casilla' }, revisado, ' Revisado por el letrado'), el('div', {}, guardar, ' ', borrar), estado);

    form.addEventListener('submit', async (evento) => {
      evento.preventDefault();
      const cuerpo = Object.fromEntries(new FormData(form));
      cuerpo.revisado = revisado.checked;
      if (!esAcreedor) cuerpo.embargable = cuerpo.embargable === '' ? null : cuerpo.embargable === 'si';
      try {
        await api(`/${tabla}/${partida.id}`, { method: 'PATCH', body: JSON.stringify(cuerpo) });
        await cargar();
      } catch (error) {
        estado.textContent = error.message;
        estado.className = 'estado error';
      }
    });
    borrar.addEventListener('click', async () => {
      if (!confirm('¿Eliminar esta partida?')) return;
      await api(`/${tabla}/${partida.id}`, { method: 'DELETE' }).catch((error) => alert(error.message));
      await cargar();
    });

    const resumen = esAcreedor
      ? `${partida.nombre ?? '(sin nombre)'} · ${TIPOS_ACREEDOR[partida.tipo] ?? partida.tipo} · ${euros(partida.importe_cent)}`
      : `${TIPOS_BIEN[partida.tipo] ?? partida.tipo} · ${partida.descripcion ?? '(sin descripción)'} · ${euros(partida.valor_mercado_cent)}`;
    const detalles = el('details', { className: `doc ${partida.revisado ? 'validado' : ''}` },
      el('summary', {}, resumen, ' ', el('span', { className: `insignia ${partida.revisado ? 'validado' : 'subido'}`, textContent: partida.revisado ? 'Revisado' : partida.origen === 'ia' ? 'Propuesto por IA' : 'Sin revisar' })),
      partida.cita ? el('p', { className: 'nota', textContent: `Del documento: «${partida.cita}»` }) : null,
      form);
    if (!partida.revisado && partida.origen === 'ia') detalles.open = false;
    return detalles;
  }

  function pintar() {
    const { cliente, expediente, preparacion: prep, indicadores: ind } = datos;
    document.title = `Preparación · ${cliente.nombre}`;
    $('titulo').textContent = `Preparación del expediente · ${cliente.nombre}`;
    const ESTADOS = { recogida_documentos: 'recogiendo documentos', en_revision: 'pendiente de revisión', documentacion_completa: 'completa y validada', cerrado: 'expediente cerrado' };
    $('subtitulo').textContent = `${cliente.provincia ?? ''} · documentación: ${ESTADOS[expediente.estado] ?? expediente.estado}${prep.listo ? ' · LISTO PARA PRESENTAR' : ''}`;
    const kpis = [
      ['Pasivo', euros(ind.pasivoCent)], ['Exonerable estimado', euros(ind.exonerableEstimadoCent)], ['Público no exonerable', euros(ind.publicoNoExonerableCent)],
      ['Alimentos', euros(ind.alimentosCent)], ['Con garantía real', euros(ind.garantiaRealCent)], ['Activo', euros(ind.activoCent)],
      ['Libre y embargable', euros(ind.libreEmbargableCent)], ['Acreedores', ind.acreedores], ['Bienes', ind.bienes],
    ];
    $('kpis').replaceChildren(...kpis.map(([e, v]) => el('div', { className: 'kpi' }, el('div', { className: 'valor', textContent: String(v) }), el('div', { className: 'etiqueta', textContent: e }))));
    $('sin-masa').replaceChildren(...(ind.indiciosSinMasa.length
      ? [el('p', { className: 'aviso' }, el('strong', { textContent: 'Indicios de concurso sin masa (art. 37 bis TRLC): ' }), ind.indiciosSinMasa.map((i) => `letra ${i.letra}) ${i.texto}`).join(' '), ' La decisión es del letrado.')]
      : ind.pendientesEmbargabilidad ? [el('p', { className: 'nota', textContent: `Indique si son embargables ${ind.pendientesEmbargabilidad} bien(es) para valorar el concurso sin masa.` })] : []));

    $('faltas').replaceChildren(...(datos.faltas.length
      ? datos.faltas.map((f) => el('li', {}, f.texto, el('span', { className: 'nota', textContent: ` (${f.base})` })))
      : [el('li', { textContent: 'Todo completo. Puede marcarlo como listo para presentar.' })]));
    $('boton-listo').textContent = prep.listo ? 'Reabrir para editar' : 'Marcar como listo para presentar';

    $('borradores').replaceChildren(...Object.entries(DOCUMENTOS).map(([tipo, nombre]) => {
      const boton = el('button', { className: 'boton secundario pequeno', type: 'button', textContent: `${nombre} (.docx)` });
      boton.addEventListener('click', () => descargar(`/expedientes/${expedienteId}/documentos/${tipo}`, `${nombre}.docx`));
      return boton;
    }));

    $('nota-ia').textContent = datos.ia
      ? 'Con «Extraer datos» la IA propone acreedores y bienes a partir del documento. Las propuestas quedan sin revisar hasta que usted las confirme.'
      : 'La extracción automática con IA no está activada (IA_EXTRACCION=activada). Puede introducir los datos a mano.';
    const porArchivo = new Map();
    for (const x of datos.extracciones) porArchivo.set(x.archivo_id, x);
    $('archivos').replaceChildren(...datos.archivos.map((a) => {
      const descargarBoton = el('button', { className: 'enlace-boton', type: 'button', textContent: a.nombre });
      descargarBoton.style.color = 'var(--marca)';
      descargarBoton.addEventListener('click', () => descargar(`/archivos/${a.id}`, a.nombre));
      const x = porArchivo.get(a.id);
      const estadoX = x ? ({ pendiente: ' · analizando…', completada: ` · extraídos ${x.resumen?.acreedores ?? 0} acreedores y ${x.resumen?.bienes ?? 0} bienes`, error: ` · error: ${x.error}` }[x.estado]) : '';
      let extraer = null;
      if (datos.ia && !prep.listo && (!x || x.estado === 'error')) {
        extraer = el('button', { className: 'boton pequeno secundario', type: 'button', textContent: 'Extraer datos' });
        extraer.addEventListener('click', async () => {
          extraer.disabled = true;
          await api(`/expedientes/${expedienteId}/extracciones`, { method: 'POST', body: JSON.stringify({ archivoId: a.id }) }).catch((error) => alert(error.message));
          await cargar();
          setTimeout(cargar, 15000);
        });
      }
      return el('li', {}, `${a.documento} · `, descargarBoton, estadoX, ' ', extraer);
    }));

    const form = $('form-prep');
    for (const clave of ['tribunal', 'ruta', 'procurador', 'poder', 'costePrevistoEuros', 'historia', 'actividad', 'establecimientos', 'causas']) {
      form.elements[clave].value = prep[clave] ?? '';
    }
    for (const control of form.elements) control.disabled = Boolean(prep.listo);

    $('acreedores').replaceChildren(...datos.acreedores.map((p) => tarjetaPartida('acreedores', p)));
    $('bienes').replaceChildren(...datos.bienes.map((p) => tarjetaPartida('bienes', p)));
    $('nuevo-acreedor').disabled = Boolean(prep.listo);
    $('nuevo-bien').disabled = Boolean(prep.listo);
  }

  let seguimiento = null;

  function pintarSeguimiento() {
    const s = seguimiento;
    $('estado-procedimiento').textContent = s.estadoTexto ? `· ${s.estadoTexto}` : '· sin presentar';
    const tipo = $('form-actuacion').elements.tipo;
    if (!tipo.options.length) {
      for (const [clave, def] of Object.entries(s.catalogo)) tipo.add(new Option(def.titulo, clave));
      tipo.addEventListener('change', () => $('plazo-libre').classList.toggle('oculto', !seguimiento.catalogo[tipo.value]?.plazoLibre));
      $('form-actuacion').elements.fecha.value = new Date().toISOString().slice(0, 10);
    }
    const ccaa = $('form-procedimiento').elements.ccaa;
    if (!ccaa.options.length) {
      ccaa.add(new Option('Elija…', ''));
      for (const c of s.comunidades) ccaa.add(new Option(c, c));
    }
    const p = s.procedimiento ?? {};
    const fp = $('form-procedimiento').elements;
    fp.organo.value = p.organo ?? datos?.preparacion?.tribunal ?? '';
    fp.numero.value = p.numero ?? '';
    fp.nig.value = p.nig ?? '';
    fp.ccaa.value = p.ccaa ?? '';
    fp.localidad.value = p.localidad ?? '';
    fp.festivos_locales.value = (p.festivos_locales ?? []).join(', ');

    const ESTADO_PLAZO = { pendiente: 'Pendiente', cumplido: 'Cumplido', cancelado: 'Cancelado', vencido: 'VENCIDO', transcurrido: 'Transcurrido' };
    $('plazos').replaceChildren(...(s.plazos.length ? s.plazos.map((pl) => {
      const nivel = pl.estado !== 'pendiente' ? '' : pl.restantes <= 1 ? 'rechazado' : pl.restantes <= 5 ? 'subido' : 'validado';
      const quedan = pl.estado === 'pendiente' ? (pl.restantes === 0 ? 'vence hoy' : `${pl.restantes} días hábiles`) : ESTADO_PLAZO[pl.estado];
      const acciones = el('div', {});
      const boton = (texto, estado) => {
        const b = el('button', { className: 'boton pequeno secundario', type: 'button', textContent: texto });
        b.addEventListener('click', async () => {
          await api(`/plazos/${pl.id}`, { method: 'POST', body: JSON.stringify({ estado }) }).catch((error) => alert(error.message));
          await cargarSeguimiento();
        });
        return b;
      };
      if (pl.estado === 'pendiente' || pl.estado === 'vencido') acciones.append(boton('Cumplido', 'cumplido'), ' ', boton('Cancelar', 'cancelado'));
      else acciones.append(boton('Reabrir', 'pendiente'));
      return el('article', { className: `doc ${nivel}` },
        el('div', { className: 'doc-cabecera' },
          el('h3', { textContent: `${pl.parte === 'nuestro' ? '' : '(Terceros) '}${pl.titulo}` }),
          el('span', { className: `insignia ${nivel}`, textContent: quedan })),
        el('p', { textContent: `Vence el ${pl.vence} · ${pl.cantidad} ${pl.unidad === 'habiles' ? 'días hábiles' : pl.unidad} desde ${pl.dies_a_quo}${pl.encadenado_a ? ' (encadenado al plazo anterior)' : ''} · ${pl.base ?? ''}` }),
        pl.parte === 'nuestro' ? el('p', { className: 'nota', textContent: `Presentación posible hasta las 15:00 del ${pl.limite_presentacion} (art. 135.5 LEC).` }) : null,
        ...(pl.avisos_calendario ?? []).map((a) => el('p', { className: 'aviso', textContent: a })),
        acciones);
    }) : [el('p', { className: 'nota', textContent: 'Sin plazos todavía.' })]));

    $('actuaciones').replaceChildren(...[...s.actuaciones].reverse().map((a) => el('li', {},
      el('span', { className: 'fecha', textContent: `${a.fecha}${a.visible_cliente ? ' · comunicado al cliente' : ''}` }),
      el('strong', { textContent: a.titulo }), a.detalle ? ` · ${a.detalle}` : '')));
  }

  async function cargarCierre() {
    const { cierre } = await api(`/expedientes/${expedienteId}/cierre`);
    const caja = $('cierre');
    const resolucion = ['exoneracion_concedida', 'exoneracion_denegada'].includes(seguimiento?.procedimiento?.estado);
    const hijos = [];
    if (cierre) {
      const motivos = { exoneracion_concedida: 'Exoneración concedida', exoneracion_denegada: 'Exoneración denegada', desistimiento: 'Desistimiento del cliente' };
      hijos.push(el('p', {}, `${motivos[cierre.motivo] ?? cierre.motivo}`,
        cierre.valorado ? ` · valoración ${cierre.nps}/10${cierre.comentario ? `: «${cierre.comentario}»` : ''}` : ' · sin valoración todavía',
        cierre.resena_clic ? ' · abrió el enlace de reseña' : '',
        cierre.testimonio ? ` · testimonio ${cierre.testimonio.autorizado ? 'autorizado' : 'retirado'}` : '',
        ` · ${cierre.referidos} recomendado(s)`));
      hijos.push(el('p', { className: 'nota' }, 'Enlace de valoración del cliente: ', el('a', { href: cierre.urlValoracion, target: '_blank', textContent: cierre.urlValoracion })));
      if (cierre.archivado) hijos.push(el('p', {}, `Archivado el ${cierre.archivado}. Conservar documentos hasta el ${cierre.conservar_hasta} (art. 1964.2 CC, configurable).${cierre.documentos_eliminados ? ' Documentos eliminados.' : ''}`));
      if (cierre.puedeEliminar) {
        const borrar = el('button', { className: 'boton peligro pequeno', type: 'button', textContent: 'Eliminar los documentos del expediente' });
        borrar.addEventListener('click', async () => {
          if (!confirm('Se borrarán definitivamente los documentos cifrados del cliente. ¿Continuar?')) return;
          await api(`/expedientes/${expedienteId}/eliminar-documentos`, { method: 'POST', body: '{}' }).catch((error) => alert(error.message));
          await cargarCierre();
        });
        hijos.push(borrar);
      }
    }
    if (resolucion && !cierre?.archivado) {
      const archivar = el('button', { className: 'boton secundario pequeno', type: 'button', textContent: 'Archivar el expediente' });
      archivar.addEventListener('click', async () => {
        try {
          await api(`/expedientes/${expedienteId}/archivar`, { method: 'POST', body: '{}' });
          await cargarSeguimiento();
        } catch (error) {
          alert(error.message);
        }
      });
      hijos.push(archivar);
    }
    if (!hijos.length) hijos.push(el('p', { className: 'nota', textContent: 'Al registrar la resolución sobre la exoneración se iniciará el cierre: valoración, reseña y archivo.' }));
    caja.replaceChildren(...hijos);
  }

  async function cargarSeguimiento() {
    seguimiento = await api(`/expedientes/${expedienteId}/seguimiento`);
    pintarSeguimiento();
    await cargarCierre();
  }

  $('form-actuacion').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const f = evento.target.elements;
    const estado = $('estado-actuacion');
    const cuerpo = { tipo: f.tipo.value, fecha: f.fecha.value, detalle: f.detalle.value, visibleCliente: f.visible.checked };
    if (seguimiento.catalogo[f.tipo.value]?.plazoLibre && f.plazo_cantidad.value) {
      cuerpo.plazo = {
        titulo: f.plazo_titulo.value, cantidad: Number(f.plazo_cantidad.value), unidad: f.plazo_unidad.value, base: f.plazo_base.value,
        urgente: f.plazo_urgente.checked, parte: f.plazo_tercero.checked ? 'tercero' : 'nuestro',
      };
    }
    try {
      seguimiento = await api(`/expedientes/${expedienteId}/actuaciones`, { method: 'POST', body: JSON.stringify(cuerpo) });
      pintarSeguimiento();
      await cargarCierre();
      estado.textContent = 'Actuación registrada.';
      estado.className = 'estado ok';
      f.detalle.value = '';
    } catch (error) {
      estado.textContent = error.message;
      estado.className = 'estado error';
    }
  });

  $('form-procedimiento').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const estado = $('estado-procedimiento-form');
    try {
      seguimiento = await api(`/expedientes/${expedienteId}/procedimiento`, { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(evento.target))) });
      pintarSeguimiento();
      estado.textContent = 'Guardado. Plazos recalculados.';
      estado.className = 'estado ok';
    } catch (error) {
      estado.textContent = error.message;
      estado.className = 'estado error';
    }
  });

  async function cargar() {
    datos = await api(`/expedientes/${expedienteId}/preparacion`);
    pintar();
    await cargarSeguimiento();
  }

  $('form-prep').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const estado = $('estado-prep');
    try {
      await api(`/expedientes/${expedienteId}/preparacion`, { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(evento.target))) });
      estado.textContent = 'Guardado.';
      estado.className = 'estado ok';
      await cargar();
    } catch (error) {
      estado.textContent = error.message;
      estado.className = 'estado error';
    }
  });

  for (const [boton, tabla] of [['nuevo-acreedor', 'acreedores'], ['nuevo-bien', 'bienes']]) {
    $(boton).addEventListener('click', async () => {
      await api(`/expedientes/${expedienteId}/${tabla}`, { method: 'POST', body: '{}' }).catch((error) => alert(error.message));
      await cargar();
      const lista = $(tabla).lastElementChild;
      if (lista) lista.open = true;
    });
  }

  $('boton-listo').addEventListener('click', async () => {
    const estado = $('estado-listo');
    try {
      await api(`/expedientes/${expedienteId}/listo`, { method: 'POST', body: JSON.stringify({ listo: !datos.preparacion.listo }) });
      estado.textContent = datos.preparacion.listo ? 'Expediente reabierto.' : 'Expediente marcado como listo para presentar.';
      estado.className = 'estado ok';
      await cargar();
    } catch (error) {
      estado.textContent = error.message;
      estado.className = 'estado error';
    }
  });

  cargar().catch((error) => alert(error.message));
})();
