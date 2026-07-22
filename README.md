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
