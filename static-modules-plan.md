# Plan de módulos con archivos estáticos

Estado: aprobado por el usuario e implementado.

Fecha: 2026-08-06.

Cierre técnico: 2026-08-06. La versión se mantuvo en `3.0.12`; no se realizó
push, tag, publicación npm ni deploy.

## 1. Objetivo

Agregar un nuevo tipo de módulo `static` a S42-Core. Cada módulo de este tipo
declara un punto de montaje HTTP y expone los archivos ubicados dentro de su
directorio `public/`, conservando su estructura relativa.

La implementación debe ser Bun-first y usar `Bun.serve()` y `Bun.file()` sin
incorporar dependencias ni un servidor de archivos paralelo. El resultado debe
ser explícito, seguro y compatible con los controllers HTTP y WebSocket ya
existentes.

Ejemplo de la experiencia buscada:

```text
modules/
└── admin-ui/
    ├── __module__.ts
    └── public/
        ├── index.html
        ├── assets/
        │   ├── app.css
        │   └── app.js
        └── images/
            └── logo.svg
```

```ts
// modules/admin-ui/__module__.ts
import type { StaticModuleDefinition } from 's42-core'

export default {
	name: 'admin-ui',
	version: '1.0.0',
	type: 'static',
	path: '/admin',
	enabled: true,
} satisfies StaticModuleDefinition
```

Con ese módulo:

```text
GET /admin/                 -> public/index.html
GET /admin/index.html       -> public/index.html
GET /admin/assets/app.css   -> public/assets/app.css
GET /admin/images/logo.svg  -> public/images/logo.svg
```

## 2. Estado actual verificado

- `Module` valida hoy los tipos `mws`, `share` y `full`.
- `Modules.load()` descubre `**/__module__.ts`, agrupa por tipo y conserva un
  orden explícito de carga.
- `Server` es el único dueño de `Bun.serve()` y compone los handlers nativos a
  partir de `RouteControllers` y `WebSocketControllers`.
- `RouteControllers` aplica hooks, middlewares y normalización a endpoints de
  aplicación. Un archivo público no debe convertirse artificialmente en un
  `Controller` porque perdería la semántica nativa de archivos de Bun y
  mezclaría assets públicos con el pipeline de la API.
- Bun permite rutas exactas, parametrizadas y wildcard; las exactas tienen
  precedencia sobre las demás.
- `Bun.file(path)` es lazy y `new Response(Bun.file(path))` permite streaming,
  rangos y backpressure sin cargar el archivo completo en memoria.
- En Bun 1.3.14, una ruta cuyo valor de primer nivel es directamente un
  `BunFile` responde también a métodos distintos de `GET` y `HEAD`. El diseño no
  usará esa forma: registrará handlers por método para no servir un asset ante
  un `POST`, `PUT`, `PATCH` o `DELETE`.
- La rama parte de una base limpia, con 121 tests pasando, `typecheck` y `lint`
  correctos. `typecheck:modules` mantiene únicamente el `TS2307` ya conocido en
  `modules/operators/events/emit`.

Referencias oficiales usadas:

- [Routing de Bun](https://bun.com/docs/runtime/http/routing)
- [Servidor HTTP de Bun](https://bun.com/docs/runtime/http/server)
- [File I/O y `Bun.file`](https://bun.com/docs/runtime/file-io)
- [`Bun.Glob`](https://bun.com/docs/runtime/glob)

## 3. Decisiones de diseño

### 3.1 El punto de montaje es obligatorio

Un módulo `static` tendrá que declarar `path`. No se derivará de `name` ni
se asumirá `/` silenciosamente.

Esto evita que agregar un segundo módulo publique archivos accidentalmente en
la raíz o cambie rutas por una convención implícita. La raíz sigue disponible
de forma explícita:

```ts
export default {
	name: 'website',
	version: '1.0.0',
	type: 'static',
	path: '/',
} satisfies StaticModuleDefinition
```

`path` debe:

- ser una ruta absoluta que comience con `/`;
- ser `/` o no terminar en `/`;
- no contener segmentos vacíos por barras duplicadas;
- no contener `:param`, `*`, query string, hash, barra invertida, byte NUL ni
  segmentos `.` o `..`;
- quedar en una forma canónica única, rechazando configuraciones ambiguas en
  lugar de corregirlas silenciosamente.

### 3.2 `public/` es un contrato del tipo de módulo

- El directorio `public/` es obligatorio para un módulo `static` habilitado.
- Un directorio existente pero vacío es válido y genera una advertencia.
- Un módulo deshabilitado no valida ni registra su `public/`.
- `initialize`, si existe, se ejecuta después de construir y validar el
  inventario de archivos del módulo.
- Los directorios `controllers`, `events`, `mws` y `websockets` no se cargan en
  un módulo `static`; si existen, se informa que son ignorados, igual que el
  comportamiento explícito de los módulos `share`.
- Un módulo que necesite controllers además de assets será dividido en un
  módulo `full` y otro `static`. No se ampliará `full` para leer `public/` en
  esta primera versión.

### 3.3 Mapeo de archivos a URLs

Cada archivo regular genera una ruta exacta formada por:

```text
path + ruta relativa dentro de public/
```

Reglas:

- La jerarquía de directorios se conserva.
- Cada segmento del URL se codifica de forma segura; habrá tests específicos
  para espacios, Unicode, `%`, `#` y `?` en nombres de archivo.
- La query string no participa del matching y llega al mismo archivo.
- Las rutas son case-sensitive, como el router de Bun.
- No se generan listados de directorio.
- Un directorio sin `index.html` responde por el fallback normal, normalmente
  `404`.
- `index.htm` no recibe tratamiento especial.

`index.html` tendrá aliases de directorio para ofrecer una experiencia web
esperable sin ocultar la ruta real:

```text
public/index.html             -> /admin/index.html y /admin/
public/docs/index.html        -> /admin/docs/index.html y /admin/docs/
```

Para conservar URLs relativas correctas:

- `GET /admin` redirige con `308` a `/admin/` cuando existe
  `public/index.html`;
- `GET /admin/docs` redirige con `308` a `/admin/docs/` cuando existe
  `public/docs/index.html`;
- con `path: '/'`, `/` sirve el `index.html` raíz sin redirección.

Los redirects aplican también a `HEAD` y preservan la query string original.

Los aliases y redirects forman parte del registro y participan de la misma
validación de colisiones que las rutas de archivos.

### 3.4 Todos los archivos públicos, incluidos dotfiles

`public/` es una frontera de publicación explícita. Por eso el inventario
incluye archivos y directorios que comiencen con `.`, lo que permite casos
legítimos como `public/.well-known/`.

La documentación advertirá claramente que cualquier secreto ubicado dentro de
`public/` será público. No habrá una lista silenciosa de nombres prohibidos que
contradiga la regla “todo lo que está en `public/` se sirve”.

Los enlaces simbólicos son la excepción de seguridad: se rechazarán durante la
carga, incluido un `public/` que sea symlink, aunque su destino parezca estar
dentro del módulo. Esto evita escapes del directorio y cambios del destino
después de haber validado el inventario.

### 3.5 Registro estático al iniciar, contenido leído por request

- El árbol de nombres se escanea una vez durante `Modules.load()`.
- El servidor registra rutas exactas; nunca concatena un pathname recibido con
  una ruta del filesystem. Esto elimina el traversal por `../` del camino de
  ejecución de requests.
- El contenido se entrega mediante un `BunFile` nuevo o revalidado por request,
  no se bufferiza durante el arranque.
- Si cambia el contenido de un archivo ya registrado, el cambio se ve sin
  reconstruir el mapa de rutas.
- Si el archivo se elimina o deja de ser accesible, su ruta responde `404` sin
  revelar paths internos.
- Agregar, renombrar o eliminar nombres requiere volver a cargar módulos y
  reiniciar/recargar el servidor; no habrá watcher ni hot reload en esta
  versión.

## 4. API pública propuesta

### 4.1 Definición de módulo

El schema público `Module` seguirá aceptando los módulos actuales sin cambios y
agregará la variante `static`:

```ts
export type StaticModuleDefinition = {
	name: string
	version: string
	type: 'static'
	path: string
	enabled?: boolean
	initialize?: () => Promise<unknown> | unknown
	dependencies?: Array<Record<string, unknown>>
}
```

El tipo real se derivará del mismo contrato validado por Zod; el bloque anterior
describe su forma pública, no una segunda definición mantenida a mano.

La implementación del schema debe conservar `type: 'full'` como default para
los manifests existentes. `path` será obligatorio sólo cuando
`type === 'static'` y se rechazará si aparece en otro tipo, para detectar errores
de configuración.

Se exportarán desde `src/index.ts` el tipo de definición estática y los tipos
públicos que aparezcan en `TypeServerConstructor`; no se expondrán paths físicos
como parte del contrato público.

### 4.2 `StaticRoutes`

Se incorporará una colección dedicada que encapsule el inventario, los handlers
y las validaciones de colisiones:

```ts
const modules = new Modules('./modules')
await modules.load()

await server.start({
	port: 5678,
	RouteControllers: new RouteControllers(modules.getControllers()),
	WebSocketControllers: new WebSocketControllers(modules.getWebSocketControllers()),
	StaticRoutes: modules.getStaticRoutes(),
})
```

Contrato previsto:

```ts
export type TypeServerConstructor = {
	// opciones actuales
	StaticRoutes?: StaticRoutes
}

export class Modules {
	getStaticRoutes(): StaticRoutes
}
```

`StaticRoutes` se exportará porque forma parte del tipo público de `Server`,
pero su constructor de bajo nivel no será el camino principal documentado. La
DX oficial será `Modules.getStaticRoutes()`.

No se pasará la instancia completa de `Modules` a `Server`: el servidor recibe
únicamente la capacidad que necesita, igual que ocurre con HTTP y WebSocket.

### 4.3 Ausencia de módulos estáticos

- `StaticRoutes` será opcional en `Server.start()`.
- `modules.getStaticRoutes()` devolverá una colección vacía válida si no se
  encontró ningún módulo `static`.
- Sin esa propiedad, el comportamiento y los tipos actuales de `Server` no
  cambian.

## 5. Composición con HTTP y WebSocket

`Server` tendrá una sola fase de composición para evitar divergencias entre el
branch HTTP-only y el branch WebSocket:

1. Obtener las rutas por método de `RouteControllers`.
2. Incorporar las rutas exactas `GET` y `HEAD` de `StaticRoutes`.
3. Validar colisiones antes de llamar a `Bun.serve()`.
4. Decorar los handlers `GET` con el intento de upgrade WebSocket cuando haya
   `WebSocketControllers`.
5. Agregar las rutas que existan exclusivamente para WebSocket.
6. Mantener el callback actual como fallback para cualquier request no
   resuelto por el router nativo.

### 5.1 Precedencia

- Un upgrade WebSocket válido se intenta antes de servir un archivo en el mismo
  pathname.
- Si el request no es un upgrade, el `GET` continúa hacia el archivo estático.
- Una ruta estática exacta gana naturalmente frente a controllers
  parametrizados o wildcard, siguiendo la precedencia de Bun.
- Los métodos distintos de `GET` y `HEAD` pueden coexistir en el mismo path con
  controllers de aplicación.
- Los assets no pasan por hooks ni middlewares de `RouteControllers`. Un
  `static` es público por definición; contenido autenticado debe implementarse
  con un `Controller` que devuelva `Bun.file()` después de autorizar.

### 5.2 Colisiones que detienen el arranque

Se falla antes de abrir el puerto cuando:

- dos módulos generan el mismo pathname y método;
- dos módulos usan exactamente el mismo `path`;
- un archivo, alias o redirect generado colisiona con otro del mismo módulo;
- una ruta estática `GET` o `HEAD` colisiona con un controller exacto para el
  mismo método.

El error identifica los nombres de módulos, las URLs y las rutas relativas
involucradas. No se usa “last write wins”.

Los controllers parametrizados/wildcard no se consideran colisión porque Bun
define una precedencia determinista. Los puntos de montaje anidados son válidos
si sus rutas finales no colisionan.

## 6. Semántica HTTP

### 6.1 Métodos

- `GET`: entrega el archivo o redirect correspondiente.
- `HEAD`: devuelve el mismo status y headers que `GET`, sin body.
- Otros métodos: no sirven el archivo; continúan al controller del mismo método
  o al fallback.

No se agregará una respuesta `OPTIONS` implícita ni CORS automático.

### 6.2 Headers y archivos

La implementación debe conservar o producir:

- `Content-Type` inferido por `Bun.file()`;
- `Content-Length` cuando esté disponible;
- soporte de `Range`, `Content-Range` y `206 Partial Content` delegado a Bun;
- `Last-Modified` con precisión HTTP y `304 Not Modified` para
  `If-Modified-Since` cuando corresponda;
- `404` si el archivo registrado ya no existe o no es un archivo regular.

No se generará un `ETag` propio ni un `Cache-Control` global en la primera
versión. Tampoco se agregará `Content-Disposition`.

Una validación inicial definirá exactamente qué headers conserva Bun al usar
handlers por método. Si `new Response(Bun.file(...))` no conserva
`Last-Modified`/`If-Modified-Since` en la versión mínima soportada, S42-Core los
implementará de forma localizada y cubierta por tests; no cambiará a la ruta
directa `BunFile`, porque esa variante sirve métodos no deseados.

### 6.3 Errores

- Errores de configuración o inventario detienen `Modules.load()` o el arranque
  con un mensaje accionable.
- Errores de lectura durante un request devuelven `404` para ausencia y `500`
  genérico para fallos inesperados.
- Ninguna respuesta de runtime incluye el path absoluto, stack trace ni detalle
  del filesystem.
- Los handlers estáticos convierten sus fallos de filesystem en respuestas
  sanitizadas antes de que el error llegue al renderer general de `Server`, que
  en modo de desarrollo puede incluir detalles técnicos. Los errores ajenos a
  este subsistema conservan el flujo actual de `Server.error`.

## 7. Seguridad

La implementación debe cubrir explícitamente:

- inventario de archivos regulares únicamente;
- inclusión consciente de dotfiles dentro de `public/`;
- rechazo de todos los symlinks;
- rechazo de path traversal y separadores no portables en `path`;
- rutas exactas precomputadas, sin resolver paths proporcionados por el
  request;
- detección de colisiones antes de escuchar conexiones;
- no directory listing;
- no exposición de rutas absolutas en API pública, CoreStats o respuestas;
- tests con nombres codificados y requests como `%2e%2e`, `%2f`, doble encoding
  y barras invertidas;
- documentación visible de que `public/` no debe contener secretos, source maps
  privados ni artefactos internos.

Si la verificación de symlinks requiere `lstat`, se usará la mínima API de
filesystem necesaria. `Bun.Glob` seguirá siendo el mecanismo Bun-first para el
descubrimiento.

## 8. Lifecycle, cluster y observabilidad

- Cada worker de cluster construye el mismo inventario al arrancar.
- No se comparte contenido ni estado entre workers.
- `Server.stop()` no necesita lógica especial: las respuestas de archivo
  participan del lifecycle HTTP existente.
- El inventario queda congelado para la vida de la instancia de rutas.
- Los logs de arranque informan módulo, `path` y cantidad de archivos, sin
  listar todo el árbol salvo en nivel `debug`.

`ModulesStats` agregará:

```ts
totalModulesStatic: number
```

Se agregará estadística de archivos estáticos con datos no sensibles:

```ts
export type StaticRoutesStats = {
	totalModules: number
	totalFiles: number
	totalRoutes: number // incluye aliases y redirects
	paths: string[]
}
```

`CoreStats` incorporará esos totales en una sección `staticRoutes`. No incluirá
paths físicos, tamaños, contenido ni nombres de archivo. Las funciones de
limpieza de stats usadas por tests se ampliarán para evitar estado global entre
casos.

## 9. Implementación por fases

### Fase 0 — Caracterización de Bun

Crear tests/spikes descartables sobre la versión mínima soportada y la versión
instalada para cerrar estos comportamientos antes de escribir la abstracción:

- `BunFile` directo frente a handler `GET`/`HEAD`;
- rechazo efectivo de `POST`, `PUT`, `PATCH` y `DELETE`;
- MIME, `Content-Length`, `Last-Modified`, `If-Modified-Since` y `304`;
- rangos válidos e inválidos;
- archivo modificado o eliminado después del arranque;
- spaces, Unicode y caracteres reservados en nombres;
- dotfiles y symlinks de archivo/directorio;
- convivencia de una ruta estática con un upgrade WebSocket.

Los resultados relevantes se trasladan a tests permanentes. No se guardan
scripts temporales en el repositorio.

### Fase 1 — Contrato de módulos

Archivos principales:

- `src/Modules/index.ts`
- `src/index.ts`
- `src/Modules/index.test.ts`

Tareas:

1. Extender el schema de `Module` sin alterar el default `full`.
2. Agregar y exportar `StaticModuleDefinition`.
3. Validar `path` de forma condicional.
4. Incorporar el grupo `static` al orden de carga, después de los grupos
   actuales para no cambiar su orden relativo.
5. Registrar `totalModulesStatic` y devolver static modules desde
   `getLoadedModules()`.
6. Cubrir manifests válidos, inválidos, deshabilitados y compatibilidad con los
   tres tipos existentes.

### Fase 2 — Inventario y `StaticRoutes`

Crear `src/StaticRoutes/` con responsabilidades acotadas:

- descubrir archivos dentro de cada `public/` con `Bun.Glob`;
- incluir dotfiles y excluir directorios como recursos;
- detectar/rechazar symlinks;
- convertir rutas relativas a URLs canónicas;
- generar handlers de archivo, aliases y redirects de `index.html`;
- detectar conflictos entre módulos;
- entregar un mapa por método consumible por `Server`;
- exponer sólo métricas no sensibles.

`Modules` acumula las definiciones y expone una colección inmutable mediante
`getStaticRoutes()`.

### Fase 3 — Integración con `Server`

Archivos principales:

- `src/Server/index.ts`
- `src/Server/index.test.ts`
- `src/index.ts`

Tareas:

1. Agregar `StaticRoutes?: StaticRoutes` a `TypeServerConstructor`.
2. Unificar la composición HTTP-only/WebSocket en un pipeline común.
3. Mergear handlers por método sin sobreescribir rutas existentes.
4. Mantener el upgrade WebSocket antes del `GET` estático.
5. Mantener intacto el fallback actual.
6. Verificar que una colección vacía no cambie el mapa resultante.

### Fase 4 — Semántica HTTP y seguridad

Implementar y probar:

- `GET`/`HEAD` solamente;
- streaming y rangos;
- MIME y headers condicionales definidos en la sección 6;
- `404` para archivos eliminados;
- redirects de `index.html`;
- encoding de paths;
- traversal, symlinks, dotfiles y colisiones;
- sanitización de errores de runtime.

### Fase 5 — Tests de integración

Además de tests unitarios, levantar servidores efímeros en puertos asignados por
Bun y probar requests reales:

1. sitio raíz y punto de montaje no raíz;
2. archivo HTML, CSS, JavaScript, JSON, SVG, fuente y binario;
3. directorios anidados e `index.html`;
4. `HEAD`, conditional GET y byte ranges;
5. métodos no permitidos;
6. contenido modificado/eliminado con el servidor activo;
7. convivencia con controller exacto de otro método;
8. precedencia sobre controller parametrizado/wildcard;
9. colisión con controller exacto;
10. convivencia con WebSocket en el mismo pathname;
11. dos módulos con mounts separados y mounts anidados;
12. cluster al menos a nivel de composición/lifecycle, sin crear un benchmark.

Todos los fixtures se crean en directorios temporales y se limpian al terminar.

### Fase 6 — Documentación y website

Actualizar en el mismo cambio funcional:

- `DOCUMENTATION/ALL_EN.md` como fuente prioritaria;
- nuevo `DOCUMENTATION/STATIC_ROUTES.md`;
- nuevo `DOCUMENTATION/STATIC_ROUTES.es.md`;
- `DOCUMENTATION/MODULES.md` y `.es.md`;
- `DOCUMENTATION/SERVER.md` y `.es.md`;
- `DOCUMENTATION/GETTING_STARTED.md` y `.es.md`;
- `DOCUMENTATION/CORESTATS.md` y `.es.md`;
- `README.md` y `README.es.md`;
- mirrors `docs/content/en/` y `docs/content/es/`;
- navegación/búsqueda del website en `docs/app.js`;
- `CHANGELOG.md`.

La documentación debe incluir:

- árbol mínimo de un módulo `static`;
- manifest completo y wiring con `Server`;
- tabla exacta de mapeo archivo/URL;
- reglas de `index.html`, métodos y caching;
- interacción con controllers y WebSocket;
- reinicio requerido para agregar o renombrar archivos;
- advertencia visible sobre secretos en `public/`;
- ejemplo de asset autenticado mediante `Controller`, dejando claro que no es
  responsabilidad del módulo `static`.

### Fase 7 — Release

- No cambiar la versión durante la planificación.
- La versión actual permanece en `3.0.12` hasta una instrucción explícita.
- Si `3.0.12` sigue sin publicarse al implementar la feature, agregar el cambio
  a su entrada actual del changelog; si ya fue publicada, acordar la siguiente
  versión antes de modificar metadata.
- Revisar todas las referencias públicas de versión antes del cierre.
- Verificar el contenido del tarball con `bun pm pack --dry-run` o el comando
  disponible equivalente, sin publicar.
- No hacer push, tag, publicación npm ni deploy sin pedido explícito.

## 10. Validación obligatoria

Antes de considerar la implementación terminada:

```bash
bun run typecheck
bun run lint
bun test
bun run typecheck:modules
```

Además:

- ejecutar los tests de integración HTTP reales de la fase 5;
- verificar todos los mirrors Markdown del website contra sus fuentes;
- comprobar navegación EN/ES y búsqueda del nuevo documento;
- ejecutar `git diff --check`;
- separar cualquier fallo baseline demostrado de una regresión nueva;
- revisar `git status --short --branch` y el diff de cada commit.

El `TS2307` baseline de `typecheck:modules` no se atribuirá a esta feature, pero
cualquier error adicional sí bloquea el cierre.

## 11. Estrategia de commits ejecutada

Cada cambio terminado se commiteará por separado, sin mezclar trabajo ajeno:

1. `docs: plan static module routes`
2. `docs(static): align module path naming`
3. `feat(static): add module definitions and file registry`
4. `feat(server): serve static module routes`
5. `feat(static): expose route stats and module wiring`
6. `docs(static): document static modules and public files`

No hubo commit de release porque la versión ya era `3.0.12` y no se solicitó
otra modificación.

Los tests correspondientes se incluyen con el commit funcional que validan, no
en un commit posterior que deje código intermedio sin cobertura.

## 12. Criterios de aceptación

La feature se considera completa cuando:

- `type: 'static'` forma parte del schema y API pública sin romper manifests
  existentes;
- todo archivo regular, incluidos dotfiles, dentro de `public/` tiene una URL
  determinista bajo `path`;
- symlinks y configuraciones ambiguas se rechazan al cargar;
- `index.html`, redirects y rutas anidadas siguen las reglas documentadas;
- sólo `GET` y `HEAD` sirven contenido;
- MIME, HEAD, conditional GET, rangos y archivos eliminados están verificados
  con requests reales;
- los assets conviven con controllers y WebSockets según la precedencia
  definida;
- colisiones detienen el arranque con errores accionables;
- no hay directory traversal, directory listing ni paths internos en
  respuestas/stats;
- cluster y stop conservan el lifecycle actual;
- estadísticas, API pública, documentación EN/ES y website están sincronizados;
- los comandos de validación no presentan regresiones;
- cada cambio quedó commiteado y la versión no se modificó sin autorización.

## 13. Fuera de alcance de la primera versión

- SPA fallback (`index.html` para cualquier ruta desconocida);
- directory listing;
- bundling, transpilation, minificación o inyección HTML;
- watcher, HMR o actualización dinámica del mapa de archivos;
- assets privados mediante el módulo `static`;
- uploads o escritura en `public/`;
- CDN, object storage, proxy remoto o invalidación distribuida;
- políticas configurables por archivo de `Cache-Control`, CSP o CORS;
- negociación automática de `.br`/`.gz` precomprimidos;
- ETags generados por S42-Core;
- manifests de assets o fingerprinting;
- modificación de los módulos `full`, `share` o `mws` para servir `public/`.

Estas capacidades pueden diseñarse después sobre el registro de rutas, pero no
forman parte del objetivo aprobado para esta primera entrega.

## 14. Resultado de ejecución

Las siete fases quedaron implementadas:

- schema, carga y API pública para `type: 'static'` con `path` obligatorio;
- inventario seguro `StaticRoutes`, aliases y redirects de `index.html`;
- composición HTTP/estática/WebSocket en un único `Bun.serve()`;
- semántica real de `GET`, `HEAD`, conditional GET, MIME y byte ranges;
- estadísticas no sensibles en `getStaticRoutesStats()` y `CoreStats`;
- tests unitarios y servidores HTTP/WebSocket efímeros de integración;
- documentación canónica EN/ES y mirrors navegables del website.

Validación de cierre:

- `bun run typecheck`: correcto;
- `bun run lint`: correcto;
- `bun test`: 132 tests, 518 expectations, 0 fallos;
- `bun run typecheck:modules`: solamente el `TS2307` baseline de
  `modules/operators/controllers/operatorList.ts` hacia `../events/emit`;
- mirrors Markdown EN/ES: byte-idénticos a sus fuentes;
- catálogo del website: archivos EN/ES existentes y `STATIC_ROUTES` registrado;
- `bun pm pack --dry-run`: 110 archivos, incluye `src/StaticRoutes` y ambas
  guías, mantiene `s42-core-3.0.12.tgz` como nombre esperado y no publica ni
  genera el artefacto;
- `git diff --check`: correcto.
