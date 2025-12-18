import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

export function Shell(props: { title?: string; children: ReactNode }) {
  return (
    <div className="min-h-full">
      <header className="border-b border-white/10 bg-zinc-950/50 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <Link to="/" className="text-sm font-semibold tracking-tight text-white">
            YouTube 컨텐츠 자동생성 (MVP)
          </Link>
          {props.title ? (
            <div className="text-sm text-zinc-300">
              <span className="text-zinc-500">/</span> {props.title}
            </div>
          ) : null}
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{props.children}</main>
      <footer className="border-t border-white/10 bg-black/10 py-6">
        <div className="mx-auto max-w-5xl px-4 text-xs text-zinc-500">
          로그인 없이 동작합니다. 모든 생성/조회는 Supabase Edge Function을 통해 수행됩니다.
        </div>
      </footer>
    </div>
  )
}


