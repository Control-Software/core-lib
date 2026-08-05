# CLUSTER

## Propósito

`Cluster` inicia múltiples procesos worker de Bun mediante `Bun.spawn` y los
conecta por IPC.

## Constructor

```ts
import { Cluster } from 's42-core'

const cluster = new Cluster({
	name: 'api',
	maxCPU: 4,
	watchMode: false,
	args: [],
})
```

- `name: string`
- `maxCPU?: number` (limitado por `navigator.hardwareConcurrency`)
- `watchMode?: boolean`
- `args?: string[]` (se insertan como argumentos Bun antes de `--watch` y el archivo)

Pasar un entero positivo en `maxCPU`. Omitirlo o usar el valor falsy `0`
selecciona todos los CPUs disponibles; el constructor no valida valores
negativos, fraccionales o no finitos antes de usarlos como longitud de array.

## API

- `start(file, fallback): void`
- `onWorkerMessage(callback): void`
- `sendMessageToWorkers(message): void`
- `getCurrentFile(): string`
- `getCurrentWorkers(): Array<Subprocess>`

`start()` evita iniciar un segundo conjunto mientras los workers registrados
conserven PID. El fallback recibe errores sincrónicos de setup.

## Contrato IPC

El padre envía comandos JSON:

- `start`
- `setName`
- `sendMessageToCluster`

Un worker puede pedir al padre un broadcast a todos los workers enviando un
string con prefijo `>>.<<|`. Los demás mensajes se entregan a callbacks
registrados con `onWorkerMessage()`.

Los helpers del lado worker viven en `Server`.

## Ejemplo

```ts
const cluster = new Cluster({ name: 's42-api', maxCPU: 2 })

cluster.onWorkerMessage(message => {
	console.info('worker:', message)
})

cluster.start('./modules/server.ts', error => {
	console.error('cluster setup failed', error)
})
```

El server del worker debe usar `clustering: true` para que Bun habilite
`reusePort`.

## Comportamiento WebSocket

Con WebSockets nativos, cada conexión aceptada pertenece al worker que realizó
el upgrade. Son locales al proceso:

- el registro de sockets activos y `pendingWebSockets`;
- suscripciones y `subscriberCount(topic)`;
- `ws.publish()` y `server.publish()`;
- `closeWebSockets()` y los campos WebSocket de `CoreStats`.

`reusePort` distribuye conexiones nuevas entre workers en deployments Linux
soportados; Bun ignora esa opción en macOS y Windows. No convierte el pub/sub
nativo en un bus multiproceso.

Para rooms entre workers u hosts, entregar un evento Redis, SQS o
`EventsDomain` externo a cada worker y llamar su `server.publish()` local. La
aplicación debe evitar loops y definir orden, retries y garantías de entrega.
S42-Core no instala ese bridge implícitamente.

Ver [WEBSOCKETS](./WEBSOCKETS.es.md) para el contrato completo.

## Shutdown y límites actuales

El proceso padre instala handlers one-time para `SIGINT` y `SIGTERM` y mata los
workers registrados al recibir cualquiera de esas señales.

Límites actuales:

- no hay método público `Cluster.stop()`;
- no reinicia automáticamente un worker que termina;
- no coordina readiness ni health;
- no ofrece rolling restart;
- stdout/stderr/stdin de workers heredan los del padre.
- los broadcasts solamente comprueban que exista el array de workers; no
  filtran procesos finalizados ni capturan fallas de `Subprocess.send()`.

Agregar supervisión externa, readiness checks y política de load balancer para
alta disponibilidad en producción.
