(() => {
  const datos = JSON.parse(document.getElementById('datos-encargo').textContent);
  const base = `/api/encargos/${encodeURIComponent(datos.token)}`;

  async function enviar(ruta, cuerpo = {}) {
    const respuesta = await fetch(`${base}/${ruta}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
    const resultado = await respuesta.json().catch(() => ({}));
    if (!respuesta.ok) throw new Error(resultado.error || 'No se pudo completar la operación.');
    return resultado;
  }

  function mostrar(elemento, texto, tipo) {
    elemento.textContent = texto;
    elemento.className = `estado ${tipo ?? ''}`;
  }

  const form = document.getElementById('form-firma');
  if (form) {
    const estado = document.getElementById('estado-firma');
    document.getElementById('pedir-codigo').addEventListener('click', async (evento) => {
      const boton = evento.currentTarget;
      boton.disabled = true;
      try {
        const { canal } = await enviar('codigo');
        mostrar(estado, `Le hemos enviado un código de 6 cifras por ${canal === 'whatsapp' ? 'WhatsApp' : 'correo electrónico'}.`, 'ok');
        form.elements.codigo.focus();
      } catch (error) {
        mostrar(estado, error.message, 'error');
      } finally {
        setTimeout(() => { boton.disabled = false; }, 30000);
      }
    });

    form.addEventListener('submit', async (evento) => {
      evento.preventDefault();
      const e = form.elements;
      if (!e.aceptaHoja.checked || !e.aceptaPago.checked) return mostrar(estado, 'Marque las casillas obligatorias para continuar.', 'error');
      if (!/^\d{6}$/.test(e.codigo.value.trim())) return mostrar(estado, 'Escriba el código de 6 cifras que le hemos enviado.', 'error');
      const boton = form.querySelector('button[type=submit]');
      boton.disabled = true;
      mostrar(estado, 'Firmando…');
      try {
        const { urlPago } = await enviar('firmar', {
          nombre: e.nombre.value, dni: e.dni.value, codigo: e.codigo.value.trim(), documentoSha256: datos.documentoSha256,
          aceptaHoja: e.aceptaHoja.checked, aceptaPago: e.aceptaPago.checked, inicioInmediato: e.inicioInmediato.checked,
        });
        mostrar(estado, 'Firmado. Le llevamos al pago de la entrada…', 'ok');
        location.href = urlPago;
      } catch (error) {
        mostrar(estado, error.message, 'error');
        boton.disabled = false;
      }
    });
  }

  const estadoPago = document.getElementById('estado-pago');
  for (const boton of document.querySelectorAll('[data-pagar]')) {
    boton.addEventListener('click', async () => {
      boton.disabled = true;
      try {
        const { urlPago } = await enviar('pagar', { pagoId: boton.dataset.pagar });
        location.href = urlPago;
      } catch (error) {
        mostrar(estadoPago, error.message, 'error');
        boton.disabled = false;
      }
    });
  }

  const desistirBoton = document.getElementById('desistir');
  if (desistirBoton) {
    desistirBoton.addEventListener('click', async () => {
      if (!document.getElementById('confirmo-desistir').checked) return alert('Marque la casilla para confirmar el desistimiento.');
      desistirBoton.disabled = true;
      try {
        await enviar('desistir', { confirmo: true });
        location.reload();
      } catch (error) {
        alert(error.message);
        desistirBoton.disabled = false;
      }
    });
  }
})();
