# WEBSOCKETS

## Purpose

S42-Core exposes Bun-native server-side WebSockets on the same `Bun.serve()`
listener and port as HTTP. It adds typed route controllers and a shared
dispatcher without wrapping `Bun.ServerWebSocket`, transforming messages, or
adding a protocol.

The public values are:

- `WebSocketController<TData>`: one WebSocket route and its lifecycle;
- `WebSocketControllers`: route registry, global Bun handler options, and
  process-local connection tracking;
- `Server`: HTTP/WebSocket composition, publication, metrics, and shutdown.

## Minimal server

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

The `Server.idleTimeout` option controls Bun's HTTP listener. The
`WebSocketControllers.idleTimeout` option controls WebSocket connection
inactivity. They are separate native Bun settings.

## Typed controller

`upgrade` is required. S42-Core never accepts a connection implicitly:

```ts
type ChatData = {
	userId: string
	roomId: string
}

const chat = new WebSocketController<ChatData>({
	path: '/ws/chat/:roomId',

	async upgrade({ request, params, query, remoteAddress }) {
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

The upgrade context contains:

```ts
{
	request: Request
	url: URL
	params: Readonly<Record<string, string>>
	query: URLSearchParams
	remoteAddress: Bun.SocketAddress | null
}
```

`remoteAddress` comes from `Bun.Server.requestIP()`. Do not treat forwarded IP
headers as trusted unless the request arrived through a controlled proxy.

### Upgrade results

- `{ data, headers? }` accepts the handshake and forwards optional response
  headers to `Bun.Server.upgrade()`.
- A `Response` rejects it before `101 Switching Protocols`, preserving status,
  body, and headers.
- A thrown error enters `handleError` with phase `upgrade`. If it does not
  return a `Response`, S42-Core sends a generic `500 Internal Server Error`.
- If Bun rejects the upgrade, the response is `400 WebSocket upgrade failed`.

`data` must be a non-null, non-array object. S42-Core shallow-copies it, attaches
private routing metadata for the upgrade, and removes that metadata before the
application `open` callback. Consumers use the flat, strongly typed
`ws.data.userId` shape. Reassigning `ws.data` after `open` does not break route
dispatch.

### Subprotocol negotiation

Inspect the offered header and return exactly one allowed protocol:

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

Do not echo an arbitrary client value into the response.

## Routing

Handshake routing runs only when all these conditions hold:

- method is `GET`;
- `Upgrade` equals `websocket`, case-insensitively;
- the URL pathname matches a registered WebSocket path.

Supported paths are exact paths, `:param` segments, and one terminal `*`:

```ts
/ws/health
/ws/rooms/:roomId
/ws/files/*
```

Precedence is exact, then parameterized, then wildcard. Duplicate paths and
equivalent ambiguous paths such as `/rooms/:id` plus `/rooms/:name` fail when
the registry is constructed. The wildcard remainder is available as
`params['*']`.

Every native HTTP `GET` handler is wrapped so an upgrade is attempted before
HTTP dispatch. The same check runs in the fallback `fetch` handler. Therefore
an HTTP route and a WebSocket route may share a path. A normal HTTP request to a
WebSocket-only path still follows HTTP behavior and normally receives `404`.

## Lifecycle and native socket

Supported callbacks are:

- `open(ws)`;
- `message(ws, message)`;
- `drain(ws)`;
- `close(ws, code, reason)`;
- `ping(ws, data)`;
- `pong(ws, data)`;
- `handleError(error, context)`.

`message` is optional, so server-push-only routes are valid. Callback argument
types are derived from the installed Bun definitions. Text and binary values
are delivered without framework conversion.

The socket is the native `Bun.ServerWebSocket<TData>`. Its methods and fields
remain available, including `send`, `sendText`, `sendBinary`, `ping`, `pong`,
`close`, `terminate`, `getBufferedAmount`, `binaryType`, `remoteAddress`,
`readyState`, `subscribe`, `unsubscribe`, `isSubscribed`, `subscriptions`,
`publish`, and `cork`.

### Application errors

All application callbacks run inside a framework error boundary. The context
phase is one of `upgrade`, `open`, `message`, `drain`, `close`, `ping`, or
`pong`.

```ts
handleError(error, { phase, ws }) {
	logger.error(`WebSocket ${phase} failed`, error)
	if (ws?.readyState === WebSocket.OPEN) {
		ws.close(1011, 'Internal server error')
	}
}
```

When no custom handler exists, S42-Core logs only route, phase, and error type;
it does not log message payloads or the original error message. It closes an
open socket with `1011` and a generic reason. A `close`-phase failure is logged
but cannot close the connection again. If a custom `handleError` exists, it owns
the post-upgrade recovery behavior; a `Response` only has meaning during
`upgrade`.

This hook catches application callback failures. It does not claim to receive
internal transport errors that Bun 1.3.x does not expose in its typed handler.

## Backpressure and compression

S42-Core does not alter native send results:

- `-1`: enqueued with backpressure;
- `0`: dropped because of connection state;
- positive value: bytes sent.

Pause the application producer on `-1` and resume it from `drain`. Inspect
`ws.getBufferedAmount()` when managing an application queue. S42-Core does not
retry or create an unbounded queue.

Global handler options are forwarded exactly:

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

These options apply to the whole Bun server, not individual routes. No
framework defaults override Bun's defaults. Compression may also be selected
per outgoing message with the native `compress` argument.

## Publish/subscribe

Sockets use Bun's native topic API:

```ts
open(ws) {
	ws.subscribe(`account:${ws.data.accountId}`)
}

message(ws, message) {
	return ws.publish(`account:${ws.data.accountId}`, message)
}
```

Publish from outside a socket through `Server`:

```ts
const status = server.publish('account:42', 'refresh')
const subscribers = server.subscriberCount('account:42')
```

`ws.publish()` normally excludes its sender. Set `publishToSelf: true` globally
to include it. Topic names are application strings; S42-Core does not prefix or
rewrite them.

Native WebSocket subscriptions and `Server.publish()` are process-local. In a
cluster, bridge a Redis/SQS/EventsDomain event into `server.publish()` inside
every worker when a cross-worker broadcast is required. Prevent bridge loops
and choose delivery guarantees explicitly.

## Metrics and shutdown

`Server` adds:

```ts
server.getPendingWebSockets()
server.subscriberCount(topic)
server.closeWebSockets(code?, reason?)
await server.stop(force?)
```

`getPendingWebSockets()` returns `0` before start and after stop.
`closeWebSockets()` sends a close frame to every socket tracked by the registry,
defaults to code `1001` and reason `Server shutting down`, and returns the
number reached. `publish()` and `subscriberCount()` throw a clear error before
the server starts or after it stops.

Recommended shutdown:

```ts
server.closeWebSockets(1001, 'Server shutting down')

const forceTimer = setTimeout(() => void server.stop(true), 5_000)
try {
	await server.stop()
} finally {
	clearTimeout(forceTimer)
}
```

`stop(false)` stops accepting new work and waits for in-flight HTTP requests
and sockets. `stop(true)` forces active work closed. S42-Core accounts for Bun
1.3.14 WebSocket stop/pending-counter behavior with its own connection registry.

`getWebSocketControllersStats()` and `CoreStats.webSockets` expose registered
paths and active counts only. They do not expose topics, IPs, headers, payloads,
or `ws.data`.

## Modules

A `full` module may add `websockets/**/*.ts`:

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

`enabled: false` skips a definition. Invalid enabled definitions reject
`Modules.load()` with the file and reason. Missing `websockets/` is valid.
`share` modules ignore that directory with a warning.

Bootstrap discovered routes explicitly:

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

HTTP `mws`, `Server.hooks`, and `requireBefore`/`requireAfter` do not run for a
WebSocket handshake or lifecycle event. Authenticate and authorize inside the
required `upgrade` callback. WebSocket module handlers also do not receive an
implicit `events.emit` context; capture or inject dependencies normally.

## Clients

Browser:

```js
const socket = new WebSocket('wss://api.example.com/ws/chat/room-42')
socket.addEventListener('message', event => console.info(event.data))
```

Browsers send applicable cookies automatically but cannot add arbitrary
headers to the WebSocket constructor. Bun clients can use its custom headers
extension:

```ts
const socket = new WebSocket('wss://api.example.com/ws/chat/room-42', {
	headers: { Authorization: `Bearer ${shortLivedToken}` },
})
```

## Security checklist

- Validate authentication and authorization before returning `{ data }`.
- Return explicit `401`/`403` responses; do not accept first and close later.
- Validate `Origin` when browsers authenticate with cookies.
- Prefer secure `HttpOnly` cookies or short-lived, single-use WebSocket tickets.
- Do not put durable JWTs or credentials in query strings; URLs reach logs,
  proxies, CDNs, APM, and browser history.
- Allow-list subprotocols and return only one negotiated value.
- Configure payload, backpressure, and idle limits for the workload.
- Validate application message formats before using them.
- Use `wss://` in production, directly or behind a correctly configured proxy.
- Do not log cookies, tokens, complete query strings, message payloads, or
  connection data.
- Keep close reasons short and sanitized.
- Remember that HTTP hooks do not authorize WebSocket routes.

## Migration from a sidecar server

1. Convert each sidecar path into one `WebSocketController`.
2. Move handshake authentication into `upgrade` and return HTTP rejections.
3. Move per-socket listeners into shared lifecycle callbacks.
4. Put connection state into typed `data`, not closure-local listener state.
5. Replace sidecar broadcasts with native topics and `server.publish()`.
6. Configure one `WebSocketControllers` registry on the existing `Server`.
7. Route HTTP and WebSocket traffic to the same listener and preserve proxy
   upgrade headers.
8. Add an external event bridge only when broadcasting must cross workers.

S42-Core intentionally does not add a client SDK, JSON/RPC envelope, schema
validation, heartbeats, persistence, retries, or distributed pub/sub.
