(() => {
  const { token } = JSON.parse(document.getElementById('datos-valoracion').textContent);
  const base = `/api/valoracion/${encodeURIComponent(token)}`;
  const $ = (id) => document.getElementById(id);
  const form = $('form-valoracion');
  let puntuacion = null;

  async function llamar(metodo, ruta = '', cuerpo) {
    const respuesta = await fetch(`${base}${ruta}`, { method: metodo, headers: cuerpo ? { 'Content-Type': 'application/json' } : {}, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    const datos = await respuesta.json().catch(() => ({}));
    if (!respuesta.ok) throw new Error(datos.error || 'No se pudo completar la operación.');
    return datos;
  }

  function gracias(vista) {
    $('bloque-formulario').classList.add('oculto');
    $('bloque-gracias').classList.remove('oculto');
    if (vista.resena) {
      $('bloque-resena').classList.remove('oculto');
      $('enlace-resena').href = vista.resena;
    }
    $('enlace-referido').textContent = vista.referido;
    $('compartir-whatsapp').href = `https://wa.me/?text=${encodeURIComponent(`Te paso el contacto de los abogados que me ayudaron con la Ley de Segunda Oportunidad: ${vista.referido}`)}`;
    if (vista.testimonio) {
      $('bloque-testimonio').classList.remove('oculto');
      $('texto-testimonio').textContent = `«${vista.testimonio.texto}»`;
      $('estado-testimonio').textContent = vista.testimonio.autorizado
        ? 'Ha autorizado su publicación. Puede retirar la autorización cuando quiera.'
        : 'Ha retirado la autorización: no se publicará.';
      $('revocar').classList.toggle('oculto', !vista.testimonio.autorizado);
    }
  }

  for (let n = 0; n <= 10; n += 1) {
    const etiqueta = document.createElement('label');
    const radio = Object.assign(document.createElement('input'), { type: 'radio', name: 'nps', value: String(n) });
    radio.addEventListener('change', () => { puntuacion = n; });
    etiqueta.append(radio, ` ${n}`);
    $('puntuaciones').append(etiqueta);
  }

  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const estado = $('estado-valoracion');
    if (puntuacion == null) {
      estado.textContent = 'Elija una puntuación del 0 al 10.';
      estado.className = 'estado error';
      return;
    }
    const e = form.elements;
    try {
      gracias(await llamar('POST', '', {
        nps: puntuacion, comentario: e.comentario.value,
        testimonio: e.autoriza.checked ? { texto: e.testimonio.value, firma: e.firma.value, autoriza: true } : null,
      }));
    } catch (error) {
      estado.textContent = error.message;
      estado.className = 'estado error';
    }
  });

  $('revocar').addEventListener('click', async () => {
    try {
      gracias(await llamar('POST', '/revocar'));
    } catch (error) {
      alert(error.message);
    }
  });

  llamar('GET').then((vista) => {
    $('texto-consentimiento').textContent = vista.consentimiento;
    if (vista.valorado) gracias(vista);
  }).catch((error) => {
    $('estado-valoracion').textContent = error.message;
  });
})();
