export type AppEnv = {
  supabaseUrl: string
  supabaseAnonKey: string
  functionsBase: string
}

function getOptionalEnv(key: string): string | undefined {
  return ((import.meta as any).env?.[key] as string | undefined) || undefined
}

function requireEnv(key: string): string {
  const val = getOptionalEnv(key)
  if (!val) throw new Error(`Missing required env: ${key}`)
  return val
}

/**
 * 런타임에서 필요할 때만 환경변수를 읽습니다.
 * (import 시점에 throw 하지 않아서 화면이 "검은 화면"으로 죽는 것을 방지)
 */
export function getEnv(): AppEnv {
  const supabaseUrl = requireEnv('VITE_SUPABASE_URL')
  const supabaseAnonKey = requireEnv('VITE_SUPABASE_ANON_KEY')
  const functionsBase =
    getOptionalEnv('VITE_SUPABASE_FUNCTIONS_BASE') ?? `${supabaseUrl.replace(/\/$/, '')}/functions/v1`

  return { supabaseUrl, supabaseAnonKey, functionsBase }
}


