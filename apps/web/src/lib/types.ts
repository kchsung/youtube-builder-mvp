export type TrendStoryStartRequest = {
  topic_domain: string
  language: string
  audience: string
  input_as_text?: string
  job_id?: string // 기존 job 재사용 시 (재시작)
}

export type TrendStoryStartResponse = {
  job_id: string
  trace_id?: string
}

export type JobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'

export type DbJobRow = {
  id: string
  created_at: string
  status: JobStatus
  input: unknown
  autoconfig: unknown | null
  packager: unknown | null
  final_package: unknown | null
  error: string | null
}

export type DbSceneRow = {
  id: string
  job_id: string
  scene_id: number
  narration: string | null
  on_screen_text: string | null
  visual_brief: string | null
  mood: string | null
  duration_sec: number | null
  image_prompt: string | null
  image_path: string | null
  image_url: string | null
  image_gen_status?: string | null
  image_gen_request_id?: string | null
  image_gen_started_at?: string | null
  image_gen_error?: string | null
}

export type DbAssetRow = {
  id: string
  job_id: string
  type: 'image' | 'audio' | 'json'
  path: string | null
  url: string | null
  meta: unknown | null
}

export type TrendStoryStatusResponse = {
  trace_id?: string
  status: JobStatus
  job: DbJobRow
  scenes?: DbSceneRow[]
  assets?: DbAssetRow[]
}

export type TrendStoryJobsItem = {
  id: string
  created_at: string
  status: JobStatus
  trace_id: string
  input: unknown
  error: string | null
}

export type TrendStoryJobsResponse = {
  jobs: TrendStoryJobsItem[]
}

export type TrendStoryRetryImagesRequest = {
  job_id: string
  scene_ids?: number[]
  missing_only?: boolean
}

export type TrendStoryRetryImagesResponse = {
  job_id: string
  attempted: number
  succeeded: number
  failed: number
  skipped: number
  accepted?: boolean
  message?: string
}

export type TrendStoryGenerateSceneImageRequest = {
  job_id: string
  scene_id: number
  force?: boolean
}

export type TrendStoryGenerateSceneImageResponse = {
  job_id: string
  scene_id: number
  accepted: boolean
  status: 'QUEUED' | 'ALREADY_EXISTS' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED'
  image_url?: string | null
  message?: string
}

export type TrendStoryRetryAudioRequest = {
  job_id: string
  force?: boolean
  scene_ids?: number[] // 선택된 씬만 재생성 (없으면 전체)
}

export type TrendStoryRetryAudioResponse = {
  job_id: string
  accepted: boolean
  message: string
}

export type TrendStoryDeleteJobRequest = {
  job_id: string
}

export type TrendStoryDeleteJobResponse = {
  job_id: string
  accepted: boolean
  message: string
}


