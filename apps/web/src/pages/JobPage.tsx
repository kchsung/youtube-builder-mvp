import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { functionsGet, functionsPost } from '../lib/functionsClient'
import { copyText, downloadFileFromUrl, downloadJson, downloadScenesImagesZip } from '../lib/clientUtils'
import type {
  TrendStoryRetryImagesRequest,
  TrendStoryRetryImagesResponse,
  TrendStoryRetryAudioRequest,
  TrendStoryRetryAudioResponse,
  TrendStoryStartRequest,
  TrendStoryStartResponse,
  TrendStoryStatusResponse,
} from '../lib/types'
import { Shell } from '../ui/Shell'

function formatStatus(status: string) {
  if (status === 'QUEUED') return '대기 중'
  if (status === 'RUNNING') return '생성 중'
  if (status === 'SUCCEEDED') return '완료'
  if (status === 'FAILED') return '실패'
  return status
}

export function JobPage() {
  const { id } = useParams()
  const jobId = id ?? ''
  const [data, setData] = useState<TrendStoryStatusResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [pollingBlocked, setPollingBlocked] = useState(false)
  const [retryMsg, setRetryMsg] = useState<string | null>(null)
  const [isRetryingImages, setIsRetryingImages] = useState(false)
  const [isRestarting, setIsRestarting] = useState(false)
  const [isRetryingAudio, setIsRetryingAudio] = useState(false)
  const [isDownloadingZip, setIsDownloadingZip] = useState(false)

  const status = data?.status
  const isPolling = !pollingBlocked && (status === 'QUEUED' || status === 'RUNNING' || !status)

  async function refresh() {
    if (!jobId) return
    setError(null)
    try {
      const res = await functionsGet<TrendStoryStatusResponse>(`trendstory-status?job_id=${encodeURIComponent(jobId)}`)
      setData(res)
    } catch (err: any) {
      const msg = err?.message ?? '조회 중 오류가 발생했습니다.'
      setError(msg)
      if (typeof msg === 'string' && msg.startsWith('Missing required env:')) setPollingBlocked(true)
    } finally {
      setIsLoading(false)
    }
  }

  async function retryMissingImages(sceneIds?: number[]) {
    if (!jobId) return
    setRetryMsg(null)
    setIsRetryingImages(true)
    try {
      const body: TrendStoryRetryImagesRequest = {
        job_id: jobId,
        scene_ids: sceneIds && sceneIds.length > 0 ? sceneIds : undefined,
        missing_only: !sceneIds || sceneIds.length === 0 ? true : false,
      }
      const res = await functionsPost<TrendStoryRetryImagesResponse, any>('trendstory-retry-images', body as any)
      setRetryMsg(`이미지 재시도: 성공 ${res.succeeded} / 실패 ${res.failed} (시도 ${res.attempted})`)
      await refresh()
    } catch (err: any) {
      setRetryMsg(`이미지 재시도 실패: ${err?.message ?? '알 수 없는 오류'}`)
    } finally {
      setIsRetryingImages(false)
    }
  }

  function getStartPayloadFromJobInput(): TrendStoryStartRequest | null {
    const input: any = data?.job?.input
    if (!input) return null
    const topic = String(input.topic_domain ?? '').trim()
    if (!topic) return null
    return {
      topic_domain: topic,
      language: String(input.language ?? 'ko').trim() || 'ko',
      audience: String(input.audience ?? '중학생').trim() || '중학생',
      input_as_text: typeof input.input_as_text === 'string' && input.input_as_text.trim() ? input.input_as_text.trim() : undefined,
    }
  }

  async function restartWholeJob() {
    const payload = getStartPayloadFromJobInput()
    if (!payload) {
      setRetryMsg('전체 재생성 실패: job.input을 파싱하지 못했습니다.')
      return
    }
    setIsRestarting(true)
    setRetryMsg(null)
    try {
      const res = await functionsPost<TrendStoryStartResponse, any>('trendstory-start', payload as any)
      // hard navigate to new job
      window.location.href = `/jobs/${res.job_id}`
    } catch (err: any) {
      setRetryMsg(`전체 재생성 실패: ${err?.message ?? '알 수 없는 오류'}`)
    } finally {
      setIsRestarting(false)
    }
  }

  async function regenerateAllImagesSequential() {
    if (!jobId) return
    const sceneIds = (data?.scenes ?? []).map((s) => s.scene_id).filter((n) => Number.isFinite(n))
    if (sceneIds.length === 0) {
      setRetryMsg('이미지 재생성: scene이 없어 실행할 수 없습니다.')
      return
    }
    setIsRetryingImages(true)
    setRetryMsg(null)
    let ok = 0
    let fail = 0
    for (const sid of sceneIds) {
      try {
        const body: TrendStoryRetryImagesRequest = { job_id: jobId, scene_ids: [sid], missing_only: false }
        const res = await functionsPost<TrendStoryRetryImagesResponse, any>('trendstory-retry-images', body as any)
        ok += res.succeeded
        fail += res.failed
        setRetryMsg(`전체 이미지 재생성 진행 중... (scene ${sid}) 성공 ${ok} / 실패 ${fail}`)
        await refresh()
      } catch (err: any) {
        fail += 1
        setRetryMsg(`전체 이미지 재생성 진행 중... (scene ${sid}) 오류: ${err?.message ?? '알 수 없는 오류'}`)
      }
    }
    setRetryMsg(`전체 이미지 재생성 완료: 성공 ${ok} / 실패 ${fail}`)
    setIsRetryingImages(false)
    await refresh()
  }

  async function retryAudio() {
    if (!jobId) return
    setRetryMsg(null)
    setIsRetryingAudio(true)
    try {
      const body: TrendStoryRetryAudioRequest = { job_id: jobId, force: true }
      const res = await functionsPost<TrendStoryRetryAudioResponse, any>('trendstory-retry-audio', body as any)
      setRetryMsg(res.message || '오디오 재생성을 시작했습니다. 잠시 후 새로고침 해주세요.')
      await refresh()
    } catch (err: any) {
      setRetryMsg(`오디오 재생성 실패: ${err?.message ?? '알 수 없는 오류'}`)
    } finally {
      setIsRetryingAudio(false)
    }
  }

  async function downloadAllImagesZip() {
    const scenes = (data?.scenes ?? []).filter((s) => Boolean(s.image_url))
    if (scenes.length === 0) {
      setRetryMsg('다운로드할 이미지가 없습니다.')
      return
    }
    setIsDownloadingZip(true)
    setRetryMsg(null)
    try {
      await downloadScenesImagesZip(
        scenes.map((s) => ({ scene_id: s.scene_id, image_url: s.image_url! })),
        `job_${jobId}_images.zip`,
        (done, total) => setRetryMsg(`ZIP 생성 중... ${done}/${total}`),
      )
      setRetryMsg('ZIP 다운로드를 시작했습니다.')
    } catch (err: any) {
      setRetryMsg(`ZIP 다운로드 실패: ${err?.message ?? '알 수 없는 오류'}`)
    } finally {
      setIsDownloadingZip(false)
    }
  }

  useEffect(() => {
    setIsLoading(true)
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  useEffect(() => {
    if (!isPolling) return
    const t = window.setInterval(() => {
      refresh()
    }, 2500)
    return () => window.clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, isPolling])

  const audioUrl = useMemo(() => {
    const fromAssets = data?.assets?.find((a) => a.type === 'audio')?.url
    if (fromAssets) return fromAssets
    const fp: any = data?.job?.final_package
    return fp?.audio?.audio_url ?? null
  }, [data])

  const finalPackage = useMemo(() => data?.job?.final_package ?? null, [data])
  const autoconfig = useMemo(() => data?.job?.autoconfig ?? null, [data])
  const packager = useMemo(() => data?.job?.packager ?? null, [data])
  const youtubeMeta = useMemo(() => {
    const fp: any = data?.job?.final_package
    if (fp?.youtube_meta) return fp.youtube_meta
    const pk: any = data?.job?.packager
    return pk?.youtube_meta ?? null
  }, [data])

  const progress = useMemo(() => {
    const scenes = data?.scenes ?? []
    const imagesDone = scenes.filter((s) => Boolean(s.image_url)).length
    const audioDone = Boolean(audioUrl)
    return {
      autoconfigDone: Boolean(autoconfig),
      packagerDone: Boolean(packager),
      scenesCount: scenes.length,
      imagesDone,
      audioDone,
    }
  }, [data, autoconfig, packager, audioUrl])

  async function copyHashtags() {
    const tags: unknown = youtubeMeta?.hashtags
    if (Array.isArray(tags)) await copyText(tags.join(' '))
  }

  return (
    <Shell title={`Job ${jobId.slice(0, 8)}…`}>
      <div className="grid gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid gap-1">
            <div className="text-sm text-zinc-400">
              <Link to="/" className="underline decoration-white/20 underline-offset-4 hover:text-white">
                홈으로
              </Link>
            </div>
            <div className="text-lg font-semibold">상태: {formatStatus(data?.status ?? '...')}</div>
            {data?.trace_id ? <div className="text-xs text-zinc-500">trace_id: {data.trace_id}</div> : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => refresh()}
              className="btn-ghost h-10"
            >
              새로고침
            </button>
            <button
              onClick={() => retryMissingImages()}
              disabled={isRetryingImages}
              className="btn-primary h-10"
              title="이미지가 없는 씬만 다시 생성합니다."
            >
              {isRetryingImages ? '재시도 중...' : '누락 이미지 재시도'}
            </button>
            <button
              onClick={() => regenerateAllImagesSequential()}
              disabled={true}
              className="btn-dark h-10"
              title="모든 씬을 순서대로 1개씩 다시 생성합니다(이미 있어도 덮어쓸 수 있음)."
            >
              {isRetryingImages ? '생성 중...' : '전체 이미지 다시 생성'}
            </button>
            <button
              onClick={() => restartWholeJob()}
              disabled={isRestarting}
              className="btn-ghost h-10"
              title="같은 입력으로 새 job을 만들어 전체 컨텐츠를 다시 생성합니다."
            >
              {isRestarting ? '재시작 중...' : '전체 컨텐츠 다시 생성'}
            </button>
          </div>
        </div>

        {isLoading ? <div className="text-sm text-zinc-400">불러오는 중...</div> : null}
        {error ? <div className="text-sm text-red-300">오류: {error}</div> : null}
        {retryMsg ? <div className="text-sm text-zinc-300">{retryMsg}</div> : null}
        {data?.status === 'FAILED' ? (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
            실패: {data.job.error ?? '알 수 없는 오류'}
          </div>
        ) : null}

        {data?.status === 'RUNNING' || data?.status === 'QUEUED' ? (
          <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-zinc-300">
            생성 작업이 진행 중입니다. 2~3초 간격으로 자동 갱신합니다.
            <div className="mt-2 grid gap-1 text-xs text-zinc-400">
              <div>autoconfig: {progress.autoconfigDone ? '완료' : '대기'}</div>
              <div>packager: {progress.packagerDone ? '완료' : '대기'}</div>
              <div>scenes: {progress.scenesCount}개</div>
              <div>images: {progress.imagesDone}/{progress.scenesCount}</div>
              <div>audio: {progress.audioDone ? '완료' : '대기'}</div>
            </div>
          </div>
        ) : null}

        {(autoconfig || packager) && data?.status !== 'FAILED' ? (
          <section className="card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold">에이전트 중간 결과</h2>
              <div className="flex flex-wrap gap-2">
                {autoconfig ? (
                  <button
                    onClick={() => copyText(JSON.stringify(autoconfig ?? {}, null, 2))}
                    className="btn-dark h-9 px-3 text-xs"
                  >
                    autoconfig 복사
                  </button>
                ) : null}
                {packager ? (
                  <button
                    onClick={() => copyText(JSON.stringify(packager ?? {}, null, 2))}
                    className="btn-dark h-9 px-3 text-xs"
                  >
                    packager 복사
                  </button>
                ) : null}
              </div>
            </div>

            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div className="codebox">
                <div className="text-xs font-medium text-zinc-400">autoconfig</div>
                <pre className="mt-2 max-h-[320px] overflow-auto whitespace-pre-wrap text-xs text-zinc-200">
                  {autoconfig ? JSON.stringify(autoconfig, null, 2) : '아직 생성되지 않았습니다.'}
                </pre>
              </div>
              <div className="codebox">
                <div className="text-xs font-medium text-zinc-400">packager</div>
                <pre className="mt-2 max-h-[320px] overflow-auto whitespace-pre-wrap text-xs text-zinc-200">
                  {packager ? JSON.stringify(packager, null, 2) : '아직 생성되지 않았습니다.'}
                </pre>
              </div>
            </div>
          </section>
        ) : null}

        {data?.status === 'SUCCEEDED' || data?.status === 'RUNNING' || data?.status === 'QUEUED' ? (
          <div className="grid gap-6">
            <section className="card p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-semibold">오디오 내레이션</h2>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    onClick={() => retryAudio()}
                    disabled={isRetryingAudio}
                    className="btn-dark h-9 px-3 text-xs"
                  >
                    {isRetryingAudio ? '오디오 생성 중...' : '오디오 재생성'}
                  </button>
                  {audioUrl ? (
                    <a
                      href={audioUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-zinc-300 underline decoration-white/20 underline-offset-4"
                    >
                      파일 열기
                    </a>
                  ) : null}
                </div>
              </div>
              {audioUrl ? (
                <audio className="mt-3 w-full" controls src={audioUrl} />
              ) : (
                <div className="mt-3 text-sm text-zinc-400">audio_url을 찾지 못했습니다.</div>
              )}
            </section>

            <section className="card p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-semibold">YouTube 메타</h2>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => copyText(JSON.stringify(youtubeMeta ?? {}, null, 2))}
                    className="btn-dark h-9 px-3 text-xs"
                  >
                    JSON 복사
                  </button>
                  <button
                    onClick={() => copyHashtags()}
                    className="btn-dark h-9 px-3 text-xs"
                  >
                    해시태그 복사
                  </button>
                </div>
              </div>

              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div className="codebox">
                  <div className="text-xs font-medium text-zinc-400">titles</div>
                  <pre className="mt-2 whitespace-pre-wrap text-xs text-zinc-200">
                    {Array.isArray(youtubeMeta?.titles) ? youtubeMeta.titles.join('\n') : '—'}
                  </pre>
                </div>
                <div className="codebox">
                  <div className="text-xs font-medium text-zinc-400">hook_lines</div>
                  <pre className="mt-2 whitespace-pre-wrap text-xs text-zinc-200">
                    {Array.isArray(youtubeMeta?.hook_lines) ? youtubeMeta.hook_lines.join('\n') : '—'}
                  </pre>
                </div>
                <div className="codebox">
                  <div className="text-xs font-medium text-zinc-400">thumbnail_texts</div>
                  <pre className="mt-2 whitespace-pre-wrap text-xs text-zinc-200">
                    {Array.isArray(youtubeMeta?.thumbnail_texts) ? youtubeMeta.thumbnail_texts.join('\n') : '—'}
                  </pre>
                </div>
                <div className="codebox">
                  <div className="text-xs font-medium text-zinc-400">hashtags</div>
                  <pre className="mt-2 whitespace-pre-wrap text-xs text-zinc-200">
                    {Array.isArray(youtubeMeta?.hashtags) ? youtubeMeta.hashtags.join(' ') : '—'}
                  </pre>
                </div>
              </div>
            </section>

            {finalPackage ? (
              <section className="card p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-base font-semibold">최종 패키지(JSON)</h2>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => downloadJson(`final_package_${jobId}.json`, finalPackage)}
                      className="btn-primary h-9 px-3 text-xs"
                    >
                      다운로드
                    </button>
                    <button
                      onClick={() => copyText(JSON.stringify(finalPackage ?? {}, null, 2))}
                      className="btn-dark h-9 px-3 text-xs"
                    >
                      JSON 복사
                    </button>
                  </div>
                </div>
                <pre className="codebox mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap">
                  {JSON.stringify(finalPackage ?? {}, null, 2)}
                </pre>
              </section>
            ) : null}

            <section className="card p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-semibold">씬</h2>
                <button
                  onClick={() => downloadAllImagesZip()}
                  disabled={isDownloadingZip}
                  className="btn-dark h-9 px-3 text-xs"
                  title="이미지가 있는 씬만 zip으로 다운로드합니다."
                >
                  {isDownloadingZip ? 'ZIP 생성 중...' : '전체 이미지 ZIP 다운로드'}
                </button>
              </div>
              <div className="mt-4 grid gap-4">
                {(data.scenes ?? []).map((s) => (
                  <div key={s.id} className="overflow-hidden rounded-2xl border border-white/10 bg-zinc-950">
                    <div className="grid gap-4 p-4 md:grid-cols-[240px_1fr]">
                      <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-white/10 bg-black/40">
                        {s.image_url ? (
                          <>
                            <img src={s.image_url} alt={`scene ${s.scene_id}`} className="h-full w-full object-cover" />
                            <button
                              onClick={() => downloadFileFromUrl(s.image_url!, `scene-${String(s.scene_id).padStart(2, '0')}.png`)}
                              className="absolute right-2 top-2 grid h-9 w-9 place-items-center rounded-lg border border-white/10 bg-black/60 text-white hover:bg-black/80"
                              title="이미지 다운로드"
                            >
                              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M12 3v10" />
                                <path d="M8 11l4 4 4-4" />
                                <path d="M5 21h14" />
                              </svg>
                            </button>
                          </>
                        ) : (
                          <div className="grid h-full place-items-center gap-2 p-3 text-xs text-zinc-500">
                            <div>이미지 없음</div>
                            <button
                              onClick={() => retryMissingImages([s.scene_id])}
                              disabled={isRetryingImages}
                              className="h-8 rounded-lg border border-white/10 bg-zinc-900 px-3 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                            >
                              {isRetryingImages ? '생성 중...' : '이 씬만 생성'}
                            </button>
                          </div>
                        )}
                      </div>
                      <div className="grid gap-2">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-semibold">Scene {s.scene_id}</div>
                          <div className="text-xs text-zinc-500">{s.duration_sec ? `${s.duration_sec}s` : ''}</div>
                        </div>
                        <div className="text-xs text-zinc-500">on_screen_text</div>
                        <div className="text-sm text-zinc-200">{s.on_screen_text ?? '—'}</div>
                        <div className="text-xs text-zinc-500">narration</div>
                        <div className="whitespace-pre-wrap text-sm text-zinc-200">{s.narration ?? '—'}</div>
                      </div>
                    </div>
                  </div>
                ))}
                {(data.scenes ?? []).length === 0 ? (
                  <div className="text-sm text-zinc-400">scenes 데이터를 찾지 못했습니다.</div>
                ) : null}
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </Shell>
  )
}


