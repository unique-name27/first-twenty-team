import { produce } from 'immer'
import { describe, expect, it, vi } from 'vitest'
import { fixtureDB, FRI } from './testkit'
import { interviewCancelMessage } from './messages'
import {
  cancelInterview,
  formatDual,
  interviewCancelICS,
  interviewICS,
  proposeTimes,
  rescheduleInterview,
  schedulingMessage,
  scheduleInterview,
  setInterviewStatus,
  zoneLabel,
} from './scheduling'

vi.mock('@/data/seed', async () => {
  const { blankDB } = await import('@/data/blank')
  return { SAMPLE_ANCHOR: '2026-10-09', buildSampleDB: () => blankDB({ companyName: 'Fixture', founderFirstName: 'F', founderLastName: 'F' }) }
})

describe('proposeTimes', () => {
  it('proposes 10:00, 1:00 and 3:30 Pacific on the next business days (PDT)', () => {
    expect(proposeTimes('2026-10-09')).toEqual([
      '2026-10-12T17:00:00.000Z', // Mon 10:00 AM PDT
      '2026-10-13T20:00:00.000Z', // Tue 1:00 PM PDT
      '2026-10-14T22:30:00.000Z', // Wed 3:30 PM PDT
    ])
  })

  it('switches to PST after daylight saving time ends on Nov 1, 2026', () => {
    expect(proposeTimes('2026-10-30')).toEqual(['2026-11-02T18:00:00.000Z', '2026-11-03T21:00:00.000Z', '2026-11-04T23:30:00.000Z'])
  })

  it('crosses the March 2026 change correctly', () => {
    expect(proposeTimes('2026-03-05')).toEqual([
      '2026-03-06T18:00:00.000Z', // Fri 10:00 AM PST
      '2026-03-09T20:00:00.000Z', // Mon 1:00 PM PDT
      '2026-03-10T22:30:00.000Z', // Tue 3:30 PM PDT
    ])
  })

  it('skips company holidays and supports more slots', () => {
    const times = proposeTimes('2026-11-25', [{ date: '2026-11-26' }, { date: '2026-11-27' }], 4)
    expect(times).toEqual(['2026-11-30T18:00:00.000Z', '2026-12-01T21:00:00.000Z', '2026-12-02T23:30:00.000Z', '2026-12-03T18:00:00.000Z'])
  })
})

describe('formatDual', () => {
  it('shows Pacific and the candidate zone side by side', () => {
    expect(formatDual('2026-10-13T17:00:00.000Z', 'America/New_York')).toBe('Tue, Oct 13, 10:00 AM PT (1:00 PM ET)')
    expect(formatDual('2026-11-03T21:00:00.000Z', 'America/Chicago')).toBe('Tue, Nov 3, 1:00 PM PT (3:00 PM CT)')
    expect(formatDual('2026-10-13T17:00:00.000Z', 'America/Denver')).toBe('Tue, Oct 13, 10:00 AM PT (11:00 AM MT)')
  })

  it('leaves the second zone off for Pacific or unknown candidates', () => {
    expect(formatDual('2026-10-13T17:00:00.000Z', 'America/Los_Angeles')).toBe('Tue, Oct 13, 10:00 AM PT')
    expect(formatDual('2026-10-13T17:00:00.000Z')).toBe('Tue, Oct 13, 10:00 AM PT')
    expect(formatDual('2026-10-13T17:00:00.000Z', 'Not/AZone')).toBe('Tue, Oct 13, 10:00 AM PT')
  })

  it('shows the candidate date when it differs', () => {
    const s = formatDual('2026-10-13T22:30:00.000Z', 'Asia/Kolkata')
    expect(s.startsWith('Tue, Oct 13, 3:30 PM PT (Wed, Oct 14, 4:00 AM ')).toBe(true)
  })

  it('labels non-US zones with what Intl reports', () => {
    expect(zoneLabel('America/New_York', '2026-10-13T17:00:00.000Z')).toBe('ET')
    expect(zoneLabel('Asia/Kolkata', '2026-10-13T17:00:00.000Z')).toMatch(/GMT\+5:30|IST/)
  })
})

describe('scheduleInterview', () => {
  it('creates the interview, owed scorecards due 24 hours after the end, and a debrief next step', () => {
    let id = ''
    const db = produce(fixtureDB(), (d) => {
      id = scheduleInterview(
        d,
        {
          applicationId: 'a-alex',
          stageId: 'onsite',
          name: 'Onsite',
          startsAt: '2026-10-13T17:00:00.000Z',
          durationMin: 60,
          interviewerIds: ['p-tomas', 'p-priya', 'p-tomas'],
          format: 'onsite',
          attributes: ['System design', { name: 'Security mindset' }],
        },
        { date: '2026-10-09' },
      )
    })
    const interview = db.interviews.find((i) => i.id === id)
    expect(interview?.interviewerIds).toEqual(['p-tomas', 'p-priya'])
    expect(interview?.attributes).toEqual(['System design', 'Security mindset'])
    const cards = db.scorecards.filter((s) => s.interviewId === id)
    expect(cards).toHaveLength(2)
    expect(cards.every((c) => c.dueAt === '2026-10-14T18:00:00.000Z')).toBe(true)
    const app = db.applications.find((a) => a.id === 'a-alex')
    expect(app?.nextStep).toEqual({ text: 'Debrief and decide', dueOn: '2026-10-14', ownerId: 'p-tomas' })
    expect(app?.lastContactOn).toBe('2026-10-09')
    expect(db.activity.at(-1)?.text).toBe('Scheduled onsite with Alex Kim for Tue, Oct 13, 10:00 AM PT')
  })

  it('cancels and marks no-shows, dropping owed scorecards', () => {
    let id = ''
    const base = produce(fixtureDB(), (d) => {
      id = scheduleInterview(
        d,
        { applicationId: 'a-ben', stageId: 'intro', name: 'Intro call', startsAt: '2026-10-13T20:00:00.000Z', durationMin: 30, interviewerIds: ['p-tomas'], format: 'video', attributes: [] },
        { date: '2026-10-09' },
      )
    })
    const cancelled = produce(base, (d) => {
      expect(cancelInterview(d, id, { date: '2026-10-10' })).toBe(true)
    })
    expect(cancelled.interviews.find((i) => i.id === id)?.status).toBe('cancelled')
    expect(cancelled.scorecards.some((s) => s.interviewId === id)).toBe(false)
    const noShow = produce(base, (d) => {
      setInterviewStatus(d, id, 'no_show', { date: '2026-10-13' })
    })
    expect(noShow.scorecards.some((s) => s.interviewId === id)).toBe(false)
    expect(noShow.activity.at(-1)?.text).toBe('Ben Ortiz missed the intro call')
  })
})

describe('cancelInterview and rescheduleInterview', () => {
  const intro = { applicationId: 'a-ben', stageId: 'intro', name: 'Intro call', startsAt: '2026-10-13T20:00:00.000Z', durationMin: 30, interviewerIds: ['p-tomas'], format: 'video' as const, attributes: [] }
  const scheduled = () => {
    let id = ''
    const db = produce(fixtureDB(), (d) => {
      id = scheduleInterview(d, intro, { date: FRI })
    })
    return { db, id }
  }
  const nextStep = (db: { applications: Array<{ id: string; nextStep?: unknown }> }) => db.applications.find((a) => a.id === 'a-ben')?.nextStep

  it('hands the next step back to scheduling the stage, due the next business day, with the same owner', () => {
    const { db, id } = scheduled()
    expect(nextStep(db)).toEqual({ text: 'Debrief and decide', dueOn: '2026-10-14', ownerId: 'p-tomas' })
    const after = produce(db, (d) => {
      expect(cancelInterview(d, id, { date: '2026-10-12' })).toBe(true)
    })
    expect(nextStep(after)).toEqual({ text: 'Schedule intro call', dueOn: '2026-10-13', ownerId: 'p-tomas' })
    expect(after.activity.at(-1)?.text).toBe('Cancelled intro call with Ben Ortiz')
    // Friday: due Monday, not Saturday.
    expect(nextStep(produce(db, (d) => void cancelInterview(d, id, { date: FRI })))).toMatchObject({ dueOn: '2026-10-12' })
  })

  it('keeps the debrief while another interview for the stage is still on, and a next step written by hand', () => {
    const { db, id } = scheduled()
    const twoRounds = produce(db, (d) => {
      scheduleInterview(d, { ...intro, name: 'Second intro', startsAt: '2026-10-15T17:00:00.000Z' }, { date: FRI })
      cancelInterview(d, id, { date: '2026-10-12' })
    })
    expect(nextStep(twoRounds)).toMatchObject({ text: 'Debrief and decide', dueOn: '2026-10-16' })
    const byHand = produce(db, (d) => {
      const app = d.applications.find((a) => a.id === 'a-ben')
      if (app) app.nextStep = { text: 'Call her reference first', dueOn: '2026-10-20', ownerId: 'p-priya' }
      cancelInterview(d, id, { date: '2026-10-12' })
    })
    expect(nextStep(byHand)).toEqual({ text: 'Call her reference first', dueOn: '2026-10-20', ownerId: 'p-priya' })
  })

  it('leaves the next step alone when the cancelled interview was for another stage', () => {
    let id = ''
    const db = produce(fixtureDB(), (d) => {
      id = scheduleInterview(d, { ...intro, stageId: 'onsite', name: 'Onsite' }, { date: FRI })
      cancelInterview(d, id, { date: '2026-10-12' })
    })
    expect(nextStep(db)).toEqual({ text: 'Review application', dueOn: '2026-10-20', ownerId: 'p-tomas' })
  })

  it('moves an interview in one change: the old one cancelled with its owed scorecards, the new one scheduled', () => {
    const { db, id } = scheduled()
    let newId: string | null = null
    const moved = produce(db, (d) => {
      newId = rescheduleInterview(d, id, { ...intro, startsAt: '2026-10-15T17:00:00.000Z', interviewerIds: ['p-priya'] }, { date: '2026-10-12' })
    })
    expect(newId).toBeTruthy()
    expect(newId).not.toBe(id)
    expect(moved.interviews.find((i) => i.id === id)?.status).toBe('cancelled')
    expect(moved.interviews.find((i) => i.id === newId)).toMatchObject({ status: 'scheduled', startsAt: '2026-10-15T17:00:00.000Z', name: 'Intro call' })
    expect(moved.scorecards.filter((s) => s.interviewId === id)).toHaveLength(0)
    expect(moved.scorecards.filter((s) => s.interviewId === newId).map((s) => s.interviewerId)).toEqual(['p-priya'])
    expect(nextStep(moved)).toEqual({ text: 'Debrief and decide', dueOn: '2026-10-16', ownerId: 'p-tomas' })
    expect(moved.activity.at(-1)?.text).toBe('Moved intro call with Ben Ortiz from Tue, Oct 13, 1:00 PM PT to Thu, Oct 15, 10:00 AM PT')
    expect(moved.activity.length).toBe(db.activity.length + 1)
    // Only a scheduled interview of the same application can move.
    produce(moved, (d) => {
      expect(rescheduleInterview(d, id, intro, { date: '2026-10-12' })).toBeNull()
      expect(rescheduleInterview(d, newId ?? '', { ...intro, applicationId: 'a-alex' }, { date: '2026-10-12' })).toBeNull()
    })
  })

  it('builds cancellation calendar files with the invite UID, one SEQUENCE higher, and a note for the candidate', () => {
    let id = ''
    const db = produce(fixtureDB(), (d) => {
      id = scheduleInterview(d, { ...intro, applicationId: 'a-alex', videoLink: 'https://meet.example.com/ledgerlark' }, { date: FRI })
      cancelInterview(d, id, { date: '2026-10-12' })
    })
    const unfold = (x: string | null) => (x ?? '').replace(/\r\n /g, '')
    const invite = unfold(interviewICS(db, id, 'candidate'))
    const cancel = unfold(interviewCancelICS(db, id, 'candidate'))
    const uid = invite.match(/UID:(.+)\r\n/)?.[1]
    expect(uid).toBe(`${id}-candidate@first-twenty`)
    expect(cancel).toContain(`UID:${uid}\r\n`)
    expect(cancel).toContain('METHOD:CANCEL\r\n')
    expect(cancel).toContain('SEQUENCE:1\r\n')
    expect(cancel).toContain('STATUS:CANCELLED\r\n')
    expect(cancel).toContain('SUMMARY:Cancelled: Ledgerlark: Intro call for Senior full-stack engineer')
    expect(cancel).toContain('DTSTART:20261013T200000Z')
    expect(cancel).not.toContain('meet.example.com')
    expect(unfold(interviewCancelICS(db, id, 'panel'))).toContain(`UID:${id}-panel@first-twenty`)
    expect(interviewCancelICS(db, 'nope')).toBeNull()

    const note = interviewCancelMessage(db, id, { senderId: 'p-tomas' })
    expect(note?.to).toBe('alex.kim@example.com')
    expect(note?.subject).toBe('Cancelled: Intro call with Ledgerlark, Tue, Oct 13')
    expect(note?.body).toContain('Hi Alex,')
    expect(note?.body).toContain('The intro call with Ledgerlark on Tue, Oct 13, 1:00 PM PT (4:00 PM ET) is cancelled')
    expect(note?.body).toContain('Tomas Herrera')
    expect(note?.mailto.startsWith('mailto:alex.kim@example.com?subject=')).toBe(true)
    expect(interviewCancelMessage(db, 'nope')).toBeNull()
  })
})

describe('schedulingMessage and ICS', () => {
  it('fills the screen invite with dual-zone times and a mailto link', () => {
    const db = fixtureDB()
    const times = proposeTimes('2026-10-09')
    const msg = schedulingMessage(db, 'a-ben', times, { senderId: 'p-founder' })
    expect(msg?.subject).toBe('Intro call for Senior full-stack engineer at Ledgerlark')
    expect(msg?.body).toContain('Hi Ben,')
    expect(msg?.body).toContain('- Mon, Oct 12, 10:00 AM PT')
    expect(msg?.body).toContain('Maya Raman')
    expect(msg?.mailto.startsWith('mailto:ben.ortiz@example.com?subject=')).toBe(true)
  })

  it('shows the candidate zone and offers Calendly as an alternative', () => {
    const db = fixtureDB()
    const msg = schedulingMessage(db, 'a-alex', ['2026-10-13T17:00:00.000Z'], { senderId: 'p-tomas', calendly: 'https://calendly.com/ledgerlark/onsite' })
    expect(msg?.subject).toBe('Next step: onsite for Senior full-stack engineer')
    expect(msg?.body).toContain('- Tue, Oct 13, 10:00 AM PT (1:00 PM ET)')
    expect(msg?.body).toContain('Or pick another time here: https://calendly.com/ledgerlark/onsite')
  })

  it('uses only the Calendly link when no times are given, and a generic note for technical', () => {
    const db = produce(fixtureDB(), (d) => {
      const app = d.applications.find((a) => a.id === 'a-chen')
      if (app) app.stageId = 'technical'
    })
    const msg = schedulingMessage(db, 'a-chen', [], { senderId: 'p-tomas', calendly: 'https://cal.example/x', durationMin: 90 })
    expect(msg?.subject).toBe('Next step: technical for Senior full-stack engineer at Ledgerlark')
    expect(msg?.body).toContain('a 90-minute technical')
    expect(msg?.body).toContain('Pick any time that works for you here: https://cal.example/x')
  })

  it('builds candidate and panel calendar files', () => {
    let id = ''
    const db = produce(fixtureDB(), (d) => {
      id = scheduleInterview(
        d,
        { applicationId: 'a-alex', stageId: 'onsite', name: 'Onsite', startsAt: '2026-10-13T17:00:00.000Z', durationMin: 90, interviewerIds: ['p-tomas'], format: 'onsite', attributes: ['System design'] },
        { date: '2026-10-09' },
      )
    })
    const unfold = (x: string | null) => (x ?? '').replace(/\r\n /g, '')
    const panel = unfold(interviewICS(db, id, 'panel'))
    expect(panel).toContain('DTSTART:20261013T170000Z')
    expect(panel).toContain('DTEND:20261013T183000Z')
    expect(panel).toContain('SUMMARY:Onsite: Alex Kim (Senior full-stack engineer)')
    expect(panel).toContain('Scorecard attributes: System design')
    const cand = unfold(interviewICS(db, id, 'candidate'))
    expect(cand).toContain('SUMMARY:Ledgerlark: Onsite for Senior full-stack engineer')
    expect(cand).toContain('Tomas Herrera (Founding engineer)')
    expect(cand).toContain('99 S Almaden Blvd')
    expect(interviewICS(db, 'nope')).toBeNull()
  })

  it('puts the video link in the calendar file, and never points to a link that does not exist', () => {
    const unfold = (x: string | null) => (x ?? '').replace(/\r\n /g, '')
    const input = { applicationId: 'a-alex', stageId: 'intro', name: 'Intro call', startsAt: '2026-10-13T17:00:00.000Z', durationMin: 30, interviewerIds: ['p-tomas'], format: 'video' as const, attributes: [] }
    let withLink = ''
    let without = ''
    let phone = ''
    const db = produce(fixtureDB(), (d) => {
      withLink = scheduleInterview(d, { ...input, videoLink: ' https://meet.example.com/ledgerlark ' }, { date: FRI })
      without = scheduleInterview(d, { ...input, videoLink: '' }, { date: FRI })
      phone = scheduleInterview(d, { ...input, format: 'phone', videoLink: 'https://meet.example.com/x' }, { date: FRI })
    })
    expect(db.interviews.find((i) => i.id === withLink)?.videoLink).toBe('https://meet.example.com/ledgerlark')
    expect(db.interviews.find((i) => i.id === without)?.videoLink).toBeUndefined()
    expect(db.interviews.find((i) => i.id === phone)?.videoLink).toBeUndefined() // kept for video only
    const linked = unfold(interviewICS(db, withLink, 'candidate'))
    expect(linked).toContain('LOCATION:https://meet.example.com/ledgerlark')
    expect(linked).toContain('URL:https://meet.example.com/ledgerlark')
    expect(linked).toContain('Join the video call: https://meet.example.com/ledgerlark')
    const bare = unfold(interviewICS(db, without, 'candidate'))
    expect(bare).toContain('LOCATION:Video call\r\n')
    expect(bare).not.toContain('URL:')
    expect(bare).not.toMatch(/link in the invite/i)
  })

  it('leaves people without a work email off the attendee list', () => {
    let id = ''
    const db = produce(fixtureDB(), (d) => {
      const tomas = d.people.find((p) => p.id === 'p-tomas')
      if (tomas) tomas.workEmail = ''
      id = scheduleInterview(
        d,
        { applicationId: 'a-alex', stageId: 'intro', name: 'Intro call', startsAt: '2026-10-13T17:00:00.000Z', durationMin: 30, interviewerIds: ['p-tomas', 'p-priya'], format: 'video', attributes: [] },
        { date: FRI },
      )
    })
    const ics = (interviewICS(db, id, 'candidate') ?? '').replace(/\r\n /g, '')
    expect(ics).toContain('ATTENDEE;CN=Alex Kim;RSVP=TRUE:mailto:alex.kim@example.com')
    expect(ics).toContain('ATTENDEE;CN=Priya Nair;RSVP=TRUE:mailto:priya@ledgerlark.com')
    expect(ics).not.toContain('CN=Tomas Herrera')
    expect(ics).not.toMatch(/mailto:\r\n/)
  })

  it('keeps the candidate off the attendee list of the panel copy and its cancellation', () => {
    let id = ''
    const db = produce(fixtureDB(), (d) => {
      id = scheduleInterview(
        d,
        { applicationId: 'a-alex', stageId: 'intro', name: 'Intro call', startsAt: '2026-10-13T17:00:00.000Z', durationMin: 30, interviewerIds: ['p-tomas', 'p-priya'], format: 'video', attributes: ['Communication'] },
        { date: FRI },
      )
    })
    const unfold = (x: string | null) => (x ?? '').replace(/\r\n /g, '')
    const panel = unfold(interviewICS(db, id, 'panel'))
    expect(panel).toContain('SUMMARY:Intro call: Alex Kim (Senior full-stack engineer)')
    expect(panel).toContain('Scorecard attributes: Communication')
    expect(panel).toContain('ATTENDEE;CN=Tomas Herrera;RSVP=TRUE:mailto:tomas@ledgerlark.com')
    expect(panel).toContain('ATTENDEE;CN=Priya Nair;RSVP=TRUE:mailto:priya@ledgerlark.com')
    expect(panel).not.toContain('alex.kim@example.com')
    expect(panel).not.toContain('CN=Alex Kim')
    const cancelled = produce(db, (d) => {
      cancelInterview(d, id, { date: FRI })
    })
    expect(unfold(interviewCancelICS(cancelled, id, 'panel'))).not.toContain('alex.kim@example.com')
    // The candidate's own copies still invite them.
    expect(unfold(interviewICS(db, id, 'candidate'))).toContain('ATTENDEE;CN=Alex Kim;RSVP=TRUE:mailto:alex.kim@example.com')
    expect(unfold(interviewCancelICS(cancelled, id, 'candidate'))).toContain('mailto:alex.kim@example.com')
  })
})
