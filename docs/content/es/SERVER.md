# SERVER

## Propósito

`Server` encapsula `Bun.serve` y conecta un listener con `RouteControllers`
HTTP, rutas estáticas de módulos, controllers WebSocket nativos, hooks HTTP
globales e IPC de cluster.

## Constructor

```ts
const server = new Server()
```

El constructor no recibe argumentos y registra el listener IPC del worker.

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

| Opción                 | Default de runtime | Comportamiento                                          |
| ---------------------- | -----------------: | ------------------------------------------------------- |
| `port`                 |                `0` | Puerto del listener; el contrato TypeScript lo requiere |
| `clustering`           |            `false` | Se pasa a Bun como `reusePort`                          |
| `idleTimeout`          |              `300` | Idle timeout de conexión de Bun                         |
| `maxRequestBodySize`   |        `1_000_000` | Máximo de bytes del request body                        |
| `hooks`                |               `[]` | Hooks globales de rutas                                 |
| `RouteControllers`     |            ninguno | Mapa de rutas y callback fallback                       |
| `StaticRoutes`         |            ninguno | Rutas exactas `GET`/`HEAD` de módulos estáticos         |
| `WebSocketControllers` |            ninguno | Rutas WebSocket y handler Bun singleton                 |
| `development`          |            `false` | Modo development de Bun                                 |
| `awaitForCluster`      |            `false` | Espera un comando IPC `start` del padre                 |
| `error`                | error HTML interno | Override del error handler de Bun                       |

Sin `RouteControllers` ni una entrada coincidente de `StaticRoutes`, todo
request HTTP que no sea un upgrade recibe un `404` en texto plano.

El default de source para `idleTimeout` del listener HTTP continúa en `300`.
Bun 1.3.14 solamente acepta valores hasta `255`, por lo que en el runtime
soportado la aplicación debe pasar hoy un valor válido explícito como `120`. El
handler WebSocket tiene otro `idleTimeout` dentro de `WebSocketControllers`.

## Comportamiento en runtime

1. Construye el callback fallback con `RouteControllers.getCallback(hooks)`.
2. Construye el mapa de rutas nativas con `RouteControllers.getRoutes(hooks)`.
3. Combina handlers estáticos exactos `GET`/`HEAD`. Una colisión exacta de
   método/path con un controller HTTP rechaza el inicio.
4. Con WebSockets, envuelve cada `GET` HTTP nativo, agrega entradas para paths
   solamente WebSocket y verifica el fallback antes de HTTP.
5. Inicia `Bun.serve` con `routes`, `fetch` y un handler `websocket` compartido.
6. Con `awaitForCluster`, crea primero el listener y luego mantiene pendiente la
   promise de `start()` hasta recibir `start` desde el proceso padre.

Sin espera de cluster, `start()` resuelve después de que `Bun.serve` crea el
listener. Repetir `start()` sobre el mismo wrapper no tiene guard: sobrescribe
el handle almacenado sin detener el server Bun anterior.

## Helpers públicos

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

`sendMessageToCluster()` y `sendMessageToWorkers()` solamente operan cuando
existe `process.send`. En otro contexto registran un warning.

`publish()` y `subscriberCount()` delegan a Bun y lanzan antes del start o
después del stop. La publicación y cantidad de subscribers son locales al
proceso. `getPendingWebSockets()` devuelve `0` fuera del lifecycle iniciado.

## Ejemplo mínimo

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

## Seguridad y ciclo de vida

- El error handler default devuelve mensaje y stack como HTML. En producción,
  proveer un callback `error` sanitizado y registrar el error interno por
  separado.
- `development` se reenvía a Bun; no reemplaza una política de errores segura.
- `stop(false)` inicia el stop graceful de Bun y espera actividad HTTP y
  WebSocket en vuelo. `stop(true)` fuerza el cierre.
- Para shutdown WebSocket graceful, llamar `closeWebSockets(1001, reason)`,
  iniciar `stop()` y usar un timeout de aplicación que pueda llamar
  `stop(true)`.
- S42-Core contempla promises de stop y contadores WebSocket pendientes
  obsoletos de Bun 1.3.14 mediante su registro propio; el handle nativo sigue
  realizando el stop real.
- El constructor instala un listener `message` sobre el proceso y no expone un
  método para removerlo.
- Un server worker en cluster debe usar `clustering: true` para habilitar
  `reusePort` en Bun.
- Las rutas estáticas evitan hooks HTTP y middleware de módulos. Servir archivos
  protegidos mediante un `Controller` autenticado, no un módulo `static`.

Ver [WEBSOCKETS](./WEBSOCKETS.es.md) para routing, autenticación, lifecycle,
backpressure, pub/sub, módulos, cluster y seguridad.
Ver [RUTAS ESTÁTICAS](./STATIC_ROUTES.es.md) para mapeo, cache, rangos,
colisiones, recarga y la frontera de seguridad de `public/`.
