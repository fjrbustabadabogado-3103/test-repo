/**
 * Ayudante de los archivos de arranque con doble clic.
 *   node scripts/abrir-navegador.mjs <url> --comprobar   → sale con 0 si la herramienta ya responde, 1 si no.
 *   node scripts/abrir-navegador.mjs <url>               → espera a que responda y abre la página de captación y el panel.
 */
import { spawn } from 'node:child_process';

const [url = 'http://localhost:3000', modo] = process.argv.slice(2);

async function responde() {
  try {
    const respuesta = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    return respuesta.ok;
  } catch {
    return false;
  }
}

function abrir(direccion) {
  const [orden, argumentos] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '""', direccion]]
    : process.platform === 'darwin' ? ['open', [direccion]] : ['xdg-open', [direccion]];
  spawn(orden, argumentos, { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' }).unref();
}

if (modo === '--comprobar') {
  process.exit((await responde()) ? 0 : 1);
}

for (let intento = 0; intento < 120; intento += 1) {
  if (await responde()) {
    console.log([
      '',
      '----------------------------------------------',
      '  Lista. Se abrirán dos pestañas:',
      `  · Página de captación:  ${url}`,
      `  · Panel del despacho:   ${url}/admin   (token: dev-admin)`,
      '',
      '  Es una versión de prueba: los WhatsApp, correos y pagos son simulados.',
      '  Los avisos «Pendiente antes de producción» de arriba son normales en esta versión.',
      '  Deja esta ventana abierta mientras la uses.',
      '  Para detenerla, cierra esta ventana o pulsa Control + C.',
      '----------------------------------------------',
    ].join('\n'));
    abrir(url);
    abrir(`${url}/admin`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log('\nLa herramienta tarda demasiado en responder. Revisa los mensajes de arriba.');
process.exit(1);
