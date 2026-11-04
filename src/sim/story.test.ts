// The simulator's story: trace lines as plain sentences with names from the workspace, starts and last days
// from the people, situation notes in place of their steps, and routine work folded into a weekly line.
import { describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import type { DB } from '@/domain/types'
import type { TraceLine } from './actions'
import type { SituationNote } from './situations'
import { dayEvents, eventSentence, weekEvent } from './story'

const DAY = '2027-03-03'

/** A workspace with just the records the sentences name. */
function workspace(): DB {
  const db = blankDB({ companyName: 'Quillpine', founderFirstName: 'Avery', founderLastName: 'Quill', founderEmail: 'avery@quillpine.example', foundedOn: '2026-01-05' })
  const founder = db.people[0]
  return {
    ...db,
    people: [
      founder,
      { ...founder, id: 'p-jordan', firstName: 'Jordan', lastName: 'Lee', title: 'Product designer', startDate: '2026-04-06', separation: { type: 'resigned_notice', reason: 'New job', lastDay: DAY } },
      { ...founder, id: 'p-maya', firstName: 'Maya', lastName: 'Chen', title: 'Account executive', startDate: DAY },
      { ...founder, id: 'p-ana', firstName: 'Ana', lastName: 'Ruiz', title: 'Engineer', startDate: '2026-05-04' },
    ] as DB['people'],
    candidates: [{ id: 'c-priya', firstName: 'Priya', lastName: 'Shah' }] as DB['candidates'],
    jobs: [
      { id: 'j-ae', title: 'Account executive' },
      { id: 'j-design', title: 'Product designer', isBackfill: true, backfillForPersonId: 'p-jordan' },
    ] as DB['jobs'],
    offers: [{ id: 'o-priya', candidateId: 'c-priya', jobId: 'j-ae', startDate: '2027-03-15' }] as DB['offers'],
    leaveCases: [{ id: 'lc-ana', personId: 'p-ana' }] as DB['leaveCases'],
  }
}

function line(action: TraceLine['action'], args: unknown, extra: Partial<TraceLine> = {}): TraceLine {
  return { day: DAY, time: '13:30', actor: 'p-founder', viewingAs: 'admin', action, args, created: [], ...extra }
}

const texts = (lines: TraceLine[], notes: SituationNote[] = []) => dayEvents(DAY, lines, workspace(), notes).map(eventSentence)

describe('dayEvents', () => {
  it('tells who started and whose last day it is, from the people', () => {
    expect(texts([])).toEqual(['Mar 3: Maya Chen started as Account executive.', 'Mar 3: Last day for Jordan Lee.'])
  })

  it('names the candidate and the job of an offer, and the start date with its year when it is another', () => {
    const db = workspace()
    const [accepted] = dayEvents(DAY, [line('markAccepted', { offerId: 'o-priya' })], { ...db, people: [db.people[0]] })
    expect(accepted).toEqual({ day: DAY, kind: 'offer_accepted', importance: 1, area: 'hiring', text: 'Priya Shah accepted the offer for Account executive, starting Mon, Mar 15.' })
    expect(eventSentence(accepted)).toBe('Mar 3: Priya Shah accepted the offer for Account executive, starting Mon, Mar 15.')
    const late = { ...db, people: [db.people[0]], offers: [{ ...db.offers[0], startDate: '2028-01-03' }] }
    expect(dayEvents(DAY, [line('markAccepted', { offerId: 'o-priya' })], late)[0].text).toBe('Priya Shah accepted the offer for Account executive, starting Mon, Jan 3, 2028.')
  })

  it('says how a person leaves, with the reason and last day', () => {
    const lines = [
      line('offboardPerson', { personId: 'p-jordan', type: 'resigned_notice', reason: 'New job', lastDay: '2027-03-12' }),
      line('offboardPerson', { personId: 'p-ana', type: 'laid_off', reason: 'Reduction in force', lastDay: DAY }),
    ]
    expect(texts(lines).slice(2)).toEqual(['Mar 3: Jordan Lee resigned (New job), last day Fri, Mar 12.', 'Mar 3: Ana Ruiz was laid off (Reduction in force), last day Wed, Mar 3.'])
  })

  it('tells hiring, leave, pay and reporting changes, each with its importance and area', () => {
    const events = dayEvents(
      DAY,
      [
        line('markDeclined', { offerId: 'o-priya', reason: 'chose_other_offer' }),
        line('openBackfill', { personId: 'p-jordan' }, { created: ['j-design'] }),
        line('startLeave', { personId: 'p-ana', kind: 'cfra', startDate: '2027-03-08', expectedReturn: '2027-04-19' }),
        line('markReturned', { leaveId: 'lc-ana' }),
        line('changeJobOrPay', { personId: 'p-ana', change: { reason: 'merit', salary: 124800, effectiveOn: '2027-03-16' } }),
        line('changeJobOrPay', { personId: 'p-ana', change: { reason: 'manager_change', managerId: 'p-maya', effectiveOn: DAY } }),
        line('markPayRunSubmitted', { start: '2027-03-01', end: '2027-03-15', payday: '2027-03-20' }),
      ],
      workspace(),
    )
    expect(events.filter((e) => e.kind !== 'started' && e.kind !== 'last_day').map((e) => [e.importance, e.area, e.text])).toEqual([
      [1, 'hiring', 'Priya Shah declined the offer for Account executive (chose another offer).'],
      [1, 'hiring', 'Opened a backfill for Jordan Lee: the Product designer job.'],
      [1, 'people', 'Ana Ruiz goes on CFRA leave from Mon, Mar 8, back Mon, Apr 19.'],
      [1, 'people', 'Ana Ruiz is back from leave.'],
      [2, 'pay', 'Raise for Ana Ruiz to $124,800 a year from Tue, Mar 16 (merit, on their work anniversary).'],
      [2, 'people', 'Ana Ruiz reports to Maya Chen from Wed, Mar 3.'],
      [2, 'pay', 'Pay run for Mar 1 to Mar 15 submitted, payday Sat, Mar 20.'],
    ])
  })

  it('tells a situation by its note, not again by the steps it took at 08:20', () => {
    const note: SituationNote = { day: DAY, situationId: 'quit-1', kind: 'quit', skipped: false, text: 'Jordan Lee resigned (New job), last day Fri, Mar 12. Backfill opened.' }
    const steps = [line('offboardPerson', { personId: 'p-jordan', type: 'resigned_notice', reason: 'New job', lastDay: '2027-03-12' }, { time: '08:20' })]
    const events = dayEvents(DAY, steps, workspace(), [note])
    expect(events.map((e) => [e.kind, e.text])).toEqual([
      ['started', 'Maya Chen started as Account executive.'],
      ['last_day', 'Last day for Jordan Lee.'],
      ['situation', note.text],
    ])
    expect(events[2].situationId).toBe('quit-1')
    expect(dayEvents(DAY, [], workspace(), [{ ...note, skipped: true }])[2].kind).toBe('situation_skipped')
  })

  it('leaves routine work out of the day', () => {
    const routine = [line('openApp', {}), line('addCandidate', { candidate: {}, jobId: 'j-ae' }), line('scheduleInterview', {}), line('setTaskStatus', {})]
    expect(texts(routine)).toEqual(texts([]))
  })
})

describe('weekEvent', () => {
  it('folds the routine of the seven days ending on a Sunday into one line', () => {
    const sunday = '2027-03-07'
    const lines = [
      line('addCandidate', {}, { day: '2027-03-01' }),
      line('addCandidate', {}, { day: '2027-03-05' }),
      line('scheduleInterview', {}, { day: '2027-03-02' }),
      line('rejectApplication', { reason: 'skills_gap' }, { day: '2027-03-04' }),
      line('rejectApplication', { reason: 'withdrew', withdraw: true }, { day: '2027-03-04' }),
      line('requestTimeOff', {}, { day: '2027-03-05' }),
      line('addCandidate', {}, { day: '2027-02-28' }),
    ]
    expect(weekEvent(sunday, lines)).toEqual({
      day: sunday,
      kind: 'week',
      importance: 2,
      area: 'routine',
      text: 'This week: 2 applications, 1 interview, 1 rejection, 1 withdrawal, 1 time off request.',
    })
    expect(weekEvent(sunday, [line('openApp', {}, { day: '2027-03-02' })])).toBeNull()
  })
})
