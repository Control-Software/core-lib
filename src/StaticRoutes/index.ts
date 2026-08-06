import { Glob } from 'bun'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '../Logger'

export type StaticRouteHandler = (request: Request) => Promise<Response>

export type StaticRouteMethods = Readonly<{
	GET: StaticRouteHandler
	HEAD: StaticRouteHandler
}>

export type StaticRoutesMap = Readonly<Record<string, StaticRouteMethods>>

export type StaticRouteKind = 'file' | 'index' | 'redirect'

export type StaticRouteMetadata = Readonly<{
	moduleName: string
	moduleVersion: string
	modulePath: string
	relativePath: string
	kind: StaticRouteKind
}>

export type StaticRoutesStats = {
	totalModules: number
	totalFiles: number
	totalRoutes: number
	paths: string[]
}

export type StaticModuleRegistration = {
	name: string
	version: string
	path: string
	publicDirectory: string
}

export interface StaticRoutes {
	getRoutes(): StaticRoutesMap
	getRouteMetadata(path: string): StaticRouteMetadata | undefined
	getStats(): StaticRoutesStats
}

type StaticRouteRecord = {
	handler: StaticRouteHandler
	metadata: StaticRouteMetadata
}

type StaticModuleStatsRecord = {
	key: string
	path: string
	totalFiles: number
	totalRoutes: number
}

const staticRoutesStatsRegistry = new Map<string, StaticModuleStatsRecord>()

export function getStaticRoutesStats(): StaticRoutesStats {
	return buildStats(Array.from(staticRoutesStatsRegistry.values()))
}

export function clearStaticRoutesStats(): void {
	staticRoutesStatsRegistry.clear()
}

export function getStaticModulePathError(path: string): string | null {
	if (!path) {
		return 'path is required.'
	}

	if (path.trim() !== path) {
		return 'path cannot have leading or trailing whitespace.'
	}

	if (!path.startsWith('/')) {
		return 'path must start with "/".'
	}

	if (path !== '/' && path.endsWith('/')) {
		return 'path cannot end with "/".'
	}

	if (path.includes('//')) {
		return 'path cannot contain empty segments.'
	}

	if (path.includes('?') || path.includes('#')) {
		return 'path cannot contain a query string or hash.'
	}

	if (path.includes('\\') || path.includes('\0')) {
		return 'path cannot contain a backslash or NUL byte.'
	}

	if (path.includes('*')) {
		return 'path cannot contain wildcards.'
	}

	for (const segment of path.split('/').slice(1)) {
		if (segment === '.' || segment === '..') {
			return 'path cannot contain "." or ".." segments.'
		}

		if (segment.startsWith(':')) {
			return 'path cannot contain route parameters.'
		}
	}

	return null
}

export class StaticRoutesRegistry implements StaticRoutes {
	private readonly routeRecords = new Map<string, StaticRouteRecord>()
	private readonly modulePaths = new Map<string, string>()
	private readonly moduleStats = new Map<string, StaticModuleStatsRecord>()

	public async addModule(registration: StaticModuleRegistration): Promise<void> {
		const pathError = getStaticModulePathError(registration.path)
		if (pathError) {
			throw new TypeError(
				`Invalid static module ${registration.name}@${registration.version}: ${pathError}`,
			)
		}

		const existingModule = this.modulePaths.get(registration.path)
		if (existingModule) {
			throw new TypeError(
				`Static modules ${existingModule} and ${formatModule(registration)} use the same path "${registration.path}".`,
			)
		}

		await this.assertPublicDirectory(registration)
		const files = await this.scanPublicDirectory(registration)
		const pendingRoutes = this.buildModuleRoutes(registration, files)

		for (const [pathname, record] of pendingRoutes) {
			const existing = this.routeRecords.get(pathname)
			if (existing) {
				throw new TypeError(
					`Static route collision for "${pathname}" between ${formatMetadata(existing.metadata)} and ${formatMetadata(record.metadata)}.`,
				)
			}
		}

		for (const [pathname, record] of pendingRoutes) {
			this.routeRecords.set(pathname, record)
		}

		const moduleLabel = formatModule(registration)
		const statsRecord = {
			key: `${moduleLabel}:${registration.path}`,
			path: registration.path,
			totalFiles: files.length,
			totalRoutes: pendingRoutes.size,
		}

		this.modulePaths.set(registration.path, moduleLabel)
		this.moduleStats.set(statsRecord.key, statsRecord)
		staticRoutesStatsRegistry.set(statsRecord.key, statsRecord)

		if (files.length === 0) {
			logger.warn(
				`⭕️ Static module ${moduleLabel} has an empty public directory at path "${registration.path}".`,
			)
		} else {
			logger.info(
				`📁 Static module ${moduleLabel} mounted ${files.length} files at "${registration.path}".`,
			)
		}
	}

	public getRoutes(): StaticRoutesMap {
		const routes: Record<string, StaticRouteMethods> = {}

		for (const pathname of Array.from(this.routeRecords.keys()).sort(compareText)) {
			const record = this.routeRecords.get(pathname)
			if (!record) {
				continue
			}

			routes[pathname] = Object.freeze({
				GET: record.handler,
				HEAD: record.handler,
			})
		}

		return Object.freeze(routes)
	}

	public getRouteMetadata(path: string): StaticRouteMetadata | undefined {
		const metadata = this.routeRecords.get(path)?.metadata
		return metadata ? { ...metadata } : undefined
	}

	public getStats(): StaticRoutesStats {
		return buildStats(Array.from(this.moduleStats.values()))
	}

	private async assertPublicDirectory(
		registration: StaticModuleRegistration,
	): Promise<void> {
		let stats
		try {
			stats = await lstat(registration.publicDirectory)
		} catch (error) {
			if (isFilesystemError(error, ['ENOENT', 'ENOTDIR'])) {
				throw new Error(
					`Module ${formatModule(registration)} is type "static" but missing public directory (${registration.publicDirectory}).`,
					{ cause: error },
				)
			}
			throw error
		}

		if (stats.isSymbolicLink()) {
			throw new Error(
				`Module ${formatModule(registration)} cannot use a symbolic link as its public directory (${registration.publicDirectory}).`,
			)
		}

		if (!stats.isDirectory()) {
			throw new Error(
				`Module ${formatModule(registration)} requires public to be a directory (${registration.publicDirectory}).`,
			)
		}
	}

	private async scanPublicDirectory(
		registration: StaticModuleRegistration,
	): Promise<string[]> {
		const files: string[] = []
		const glob = new Glob('**/*')

		for await (const relativePath of glob.scan({
			cwd: registration.publicDirectory,
			dot: true,
			followSymlinks: false,
			onlyFiles: false,
			throwErrorOnBrokenSymlink: true,
		})) {
			const filePath = join(registration.publicDirectory, relativePath)
			const stats = await lstat(filePath)

			if (stats.isSymbolicLink()) {
				throw new Error(
					`Static module ${formatModule(registration)} cannot serve symbolic link public/${toPublicPath(relativePath)}.`,
				)
			}

			if (stats.isDirectory()) {
				continue
			}

			if (!stats.isFile()) {
				throw new Error(
					`Static module ${formatModule(registration)} can only serve regular files; public/${toPublicPath(relativePath)} is unsupported.`,
				)
			}

			files.push(toPublicPath(relativePath))
		}

		return files.sort(compareText)
	}

	private buildModuleRoutes(
		registration: StaticModuleRegistration,
		files: string[],
	): Map<string, StaticRouteRecord> {
		const routes = new Map<string, StaticRouteRecord>()
		const encodedModulePath = encodeModulePath(registration.path)

		for (const relativePath of files) {
			const encodedRelativePath = relativePath.split('/').map(encodePathSegment).join('/')
			const filePathname = joinURLPath(encodedModulePath, encodedRelativePath)
			const filePath = join(registration.publicDirectory, relativePath)
			const fileHandler = this.createFileHandler(filePath, filePathname)

			this.addPendingRoute(routes, filePathname, fileHandler, {
				moduleName: registration.name,
				moduleVersion: registration.version,
				modulePath: registration.path,
				relativePath,
				kind: 'file',
			})

			const segments = relativePath.split('/')
			if (segments.at(-1) !== 'index.html') {
				continue
			}

			const directorySegments = segments.slice(0, -1).map(encodePathSegment)
			const directoryPathname = getDirectoryPathname(encodedModulePath, directorySegments)
			this.addPendingRoute(routes, directoryPathname, fileHandler, {
				moduleName: registration.name,
				moduleVersion: registration.version,
				modulePath: registration.path,
				relativePath,
				kind: 'index',
			})

			if (directoryPathname !== '/') {
				const redirectPathname = directoryPathname.slice(0, -1)
				this.addPendingRoute(
					routes,
					redirectPathname,
					this.createRedirectHandler(directoryPathname),
					{
						moduleName: registration.name,
						moduleVersion: registration.version,
						modulePath: registration.path,
						relativePath,
						kind: 'redirect',
					},
				)
			}
		}

		return routes
	}

	private addPendingRoute(
		routes: Map<string, StaticRouteRecord>,
		pathname: string,
		handler: StaticRouteHandler,
		metadata: StaticRouteMetadata,
	): void {
		const existing = routes.get(pathname)
		if (existing) {
			throw new TypeError(
				`Static route collision for "${pathname}" between ${formatMetadata(existing.metadata)} and ${formatMetadata(metadata)}.`,
			)
		}

		routes.set(pathname, { handler, metadata })
	}

	private createFileHandler(filePath: string, pathname: string): StaticRouteHandler {
		return async request => {
			try {
				const stats = await lstat(filePath)
				if (!stats.isFile() || stats.isSymbolicLink()) {
					return notFoundResponse()
				}

				const lastModified = stats.mtime.toUTCString()
				if (isNotModified(request, stats.mtimeMs)) {
					return new Response(null, {
						status: 304,
						headers: { 'Last-Modified': lastModified },
					})
				}

				const file = Bun.file(filePath)
				return new Response(file, {
					headers: {
						'Content-Type': file.type || 'application/octet-stream',
						'Last-Modified': lastModified,
					},
				})
			} catch (error) {
				if (isFilesystemError(error, ['ENOENT', 'ENOTDIR', 'EACCES'])) {
					return notFoundResponse()
				}

				logger.error(`Static route "${pathname}" failed.`, error)
				return new Response('Internal Server Error', {
					status: 500,
					headers: { 'Content-Type': 'text/plain;charset=utf-8' },
				})
			}
		}
	}

	private createRedirectHandler(locationPathname: string): StaticRouteHandler {
		return async request => {
			const url = new URL(request.url)
			return new Response(null, {
				status: 308,
				headers: { Location: `${locationPathname}${url.search}` },
			})
		}
	}
}

function buildStats(records: StaticModuleStatsRecord[]): StaticRoutesStats {
	const sortedRecords = [...records].sort((left, right) =>
		compareText(left.key, right.key),
	)

	return {
		totalModules: sortedRecords.length,
		totalFiles: sortedRecords.reduce((total, record) => total + record.totalFiles, 0),
		totalRoutes: sortedRecords.reduce((total, record) => total + record.totalRoutes, 0),
		paths: sortedRecords.map(record => record.path),
	}
}

function encodeModulePath(path: string): string {
	if (path === '/') {
		return '/'
	}

	return `/${path.split('/').slice(1).map(encodePathSegment).join('/')}`
}

function encodePathSegment(segment: string): string {
	return encodeURIComponent(segment).replace(/[!'()*]/g, character => {
		return `%${character.charCodeAt(0).toString(16).toUpperCase()}`
	})
}

function joinURLPath(modulePath: string, relativePath: string): string {
	return modulePath === '/' ? `/${relativePath}` : `${modulePath}/${relativePath}`
}

function getDirectoryPathname(modulePath: string, segments: string[]): string {
	if (segments.length === 0) {
		return modulePath === '/' ? '/' : `${modulePath}/`
	}

	return `${joinURLPath(modulePath, segments.join('/'))}/`
}

function toPublicPath(path: string): string {
	return path.replaceAll('\\', '/')
}

function isNotModified(request: Request, modifiedAt: number): boolean {
	const header = request.headers.get('if-modified-since')
	if (!header) {
		return false
	}

	const since = Date.parse(header)
	if (!Number.isFinite(since)) {
		return false
	}

	return Math.floor(modifiedAt / 1000) <= Math.floor(since / 1000)
}

function notFoundResponse(): Response {
	return new Response('Not Found', {
		status: 404,
		headers: { 'Content-Type': 'text/plain;charset=utf-8' },
	})
}

function isFilesystemError(error: unknown, codes: string[]): boolean {
	return Boolean(
		error &&
		typeof error === 'object' &&
		'code' in error &&
		typeof error.code === 'string' &&
		codes.includes(error.code),
	)
}

function formatModule(
	module: Pick<StaticModuleRegistration, 'name' | 'version'>,
): string {
	return `${module.name}@${module.version}`
}

function formatMetadata(metadata: StaticRouteMetadata): string {
	return `${metadata.moduleName}@${metadata.moduleVersion} public/${metadata.relativePath} (${metadata.kind})`
}

function compareText(left: string, right: string): number {
	return (
		left < right ? -1
		: left > right ? 1
		: 0
	)
}
