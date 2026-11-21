/**
 * The pieces of the phone's way through nexnotes (NOTES-23 AC-1, drawings "Handy-Ordner", "Handy-Kacheln",
 * "Handy-Editor"): one view after the other, folders, then notes, then the note, each with "‹ Back" to the one before,
 * and "New note" as a large round button at the bottom right. Only below the app's `md` (768 px); wider screens have
 * the sidebar and the notes beside the list.
 */
import { ChevronLeft, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

/** "‹ <name>" at the top of a view: back to the one before it. */
export function PhoneBack({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="-ml-1 flex min-h-11 w-fit max-w-full items-center gap-1 pr-2 text-base text-accent-400 md:hidden" data-testid="phone-back">
      <ChevronLeft aria-hidden className="h-5 w-5 shrink-0" />
      <span className="truncate">{label}</span>
    </Link>
  )
}

/** "New note", large and round at the bottom right. */
export function PhoneNewNote({ onClick, label, disabled = false }: { onClick: () => void; label?: string; disabled?: boolean }) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      aria-label={label ?? t('notes.new')}
      onClick={onClick}
      disabled={disabled}
      data-testid="phone-new-note"
      className="fixed right-4 bottom-7 z-20 flex h-14 w-14 items-center justify-center rounded-[18px] bg-accent-500 text-on-accent shadow-lg md:hidden"
    >
      <Plus className="h-[22px] w-[22px]" strokeWidth={2.6} aria-hidden />
    </button>
  )
}
