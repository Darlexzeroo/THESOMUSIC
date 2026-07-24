# THESO V106 — Botón de instalación PWA visible

- Botón **Instalar THESO** visible en PC y móvil mientras la app no esté instalada.
- Usa `beforeinstallprompt` cuando Chrome, Edge, Opera o Android permiten instalación directa.
- Muestra instrucciones específicas cuando el navegador todavía no habilita el instalador.
- Guía especial para iPhone/iPad mediante Safari y “Agregar a pantalla de inicio”.
- El botón se oculta automáticamente al ejecutar THESO como aplicación instalada.

# THESO V89 — Estados y chat privado avanzado

Esta versión agrega estados de presencia y nuevas funciones persistentes en los chats privados.

## Novedades

- Estados: En línea, Ausente, En una sala, Escuchando música y Viendo Twitch.
- Responder mensajes.
- Reacciones rápidas.
- Editar y eliminar mensajes propios.
- Indicador “Escribiendo…”.
- Confirmación de mensajes leídos.
- Separadores de fecha por día.
- Búsqueda dentro del chat abierto.

Los cambios de mensajes, reacciones y lecturas se guardan en MongoDB Atlas. Los invitados continúan limitados al chat de las salas.

# THESO V55

Cambios principales:

- El tema rojo, azul, morado o personalizado ahora se aplica también a los brillos, bordes, reproductor, indicadores, botones y estados que antes permanecían verdes.
- El reproductor usa el color principal configurado por el usuario.
- El chat lateral de la sala es más alto y el panel derecho es un poco más ancho en pantallas grandes.
- Las imágenes del chat aprovechan mejor el espacio disponible.

Después de actualizar el proyecto, usa `Ctrl + F5` para limpiar la caché del navegador.

## V58 — Twitch y correcciones del reproductor

### Variables necesarias en Render

Para buscar videos de YouTube:

- `YOUTUBE_API_KEY`

Para buscar canales en vivo de Twitch:

- `TWITCH_CLIENT_ID`
- `TWITCH_CLIENT_SECRET`

Las credenciales de Twitch se crean desde la consola de desarrolladores de Twitch registrando una aplicación. Los enlaces directos `https://twitch.tv/canal` se pueden agregar desde el campo de enlaces. La reproducción embebida requiere que la web esté servida por HTTP/HTTPS; el dominio se configura automáticamente mediante el parámetro `parent`.

### Cambios

- El indicador de voz usa el color del tema activo.
- Un solo botón alterna entre Play y Pausa.
- Pestañas independientes para YouTube y Twitch.
- Búsqueda de canales de Twitch que estén en directo.
- Tarjetas con título, categoría, espectadores y etiqueta EN VIVO.
- Los directos pueden agregarse a la cola o reproducirse inmediatamente.
- Detección de enlaces directos de YouTube y Twitch.

## Inicio de sesión con Discord (V74)

En Discord Developer Portal, abre tu aplicación y agrega esta URL en **OAuth2 > Redirects**:

```text
https://thesomusic.onrender.com/auth/discord/callback
```

En Render agrega estas variables de entorno:

```env
DISCORD_CLIENT_ID=ID_DE_LA_APLICACION
DISCORD_CLIENT_SECRET=SECRETO_DE_LA_APLICACION
DISCORD_REDIRECT_URI=https://thesomusic.onrender.com/auth/discord/callback
SESSION_SECRET=UNA_CLAVE_LARGA_Y_ALEATORIA
```

El secreto de Discord y `SESSION_SECRET` nunca deben escribirse en `public/app.js`, `public/index.html` ni subirse a GitHub.

## V75 - Pantalla de acceso
- Pantalla inicial con acceso mediante Discord o como invitado.
- Los invitados deben elegir un nombre antes de entrar.
- Perfiles locales de invitado separados del perfil de Discord.
- Discord usa siempre el nombre y avatar recibidos de la cuenta, sin mezclar la foto local anterior.
- Cerrar sesión vuelve a mostrar la pantalla de acceso.


## V77
- Favicon propio de THESO y título corto en la pestaña.
- Mejoras responsive para móvil, tablet y escritorio.
- Invitaciones directas a salas desde los chats privados.
- Notificaciones visuales y sonoras de invitaciones.

Nota: Spotify no se habilita en esta versión porque su reproducción sincronizada requiere OAuth, una aplicación de Spotify y restricciones del Web Playback SDK.


## V79 - MongoDB Atlas, amigos y chats privados permanentes

Esta versión agrega persistencia real para usuarios que inician sesión con Discord:

- Solicitudes de amistad desde la lista de usuarios de una sala.
- Aceptar o rechazar solicitudes desde el panel **Amigos**.
- Lista de amigos disponible aunque salgan de la sala.
- Conversaciones privadas guardadas en MongoDB Atlas.
- Historial recuperable al cerrar el navegador, cambiar de dispositivo o reiniciar Render.
- Los invitados conservan únicamente chats temporales del navegador/servidor y no pueden crear amistades permanentes.

### Configuración gratuita de MongoDB Atlas

1. Crea una cuenta en MongoDB Atlas y un clúster gratuito.
2. En **Database Access**, crea un usuario de base de datos.
3. En **Network Access**, permite el acceso desde Render. Para una prueba inicial puedes usar `0.0.0.0/0` y una contraseña fuerte.
4. Copia la cadena de conexión y reemplaza `<password>` por la contraseña real.
5. En Render abre **Environment** y agrega:

```env
MONGODB_URI=mongodb+srv://USUARIO:CONTRASEÑA@CLUSTER.mongodb.net/theso?retryWrites=true&w=majority
```

No escribas `MONGODB_URI` en archivos públicos ni la subas a GitHub.

### Variables necesarias en Render

```env
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
DISCORD_REDIRECT_URI=https://thesomusic.onrender.com/auth/discord/callback
SESSION_SECRET=...
MONGODB_URI=...
YOUTUBE_API_KEY=...
```

Puedes revisar la conexión visitando `/api/database/status`. Debe responder `connected: true`.


## V80 - Separación de cuentas Discord e invitado

- Amigos, solicitudes y conversaciones de Discord se limpian al cambiar de cuenta.
- El invitado ya no hereda contactos guardados de una cuenta Discord.
- Al volver a Discord, amigos y chats se cargan nuevamente desde MongoDB Atlas.
- Socket.IO se reconecta después de cerrar sesión para actualizar la identidad del servidor.
- La lista de conversaciones se reemplaza por cuenta en vez de mezclar datos anteriores.

## V81 · Cambio de cuenta y salas

Al cerrar Discord o cambiar entre Discord e invitado, THESO abandona automáticamente la sala activa, limpia la interfaz de la sala y reconecta Socket.IO con la nueva identidad. Esto evita que el modo invitado conserve visualmente el usuario, rol o sala de la cuenta Discord anterior.


## V82
- Corrige el aviso falso de MongoDB desconectado.
- El cliente verifica `/api/database/status` directamente.
- Los errores de carga de amigos ya no se confunden con una caída de la base de datos.


## V83 - Amigos y conversaciones
- Evita que la interfaz quede atrapada en “Comprobando conexión”.
- Carga amigos y solicitudes después de registrar el socket.
- Añade tiempos de espera y reintentos seguros.
- Actualiza conversaciones al recibir solicitudes.


## V84 - Notificaciones separadas por cuenta

- La campana, los avisos privados y los contadores se limpian al cerrar sesión o cambiar de cuenta.
- El modo invitado ignora mensajes y solicitudes retrasados del socket de una cuenta Discord anterior.
- Al volver a Discord, las notificaciones nuevas corresponden únicamente a esa cuenta.

## V85 - Restricciones para invitados

- Los invitados solo pueden participar en chats de sala.
- No pueden enviar ni recibir solicitudes de amistad.
- No pueden abrir, enviar ni recibir mensajes privados.
- No pueden usar llamadas privadas.
- El botón de Amigos y los botones `+` se ocultan en modo invitado.
- El servidor también valida estas restricciones para impedir que se evadan desde el navegador.


## V88
- El login inicia oculto desde el HTML.
- CSS crítico inline evita que el formulario se pinte antes de cargar la hoja de estilos.
- La comprobación de sesión conserva la pantalla de arranque y solo muestra el login cuando el servidor confirma que no hay sesión.


## V90 - Estados de reproducción corregidos

- El estado se actualiza cuando YouTube realmente entra en reproducción.
- Twitch reporta `Viendo Twitch` cuando el directo está activo.
- Al pausar, terminar o salir de la sala vuelve a `En una sala` o `En línea`.
- Estados con iconos y colores en la lista de amigos.
- Se eliminaron las confirmaciones visuales `Enviado` y `Leído`.


## V91 - Invitaciones, roles y votación
- Invitaciones persistentes dentro del chat privado con botón Unirse.
- Roles: Anfitrión, Moderador, DJ, Oyente, Invitado y Silenciado.
- Permisos por usuario para pausar, saltar, borrar cola, agregar Twitch y expulsar.
- Votación para saltar con umbral del 60% de participantes elegibles.
- Validaciones del lado del servidor para impedir saltarse permisos desde el navegador.

## V95 — Aurora UI Refresh

- Rediseño visual completo para escritorio y móvil sin modificar IDs ni eventos existentes.
- Paneles con acabado translúcido, navegación más limpia y mejor jerarquía visual.
- Reproductor flotante renovado y cola/chat más claros.
- Diseño responsive para tablet y móvil con controles táctiles más cómodos.
- Conserva las funciones de V91: invitaciones, roles, permisos y votación para saltar.


## V96 - Corrección visual
- Los colores Aurora ahora usan las variables de todos los temas existentes.
- Se eliminó la barra superior vacía.
- Perfil y notificaciones quedaron flotando en la esquina superior derecha.
- Se conservan IDs, eventos y funciones de la V91.


## V97 — Menú y creador de salas refinados
- Botón de contraer menú rediseñado.
- Formulario de sala reorganizado y más compacto.
- Perfil y notificaciones superiores alineados y simplificados.
- Colores compatibles con todos los temas.


## THESO V98
- Perfil superior unificado y compacto, sin bordes dobles.
- Botón de notificaciones integrado visualmente con el perfil.
- Selector de tipo de sala completamente rediseñado y compatible con temas.


## V99
- Selector de tipo de sala personalizado, sin menú nativo del navegador.
- Opciones Pública y Privada con descripción, iconos y estilos compatibles con los temas.


## THESO V100
- Eliminado el doble fondo del selector de tipo de sala.
- Menú desplegable corregido para no superponerse con controles vecinos.
- Perfil superior rediseñado para mostrar foto y banner guardados.
- Mejoras de capas, contraste y adaptación móvil.


## V101
- Barra lateral contraída rediseñada como dock compacto.
- Oculta correctamente los paneles de sala al guardar el menú.
- Tooltips limpios para los iconos.
- Selector de tipo de sala más compacto, sin bordes duplicados y con despliegue refinado.


## V103
- Corrige la previsualización de foto y banner en Personalización.
- Rediseña la tarjeta de perfil con avatar superpuesto, banner real y controles limpios.


## V104
- Corrige la aplicación inmediata y persistente del banner en la vista de perfil.
- Rediseña los botones de edición de foto y banner con iconos discretos de cámara.
- Actualiza todas las vistas del perfil al aplicar o quitar una imagen.


## V105 · PWA instalable
- Instalación en Windows y Android mediante el aviso del navegador.
- Compatibilidad con Agregar a pantalla de inicio en iPhone/iPad.
- Manifest, iconos, modo standalone y service worker.
- La API, autenticación y Socket.IO quedan fuera de la caché para evitar sesiones desactualizadas.


## V107
- Botón Instalar THESO visible dentro del menú lateral.
- Indicador cuando la PWA está lista para instalar.
- Caché PWA actualizado con estrategia de red primero para evitar archivos viejos.

## V108
- La barra de reproducción dejó de ser flotante y ahora aparece integrada justo debajo del video.
- La cola usa toda la altura disponible, tiene scroll interno y muestra cada canción completa.
- Se corrigieron miniaturas, textos truncados y botones de eliminación de la cola.
- Ajustes responsive para PC, tablet y móvil.
