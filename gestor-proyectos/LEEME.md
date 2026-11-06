# Rumbo · Mini gestor de proyectos visual

Aplicación web de un solo archivo (`gestor-proyectos.html`) para organizar proyectos en un tablero Kanban, con tareas dentro de cada proyecto. Funciona entera en el navegador y guarda los datos en su LocalStorage: no hay servidor ni hay nada que instalar.

## Cómo abrirla (doble clic)

1. Descarga el archivo **`gestor-proyectos.html`** y guárdalo donde quieras (por ejemplo, en el Escritorio o en Documentos).
   - Desde GitHub: abre el archivo, pulsa el botón **Download raw file** (icono de descarga) y guárdalo.
2. Haz **doble clic** sobre el archivo. Se abrirá en tu navegador predeterminado (Chrome, Edge, Firefox o Safari).
3. Si se abre con otro programa (un editor de texto, por ejemplo), haz clic derecho sobre el archivo → **Abrir con** → elige tu navegador.

Necesitas conexión a Internet para que carguen el diseño (Tailwind CSS) y las fuentes (Google Fonts), que se descargan de un CDN. Si no hay conexión aparece un aviso; tus datos no se pierden.

## Cómo se usa

| Quiero… | Cómo |
|---|---|
| Crear un proyecto | Botón **Nuevo proyecto**, el **+** de una columna o la tecla **N**. |
| Editar o eliminar un proyecto | Iconos de lápiz y papelera de la tarjeta (aparecen al pasar el ratón) o dentro del detalle. Eliminar pide confirmación y se puede **deshacer** unos segundos. |
| Mover un proyecto de columna | **Arrástralo** y suéltalo en otra columna o en otra posición. En móvil o tableta: **mantén pulsada** la tarjeta un instante y arrástrala. También: cambia el **Estado** en el detalle, o selecciona la tarjeta y pulsa **Alt + ← / →**. |
| Ver el detalle | Haz clic en la tarjeta: se abre una ventana (modal) con la descripción, el estado, el progreso y las tareas. |
| Añadir una tarea | En el detalle, escribe en el campo de tareas y pulsa **Intro**. Si aún no hay tareas, puedes pulsar una de las sugerencias. |
| Completar, editar o eliminar una tarea | Marca la casilla; doble clic sobre el texto (o el lápiz) para editar (**Intro** guarda, **Esc** cancela); la papelera la elimina (con opción de deshacer). |
| Buscar | Escribe en el buscador del tablero o pulsa **/**. Busca en títulos, descripciones y tareas. |
| Probar con datos | Menú **⋯** → **Cargar proyectos de ejemplo** (o **Ver un ejemplo** en la pantalla inicial). |

## Dónde se guardan los datos

- Se guardan automáticamente en el **LocalStorage de ese navegador en ese equipo**. No se envían a ningún sitio.
- Si cambias de navegador o de ordenador, o borras los datos de navegación, no los verás. Para guardar una copia o pasarla a otro equipo usa el menú **⋯** → **Exportar copia (.json)** y, en el otro equipo, **Importar copia**.
- En modo de navegación privada los datos se borran al cerrar la ventana.
- Si abres la aplicación en dos pestañas a la vez, los cambios de una se reflejan en la otra.

## Detalles técnicos

- Un único archivo con HTML, CSS y JavaScript sin dependencias propias.
- Tailwind CSS v4 (build oficial para navegador) cargado desde jsDelivr; fuentes Inter y Manrope desde Google Fonts.
- Arrastrar y soltar con Pointer Events: funciona con ratón, pantalla táctil y lápiz.
- Clave de almacenamiento: `rumbo.kanban.v1`.
