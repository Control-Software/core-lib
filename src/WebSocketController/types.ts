export type WebSocketData = Record<string, unknown>

export type WebSocketPeer<TData extends WebSocketData> = Bun.ServerWebSocket<TData>

export type WebSocketMessage = Parameters<
	Bun.WebSocketHandler<WebSocketData>['message']
>[1]

export type WebSocketPingData = Parameters<
	NonNullable<Bun.WebSocketHandler<WebSocketData>['ping']>
>[1]

export type WebSocketPongData = Parameters<
	NonNullable<Bun.WebSocketHandler<WebSocketData>['pong']>
>[1]

export type WebSocketUpgradeContext = {
	request: Request
	url: URL
	params: Readonly<Record<string, string>>
	query: URLSearchParams
	remoteAddress: Bun.SocketAddress | null
}

export type WebSocketUpgradeAccept<TData extends WebSocketData> = {
	data: TData
	headers?: Bun.HeadersInit
}

export type WebSocketUpgradeResult<TData extends WebSocketData> =
	| WebSocketUpgradeAccept<TData>
	| Response

export type WebSocketErrorPhase =
	| 'upgrade'
	| 'open'
	| 'message'
	| 'drain'
	| 'close'
	| 'ping'
	| 'pong'

export type WebSocketErrorContext<TData extends WebSocketData> = {
	phase: WebSocketErrorPhase
	request?: Request
	url?: URL
	params?: Readonly<Record<string, string>>
	ws?: WebSocketPeer<TData>
}

type MaybePromise<T> = T | Promise<T>

export type WebSocketHandlerResult = MaybePromise<void | Bun.ServerWebSocketSendStatus>

export type WebSocketControllerOptions<TData extends WebSocketData> = {
	path: string
	upgrade: (
		context: WebSocketUpgradeContext,
	) => MaybePromise<WebSocketUpgradeResult<TData>>
	open?: (ws: WebSocketPeer<TData>) => WebSocketHandlerResult
	message?: (
		ws: WebSocketPeer<TData>,
		message: WebSocketMessage,
	) => WebSocketHandlerResult
	drain?: (ws: WebSocketPeer<TData>) => WebSocketHandlerResult
	close?: (
		ws: WebSocketPeer<TData>,
		code: number,
		reason: string,
	) => WebSocketHandlerResult
	ping?: (ws: WebSocketPeer<TData>, data: WebSocketPingData) => WebSocketHandlerResult
	pong?: (ws: WebSocketPeer<TData>, data: WebSocketPongData) => WebSocketHandlerResult
	handleError?: (
		error: unknown,
		context: WebSocketErrorContext<TData>,
	) => MaybePromise<Response | void>
}

export type ModuleWebSocketControllerDefinition<TData extends WebSocketData> =
	WebSocketControllerOptions<TData> & {
		name: string
		version: string
		enabled?: boolean
	}
