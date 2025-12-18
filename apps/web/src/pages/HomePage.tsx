import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError, functionsGet, functionsPost } from '../lib/functionsClient'
import type {
  TrendStoryDeleteJobRequest,
  TrendStoryDeleteJobResponse,
  TrendStoryJobsResponse,
  TrendStoryStartRequest,
  TrendStoryStartResponse,
} from '../lib/types'
import { Shell } from '../ui/Shell'
import { ConfirmModal } from '../ui/ConfirmModal'

export function HomePage() {
  const nav = useNavigate()
  const [topicDomain, setTopicDomain] = useState('')
  const [language, setLanguage] = useState('ko')
  const [audience, setAudience] = useState('')
  const [inputAsText, setInputAsText] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [jobs, setJobs] = useState<TrendStoryJobsResponse['jobs']>([])
  const [jobsError, setJobsError] = useState<string | null>(null)
  const [jobsLoading, setJobsLoading] = useState(false)
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null)
  const [deleteModalJobId, setDeleteModalJobId] = useState<string | null>(null)

  const canSubmit = useMemo(() => topicDomain.trim().length > 0 && !isSubmitting, [topicDomain, isSubmitting])

  async function refreshJobs() {
    setJobsLoading(true)
    setJobsError(null)
    try {
      const res = await functionsGet<TrendStoryJobsResponse>('trendstory-jobs?limit=20')
      setJobs(res.jobs ?? [])
    } catch (err: any) {
      setJobsError(err?.message ?? '목록을 불러오지 못했습니다.')
    } finally {
      setJobsLoading(false)
    }
  }

  async function deleteJob(jobId: string) {
    setDeletingJobId(jobId)
    try {
      const body: TrendStoryDeleteJobRequest = { job_id: jobId }
      await functionsPost<TrendStoryDeleteJobResponse, any>('trendstory-delete-job', body as any)
      await refreshJobs()
    } catch (err: any) {
      setJobsError(err?.message ?? '삭제 중 오류가 발생했습니다.')
    } finally {
      setDeletingJobId(null)
    }
  }

  useEffect(() => {
    refreshJobs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setIsSubmitting(true)
    setError(null)
    try {
      const payload: TrendStoryStartRequest = {
        topic_domain: topicDomain.trim(),
        language: language.trim() || 'ko',
        audience: audience.trim() || '중학생',
        input_as_text: inputAsText.trim() || undefined,
      }
      const res = await functionsPost<TrendStoryStartResponse, any>('trendstory-start', payload as any)
      nav(`/jobs/${res.job_id}`)
    } catch (err: any) {
      if (err instanceof ApiError) {
        setError(err.bodyText ? `${err.message}\n${err.bodyText}` : err.message)
      } else {
        setError(err?.message ?? '요청 중 오류가 발생했습니다.')
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Shell>
      <div className="grid gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">트렌드 스토리 + 씬 이미지 + TTS 자동 생성</h1>
          <p className="mt-2 text-sm leading-6 text-zinc-400">
            topic_domain / language / audience를 입력하면 Edge Function이 오케스트레이션을 수행하고, 완료 시 패키지(JSON),
            씬 이미지 URL, 오디오 URL을 한 번에 제공합니다.
          </p>
        </div>

        <form onSubmit={onSubmit} className="card p-5">
          <div className="grid gap-4 md:grid-cols-3">
            <label className="grid gap-1">
              <span className="text-xs font-medium text-zinc-300">topic_domain (필수)</span>
              <input
                className="h-10 rounded-lg border border-white/10 bg-zinc-950 px-3 text-sm outline-none focus:border-white/20"
                placeholder="예: 인공지능, 우주, 경제, 역사, 과학 실험..."
                value={topicDomain}
                onChange={(e) => setTopicDomain(e.target.value)}
                required
              />
            </label>
            <label className="grid gap-1">
              <span className="text-xs font-medium text-zinc-300">language</span>
              <select
                className="h-10 rounded-lg border border-white/10 bg-zinc-950 px-3 text-sm outline-none focus:border-white/20"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                <option value="ko">한국어</option>
                <option value="en">영어</option>
                <option value="ja">일본어</option>
              </select>
            </label>
            <label className="grid gap-1">
              <span className="text-xs font-medium text-zinc-300">audience</span>
              <input
                className="h-10 rounded-lg border border-white/10 bg-zinc-950 px-3 text-sm outline-none focus:border-white/20"
                value={audience}
                placeholder="예: 중학생, 대학생, 전문가, 어린이, 시니어"
                onChange={(e) => setAudience(e.target.value)}
              />
            </label>
          </div>

          <label className="mt-4 grid gap-1">
            <span className="text-xs font-medium text-zinc-300">추가 프롬프트 (선택)</span>
            <textarea
              className="min-h-24 rounded-lg border border-white/10 bg-zinc-950 p-3 text-sm outline-none focus:border-white/20"
              placeholder="스타일/톤/금지사항/구성 힌트 등을 적어주세요. 예: “이미지는 만화 스케치톤으로, 텍스트/워터마크 없이”"
              value={inputAsText}
              onChange={(e) => setInputAsText(e.target.value)}
            />
          </label>

          <div className="mt-4 flex items-center justify-between gap-3">
            <button
              type="submit"
              disabled={!canSubmit}
              className="btn-primary h-10"
            >
              {isSubmitting ? '시작 중...' : '생성 시작'}
            </button>
            <div className="text-xs text-zinc-500">완료까지 수십 초~수 분 소요될 수 있어요 (job 폴링)</div>
          </div>

          {error ? <div className="mt-4 text-sm text-red-300">오류: {error}</div> : null}
        </form>

        <section className="card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold">최근 생성된 컨텐츠</h2>
            <button
              onClick={() => refreshJobs()}
              className="btn-dark h-9 px-3 text-xs"
            >
              새로고침
            </button>
          </div>
          {jobsLoading ? <div className="mt-3 text-sm text-zinc-400">불러오는 중...</div> : null}
          {jobsError ? <div className="mt-3 text-sm text-red-300">오류: {jobsError}</div> : null}
          {!jobsLoading && !jobsError ? (
            <div className="mt-3 grid gap-2">
              {jobs.map((j) => (
                <div
                  key={j.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-zinc-950/60 px-3 py-2 text-sm"
                >
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
                    <Link to={`/jobs/${j.id}`} className="font-semibold hover:underline">
                      {j.id.slice(0, 8)}…
                    </Link>
                    <span className="text-xs text-zinc-500">{new Date(j.created_at).toLocaleString()}</span>
                    <span className="text-xs text-zinc-400">상태: {j.status}</span>
                    <span className="text-xs text-zinc-600">trace: {j.trace_id.slice(0, 8)}…</span>
                    <span className="text-xs text-zinc-300">
                      {(j.input as any)?.topic_domain ? `topic: ${(j.input as any).topic_domain}` : ''}
                      {(j.input as any)?.language ? ` / lang: ${(j.input as any).language}` : ''}
                      {(j.input as any)?.audience ? ` / audience: ${(j.input as any).audience}` : ''}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/jobs/${j.id}`}
                      className="btn-dark h-8 px-3 text-xs"
                    >
                      열기
                    </Link>
                    <button
                      onClick={() => setDeleteModalJobId(j.id)}
                      disabled={deletingJobId === j.id}
                      className="btn-danger h-8 px-3 text-xs"
                    >
                      {deletingJobId === j.id ? '삭제 중...' : '삭제'}
                    </button>
                  </div>
                </div>
              ))}
              {jobs.length === 0 ? <div className="text-sm text-zinc-400">아직 생성된 job이 없습니다.</div> : null}
            </div>
          ) : null}
        </section>
      </div>

      <ConfirmModal
        open={Boolean(deleteModalJobId)}
        title="컨텐츠 삭제"
        description="이 job을 삭제할까요? (씬/에셋/스토리지 파일도 함께 정리됩니다)"
        confirmText="삭제"
        cancelText="취소"
        danger
        onClose={() => setDeleteModalJobId(null)}
        onConfirm={async () => {
          if (!deleteModalJobId) return
          const id = deleteModalJobId
          setDeleteModalJobId(null)
          await deleteJob(id)
        }}
      />
    </Shell>
  )
}


