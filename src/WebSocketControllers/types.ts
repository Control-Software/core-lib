import type { WebSocketData } from '../WebSocketController'

export type WebSocketServerOptions = Pick<
	Bun.WebSocketHandler<WebSocketData>,
	| 'maxPayloadLength'
	| 'backpressureLimit'
	| 'closeOnBackpressureLimit'
	| 'idleTimeout'
	| 'publishToSelf'
	| 'sendPings'
	| 'perMessageDeflate'
>

export type WebSocketUpgradeDispatchResult =
	| { matched: false; response?: never }
	| { matched: true; response?: Response }
