# RUTAS ESTÁTICAS POR MÓDULO

## Propósito

Un módulo con `type: 'static'` publica cada archivo regular dentro de su
directorio obligatorio `public/` mediante rutas nativas exactas de Bun. El
manifest usa la misma propiedad `path` que las demás definiciones de rutas:

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

```text
modules/
└── admin-ui/
    ├── __module__.ts
    └── public/
        ├── index.html
        ├── assets/
        │   ├── app.css
        │   └── app.js
        └── .well-known/
            └── security.txt
```

## Integración con el servidor

Cargar los módulos antes de iniciar `Server` y pasar el registro generado
mediante `StaticRoutes`:

```ts
import { Modules, RouteControllers, Server, WebSocketControllers } from 's42-core'

const modules = new Modules('./modules')
await modules.load()

const webSocketDefinitions = modules.getWebSocketControllers()

await new Server().start({
	port: 5678,
	idleTimeout: 120,
	RouteControllers: new RouteControllers(modules.getControllers()),
	StaticRoutes: modules.getStaticRoutes(),
	WebSocketControllers:
		webSocketDefinitions.length > 0 ?
			new WebSocketControllers(webSocketDefinitions)
		:	undefined,
	hooks: modules.getHooks(),
})
```

`Modules.getStaticRoutes()` es válido aunque no se haya cargado ningún módulo
estático. Omitir `StaticRoutes` conserva el comportamiento HTTP existente.

## Contrato del manifest y el directorio

`StaticModuleDefinition` requiere:

- `name: string`;
- `version: string`;
- `type: 'static'`;
- `path: string`;
- `enabled`, `initialize` y `dependencies` opcionales, con la misma semántica
  que en los demás manifests.

El `path` de montaje debe ser canónico. Debe comenzar con `/`; puede ser `/`;
y, en otro caso, no debe terminar con `/`. Rechaza barras duplicadas,
wildcards, `:params`, query strings, hashes, barras invertidas, bytes NUL,
espacios externos y segmentos `.` o `..`. Una propiedad `path` en un módulo
`mws`, `share` o `full` se rechaza en vez de ignorarse silenciosamente.

Un módulo estático habilitado debe contener un directorio `public/` real. Un
`public/` ausente o que no sea directorio hace fallar `Modules.load()`. Un
directorio vacío es válido y registra un warning. Los módulos deshabilitados se
omiten antes de esta validación.

Los módulos estáticos no cargan `controllers/`, `events/`, `mws/` ni
`websockets/`; esos directorios se informan como ignorados. `initialize`, si
existe, se ejecuta después de validar y registrar todo el inventario estático.
Los módulos estáticos se cargan después de `mws`, `share` y `full`.

## Mapeo de URLs

Cada archivo regular recibe una URL exacta compuesta por el `path` del módulo y
su ruta relativa dentro de `public/`:

```text
public/assets/app.css           -> /admin/assets/app.css
public/images/company logo.svg  -> /admin/images/company%20logo.svg
public/.well-known/security.txt -> /admin/.well-known/security.txt
```

Cada segmento del pathname se codifica por separado. Espacios, Unicode, `%`,
`#`, `?` y otros caracteres reservados de los nombres quedan accesibles sin
interpretarse como sintaxis de routing. El matching distingue mayúsculas. La
query string no participa en el matching.

`index.html` agrega comportamiento de directorio:

```text
public/index.html        -> /admin/index.html y /admin/
GET o HEAD /admin        -> 308 /admin/
public/docs/index.html   -> /admin/docs/index.html y /admin/docs/
GET o HEAD /admin/docs   -> 308 /admin/docs/
```

Los redirects preservan la query string original. Con `path: '/'`, el
`public/index.html` raíz sirve `/` directamente y no se crea un redirect de
path vacío. `index.htm` no tiene tratamiento especial. Los directorios sin
`index.html` no se listan y continúan al fallback normal.

## Comportamiento HTTP

Las rutas estáticas registran solamente `GET` y `HEAD`. Los demás métodos
siguen disponibles para controllers o para el fallback normal.

Los archivos se entregan con un body `Bun.file()` nuevo por request en vez de
bufferizarse durante el inicio. Esto conserva el streaming y los rangos de
bytes nativos de Bun, incluidos `206`/`416`, `Content-Range`, `Content-Length`
y la detección del MIME type. S42-Core también emite `Last-Modified` y devuelve
`304` cuando coincide `If-Modified-Since`. `HEAD` devuelve los mismos headers
de representación sin response body.

Esta feature no agrega `ETag`, `Cache-Control`, CORS ni comportamiento
`OPTIONS` a nivel framework. Definir las políticas de cache y cross-origin
específicas del despliegue en la capa de servicio o proxy cuando correspondan.

El inventario se construye una vez durante `Modules.load()`:

- editar el contenido de un archivo ya registrado se ve en el request
  siguiente;
- un archivo inaccesible, eliminado o reemplazado por symlink durante el
  runtime devuelve un `404` sanitizado;
- agregar, renombrar o eliminar pathnames requiere volver a cargar los módulos
  y reiniciar o recargar el servidor.

No hay watcher, hot reload, bundler, fallback de SPA ni listado de directorios.

## Precedencia y colisiones de rutas

Las rutas estáticas se combinan con el mapa nativo producido por
`RouteControllers` antes de iniciar `Bun.serve()`:

- URLs estáticas duplicadas hacen fallar la carga de módulos;
- una colisión exacta `GET` o `HEAD` con un controller HTTP hace fallar el
  inicio del servidor e identifica ambas fuentes;
- otro método de controller sobre el mismo pathname puede convivir;
- una ruta estática exacta tiene la precedencia normal de Bun sobre rutas
  parametrizadas o wildcard de controllers;
- si un pathname también pertenece a un controller WebSocket, primero se
  intenta el upgrade y un request HTTP normal sigue recibiendo el archivo.

Los assets estáticos no pasan por `RouteControllers`, hooks globales ni
middleware de módulos. Si un archivo necesita autenticación o autorización,
servirlo desde un `Controller` HTTP que realice el control y devuelva
`new Response(Bun.file(path))`.

## Frontera de seguridad

`public/` es una frontera explícita de publicación. Los dotfiles se incluyen
para permitir paths como `.well-known/`, lo que también implica que los
secretos ubicados en cualquier lugar dentro de `public/` se vuelven públicos.

El loader rechaza un `public/` que sea symlink, todos los symlinks encontrados
en su interior y entradas del filesystem que no sean archivos regulares. Los
requests usan solamente el inventario exacto creado al inicio; ningún pathname
del request se concatena con un path del filesystem. Esto elimina el traversal
de paths de la resolución durante el request. Los errores y `404` no revelan
paths físicos.

## Estadísticas y tipos públicos

`getStaticRoutesStats()` devuelve datos agregados locales al proceso:

```ts
{
	totalModules: 1,
	totalFiles: 4,
	totalRoutes: 7,
	paths: ['/admin'],
}
```

`totalRoutes` incluye archivos directos, aliases de directorio y redirects.
`CoreStats` expone el mismo objeto no sensible como `staticRoutes`, y agrega
`totalModulesStatic`, `totalStaticFiles` y `totalStaticRoutes` a su summary. No
se exponen paths físicos.

Los tipos exportados desde la raíz incluyen `StaticModuleDefinition`,
`StaticRoutes`, `StaticRoutesMap`, `StaticRoutesStats`, `StaticRouteMetadata` y
`StaticRouteKind`. Normalmente las aplicaciones obtienen el valor
`StaticRoutes` desde `Modules.getStaticRoutes()` en vez de construir un registro
directamente.
