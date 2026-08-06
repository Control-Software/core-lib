import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	clearStaticRoutesStats,
	getStaticModulePathError,
	getStaticRoutesStats,
	StaticRoutesRegistry,
} from './index'

describe('StaticRoutesRegistry', () => {
	let fixtureDir = ''

	beforeEach(async () => {
		clearStaticRoutesStats()
		fixtureDir = await mkdtemp(join(tmpdir(), 's42-core-static-routes-'))
	})

	afterEach(async () => {
		clearStaticRoutesStats()
		if (fixtureDir) {
			await rm(fixtureDir, { recursive: true, force: true })
		}
	})

	test('validates canonical module paths', () => {
		for (const path of ['/', '/admin', '/café assets', '/literal%value', '/foo:bar']) {
			expect(getStaticModulePathError(path)).toBeNull()
		}

		for (const path of [
			'',
			'admin',
			'/admin/',
			'/admin//assets',
			'/admin?debug=true',
			'/admin#hash',
			'/admin\\assets',
			'/admin\0assets',
			'/admin/*',
			'/admin/:file',
			'/admin/../private',
			' /admin',
		]) {
			expect(getStaticModulePathError(path)).not.toBeNull()
		}
	})

	test('builds exact file, index, redirect and encoded routes', async () => {
		const publicDirectory = join(fixtureDir, 'public')
		await mkdir(join(publicDirectory, 'assets'), { recursive: true })
		await mkdir(join(publicDirectory, 'docs'), { recursive: true })
		await mkdir(join(publicDirectory, '.well-known'), { recursive: true })
		await writeFile(join(publicDirectory, 'index.html'), '<h1>Home</h1>')
		await writeFile(join(publicDirectory, 'assets', 'app.css'), 'body{}')
		await writeFile(join(publicDirectory, 'docs', 'index.html'), '<h1>Docs</h1>')
		await writeFile(join(publicDirectory, '.well-known', 'security.txt'), 'contact')
		await writeFile(join(publicDirectory, 'space #%.txt'), 'reserved')
		await writeFile(join(publicDirectory, 'café.txt'), 'unicode')

		const routes = new StaticRoutesRegistry()
		await routes.addModule({
			name: 'admin-ui',
			version: '1.0.0',
			path: '/admin',
			publicDirectory,
		})

		const routeMap = routes.getRoutes()
		expect(Object.keys(routeMap).sort()).toEqual(
			[
				'/admin',
				'/admin/',
				'/admin/.well-known/security.txt',
				'/admin/assets/app.css',
				'/admin/caf%C3%A9.txt',
				'/admin/docs',
				'/admin/docs/',
				'/admin/docs/index.html',
				'/admin/index.html',
				'/admin/space%20%23%25.txt',
			].sort(),
		)

		const css = await routeMap['/admin/assets/app.css'].GET(
			new Request('http://localhost/admin/assets/app.css'),
		)
		expect(css.status).toBe(200)
		expect(css.headers.get('content-type')).toBe('text/css;charset=utf-8')
		expect(css.headers.get('last-modified')).not.toBeNull()
		expect(await css.text()).toBe('body{}')

		const conditional = await routeMap['/admin/assets/app.css'].GET(
			new Request('http://localhost/admin/assets/app.css', {
				headers: { 'If-Modified-Since': css.headers.get('last-modified') ?? '' },
			}),
		)
		expect(conditional.status).toBe(304)
		expect(await conditional.text()).toBe('')

		const redirect = await routeMap['/admin'].GET(
			new Request('http://localhost/admin?theme=dark'),
		)
		expect(redirect.status).toBe(308)
		expect(redirect.headers.get('location')).toBe('/admin/?theme=dark')

		expect(routes.getRouteMetadata('/admin/docs/')?.kind).toBe('index')
		expect(routes.getRouteMetadata('/admin/docs/')?.relativePath).toBe('docs/index.html')
		expect(routes.getStats()).toEqual({
			totalModules: 1,
			totalFiles: 6,
			totalRoutes: 10,
			paths: ['/admin'],
		})
		expect(getStaticRoutesStats()).toEqual(routes.getStats())
	})

	test('reads changed files and returns 404 for removed or replaced files', async () => {
		const publicDirectory = join(fixtureDir, 'public')
		const assetPath = join(publicDirectory, 'asset.txt')
		const outsidePath = join(fixtureDir, 'outside.txt')
		await mkdir(publicDirectory)
		await writeFile(assetPath, 'first')
		await writeFile(outsidePath, 'private')

		const routes = new StaticRoutesRegistry()
		await routes.addModule({
			name: 'assets',
			version: '1.0.0',
			path: '/assets',
			publicDirectory,
		})
		const handler = routes.getRoutes()['/assets/asset.txt'].GET

		await writeFile(assetPath, 'second')
		expect(
			await (await handler(new Request('http://localhost/assets/asset.txt'))).text(),
		).toBe('second')

		await rm(assetPath)
		expect((await handler(new Request('http://localhost/assets/asset.txt'))).status).toBe(
			404,
		)

		await symlink(outsidePath, assetPath)
		expect((await handler(new Request('http://localhost/assets/asset.txt'))).status).toBe(
			404,
		)
	})

	test('rejects missing public directories and symbolic links', async () => {
		const missingRoutes = new StaticRoutesRegistry()
		await expect(
			missingRoutes.addModule({
				name: 'missing',
				version: '1.0.0',
				path: '/missing',
				publicDirectory: join(fixtureDir, 'missing'),
			}),
		).rejects.toThrow('missing public directory')

		const targetDirectory = join(fixtureDir, 'target')
		const linkedDirectory = join(fixtureDir, 'linked-public')
		await mkdir(targetDirectory)
		await symlink(targetDirectory, linkedDirectory)

		const linkedRoutes = new StaticRoutesRegistry()
		await expect(
			linkedRoutes.addModule({
				name: 'linked',
				version: '1.0.0',
				path: '/linked',
				publicDirectory: linkedDirectory,
			}),
		).rejects.toThrow('cannot use a symbolic link as its public directory')

		const publicDirectory = join(fixtureDir, 'public')
		const outsideFile = join(fixtureDir, 'outside.txt')
		await mkdir(publicDirectory)
		await writeFile(outsideFile, 'private')
		await symlink(outsideFile, join(publicDirectory, 'linked.txt'))

		const fileLinkRoutes = new StaticRoutesRegistry()
		await expect(
			fileLinkRoutes.addModule({
				name: 'file-link',
				version: '1.0.0',
				path: '/file-link',
				publicDirectory,
			}),
		).rejects.toThrow('cannot serve symbolic link public/linked.txt')
	})

	test('rejects duplicate module paths and generated route collisions', async () => {
		const rootPublic = join(fixtureDir, 'root-public')
		const adminPublic = join(fixtureDir, 'admin-public')
		const duplicatePublic = join(fixtureDir, 'duplicate-public')
		await mkdir(join(rootPublic, 'admin'), { recursive: true })
		await mkdir(adminPublic)
		await mkdir(duplicatePublic)
		await writeFile(join(rootPublic, 'admin', 'index.html'), 'root owner')
		await writeFile(join(adminPublic, 'index.html'), 'admin owner')
		await writeFile(join(duplicatePublic, 'asset.txt'), 'duplicate')

		const routes = new StaticRoutesRegistry()
		await routes.addModule({
			name: 'root',
			version: '1.0.0',
			path: '/',
			publicDirectory: rootPublic,
		})

		await expect(
			routes.addModule({
				name: 'admin',
				version: '1.0.0',
				path: '/admin',
				publicDirectory: adminPublic,
			}),
		).rejects.toThrow('Static route collision for "/admin/index.html"')

		await expect(
			routes.addModule({
				name: 'duplicate-root',
				version: '1.0.0',
				path: '/',
				publicDirectory: duplicatePublic,
			}),
		).rejects.toThrow('use the same path "/"')
	})
})
