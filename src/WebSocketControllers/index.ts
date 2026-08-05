import { logger } from '../Logger'
import {
	trackWebSocketConnection,
	untrackWebSocketConnection,
	type WebSocketController,
	type WebSocketData,
	type WebSocketErrorContext,
	type WebSocketErrorPhase,
	type WebSocketHandlerResult,
	type WebSocketMessage,
	type WebSocketPeer,
	type WebSocketPingData,
	type WebSocketPongData,
} from '../WebSocketController'
import type { WebSocketServerOptions, WebSocketUpgradeDispatchResult } from './types'

const WEB_SOCKET_ROUTE: unique symbol = Symbol('s42-core.websocket.route')

type AnyWebSocketController = WebSocketController<any>
type InternalWebSocketData = WebSocketData & {
	[WEB_SOCKET_ROUTE]?: AnyWebSocketController
}
type InternalWebSocketPeer = Bun.ServerWebSocket<InternalWebSocketData>

type CompiledRoute = {
	controller: AnyWebSocketController
	segments: string[]
	kind: 0 | 1 | 2
	specificity: number[]
}

type MatchedRoute = {
	controller: AnyWebSocketController
	params: Readonly<Record<string, string>>
}

export class WebSocketControllers {
	private readonly controllers: AnyWebSocketController[]
	private readonly routes: CompiledRoute[]
	private readonly options: WebSocketServerOptions
	private readonly handler: Bun.WebSocketHandler<WebSocketData>
	private readonly controllerBySocket = new WeakMap<
		InternalWebSocketPeer,
		AnyWebSocketController
	>()
	private readonly activeSockets = new Set<InternalWebSocketPeer>()

	public constructor(
		controllers: AnyWebSocketController[],
		options: WebSocketServerOptions = {},
	) {
		this.controllers = [...controllers]
		this.options = { ...options }
		this.routes = this.compileRoutes(this.controllers)
		this.handler = this.createHandler()
	}

	public getControllers(): AnyWebSocketController[] {
		return [...this.controllers]
	}

	public getPaths(): string[] {
		return this.routes.map(route => route.controller.getPath())
	}

	public getActiveConnections(): number {
		return this.activeSockets.size
	}

	public closeAll(code = 1001, reason = 'Server shutting down'): number {
		let closed = 0

		for (const ws of this.activeSockets) {
			ws.close(code, reason)
			closed++
		}

		return closed
	}

	public isUpgradeRequest(request: Request): boolean {
		return (
			request.method === 'GET' &&
			request.headers.get('upgrade')?.toLowerCase() === 'websocket'
		)
	}

	public async tryUpgrade(
		request: Request,
		server: Bun.Server<WebSocketData>,
	): Promise<WebSocketUpgradeDispatchResult> {
		if (!this.isUpgradeRequest(request)) {
			return { matched: false }
		}

		const url = new URL(request.url)
		const matchedRoute = this.match(url.pathname)
		if (!matchedRoute) {
			return { matched: false }
		}

		const context = {
			request,
			url,
			params: matchedRoute.params,
			query: url.searchParams,
			remoteAddress: server.requestIP(request),
		}

		let result
		try {
			result = await matchedRoute.controller.upgrade(context)
		} catch (error) {
			const response = await this.handleUpgradeError(
				matchedRoute.controller,
				error,
				context,
			)
			return { matched: true, response }
		}

		if (result instanceof Response) {
			return { matched: true, response: result }
		}

		if (!this.isValidData(result?.data)) {
			const response = await this.handleUpgradeError(
				matchedRoute.controller,
				new TypeError('WebSocket upgrade data must be a non-null object.'),
				context,
			)
			return { matched: true, response }
		}

		const data = { ...result.data } as InternalWebSocketData
		Object.defineProperty(data, WEB_SOCKET_ROUTE, {
			value: matchedRoute.controller,
			enumerable: false,
			configurable: true,
		})

		const upgraded = server.upgrade(request, {
			data,
			headers: result.headers,
		})

		return {
			matched: true,
			response:
				upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 400 }),
		}
	}

	public getHandler(): Bun.WebSocketHandler<WebSocketData> {
		return this.handler
	}

	private createHandler(): Bun.WebSocketHandler<WebSocketData> {
		return {
			...this.options,
			data: {} as WebSocketData,
			open: ws => this.onOpen(ws as InternalWebSocketPeer),
			message: (ws, message) => this.onMessage(ws as InternalWebSocketPeer, message),
			drain: ws => this.onDrain(ws as InternalWebSocketPeer),
			close: (ws, code, reason) =>
				this.onClose(ws as InternalWebSocketPeer, code, reason),
			ping: (ws, data) => this.onPing(ws as InternalWebSocketPeer, data),
			pong: (ws, data) => this.onPong(ws as InternalWebSocketPeer, data),
		}
	}

	private compileRoutes(controllers: AnyWebSocketController[]): CompiledRoute[] {
		const canonicalPaths = new Map<string, string>()
		const routes = controllers.map(controller => {
			const path = controller.getPath()
			const segments = path.split('/').slice(1)
			const canonicalPath = `/${segments
				.map(segment => (segment.startsWith(':') ? ':' : segment))
				.join('/')}`
			const duplicate = canonicalPaths.get(canonicalPath)

			if (duplicate) {
				throw new TypeError(`Ambiguous WebSocket routes "${duplicate}" and "${path}".`)
			}

			canonicalPaths.set(canonicalPath, path)
			const hasWildcard = segments.includes('*')
			const hasParameter = segments.some(segment => segment.startsWith(':'))
			const kind: CompiledRoute['kind'] =
				hasWildcard ? 2
				: hasParameter ? 1
				: 0

			return {
				controller,
				segments,
				kind,
				specificity: segments.map(segment => {
					if (segment === '*') {
						return 1
					}
					return segment.startsWith(':') ? 2 : 3
				}),
			}
		})

		return routes.sort((left, right) => this.compareRoutes(left, right))
	}

	private compareRoutes(left: CompiledRoute, right: CompiledRoute): number {
		if (left.kind !== right.kind) {
			return left.kind - right.kind
		}

		const maxLength = Math.max(left.specificity.length, right.specificity.length)

		for (let index = 0; index < maxLength; index++) {
			const difference = (right.specificity[index] ?? 0) - (left.specificity[index] ?? 0)
			if (difference !== 0) {
				return difference
			}
		}

		return left.controller.getPath().localeCompare(right.controller.getPath())
	}

	private match(pathname: string): MatchedRoute | null {
		const pathSegments = pathname.split('/').slice(1)

		for (const route of this.routes) {
			const hasWildcard = route.segments.at(-1) === '*'
			if (
				(!hasWildcard && route.segments.length !== pathSegments.length) ||
				(hasWildcard && pathSegments.length < route.segments.length - 1)
			) {
				continue
			}

			const params: Record<string, string> = {}
			let matches = true

			for (let index = 0; index < route.segments.length; index++) {
				const routeSegment = route.segments[index]
				const pathSegment = pathSegments[index]

				if (routeSegment === '*') {
					const decoded = this.decodePathSegment(pathSegments.slice(index).join('/'))
					if (decoded === null) {
						matches = false
						break
					}
					params['*'] = decoded
					break
				}

				if (routeSegment.startsWith(':')) {
					const decoded = this.decodePathSegment(pathSegment)
					if (decoded === null) {
						matches = false
						break
					}
					params[routeSegment.slice(1)] = decoded
					continue
				}

				if (routeSegment !== pathSegment) {
					matches = false
					break
				}
			}

			if (matches) {
				return { controller: route.controller, params: Object.freeze(params) }
			}
		}

		return null
	}

	private decodePathSegment(segment: string): string | null {
		try {
			return decodeURIComponent(segment)
		} catch {
			return null
		}
	}

	private isValidData(data: unknown): data is WebSocketData {
		return typeof data === 'object' && data !== null && !Array.isArray(data)
	}

	private async onOpen(ws: InternalWebSocketPeer): Promise<void> {
		const controller = ws.data[WEB_SOCKET_ROUTE]
		if (!controller) {
			logger.error('WebSocket open failed: route metadata is missing.')
			ws.close(1011, 'Internal server error')
			return
		}

		this.controllerBySocket.set(ws, controller)
		this.activeSockets.add(ws)
		trackWebSocketConnection(controller)
		delete ws.data[WEB_SOCKET_ROUTE]

		await this.runSocketHandler(controller, 'open', ws, () => {
			return controller.open(this.toPublicPeer(ws))
		})
	}

	private async onMessage(
		ws: InternalWebSocketPeer,
		message: WebSocketMessage,
	): Promise<void> {
		await this.dispatchSocketHandler(ws, 'message', controller => {
			return controller.message(this.toPublicPeer(ws), message)
		})
	}

	private async onDrain(ws: InternalWebSocketPeer): Promise<void> {
		await this.dispatchSocketHandler(ws, 'drain', controller => {
			return controller.drain(this.toPublicPeer(ws))
		})
	}

	private async onClose(
		ws: InternalWebSocketPeer,
		code: number,
		reason: string,
	): Promise<void> {
		const controller = this.controllerBySocket.get(ws)

		this.activeSockets.delete(ws)
		this.controllerBySocket.delete(ws)
		if (!controller) {
			logger.error('WebSocket close failed: controller metadata is missing.')
			return
		}

		untrackWebSocketConnection(controller)
		await this.runSocketHandler(controller, 'close', ws, () => {
			return controller.close(this.toPublicPeer(ws), code, reason)
		})
	}

	private async onPing(
		ws: InternalWebSocketPeer,
		data: WebSocketPingData,
	): Promise<void> {
		await this.dispatchSocketHandler(ws, 'ping', controller => {
			return controller.ping(this.toPublicPeer(ws), data)
		})
	}

	private async onPong(
		ws: InternalWebSocketPeer,
		data: WebSocketPongData,
	): Promise<void> {
		await this.dispatchSocketHandler(ws, 'pong', controller => {
			return controller.pong(this.toPublicPeer(ws), data)
		})
	}

	private async dispatchSocketHandler(
		ws: InternalWebSocketPeer,
		phase: Exclude<WebSocketErrorPhase, 'upgrade' | 'open' | 'close'>,
		callback: (controller: AnyWebSocketController) => WebSocketHandlerResult,
	): Promise<void> {
		const controller = this.controllerBySocket.get(ws)
		if (!controller) {
			logger.error(`WebSocket ${phase} failed: controller metadata is missing.`)
			ws.close(1011, 'Internal server error')
			return
		}

		await this.runSocketHandler(controller, phase, ws, () => callback(controller))
	}

	private async runSocketHandler(
		controller: AnyWebSocketController,
		phase: Exclude<WebSocketErrorPhase, 'upgrade'>,
		ws: InternalWebSocketPeer,
		callback: () => WebSocketHandlerResult,
	): Promise<void> {
		try {
			await callback()
		} catch (error) {
			await this.handleSocketError(controller, error, {
				phase,
				ws: this.toPublicPeer(ws),
			})
		}
	}

	private async handleUpgradeError(
		controller: AnyWebSocketController,
		error: unknown,
		context: {
			request: Request
			url: URL
			params: Readonly<Record<string, string>>
		},
	): Promise<Response> {
		if (controller.hasErrorHandler()) {
			try {
				const response = await controller.handleError(error, {
					phase: 'upgrade',
					request: context.request,
					url: context.url,
					params: context.params,
				})
				if (response instanceof Response) {
					return response
				}
			} catch (handlerError) {
				this.logHandlerError(controller, 'upgrade', handlerError)
			}
		}

		this.logHandlerError(controller, 'upgrade', error)
		return new Response('Internal Server Error', { status: 500 })
	}

	private async handleSocketError(
		controller: AnyWebSocketController,
		error: unknown,
		context: WebSocketErrorContext<WebSocketData>,
	): Promise<void> {
		if (controller.hasErrorHandler()) {
			try {
				await controller.handleError(error, context)
				return
			} catch (handlerError) {
				this.logHandlerError(controller, context.phase, handlerError)
			}
		}

		this.logHandlerError(controller, context.phase, error)
		if (context.phase !== 'close' && context.ws?.readyState === WebSocket.OPEN) {
			context.ws.close(1011, 'Internal server error')
		}
	}

	private logHandlerError(
		controller: AnyWebSocketController,
		phase: WebSocketErrorPhase,
		error: unknown,
	): void {
		const errorType = error instanceof Error ? error.name : 'UnknownError'
		logger.error(`WebSocket ${controller.getPath()} ${phase} failed (${errorType}).`)
	}

	private toPublicPeer(ws: InternalWebSocketPeer): WebSocketPeer<WebSocketData> {
		return ws as WebSocketPeer<WebSocketData>
	}
}

export type { WebSocketServerOptions, WebSocketUpgradeDispatchResult } from './types'
