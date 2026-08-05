import type {
	WebSocketControllerOptions,
	WebSocketData,
	WebSocketErrorContext,
	WebSocketHandlerResult,
	WebSocketMessage,
	WebSocketPeer,
	WebSocketPingData,
	WebSocketPongData,
	WebSocketUpgradeContext,
	WebSocketUpgradeResult,
} from './types'

export type WebSocketControllerStatsRoute = {
	path: string
	activeConnections: number
}

export type WebSocketControllersStats = {
	totalControllers: number
	activeConnections: number
	routes: WebSocketControllerStatsRoute[]
}

type AnyWebSocketController = WebSocketController<any>

const registeredControllers = new Set<AnyWebSocketController>()
const activeConnections = new Map<AnyWebSocketController, number>()

export function getWebSocketControllersStats(): WebSocketControllersStats {
	const routes = Array.from(registeredControllers, controller => ({
		path: controller.getPath(),
		activeConnections: activeConnections.get(controller) ?? 0,
	})).sort((left, right) => left.path.localeCompare(right.path))

	return {
		totalControllers: registeredControllers.size,
		activeConnections: routes.reduce(
			(total, route) => total + route.activeConnections,
			0,
		),
		routes,
	}
}

export function clearWebSocketControllersStats(): void {
	registeredControllers.clear()
	activeConnections.clear()
}

export function trackWebSocketConnection(controller: AnyWebSocketController): void {
	activeConnections.set(controller, (activeConnections.get(controller) ?? 0) + 1)
}

export function untrackWebSocketConnection(controller: AnyWebSocketController): void {
	const current = activeConnections.get(controller) ?? 0
	activeConnections.set(controller, Math.max(0, current - 1))
}

export class WebSocketController<TData extends WebSocketData = WebSocketData> {
	private readonly properties: WebSocketControllerOptions<TData>

	public constructor(properties: WebSocketControllerOptions<TData>) {
		this.validateProperties(properties)
		this.properties = properties
		registeredControllers.add(this)
	}

	public getPath(): string {
		return this.properties.path
	}

	public upgrade(
		context: WebSocketUpgradeContext,
	): WebSocketUpgradeResult<TData> | Promise<WebSocketUpgradeResult<TData>> {
		return this.properties.upgrade(context)
	}

	public open(ws: WebSocketPeer<TData>): WebSocketHandlerResult {
		return this.properties.open?.(ws)
	}

	public message(
		ws: WebSocketPeer<TData>,
		message: WebSocketMessage,
	): WebSocketHandlerResult {
		return this.properties.message?.(ws, message)
	}

	public drain(ws: WebSocketPeer<TData>): WebSocketHandlerResult {
		return this.properties.drain?.(ws)
	}

	public close(
		ws: WebSocketPeer<TData>,
		code: number,
		reason: string,
	): WebSocketHandlerResult {
		return this.properties.close?.(ws, code, reason)
	}

	public ping(ws: WebSocketPeer<TData>, data: WebSocketPingData): WebSocketHandlerResult {
		return this.properties.ping?.(ws, data)
	}

	public pong(ws: WebSocketPeer<TData>, data: WebSocketPongData): WebSocketHandlerResult {
		return this.properties.pong?.(ws, data)
	}

	public handleError(
		error: unknown,
		context: WebSocketErrorContext<TData>,
	): Response | void | Promise<Response | void> {
		return this.properties.handleError?.(error, context)
	}

	public hasErrorHandler(): boolean {
		return typeof this.properties.handleError === 'function'
	}

	private validateProperties(properties: WebSocketControllerOptions<TData>): void {
		if (!properties || typeof properties !== 'object') {
			throw new TypeError('WebSocketController options must be an object.')
		}

		if (typeof properties.upgrade !== 'function') {
			throw new TypeError('WebSocketController requires an upgrade callback.')
		}

		this.validatePath(properties.path)
	}

	private validatePath(path: string): void {
		if (typeof path !== 'string' || !path.length || !path.startsWith('/')) {
			throw new TypeError('WebSocketController path must start with "/".')
		}

		if (path.includes('?') || path.includes('#')) {
			throw new TypeError('WebSocketController path cannot include a query or hash.')
		}

		const parameterNames = new Set<string>()
		const segments = path.split('/').slice(1)

		for (const [index, segment] of segments.entries()) {
			if (segment.includes('*') && segment !== '*') {
				throw new TypeError('WebSocketController wildcard must be a complete segment.')
			}

			if (segment === '*' && index !== segments.length - 1) {
				throw new TypeError('WebSocketController wildcard must be the last segment.')
			}

			if (!segment.startsWith(':')) {
				continue
			}

			const parameterName = segment.slice(1)
			if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(parameterName)) {
				throw new TypeError(
					`Invalid WebSocketController parameter name "${parameterName}".`,
				)
			}

			if (parameterNames.has(parameterName)) {
				throw new TypeError(`Duplicate WebSocketController parameter "${parameterName}".`)
			}

			parameterNames.add(parameterName)
		}
	}
}

export type {
	ModuleWebSocketControllerDefinition,
	WebSocketControllerOptions,
	WebSocketData,
	WebSocketErrorContext,
	WebSocketErrorPhase,
	WebSocketHandlerResult,
	WebSocketMessage,
	WebSocketPeer,
	WebSocketPingData,
	WebSocketPongData,
	WebSocketUpgradeAccept,
	WebSocketUpgradeContext,
	WebSocketUpgradeResult,
} from './types'
