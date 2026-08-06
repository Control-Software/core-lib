import { serve, sleep, type Server as ServerBun } from 'bun'
import { type RouteControllers } from '../RouteControllers'
import { logger } from '../Logger'
import { type StaticRoutes } from '../StaticRoutes'
import { type WebSocketData } from '../WebSocketController'
import { type WebSocketControllers } from '../WebSocketControllers'

import { type TypeHook } from './types.ts'
import { type TypeCommandToWorkers } from '../Cluster/types.ts'

export type TypeServerConstructor = {
	port: number
	clustering?: boolean
	idleTimeout?: number
	maxRequestBodySize?: number
	error?: (err: unknown) => Response
	hooks?: Array<TypeHook>
	RouteControllers?: RouteControllers
	WebSocketControllers?: WebSocketControllers
	StaticRoutes?: StaticRoutes
	development?: boolean
	awaitForCluster?: boolean
}

export type ServerWebSocketPublishData = Parameters<
	ServerBun<WebSocketData>['publish']
>[1]

type ServerRouteHandler = (
	request: Request,
	server: ServerBun<WebSocketData>,
) => Response | void | Promise<Response | void>

type HTTPServerRouteHandler = (
	request: Request,
	server: ServerBun<WebSocketData>,
) => Response | Promise<Response>

type ServerRoutes = Record<
	string,
	Partial<Record<Bun.Serve.HTTPMethod, ServerRouteHandler>>
>

type HTTPServerRoutes = Record<
	string,
	Partial<Record<Bun.Serve.HTTPMethod, HTTPServerRouteHandler>>
>

export class Server {
	private startedFromCluster: boolean = false
	private clusterName: string = ''
	private server: ServerBun<WebSocketData> | undefined
	private webSocketControllers: WebSocketControllers | undefined
	private callbackMessageFromWorkers: Array<(message: string) => void> = []

	constructor() {
		process.on('message', (message: unknown) => {
			try {
				if (typeof message !== 'string') {
					return
				}
				const cmd = JSON.parse(message) as TypeCommandToWorkers
				if (cmd.command === 'start') {
					this.startedFromCluster = true
				}
				if (cmd.command === 'setName') {
					this.clusterName = cmd.message
				}
				if (cmd.command === 'sendMessageToCluster') {
					for (const callback of this.callbackMessageFromWorkers) {
						callback(cmd.message)
					}
				}
			} catch (error) {
				logger.error('Error parsing message from worker:', error)
			}
		})
	}

	public async start(properties: TypeServerConstructor) {
		const {
			port = 0,
			clustering = false,
			idleTimeout = 300,
			maxRequestBodySize = 1000000,
			error,
			hooks = [],
			RouteControllers,
			WebSocketControllers,
			StaticRoutes,
			development = false,
			awaitForCluster = false,
		} = properties

		logger.info('🚀 Starting server on port:', port)
		const callback =
			RouteControllers ?
				RouteControllers.getCallback(hooks)
			:	async (req: Request) => {
					return new Response(`Not Found ${new URL(req.url).pathname}`, { status: 404 })
				}
		const httpRoutes = this.composeHTTPRoutes(
			RouteControllers?.getRoutes(hooks),
			StaticRoutes,
		)
		const baseOptions = {
			port,
			reusePort: clustering,
			idleTimeout,
			maxRequestBodySize,
			development,
			error(err: unknown) {
				if (error) {
					return error(err)
				}
				const message =
					err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
				return new Response(`<pre>${message}</pre>`, {
					status: 500,
					headers: {
						'Content-Type': 'text/html',
					},
				})
			},
		}

		if (WebSocketControllers) {
			const routes = this.composeWebSocketRoutes(
				httpRoutes,
				callback,
				WebSocketControllers,
			)
			this.server = serve<WebSocketData, string>({
				...baseOptions,
				routes,
				websocket: WebSocketControllers.getHandler(),
				fetch: async (request, bunServer) => {
					const upgraded = await WebSocketControllers.tryUpgrade(request, bunServer)
					if (upgraded.matched) {
						return upgraded.response
					}

					return callback(request)
				},
			})
			this.webSocketControllers = WebSocketControllers
		} else {
			this.server = serve<WebSocketData, string>({
				...baseOptions,
				routes: httpRoutes,
				fetch: async request => callback(request),
			})
			this.webSocketControllers = undefined
		}

		while (awaitForCluster && !this.startedFromCluster) {
			await sleep(1000)
		}
	}

	private composeHTTPRoutes(
		httpRoutes: ReturnType<RouteControllers['getRoutes']> | undefined,
		staticRoutes: StaticRoutes | undefined,
	): HTTPServerRoutes {
		const routes: HTTPServerRoutes = {}

		for (const [path, handlers] of Object.entries(httpRoutes ?? {})) {
			const routeHandlers: Partial<Record<Bun.Serve.HTTPMethod, HTTPServerRouteHandler>> =
				{}

			for (const [method, handler] of Object.entries(handlers)) {
				const httpMethod = method as Bun.Serve.HTTPMethod
				routeHandlers[httpMethod] = request => handler(request)
			}

			routes[path] = routeHandlers
		}

		for (const [path, handlers] of Object.entries(staticRoutes?.getRoutes() ?? {})) {
			const routeHandlers = routes[path] ?? {}

			for (const [method, handler] of Object.entries(handlers)) {
				const httpMethod = method as Bun.Serve.HTTPMethod
				if (routeHandlers[httpMethod]) {
					const metadata = staticRoutes?.getRouteMetadata(path)
					const source =
						metadata ?
							`${metadata.moduleName}@${metadata.moduleVersion} public/${metadata.relativePath}`
						:	'unknown static module'
					throw new TypeError(
						`Static route collision for ${httpMethod} "${path}" from ${source} with an HTTP controller.`,
					)
				}

				routeHandlers[httpMethod] = request => handler(request)
			}

			routes[path] = routeHandlers
		}

		return routes
	}

	private composeWebSocketRoutes(
		httpRoutes: HTTPServerRoutes,
		fallback: (request: Request) => Promise<Response>,
		webSocketControllers: WebSocketControllers,
	): ServerRoutes {
		const routes: ServerRoutes = {}

		for (const [path, handlers] of Object.entries(httpRoutes)) {
			const routeHandlers: Partial<Record<Bun.Serve.HTTPMethod, ServerRouteHandler>> = {}

			for (const [method, handler] of Object.entries(handlers)) {
				const httpMethod = method as Bun.Serve.HTTPMethod
				routeHandlers[httpMethod] =
					httpMethod === 'GET' ?
						this.withWebSocketUpgrade(handler, webSocketControllers)
					:	(request, bunServer) => handler(request, bunServer)
			}

			routes[path] = routeHandlers
		}

		for (const path of webSocketControllers.getPaths()) {
			const routeHandlers = routes[path] ?? {}
			if (!routeHandlers.GET) {
				routeHandlers.GET = this.withWebSocketUpgrade(fallback, webSocketControllers)
			}
			routes[path] = routeHandlers
		}

		return routes
	}

	private withWebSocketUpgrade(
		httpHandler: HTTPServerRouteHandler,
		webSocketControllers: WebSocketControllers,
	): ServerRouteHandler {
		return async (request, bunServer) => {
			const upgraded = await webSocketControllers.tryUpgrade(request, bunServer)
			if (upgraded.matched) {
				return upgraded.response
			}

			return httpHandler(request, bunServer)
		}
	}

	public getPort() {
		return this.server?.port
	}

	public getURL() {
		return this.server?.url.href
	}

	public publish(
		topic: string,
		data: ServerWebSocketPublishData,
		compress?: boolean,
	): Bun.ServerWebSocketSendStatus {
		return this.getStartedServer('publish').publish(topic, data, compress)
	}

	public subscriberCount(topic: string): number {
		return this.getStartedServer('subscriberCount').subscriberCount(topic)
	}

	public getPendingWebSockets(): number {
		return this.server?.pendingWebSockets ?? 0
	}

	public closeWebSockets(code = 1001, reason = 'Server shutting down'): number {
		return this.webSocketControllers?.closeAll(code, reason) ?? 0
	}

	public async stop(force = false): Promise<void> {
		const server = this.server
		if (!server) {
			return
		}

		const activeConnectionsAtStop = this.webSocketControllers?.getActiveConnections() ?? 0
		const pendingWebSocketsAtStop = server.pendingWebSockets
		let nativeStopSettled = false
		let nativeStopError: unknown
		const nativeStop = server.stop(force)
		void nativeStop.then(
			() => {
				nativeStopSettled = true
			},
			error => {
				nativeStopError = error
				nativeStopSettled = true
			},
		)

		// Bun 1.3.14 can leave stop(false) pending after clients disconnect and
		// can retain a stale pendingWebSockets count after a server-initiated
		// close. The framework registry is authoritative for forced shutdown;
		// the native handle still performs the actual stop in every branch.
		const canAwaitNativeForceStop =
			force && (activeConnectionsAtStop > 0 || pendingWebSocketsAtStop === 0)

		if (canAwaitNativeForceStop) {
			await nativeStop
		} else {
			await sleep(0)
			while (
				this.server === server &&
				!nativeStopSettled &&
				(server.pendingRequests > 0 ||
					(force ?
						(this.webSocketControllers?.getActiveConnections() ?? 0) > 0
					:	server.pendingWebSockets > 0))
			) {
				await sleep(10)
			}
		}

		if (nativeStopError) {
			throw nativeStopError
		}

		if (this.server === server) {
			server.unref()
			this.server = undefined
			this.webSocketControllers = undefined
		}
	}

	private getStartedServer(operation: string): ServerBun<WebSocketData> {
		if (!this.server) {
			throw new Error(`Server.${operation}() requires a started server.`)
		}

		return this.server
	}

	public isStartedFromCluster() {
		return this.startedFromCluster
	}

	public getClusterName() {
		return this.clusterName
	}

	public sendMessageToCluster(message: string) {
		if (typeof process.send !== 'function') {
			logger.warn('sendMessageToCluster called outside cluster worker context.')
			return
		}
		process.send(message)
	}

	public sendMessageToWorkers(message: string) {
		if (typeof process.send !== 'function') {
			logger.warn('sendMessageToWorkers called outside cluster worker context.')
			return
		}
		process.send(`>>.<<|${message}`)
	}

	public onMessageFromWorkers(callback: (message: string) => void) {
		this.callbackMessageFromWorkers.push(callback)
	}
}
