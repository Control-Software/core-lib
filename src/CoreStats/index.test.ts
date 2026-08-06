import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearControllersStats, Controller, getControllersStats } from '../Controller'
import { clearModulesStats, Modules } from '../Modules'
import { RouteControllers } from '../RouteControllers'
import { clearStaticRoutesStats } from '../StaticRoutes'
import {
	clearWebSocketControllersStats,
	WebSocketController,
} from '../WebSocketController'
import { CoreStats, type CoreStatsCommand, type CoreStatsCommandResult } from './index'

const commandOutputs: Record<CoreStatsCommand, CoreStatsCommandResult> = {
	'free -m': {
		command: 'free -m',
		ok: true,
		output: `               total        used        free      shared  buff/cache   available
Mem:            2048        1024         512          10         512        1536`,
	},
	'df -h': {
		command: 'df -h',
		ok: true,
		output: `Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1       100G   40G   60G  40% /`,
	},
	uptime: {
		command: 'uptime',
		ok: true,
		output: '10:00:00 up 5 days,  2 users,  load average: 0.20, 0.15, 0.10',
	},
	who: {
		command: 'who',
		ok: true,
		output: 'admin tty1 2026-03-10 09:00\nops pts/0 2026-03-10 09:05',
	},
	'cpupower frequency-info': {
		command: 'cpupower frequency-info',
		ok: true,
		output: 'current CPU frequency: 3.20 GHz',
	},
}

describe('CoreStats', () => {
	let fixtureDir = ''

	beforeEach(async () => {
		clearControllersStats()
		clearModulesStats()
		clearWebSocketControllersStats()
		clearStaticRoutesStats()
		delete process.env.ENABLE_CORE_STATS
		fixtureDir = await mkdtemp(join(tmpdir(), 's42-core-stats-'))
	})

	afterEach(async () => {
		delete process.env.ENABLE_CORE_STATS
		clearStaticRoutesStats()
		if (fixtureDir) {
			await rm(fixtureDir, { recursive: true, force: true })
		}
	})

	test('does not inject the stats route when disabled', () => {
		const health = new Controller('GET', '/health', async (_req, res) => {
			return res.json({ ok: true })
		})

		const router = new RouteControllers([health])
		const routes = router.getRoutes([])

		expect(routes['/core/stats']).toBeUndefined()
		expect(getControllersStats().totalControllers).toBe(1)
	})

	test('injects the stats route automatically and returns stats payload', async () => {
		process.env.ENABLE_CORE_STATS = 'true'
		await mkdir(join(fixtureDir, 'website', 'public'), { recursive: true })
		await writeFile(
			join(fixtureDir, 'website', '__module__.ts'),
			`export default { name: 'website', version: '1.0.0', type: 'static', path: '/site' }\n`,
		)
		await writeFile(
			join(fixtureDir, 'website', 'public', 'index.html'),
			'<h1>Website</h1>',
		)
		const modules = new Modules(fixtureDir)
		await modules.load()

		const health = new Controller('GET', '/health', async (_req, res) => {
			return res.json({ ok: true })
		})
		const users = new Controller('GET', '/users', async (_req, res) => {
			return res.json({ ok: true })
		}).post()
		new WebSocketController({
			path: '/ws/users/:userId',
			upgrade: ({ params }) => ({ data: { userId: params.userId } }),
		})

		const router = new RouteControllers([health, users])
		const coreStats = new CoreStats({
			enabled: true,
			commandRunner: async command => commandOutputs[command],
		})

		const routes = router.getRoutes([])
		const stats = await coreStats.getStats()

		expect(typeof routes['/core/stats']?.GET).toBe('function')
		expect(getControllersStats().totalControllers).toBe(3)
		expect(stats.summary.totalControllers).toBe(3)
		expect(stats.summary.totalEndpoints).toBe(4)
		expect(stats.summary.totalModulesLoaded).toBe(1)
		expect(stats.summary.totalModulesStatic).toBe(1)
		expect(stats.summary.totalStaticFiles).toBe(1)
		expect(stats.summary.totalStaticRoutes).toBe(3)
		expect(stats.summary.totalWebSocketControllers).toBe(1)
		expect(stats.summary.activeWebSocketConnections).toBe(0)
		expect(stats.endpoints).toEqual([
			{ method: 'GET', path: '/core/stats' },
			{ method: 'GET', path: '/health' },
			{ method: 'GET', path: '/users' },
			{ method: 'POST', path: '/users' },
		])
		expect(stats.webSockets).toEqual({
			totalControllers: 1,
			activeConnections: 0,
			routes: [{ path: '/ws/users/:userId', activeConnections: 0 }],
		})
		expect(stats.staticRoutes).toEqual({
			totalModules: 1,
			totalFiles: 1,
			totalRoutes: 3,
			paths: ['/site'],
		})
		expect(stats.modules).toEqual([
			expect.objectContaining({
				name: 'website',
				type: 'static',
				path: '/site',
			}),
		])
		expect(stats.system.memory.totalMB).toBe(2048)
		expect(stats.system.memory.usedMB).toBe(1024)
		expect(stats.system.memory.availableMB).toBe(1536)
		expect(stats.system.disk.root?.available).toBe('60G')
		expect(stats.system.connectedUsers.totalUsers).toBe(2)
		expect(stats.system.cpuFrequency.raw).toContain('3.20 GHz')
	})

	test('keeps an existing stats controller instead of injecting a duplicate', () => {
		process.env.ENABLE_CORE_STATS = 'true'

		const customStats = new Controller('GET', '/core/stats', async (_req, res) => {
			return res.json({ from: 'custom' })
		})

		const router = new RouteControllers([customStats])
		const routes = router.getRoutes([])

		expect(typeof routes['/core/stats']?.GET).toBe('function')
		expect(getControllersStats().totalControllers).toBe(1)
		expect(getControllersStats().totalEndpoints).toBe(1)
	})
})
