# SERVER

## Purpose

`Server` wraps `Bun.serve` and connects one listener to HTTP
`RouteControllers`, static module routes, native WebSocket controllers, global
HTTP hooks, and cluster IPC.

## Constructor

```ts
const server = new Server()
```

The constructor takes no arguments and registers the worker-side IPC listener.

## `start()`

```ts
await server.start({
	port: 5678,
	clustering: false,
	idleTimeout: 120,
	maxRequestBodySize: 1_000_000,
	hooks: [],
	RouteControllers: router,
	StaticRoutes: staticRoutes,
	WebSocketControllers: sockets,
	development: false,
	awaitForCluster: false,
	error: () => new Response('Internal Server Error', { status: 500 }),
})
```

| Option                 |     Runtime default | Behavior                                           |
| ---------------------- | ------------------: | -------------------------------------------------- |
| `port`                 |                 `0` | Listener port; the TypeScript contract requires it |
| `clustering`           |             `false` | Passed to Bun as `reusePort`                       |
| `idleTimeout`          |               `300` | Bun connection idle timeout                        |
| `maxRequestBodySize`   |         `1_000_000` | Maximum request body bytes                         |
| `hooks`                |                `[]` | Global route hooks                                 |
| `RouteControllers`     |                none | Route map and fallback callback                    |
| `StaticRoutes`         |                none | Exact `GET`/`HEAD` routes from static modules      |
| `WebSocketControllers` |                none | WebSocket routes and singleton Bun handler         |
| `development`          |             `false` | Bun development mode                               |
| `awaitForCluster`      |             `false` | Wait for a parent `start` IPC command              |
| `error`                | built-in HTML error | Bun error handler override                         |

Without `RouteControllers` or a matching `StaticRoutes` entry, every
non-upgrade HTTP request receives a plain-text `404`.

The source default for the HTTP listener `idleTimeout` remains `300`. Bun
1.3.14 accepts values only through `255`, so applications on the supported
runtime must currently pass an explicit valid value such as `120`. The
WebSocket handler has a separate `idleTimeout` configured on
`WebSocketControllers`.

## Runtime behavior

1. Builds the fallback callback with `RouteControllers.getCallback(hooks)`.
2. Builds the Bun native route map with `RouteControllers.getRoutes(hooks)`.
3. Merges exact static `GET`/`HEAD` handlers. An exact method/path collision
   with an HTTP controller rejects startup.
4. When WebSockets are configured, wraps every native HTTP `GET`, adds native
   entries for WebSocket-only paths, and checks the fallback before HTTP.
5. Starts `Bun.serve` with `routes`, `fetch`, and one shared `websocket` handler.
6. When `awaitForCluster` is enabled, creates the listener first and then keeps
   the `start()` promise pending until the parent sends `start`.

Without cluster waiting, `start()` resolves after `Bun.serve` has created the
listener. Calling `start()` again on the same wrapper is not guarded: it
overwrites the stored handle without stopping the previous Bun server.

## Public helpers

- `getPort(): number | undefined`
- `getURL(): string | undefined`
- `publish(topic, data, compress?): Bun.ServerWebSocketSendStatus`
- `subscriberCount(topic): number`
- `getPendingWebSockets(): number`
- `closeWebSockets(code?, reason?): number`
- `stop(force?): Promise<void>`
- `isStartedFromCluster(): boolean`
- `getClusterName(): string`
- `sendMessageToCluster(message): void`
- `sendMessageToWorkers(message): void`
- `onMessageFromWorkers(callback): void`

`sendMessageToCluster()` and `sendMessageToWorkers()` only operate when
`process.send` exists. Otherwise they log a warning.

`publish()` and `subscriberCount()` delegate to Bun and throw before the server
starts or after it stops. Publication and subscriber counts are process-local.
`getPendingWebSockets()` returns `0` outside the started lifecycle.

## Minimal example

```ts
import { Modules, RouteControllers, Server } from 's42-core'

const modules = new Modules('./modules')
await modules.load()

const server = new Server()
await server.start({
	port: 5678,
	RouteControllers: new RouteControllers(modules.getControllers()),
	StaticRoutes: modules.getStaticRoutes(),
	hooks: modules.getHooks(),
})

console.info(server.getURL())
```

## Security and lifecycle notes

- The default error handler returns the error message and stack as HTML.
  Production services should provide a sanitized `error` callback and log the
  internal error separately.
- `development` is forwarded to Bun; it is not a substitute for a sanitized
  production error policy.
- `stop(false)` initiates Bun's graceful stop and waits for in-flight HTTP and
  WebSocket activity. `stop(true)` forces active work closed.
- For graceful WebSocket shutdown, call `closeWebSockets(1001, reason)`, start
  `stop()`, and use an application timeout that can call `stop(true)`.
- S42-Core accounts for Bun 1.3.14 stop promises and stale WebSocket pending
  counters through its own connection registry; the native handle still
  performs the actual stop.
- The constructor installs a process `message` listener and does not expose a
  method to remove it.
- A clustered worker server must use `clustering: true` so Bun enables
  `reusePort`.
- Static routes bypass HTTP hooks and module middleware. Serve protected files
  through an authenticated `Controller`, not a `static` module.

See [WEBSOCKETS](./WEBSOCKETS.md) for routing, authentication, lifecycle,
backpressure, pub/sub, modules, cluster boundaries, and security.
See [STATIC ROUTES](./STATIC_ROUTES.md) for file mapping, caching, ranges,
collisions, reload behavior, and the `public/` security boundary.
