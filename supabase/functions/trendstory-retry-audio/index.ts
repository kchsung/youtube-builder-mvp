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

  const ttsModel = Deno.env.get('OPENAI_TTS_MODEL')?.trim() || 'gpt-4o-mini-tts'
  const ttsVoice = Deno.env.get('OPENAI_TTS_VOICE')?.trim() || 'alloy'

  const sceneRows = (scenesRes.data ?? [])
    .map((s: any) => ({ scene_id: Number(s?.scene_id), narration: String(s?.narration ?? '').trim() }))
    .filter((s: any) => Number.isFinite(s.scene_id) && s.narration)
    .sort((a: any, b: any) => a.scene_id - b.scene_id)

  const sceneAudioUrls: Array<{ scene_id: number; audio_url: string }> = []

  if (sceneRows.length === 0) {
    pushRuntimeLog(packager, 'error', '오디오 재생성 실패: narration이 있는 scene이 없습니다.')
  } else {
    for (const s of sceneRows) {
      try {
        pushRuntimeLog(packager, 'info', '오디오(씬) 재생성 시작', { scene_id: s.scene_id, chars: s.narration.length })
        const mp3 = await openaiTtsMp3(s.narration)
        const audioPath = `jobs/${jobId}/tts/scene-${String(s.scene_id).padStart(2, '0')}.mp3`
        const up = await supabase.storage.from(bucket).upload(audioPath, new Blob([toArrayBuffer(mp3)], { type: 'audio/mpeg' }), {
          contentType: 'audio/mpeg',
          upsert: true,
        })
        if (up.error) throw new Error(up.error.message)
        const url = supabase.storage.from(bucket).getPublicUrl(audioPath).data.publicUrl
        sceneAudioUrls.push({ scene_id: s.scene_id, audio_url: url })
        pushRuntimeLog(packager, 'info', '오디오(씬) 재생성 완료', { scene_id: s.scene_id, audio_url: url })

        const insAsset = await supabase.from('ytg_assets').insert({
          job_id: jobId,
          type: 'audio',
          path: audioPath,
          url,
          meta: { kind: 'scene', scene_id: s.scene_id, provider: 'openai', model: ttsModel, voice: ttsVoice, retried_at: nowIso() },
        })
        if (insAsset.error) pushRuntimeLog(packager, 'warn', 'ytg_assets 씬 오디오 기록 실패(무시)', { error: insAsset.error.message })
      } catch (e: any) {
        pushRuntimeLog(packager, 'error', '오디오(씬) 재생성 실패', { scene_id: s.scene_id, error: e?.message ?? String(e) })
      }
      await supabase.from('ytg_jobs').update({ packager }).eq('id', jobId)
    }
  }

  // NOTE: full 트랙(전체 TTS)은 생성하지 않습니다(자원 낭비 방지). 씬별만 생성합니다.
  const fullAudioUrl: string | null = null

  // best-effort: patch final_package if present
  if (fp && typeof fp === 'object') {
    const next = { ...(fp as any) }
    next.audio = next.audio ?? {}
    next.audio.scene_audios = sceneAudioUrls
    next.audio.tts = { provider: 'openai', model: ttsModel, voice: ttsVoice }
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


