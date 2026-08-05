import { beforeEach, describe, expect, test } from 'bun:test'
import {
	clearWebSocketControllersStats,
	getWebSocketControllersStats,
	WebSocketController,
} from '../WebSocketController'
import { WebSocketControllers } from './index'

type UpgradeOptions = {
	data: Record<PropertyKey, unknown>
	headers?: Bun.HeadersInit
}

type FakeServer = {
	server: Parameters<WebSocketControllers['tryUpgrade']>[1]
	getUpgradeOptions(): UpgradeOptions | undefined
}

function createFakeServer(upgradeResult = true): FakeServer {
	let upgradeOptions: UpgradeOptions | undefined
	const server = {
		requestIP: () => null,
		upgrade: (_request: Request, options: UpgradeOptions) => {
			upgradeOptions = options
			return upgradeResult
		},
	} as unknown as Parameters<WebSocketControllers['tryUpgrade']>[1]

	return {
		server,
		getUpgradeOptions: () => upgradeOptions,
	}
}

function upgradeRequest(path: string, headers: Bun.HeadersInit = {}): Request {
	return new Request(`http://localhost${path}`, {
		headers: { Upgrade: 'websocket', ...headers },
	})
}

function createFakeSocket(
	data: Record<PropertyKey, unknown>,
	closeCalls: Array<[number | undefined, string | undefined]> = [],
) {
	return {
		data,
		readyState: WebSocket.OPEN,
		close(code?: number, reason?: string) {
			closeCalls.push([code, reason])
		},
	}
}

describe('WebSocketControllers', () => {
	beforeEach(() => {
		clearWebSocketControllersStats()
	})

	test('matches exact, parameterized and terminal wildcard routes deterministically', async () => {
		const visited: string[] = []
		const sockets = new WebSocketControllers([
			new WebSocketController({
				path: '/rooms/:id',
				upgrade: ({ params }) => {
					visited.push(`parameter:${params.id}`)
					return { data: { route: 'parameter' } }
				},
			}),
			new WebSocketController({
				path: '/rooms/special',
				upgrade: () => {
					visited.push('exact')
					return { data: { route: 'exact' } }
				},
			}),
			new WebSocketController({
				path: '/rooms/*',
				upgrade: ({ params }) => {
					visited.push(`wildcard:${params['*']}`)
					return { data: { route: 'wildcard' } }
				},
			}),
		])

		for (const path of ['/rooms/special', '/rooms/42', '/rooms/a/b']) {
			const fake = createFakeServer()
			const result = await sockets.tryUpgrade(upgradeRequest(path), fake.server)
			expect(result).toEqual({ matched: true, response: undefined })
		}

		expect(visited).toEqual(['exact', 'parameter:42', 'wildcard:a/b'])
	})

	test('rejects duplicate and equivalent parameter routes', () => {
		const first = new WebSocketController({
			path: '/rooms/:id',
			upgrade: () => ({ data: {} }),
		})

		expect(() => new WebSocketControllers([first, first])).toThrow(
			'Ambiguous WebSocket routes',
		)
		expect(
			() =>
				new WebSocketControllers([
					first,
					new WebSocketController({
						path: '/rooms/:name',
						upgrade: () => ({ data: {} }),
					}),
				]),
		).toThrow('Ambiguous WebSocket routes')
	})

	test('falls through non-upgrade requests and unmatched paths', async () => {
		const sockets = new WebSocketControllers([
			new WebSocketController({
				path: '/ws/echo',
				upgrade: () => ({ data: {} }),
			}),
		])
		const fake = createFakeServer()

		expect(
			await sockets.tryUpgrade(new Request('http://localhost/ws/echo'), fake.server),
		).toEqual({ matched: false })
		expect(await sockets.tryUpgrade(upgradeRequest('/ws/missing'), fake.server)).toEqual({
			matched: false,
		})
		expect(fake.getUpgradeOptions()).toBeUndefined()
	})

	test('preserves rejection responses and accepted headers', async () => {
		const rejecting = new WebSocketControllers([
			new WebSocketController({
				path: '/ws/private',
				upgrade: () => new Response('Unauthorized', { status: 401 }),
			}),
		])
		const rejected = await rejecting.tryUpgrade(
			upgradeRequest('/ws/private'),
			createFakeServer().server,
		)

		expect(rejected.matched).toBe(true)
		expect(rejected.response?.status).toBe(401)
		expect(await rejected.response?.text()).toBe('Unauthorized')

		const accepting = new WebSocketControllers([
			new WebSocketController({
				path: '/ws/chat',
				upgrade: () => ({
					data: { userId: 'user-1' },
					headers: { 'Set-Cookie': 'session=renewed' },
				}),
			}),
		])
		const fake = createFakeServer()
		await accepting.tryUpgrade(upgradeRequest('/ws/chat'), fake.server)

		expect(fake.getUpgradeOptions()?.headers).toEqual({
			'Set-Cookie': 'session=renewed',
		})
		expect(fake.getUpgradeOptions()?.data.userId).toBe('user-1')
	})

	test('sanitizes upgrade failures and lets handleError reject explicitly', async () => {
		const handled = new WebSocketControllers([
			new WebSocketController({
				path: '/ws/handled',
				upgrade: () => {
					throw new Error('secret token')
				},
				handleError: (_error, { phase }) => new Response(phase, { status: 403 }),
			}),
		])
		const handledResult = await handled.tryUpgrade(
			upgradeRequest('/ws/handled'),
			createFakeServer().server,
		)

		expect(handledResult.response?.status).toBe(403)
		expect(await handledResult.response?.text()).toBe('upgrade')

		const unhandled = new WebSocketControllers([
			new WebSocketController({
				path: '/ws/unhandled',
				upgrade: () => {
					throw new Error('secret token')
				},
			}),
		])
		const unhandledResult = await unhandled.tryUpgrade(
			upgradeRequest('/ws/unhandled'),
			createFakeServer().server,
		)

		expect(unhandledResult.response?.status).toBe(500)
		expect(await unhandledResult.response?.text()).toBe('Internal Server Error')
	})

	test('returns a controlled response for invalid data or a failed Bun upgrade', async () => {
		const invalid = new WebSocketControllers([
			new WebSocketController({
				path: '/ws/invalid',
				upgrade: (() => ({ data: null })) as never,
				handleError: () => new Response('invalid', { status: 422 }),
			}),
		])
		const invalidResult = await invalid.tryUpgrade(
			upgradeRequest('/ws/invalid'),
			createFakeServer().server,
		)
		expect(invalidResult.response?.status).toBe(422)

		const valid = new WebSocketControllers([
			new WebSocketController({
				path: '/ws/valid',
				upgrade: () => ({ data: {} }),
			}),
		])
		const failedResult = await valid.tryUpgrade(
			upgradeRequest('/ws/valid'),
			createFakeServer(false).server,
		)
		expect(failedResult.response?.status).toBe(400)
		expect(await failedResult.response?.text()).toBe('WebSocket upgrade failed')
	})

	test('dispatches lifecycle callbacks after removing private data metadata', async () => {
		const events: string[] = []
		const controller = new WebSocketController<{ value: string }>({
			path: '/ws/lifecycle',
			upgrade: () => ({ data: { value: 'initial' } }),
			open(ws) {
				events.push(`open:${ws.data.value}`)
				expect(Object.getOwnPropertySymbols(ws.data)).toHaveLength(0)
				ws.data = { value: 'changed' }
			},
			message: (ws, message) => {
				events.push(`message:${ws.data.value}:${String(message)}`)
			},
			drain: ws => {
				events.push(`drain:${ws.data.value}`)
			},
			ping: (_ws, data) => {
				events.push(`ping:${data.toString()}`)
			},
			pong: (_ws, data) => {
				events.push(`pong:${data.toString()}`)
			},
			close: (ws, code, reason) => {
				events.push(`close:${ws.data.value}:${code}:${reason}`)
			},
		})
		const sockets = new WebSocketControllers([controller])
		const fake = createFakeServer()

		await sockets.tryUpgrade(upgradeRequest('/ws/lifecycle'), fake.server)
		const upgradeData = fake.getUpgradeOptions()?.data
		expect(upgradeData).toBeDefined()
		expect(Object.keys(upgradeData ?? {})).toEqual(['value'])
		expect(Object.getOwnPropertySymbols(upgradeData ?? {})).toHaveLength(1)

		const socket = createFakeSocket(upgradeData ?? {})
		const handler = sockets.getHandler()
		await handler.open?.(socket as never)
		await handler.message(socket as never, Buffer.from('hello'))
		await handler.drain?.(socket as never)
		await handler.ping?.(socket as never, Buffer.from('one'))
		await handler.pong?.(socket as never, Buffer.from('two'))
		await handler.close?.(socket as never, 1000, 'done')

		expect(events).toEqual([
			'open:initial',
			'message:changed:hello',
			'drain:changed',
			'ping:one',
			'pong:two',
			'close:changed:1000:done',
		])
		expect(sockets.getActiveConnections()).toBe(0)
		expect(getWebSocketControllersStats().activeConnections).toBe(0)
	})

	test('forwards native options, returns one handler and closes tracked sockets', async () => {
		const controller = new WebSocketController({
			path: '/ws/operations',
			upgrade: () => ({ data: {} }),
		})
		const sockets = new WebSocketControllers([controller], {
			idleTimeout: 45,
			maxPayloadLength: 1024,
			backpressureLimit: 2048,
			closeOnBackpressureLimit: true,
			publishToSelf: true,
			sendPings: false,
			perMessageDeflate: true,
		})
		const fake = createFakeServer()
		await sockets.tryUpgrade(upgradeRequest('/ws/operations'), fake.server)
		const closeCalls: Array<[number | undefined, string | undefined]> = []
		const socket = createFakeSocket(fake.getUpgradeOptions()?.data ?? {}, closeCalls)
		const handler = sockets.getHandler()

		expect(sockets.getHandler()).toBe(handler)
		expect(handler).toMatchObject({
			idleTimeout: 45,
			maxPayloadLength: 1024,
			backpressureLimit: 2048,
			closeOnBackpressureLimit: true,
			publishToSelf: true,
			sendPings: false,
			perMessageDeflate: true,
		})

		await handler.open?.(socket as never)
		expect(sockets.getActiveConnections()).toBe(1)
		expect(getWebSocketControllersStats().activeConnections).toBe(1)
		expect(sockets.closeAll(1012, 'Restarting')).toBe(1)
		expect(closeCalls).toEqual([[1012, 'Restarting']])
		await handler.close?.(socket as never, 1012, 'Restarting')
		expect(sockets.getActiveConnections()).toBe(0)
	})

	test('uses the safe close fallback for unhandled application errors', async () => {
		const controller = new WebSocketController({
			path: '/ws/errors',
			upgrade: () => ({ data: {} }),
			message: () => {
				throw new Error('sensitive payload')
			},
		})
		const sockets = new WebSocketControllers([controller])
		const fake = createFakeServer()
		await sockets.tryUpgrade(upgradeRequest('/ws/errors'), fake.server)
		const closeCalls: Array<[number | undefined, string | undefined]> = []
		const socket = createFakeSocket(fake.getUpgradeOptions()?.data ?? {}, closeCalls)
		const handler = sockets.getHandler()

		await handler.open?.(socket as never)
		await handler.message(socket as never, 'secret')

		expect(closeCalls).toEqual([[1011, 'Internal server error']])
	})

	test('always removes closed sockets even when the close callback fails', async () => {
		const phases: string[] = []
		const controller = new WebSocketController({
			path: '/ws/cleanup',
			upgrade: () => ({ data: {} }),
			close: () => {
				throw new Error('cleanup failed')
			},
			handleError: (_error, { phase }) => {
				phases.push(phase)
			},
		})
		const sockets = new WebSocketControllers([controller])
		const fake = createFakeServer()
		await sockets.tryUpgrade(upgradeRequest('/ws/cleanup'), fake.server)
		const socket = createFakeSocket(fake.getUpgradeOptions()?.data ?? {})
		const handler = sockets.getHandler()

		await handler.open?.(socket as never)
		await handler.close?.(socket as never, 1000, 'done')

		expect(phases).toEqual(['close'])
		expect(sockets.getActiveConnections()).toBe(0)
		expect(getWebSocketControllersStats().activeConnections).toBe(0)
	})
})
