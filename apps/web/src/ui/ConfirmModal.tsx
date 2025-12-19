import { useEffect, useRef } from 'react'

export function ConfirmModal(props: {
  open: boolean
  title: string
  description?: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  children?: React.ReactNode
  onConfirm: () => void
  onClose: () => void
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!props.open) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const t = window.setTimeout(() => cancelRef.current?.focus(), 0)

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prevOverflow
    }
  }, [props.open, props.onClose])

  if (!props.open) return null

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => props.onClose()} />
      <div className="absolute inset-0 grid place-items-center p-4">
        <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/80 shadow-2xl">
          <div className="p-5">
            <div className="text-base font-semibold">{props.title}</div>
            {props.description ? <div className="mt-2 text-sm leading-6 text-zinc-300">{props.description}</div> : null}
            {props.children ? <div className="mt-4">{props.children}</div> : null}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/10 bg-black/20 p-4">
            <button ref={cancelRef} onClick={() => props.onClose()} className="btn-dark h-10">
              {props.cancelText ?? '취소'}
            </button>
            <button onClick={() => props.onConfirm()} className={(props.danger ? 'btn-danger' : 'btn-primary') + ' h-10'}>
              {props.confirmText ?? '확인'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}



