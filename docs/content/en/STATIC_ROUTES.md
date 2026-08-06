# STATIC MODULE ROUTES

## Purpose

A module with `type: 'static'` publishes every regular file below its required
`public/` directory through exact native Bun routes. The module manifest uses
the same `path` property used by other route definitions:

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

## Server wiring

Load modules before starting `Server` and pass the generated registry through
`StaticRoutes`:

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

`Modules.getStaticRoutes()` is valid even when no static modules were loaded.
Omitting `StaticRoutes` preserves the existing HTTP behavior.

## Manifest and directory contract

`StaticModuleDefinition` requires:

- `name: string`;
- `version: string`;
- `type: 'static'`;
- `path: string`;
- optional `enabled`, `initialize`, and `dependencies`, with the same semantics
  as other module manifests.

The mount `path` must be canonical. It must start with `/`; may be `/`; and
must not have a trailing slash otherwise. It rejects duplicate slashes,
wildcards, `:params`, query strings, hashes, backslashes, NUL bytes, surrounding
whitespace, and `.` or `..` segments. A `path` property on `mws`, `share`, or
`full` is rejected rather than silently ignored.

An enabled static module must contain a real `public/` directory. A missing or
non-directory `public/` rejects `Modules.load()`. An empty directory is valid
and logs a warning. Disabled modules are skipped before this validation.

Static modules do not load `controllers/`, `events/`, `mws/`, or
`websockets/`; those directories are reported as ignored. `initialize`, when
present, runs after the complete static inventory has been validated and
registered. Static modules load after `mws`, `share`, and `full` modules.

## URL mapping

Every regular file receives one exact URL composed from the module `path` and
its relative path under `public/`:

```text
public/assets/app.css          -> /admin/assets/app.css
public/images/company logo.svg -> /admin/images/company%20logo.svg
public/.well-known/security.txt -> /admin/.well-known/security.txt
```

Each pathname segment is encoded independently. Spaces, Unicode, `%`, `#`,
`?`, and other reserved filename characters therefore remain addressable
without being interpreted as routing syntax. Matching is case-sensitive. The
query string does not participate in route matching.

`index.html` adds directory behavior:

```text
public/index.html       -> /admin/index.html and /admin/
GET or HEAD /admin     -> 308 /admin/
public/docs/index.html  -> /admin/docs/index.html and /admin/docs/
GET or HEAD /admin/docs -> 308 /admin/docs/
```

Redirects preserve the original query string. With `path: '/'`, the root
`public/index.html` serves `/` directly and no empty-path redirect is created.
`index.htm` has no special behavior. Directories without `index.html` are not
listed and continue to the normal fallback.

## HTTP behavior

Static routes register only `GET` and `HEAD`. Other methods remain available
to controllers or the normal fallback.

Files are served with a fresh `Bun.file()` body per request rather than being
buffered at startup. This provides Bun's streaming and native byte-range
handling, including `206`/`416`, `Content-Range`, `Content-Length`, and MIME
type detection. S42-Core also emits `Last-Modified` and returns `304` for a
matching `If-Modified-Since` value. `HEAD` returns the same representation
headers without a response body.

This feature does not add framework-level `ETag`, `Cache-Control`, CORS, or
`OPTIONS` behavior. Set deployment-specific cache and cross-origin policies in
the serving or proxy layer when required.

The route inventory is built once during `Modules.load()`:

- editing the contents of an already registered file is visible on the next
  request;
- an inaccessible, removed, or runtime-replaced symlink returns a sanitized
  `404`;
- adding, renaming, or removing pathnames requires loading modules again and
  restarting or reloading the server.

There is no watcher, hot reload, bundler, SPA fallback, or directory listing.

## Routing precedence and collisions

Static routes are merged with the native map produced by `RouteControllers`
before `Bun.serve()` starts:

- duplicate static URLs fail module loading;
- an exact `GET` or `HEAD` collision with an HTTP controller fails server
  startup and identifies both sources;
- another controller method at the same pathname may coexist;
- an exact static route takes Bun's normal precedence over parameter or
  wildcard controller routes;
- on a pathname shared with a WebSocket controller, an upgrade request is
  attempted first and a normal HTTP request still receives the file.

Static assets do not pass through `RouteControllers`, global hooks, or module
middleware. If a file requires authentication or authorization, serve it from
an HTTP `Controller` that performs the check and returns `new Response(Bun.file(path))`.

## Security boundary

`public/` is an explicit publication boundary. Dotfiles are included so paths
such as `.well-known/` work, which also means secrets placed anywhere below
`public/` become public.

The loader rejects a symlink used as `public/`, every symlink found below it,
and non-regular filesystem entries. Requests use only the exact inventory
created at startup; no request pathname is concatenated with a filesystem path.
This removes path traversal from request-time resolution. Errors and `404`
responses do not reveal physical paths.

## Statistics and public types

`getStaticRoutesStats()` returns process-local aggregate data:

```ts
{
	totalModules: 1,
	totalFiles: 4,
	totalRoutes: 7,
	paths: ['/admin'],
}
```

`totalRoutes` includes direct files, directory aliases, and redirects.
`CoreStats` exposes the same non-sensitive object as `staticRoutes`, and adds
`totalModulesStatic`, `totalStaticFiles`, and `totalStaticRoutes` to its
summary. No physical paths are exposed.

Root package types include `StaticModuleDefinition`, `StaticRoutes`,
`StaticRoutesMap`, `StaticRoutesStats`, `StaticRouteMetadata`, and
`StaticRouteKind`. Applications normally obtain the `StaticRoutes` value from
`Modules.getStaticRoutes()` rather than constructing a registry directly.
