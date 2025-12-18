import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'

export function getSupabaseClient(req: Request) {
  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!url) throw new Error('Missing secret: SUPABASE_URL')
  if (!anonKey) throw new Error('Missing secret: SUPABASE_ANON_KEY')

  // 클라이언트에서 온 Authorization 헤더(anon JWT)를 그대로 전달
  const authHeader = req.headers.get('authorization') ?? ''

  return createClient(url, anonKey, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  })
}


