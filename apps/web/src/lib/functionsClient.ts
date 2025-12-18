import { getEnv } from './env'

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue }

export class ApiError extends Error {
  status: number
  bodyText?: string
  constructor(message: string, status: number, bodyText?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.bodyText = bodyText
  }
}

export async function functionsPost<TResponse, TBody extends JsonValue>(
  path: string,
  body: TBody,
): Promise<TResponse> {
  const env = getEnv()
  const url = `${env.functionsBase.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: env.supabaseAnonKey,
      authorization: `Bearer ${env.supabaseAnonKey}`,
    },
    body: JSON.stringify(body),
  })

  const text = await res.text()
  if (!res.ok) throw new ApiError(`요청 실패: ${res.status}`, res.status, text)
  return JSON.parse(text) as TResponse
}

export async function functionsGet<TResponse>(pathWithQuery: string): Promise<TResponse> {
  const env = getEnv()
  const url = `${env.functionsBase.replace(/\/$/, '')}/${pathWithQuery.replace(/^\//, '')}`
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      apikey: env.supabaseAnonKey,
      authorization: `Bearer ${env.supabaseAnonKey}`,
    },
  })
  const text = await res.text()
  if (!res.ok) throw new ApiError(`요청 실패: ${res.status}`, res.status, text)
  return JSON.parse(text) as TResponse
}


