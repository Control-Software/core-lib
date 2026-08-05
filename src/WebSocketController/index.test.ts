import { beforeEach, describe, expect, test } from 'bun:test'
import {
	clearWebSocketControllersStats,
	getWebSocketControllersStats,
	WebSocketController,
} from './index'

describe('WebSocketController', () => {
	beforeEach(() => {
		clearWebSocketControllersStats()
	})

	test('preserves strongly typed connection data and native callback values', () => {
		type ChatData = {
			userId: string
			roomId: string
		}

		const controller = new WebSocketController<ChatData>({
			path: '/ws/chat/:roomId',
			upgrade({ params, query, remoteAddress }) {
				const roomId: string = params.roomId
				const filter: string | null = query.get('filter')
				const address: Bun.SocketAddress | null = remoteAddress

				void filter
				void address
				return { data: { userId: 'user-1', roomId } }
			},
			open(ws) {
				const userId: string = ws.data.userId
				void userId
			},
			message: (ws, message) => ws.send(message),
		})

		expect(controller.getPath()).toBe('/ws/chat/:roomId')
		expect(getWebSocketControllersStats()).toEqual({
			totalControllers: 1,
			activeConnections: 0,
			routes: [{ path: '/ws/chat/:roomId', activeConnections: 0 }],
		})
	})

	test('requires a valid absolute route and an upgrade callback', () => {
		const upgrade = () => ({ data: {} })

		expect(() => new WebSocketController({ path: 'ws/chat', upgrade })).toThrow(
			'must start with',
		)
		expect(
			() => new WebSocketController({ path: '/ws/chat?token=value', upgrade }),
		).toThrow('cannot include a query or hash')
		expect(() => new WebSocketController({ path: '/ws/*/messages', upgrade })).toThrow(
			'must be the last segment',
		)
		expect(() => new WebSocketController({ path: '/ws/prefix*', upgrade })).toThrow(
			'must be a complete segment',
		)
		expect(() => new WebSocketController({ path: '/ws/:room/:room', upgrade })).toThrow(
			'Duplicate WebSocketController parameter',
		)
		expect(() => new WebSocketController({ path: '/ws/:bad-name', upgrade })).toThrow(
			'Invalid WebSocketController parameter name',
		)
		expect(
			() =>
				new WebSocketController({
					path: '/ws/chat',
					upgrade: undefined as never,
				}),
		).toThrow('requires an upgrade callback')
	})
})
