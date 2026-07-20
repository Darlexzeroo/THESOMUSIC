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
