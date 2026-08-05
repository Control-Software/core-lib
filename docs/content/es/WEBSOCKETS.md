# WEBSOCKETS

## Propósito

S42-Core expone WebSockets server-side nativos de Bun sobre el mismo listener
`Bun.serve()` y puerto que HTTP. Agrega controllers de ruta tipados y un
dispatcher compartido sin envolver `Bun.ServerWebSocket`, transformar mensajes
ni imponer un protocolo.

Los valores públicos son:

- `WebSocketController<TData>`: una ruta WebSocket y su lifecycle;
- `WebSocketControllers`: registro de rutas, opciones globales del handler Bun
  y tracking de conexiones local al proceso;
- `Server`: composición HTTP/WebSocket, publicación, métricas y shutdown.

## Server mínimo

```ts
import { Server, WebSocketController, WebSocketControllers } from 's42-core'

type EchoData = {
	connectedAt: number
}

const echo = new WebSocketController<EchoData>({
	path: '/ws/echo',
	upgrade: () => ({ data: { connectedAt: Date.now() } }),
	message: (ws, message) => ws.send(message),
})

const sockets = new WebSocketControllers([echo], {
	maxPayloadLength: 1024 * 1024,
	idleTimeout: 60,
	backpressureLimit: 1024 * 1024,
	closeOnBackpressureLimit: true,
})

const server = new Server()
await server.start({
	port: 5678,
	idleTimeout: 120,
	WebSocketControllers: sockets,
})
```

La opción `Server.idleTimeout` controla el listener HTTP de Bun. La opción
`WebSocketControllers.idleTimeout` controla la inactividad de conexiones
WebSocket. Son configuraciones nativas de Bun diferentes.

## Controller tipado

`upgrade` es obligatorio. S42-Core nunca acepta una conexión implícitamente:

```ts
type ChatData = {
	userId: string
	roomId: string
}

const chat = new WebSocketController<ChatData>({
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
		return ws.publish(`chat:${ws.data.roomId}`, `${ws.data.userId}: ${String(message)}`)
	},

	close(ws) {
		ws.unsubscribe(`chat:${ws.data.roomId}`)
	},
})
```

El contexto de upgrade contiene:

```ts
{
	request: Request
	url: URL
	params: Readonly<Record<string, string>>
	query: URLSearchParams
	remoteAddress: Bun.SocketAddress | null
}
```

`remoteAddress` proviene de `Bun.Server.requestIP()`. No confiar en headers de
IP reenviados salvo que el request llegue mediante un proxy controlado.

### Resultados del upgrade

- `{ data, headers? }` acepta el handshake y reenvía headers opcionales a
  `Bun.Server.upgrade()`.
- Un `Response` lo rechaza antes del `101 Switching Protocols`, conservando
  status, body y headers.
- Una excepción entra en `handleError` con fase `upgrade`. Si no devuelve un
  `Response`, S42-Core responde un `500 Internal Server Error` genérico.
- Si Bun rechaza el upgrade, la respuesta es `400 WebSocket upgrade failed`.

`data` debe ser un objeto no nulo y no array. S42-Core hace una copia
superficial, adjunta metadata privada durante el upgrade y la elimina antes del
callback `open` de la aplicación. El consumidor usa la forma plana y tipada
`ws.data.userId`. Reasignar `ws.data` después de `open` no rompe el dispatch.

### Negociación de subprotocolo

Inspeccionar el header ofrecido y devolver exactamente un protocolo permitido:

```ts
upgrade({ request }) {
	const offered = request.headers
		.get('sec-websocket-protocol')
		?.split(',')
		.map(value => value.trim()) ?? []

	if (!offered.includes('s42.chat.v1')) {
		return new Response('Unsupported protocol', { status: 400 })
	}

	return {
		data: {},
		headers: { 'Sec-WebSocket-Protocol': 's42.chat.v1' },
	}
}
```

No reflejar un valor arbitrario del cliente en la respuesta.

## Routing

El routing del handshake se ejecuta solamente cuando:

- el método es `GET`;
- `Upgrade` es `websocket`, sin distinguir mayúsculas;
- el pathname coincide con una ruta WebSocket registrada.

Se soportan paths exactos, segmentos `:param` y un `*` terminal:

```ts
/ws/health
/ws/rooms/:roomId
/ws/files/*
```

La precedencia es exacta, luego parametrizada y finalmente wildcard. Paths
duplicados y formas ambiguas equivalentes como `/rooms/:id` junto con
`/rooms/:name` fallan al construir el registro. El resto wildcard se entrega en
`params['*']`.

Cada handler HTTP `GET` nativo se envuelve para intentar primero el upgrade. La
misma verificación se ejecuta en el `fetch` fallback. Por eso una ruta HTTP y
una WebSocket pueden compartir path. Un request HTTP normal a un path solamente
WebSocket continúa por HTTP y normalmente recibe `404`.

## Lifecycle y socket nativo

Callbacks soportados:

- `open(ws)`;
- `message(ws, message)`;
- `drain(ws)`;
- `close(ws, code, reason)`;
- `ping(ws, data)`;
- `pong(ws, data)`;
- `handleError(error, context)`.

`message` es opcional, por lo que son válidas las rutas solamente server-push.
Los tipos de argumentos se derivan de las definiciones Bun instaladas. Texto y
binario se entregan sin conversión del framework.

El socket es `Bun.ServerWebSocket<TData>` nativo. Siguen disponibles `send`,
`sendText`, `sendBinary`, `ping`, `pong`, `close`, `terminate`,
`getBufferedAmount`, `binaryType`, `remoteAddress`, `readyState`, `subscribe`,
`unsubscribe`, `isSubscribed`, `subscriptions`, `publish` y `cork`.

### Errores de aplicación

Todos los callbacks de aplicación se ejecutan dentro de una frontera de error.
La fase es `upgrade`, `open`, `message`, `drain`, `close`, `ping` o `pong`.

```ts
handleError(error, { phase, ws }) {
	logger.error(`WebSocket ${phase} failed`, error)
	if (ws?.readyState === WebSocket.OPEN) {
		ws.close(1011, 'Internal server error')
	}
}
```

Sin handler custom, S42-Core registra solamente ruta, fase y tipo de error; no
registra payloads ni el mensaje original del error. Cierra un socket abierto
con `1011` y reason genérico. Una falla en fase `close` se registra sin volver a
cerrar. Cuando existe `handleError`, ese handler controla la recuperación luego
del upgrade; un `Response` solamente tiene efecto durante `upgrade`.

Este hook captura fallas de callbacks de aplicación. No promete recibir errores
internos de transporte que Bun 1.3.x no entrega en su handler tipado.

## Backpressure y compresión

S42-Core no modifica los resultados nativos de envío:

- `-1`: encolado con backpressure;
- `0`: descartado por estado de conexión;
- valor positivo: bytes enviados.

Pausar el productor al recibir `-1` y reanudarlo desde `drain`. Consultar
`ws.getBufferedAmount()` al administrar una cola de aplicación. S42-Core no
reintenta ni crea una cola ilimitada.

Las opciones globales se reenvían exactamente:

```ts
new WebSocketControllers(controllers, {
	maxPayloadLength: 1024 * 1024,
	backpressureLimit: 1024 * 1024,
	closeOnBackpressureLimit: true,
	idleTimeout: 60,
	publishToSelf: false,
	sendPings: true,
	perMessageDeflate: true,
})
```

Aplican a todo el server Bun, no por ruta. Ningún default del framework pisa
los defaults de Bun. La compresión también puede seleccionarse por mensaje con
el argumento nativo `compress`.

## Publish/subscribe

Los sockets usan topics nativos de Bun:

```ts
open(ws) {
	ws.subscribe(`account:${ws.data.accountId}`)
}

message(ws, message) {
	return ws.publish(`account:${ws.data.accountId}`, message)
}
```

Para publicar fuera de un socket:

```ts
const status = server.publish('account:42', 'refresh')
const subscribers = server.subscriberCount('account:42')
```

`ws.publish()` normalmente excluye al emisor. Configurar `publishToSelf: true`
globalmente para incluirlo. Los topics son strings de aplicación; S42-Core no
los prefija ni reescribe.

Las suscripciones nativas y `Server.publish()` son locales al proceso. En
cluster, hacer bridge de un evento Redis/SQS/EventsDomain a `server.publish()`
dentro de cada worker cuando se necesite broadcast entre workers. Evitar loops
y elegir explícitamente las garantías de entrega.

## Métricas y shutdown

`Server` agrega:

```ts
server.getPendingWebSockets()
server.subscriberCount(topic)
server.closeWebSockets(code?, reason?)
await server.stop(force?)
```

`getPendingWebSockets()` devuelve `0` antes del start y después del stop.
`closeWebSockets()` envía un close frame a cada socket registrado, usa por
default código `1001` y reason `Server shutting down`, y devuelve la cantidad
alcanzada. `publish()` y `subscriberCount()` lanzan un error claro antes del
start o luego del stop.

Shutdown recomendado:

```ts
server.closeWebSockets(1001, 'Server shutting down')

const forceTimer = setTimeout(() => void server.stop(true), 5_000)
try {
	await server.stop()
} finally {
	clearTimeout(forceTimer)
}
```

`stop(false)` deja de aceptar trabajo y espera requests HTTP y sockets activos.
`stop(true)` fuerza el cierre. S42-Core contempla el comportamiento de stop y
contador pendiente de WebSockets de Bun 1.3.14 mediante su registro propio.

`getWebSocketControllersStats()` y `CoreStats.webSockets` exponen solamente
paths y cantidades activas. No exponen topics, IPs, headers, payloads ni
`ws.data`.

## Módulos

Un módulo `full` puede agregar `websockets/**/*.ts`:

```text
modules/chat/
├── __module__.ts
├── controllers/
├── events/
└── websockets/
    └── chat.ts
```

```ts
import type { ModuleWebSocketControllerDefinition } from 's42-core'

type ChatData = { userId: string; roomId: string }

export default {
	name: 'chat.socket',
	version: '1.0.0',
	enabled: true,
	path: '/ws/chat/:roomId',
	upgrade: async ({ request, params }) => {
		const session = await authenticate(request)
		if (!session) return new Response('Unauthorized', { status: 401 })
		return { data: { userId: session.userId, roomId: params.roomId } }
	},
	message: (ws, message) => ws.publish(`chat:${ws.data.roomId}`, message),
} satisfies ModuleWebSocketControllerDefinition<ChatData>
```

`enabled: false` omite la definición. Una definición habilitada inválida
rechaza `Modules.load()` con archivo y motivo. La ausencia de `websockets/` es
válida. Los módulos `share` ignoran el directorio con un warning.

Bootstrap explícito:

```ts
const modules = new Modules('./modules')
await modules.load()

const sockets = new WebSocketControllers(modules.getWebSocketControllers(), {
	maxPayloadLength: 1024 * 1024,
})

await server.start({
	port: 5678,
	idleTimeout: 120,
	RouteControllers: new RouteControllers(modules.getControllers()),
	WebSocketControllers: sockets,
	hooks: modules.getHooks(),
})
```

Los `mws` HTTP, `Server.hooks` y `requireBefore`/`requireAfter` no se ejecutan
en el handshake ni lifecycle WebSocket. Autenticar y autorizar dentro de
`upgrade`. Los handlers WebSocket modulares tampoco reciben un contexto
`events.emit` implícito; capturar o inyectar dependencias normalmente.

## Clientes

Browser:

```js
const socket = new WebSocket('wss://api.example.com/ws/chat/room-42')
socket.addEventListener('message', event => console.info(event.data))
```

Los browsers envían cookies aplicables automáticamente, pero no permiten
headers arbitrarios en el constructor WebSocket. Los clientes Bun ofrecen su
extensión de headers custom:

```ts
const socket = new WebSocket('wss://api.example.com/ws/chat/room-42', {
	headers: { Authorization: `Bearer ${shortLivedToken}` },
})
```

## Checklist de seguridad

- Validar autenticación y autorización antes de retornar `{ data }`.
- Retornar `401`/`403` explícitos; no aceptar primero y cerrar después.
- Validar `Origin` cuando el browser autentica con cookies.
- Preferir cookies seguras `HttpOnly` o tickets WebSocket breves y de un uso.
- No poner JWTs duraderos ni credenciales en query strings; las URLs llegan a
  logs, proxies, CDN, APM e historial.
- Permitir solamente subprotocolos conocidos y devolver uno negociado.
- Configurar límites de payload, backpressure e inactividad.
- Validar el formato de mensajes antes de usarlos.
- Usar `wss://` en producción, directo o detrás de un proxy correcto.
- No registrar cookies, tokens, query strings completas, payloads ni datos de
  conexión.
- Mantener close reasons breves y sanitizados.
- Recordar que los hooks HTTP no autorizan rutas WebSocket.

## Migración desde un sidecar

1. Convertir cada path sidecar en un `WebSocketController`.
2. Mover autenticación del handshake a `upgrade` y devolver rechazos HTTP.
3. Mover listeners por socket a callbacks de lifecycle compartidos.
4. Guardar estado de conexión en `data` tipado, no en closures de listeners.
5. Reemplazar broadcasts del sidecar por topics y `server.publish()`.
6. Configurar un registro `WebSocketControllers` sobre el `Server` existente.
7. Enrutar HTTP y WebSocket al mismo listener preservando headers de upgrade.
8. Agregar un bridge externo solamente si el broadcast debe cruzar workers.

S42-Core no agrega deliberadamente SDK cliente, envelope JSON/RPC, validación
de schemas, heartbeats, persistencia, reintentos ni pub/sub distribuido.
