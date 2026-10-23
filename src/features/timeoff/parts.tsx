// Small pieces shared by the time off screens.
import { links } from '@/app/router'
import { fullName } from '@/domain/people'
import type { Person, TimeOffRequest } from '@/domain/types'
import { Avatar, Badge, CitationChip, type Tone } from '@/ui'
import type { NoticeState } from './logic'

const STATUS: Record<TimeOffRequest['status'], { tone: Tone; label: string }> = {
  pending: { tone: 'warn', label: 'Pending' },
  approved: { tone: 'good', label: 'Approved' },
  // Red is reserved for statutory deadlines, so a decline is neutral.
  declined: { tone: 'neutral', label: 'Declined' },
  cancelled: { tone: 'outline', label: 'Cancelled' },
}

export function StatusBadge({ status }: { status: TimeOffRequest['status'] }) {
  const s = STATUS[status]
  return (
    <Badge tone={s.tone} icon={status === 'pending' ? 'clock' : status === 'approved' ? 'check' : undefined}>
      {s.label}
    </Badge>
  )
}

export function NoticeBadge({ notice }: { notice: NoticeState }) {
  const tone: Tone = notice.state === 'sent' ? 'good' : notice.state === 'overdue' ? 'bad' : notice.state === 'due_soon' ? 'warn' : 'neutral'
  return (
    <Badge tone={tone} icon={notice.state === 'sent' ? 'check' : notice.state === 'overdue' ? 'alert' : 'clock'}>
      {notice.text}
    </Badge>
  )
}

/** Avatar and name linking to the profile. */
export function PersonName({ person, size = 28, sub }: { person: Person; size?: number; sub?: string }) {
  const name = fullName(person)
  return (
    <a href={links.person(person.id, 'timeoff')} className="group inline-flex min-h-11 min-w-0 items-center gap-2.5 rounded-lg">
      <Avatar name={name} size={size} />
      <span className="min-w-0">
        <span className="block truncate font-semibold text-ink group-hover:text-accent">{name}</span>
        {sub && <span className="block truncate text-[12.5px] text-ink-3">{sub}</span>}
      </span>
    </a>
  )
}

/** Citation plus the "Not legal advice" line that goes wherever a rule is explained. */
export function LegalNote({ label, url, extra }: { label: string; url?: string; extra?: string }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-3">
      <CitationChip label={label} url={url} />
      <span>{extra ? `${extra} ` : ''}Not legal advice; confirm with counsel or your PEO.</span>
    </p>
  )
}

/** Official links used by the leave screens. */
export const LEAVE_LINKS = {
  cfra: { label: 'Gov Code 12945.2', url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=12945.2.&lawCode=GOV' },
  designation: { label: 'CFRA regulations (2 CCR 11091)', url: 'https://calcivilrights.ca.gov/family-medical-pregnancy-leave/' },
  edd: { label: 'EDD disability and paid family leave', url: 'https://edd.ca.gov/en/disability/' },
  sick: { label: 'Labor Code 246', url: 'https://www.dir.ca.gov/dlse/Paid_Sick_Leave.htm' },
  payout: { label: 'Labor Code 227.3', url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=227.3.&lawCode=LAB' },
}
