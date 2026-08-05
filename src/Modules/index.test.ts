import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearControllersStats } from '../Controller'
import { setLogSink, type LogSink } from '../Logger'
import { clearWebSocketControllersStats } from '../WebSocketController'
import { clearModulesStats, getModulesStats, Modules } from './index'

const defaultLogSink: LogSink = {
	debug: (...args) => console.log(...args),
	info: (...args) => console.info(...args),
	warn: (...args) => console.warn(...args),
	error: (...args) => console.error(...args),
}

describe('getModulesStats', () => {
	let fixtureDir = ''

	beforeEach(async () => {
		clearControllersStats()
		clearWebSocketControllersStats()
		clearModulesStats()
		fixtureDir = await mkdtemp(join(tmpdir(), 's42-core-modules-'))

		await mkdir(join(fixtureDir, 'auth', 'mws'), { recursive: true })
		await mkdir(join(fixtureDir, 'share'), { recursive: true })
		await mkdir(join(fixtureDir, 'operators', 'controllers'), { recursive: true })
		await mkdir(join(fixtureDir, 'operators', 'websockets'), { recursive: true })

		await writeFile(
			join(fixtureDir, 'auth', '__module__.ts'),
			`export default { name: 'auth', version: '1.0.0', type: 'mws' }\n`,
		)
		await writeFile(
			join(fixtureDir, 'auth', 'mws', 'index.ts'),
			`export default () => {}\nexport const beforeRequest = (_req, _res, next) => next(_req, _res)\nexport const afterRequest = (_req, _res, next) => next(_req, _res)\n`,
		)
		await writeFile(
			join(fixtureDir, 'share', '__module__.ts'),
			`export default { name: 'share', version: '1.0.0', type: 'share' }\n`,
		)
		await writeFile(
			join(fixtureDir, 'operators', '__module__.ts'),
			`export default { name: 'operators', version: '1.0.0', type: 'full' }\n`,
		)
		await writeFile(
			join(fixtureDir, 'operators', 'controllers', 'list.ts'),
			`export default { name: 'operators.list', version: '1.0.0', method: 'GET', path: '/operators/list', handler: async (_req, res) => res.json({ ok: true }) }\n`,
		)
		await writeFile(
			join(fixtureDir, 'operators', 'websockets', 'stream.ts'),
			`export default { name: 'operators.stream', version: '1.0.0', path: '/ws/operators/:operatorId', upgrade: ({ params }) => ({ data: { operatorId: params.operatorId } }), message: (ws, message) => ws.send(message) }\n`,
		)
	})

	afterEach(async () => {
		if (fixtureDir) {
			await rm(fixtureDir, { recursive: true, force: true })
		}
	})

	test('tracks loaded modules after load()', async () => {
		const modules = new Modules(fixtureDir)
		await modules.load()

		const stats = getModulesStats()

		expect(stats.totalModulesLoaded).toBe(3)
		expect(stats.totalModulesMws).toBe(1)
		expect(stats.totalModulesShare).toBe(1)
		expect(stats.totalModulesFull).toBe(1)
		expect([...stats.modulesNames].sort()).toEqual(['auth', 'operators', 'share'])
		expect(stats.modules.map(module => module.name).sort()).toEqual([
			'auth',
			'operators',
			'share',
		])
	})

	test('runs module initialize hooks after each module is loaded', async () => {
		const initializeEventsKey = '__s42CoreInitializeEvents'
		;(globalThis as Record<string, unknown>)[initializeEventsKey] = []

		await writeFile(
			join(fixtureDir, 'auth', '__module__.ts'),
			`export default { name: 'auth', version: '1.0.0', type: 'mws', initialize: () => globalThis.${initializeEventsKey}.push('auth') }\n`,
		)
		await writeFile(
			join(fixtureDir, 'share', '__module__.ts'),
			`export default { name: 'share', version: '1.0.0', type: 'share', initialize: async () => { await Bun.sleep(1); globalThis.${initializeEventsKey}.push('share') } }\n`,
		)
		await writeFile(
			join(fixtureDir, 'operators', '__module__.ts'),
			`export default { name: 'operators', version: '1.0.0', type: 'full', initialize: () => globalThis.${initializeEventsKey}.push('operators') }\n`,
		)

		const modules = new Modules(fixtureDir)
		await modules.load()

		expect((globalThis as Record<string, unknown>)[initializeEventsKey]).toEqual([
			'auth',
			'share',
			'operators',
		])

		delete (globalThis as Record<string, unknown>)[initializeEventsKey]
	})

	test('discovers enabled WebSocket controllers from full modules', async () => {
		await writeFile(
			join(fixtureDir, 'operators', 'websockets', 'disabled.ts'),
			`export default { enabled: false }\n`,
		)

		const modules = new Modules(fixtureDir)
		await modules.load()

		expect(modules.getWebSocketControllers()).toHaveLength(1)
		expect(modules.getWebSocketControllers()[0]?.getPath()).toBe(
			'/ws/operators/:operatorId',
		)
	})

	test('accepts full modules without a websockets directory', async () => {
		await rm(join(fixtureDir, 'operators', 'websockets'), {
			recursive: true,
			force: true,
		})

		const modules = new Modules(fixtureDir)
		await modules.load()

		expect(modules.getWebSocketControllers()).toEqual([])
	})

	test('fails load with the file and reason for an invalid definition', async () => {
		const invalidPath = join(fixtureDir, 'operators', 'websockets', 'invalid.ts')
		await writeFile(
			invalidPath,
			`export default { name: 'operators.invalid', version: '1.0.0', path: '/ws/invalid', upgrade: 'not-a-function' }\n`,
		)

		const modules = new Modules(fixtureDir)
		const loading = modules.load()

		await expect(loading).rejects.toThrow(invalidPath)
		await expect(loading).rejects.toThrow('upgrade must be a function when provided')
	})

	test('ignores websockets in share modules and emits a warning', async () => {
		await mkdir(join(fixtureDir, 'share', 'websockets'), { recursive: true })
		await writeFile(
			join(fixtureDir, 'share', 'websockets', 'ignored.ts'),
			`export default { name: 'share.ignored', version: '1.0.0', path: '/ws/share', upgrade: () => ({ data: {} }) }\n`,
		)

		const warnings: unknown[][] = []
		setLogSink({
			debug: () => {},
			info: () => {},
			warn: (...args) => warnings.push(args),
			error: () => {},
		})

		try {
			const modules = new Modules(fixtureDir)
			await modules.load()

			expect(modules.getWebSocketControllers()).toHaveLength(1)
			expect(
				warnings.some(args => String(args[0]).includes('ignores "websockets"')),
			).toBe(true)
		} finally {
			setLogSink(defaultLogSink)
		}
	})
})
