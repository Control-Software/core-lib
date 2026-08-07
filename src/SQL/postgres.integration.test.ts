import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL, isSQLError } from './index'

const postgresUrl = process.env.S42_POSTGRES_TEST_URL ?? ''

describe.skipIf(postgresUrl.length === 0)(
	'SQL (postgres) — conflict-aware insert',
	() => {
		let db: SQL | undefined
		const tableName = `s42_conflict_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`

		beforeAll(async () => {
			db = new SQL({ type: 'postgres', url: postgresUrl, max: 4 })
			await db.connect()
			await db.createTable(tableName, {
				id: 'TEXT PRIMARY KEY',
				source: 'TEXT NOT NULL',
				delivery_key: 'TEXT',
				external_key: 'TEXT',
				receipt_token: 'TEXT NOT NULL',
				status: 'TEXT NOT NULL',
			})
			await db.createIndex(tableName, 'delivery_key', {
				name: `${tableName}_delivery_key`,
				unique: true,
			})
			await db.createIndex(tableName, ['source', 'external_key'], {
				name: `${tableName}_source_external_key`,
				unique: true,
			})
			await db.createIndex(tableName, 'receipt_token', {
				name: `${tableName}_receipt_token`,
				unique: true,
			})
		})

		afterAll(async () => {
			if (!db) {
				return
			}

			try {
				await db.executeRaw(`DROP TABLE IF EXISTS ${tableName}`)
			} finally {
				await db.close()
			}
		})

		test('returns one simple-target winner and preserves returning rows', async () => {
			if (!db) {
				throw new Error('PostgreSQL test database was not initialized')
			}

			const winner = await db.insert<{ id: string }>(
				tableName,
				{
					id: 'simple-1',
					source: 'checkout',
					delivery_key: 'delivery-1',
					external_key: 'external-1',
					receipt_token: 'receipt-1',
					status: 'processing',
				},
				{
					onConflict: { columns: ['delivery_key'], action: 'nothing' },
					returning: ['id'],
				},
			)
			const loser = await db.insert<{ id: string }>(
				tableName,
				{
					id: 'simple-2',
					source: 'checkout',
					delivery_key: 'delivery-1',
					external_key: 'external-2',
					receipt_token: 'receipt-2',
					status: 'processing',
				},
				{
					onConflict: { columns: ['delivery_key'], action: 'nothing' },
					returning: ['id'],
				},
			)

			expect(winner).toMatchObject({
				inserted: true,
				affectedRows: 1,
				rows: [{ id: 'simple-1' }],
			})
			expect(loser).toMatchObject({ inserted: false, affectedRows: 0, rows: [] })
		})

		test('produces exactly one compound-target winner under concurrent calls', async () => {
			if (!db) {
				throw new Error('PostgreSQL test database was not initialized')
			}

			const results = await Promise.all([
				db.insert(
					tableName,
					{
						id: 'compound-1',
						source: 'payments',
						delivery_key: 'delivery-2',
						external_key: 'shared-external',
						receipt_token: 'receipt-3',
						status: 'processing',
					},
					{
						onConflict: {
							columns: ['source', 'external_key'],
							action: 'nothing',
						},
					},
				),
				db.insert(
					tableName,
					{
						id: 'compound-2',
						source: 'payments',
						delivery_key: 'delivery-3',
						external_key: 'shared-external',
						receipt_token: 'receipt-4',
						status: 'processing',
					},
					{
						onConflict: {
							columns: ['source', 'external_key'],
							action: 'nothing',
						},
					},
				),
			])

			expect(results.filter(result => result?.inserted)).toHaveLength(1)
			expect(results.filter(result => !result?.inserted)).toHaveLength(1)
		})

		test('does not suppress unrelated constraints or change legacy inserts', async () => {
			if (!db) {
				throw new Error('PostgreSQL test database was not initialized')
			}

			const legacy = await db.insert(tableName, {
				id: 'legacy-1',
				source: 'ledger',
				delivery_key: 'delivery-4',
				external_key: 'external-4',
				receipt_token: 'shared-receipt',
				status: 'processing',
			})
			expect(legacy && 'inserted' in legacy).toBe(false)

			let unrelatedError: unknown
			try {
				await db.insert(
					tableName,
					{
						id: 'unrelated-1',
						source: 'ledger',
						delivery_key: 'delivery-5',
						external_key: 'external-5',
						receipt_token: 'shared-receipt',
						status: 'processing',
					},
					{ onConflict: { columns: ['delivery_key'], action: 'nothing' } },
				)
			} catch (error) {
				unrelatedError = error
			}
			expect(isSQLError(unrelatedError, 'unique_violation')).toBe(true)

			let legacyConflict: unknown
			try {
				await db.insert(tableName, {
					id: 'legacy-2',
					source: 'ledger',
					delivery_key: 'delivery-4',
					external_key: 'external-6',
					receipt_token: 'receipt-5',
					status: 'processing',
				})
			} catch (error) {
				legacyConflict = error
			}
			expect(isSQLError(legacyConflict, 'unique_violation')).toBe(true)
		})
	},
)
