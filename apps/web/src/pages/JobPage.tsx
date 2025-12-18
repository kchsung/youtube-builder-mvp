import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiError, functionsGet, functionsPost } from '../lib/functionsClient'
import { copyText, downloadFileFromUrl, downloadJson, downloadScenesImagesZip } from '../lib/clientUtils'
import type {
  TrendStoryRetryImagesRequest,
  TrendStoryRetryImagesResponse,
  TrendStoryRetryAudioRequest,
  TrendStoryRetryAudioResponse,
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
      const msg =
        err instanceof ApiError
          ? err.bodyText
            ? `${err.message}\n${err.bodyText}`
            : err.message
          : err?.message ?? '조회 중 오류가 발생했습니다.'
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
      const msg =
        err instanceof ApiError
          ? err.bodyText
            ? `${err.message}\n${err.bodyText}`
            : err.message
          : err?.message ?? '알 수 없는 오류'
      setRetryMsg(`이미지 재시도 실패: ${msg}`)
    } finally {
      setIsRetryingImages(false)
    }
  }

  // NOTE: "전체 컨텐츠 다시 생성" 버튼은 제거했습니다.

  // NOTE: "전체 이미지 다시 생성" 버튼은 제거했습니다.

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
      const msg =
        err instanceof ApiError
          ? err.bodyText
            ? `${err.message}\n${err.bodyText}`
            : err.message
          : err?.message ?? '알 수 없는 오류'
      setRetryMsg(`오디오 재생성 실패: ${msg}`)
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
    const audios = (data?.assets ?? []).filter((a) => a.type === 'audio')
    const anyAudio = audios[0]?.url
    if (anyAudio) return anyAudio
    const fp: any = data?.job?.final_package
    return fp?.audio?.audio_url ?? null
  }, [data])

  const sceneAudios = useMemo(() => {
    const fromAssets = (data?.assets ?? [])
      .filter((a) => a.type === 'audio' && (a as any)?.meta?.kind === 'scene')
      .map((a) => ({
        scene_id: Number((a as any)?.meta?.scene_id),
        audio_url: a.url as string,
      }))
      .filter((x) => Number.isFinite(x.scene_id) && Boolean(x.audio_url))
      .sort((a, b) => a.scene_id - b.scene_id)
    if (fromAssets.length > 0) return fromAssets

    const fp: any = data?.job?.final_package
    const fromFp = Array.isArray(fp?.audio?.scene_audios) ? fp.audio.scene_audios : []
    return fromFp
      .map((x: any) => ({ scene_id: Number(x?.scene_id), audio_url: String(x?.audio_url ?? '') }))
      .filter((x: any) => Number.isFinite(x.scene_id) && x.audio_url)
      .sort((a: any, b: any) => a.scene_id - b.scene_id)
  }, [data])

  const [autoPlayScenes, setAutoPlayScenes] = useState(false)
  const [sceneAudioIdx, setSceneAudioIdx] = useState(0)

  useEffect(() => {
    // jobId가 바뀌면 플레이어 상태 리셋
    setAutoPlayScenes(false)
    setSceneAudioIdx(0)
  }, [jobId])

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
    const sceneAudiosDone = sceneAudios.length
    return {
      autoconfigDone: Boolean(autoconfig),
      packagerDone: Boolean(packager),
      scenesCount: scenes.length,
      imagesDone,
      audioDone,
      sceneAudiosDone,
    }
  }, [data, autoconfig, packager, audioUrl, sceneAudios])

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
              <div>scene audio: {progress.sceneAudiosDone}/{progress.scenesCount}</div>
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
              {sceneAudios.length > 0 ? (
                <div className="mt-3 grid gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-400">
                    <div>씬별 오디오: {sceneAudios.length}개</div>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={autoPlayScenes}
                        onChange={(e) => setAutoPlayScenes(e.target.checked)}
                      />
                      자동 연속 재생
                    </label>
                  </div>
                  <audio
                    className="w-full"
                    controls
                    src={sceneAudios[Math.min(sceneAudioIdx, sceneAudios.length - 1)]?.audio_url}
                    onEnded={() => {
                      if (!autoPlayScenes) return
                      setSceneAudioIdx((i) => Math.min(i + 1, sceneAudios.length - 1))
                    }}
                  />
                  <div className="grid gap-2">
                    {sceneAudios.map((a: { scene_id: number; audio_url: string }, idx: number) => (
                      <button
                        key={`${a.scene_id}-${a.audio_url}`}
                        onClick={() => {
                          setSceneAudioIdx(idx)
                          setAutoPlayScenes(true)
                        }}
                        className={`flex items-center justify-between rounded-xl border px-3 py-2 text-left text-sm ${
                          idx === sceneAudioIdx ? 'border-white/30 bg-white/10' : 'border-white/10 bg-zinc-950/60 hover:bg-zinc-900/60'
                        }`}
                      >
                        <span className="text-zinc-200">Scene {a.scene_id}</span>
                        <span className="text-xs text-zinc-500">재생</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : audioUrl ? (
                <audio className="mt-3 w-full" controls src={audioUrl} />
              ) : (
                <div className="mt-3 text-sm text-zinc-400">오디오를 찾지 못했습니다. (TTS 로그를 확인해보세요)</div>
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
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => retryMissingImages()}
                    disabled={isRetryingImages}
                    className="grid h-9 w-9 place-items-center rounded-lg border border-white/10 bg-zinc-900 text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                    title="누락 이미지 재시도"
                  >
                    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 12a9 9 0 1 0 3-6.7" />
                      <path d="M3 3v6h6" />
                    </svg>
                  </button>
                  <button
                    onClick={() => downloadAllImagesZip()}
                    disabled={isDownloadingZip}
                    className="btn-dark h-9 px-3 text-xs"
                    title="이미지가 있는 씬만 zip으로 다운로드합니다."
                  >
                    {isDownloadingZip ? 'ZIP 생성 중...' : '전체 이미지 ZIP 다운로드'}
                  </button>
                </div>
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


