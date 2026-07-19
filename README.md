# WaveRoom YouTube

Versión de WaveRoom que reproduce videos con el reproductor oficial de YouTube.

## Funciones

- Pegar enlaces de YouTube.
- Reproducción individual.
- Crear salas con código.
- Unirse desde otros dispositivos.
- Sincronización de reproducción, pausa y tiempo.
- Cola compartida.
- Chat.
- Cambio automático de anfitrión.
- Sin necesidad de una clave API para pegar enlaces.

## Ejecutar en Windows PowerShell

Descomprime el ZIP y abre PowerShell dentro de la carpeta.

```powershell
npm.cmd install
npm.cmd start
```

Abre:

```text
http://localhost:3000
```

## Probar con amigos en la misma red Wi-Fi

1. Ejecuta `ipconfig`.
2. Busca la dirección IPv4 de tu computadora, por ejemplo `192.168.1.25`.
3. Tus amigos abren:

```text
http://192.168.1.25:3000
```

Puede ser necesario permitir Node.js en el Firewall de Windows.

## Enlaces compatibles

```text
https://www.youtube.com/watch?v=XXXXXXXXXXX
https://youtu.be/XXXXXXXXXXX
https://www.youtube.com/shorts/XXXXXXXXXXX
```

## Nota sobre autoplay

Algunos navegadores bloquean la reproducción automática hasta que el usuario pulsa una vez el reproductor. Si un invitado no escucha nada, debe pulsar “Reproducir” o interactuar una vez con la página.

## Búsqueda por nombre

Esta versión acepta enlaces de YouTube sin clave API. Para buscar canciones directamente por texto se necesita una clave de YouTube Data API v3 y protegerla mediante el servidor.


## Correcciones de esta versión

- Ya no se carga ningún video predeterminado.
- Al pegar una canción se intenta reproducir automáticamente.
- Al entrar a una sala se carga inmediatamente el video activo y su tiempo actual.
- Si el navegador bloquea el autoplay con sonido, aparecerá el botón **Activar reproducción**. Solo se necesita pulsar una vez por pestaña.


# Búsqueda por nombre

Esta versión permite buscar canciones directamente por nombre usando la API oficial de YouTube Data API v3.

## Crear la clave de YouTube

1. Entra a Google Cloud Console.
2. Crea o selecciona un proyecto.
3. Activa **YouTube Data API v3**.
4. Abre **Credenciales**.
5. Crea una **API key**.
6. No escribas la clave dentro de `public/app.js`.

## Configurar en Render

En tu servicio de Render abre:

```text
Environment
```

Agrega:

```text
Key: YOUTUBE_API_KEY
Value: TU_CLAVE_DE_GOOGLE
```

Guarda los cambios. Render volverá a desplegar automáticamente.

## Configurar en tu computadora

PowerShell:

```powershell
$env:YOUTUBE_API_KEY="TU_CLAVE_DE_GOOGLE"
npm.cmd start
```

La clave permanece solo durante esa sesión de PowerShell.

## Reproducción automática

Cuando el anfitrión pulsa un resultado de búsqueda, el video comienza automáticamente. Los invitados reciben el cambio por Socket.IO.

Los navegadores pueden bloquear el primer autoplay con sonido de una pestaña nueva. En ese caso, cada invitado pulsa **Activar reproducción** una sola vez; después los cambios de canción se reproducen automáticamente.


## Resultados y cola

Los resultados de búsqueda ahora tienen dos acciones:

- **Agregar a cola:** guarda la canción para después y no interrumpe la reproducción actual.
- **Reproducir ahora:** reemplaza la canción actual; dentro de una sala solo puede usarlo el anfitrión.

Cuando una canción termina, el anfitrión solicita automáticamente la siguiente canción de la cola.

## Publicar en Render

Este proyecto incluye `render.yaml` y está listo para desplegarse como **Web Service**.

1. Sube todos los archivos del proyecto a GitHub.
2. En Render selecciona **New > Blueprint** y conecta el repositorio.
3. Render detectará `render.yaml`.
4. Agrega la variable `YOUTUBE_API_KEY` cuando Render la solicite.
5. Finaliza la creación y espera el despliegue.

También puedes crearlo manualmente como Web Service usando:

```text
Build Command: npm ci
Start Command: npm start
Health Check Path: /health
```

No agregues `PORT` manualmente: Render lo proporciona automáticamente.

## Chat de voz
Esta versión incluye chat de voz P2P con WebRTC. Los usuarios deben entrar a una sala, pulsar "Entrar al chat de voz" y permitir el micrófono. Funciona sobre HTTPS, como el dominio que proporciona Render.

## Versión 13: adaptación móvil de salas

En pantallas de hasta 820 px, el bloque para crear una sala o introducir un código se muestra como una tarjeta en la parte superior. También se mantienen visibles los controles de la sala activa y el acceso al perfil.


## V14 - Volúmenes separados
- El volumen de la música controla únicamente YouTube.
- El volumen de voces controla únicamente el audio recibido del chat WebRTC.
- Ambos valores se guardan en el navegador y el control de música permanece visible en móvil.


## V15: voz activa y volumen individual
- El icono de cada participante se ilumina cuando habla.
- Cada participante remoto tiene un control de volumen individual de 0% a 200%.
- El volumen general del chat de voz sigue funcionando de manera independiente.
- Los niveles individuales quedan guardados en el navegador.

## V17
Se corrigió el desbordamiento del chat de voz y del chat de texto en el panel derecho.

## V21 - Filtro anti ruido mejorado

Se agregó procesamiento avanzado de voz con cancelación de eco, reducción de ruido del navegador, filtro pasa-altos, filtro pasa-bajos, realce de presencia y compresión de picos.

## Versión V28
- El chat de la sala mantiene una altura fija y los mensajes se desplazan dentro del panel.
- El área para escribir permanece visible aunque se envíen muchas imágenes o mensajes.


## V29
- Los chats privados conservan hasta 150 mensajes por conversación usando una identidad estable guardada en el navegador.
- Los mensajes siguen disponibles al salir y volver a entrar mientras el almacenamiento del servidor se conserve.
- Selector de emotes corregido para no salirse del panel.
- Filtro de voz mejorado con cancelación nativa del navegador, ecualización, compresión y puerta de ruido adaptativa.


## V34
Se corrigió la estructura del chat privado: encabezado y controles de llamada fijos arriba, mensajes con scroll interno y compositor fijo abajo.
