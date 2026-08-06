import { afterEach, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Controller } from '../Controller'
import { RouteControllers } from '../RouteControllers'
import { clearStaticRoutesStats, StaticRoutesRegistry } from '../StaticRoutes'
import { WebSocketController } from '../WebSocketController'
import { WebSocketControllers } from '../WebSocketControllers'
import { Server } from './index'

type StaticFixture = {
	rootDirectory: string
	publicDirectory: string
	routes: StaticRoutesRegistry
}

async function createStaticFixture(
	path: string,
	files: Record<string, string | Uint8Array>,
): Promise<StaticFixture> {
	const rootDirectory = await mkdtemp(join(tmpdir(), 's42-core-server-static-'))
	const publicDirectory = join(rootDirectory, 'public')
	await mkdir(publicDirectory)

	for (const [relativePath, contents] of Object.entries(files)) {
		const filePath = join(publicDirectory, relativePath)
		await mkdir(dirname(filePath), { recursive: true })
		await writeFile(filePath, contents)
	}

	const routes = new StaticRoutesRegistry()
	await routes.addModule({
		name: 'test-static',
		version: '1.0.0',
		path,
		publicDirectory,
	})

	return { rootDirectory, publicDirectory, routes }
}

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

afterEach(() => {
	clearStaticRoutesStats()
})

describe('Server integration', () => {
	test('serves static module files with native HTTP semantics', async () => {
		const fixture = await createStaticFixture('/site', {
			'index.html': '<h1>Site</h1>',
			'assets/app.css': 'body{}',
			'assets/data.bin': new Uint8Array([0, 1, 2, 3, 4]),
			'assets/font.woff2': new Uint8Array([5, 6, 7]),
			'.well-known/security.txt': 'contact@example.com',
			'space #%.txt': 'reserved',
			'café.txt': 'unicode',
		})
		const rootPublicDirectory = join(fixture.rootDirectory, 'root-public')
		await mkdir(rootPublicDirectory)
		await writeFile(join(rootPublicDirectory, 'index.html'), '<h1>Root</h1>')
		await fixture.routes.addModule({
			name: 'root-static',
			version: '1.0.0',
			path: '/',
			publicDirectory: rootPublicDirectory,
		})

		const server = new Server()
		await server.start({ port: 0, idleTimeout: 120, StaticRoutes: fixture.routes })

		try {
			expect(await (await fetch(getHTTPURL(server, '/'))).text()).toBe('<h1>Root</h1>')

			const redirect = await fetch(getHTTPURL(server, '/site?theme=dark'), {
				redirect: 'manual',
			})
			expect(redirect.status).toBe(308)
			expect(redirect.headers.get('location')).toBe('/site/?theme=dark')
			expect(await (await fetch(getHTTPURL(server, '/site/'))).text()).toBe(
				'<h1>Site</h1>',
			)
			expect(
				await (await fetch(getHTTPURL(server, '/site/index.html?cache=bust'))).text(),
			).toBe('<h1>Site</h1>')

			expect(
				await (await fetch(getHTTPURL(server, '/site/.well-known/security.txt'))).text(),
			).toBe('contact@example.com')
			expect(
				await (await fetch(getHTTPURL(server, '/site/space%20%23%25.txt'))).text(),
			).toBe('reserved')
			expect(await (await fetch(getHTTPURL(server, '/site/caf%C3%A9.txt'))).text()).toBe(
				'unicode',
			)

			const cssResponse = await fetch(getHTTPURL(server, '/site/assets/app.css'))
			expect(cssResponse.status).toBe(200)
			expect(cssResponse.headers.get('content-type')).toBe('text/css;charset=utf-8')
			expect(cssResponse.headers.get('content-length')).toBe('6')
			expect(cssResponse.headers.get('last-modified')).not.toBeNull()
			expect(await cssResponse.text()).toBe('body{}')

			const headResponse = await fetch(getHTTPURL(server, '/site/assets/app.css'), {
				method: 'HEAD',
			})
			expect(headResponse.status).toBe(200)
			expect(headResponse.headers.get('content-type')).toBe('text/css;charset=utf-8')
			expect(headResponse.headers.get('content-length')).toBe('6')
			expect(headResponse.headers.get('last-modified')).not.toBeNull()
			expect(await headResponse.text()).toBe('')

			const conditionalResponse = await fetch(
				getHTTPURL(server, '/site/assets/app.css'),
				{
					headers: {
						'If-Modified-Since': cssResponse.headers.get('last-modified') ?? '',
					},
				},
			)
			expect(conditionalResponse.status).toBe(304)
			expect(await conditionalResponse.text()).toBe('')

			const rangeResponse = await fetch(getHTTPURL(server, '/site/assets/data.bin'), {
				headers: { Range: 'bytes=1-3' },
			})
			expect(rangeResponse.status).toBe(206)
			expect(rangeResponse.headers.get('content-range')).toBe('bytes 1-3/5')
			expect(new Uint8Array(await rangeResponse.arrayBuffer())).toEqual(
				new Uint8Array([1, 2, 3]),
			)

			const invalidRange = await fetch(getHTTPURL(server, '/site/assets/data.bin'), {
				headers: { Range: 'bytes=99-100' },
			})
			expect(invalidRange.status).toBe(416)
			expect(
				(await fetch(getHTTPURL(server, '/site/assets/font.woff2'))).headers.get(
					'content-type',
				),
			).toBe('font/woff2')

			expect(
				(
					await fetch(getHTTPURL(server, '/site/assets/app.css'), {
						method: 'POST',
					})
				).status,
			).toBe(404)
			expect((await fetch(getHTTPURL(server, '/site/assets/'))).status).toBe(404)
			expect(
				(await fetch(getHTTPURL(server, '/site/%252e%252e/private.txt'))).status,
			).toBe(404)

			await writeFile(join(fixture.publicDirectory, 'assets', 'app.css'), 'new{}')
			expect(await (await fetch(getHTTPURL(server, '/site/assets/app.css'))).text()).toBe(
				'new{}',
			)

			await writeFile(join(fixture.publicDirectory, 'added.txt'), 'not registered')
			expect((await fetch(getHTTPURL(server, '/site/added.txt'))).status).toBe(404)
			await rm(join(fixture.publicDirectory, 'assets', 'app.css'))
			expect((await fetch(getHTTPURL(server, '/site/assets/app.css'))).status).toBe(404)
		} finally {
			await server.stop(true)
			await rm(fixture.rootDirectory, { recursive: true, force: true })
		}
	})

	test('composes static routes with controller methods and rejects exact collisions', async () => {
		const fixture = await createStaticFixture('/assets', {
			'item.txt': 'static item',
		})
		const server = new Server()
		const controllers = new RouteControllers([
			new Controller('POST', '/assets/item.txt', async (_request, response) => {
				return response.json({ source: 'controller' })
			}),
			new Controller('GET', '/assets/*', async (_request, response) => {
				return response.json({ source: 'wildcard' })
			}),
		])

		await server.start({
			port: 0,
			idleTimeout: 120,
			RouteControllers: controllers,
			StaticRoutes: fixture.routes,
		})

		try {
			expect(await (await fetch(getHTTPURL(server, '/assets/item.txt'))).text()).toBe(
				'static item',
			)
			expect(
				await (
					await fetch(getHTTPURL(server, '/assets/item.txt'), { method: 'POST' })
				).json(),
			).toEqual({ source: 'controller' })
			expect(await (await fetch(getHTTPURL(server, '/assets/other.txt'))).json()).toEqual(
				{ source: 'wildcard' },
			)
		} finally {
			await server.stop(true)
		}

		const collidingServer = new Server()
		const collidingControllers = new RouteControllers([
			new Controller('GET', '/assets/item.txt', async (_request, response) => {
				return response.text('controller item')
			}),
		])
		await expect(
			collidingServer.start({
				port: 0,
				RouteControllers: collidingControllers,
				StaticRoutes: fixture.routes,
			}),
		).rejects.toThrow(
			'Static route collision for GET "/assets/item.txt" from test-static@1.0.0 public/item.txt with an HTTP controller',
		)
		expect(collidingServer.getPort()).toBeUndefined()
		await rm(fixture.rootDirectory, { recursive: true, force: true })
	})

	test('attempts WebSocket upgrade before a static GET on the same path', async () => {
		const fixture = await createStaticFixture('/shared', {
			'socket.txt': 'static fallback',
		})
		const server = new Server()
		const sockets = new WebSocketControllers([
			new WebSocketController({
				path: '/shared/socket.txt',
				upgrade: () => ({ data: {} }),
				message: (ws, message) => ws.send(message),
			}),
		])

		await server.start({
			port: 0,
			idleTimeout: 120,
			StaticRoutes: fixture.routes,
			WebSocketControllers: sockets,
		})

		let socket: WebSocket | undefined
		try {
			expect(await (await fetch(getHTTPURL(server, '/shared/socket.txt'))).text()).toBe(
				'static fallback',
			)

			socket = await openWebSocket(getWebSocketURL(server, '/shared/socket.txt'))
			const echoed = nextMessage(socket)
			socket.send('through-websocket')
			expect(String((await echoed).data)).toBe('through-websocket')
		} finally {
			if (socket && socket.readyState < WebSocket.CLOSING) {
				const closed = nextClose(socket)
				socket.close()
				await closed
			}
			await server.stop(true)
			await rm(fixture.rootDirectory, { recursive: true, force: true })
		}
	})

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
