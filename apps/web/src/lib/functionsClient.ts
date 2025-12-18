import { getEnv } from './env'

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue }

export class ApiError extends Error {
  status: number
  bodyText?: string
  bodyJson?: unknown
  constructor(message: string, status: number, bodyText?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.bodyText = bodyText
  }
}

function tryParseJson(text: string): unknown | undefined {
  const t = text.trim()
  if (!t) return undefined
  try {
    return JSON.parse(t)
  } catch {
    return undefined
  }
}

function extractErrorMessage(bodyJson: unknown): string | undefined {
  if (!bodyJson || typeof bodyJson !== 'object') return undefined
  const anyBody = bodyJson as any
  const msg = anyBody?.error ?? anyBody?.message
  return typeof msg === 'string' && msg.trim() ? msg.trim() : undefined
}

export async function functionsPost<TResponse, TBody extends JsonValue>(
  path: string,
  body: TBody,
  init?: RequestInit,
): Promise<TResponse> {
  const env = getEnv()
  const url = `${env.functionsBase.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: env.supabaseAnonKey,
      authorization: `Bearer ${env.supabaseAnonKey}`,
      ...(init?.headers ?? {}),
    },
    body: JSON.stringify(body),
    signal: init?.signal,
  })

  const text = await res.text()
  if (!res.ok) {
    const bodyJson = tryParseJson(text)
    const detail = bodyJson ? extractErrorMessage(bodyJson) : undefined
    const err = new ApiError(
      detail ? `POST ${path}: ${res.status} (${detail})` : `POST ${path}: ${res.status}`,
      res.status,
      text,
    )
    err.bodyJson = bodyJson
    throw err
  }
  return JSON.parse(text) as TResponse
}

export async function functionsGet<TResponse>(pathWithQuery: string, init?: RequestInit): Promise<TResponse> {
  const env = getEnv()
  const url = `${env.functionsBase.replace(/\/$/, '')}/${pathWithQuery.replace(/^\//, '')}`
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      apikey: env.supabaseAnonKey,
      authorization: `Bearer ${env.supabaseAnonKey}`,
      ...(init?.headers ?? {}),
    },
    signal: init?.signal,
  })
  const text = await res.text()
  if (!res.ok) {
    const bodyJson = tryParseJson(text)
    const detail = bodyJson ? extractErrorMessage(bodyJson) : undefined
    const err = new ApiError(
      detail ? `GET ${pathWithQuery}: ${res.status} (${detail})` : `GET ${pathWithQuery}: ${res.status}`,
      res.status,
      text,
    )
    err.bodyJson = bodyJson
    throw err
  }
  return JSON.parse(text) as TResponse
}


