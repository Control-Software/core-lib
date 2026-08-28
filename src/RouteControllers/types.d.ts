import { type Res } from '../Response'

export type TypeReturnCallback = (req: Request) => Promise<Response>

export type RouteCheckResult = {
	exists: boolean
	params: { [key: string]: string }
	key: string
}

export type TypeRoutesMapCache = {
	[key: string]: (
		req: any,
		res: Res,
	) => void | Promise<void> | Response | Promise<Response>
}

export type TypeRequestInternalObject = {
	headers: Headers
	realIp: string
	url: string
	method: string
	query: Record<string, string>
	body: Record<string, any>
	/**
	 * The request body exactly as it arrived, before `JSON.parse`.
	 *
	 * Required for HMAC webhook verification: a provider signs specific bytes, and
	 * `JSON.stringify(body)` does not reproduce them (number normalisation, unicode
	 * escaping, key order, whitespace). `undefined` for GET and form-data requests.
	 */
	rawBody?: string
	/**
	 * `true` when a non-GET, non-form-data body was present but failed `JSON.parse`.
	 *
	 * Stock behaviour returns `{}` for both "no body" and "malformed body", so a
	 * handler cannot reject malformed input. `rawBody` still carries the bytes.
	 */
	bodyParseFailed?: boolean
	formData: () => any
	params?: Record<string, string>
}

export type TypeResponseInternalObject = {
	end: (body: string) => void
	json: (body: object) => void
	_404: (body: string) => void
	_500: (body: string) => void
}
