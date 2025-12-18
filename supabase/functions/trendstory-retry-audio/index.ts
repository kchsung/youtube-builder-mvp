// @ts-nocheck
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'

const corsHeaders: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
}

function handleOptions(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null
  return new Response('ok', { headers: corsHeaders })
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8' },
  })
}

function requireEnv(name: string) {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`Missing required env: ${name}`)
  return v
}

function getSupabaseServiceClient() {
  const url = requireEnv('SUPABASE_URL')
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  return createClient(url, serviceRoleKey)
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

function nowIso() {
  return new Date().toISOString()
}

function ensureRuntime(packager: any) {
  if (!packager) return null
  if (!packager._runtime) packager._runtime = {}
  if (!packager._runtime.logs) packager._runtime.logs = []
  return packager._runtime
}

function pushRuntimeLog(packager: any, level: 'info' | 'warn' | 'error', msg: string, data?: unknown) {
  const rt = ensureRuntime(packager)
  if (rt) rt.logs.push({ ts: nowIso(), level, msg, data })
  const payload = data ? { msg, ...data } : { msg }
  if (level === 'error') console.error('[ytg]', payload)
  else if (level === 'warn') console.warn('[ytg]', payload)
  else console.log('[ytg]', payload)
}

async function openaiTtsMp3(input: string): Promise<Uint8Array> {
  const apiKey = requireEnv('OPENAI_API_KEY')
  const model = Deno.env.get('OPENAI_TTS_MODEL')?.trim() || 'gpt-4o-mini-tts'
  const voice = Deno.env.get('OPENAI_TTS_VOICE')?.trim() || 'alloy'
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, voice, format: 'mp3', input }),
  })
  if (!res.ok) throw new Error(`OpenAI TTS error (${res.status}): ${await res.text()}`)
  const ab = await res.arrayBuffer()
  return new Uint8Array(ab)
}

type RetryAudioRequest = {
  job_id: string
  force?: boolean
}

type RetryAudioResponse = {
  job_id: string
  accepted: boolean
  message: string
}

async function runRetryAudio(jobId: string) {
  const supabase = getSupabaseServiceClient()
  const bucket = Deno.env.get('YTG_BUCKET') ?? 'ytg-assets'

  const jobRes = await supabase.from('ytg_jobs').select('id, packager, final_package').eq('id', jobId).single()
  if (jobRes.error) throw new Error(jobRes.error.message)

  const scenesRes = await supabase
    .from('ytg_scenes')
    .select('scene_id, narration')
    .eq('job_id', jobId)
    .order('scene_id', { ascending: true })
  if (scenesRes.error) throw new Error(scenesRes.error.message)

  const packager = jobRes.data.packager ?? null
  const fp = jobRes.data.final_package ?? null

  const fullScript = String((packager as any)?.tts?.full_script ?? '').trim()
  const fromScenes = (scenesRes.data ?? [])
    .map((s: any) => String(s?.narration ?? '').trim())
    .filter(Boolean)
    .map((t: string, i: number) => `${i + 1}. ${t}`)
    .join('\n')

  const narrationText = fullScript || fromScenes
  if (!narrationText.trim()) {
    pushRuntimeLog(packager, 'error', '오디오 재생성 실패: TTS 스크립트가 비어있습니다.')
    await supabase.from('ytg_jobs').update({ packager }).eq('id', jobId)
    throw new Error('TTS script is empty')
  }

  pushRuntimeLog(packager, 'info', '오디오 재생성 시작', { chars: narrationText.length })
  const mp3 = await openaiTtsMp3(narrationText)
  const audioPath = `jobs/${jobId}/narration.mp3`
  const up = await supabase.storage.from(bucket).upload(audioPath, new Blob([toArrayBuffer(mp3)], { type: 'audio/mpeg' }), {
    contentType: 'audio/mpeg',
    upsert: true,
  })
  if (up.error) throw new Error(up.error.message)

  const audioUrl = supabase.storage.from(bucket).getPublicUrl(audioPath).data.publicUrl
  pushRuntimeLog(packager, 'info', '오디오 재생성 완료', { audio_url: audioUrl })

  const insAsset = await supabase.from('ytg_assets').insert({
    job_id: jobId,
    type: 'audio',
    path: audioPath,
    url: audioUrl,
    meta: { provider: 'openai', model: Deno.env.get('OPENAI_TTS_MODEL')?.trim() || 'gpt-4o-mini-tts', voice: Deno.env.get('OPENAI_TTS_VOICE')?.trim() || 'alloy', retried_at: nowIso() },
  })
  if (insAsset.error) {
    pushRuntimeLog(packager, 'warn', 'ytg_assets 오디오 기록 실패(무시)', { error: insAsset.error.message })
  }

  // best-effort: patch final_package if present
  if (fp && typeof fp === 'object') {
    const next = { ...(fp as any) }
    next.audio = next.audio ?? {}
    next.audio.audio_url = audioUrl
    next.audio.tts = { provider: 'openai', model: Deno.env.get('OPENAI_TTS_MODEL')?.trim() || 'gpt-4o-mini-tts', voice: Deno.env.get('OPENAI_TTS_VOICE')?.trim() || 'alloy' }
    await supabase.from('ytg_jobs').update({ final_package: next, packager }).eq('id', jobId)
  } else {
    await supabase.from('ytg_jobs').update({ packager }).eq('id', jobId)
  }
}

Deno.serve(async (req) => {
  const opt = handleOptions(req)
  if (opt) return opt

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let payload: RetryAudioRequest
  try {
    payload = (await req.json()) as RetryAudioRequest
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const jobId = String(payload?.job_id ?? '').trim()
  if (!jobId) return json({ error: 'job_id is required' }, 400)

  // 즉시 응답 후 백그라운드 실행 (CORS/timeout 방지)
  const waitUntil = (globalThis as any).EdgeRuntime?.waitUntil
  if (typeof waitUntil === 'function') {
    waitUntil(runRetryAudio(jobId))
  } else {
    runRetryAudio(jobId)
  }

  const out: RetryAudioResponse = {
    job_id: jobId,
    accepted: true,
    message: '오디오 재생성을 백그라운드로 시작했습니다. 잠시 후 새로고침하면 오디오가 표시됩니다.',
  }
  return json(out, 202)
})


