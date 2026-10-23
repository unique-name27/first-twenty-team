// The Ask sheet: the conversation with the assistant, the question box, and what to do when it cannot
// answer (no server, signed in but not connected, signed out, off on this server, the day's questions used
// up, a busy or broken answer). Keyboard first: focus starts in the question box (or, when the sheet can
// only explain, on the explanation's first action), Enter sends and Shift+Enter starts a new line, and the
// finished answer (never each piece of it) is announced to screen readers.
import { type MouseEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { assistantNameError, defaultAssistantName } from '@/domain/assistant'
import { focusServerStep } from '@/features/settings/serverFocus'
import { useDB } from '@/store/db'
import { isServedPage, useSyncStatus } from '@/sync'
import { Button, Callout, cx, Field, focusPageStart, Icon, IconButton, Sheet, TextArea, TextInput, toast } from '@/ui'
import { assistant, useAssistant, useAssistantName } from './instance'
import {
  applyAssistantName,
  canRetry,
  conversationFullText,
  CUT_OFF_TEXT,
  failureText,
  historyFits,
  LIVE_DEMO_SIGNUP_URL,
  MAX_MESSAGE_LENGTH,
  messageProblem,
  remainingText,
  renameChanges,
  renameLabel,
  type SheetView,
  sheetView,
  suggestionsFor,
  turnsFromHistory,
} from './logic'
import { Markdown, markdownToPlainText } from './markdown'
import type { Pending } from './store'

const QUESTION_ID = 'assistant-question'
const COUNT_ID = 'assistant-count'
const NOTICE_ID = 'assistant-notice'
const BLOCKED_ID = 'assistant-blocked'
/** The explanation shown instead of the conversation (StateNotice), for focus to land on. */
const STATE_ID = 'assistant-state'
const LINK = 'ft-link font-semibold text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent'

/** Focus moves at once, never on a later frame, so it cannot land after the person moved on. */
const focusQuestion = () => document.getElementById(QUESTION_ID)?.focus()

/** True for a field someone may be typing in (focus is never pulled out of one). */
function isTextField(el: Element | null): boolean {
  return !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'text'))
}

export function AssistantSheet({ returnFocus }: { returnFocus: () => HTMLElement | null }) {
  const open = useAssistant((s) => s.open)
  const info = useAssistant((s) => s.info)
  const name = useAssistantName()
  const companyName = useDB((s) => s.db.company.name)
  const mode = useSyncStatus((s) => s.mode)
  const syncStatus = useSyncStatus((s) => s.status)
  const signedIn = useSyncStatus((s) => s.user !== null)
  const viewer = useViewer()
  const [renaming, setRenaming] = useState(false)
  const pencil = useRef<HTMLButtonElement>(null)
  const view = sheetView({ mode, served: isServedPage(), signedIn, syncStatus, info })
  const signedOut = syncStatus === 'signed_out'
  // Nothing known for this login yet (just signed in as someone else while the sheet was open).
  const unknown = info.phase === 'idle'

  // Ask the server each time the sheet opens: the questions left today change, and so may the server.
  useEffect(() => {
    if (open && mode === 'server' && !signedOut) void assistant.actions.loadInfo()
  }, [open, mode, signedOut, unknown])
  useEffect(() => {
    if (!open) setRenaming(false)
  }, [open])
  // When the sheet can only explain (no server, not connected, signed out, off, unreachable), focus goes to
  // the explanation's first action (or the explanation itself) instead of the header's Rename pencil, which
  // is all the sheet had to focus when it opened or while it was checking. Runs after the sheet's own focus
  // (a parent's effects run after its children's), and never takes focus from anything the person chose.
  useEffect(() => {
    if (!open || view.kind === 'ready' || view.kind === 'checking') return
    const active = document.activeElement
    const initial = !active || active === document.body || active === pencil.current || active.matches('.ft-sheet__close')
    if (!initial) return
    const notice = document.getElementById(STATE_ID)
    const target = notice?.querySelector<HTMLElement>('a[href], button:not([disabled])') ?? notice
    target?.focus()
  }, [open, view.kind])

  const close = () => assistant.actions.closeSheet()
  // An in-app link from an answer or a notice: the sheet closes so the page shows; focus goes to its title.
  const followAppLink = () => {
    close()
    // After the sheet gave focus back and the new page rendered.
    setTimeout(focusPageStart, 60)
  }
  // A link to Settings > Server: the sheet closes, and focus goes to where the next step starts there (the
  // sign-in form, Upload), as the header's links do. Already on that page, following the link would do
  // nothing, so it is not followed.
  const followServerLink = (e: MouseEvent<HTMLAnchorElement>) => {
    if (window.location.hash === links.settings('server')) e.preventDefault()
    close()
    // The step shows once the page rendered and its server check answered: wait for it (as the app's other
    // focus helpers do, up to 0.7 s), then fall back to the page's title.
    setTimeout(() => {
      const start = Date.now()
      const attempt = () => {
        if (focusServerStep()) return
        if (Date.now() - start < 700) requestAnimationFrame(attempt)
        else focusPageStart()
      }
      attempt()
    }, 60)
  }
  const doneRenaming = () => {
    // The pencil takes focus before the form (and the field holding focus) goes.
    pencil.current?.focus()
    setRenaming(false)
  }

  return (
    <Sheet
      open={open}
      onClose={close}
      title={`Ask ${name}`}
      subtitle={`HR assistant for ${companyName.trim() || 'your company'}`}
      width={600}
      returnFocus={returnFocus}
      headerExtra={
        viewer.role === 'admin' && (
          <IconButton ref={pencil} icon="edit" label={`Rename ${name}`} aria-expanded={renaming} onClick={() => (renaming ? doneRenaming() : setRenaming(true))} />
        )
      }
      footer={view.kind === 'ready' ? <Composer name={name} /> : undefined}
    >
      <div className="ft-assistant flex flex-col gap-4">
        {renaming && <RenameForm onDone={doneRenaming} />}
        {view.kind === 'ready' ? <Conversation name={name} onAppLink={followAppLink} /> : <StateNotice view={view} name={name} onServerLink={followServerLink} />}
        <LiveRegion name={name} />
      </div>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------------------------
// When the assistant cannot answer here
// ---------------------------------------------------------------------------------------------

function StateNotice({ view, name, onServerLink }: { view: Exclude<SheetView, { kind: 'ready' }>; name: string; onServerLink: (e: MouseEvent<HTMLAnchorElement>) => void }) {
  if (view.kind === 'checking') {
    return (
      <p role="status" className="text-[14px] text-ink-3">
        Checking whether {name} is on for your server.
      </p>
    )
  }
  // Focus lands here when there is nothing to do in it (the server has it off): see AssistantSheet.
  return (
    <div id={STATE_ID} tabIndex={-1} className="focus:outline-none">
      <Explanation view={view} name={name} onServerLink={onServerLink} />
    </div>
  )
}

function Explanation({ view, name, onServerLink }: { view: Exclude<SheetView, { kind: 'ready' | 'checking' }>; name: string; onServerLink: (e: MouseEvent<HTMLAnchorElement>) => void }) {
  const serverLink = (text: string) => (
    <a href={links.settings('server')} onClick={onServerLink} className={cx(LINK, 'inline-flex min-h-10 items-center')}>
      {text}
    </a>
  )
  switch (view.kind) {
    case 'local':
      return (
        <Callout tone="neutral" icon="globe" title={`${name} needs a First Twenty server`}>
          <p>
            {name} works when the app is connected to a First Twenty server with AI turned on. This copy keeps its data in this browser only, so there
            is no server for {name} to ask.
          </p>
          <p className="mt-1">
            <a href={LIVE_DEMO_SIGNUP_URL} target="_blank" rel="noopener noreferrer" className={cx(LINK, 'inline-flex min-h-10 items-center gap-1')}>
              Create a demo company on the live server to try it
              <Icon name="external" size={13} />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </p>
        </Callout>
      )
    case 'connect':
      return (
        <Callout tone="neutral" icon="lock" title={`Sign in to ask ${name}`}>
          <p>This page comes from a First Twenty server. Sign in there, or create a demo company, and {name} answers from that company's records.</p>
          <p className="mt-1">{serverLink('Go to Server settings')}</p>
        </Callout>
      )
    case 'finish':
      return (
        <Callout tone="neutral" icon="globe" title={`Finish connecting to ask ${name}`}>
          <p>
            You are signed in to the server, but this browser has not chosen a workspace yet. Upload this browser's workspace, or use the server's copy, and{' '}
            {name} answers from that company's records.
          </p>
          <p className="mt-1">{serverLink('Finish in Server settings')}</p>
        </Callout>
      )
    case 'signed_out':
      return (
        <Callout tone="warn" icon="lock" title="Signed out of your server">
          <p>Sign in to your server again to ask {name}.</p>
          <p className="mt-1">{serverLink('Sign in')}</p>
        </Callout>
      )
    case 'unavailable':
      return (
        <Callout
          tone="bad"
          title={`Cannot ask ${name} right now`}
          action={
            <Button size="sm" icon="rotate-ccw" onClick={() => void assistant.actions.loadInfo()}>
              Retry
            </Button>
          }
        >
          {view.failure.kind === 'offline' ? 'Cannot reach the server. Check the connection, then try again.' : failureText(view.failure, name)}
        </Callout>
      )
    case 'off':
      return (
        <Callout tone="neutral" icon="info" title={`${name} is off on this server`}>
          {name} is not turned on for this server. If you need it, ask whoever runs your server.
        </Callout>
      )
  }
}

// ---------------------------------------------------------------------------------------------
// The conversation
// ---------------------------------------------------------------------------------------------

function Conversation({ name, onAppLink }: { name: string; onAppLink: () => void }) {
  const history = useAssistant((s) => s.history)
  const pending = useAssistant((s) => s.pending)
  const remaining = useAssistant((s) => s.remainingToday)
  const cutOff = useAssistant((s) => s.cutOff)
  const db = useDB((s) => s.db)
  const hold = useSyncStatus((s) => s.hold)
  const turns = useMemo(() => turnsFromHistory(history), [history])
  const suggestions = useMemo(() => suggestionsFor(db), [db])
  const fits = useMemo(() => historyFits(history), [history])
  const end = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  // Follow the answer as it grows, unless the person scrolled up to read something earlier.
  useEffect(() => {
    const scroller = end.current?.closest<HTMLElement>('[data-overlay-body]')
    if (!scroller) return
    const onScroll = () => {
      stick.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [])
  useLayoutEffect(() => {
    const scroller = end.current?.closest<HTMLElement>('[data-overlay-body]')
    if (scroller && stick.current) scroller.scrollTop = scroller.scrollHeight
  }, [turns.length, pending?.text, pending?.status, pending?.phase])

  const ask = (q: string) => {
    void assistant.actions.send(q)
    focusQuestion()
  }
  const empty = turns.length === 0 && !pending
  const canAsk = fits && remaining !== 0

  return (
    <>
      {hold === 'sample' && (
        <p className="text-[13px] text-ink-3">{name} answers from your server's records, not from the sample company this browser shows now.</p>
      )}
      {hold === 'demo_clock' && <p className="text-[13px] text-ink-3">{name} uses today's real date, not the date this app pretends it is.</p>}
      {empty && (
        <div className="ft-assistant__intro flex flex-col gap-3">
          <p className="text-[14.5px] text-ink-2">
            Ask {name} about your people, hiring, time off and the California, San Jose and federal rules First Twenty follows. {name} answers from your
            company's records and drafts postings, emails and notes for you to paste.
          </p>
          <div role="group" aria-label="Suggested questions" className="ft-chips flex flex-wrap gap-2">
            {suggestions.map((q) => (
              <button
                key={q}
                type="button"
                disabled={!canAsk}
                onClick={() => ask(q)}
                className="ft-chip inline-flex min-h-10 max-w-full items-center rounded-full border border-line-strong bg-surface px-3.5 py-1.5 text-left text-[13.5px] font-semibold text-ink-2 transition-colors hover:border-ink-3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
      {!empty && (
        <ol aria-label={`Conversation with ${name}`} className="ft-assistant__log flex flex-col gap-5">
          {turns.map((t, i) =>
            t.role === 'user' ? (
              <UserTurn key={i} text={t.text} />
            ) : (
              <AnswerTurn key={i} name={name} text={t.text} onAppLink={onAppLink}>
                {/* The newest answer stopped at the server's length limit: it says so, so it is never taken as complete. */}
                {cutOff && !pending && i === turns.length - 1 && (
                  <p className="ft-assistant__cutoff mt-2 flex items-start gap-2 text-[13.5px] text-ink-3">
                    <Icon name="info" size={15} className="mt-0.5 shrink-0" />
                    {CUT_OFF_TEXT}
                  </p>
                )}
              </AnswerTurn>
            ),
          )}
          {pending && <PendingTurns pending={pending} name={name} onAppLink={onAppLink} />}
        </ol>
      )}
      <div ref={end} />
    </>
  )
}

function UserTurn({ text }: { text: string }) {
  return (
    <li className="ft-assistant__turn ft-assistant__turn--user ml-auto max-w-[88%] rounded-2xl bg-accent-soft px-3.5 py-2 text-[14.5px] break-words whitespace-pre-wrap text-accent-soft-ink">
      <span className="sr-only">You asked: </span>
      {text}
    </li>
  )
}

function AnswerHead({ name }: { name: string }) {
  return (
    <div className="ft-assistant__who mb-1 flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-3">
      <Icon name="message" size={13} className="shrink-0" />
      {name}
    </div>
  )
}

function AnswerTurn({ name, text, onAppLink, children, busy }: { name: string; text: string; onAppLink: () => void; children?: ReactNode; busy?: boolean }) {
  return (
    <li className="ft-assistant__turn ft-assistant__turn--assistant min-w-0 text-[14.5px] leading-relaxed text-ink" aria-busy={busy || undefined}>
      <AnswerHead name={name} />
      {text.trim() ? <Markdown text={text} onAppLink={onAppLink} /> : !children && <p className="text-ink-3">No answer came back. Ask again, or try other words.</p>}
      {children}
    </li>
  )
}

function PendingTurns({ pending, name, onAppLink }: { pending: Pending; name: string; onAppLink: () => void }) {
  const f = pending.failure
  return (
    <>
      <UserTurn text={pending.message} />
      <AnswerTurn name={name} text={pending.text} onAppLink={onAppLink} busy={pending.phase === 'sending'}>
        {/* While records are looked up, or before the first words; growing text speaks for itself. */}
        {pending.phase === 'sending' && (pending.status || !pending.text) && (
          <p className="ft-assistant__status mt-1 flex items-center gap-2 text-[13.5px] text-ink-3">
            <Icon name={pending.status ? 'search' : 'clock'} size={15} className="shrink-0" />
            {pending.status ?? 'Thinking'}
          </p>
        )}
        {pending.phase === 'stopped' && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13.5px] text-ink-3">
            <span>Stopped. This answer is not part of the conversation.</span>
            <Button size="sm" variant="ghost" icon="rotate-ccw" onClick={retryAnswer}>
              Ask again
            </Button>
          </div>
        )}
        {pending.phase === 'failed' && f && (
          <Callout
            tone="bad"
            className="mt-2"
            title={f.kind === 'bad_history' ? 'This conversation cannot go on' : 'No answer this time'}
            action={
              f.kind === 'bad_history' ? (
                <Button size="sm" icon="plus" onClick={startOver}>
                  New conversation
                </Button>
              ) : (
                canRetry(f) && (
                  <Button size="sm" icon="rotate-ccw" onClick={retryAnswer}>
                    Retry
                  </Button>
                )
              )
            }
          >
            {failureText(f, name)}
          </Callout>
        )}
      </AnswerTurn>
    </>
  )
}

/** Retry and Ask again remove themselves: focus goes to the question box, never to the page. */
function retryAnswer() {
  void assistant.actions.retry()
  focusQuestion()
}

function startOver() {
  assistant.actions.newConversation()
  focusQuestion()
}

// ---------------------------------------------------------------------------------------------
// The question box
// ---------------------------------------------------------------------------------------------

function Composer({ name }: { name: string }) {
  const draft = useAssistant((s) => s.draft)
  const pending = useAssistant((s) => s.pending)
  const remaining = useAssistant((s) => s.remainingToday)
  const history = useAssistant((s) => s.history)
  const sending = pending?.phase === 'sending'
  const fits = useMemo(() => historyFits(history), [history])
  const quotaOut = remaining === 0
  const blocked = quotaOut || !fits
  const over = draft.length > MAX_MESSAGE_LENGTH
  const canSend = !sending && !blocked && !messageProblem(draft)

  // The box takes focus when it appears after the sheet opened (the server's answer came in), unless
  // something else is being typed in.
  useEffect(() => {
    if (!isTextField(document.activeElement)) focusQuestion()
  }, [])

  const submit = () => {
    if (canSend) void assistant.actions.send()
  }

  return (
    <form
      className="ft-assistant__composer w-full"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {blocked && (
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13.5px] font-semibold text-ink-2">
          <Icon name="info" size={15} className="shrink-0 text-ink-3" />
          {/* Why the box takes no question: read first when the box has focus. */}
          <span id={BLOCKED_ID} className="min-w-0 flex-[1_1_14rem]">
            {quotaOut ? failureText({ kind: 'quota' }, name) : conversationFullText(name)}
          </span>
        </div>
      )}
      <label htmlFor={QUESTION_ID} className="sr-only">
        Question for {name}
      </label>
      <div className="flex items-end gap-2">
        <TextArea
          id={QUESTION_ID}
          data-autofocus
          rows={2}
          value={draft}
          readOnly={blocked}
          placeholder={`Ask ${name} a question`}
          aria-describedby={blocked ? `${BLOCKED_ID} ${COUNT_ID} ${NOTICE_ID}` : `${COUNT_ID} ${NOTICE_ID}`}
          aria-invalid={over || undefined}
          onChange={(e) => assistant.actions.setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
            e.preventDefault()
            submit()
          }}
          className="max-h-48 min-h-12 flex-1 resize-y"
        />
        {/* One button that turns into Stop while the answer streams, so focus on it stays put. Its icon is a
            stop square, not the x of the destructive verbs (Remove, Reject) the looks draw in red. */}
        <Button
          type={sending ? 'button' : 'submit'}
          variant={sending ? 'secondary' : 'primary'}
          icon={sending ? 'stop' : 'send'}
          aria-disabled={!sending && !canSend ? true : undefined}
          onClick={sending ? () => assistant.actions.stop() : undefined}
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
        >
          {sending ? 'Stop' : 'Send'}
        </Button>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-3">
        <span id={COUNT_ID} className={cx('num', over && 'font-semibold text-bad')}>
          {draft.length.toLocaleString('en-US')} / {MAX_MESSAGE_LENGTH.toLocaleString('en-US')} characters{over ? '. Shorten it to send it.' : ''}
        </span>
        {remaining !== null && <span>{remainingText(remaining)}</span>}
        <Button size="sm" variant="ghost" icon="plus" onClick={startOver} className="ml-auto">
          New conversation
        </Button>
      </div>
      <p id={NOTICE_ID} className="ft-assistant__notice mt-0.5 text-[12.5px] text-ink-3">
        {name} sends your question and the records it looks up to Anthropic's Claude API.
      </p>
    </form>
  )
}

// ---------------------------------------------------------------------------------------------
// Renaming
// ---------------------------------------------------------------------------------------------

const RENAME_ID = 'assistant-rename'

function RenameForm({ onDone }: { onDone: () => void }) {
  const company = useDB((s) => s.db.company)
  const [value, setValue] = useState(company.assistantName ?? '')
  const error = assistantNameError(value)
  const fallback = defaultAssistantName(company)

  useEffect(() => {
    const el = document.getElementById(RENAME_ID) as HTMLInputElement | null
    el?.focus()
    el?.select()
  }, [])

  const save = () => {
    if (error) {
      document.getElementById(RENAME_ID)?.focus()
      return
    }
    if (renameChanges(company, value)) {
      const label = renameLabel(company, value)
      useDB.getState().mutate(label, (d) => applyAssistantName(d, value, label))
      toast({ text: label, action: { label: 'Undo', onClick: () => void useDB.getState().undo() } })
    }
    onDone()
  }

  return (
    <form
      className="ft-assistant__rename flex flex-col gap-3 rounded-xl border border-line bg-surface-2 p-3.5"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
      onKeyDown={(e) => {
        // Escape closes the rename form only; the sheet stays open.
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        onDone()
      }}
    >
      <Field id={RENAME_ID} label="Assistant name" hint={`Leave it empty to call it ${fallback}.`} error={error ?? undefined}>
        {(id, hint) => <TextInput id={id} aria-describedby={hint} autoComplete="off" placeholder={fallback} value={value} onChange={(e) => setValue(e.target.value)} />}
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" size="sm">
          Save name
        </Button>
        <Button size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------------------------
// Screen reader announcements
// ---------------------------------------------------------------------------------------------

/**
 * Speaks each finished answer once (and notices such as Stopped), never the pieces as they stream. Kept
 * mounted with the sheet; cleared first and set a moment later, so the same words twice are spoken twice.
 */
function LiveRegion({ name }: { name: string }) {
  const announcement = useAssistant((s) => s.announcement)
  const seen = useRef(announcement.id)
  const [said, setSaid] = useState('')
  useEffect(() => {
    if (announcement.id === seen.current) return
    seen.current = announcement.id
    const said = announcement.kind === 'answer' ? `${name} answered: ${markdownToPlainText(announcement.text) || 'no answer came back.'}` : announcement.text
    // What changed with the answer (cut off, the conversation full, no questions left) is said after it.
    const text = announcement.note ? `${said}\n${announcement.note}` : said
    setSaid('')
    const t = setTimeout(() => setSaid(text), 100)
    return () => clearTimeout(t)
  }, [announcement, name])
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {said}
    </div>
  )
}
