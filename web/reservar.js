(() => {
  const token = location.pathname.split('/').pop();
  const estado = document.getElementById('estado');
  const contenedorDias = document.getElementById('dias');

  function formatear(iso, zona, opciones) {
    return new Intl.DateTimeFormat('es-ES', { timeZone: zona, ...opciones }).format(new Date(iso));
  }

  function mostrarConfirmacion(cita) {
    document.getElementById('confirmacion').classList.remove('oculto');
    document.getElementById('texto-confirmacion').textContent = `Le esperamos el ${cita.texto}.`;
    document.getElementById('enlace-video').href = cita.url;
    if (cita.ics) document.getElementById('enlace-ics').href = cita.ics;
    else document.getElementById('enlace-ics').classList.add('oculto');
    document.getElementById('confirmacion').scrollIntoView({ behavior: 'smooth' });
  }

  async function reservar(inicio, boton) {
    for (const b of contenedorDias.querySelectorAll('button')) b.disabled = true;
    boton.setAttribute('aria-pressed', 'true');
    estado.className = 'estado';
    estado.textContent = 'Reservando…';
    try {
      const respuesta = await fetch(`/api/reservas/${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inicio }),
      });
      const cuerpo = await respuesta.json();
      if (!respuesta.ok) throw new Error(cuerpo.error || 'No se pudo reservar.');
      estado.textContent = '';
      contenedorDias.replaceChildren();
      mostrarConfirmacion(cuerpo);
    } catch (error) {
      estado.textContent = error.message;
      estado.classList.add('error');
      cargar();
    }
  }

  async function cargar() {
    const respuesta = await fetch(`/api/reservas/${encodeURIComponent(token)}`);
    const datos = await respuesta.json();
    if (!respuesta.ok) {
      estado.textContent = datos.error || 'Enlace no válido.';
      estado.classList.add('error');
      return;
    }
    if (datos.nombre) document.getElementById('saludo').textContent = `${datos.nombre}, elija el día y la hora de su consulta`;
    const actual = document.getElementById('cita-actual');
    if (datos.citaActual) {
      actual.textContent = `Ya tiene una consulta reservada el ${datos.citaActual.texto}. Si elige otra hora, la cambiaremos.`;
      actual.classList.remove('oculto');
    }
    const porDia = new Map();
    for (const hueco of datos.huecos) {
      if (!porDia.has(hueco.fecha)) porDia.set(hueco.fecha, []);
      porDia.get(hueco.fecha).push(hueco);
    }
    contenedorDias.replaceChildren();
    if (porDia.size === 0) {
      estado.textContent = 'No quedan huecos libres en los próximos días. Responda a nuestro mensaje y le buscaremos una hora.';
      return;
    }
    estado.textContent = '';
    for (const [, huecos] of porDia) {
      const dia = document.createElement('div');
      dia.className = 'dia';
      const titulo = document.createElement('h3');
      titulo.textContent = formatear(huecos[0].inicio, datos.zona, { weekday: 'long', day: 'numeric', month: 'long' });
      const horas = document.createElement('div');
      horas.className = 'horas';
      for (const hueco of huecos) {
        const boton = document.createElement('button');
        boton.type = 'button';
        boton.textContent = formatear(hueco.inicio, datos.zona, { hour: '2-digit', minute: '2-digit' });
        boton.addEventListener('click', () => reservar(hueco.inicio, boton));
        horas.append(boton);
      }
      dia.append(titulo, horas);
      contenedorDias.append(dia);
    }
  }

  cargar().catch(() => {
    estado.textContent = 'No se pudieron cargar los horarios. Recargue la página.';
    estado.classList.add('error');
  });
})();
