# Plan de soporte WebSocket nativo

Estado: propuesta de implementación para revisión antes de escribir código WebSocket.

Fecha: 2026-08-05.

## 1. Objetivo

Agregar WebSockets server-side a S42-Core sobre el mismo `Bun.serve()` y el
mismo puerto que HTTP, sin servidores sidecar ni dependencias externas. La API
debe conservar el modelo Bun-first, permitir varias rutas WebSocket, mantener
`ws.data` tipado por ruta y ofrecer una integración natural con `Server` y
`Modules`.

El resultado debe cubrir el ciclo completo:

- handshake y autenticación antes del `101 Switching Protocols`;
- `open`, `message`, `drain`, `close`, `ping` y `pong`;
- mensajes de texto y binarios sin transformaciones implícitas;
- backpressure, compresión, límites e idle timeout nativos;
- pub/sub nativo de Bun;
- publicación desde eventos externos al socket;
- cierre y métricas operativas;
- carga por convención desde módulos;
- documentación EN/ES, website, tests y preparación de release.

## 2. Estado actual verificado

- `Server` ya es dueño de `Bun.serve()`, pero su `fetch` ignora el segundo
  argumento `Bun.Server` y no puede llamar a `server.upgrade()`.
- El handle nativo está guardado como `Bun.Server<undefined>` y sólo se usa para
  `getPort()` y `getURL()`.
- `RouteControllers` resuelve exclusivamente HTTP y genera tanto el mapa
  `routes` nativo como el fallback `fetch`.
- `Modules` descubre controllers HTTP y eventos, pero no rutas WebSocket.
- S42-Core no expone hoy `stop()`, `publish()`, `subscriberCount()` ni
  `pendingWebSockets`.
- Bun recibe un único `WebSocketHandler` por servidor. Para soportar varias
  rutas, S42-Core necesita un dispatcher compartido en lugar de instalar
  listeners por conexión.
- El proyecto ejecuta Bun 1.3.14. Sus tipos instalados incluyen `open`,
  `message`, `drain`, `close`, `ping` y `pong`, pero no incluyen el callback
  nativo `error` que aparece mencionado en parte de la documentación web. La
  primera versión no dependerá de esa discrepancia: S42-Core capturará los
  errores de sus propios callbacks mediante `handleError`.

Referencias oficiales usadas para este diseño:

- [WebSockets en Bun](https://bun.com/docs/runtime/http/websockets)
- [Servidor y lifecycle](https://bun.com/docs/runtime/http/server)
- [Métricas HTTP/WebSocket](https://bun.com/docs/runtime/http/metrics)
- [Cluster con `reusePort`](https://bun.com/docs/guides/http/cluster)

## 3. Alcance de la primera versión

### Incluido

- varias rutas WebSocket en un mismo servidor;
- paths exactos, parámetros `:param` y wildcard terminal `*`;
- contexto tipado por conexión mediante `ws.data`;
- rechazo HTTP del handshake con cualquier `Response` antes del upgrade;
- headers de respuesta del upgrade, incluido `Set-Cookie` o
  `Sec-WebSocket-Protocol`;
- handlers Bun-like y un `handleError` propio;
- configuración global de WebSocket derivada de las opciones nativas de Bun;
- pub/sub y estado operativo expuestos desde `Server`;
- cierre coordinado de las conexiones conocidas por S42-Core;
- descubrimiento `websockets/**/*.ts` en módulos `full`;
- estadísticas de rutas y conexiones por proceso;
- tests unitarios, de tipos e integración con clientes reales.

### Fuera de alcance

- cliente WebSocket para browser o Bun;
- protocolo RPC, envelopes JSON, validación de schemas o serialización
  automática;
- reintentos, heartbeats de aplicación, presence o persistencia de mensajes;
- autenticación o autorización concreta del producto;
- rate limiting automático;
- pub/sub global entre procesos, hosts o regiones;
- reemplazar Redis, SQS o `EventsDomain` como bus distribuido;
- configurar Nginx, Cloudflare, ALB, TLS o certificados;
- hot reload del `WebSocketHandler` (Bun no lo actualiza con
  `server.reload()`);
- reutilizar automáticamente los hooks/middlewares HTTP actuales dentro del
  lifecycle WebSocket.

## 4. API pública propuesta

### 4.1 `WebSocketController<TData>`

Cada instancia representa una ruta y mantiene el tipo de datos de sus
conexiones.

```ts
import { logger, Server, WebSocketController, WebSocketControllers } from 's42-core'

type ChatSocketData = {
	userId: string
	roomId: string
}

const chat = new WebSocketController<ChatSocketData>({
	path: '/ws/chat/:roomId',

	async upgrade({ request, params }) {
		const session = await authenticate(request)
		if (!session) {
			return Response.json({ error: 'Unauthorized' }, { status: 401 })
		}

		if (!isAllowedOrigin(request.headers.get('origin'))) {
			return Response.json({ error: 'Forbidden' }, { status: 403 })
		}

		return {
			data: {
				userId: session.userId,
				roomId: params.roomId,
			},
			headers: {
				'Set-Cookie': createRefreshCookie(session),
			},
		}
	},

	open(ws) {
		ws.subscribe(`chat:${ws.data.roomId}`)
	},

	message(ws, message) {
		const status = ws.publish(
			`chat:${ws.data.roomId}`,
			`${ws.data.userId}: ${String(message)}`,
		)

		if (status === -1) {
			// El mensaje quedó encolado y hay backpressure.
		}
	},

	drain(ws) {
		// Reanudar aquí una cola propia, si la aplicación usa una.
	},

	close(ws) {
		ws.unsubscribe(`chat:${ws.data.roomId}`)
	},

	handleError(error, { phase, ws }) {
		logger.error(`WebSocket ${phase} failed`, error)
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.close(1011, 'Internal server error')
		}
	},
})

const sockets = new WebSocketControllers([chat], {
	maxPayloadLength: 1024 * 1024,
	idleTimeout: 60,
	backpressureLimit: 1024 * 1024,
	closeOnBackpressureLimit: true,
	perMessageDeflate: true,
})

const server = new Server()
await server.start({
	port: 5678,
	RouteControllers: httpRoutes,
	WebSocketControllers: sockets,
})
```

`upgrade` será obligatorio. Esto hace explícita la decisión de aceptar una
conexión, incluso en endpoints públicos:

```ts
const echo = new WebSocketController({
	path: '/ws/echo',
	upgrade: () => ({ data: {} }),
	message: (ws, message) => ws.send(message),
})
```

No habrá aceptación implícita si el desarrollador olvida configurar
autenticación.

### 4.2 Contratos principales

```ts
export type WebSocketData = Record<string, unknown>

export type WebSocketUpgradeContext = {
	request: Request
	url: URL
	params: Readonly<Record<string, string>>
	query: URLSearchParams
	remoteAddress: Bun.SocketAddress | null
}

export type WebSocketUpgradeAccept<TData extends WebSocketData> = {
	data: TData
	headers?: HeadersInit
}

export type WebSocketUpgradeResult<TData extends WebSocketData> =
	| WebSocketUpgradeAccept<TData>
	| Response

export type WebSocketErrorPhase =
	| 'upgrade'
	| 'open'
	| 'message'
	| 'drain'
	| 'close'
	| 'ping'
	| 'pong'
```

Los tipos concretos de socket, mensaje, compresión y resultado de envío se
derivarán de `Bun.ServerWebSocket` y `Bun.WebSocketHandler`; no se copiarán
uniones que puedan quedar desactualizadas respecto de Bun.

Los callbacks conservarán la forma nativa:

- `open?(ws)`
- `message?(ws, message)`
- `drain?(ws)`
- `close?(ws, code, reason)`
- `ping?(ws, data)`
- `pong?(ws, data)`
- `handleError?(error, context)`

`message` será opcional para permitir sockets exclusivamente server-push. El
dispatcher global siempre implementará el `message` requerido por Bun y hará
no-op cuando la ruta no lo haya definido.

### 4.3 Resultado de `upgrade`

- Un objeto `{ data, headers? }` acepta el handshake.
- Un `Response` lo rechaza antes del `101`; se conserva su status, body y
  headers.
- Una excepción pasa por `handleError` con fase `upgrade`. Si el handler no
  devuelve una respuesta, S42-Core responde `500` genérico sin exponer el
  mensaje ni stack.
- Si `Bun.Server.upgrade()` devuelve `false`, S42-Core responde `400 WebSocket
upgrade failed`.
- `data` debe ser un objeto no nulo. No se aceptarán primitives porque el
  dispatcher necesita asociar metadata interna durante el handshake.

### 4.4 Configuración global

`WebSocketControllers` aceptará únicamente las opciones globales del handler
nativo que el framework no necesita reservar:

```ts
export type WebSocketServerOptions = Pick<
	Bun.WebSocketHandler<unknown>,
	| 'maxPayloadLength'
	| 'backpressureLimit'
	| 'closeOnBackpressureLimit'
	| 'idleTimeout'
	| 'publishToSelf'
	| 'sendPings'
	| 'perMessageDeflate'
>
```

Los callbacks y `data` quedan bajo control del dispatcher. La primera versión
no cambiará silenciosamente los defaults de Bun: la documentación y los
ejemplos usarán límites conservadores explícitos.

Estas opciones son por servidor, no por ruta. S42-Core no simulará límites ni
compresión diferentes para cada controller cuando Bun no ofrece esa semántica.

### 4.5 Métodos nuevos de `Server`

```ts
server.publish(topic, data, compress?)
server.subscriberCount(topic)
server.getPendingWebSockets()
server.closeWebSockets(code?, reason?)
await server.stop(force?)
```

- `publish()` y `subscriberCount()` delegan al handle nativo y lanzan un error
  claro si el server no fue iniciado.
- `getPendingWebSockets()` devuelve `0` antes del inicio o después del stop.
- `closeWebSockets()` envía un close frame a cada conexión registrada, usa por
  defecto código `1001` y devuelve la cantidad alcanzada.
- `stop(false)` conserva la semántica graceful de Bun y puede esperar mientras
  queden sockets abiertos.
- `stop(true)` fuerza el cierre de requests y sockets activos.
- El cierre graceful recomendado será primero `closeWebSockets()` y luego
  `stop()`, con un timeout de aplicación que pueda terminar en `stop(true)`.

No se expondrá el handle completo de Bun en esta entrega; se agregarán las
operaciones necesarias de forma tipada.

## 5. Diseño interno

### 5.1 Componentes

```text
Server
├── RouteControllers              HTTP
├── WebSocketControllers          routing + dispatcher singleton
│   ├── WebSocketController A     /ws/chat/:roomId
│   └── WebSocketController B     /ws/metrics
└── Bun.serve
    ├── routes/fetch              handshake antes del dispatch HTTP
    └── websocket                 un único WebSocketHandler
```

Archivos previstos:

- `src/WebSocketController/index.ts`
- `src/WebSocketController/types.ts`
- `src/WebSocketController/index.test.ts`
- `src/WebSocketControllers/index.ts`
- `src/WebSocketControllers/types.ts`
- `src/WebSocketControllers/index.test.ts`
- `src/Server/index.ts`
- `src/Server/types.ts`
- `src/Server/index.test.ts`
- `src/Modules/index.ts`
- `src/Modules/index.test.ts`
- `src/CoreStats/index.ts`
- `src/CoreStats/index.test.ts`
- `src/index.ts`

Los nombres definitivos sólo cambiarán si TypeScript demuestra una colisión con
el `WebSocket` global; no se creará una abstracción cliente.

### 5.2 Routing del handshake

El handshake se intentará sólo cuando:

- el método sea `GET`;
- `Upgrade` sea `websocket`, comparado sin distinguir mayúsculas;
- exista una ruta WebSocket compatible con el pathname.

Si no hay match, la request continúa por HTTP sin cambios. Una request HTTP
normal a un path WebSocket también continúa por HTTP y obtiene la respuesta que
ya corresponda, normalmente `404`.

El mapa `routes` nativo de Bun tiene precedencia sobre `fetch`. Para que un
controller HTTP nunca intercepte por accidente un upgrade, `Server` compondrá
los handlers de esta forma:

1. envolverá cada handler HTTP `GET` del mapa nativo para intentar primero el
   upgrade WebSocket;
2. agregará entradas `GET` para los paths WebSocket que no existan en el mapa
   HTTP;
3. repetirá el mismo intento al inicio del fallback `fetch`;
4. sólo ejecutará el callback HTTP cuando el dispatcher indique `matched:
false`.

Así funcionan correctamente los solapamientos entre rutas exactas y
parametrizadas sin desactivar el router nativo de Bun ni degradar todo HTTP al
fallback.

El matcher WebSocket tendrá reglas deterministas:

1. exactas;
2. parametrizadas;
3. wildcard terminal.

Se rechazarán al construir el registry los paths duplicados y las formas
ambiguas equivalentes, por ejemplo `/rooms/:id` y `/rooms/:name`. Los parámetros
se entregarán en `upgrade`; la aplicación decide cuáles persiste en `data`.

### 5.3 Dispatch sin degradar `ws.data`

Bun exige un handler compartido, pero la API pública debe permitir:

```ts
ws.data.userId
```

en lugar de:

```ts
ws.data.framework.route.data.userId
```

El mecanismo será:

1. copiar superficialmente el objeto `data` aceptado;
2. adjuntar con un `Symbol` privado y no enumerable la ruta interna;
3. pasarlo a `server.upgrade()`;
4. en el callback global `open`, registrar `socket -> controller` en un
   `WeakMap` antes de invocar el `open` de usuario;
5. eliminar la metadata transitoria del objeto público;
6. resolver los eventos posteriores desde el `WeakMap`;
7. mantener un `Set` de sockets activos para métricas y cierre; eliminar cada
   socket en `close` aun si el callback del usuario falla.

Esto conserva el objeto plano y tipado que espera la aplicación. También
permite que Bun y el usuario muten o reasignen `ws.data` después de `open` sin
romper el routing del dispatcher.

Habrá un test de integración específico que demuestre que Bun conserva la
metadata durante `upgrade -> open`; no se dará por supuesto únicamente a partir
de los tipos.

### 5.4 Errores

Todos los callbacks de aplicación se ejecutarán dentro de una frontera async
común.

- `upgrade`: `handleError` puede devolver un `Response`; el fallback es `500`
  sanitizado.
- `open`, `message`, `drain`, `ping`, `pong`: el fallback registra el error y
  cierra con `1011` y un reason genérico.
- `close`: el fallback sólo registra porque la conexión ya está cerrándose.
- El framework nunca enviará stack, tokens, payloads ni el texto original del
  error al cliente.
- Un fallo de `handleError` se registra y cae en el comportamiento seguro por
  defecto.

No se expondrá un callback llamado `error` hasta que la API runtime y los tipos
del mínimo Bun soportado coincidan. `handleError` cubre errores lanzados por
código de aplicación; no promete representar errores internos de transporte
que Bun no entregue al handler tipado.

### 5.5 Backpressure

S42-Core devolverá sin alterar los resultados nativos de `send()` y
`publish()`:

- `-1`: encolado con backpressure;
- `0`: descartado por estado de la conexión;
- `> 0`: bytes enviados.

No habrá reintentos ni colas ilimitadas automáticas. La aplicación podrá pausar
su productor al recibir `-1` y reanudarlo en `drain`. Se documentarán
`backpressureLimit`, `closeOnBackpressureLimit` y `getBufferedAmount()`.

### 5.6 Pub/sub

- `ws.subscribe()`, `unsubscribe()`, `isSubscribed()`, `subscriptions`,
  `publish()` y `cork()` permanecen disponibles en el socket nativo.
- `ws.publish()` mantiene la semántica de Bun respecto del emisor y
  `publishToSelf`.
- `server.publish()` permite publicar desde un controller HTTP, un evento de
  dominio, un timer o cualquier otro productor que conserve la instancia de
  `Server`.
- Los topics son strings de aplicación. El framework no agregará prefijos ni
  reescribirá nombres silenciosamente.

## 6. Integración con `Modules`

Los módulos `full` podrán incluir:

```text
modules/chat/
├── __module__.ts
├── controllers/
├── events/
└── websockets/
    └── chat.ts
```

Ejemplo:

```ts
import type { ModuleWebSocketControllerDefinition } from 's42-core'

type ChatData = {
	userId: string
	roomId: string
}

export default {
	name: 'chat.socket',
	version: '1.0.0',
	enabled: true,
	path: '/ws/chat/:roomId',
	upgrade: async ({ request, params }) => {
		const session = await authenticate(request)
		if (!session) return new Response('Unauthorized', { status: 401 })

		return {
			data: { userId: session.userId, roomId: params.roomId },
		}
	},
	message: (ws, message) => {
		ws.publish(`chat:${ws.data.roomId}`, message)
	},
} satisfies ModuleWebSocketControllerDefinition<ChatData>
```

Cambios del loader:

- `Modules.load()` escaneará `websockets/**/*.ts` en módulos `full`;
- `enabled: false` omitirá la definición antes de construirla;
- una definición inválida hará fallar `load()` con archivo y motivo;
- la ausencia del directorio será válida;
- `share` ignorará `websockets/` con warning, igual que otros directorios no
  compatibles;
- se agregará `modules.getWebSocketControllers()`;
- el bootstrap usará
  `new WebSocketControllers(modules.getWebSocketControllers(), options)`.

Los middleware `mws`, `hooks` de `Server` y `requireBefore/requireAfter` son
HTTP-specific y no se ejecutarán en WebSocket. Su contrato actual no puede
rechazar de forma segura un handshake porque auto-avanza aunque no se llame
`next()`. La autenticación y autorización WebSocket deben vivir en `upgrade`.

La primera entrega tampoco inyectará automáticamente `events.emit()` en los
handlers WebSocket. Un módulo puede capturar `EventsDomain`, `Dependencies` o
`Server` mediante su composición normal. Diseñar un contexto común para HTTP,
eventos y WebSocket será un cambio posterior y separado.

## 7. Cluster y distribución

Con `clustering: true`, `reusePort` distribuye conexiones nuevas entre procesos
en Linux. Una conexión ya aceptada permanece en su worker.

Por lo tanto, son locales al proceso:

- el registry de sockets;
- `pendingWebSockets`;
- `subscriberCount(topic)`;
- `ws.subscribe()` y el pub/sub nativo;
- `server.publish()`;
- `closeWebSockets()`.

La primera versión no anunciará broadcasting global. Para rooms entre workers o
hosts, la aplicación debe usar Redis, SQS, `EventsDomain` u otro adapter externo
y publicar el evento recibido dentro de cada worker. Ese bridge debe evitar
loops y respetar la semántica de entrega elegida; no se activará implícitamente.

La documentación de `CLUSTER` incluirá esta frontera y aclarará que
`reusePort` se ignora en macOS y Windows según Bun.

## 8. Seguridad

Checklist obligatorio de documentación y tests:

- validar sesión y autorización antes de llamar a `server.upgrade()`;
- devolver `401` o `403` como `Response`, no aceptar y cerrar después;
- validar `Origin` cuando el browser autentica con cookies;
- preferir cookies `HttpOnly`, `Secure` y `SameSite` correctamente configuradas
  o tickets de WebSocket cortos, de un solo uso y con expiración;
- no colocar JWTs o credenciales duraderas en query params porque URLs pueden
  quedar en history, proxies, CDN, APM y logs;
- recordar que browsers no permiten headers arbitrarios en `new WebSocket()`;
- negociar subprotocolos inspeccionando `Sec-WebSocket-Protocol` y devolviendo
  solamente uno permitido en headers del upgrade;
- configurar `maxPayloadLength`, backpressure e idle timeout según el caso;
- validar el formato del mensaje en la aplicación antes de usarlo;
- usar `wss://` en producción, directo o terminado en un reverse proxy;
- confiar en `X-Forwarded-For` sólo detrás de proxies conocidos;
- no registrar cookies, tokens, query strings completas, payloads sensibles ni
  `ws.data` completo;
- mantener close reasons breves, sanitizados y dentro del límite del protocolo;
- documentar que los hooks HTTP globales no autorizan endpoints WebSocket.

S42-Core no inferirá códigos HTTP a partir del texto de una excepción. El
controller debe devolver el rechazo esperado de forma explícita.

## 9. Observabilidad

Se agregarán:

- `getWebSocketControllersStats()` con paths y cantidad de controllers;
- sockets activos por proceso;
- `Server.getPendingWebSockets()` y `Server.subscriberCount(topic)`;
- campos aditivos en `CoreStatsPayload` para controllers y conexiones
  WebSocket.

No se expondrán topics, IPs, headers, `ws.data` ni información de sesión en
`CoreStats`. En cluster, el payload seguirá describiendo únicamente el worker
que respondió.

Los logs incluirán ruta y fase, pero no el contenido del mensaje ni datos de
autenticación.

## 10. Plan de implementación

### Fase 0 — Baseline y compatibilidad

- [ ] Registrar estado de git y preservar cambios ajenos/no relacionados.
- [ ] Ejecutar baseline de typecheck, lint y tests.
- [ ] Verificar el contrato mínimo necesario contra Bun 1.3.x y los tipos
      instalados.
- [ ] Crear un spike descartable que confirme `upgrade`, `data`, headers,
      mensajes binarios, ping/pong, pub/sub y stop en Bun 1.3.14.
- [ ] No ampliar el uso de APIs que requieran subir `engines.bun`; si aparece
      una necesidad real, documentarla y solicitar decisión antes de cambiar el
      mínimo.

### Fase 1 — Controller y tipos

- [ ] Crear `WebSocketController<TData>` y todos los tipos públicos.
- [ ] Validar path, callback `upgrade` y resultado de aceptación.
- [ ] Implementar handlers opcionales y `handleError`.
- [ ] Derivar los tipos nativos de Bun en lugar de duplicarlos.
- [ ] Cubrir inferencia de `ws.data`, mensajes, respuestas y errores con tests
      TypeScript.

### Fase 2 — Registry, matcher y dispatcher

- [ ] Crear `WebSocketControllers` con opciones globales.
- [ ] Implementar matching determinista y rechazo de rutas ambiguas.
- [ ] Implementar el resultado interno `matched/response` del handshake.
- [ ] Adjuntar metadata privada al upgrade y mover el routing a `WeakMap` en
      `open`.
- [ ] Mantener y limpiar el conjunto de sockets activos.
- [ ] Envolver todos los callbacks con el error boundary común.
- [ ] Construir un único `Bun.WebSocketHandler` reutilizado por el servidor.

### Fase 3 — Integración con `Server`

- [ ] Agregar `WebSocketControllers?` a `TypeServerConstructor`.
- [ ] Cambiar el handle interno a su tipo WebSocket real.
- [ ] Componer upgrades en `routes` GET y `fetch` antes de HTTP.
- [ ] Mantener idéntico el comportamiento cuando no se configura WebSocket.
- [ ] Forwardear la configuración global al campo `websocket` de `Bun.serve()`.
- [ ] Agregar `publish`, `subscriberCount`, `getPendingWebSockets`,
      `closeWebSockets` y `stop`.
- [ ] Preservar los resultados numéricos y errores nativos relevantes.
- [ ] Evitar un `as any` global; cualquier cast por limitación de tipos de Bun
      debe ser mínimo, localizado y explicado.

### Fase 4 — Modules y CoreStats

- [ ] Descubrir `websockets/**/*.ts` sólo en módulos `full`.
- [ ] Agregar el tipo de definición modular y `getWebSocketControllers()`.
- [ ] Manejar `enabled`, ausencias, errores y warnings de directorios.
- [ ] Registrar estadísticas de controllers y conexiones.
- [ ] Extender `CoreStatsPayload` sin información sensible.

### Fase 5 — Validación automatizada

- [ ] Unit tests del matcher, precedencia, duplicados y wildcards.
- [ ] Unit tests de aceptación/rechazo, headers y fallos de upgrade.
- [ ] Unit tests de dispatch de cada fase y fallback de errores.
- [ ] Unit tests de options, backpressure passthrough, métricas y lifecycle.
- [ ] Tests del loader de módulos, incluida una definición deshabilitada o
      inválida.
- [ ] Integración HTTP + WebSocket en un único puerto efímero.
- [ ] Integración con path params y `ws.data` tipado.
- [ ] Integración de texto, binario, dos clientes, subscribe/publish y
      `publishToSelf`.
- [ ] Integración de rechazo `401/403`, headers de upgrade y subprotocolo.
- [ ] Integración de payload excedido y cierre.
- [ ] Integración de cierre graceful y force sin procesos/listeners huérfanos.
- [ ] Verificar que un route HTTP solapado no consume el upgrade.
- [ ] Verificar que HTTP existente sigue funcionando sin configuración
      WebSocket.

No se intentará producir backpressure real mediante sleeps frágiles en CI. Se
probará la propagación de estados con dobles controlados y se reservará un test
de carga manual reproducible para validar `drain`.

### Fase 6 — Documentación

- [ ] Crear `DOCUMENTATION/WEBSOCKETS.md` y
      `DOCUMENTATION/WEBSOCKETS.es.md`.
- [ ] Crear mirrors `docs/content/en/WEBSOCKETS.md` y
      `docs/content/es/WEBSOCKETS.md` byte-for-byte.
- [ ] Actualizar primero `DOCUMENTATION/ALL_EN.md` y su mirror website.
- [ ] Actualizar `SERVER`, `MODULES`, `CLUSTER`, `CORESTATS`,
      `GETTING_STARTED` y sus pares EN/ES.
- [ ] Actualizar README/`FRAMEWORK` con la capacidad y un ejemplo mínimo.
- [ ] Agregar WebSockets al catálogo de `docs/app.js`.
- [ ] Documentar autenticación browser/Bun, proxies, backpressure, compresión,
      límites, shutdown y frontera cluster.
- [ ] Incluir una migración de sidecar a listener compartido.
- [ ] Actualizar `CHANGELOG.md` bajo `[Unreleased]`.

### Fase 7 — Release

- [ ] Tratar la API nueva como feature aditiva: release minor bajo SemVer.
- [ ] No fijar ni subir versión mientras continúe entrando trabajo al bloque
      `[Unreleased]`.
- [ ] Antes del release, sincronizar versión en `package.json`, lockfile,
      README EN/ES, master docs, website/manifest y changelog.
- [ ] Verificar `bun run typecheck`, `bun run lint`, `bun test`, Prettier,
      mirrors documentales y `git diff --check`.
- [ ] Inspeccionar el tarball y confirmar que todos los nuevos sources/types y
      documentos publicados están incluidos.
- [ ] Crear commits por cambios coherentes y un commit de release separado.
- [ ] No publicar npm, taggear ni desplegar sin pedido explícito.

## 11. Criterios de aceptación

La implementación estará terminada cuando:

1. una aplicación pueda servir HTTP y varias rutas WebSocket en el mismo puerto;
2. cada ruta tenga `ws.data` inferido sin casts del consumidor;
3. un handshake pueda autenticarse, rechazarse o agregar headers antes del
   `101`;
4. todos los lifecycle handlers previstos se despachen al controller correcto;
5. texto y binario lleguen sin conversión automática;
6. los estados de backpressure y pub/sub conserven la semántica de Bun;
7. publicación, métricas y cierre estén disponibles desde `Server`;
8. una ruta modular en `websockets/` se descubra y funcione;
9. el comportamiento por worker esté probado y documentado sin prometer
   broadcast distribuido;
10. los errores de aplicación estén sanitizados y los fallos de cleanup no
    filtren sockets del registry;
11. todo HTTP existente siga pasando sin WebSocket configurado;
12. documentación canónica, mirrors, website y changelog estén sincronizados;
13. typecheck, lint y suite completa pasen sin listeners o procesos residuales.

## 12. Riesgos y decisiones deliberadas

| Riesgo                                        | Decisión                                                           |
| --------------------------------------------- | ------------------------------------------------------------------ |
| Bun acepta un solo handler                    | Dispatcher singleton con controller por ruta                       |
| `routes` puede evitar `fetch`                 | Componer upgrade en cada GET nativo y también en fallback          |
| Routing interno contaminaría `ws.data`        | Symbol transitorio, luego `WeakMap`; datos públicos planos         |
| Un hook HTTP parece proteger el socket        | No reutilizarlo; `upgrade` obligatorio y documentado               |
| Error hook difiere entre docs y tipos         | `handleError` propio; no prometer evento de transporte             |
| Backpressure puede consumir memoria           | Exponer estado nativo, `drain` y límites; sin reintento automático |
| Pub/sub parece global                         | Marcar todas las métricas/topics como process-local                |
| `stop()` graceful espera sockets              | `closeWebSockets()` explícito y fallback force controlado por app  |
| Tokens en URLs terminan en logs               | Cookies seguras o tickets breves de un uso; nunca JWT duradero     |
| Una façade puede ocultar capacidades Bun      | Entregar `Bun.ServerWebSocket` directamente y derivar sus tipos    |
| Defaults del framework pueden divergir de Bun | No sobrescribirlos silenciosamente en v1                           |

## 13. Orden de commits previsto

1. `docs: plan native WebSocket support` — este documento, sin código.
2. `feat(websocket): add typed controllers and dispatcher`.
3. `feat(server): integrate native WebSocket lifecycle`.
4. `feat(modules): discover WebSocket controllers`.
5. `test(websocket): cover native server integration` si la cobertura no queda
   dentro de los commits anteriores.
6. `docs(websocket): document server and module support`.
7. `chore(release): bump version to <minor>` cuando el usuario cierre el alcance
   de la release.

Antes de empezar el commit 2, este plan debe ser revisado y aprobado. Cualquier
cambio de alcance —por ejemplo pub/sub distribuido, middleware WebSocket,
protocolos JSON o un nuevo mínimo de Bun— vuelve al plan y requiere una decisión
explícita.
