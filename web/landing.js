(() => {
  const PROVINCIAS = ['A Coruña', 'Álava', 'Albacete', 'Alicante', 'Almería', 'Asturias', 'Ávila', 'Badajoz', 'Baleares', 'Barcelona', 'Bizkaia', 'Burgos',
    'Cáceres', 'Cádiz', 'Cantabria', 'Castellón', 'Ceuta', 'Ciudad Real', 'Córdoba', 'Cuenca', 'Gipuzkoa', 'Girona', 'Granada', 'Guadalajara', 'Huelva',
    'Huesca', 'Jaén', 'La Rioja', 'Las Palmas', 'León', 'Lleida', 'Lugo', 'Madrid', 'Málaga', 'Melilla', 'Murcia', 'Navarra', 'Ourense', 'Palencia',
    'Pontevedra', 'Salamanca', 'Santa Cruz de Tenerife', 'Segovia', 'Sevilla', 'Soria', 'Tarragona', 'Teruel', 'Toledo', 'Valencia', 'Valladolid',
    'Zamora', 'Zaragoza'];
  const form = document.getElementById('form-lead');
  const estado = document.getElementById('estado-lead');
  const resultado = document.getElementById('resultado');
  const select = form.elements.provincia;
  for (const p of PROVINCIAS) select.add(new Option(p, p));

  const parametros = new URLSearchParams(location.search);
  const atribucion = {};
  for (const clave of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid']) {
    if (parametros.get(clave)) atribucion[clave] = parametros.get(clave);
  }
  atribucion.pagina = location.pathname;

  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    estado.className = 'estado';
    if (!form.checkValidity()) {
      estado.textContent = 'Revise los campos obligatorios y acepte la política de privacidad.';
      estado.classList.add('error');
      form.reportValidity();
      return;
    }
    const datos = Object.fromEntries(new FormData(form));
    datos.acepta_privacidad = form.elements.acepta_privacidad.checked;
    datos.acepta_comunicaciones = form.elements.acepta_comunicaciones.checked;
    datos.atribucion = atribucion;
    const boton = form.querySelector('button[type=submit]');
    boton.disabled = true;
    estado.textContent = 'Enviando…';
    try {
      const respuesta = await fetch('/api/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(datos) });
      const cuerpo = await respuesta.json();
      if (!respuesta.ok) throw new Error(cuerpo.error || 'No se pudo enviar.');
      form.classList.add('oculto');
      resultado.classList.remove('oculto');
      resultado.replaceChildren();
      const titulo = document.createElement('h3');
      const texto = document.createElement('p');
      if (cuerpo.reserva) {
        titulo.textContent = 'Gracias. Elija ahora el día y la hora de su consulta gratuita.';
        texto.textContent = 'También le hemos enviado el enlace por WhatsApp o correo.';
        const enlace = Object.assign(document.createElement('a'), { className: 'boton', href: cuerpo.reserva, textContent: 'Reservar mi consulta' });
        resultado.append(titulo, texto, enlace);
        if (window.fbq) window.fbq('track', 'Lead');
      } else {
        titulo.textContent = 'Gracias, hemos recibido su consulta.';
        texto.textContent = 'Un abogado revisará personalmente sus respuestas y le contestaremos lo antes posible.';
        resultado.append(titulo, texto);
      }
    } catch (error) {
      estado.textContent = error.message;
      estado.classList.add('error');
      boton.disabled = false;
    }
  });
})();
