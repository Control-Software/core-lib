import { describe, expect, test } from 'bun:test'
import { Controller } from '../Controller'
import { RouteControllers } from '../RouteControllers'
import { WebSocketController } from '../WebSocketController'
import { WebSocketControllers } from '../WebSocketControllers'
import { Server } from './index'

function getHTTPURL(server: Server, path: string): string {
	const port = server.getPort()
	if (!port) {
		throw new Error('Test server did not expose a port.')
	}

	return `http://127.0.0.1:${port}${path}`
}

function getWebSocketURL(server: Server, path: string): string {
	return getHTTPURL(server, path).replace(/^http:/, 'ws:')
}

function openWebSocket(url: string, protocols?: string[]): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const socket = protocols ? new WebSocket(url, protocols) : new WebSocket(url)
		const timeout = setTimeout(() => {
			socket.close()
			reject(new Error(`Timed out opening ${url}`))
		}, 2000)

		const onOpen = (): void => {
			clearTimeout(timeout)
			socket.removeEventListener('error', onError)
			resolve(socket)
		}
		const onError = (): void => {
			clearTimeout(timeout)
			socket.removeEventListener('open', onOpen)
			reject(new Error(`Failed to open ${url}`))
		}

		socket.addEventListener('open', onOpen, { once: true })
		socket.addEventListener('error', onError, { once: true })
	})
}

function nextMessage(socket: WebSocket): Promise<MessageEvent> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error('Timed out waiting for a WebSocket message.'))
		}, 2000)

		const onMessage = (event: MessageEvent): void => {
			clearTimeout(timeout)
			socket.removeEventListener('close', onClose)
			resolve(event)
		}
		const onClose = (): void => {
			clearTimeout(timeout)
			socket.removeEventListener('message', onMessage)
			reject(new Error('WebSocket closed before receiving a message.'))
		}

		socket.addEventListener('message', onMessage, { once: true })
		socket.addEventListener('close', onClose, { once: true })
	})
}

function nextClose(socket: WebSocket): Promise<CloseEvent> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error('Timed out waiting for a WebSocket close event.'))
		}, 2000)

		socket.addEventListener(
			'close',
			event => {
				clearTimeout(timeout)
				resolve(event)
			},
			{ once: true },
		)
	})
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (condition()) {
			return
		}
		await Bun.sleep(5)
	}

	throw new Error(message)
}

describe('Server WebSocket integration', () => {
	test('keeps HTTP behavior unchanged without WebSocket configuration', async () => {
		const server = new Server()
		const routes = new RouteControllers([
			new Controller('GET', '/health', async (_request, response) => {
				return response.json({ ok: true })
			}),
		])

		expect(server.getPendingWebSockets()).toBe(0)
		expect(() => server.publish('topic', 'message')).toThrow('requires a started server')
		expect(() => server.subscriberCount('topic')).toThrow('requires a started server')

		await server.start({ port: 0, idleTimeout: 120, RouteControllers: routes })
		try {
			const response = await fetch(getHTTPURL(server, '/health'))
			expect(response.status).toBe(200)
			expect(await response.json()).toEqual({ ok: true })
			expect(server.getPendingWebSockets()).toBe(0)
			expect(server.closeWebSockets()).toBe(0)
		} finally {
			await server.stop(true)
		}

		expect(server.getPendingWebSockets()).toBe(0)
		expect(server.getPort()).toBeUndefined()
	})

	test('serves overlapping HTTP and WebSocket routes on one port', async () => {
		const server = new Server()
		const httpRoutes = new RouteControllers([
			new Controller('GET', '/shared/:roomId', async (request, response) => {
				const { params } = request as { params?: Record<string, string> }
				return response.json({ transport: 'http', roomId: params?.roomId })
			}),
		])
		const sockets = new WebSocketControllers([
			new WebSocketController<{ roomId: string }>({
				path: '/shared/:roomId',
				upgrade({ request, params }) {
					if (new URL(request.url).searchParams.get('ticket') !== 'allowed') {
						return new Response('Unauthorized', {
							status: 401,
							headers: { 'X-Rejected': 'yes' },
						})
					}

					return {
						data: { roomId: params.roomId },
						headers: { 'Sec-WebSocket-Protocol': 's42.chat' },
					}
				},
				message(ws, message) {
					if (typeof message === 'string') {
						return ws.send(JSON.stringify({ roomId: ws.data.roomId, message }))
					}

					return ws.send(message)
				},
			}),
			new WebSocketController({
				path: '/socket-only',
				upgrade: () => ({ data: {} }),
			}),
		])

		await server.start({
			port: 0,
			idleTimeout: 120,
			RouteControllers: httpRoutes,
			WebSocketControllers: sockets,
		})

		let client: WebSocket | undefined
		try {
			const httpResponse = await fetch(getHTTPURL(server, '/shared/room-1'))
			expect(await httpResponse.json()).toEqual({
				transport: 'http',
				roomId: 'room-1',
			})
			expect((await fetch(getHTTPURL(server, '/socket-only'))).status).toBe(404)

			const rejected = await fetch(getHTTPURL(server, '/shared/room-1'), {
				headers: {
					Connection: 'Upgrade',
					Upgrade: 'websocket',
					'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
					'Sec-WebSocket-Version': '13',
				},
			})
			expect(rejected.status).toBe(401)
			expect(rejected.headers.get('x-rejected')).toBe('yes')
			expect(await rejected.text()).toBe('Unauthorized')

			client = await openWebSocket(
				getWebSocketURL(server, '/shared/room-1?ticket=allowed'),
				['s42.chat'],
			)
			expect(client.protocol).toBe('s42.chat')

			const textMessage = nextMessage(client)
			client.send('hello')
			expect(JSON.parse(String((await textMessage).data))).toEqual({
				roomId: 'room-1',
				message: 'hello',
			})

			client.binaryType = 'arraybuffer'
			const binaryMessage = nextMessage(client)
			client.send(new Uint8Array([1, 2, 3, 4]))
			expect(new Uint8Array((await binaryMessage).data as ArrayBuffer)).toEqual(
				new Uint8Array([1, 2, 3, 4]),
			)
		} finally {
			if (client && client.readyState < WebSocket.CLOSING) {
				const closed = nextClose(client)
				client.close()
				await closed
			}
			await server.stop(true)
		}
	})

	test('preserves Bun pub/sub, process-local metrics and coordinated close', async () => {
		const server = new Server()
		const sockets = new WebSocketControllers(
			[
				new WebSocketController<{ room: string }>({
					path: '/rooms/:room',
					upgrade: ({ params }) => ({ data: { room: params.room } }),
					open(ws) {
						ws.subscribe(`room:${ws.data.room}`)
					},
					message(ws, message) {
						return ws.publish(`room:${ws.data.room}`, message)
					},
				}),
			],
			{ publishToSelf: true },
		)

		await server.start({
			port: 0,
			idleTimeout: 120,
			WebSocketControllers: sockets,
		})

		const first = await openWebSocket(getWebSocketURL(server, '/rooms/main'))
		const second = await openWebSocket(getWebSocketURL(server, '/rooms/main'))
		try {
			await waitFor(
				() => server.subscriberCount('room:main') === 2,
				'Expected two WebSocket subscribers.',
			)
			expect(server.getPendingWebSockets()).toBe(2)
			expect(sockets.getActiveConnections()).toBe(2)

			const firstPeerMessage = nextMessage(first)
			const secondPeerMessage = nextMessage(second)
			first.send('from-first')
			expect(String((await firstPeerMessage).data)).toBe('from-first')
			expect(String((await secondPeerMessage).data)).toBe('from-first')

			const firstExternalMessage = nextMessage(first)
			const secondExternalMessage = nextMessage(second)
			expect(server.publish('room:main', 'external')).toBeGreaterThan(0)
			expect(String((await firstExternalMessage).data)).toBe('external')
			expect(String((await secondExternalMessage).data)).toBe('external')

			const firstClosed = nextClose(first)
			const secondClosed = nextClose(second)
			expect(server.closeWebSockets()).toBe(2)
			const firstCloseEvent = await firstClosed
			const secondCloseEvent = await secondClosed
			expect([1000, 1001]).toContain(firstCloseEvent.code)
			expect([1000, 1001]).toContain(secondCloseEvent.code)
			expect(firstCloseEvent.reason).toBe('Server shutting down')
			expect(secondCloseEvent.reason).toBe('Server shutting down')
			await waitFor(
				() => sockets.getActiveConnections() === 0,
				'Expected the WebSocket registry to close.',
			)
			await server.stop(true)
			expect(server.getPendingWebSockets()).toBe(0)
		} finally {
			await server.stop(true)
		}
	})

	test('enforces maxPayloadLength without dispatching an oversized message', async () => {
		const server = new Server()
		let messageReceived = false
		const sockets = new WebSocketControllers(
			[
				new WebSocketController({
					path: '/limited',
					upgrade: () => ({ data: {} }),
					message: () => {
						messageReceived = true
					},
				}),
			],
			{ maxPayloadLength: 8 },
		)

		await server.start({
			port: 0,
			idleTimeout: 120,
			WebSocketControllers: sockets,
		})
		const limited = await openWebSocket(getWebSocketURL(server, '/limited'))
		const payloadClose = nextClose(limited)
		limited.send('this payload is too large')
		expect([1006, 1009]).toContain((await payloadClose).code)
		expect(messageReceived).toBe(false)

		await server.stop(true)
		expect(server.getPort()).toBeUndefined()
	})

	test('supports graceful and forced shutdown for active sockets', async () => {
		const gracefulServer = new Server()
		const gracefulSockets = new WebSocketControllers([
			new WebSocketController({
				path: '/graceful',
				upgrade: () => ({ data: {} }),
			}),
		])
		await gracefulServer.start({
			port: 0,
			idleTimeout: 120,
			WebSocketControllers: gracefulSockets,
		})
		const graceful = await openWebSocket(getWebSocketURL(gracefulServer, '/graceful'))
		let gracefulStopped = false
		const gracefulStop = gracefulServer.stop().then(() => {
			gracefulStopped = true
		})
		await Bun.sleep(10)
		expect(gracefulStopped).toBe(false)
		const gracefulClose = nextClose(graceful)
		graceful.close()
		await gracefulClose
		await gracefulStop
		expect(gracefulStopped).toBe(true)

		const forcedServer = new Server()
		const forcedSockets = new WebSocketControllers([
			new WebSocketController({
				path: '/forced',
				upgrade: () => ({ data: {} }),
			}),
		])
		await forcedServer.start({
			port: 0,
			idleTimeout: 120,
			WebSocketControllers: forcedSockets,
		})
		const active = await openWebSocket(getWebSocketURL(forcedServer, '/forced'))
		const forcedClose = nextClose(active)
		await forcedServer.stop(true)
		await forcedClose
		expect(forcedServer.getPendingWebSockets()).toBe(0)
		expect(forcedServer.getPort()).toBeUndefined()

		await waitFor(
			() => forcedSockets.getActiveConnections() === 0,
			'Expected force-stop to clean the connection registry.',
		)
	})
})
