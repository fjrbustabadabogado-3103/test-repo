(() => {
  const { token } = JSON.parse(document.getElementById('datos-expediente').textContent);
  const base = `/api/expedientes/${encodeURIComponent(token)}`;
  const $ = (id) => document.getElementById(id);
  const form = $('form-datos');
  const ETIQUETAS = { pendiente: 'Pendiente', subido: 'En revisión', validado: 'Validado ✓', rechazado: 'Hay que corregirlo' };

  function el(tag, propiedades = {}, ...hijos) {
    const nodo = Object.assign(document.createElement(tag), propiedades);
    for (const hijo of hijos.flat()) if (hijo != null) nodo.append(hijo);
    return nodo;
  }

  function tamano(bytes) {
    return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
  }

  async function llamar(metodo, ruta, cuerpo, cabeceras = {}) {
    const respuesta = await fetch(`${base}${ruta}`, { method: metodo, headers: cabeceras, body: cuerpo });
    const datos = await respuesta.json().catch(() => ({}));
    if (!respuesta.ok) throw new Error(datos.error || 'No se pudo completar la operación.');
    return datos;
  }

  function estadoGeneral(resumen) {
    const { obligatorios, aportados } = resumen.progreso;
    const total = obligatorios + 1;
    const hechos = aportados + (resumen.datosCompletos ? 1 : 0);
    $('barra').style.width = `${Math.round((hechos / total) * 100)}%`;
    const mensajes = {
      documentacion_completa: 'Su documentación está completa y revisada. Ahora preparamos la solicitud y le avisaremos de cada paso.',
      en_revision: 'Ha aportado todo lo necesario. Estamos revisándolo; si algo hay que corregirlo, se lo indicaremos aquí y por WhatsApp.',
      cerrado: 'Este expediente está cerrado.',
    };
    $('estado-general').textContent = mensajes[resumen.estado] ?? `Lleva ${hechos} de ${total} pasos obligatorios.`;
  }

  function rellenarDatos(datos) {
    if (!datos) return;
    for (const [clave, valor] of Object.entries(datos)) {
      const campo = form.elements[clave];
      if (!campo || valor == null) continue;
      if (campo instanceof RadioNodeList) {
        const objetivo = typeof valor === 'boolean' ? (valor ? 'si' : 'no') : valor;
        for (const radio of campo) radio.checked = radio.value === objetivo;
      } else {
        campo.value = valor;
      }
    }
  }

  function mostrarConyuge() {
    const conPareja = ['casado', 'pareja_inscrita'].includes(form.elements.estado_civil.value);
    $('bloque-conyuge').classList.toggle('oculto', !conPareja);
  }

  async function subir(documento, archivos, estado) {
    let resumen = null;
    for (const [i, archivo] of [...archivos].entries()) {
      estado.textContent = `Subiendo ${i + 1} de ${archivos.length}: ${archivo.name}…`;
      estado.className = 'estado';
      try {
        resumen = await llamar('PUT', `/documentos/${documento.id}`, archivo, {
          'Content-Type': archivo.type || 'application/octet-stream',
          'X-Nombre-Archivo': encodeURIComponent(archivo.name),
        });
      } catch (error) {
        estado.textContent = `${archivo.name}: ${error.message}`;
        estado.className = 'estado error';
        if (resumen) pintar(resumen);
        return;
      }
    }
    if (resumen) pintar(resumen);
  }

  function tarjeta(documento, abierto, limites) {
    const estado = el('p', { className: 'estado', role: 'status' });
    const archivos = el('ul', { className: 'archivos' }, documento.archivos.map((a) => {
      const borrar = documento.estado !== 'validado' && abierto
        ? el('button', { className: 'enlace-boton', type: 'button', textContent: 'Quitar' })
        : null;
      borrar?.addEventListener('click', async () => {
        if (!confirm(`¿Quitar «${a.nombre}»?`)) return;
        try {
          pintar(await llamar('DELETE', `/archivos/${a.id}`));
        } catch (error) {
          estado.textContent = error.message;
          estado.className = 'estado error';
        }
      });
      return el('li', {}, el('span', { textContent: `${a.nombre} · ${tamano(a.tamano)}` }), borrar);
    }));

    let subida = null;
    if (abierto && documento.estado !== 'validado') {
      const entrada = el('input', { type: 'file', multiple: true, accept: 'application/pdf,image/*' });
      entrada.addEventListener('change', () => {
        if (entrada.files.length) subir(documento, entrada.files, estado);
        entrada.value = '';
      });
      subida = el('label', { className: 'boton secundario pequeno subida' }, documento.archivos.length ? 'Añadir más archivos' : 'Subir archivo o foto', entrada);
    }

    return el('article', { className: `doc ${documento.estado}` },
      el('div', { className: 'doc-cabecera' },
        el('h3', { textContent: `${documento.titulo}${documento.obligatorio ? '' : ' (opcional)'}` }),
        el('span', { className: `insignia ${documento.estado}`, textContent: ETIQUETAS[documento.estado] ?? documento.estado })),
      documento.motivoRechazo ? el('p', { className: 'aviso', textContent: `Motivo: ${documento.motivoRechazo}` }) : null,
      el('p', { textContent: documento.descripcion ?? '' }),
      documento.comoObtenerlo ? el('details', {}, el('summary', { textContent: 'Cómo conseguirlo' }), el('p', { textContent: documento.comoObtenerlo })) : null,
      archivos,
      subida,
      estado,
      el('p', { className: 'nota', textContent: `PDF o fotos (JPG, PNG, HEIC). Máximo ${limites.maxMbPorArchivo} MB por archivo.` }));
  }

  function pintar(resumen) {
    estadoGeneral(resumen);
    const abierto = !['documentacion_completa', 'cerrado'].includes(resumen.estado);
    for (const campo of form.elements) campo.disabled = !abierto;
    $('documentos').replaceChildren(...resumen.documentos.map((d) => tarjeta(d, abierto, resumen.limites)));
  }

  form.elements.estado_civil.addEventListener('change', mostrarConyuge);
  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const estado = $('estado-datos');
    const datos = Object.fromEntries(new FormData(form));
    try {
      const resumen = await llamar('POST', '/datos', JSON.stringify(datos), { 'Content-Type': 'application/json' });
      estado.textContent = 'Datos guardados. Revise abajo la lista de documentos.';
      estado.className = 'estado ok';
      pintar(resumen);
    } catch (error) {
      estado.textContent = error.message;
      estado.className = 'estado error';
    }
  });

  function pintarSeguimiento(seguimiento) {
    if (!seguimiento) return;
    $('bloque-seguimiento').classList.remove('oculto');
    $('estado-procedimiento').textContent = seguimiento.estado;
    const formato = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    $('actuaciones-cliente').replaceChildren(...[...seguimiento.actuaciones].reverse().map((a) => el('li', {},
      el('span', { className: 'fecha', textContent: formato.format(new Date(`${a.fecha}T00:00:00Z`)) }), a.titulo)));
  }

  llamar('GET', '').then((resumen) => {
    pintarSeguimiento(resumen.seguimiento);
    rellenarDatos(resumen.datos);
    mostrarConyuge();
    pintar(resumen);
  }).catch((error) => {
    $('estado-general').textContent = error.message;
    $('estado-general').className = 'estado error';
  });
})();
