import { describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import {
  checklistProgress,
  contextFor,
  dueDate,
  dueLabel,
  dueRuleText,
  fileBy,
  generateChecklist,
  holidayDates,
  openTasks,
  rehireDaysAway,
  type TaskContext,
  taskApplies,
  taskDueOn,
  taskFileBy,
} from '@/domain/checklists/generate'
import { DEFAULT_CHECKLIST_TEMPLATES } from '@/domain/checklists/templates'
import type { Checklist, Contractor, DB, Person } from '@/domain/types'

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

function baseDB(): DB {
  const db = blankDB({ companyName: 'Ledgerlark', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2025-02-03' })
  db.company.website = 'https://www.ledgerlark.com'
  return db
}

function addPerson(db: DB, id: string, over: Partial<Person> = {}): Person {
  const p: Person = {
    id,
    firstName: id.slice(2, 3).toUpperCase() + id.slice(3),
    lastName: 'Tester',
    workEmail: `${id.slice(2)}@ledgerlark.com`,
    title: 'Software engineer',
    departmentId: 'd-eng',
    familyId: 'f-eng',
    levelId: 'lv-l2',
    managerId: 'p-founder',
    locationId: 'loc-hq',
    workMode: 'hybrid',
    homeCity: 'San Jose',
    homeState: 'CA',
    employmentType: 'full_time',
    hoursPerWeek: 40,
    flsa: 'exempt',
    startDate: '2025-06-01',
    hireNumber: db.people.length + 1,
    emergencyContacts: [],
    ...over,
  }
  db.people.push(p)
  return p
}

function contractor(id: string): Contractor {
  return {
    id,
    kind: 'contractor',
    name: 'Casey Contractor',
    entityType: 'individual',
    email: 'casey@example.com',
    scope: 'Design',
    rate: 90,
    rateUnit: 'hour',
    startOn: '2026-01-01',
    managerId: 'p-founder',
    departmentId: 'd-product',
    state: 'CA',
    ab5: { exemption: 'professional_services', a: true, b: true, c: true },
    w9OnFile: true,
  }
}

const START = '2026-10-19' // Monday

function onboarding(db: DB, person: Person): Checklist {
  return generateChecklist(db, { person, templateId: 'tpl-onboarding', anchorDate: person.startDate, createdOn: '2026-10-01', id: 'ck-test' })
}

function task(cl: Checklist, templateTaskId: string) {
  return cl.tasks.find((t) => t.templateTaskId === templateTaskId)
}

function ids(cl: Checklist): string[] {
  return cl.tasks.map((t) => t.templateTaskId ?? '')
}

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

describe('dueDate', () => {
  const holidays = holidayDates(baseDB())

  it('counts business days from a Monday start (I-9 section 2 due Thursday)', () => {
    expect(dueDate({ anchor: 'start', offset: 3, unit: 'business_days' }, START, holidays)).toBe('2026-10-22')
  })

  it('skips weekends', () => {
    expect(dueDate({ anchor: 'start', offset: 3, unit: 'business_days' }, '2026-10-22', holidays)).toBe('2026-10-27')
  })

  it('skips company holidays', () => {
    expect(dueDate({ anchor: 'start', offset: 3, unit: 'business_days' }, START, ['2026-10-21'])).toBe('2026-10-23')
    // Thanksgiving Thu Nov 26 and Fri Nov 27 are company holidays
    expect(dueDate({ anchor: 'start', offset: 1, unit: 'business_days' }, '2026-11-25', holidays)).toBe('2026-11-30')
  })

  it('counts business days backwards for pre-start tasks', () => {
    expect(dueDate({ anchor: 'start', offset: -6, unit: 'business_days' }, '2026-10-26', holidays)).toBe('2026-10-16')
    expect(dueDate({ anchor: 'start', offset: -1, unit: 'business_days' }, '2026-10-26', holidays)).toBe('2026-10-23')
  })

  it('adds calendar days and months', () => {
    expect(dueDate({ anchor: 'start', offset: 20, unit: 'days' }, START, holidays)).toBe('2026-11-08')
    expect(dueDate({ anchor: 'start', offset: 6, unit: 'months' }, START, holidays)).toBe('2027-04-19')
    expect(dueDate({ anchor: 'start', offset: 6, unit: 'months' }, '2026-08-31', holidays)).toBe('2027-02-28')
  })
})

describe('taskDueOn', () => {
  const holidays = holidayDates(baseDB())

  it('keeps statutory deadlines on their legal date even on a weekend', () => {
    expect(taskDueOn({ due: { anchor: 'start', offset: 20, unit: 'days' }, statutory: true }, START, holidays)).toBe('2026-11-08')
  })

  it('moves other weekend or holiday dates to the next business day', () => {
    // Oct 19 + 90 = Sun Jan 17, 2027; Mon Jan 18 is MLK Day, so Tue Jan 19
    expect(taskDueOn({ due: { anchor: 'start', offset: 90, unit: 'days' }, statutory: false }, START, holidays)).toBe('2027-01-19')
  })

  it('never moves the anchor date itself', () => {
    expect(taskDueOn({ due: { anchor: 'last_day', offset: 0, unit: 'days' }, statutory: false }, '2026-10-31', holidays)).toBe('2026-10-31')
  })
})

describe('fileBy and dueLabel', () => {
  const holidays = holidayDates(baseDB())

  it('gives the previous business day for weekend deadlines', () => {
    expect(fileBy('2026-11-08', holidays)).toBe('2026-11-06')
    expect(fileBy('2026-11-06', holidays)).toBeNull()
  })

  it('skips holidays when stepping back', () => {
    expect(fileBy('2026-11-26', holidays)).toBe('2026-11-25')
    expect(fileBy('2026-11-28', holidays)).toBe('2026-11-25')
  })

  it('reads like the spec', () => {
    expect(dueLabel('2026-11-15', holidays)).toBe('due Sun Nov 15, file by Fri Nov 13')
    expect(dueLabel('2026-10-26', holidays)).toBe('due Mon Oct 26')
  })
})

describe('dueRuleText', () => {
  it('describes each unit', () => {
    expect(dueRuleText({ anchor: 'start', offset: 3, unit: 'business_days' })).toBe('Start + 3 business days')
    expect(dueRuleText({ anchor: 'start', offset: 20, unit: 'days' })).toBe('20 days after start')
    expect(dueRuleText({ anchor: 'start', offset: 6, unit: 'months' })).toBe('6 months after start')
    expect(dueRuleText({ anchor: 'last_day', offset: 0, unit: 'days' })).toBe('Last day')
    expect(dueRuleText({ anchor: 'start', offset: -1, unit: 'business_days' })).toBe('1 business day before start')
    expect(dueRuleText({ anchor: 'created', offset: 5, unit: 'business_days' })).toBe('Request + 5 business days')
  })
})

// ---------------------------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------------------------

describe('taskApplies', () => {
  const ctx: TaskContext = {
    headcount: 4,
    workforce: 5,
    supervisor: false,
    flsa: 'non_exempt',
    remote: false,
    outsideCA: false,
    hasEquity: true,
    earlyExercise: false,
    employmentType: 'full_time',
    backgroundCheck: true,
  }

  it('applies with no condition', () => {
    expect(taskApplies(undefined, ctx)).toBe(true)
  })

  it('checks headcount thresholds both ways', () => {
    expect(taskApplies({ minHeadcount: 5 }, ctx)).toBe(false)
    expect(taskApplies({ belowHeadcount: 5 }, ctx)).toBe(true)
    expect(taskApplies({ minWorkforce: 5 }, ctx)).toBe(true)
  })

  it('needs every set condition to match', () => {
    expect(taskApplies({ flsa: 'non_exempt', hasEquity: true }, ctx)).toBe(true)
    expect(taskApplies({ flsa: 'non_exempt', supervisor: true }, ctx)).toBe(false)
    expect(taskApplies({ outsideCA: false, remote: false }, ctx)).toBe(true)
    expect(taskApplies({ earlyExercise: true }, ctx)).toBe(false)
  })

  it('matches separation types and leave kinds only when known', () => {
    expect(taskApplies({ separationTypes: ['terminated'] }, ctx)).toBe(false)
    expect(taskApplies({ separationTypes: ['terminated'] }, { ...ctx, separationType: 'terminated' })).toBe(true)
    expect(taskApplies({ leaveKinds: ['bonding'] }, ctx)).toBe(false)
    expect(taskApplies({ leaveKinds: ['bonding'] }, { ...ctx, leaveKind: 'bonding' })).toBe(true)
  })
})

describe('contextFor', () => {
  it('counts contractors in the workforce but not in headcount', () => {
    const db = baseDB()
    const p = addPerson(db, 'p-lucas', { startDate: START })
    db.contractors.push(contractor('k-casey'))
    const ctx = contextFor(db, p, START)
    expect(ctx.headcount).toBe(2)
    expect(ctx.workforce).toBe(3)
  })

  it('detects supervisors, equity and out-of-state work', () => {
    const db = baseDB()
    const p = addPerson(db, 'p-elena', { homeState: 'CO', workMode: 'remote' })
    addPerson(db, 'p-chris', { managerId: 'p-elena' })
    db.grants.push({
      id: 'g-1',
      personId: 'p-elena',
      holderType: 'employee',
      type: 'ISO',
      shares: 1000,
      strikePrice: 1,
      vestingStart: '2025-06-01',
      cliffMonths: 12,
      vestingMonths: 48,
      status: 'approved',
      exercisedShares: 0,
      earlyExercise: true,
      postTerminationExerciseDays: 90,
    })
    const ctx = contextFor(db, p, '2026-10-09')
    expect(ctx).toMatchObject({ supervisor: true, hasEquity: true, earlyExercise: true, outsideCA: true, remote: true })
  })
})

// ---------------------------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------------------------

describe('generateChecklist (onboarding)', () => {
  it('computes California onboarding dates for a Monday start', () => {
    const db = baseDB()
    const p = addPerson(db, 'p-lucas', { startDate: START })
    const cl = onboarding(db, p)
    expect(cl).toMatchObject({ id: 'ck-test', personId: 'p-lucas', kind: 'onboarding', templateId: 'tpl-onboarding', anchorDate: START })
    expect(task(cl, 'on-i9-section1')?.dueOn).toBe(START)
    expect(task(cl, 'on-i9-section2')).toMatchObject({ dueOn: '2026-10-22', statutory: true, dueRuleText: 'Start + 3 business days' })
    const de34 = task(cl, 'on-de34')
    expect(de34).toMatchObject({ dueOn: '2026-11-08', statutory: true, dueRuleText: '20 days after start' })
    expect(fileBy(de34?.dueOn ?? '', holidayDates(db))).toBe('2026-11-06')
    expect(task(cl, 'on-notice-aca')?.dueOn).toBe('2026-11-02')
    expect(task(cl, 'on-laptop')?.dueOn).toBe('2026-10-09')
    expect(task(cl, 'on-accounts')?.dueOn).toBe('2026-10-16')
    expect(task(cl, 'on-security-training')).toMatchObject({ dueOn: '2026-11-18', soc2Control: 'security-training' })
    expect(task(cl, 'on-checkin-90')?.dueOn).toBe('2027-01-19')
    expect(cl.tasks.every((t) => t.status === 'open' && t.id.startsWith('t-test-'))).toBe(true)
    // sorted by due date
    const dates = cl.tasks.map((t) => t.dueOn)
    expect([...dates].sort()).toEqual(dates)
  })

  it('assigns employee and manager tasks', () => {
    const db = baseDB()
    const p = addPerson(db, 'p-lucas', { startDate: START })
    const cl = onboarding(db, p)
    expect(task(cl, 'on-i9-section1')?.assigneeId).toBe('p-lucas')
    expect(task(cl, 'on-checkin-30')?.assigneeId).toBe('p-founder')
    expect(task(cl, 'on-i9-section2')?.assigneeId).toBeNull()
  })

  it('adds the 2810.5 wage notice only for non-exempt hires', () => {
    const db = baseDB()
    const exempt = addPerson(db, 'p-lucas', { startDate: START })
    const hourly = addPerson(db, 'p-luis', { startDate: START, flsa: 'non_exempt', employmentType: 'part_time', hoursPerWeek: 24 })
    expect(ids(onboarding(db, exempt))).not.toContain('on-notice-2810-5')
    const wage = task(onboarding(db, hourly), 'on-notice-2810-5')
    expect(wage).toMatchObject({ dueOn: START, statutory: true })
    expect(wage?.citation?.label).toBe('Labor Code 2810.5')
  })

  it('leaves out harassment training, CFRA notices and the required fact sheet under 5 employees', () => {
    const db = baseDB()
    const p = addPerson(db, 'p-lucas', { startDate: START })
    const list = ids(onboarding(db, p))
    expect(list).not.toContain('on-harassment-training')
    expect(list).not.toContain('on-harassment-training-supervisor')
    expect(list).not.toContain('on-notice-cfra-pdl')
    expect(list).not.toContain('on-notice-crd')
    expect(list).toContain('on-notice-crd-early')
  })

  it('adds them at 5 or more employees, with the supervisor variant for managers', () => {
    const db = baseDB()
    addPerson(db, 'p-a')
    addPerson(db, 'p-b')
    addPerson(db, 'p-c')
    const p = addPerson(db, 'p-lucas', { startDate: START })
    const cl = onboarding(db, p)
    expect(ids(cl)).toEqual(expect.arrayContaining(['on-notice-crd', 'on-notice-cfra-pdl', 'on-harassment-training']))
    expect(ids(cl)).not.toContain('on-notice-crd-early')
    expect(task(cl, 'on-harassment-training')).toMatchObject({ dueOn: '2027-04-19', statutory: true })
    addPerson(db, 'p-d', { managerId: 'p-lucas', startDate: '2026-11-02' })
    const sup = onboarding(db, p)
    expect(ids(sup)).toContain('on-harassment-training-supervisor')
    expect(ids(sup)).not.toContain('on-harassment-training')
  })

  it('counts contractors toward the harassment training threshold only', () => {
    const db = baseDB()
    addPerson(db, 'p-a')
    const p = addPerson(db, 'p-lucas', { startDate: START })
    db.contractors.push(contractor('k-casey'))
    // 3 employees + 1 contractor = 4
    const list = ids(onboarding(db, p))
    expect(list).not.toContain('on-harassment-training')
    db.contractors.push(contractor('k-two'))
    const list5 = ids(onboarding(db, p))
    expect(list5).toContain('on-harassment-training')
    expect(list5).not.toContain('on-notice-cfra-pdl')
  })

  it('handles an out-of-state remote hire', () => {
    const db = baseDB()
    addPerson(db, 'p-a')
    addPerson(db, 'p-b')
    addPerson(db, 'p-c')
    const p = addPerson(db, 'p-caleb', { startDate: START, homeState: 'TX', homeCity: 'Austin', workMode: 'remote' })
    const list = ids(onboarding(db, p))
    expect(list).toEqual(expect.arrayContaining(['on-new-state', 'on-state-new-hire-report', 'on-remote-setup']))
    expect(list).not.toContain('on-de34')
    expect(list).not.toContain('on-harassment-training')
  })

  it('includes background check, equity and 83(b) tasks only when they apply', () => {
    const db = baseDB()
    const p = addPerson(db, 'p-lucas', { startDate: START, backgroundCheck: { status: 'not_required' } })
    expect(ids(onboarding(db, p))).not.toContain('on-background-check')
    p.backgroundCheck = { status: 'pending' }
    db.grants.push({
      id: 'g-1',
      personId: 'p-lucas',
      holderType: 'employee',
      type: 'ISO',
      shares: 30000,
      strikePrice: 1.15,
      vestingStart: START,
      cliffMonths: 12,
      vestingMonths: 48,
      status: 'promised',
      exercisedShares: 0,
      postTerminationExerciseDays: 90,
    })
    const cl = onboarding(db, p)
    expect(task(cl, 'on-background-check')).toMatchObject({ soc2Control: 'background-check', dueOn: '2026-10-14' })
    expect(ids(cl)).toContain('on-equity-board')
    expect(ids(cl)).not.toContain('on-83b')
    db.grants[0].earlyExercise = true
    // No exercise recorded yet: a reminder without a legal date, never red
    expect(task(onboarding(db, p), 'on-83b')).toMatchObject({ statutory: false, dueRuleText: 'Within 30 days of an early exercise' })
    db.grants[0].election83bDueOn = '2026-12-04'
    expect(task(onboarding(db, p), 'on-83b')).toMatchObject({ dueOn: '2026-12-04', statutory: true, dueRuleText: '30 days after early exercise' })
  })

  it('applies overrides and marks a checklist complete when nothing is open', () => {
    const db = baseDB()
    const p = addPerson(db, 'p-lucas', { startDate: START })
    const cl = generateChecklist(db, {
      person: p,
      templateId: 'tpl-onboarding',
      anchorDate: START,
      createdOn: '2026-10-01',
      overrides: { 'on-piia': { status: 'done', doneOn: '2026-10-02', note: 'Signed in the e-sign tool' } },
    })
    expect(task(cl, 'on-piia')).toMatchObject({ status: 'done', doneOn: '2026-10-02', note: 'Signed in the e-sign tool' })
    expect(cl.completedOn).toBeUndefined()
  })

  it('throws on an unknown template', () => {
    const db = baseDB()
    expect(() => generateChecklist(db, { person: db.people[0], templateId: 'tpl-nope', anchorDate: START, createdOn: START })).toThrow()
  })
})

describe('generateChecklist (offboarding)', () => {
  it('picks final pay and separation notice tasks by separation type', () => {
    const db = baseDB()
    const p = addPerson(db, 'p-omar')
    const base = { person: p, templateId: 'tpl-offboarding', anchorDate: '2026-10-30', createdOn: '2026-10-20' }
    const fired = generateChecklist(db, { ...base, separationType: 'terminated' })
    expect(task(fired, 'off-final-pay-termination')).toMatchObject({ dueOn: '2026-10-30', statutory: true })
    expect(task(fired, 'off-separation-notices')?.statutory).toBe(true)
    expect(ids(fired)).not.toContain('off-separation-notices-optional')
    expect(fired.separationType).toBe('terminated')

    const quit = generateChecklist(db, { ...base, separationType: 'resigned_no_notice' })
    expect(task(quit, 'off-final-pay-72h')?.dueOn).toBe('2026-11-02')
    expect(ids(quit)).toContain('off-separation-notices-optional')
    expect(ids(quit)).not.toContain('off-separation-notices')
    expect(task(quit, 'off-access')).toMatchObject({ dueOn: '2026-10-30', soc2Control: 'access-revoked' })
    expect(task(quit, 'off-cobra')?.dueOn).toBe('2026-11-29')
  })
})

// ---------------------------------------------------------------------------------------------
// Progress and inbox
// ---------------------------------------------------------------------------------------------

describe('checklistProgress', () => {
  it('counts done, open, overdue and statutory overdue', () => {
    const db = baseDB()
    const p = addPerson(db, 'p-lucas', { startDate: START })
    const cl = onboarding(db, p)
    const before = checklistProgress(cl, '2026-10-01')
    expect(before).toMatchObject({ done: 0, overdue: 0, statutoryOverdue: 0, pct: 0, dayOneReady: false })
    expect(before.total).toBe(cl.tasks.length)
    expect(before.nextDue?.templateTaskId).toBe('on-laptop')

    for (const t of cl.tasks) if (t.dueOn < START) t.status = 'done'
    const ready = checklistProgress(cl, START)
    expect(ready.dayOneReady).toBe(true)
    expect(ready.overdue).toBe(0)

    const late = checklistProgress(cl, '2026-10-23')
    expect(late.overdue).toBeGreaterThan(0)
    // I-9 section 1, the SB 294 and survivors of violence notices (day 1), I-9 section 2 (Oct 22); the ACA notice and DE 34 are not due yet
    expect(late.statutoryOverdue).toBe(4)
  })

  it('leaves not-applicable tasks out of the total', () => {
    const db = baseDB()
    const p = addPerson(db, 'p-lucas', { startDate: START })
    const cl = onboarding(db, p)
    const n = cl.tasks.length
    cl.tasks[0].status = 'not_applicable'
    cl.tasks[1].status = 'done'
    const prog = checklistProgress(cl, '2026-10-01')
    expect(prog.total).toBe(n - 1)
    expect(prog.pct).toBe(Math.round((1 / (n - 1)) * 100))
  })
})

describe('openTasks', () => {
  it('lists open tasks soonest first with filters', () => {
    const db = baseDB()
    const p = addPerson(db, 'p-lucas', { startDate: START })
    const q = addPerson(db, 'p-mei', { startDate: '2026-11-02' })
    db.checklists.push(onboarding(db, p))
    db.checklists.push(generateChecklist(db, { person: q, templateId: 'tpl-onboarding', anchorDate: q.startDate, createdOn: '2026-10-07' }))
    const all = openTasks(db, '2026-10-20')
    expect(all.length).toBe(db.checklists[0].tasks.length + db.checklists[1].tasks.length)
    expect(all.map((x) => x.task.dueOn)).toEqual([...all.map((x) => x.task.dueOn)].sort())
    expect(all.find((x) => x.task.templateTaskId === 'on-laptop' && x.personId === 'p-lucas')?.overdue).toBe(true)

    const mine = openTasks(db, '2026-10-20', { personId: 'p-mei', ownerRole: 'employee' })
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((x) => x.personId === 'p-mei' && x.task.ownerRole === 'employee')).toBe(true)

    const soon = openTasks(db, '2026-10-20', { dueBy: '2026-10-22' })
    expect(soon.every((x) => x.task.dueOn <= '2026-10-22')).toBe(true)
    const de34 = all.find((x) => x.task.templateTaskId === 'on-de34' && x.personId === 'p-lucas')
    expect(de34?.fileBy).toBe('2026-11-06')
  })
})

// ---------------------------------------------------------------------------------------------
// Template hygiene
// ---------------------------------------------------------------------------------------------

describe('DEFAULT_CHECKLIST_TEMPLATES', () => {
  it('has the five templates', () => {
    expect(DEFAULT_CHECKLIST_TEMPLATES.map((t) => t.id)).toEqual(['tpl-onboarding', 'tpl-offboarding', 'tpl-new-state', 'tpl-leave', 'tpl-change'])
  })

  it('uses unique ids, sentence case, plain punctuation and citations on legal deadlines', () => {
    const seen = new Set<string>()
    for (const tpl of DEFAULT_CHECKLIST_TEMPLATES) {
      for (const t of tpl.tasks) {
        expect(seen.has(t.id), t.id).toBe(false)
        seen.add(t.id)
        expect(t.title.length, t.id).toBeGreaterThan(0)
        expect(t.title[0], t.id).toBe(t.title[0].toUpperCase())
        expect(`${t.title} ${t.why ?? ''}`, t.id).not.toMatch(/—/)
        expect(t.why, t.id).toBeTruthy()
        if (t.statutory) expect(t.citation?.url, t.id).toMatch(/^https:\/\//)
      }
    }
  })
})

// ---------------------------------------------------------------------------------------------
// Review fixes
// ---------------------------------------------------------------------------------------------

describe('short-term hires and the notices packet', () => {
  function fiveStrong(): DB {
    const db = baseDB()
    for (const id of ['p-a', 'p-b', 'p-c']) addPerson(db, id)
    return db
  }

  it('matches a list of employment types', () => {
    const ctx: TaskContext = {
      headcount: 6,
      workforce: 6,
      supervisor: false,
      flsa: 'non_exempt',
      remote: false,
      outsideCA: false,
      hasEquity: false,
      earlyExercise: false,
      employmentType: 'intern',
      backgroundCheck: false,
    }
    expect(taskApplies({ employmentTypes: ['intern'] }, ctx)).toBe(true)
    expect(taskApplies({ employmentTypes: ['full_time', 'part_time'] }, ctx)).toBe(false)
  })

  it('gives a summer intern harassment training within 30 days, not 6 months', () => {
    const db = fiveStrong()
    const intern = addPerson(db, 'p-ivy', { startDate: '2027-06-07', employmentType: 'intern', flsa: 'non_exempt', hoursPerWeek: 40 })
    const cl = onboarding(db, intern)
    expect(task(cl, 'on-harassment-training-short-term')).toMatchObject({ dueOn: '2027-07-07', statutory: true })
    expect(task(cl, 'on-harassment-training-short-term')?.why).toMatch(/30 days or 100 hours worked, whichever comes first/)
    expect(ids(cl)).not.toContain('on-harassment-training')
    const regular = addPerson(db, 'p-rae', { startDate: '2027-06-07' })
    const reg = onboarding(db, regular)
    expect(ids(reg)).toContain('on-harassment-training')
    expect(ids(reg)).not.toContain('on-harassment-training-short-term')
  })

  it('includes the survivors of violence notice and IIPP training from the first hire', () => {
    const db = baseDB()
    const p = addPerson(db, 'p-lucas', { startDate: START })
    const cl = onboarding(db, p)
    expect(task(cl, 'on-notice-survivors')).toMatchObject({ dueOn: START, statutory: true })
    expect(task(cl, 'on-notice-survivors')?.citation?.label).toBe('Gov Code 12945.8')
    expect(task(cl, 'on-iipp-training')).toMatchObject({ dueOn: START, statutory: false })
    expect(ids(cl)).not.toContain('on-ack-meal-rest')
    const hourly = addPerson(db, 'p-luis', { startDate: START, flsa: 'non_exempt' })
    expect(ids(onboarding(db, hourly))).toContain('on-ack-meal-rest')
  })
})

describe('generation dates', () => {
  it('never dates a lead-time task before the checklist existed', () => {
    const db = baseDB()
    const p = addPerson(db, 'p-lucas', { startDate: START })
    const late = generateChecklist(db, { person: p, templateId: 'tpl-onboarding', anchorDate: START, createdOn: '2026-10-14' })
    expect(task(late, 'on-laptop')?.dueOn).toBe('2026-10-14')
    expect(task(late, 'on-piia')?.dueOn).toBe('2026-10-14')
    expect(task(late, 'on-accounts')?.dueOn).toBe('2026-10-16')
    expect(checklistProgress(late, '2026-10-14').overdue).toBe(0)
    // Recorded on a Saturday: the next business day
    const weekend = generateChecklist(db, { person: p, templateId: 'tpl-onboarding', anchorDate: START, createdOn: '2026-10-17' })
    expect(task(weekend, 'on-laptop')?.dueOn).toBe(START)
  })

  it('names the created anchor by checklist kind', () => {
    expect(dueRuleText({ anchor: 'created', offset: 3, unit: 'business_days' }, 'change')).toBe('Recording + 3 business days')
    expect(dueRuleText({ anchor: 'created', offset: 5, unit: 'business_days' }, 'leave')).toBe('Request + 5 business days')
  })
})

describe('generateChecklist (leave)', () => {
  function staffed(): { db: DB; p: Person } {
    const db = baseDB()
    for (const id of ['p-a', 'p-b', 'p-c']) addPerson(db, id)
    return { db, p: addPerson(db, 'p-tomas') }
  }
  const leave = (db: DB, p: Person, leaveKind: TaskContext['leaveKind']) =>
    generateChecklist(db, { person: p, templateId: 'tpl-leave', anchorDate: '2026-11-16', createdOn: '2026-10-06', extra: { leaveKind } })

  it('shares the lactation policy only for parental leave, under a neutral title', () => {
    const { db, p } = staffed()
    expect(task(leave(db, p, 'bonding'), 'lv-lactation')?.title).toBe('Policy packet shared')
    expect(task(leave(db, p, 'pdl'), 'lv-lactation')).toBeDefined()
    expect(task(leave(db, p, 'cfra'), 'lv-lactation')).toBeUndefined()
  })

  it('sends the CFRA designation notice only for CFRA, PDL and bonding leave', () => {
    const { db, p } = staffed()
    expect(task(leave(db, p, 'cfra'), 'lv-designation')?.statutory).toBe(false) // a company target (5 business days), not a statutory date
    expect(task(leave(db, p, 'military'), 'lv-designation')).toBeUndefined()
    expect(task(leave(db, p, 'military'), 'lv-benefits')).toBeUndefined()
  })
})

describe('generateChecklist (offboarding copy)', () => {
  it('gives the end of a fixed-term job its own final pay task', () => {
    const db = baseDB()
    const p = addPerson(db, 'p-omar')
    const cl = generateChecklist(db, { person: p, templateId: 'tpl-offboarding', anchorDate: '2026-10-30', createdOn: '2026-10-20', separationType: 'contract_ended' })
    expect(task(cl, 'off-final-pay-contract-end')).toMatchObject({ title: 'Final paycheck paid on the last day', dueOn: '2026-10-30', statutory: true })
    expect(ids(cl)).not.toContain('off-final-pay-termination')
  })
})

describe('openTasks after an exit', () => {
  it('drops tasks made moot by an end date recorded another way, keeping surviving obligations', () => {
    const db = baseDB()
    const p = addPerson(db, 'p-lucas', { startDate: START })
    db.checklists.push(onboarding(db, p))
    p.endDate = '2026-10-23'
    const open = openTasks(db, '2026-12-01', { personId: 'p-lucas' }).map((x) => x.task.templateTaskId)
    expect(open).toEqual(expect.arrayContaining(['on-i9-section2', 'on-de34', 'on-notice-aca', 'on-laptop']))
    expect(open).not.toContain('on-checkin-30')
    expect(open).not.toContain('on-security-training')
    p.endDate = '2026-10-16' // never started
    expect(openTasks(db, '2026-12-01', { personId: 'p-lucas' })).toHaveLength(0)
  })
})

describe('template copy', () => {
  it("writes 72 hours' notice with the apostrophe", () => {
    for (const tpl of DEFAULT_CHECKLIST_TEMPLATES) {
      for (const t of tpl.tasks) expect(`${t.title} ${t.why ?? ''}`, t.id).not.toMatch(/72 hours notice/)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// End-to-end review fixes
// ---------------------------------------------------------------------------------------------

describe('taskFileBy', () => {
  const holidays = holidayDates(baseDB())

  it('gives agency filings due on a weekend the business day before', () => {
    const db = baseDB()
    const p = addPerson(db, 'p-lucas', { startDate: START })
    const cl = onboarding(db, p)
    const de34 = task(cl, 'on-de34')
    expect(de34?.dueOn).toBe('2026-11-08')
    expect(taskFileBy(de34 ?? { dueOn: '' }, cl, holidays)).toBe('2026-11-06')
    // A non-filing deadline on the same weekend day gets none
    expect(taskFileBy({ templateTaskId: 'on-notice-aca', dueOn: '2026-11-08' }, cl, holidays)).toBeNull()
  })

  it('never gives final pay or other last-day tasks a day before the termination', () => {
    const db = baseDB()
    const p = addPerson(db, 'p-kofi')
    // Terminated on Saturday, Oct 10, recorded that day
    const fired = generateChecklist(db, { person: p, templateId: 'tpl-offboarding', anchorDate: '2026-10-10', createdOn: '2026-10-10', separationType: 'terminated' })
    expect(task(fired, 'off-final-pay-termination')?.dueOn).toBe('2026-10-10')
    for (const t of fired.tasks) expect(taskFileBy(t, fired, holidays), t.templateTaskId).toBeNull()
  })

  it('never returns a day before the checklist existed or its anchor', () => {
    const cl = { createdOn: '2026-11-07', anchorDate: '2026-10-19' }
    expect(taskFileBy({ templateTaskId: 'on-de34', dueOn: '2026-11-08' }, cl, holidays)).toBeNull()
    expect(taskFileBy({ templateTaskId: 'on-de34', dueOn: '2026-11-08' }, { createdOn: '2026-10-01', anchorDate: '2026-11-07' }, holidays)).toBeNull()
  })

  it('feeds the open task list', () => {
    const db = baseDB()
    const p = addPerson(db, 'p-kofi')
    db.checklists.push(generateChecklist(db, { person: p, templateId: 'tpl-offboarding', anchorDate: '2026-10-10', createdOn: '2026-10-10', separationType: 'terminated' }))
    expect(openTasks(db, '2026-10-10').every((x) => x.fileBy === null)).toBe(true)
  })
})

describe('W-4 and DE 4 on the onboarding checklist', () => {
  it('asks a California hire for the W-4 and DE 4 on day 1', () => {
    const db = baseDB()
    const p = addPerson(db, 'p-lucas', { startDate: START })
    const cl = onboarding(db, p)
    expect(task(cl, 'on-w4-de4')).toMatchObject({ title: 'W-4 (2026) and DE 4 completed', ownerRole: 'employee', assigneeId: 'p-lucas', dueOn: START, category: 'payroll', statutory: false })
    expect(task(cl, 'on-w4-de4')?.citation?.label).toBe('W-4 and DE 4')
    expect(task(cl, 'on-w4-de4')?.why).toMatch(/single with zero allowances/)
    expect(ids(cl)).not.toContain('on-w4-state')
  })

  it('asks someone working in another state for the W-4 and that state form', () => {
    const db = baseDB()
    const p = addPerson(db, 'p-caleb', { startDate: START, homeState: 'TX', homeCity: 'Austin', workMode: 'remote' })
    const cl = onboarding(db, p)
    expect(task(cl, 'on-w4-state')).toMatchObject({ title: 'W-4 (2026) and the state withholding form completed', dueOn: START, ownerRole: 'employee' })
    expect(ids(cl)).not.toContain('on-w4-de4')
  })
})

describe('DE 34 for a rehire', () => {
  function rehireDB(lastDay: string): { db: DB; person: Person } {
    const db = baseDB()
    addPerson(db, 'p-omar', { firstName: 'Omar', lastName: 'Haddad', startDate: '2025-01-13', endDate: lastDay })
    const person = addPerson(db, 'p-omar-haddad', { firstName: 'Omar', lastName: 'Haddad', startDate: '2026-10-12', rehireOfPersonId: 'p-omar' })
    return { db, person }
  }

  it('marks it not required when the rehire was away less than 60 days', () => {
    const { db, person } = rehireDB('2026-08-28')
    expect(rehireDaysAway(db, person)).toBe(44)
    const cl = onboarding(db, person)
    expect(task(cl, 'on-de34')).toMatchObject({ status: 'not_applicable', statutory: true })
    expect(task(cl, 'on-de34')?.note).toBe("Not required: back after 44 days away. EDD's new hire report covers a rehire only after a separation of at least 60 consecutive days.")
    expect(cl.completedOn).toBeUndefined()
  })

  it('keeps it after a separation of 60 days or more, and for a same-name hire that is not linked', () => {
    const { db, person } = rehireDB('2026-08-12')
    expect(rehireDaysAway(db, person)).toBe(60)
    expect(task(onboarding(db, person), 'on-de34')?.status).toBe('open')
    const near = rehireDB('2026-08-28')
    delete near.person.rehireOfPersonId
    expect(task(onboarding(near.db, near.person), 'on-de34')?.status).toBe('open')
  })
})
