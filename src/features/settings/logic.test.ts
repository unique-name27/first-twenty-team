import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import { DOC_KEYS, RECORD_COLLECTIONS } from '@/sync/collections'
import type { DB } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'
import {
  buildFreshDB,
  changedKeys,
  charCountText,
  COLLECTION_LABELS,
  conflictValueText,
  dataWeDontKeep,
  describeCondition,
  diffDB,
  exemptFloorFrom,
  exemptRecheck,
  exemptRecheckText,
  fmtBytes,
  healthPlanChoice,
  healthPlanProblem,
  hintWithCount,
  hostLabel,
  isCustomTask,
  linkProblem,
  localMinWage,
  longestWorkday,
  maskDigits,
  mergeIncoming,
  moveItem,
  normalizeWebsite,
  packFileName,
  parseBackup,
  payrollProviderName,
  setHealthPlan,
  resolveConflicts,
  reviewedDate,
  sickLeaveMinimums,
  sickPolicyProblem,
  SHORT_TEXT_MAX_CHARS,
  STORAGE_DOC_LABELS,
  storageLabel,
  storageUsage,
  suggestedWorkEmail,
  TEXT_MAX_CHARS,
  urlProblem,
  usageOf,
  workEmailProblem,
} from './logic'

const TODAY = '2026-10-09'

beforeAll(() => setClockOverride(TODAY))
afterAll(() => setClockOverride(null))

function base(): DB {
  return blankDB({ companyName: 'Acme', founderFirstName: 'Ada', founderLastName: 'Lovelace', foundedOn: '2026-01-05' })
}

describe('parseBackup', () => {
  it('asks for input when empty', () => {
    expect(parseBackup('   ')).toEqual({ ok: false, reason: 'Paste a backup or pick a file first.' })
  })
  it('rejects text that is not JSON', () => {
    const r = parseBackup('{ "schemaVersion": 1, ')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not valid JSON/)
  })
  it('rejects arrays and objects without a schema version', () => {
    expect(parseBackup('[]').ok).toBe(false)
    const r = parseBackup('{"company":{"name":"x"}}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/no schemaVersion/)
  })
  it('names a newer schema version', () => {
    const r = parseBackup(JSON.stringify({ ...base(), schemaVersion: 2 }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/schema version 2, which is newer/)
  })
  it('needs a company record and the core lists', () => {
    const noCompany = { ...base() } as Partial<DB>
    delete noCompany.company
    expect(parseBackup(JSON.stringify(noCompany)).ok).toBe(false)
    const noPeople = { ...base() } as Record<string, unknown>
    delete noPeople.people
    const r = parseBackup(JSON.stringify(noPeople))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/people list/)
  })
  it('rejects a collection that is not a list', () => {
    const r = parseBackup(JSON.stringify({ ...base(), holidays: { a: 1 } }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/holidays/i)
  })
  it('accepts a real backup and round-trips without loss', () => {
    const db = base()
    const r = parseBackup(JSON.stringify(db, null, 2))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.db).toEqual(db)
      expect(diffDB(db, r.db).identical).toBe(true)
    }
  })
})

describe('diffDB', () => {
  it('counts added, removed and changed records per collection', () => {
    const a = base()
    const b = structuredClone(a)
    b.people[0].title = 'CEO'
    b.holidays = b.holidays.slice(1)
    b.departments.push({ id: 'd-new', name: 'Research' })
    b.company.name = 'Acme Two'
    const d = diffDB(a, b)
    const row = (k: string) => d.rows.find((r) => r.key === k)!
    expect(row('people')).toMatchObject({ current: 1, incoming: 1, changed: 1, added: 0, removed: 0 })
    expect(row('holidays').removed).toBe(1)
    expect(row('departments').added).toBe(1)
    expect(d.sections.map((s) => s.key)).toEqual(['company'])
    expect(d.companyFrom).toBe('Acme')
    expect(d.companyTo).toBe('Acme Two')
    expect(d.totalChanges).toBe(4)
    expect(d.identical).toBe(false)
  })
})

describe('storage', () => {
  it('formats sizes', () => {
    expect(fmtBytes(512)).toBe('512 bytes')
    expect(fmtBytes(412_300)).toBe('412 KB')
    expect(fmtBytes(1_250_000)).toBe('1.3 MB')
    expect(fmtBytes(2_000_000)).toBe('2 MB')
  })
  it('warns from 70% and alarms from 90%', () => {
    expect(storageUsage(1_000_000).tone).toBe('good')
    expect(storageUsage(3_500_000).tone).toBe('warn')
    expect(storageUsage(4_600_000).tone).toBe('bad')
    expect(storageUsage(400_000).text).toBe('400 KB of about 5 MB (8%)')
    expect(storageUsage(20_000).text).toContain('under 1%')
  })
})

describe('storage labels (r3-11: raw keys such as timeOffPolicies showed)', () => {
  it('names every collection and document in plain words', () => {
    for (const key of RECORD_COLLECTIONS) expect(COLLECTION_LABELS[key], key).toBeTruthy()
    for (const key of DOC_KEYS) expect(STORAGE_DOC_LABELS[key], key).toBeTruthy()
    for (const key of [...RECORD_COLLECTIONS, ...DOC_KEYS]) {
      const label = storageLabel(key)
      // Lower case words, never a camelCase key.
      expect(label, key).not.toMatch(/[a-z][A-Z]/)
      expect(label.charAt(0), key).toBe(label.charAt(0).toLowerCase())
    }
    expect(storageLabel('timeOffPolicies')).toBe('time off policies')
    expect(storageLabel('bands')).toBe('pay bands')
    expect(storageLabel('checklistTemplates')).toBe('checklist templates')
    expect(storageLabel('settings')).toBe('hiring settings and rules')
  })
})

describe('free text caps (r3-17)', () => {
  it('counts characters only near the limit', () => {
    expect(TEXT_MAX_CHARS).toBe(20_000)
    expect(charCountText('x'.repeat(17_999), TEXT_MAX_CHARS)).toBeNull()
    expect(charCountText('x'.repeat(18_250), TEXT_MAX_CHARS)).toBe('18,250 of 20,000 characters')
    expect(charCountText(undefined, SHORT_TEXT_MAX_CHARS)).toBeNull()
    expect(charCountText('x'.repeat(1_850), SHORT_TEXT_MAX_CHARS)).toBe('1,850 of 2,000 characters')
  })
  it('adds the count to a hint, keeping the hint', () => {
    expect(hintWithCount('One plain sentence.', 'Short', SHORT_TEXT_MAX_CHARS)).toBe('One plain sentence.')
    expect(hintWithCount('One plain sentence.', 'x'.repeat(2_000), SHORT_TEXT_MAX_CHARS)).toBe('One plain sentence. 2,000 of 2,000 characters.')
  })
})

describe('start fresh', () => {
  it('builds a one-person company with the founder as employee #1', () => {
    const db = buildFreshDB({
      companyName: '  Northwind ',
      hqCity: 'San Jose',
      hqState: 'ca',
      hqZip: '95113',
      firstName: 'Sam',
      lastName: 'Rivera',
      title: 'Founder and CEO',
      startDate: '2026-10-05',
    })
    expect(db.people).toHaveLength(1)
    expect(db.people[0]).toMatchObject({ firstName: 'Sam', lastName: 'Rivera', hireNumber: 1, isFounder: true, startDate: '2026-10-05' })
    expect(db.company).toMatchObject({ name: 'Northwind', legalName: 'Northwind, Inc.', foundedOn: '2026-10-05' })
    expect(db.company.hq).toMatchObject({ city: 'San Jose', state: 'CA', zip: '95113' })
    expect(db.meta.sample).toBe(false)
    expect(db.jobs).toHaveLength(0)
    expect(db.locations.find((l) => l.kind === 'hq')?.minWageHourly).toBe(18.45)
  })
  it('uses the local minimum wage for other Bay Area cities', () => {
    const db = buildFreshDB({
      companyName: 'Bayside',
      hqStreet: '1 Market St',
      hqCity: 'San Francisco',
      hqState: 'CA',
      hqZip: '94105',
      firstName: 'Jo',
      lastName: 'Park',
      title: '',
      startDate: TODAY,
    })
    const hq = db.locations.find((l) => l.kind === 'hq')!
    expect(hq.minWageHourly).toBe(19.61)
    expect(hq.name).toBe('San Francisco HQ')
    expect(db.company.hq.street).toBe('1 Market St')
    expect(db.people[0].title).toBe('Founder and CEO')
  })
  it('never makes up the founder email, and keeps the email and website they enter', () => {
    const input = {
      companyName: 'Ledgerline AI',
      hqCity: 'San Jose',
      hqState: 'CA',
      hqZip: '95113',
      firstName: 'Dana',
      lastName: 'Lee',
      title: 'Founder and CEO',
      startDate: TODAY,
    }
    const blank = buildFreshDB(input)
    expect(blank.people[0].workEmail).toBe('')
    expect(blank.company.website).toBeUndefined()
    expect(buildFreshDB({ ...input, workEmail: '   ' }).people[0].workEmail).toBe('')
    const filled = buildFreshDB({ ...input, workEmail: ' dana@ledgerline.ai ', website: 'ledgerline.ai' })
    expect(filled.people[0].workEmail).toBe('dana@ledgerline.ai')
    expect(filled.company.website).toBe('https://ledgerline.ai')
    // Programmatic callers (the sample and test kits) still get blankDB's address.
    expect(base().people[0].workEmail).toBe('ada@acme.com')
  })
  it('checks the optional email and website on Start fresh', () => {
    expect(workEmailProblem('')).toBeNull()
    expect(workEmailProblem(undefined)).toBeNull()
    expect(workEmailProblem('dana@ledgerline.ai')).toBeNull()
    expect(workEmailProblem('dana@')).toBe('Enter an email like name@example.com, or leave it blank.')
    expect(normalizeWebsite('  ')).toBe('')
    expect(normalizeWebsite('ledgerline.ai')).toBe('https://ledgerline.ai')
    expect(normalizeWebsite('http://ledgerline.ai/')).toBe('http://ledgerline.ai/')
    expect(urlProblem(normalizeWebsite('ledgerline'))).toMatch(/domain/)
    expect(suggestedWorkEmail('Dana', 'https://www.ledgerline.ai')).toBe('dana@ledgerline.ai')
    expect(suggestedWorkEmail('Mary Jo', 'ledgerline.ai')).toBe('maryjo@ledgerline.ai')
    expect(suggestedWorkEmail('', 'ledgerline.ai')).toBeNull()
    expect(suggestedWorkEmail('Dana', '')).toBeNull()
    expect(suggestedWorkEmail('Dana', 'ledgerline')).toBeNull()
  })
  it('finds local minimum wages by date', () => {
    expect(localMinWage('san jose')).toBe(18.45)
    expect(localMinWage('Palo Alto', '2027-01-02')).toBe(19.25)
    expect(localMinWage('Fresno')).toBeUndefined()
    expect(localMinWage(undefined)).toBeUndefined()
  })
})

describe('labels and small helpers', () => {
  it('describes checklist conditions in plain words', () => {
    expect(describeCondition(undefined)).toEqual([])
    expect(describeCondition({ minHeadcount: 5, supervisor: true, flsa: 'non_exempt' })).toEqual(['5+ employees', 'Supervisors', 'Non-exempt'])
    expect(describeCondition({ separationTypes: ['terminated', 'laid_off'] })).toEqual(['Exit: terminated, laid off'])
    expect(describeCondition({ leaveKinds: ['cfra', 'bonding'], outsideCA: true })).toEqual(['Works outside California', 'Leave: CFRA, bonding'])
  })
  it('masks all but the last two digits', () => {
    expect(maskDigits('123-4567-8')).toBe('•••-•••7-8')
    expect(maskDigits('000-0000-0 (placeholder)')).toBe('•••-•••0-0 (placeholder)')
    expect(maskDigits(undefined)).toBe('')
  })
  it('checks link-out URLs', () => {
    expect(urlProblem('')).toBeNull()
    expect(urlProblem('https://example.com/peo')).toBeNull()
    expect(urlProblem('example.com')).toMatch(/https/)
    expect(urlProblem('https://intranet')).toMatch(/domain/)
    expect(hostLabel('https://www.example.com/x')).toBe('example.com')
    expect(hostLabel('nope')).toBeNull()
  })
  it('moves list items without leaving the list', () => {
    expect(moveItem([1, 2, 3], 1, -1)).toEqual([2, 1, 3])
    expect(moveItem([1, 2, 3], 2, 1)).toEqual([1, 2, 3])
  })
  it('computes the exempt floor from the minimum wage', () => {
    expect(exemptFloorFrom(16.9)).toBe(70_304)
  })
  it('falls back to the whole set review date', () => {
    const law = base().settings.law
    expect(reviewedDate(law, 'caMinWageHourly')).toBe(law.lastReviewedOn)
    expect(reviewedDate({ ...law, reviewedOn: { caMinWageHourly: '2027-01-04' } }, 'caMinWageHourly')).toBe('2027-01-04')
  })
  it('names custom tasks (backup file names: src/store/backup.test.ts)', () => {
    expect(isCustomTask('custom-t-123')).toBe(true)
    expect(isCustomTask('on-piia')).toBe(false)
  })
})

describe('usageOf', () => {
  it('reports what still points at a department or level', () => {
    const db = base()
    const dept = usageOf(db, 'department', 'd-exec')
    expect(dept.count).toBe(1)
    expect(dept.text).toBe('1 person')
    expect(usageOf(db, 'department', 'd-gtm').count).toBe(0)
    const level = usageOf(db, 'level', 'lv-l3')
    expect(level.text).toMatch(/pay bands/)
  })
})

describe('dataWeDontKeep', () => {
  it('lists every sensitive kind and names the system of record', () => {
    const db = base()
    db.company.payrollProvider = { name: 'Acme PEO', kind: 'PEO', url: 'https://peo.example.com' }
    db.company.linkOuts.backgroundCheck = 'https://checks.example.com'
    const rows = dataWeDontKeep(db)
    expect(rows.map((r) => r.item)).toEqual([
      'Social Security numbers',
      'Dates of birth',
      'Bank and direct deposit details',
      'Home street addresses',
      'ID scans',
      'I-9 forms',
      'Background check reports',
      'Medical details',
      'Protected characteristics',
    ])
    expect(rows[0].systemOfRecord).toBe('Acme PEO (PEO)')
    expect(rows[6].systemOfRecord).toContain('checks.example.com')
  })

  it('says "your payroll or PEO provider" while the provider has no name, or the old placeholder', () => {
    const db = base()
    db.company.payrollProvider = { name: '', kind: 'PEO', url: '' }
    expect(dataWeDontKeep(db)[0].systemOfRecord).toBe('your payroll or PEO provider')
    db.company.payrollProvider.name = 'Your payroll or PEO provider'
    expect(dataWeDontKeep(db)[0].systemOfRecord).toBe('your payroll or PEO provider')
  })
})

describe('link-outs (r2-41: a link without https:// was refused, the provider name held placeholder text)', () => {
  it('checks a link as it will be saved, with https:// added when it was left off', () => {
    expect(linkProblem('secure.justworks.com')).toBeNull()
    expect(normalizeWebsite('secure.justworks.com')).toBe('https://secure.justworks.com')
    expect(linkProblem('https://secure.justworks.com/login')).toBeNull()
    expect(linkProblem('')).toBeNull()
    expect(linkProblem('justworks')).toMatch(/domain/)
  })

  it('starts a new workspace with no provider name, and reads the old placeholder as none', () => {
    const db = base()
    expect(db.company.payrollProvider.name).toBe('')
    expect(payrollProviderName(db.company)).toBe('')
    db.company.payrollProvider.name = 'Your payroll or PEO provider'
    expect(payrollProviderName(db.company)).toBe('')
    db.company.payrollProvider.name = '  Justworks  '
    expect(payrollProviderName(db.company)).toBe('Justworks')
  })
})

describe('sick leave policy checks', () => {
  const sick = { kind: 'sick' as const, method: 'frontload' as const, annualHours: 40, usageCapHours: 40, capHours: 80, usableAfterDays: 90 }

  it('passes the default policy and ignores other kinds', () => {
    expect(sickPolicyProblem(sick)).toBeNull()
    expect(sickPolicyProblem({ ...sick, usageCapHours: null, capHours: null, usableAfterDays: null })).toBeNull()
    expect(sickPolicyProblem({ kind: 'vacation', method: 'accrual', annualHours: 10, capHours: 5 })).toBeNull()
  })
  it('rejects a wait over 90 days and a grant under 40 hours', () => {
    expect(sickPolicyProblem({ ...sick, usableAfterDays: 120 })).toMatch(/up to 90 days/)
    expect(sickPolicyProblem({ ...sick, annualHours: 24 })).toMatch(/^Grant at least 40 hours a year/)
  })
  it('rejects a yearly use limit under 40 hours or 5 days', () => {
    expect(sickPolicyProblem({ ...sick, usageCapHours: 24 })).toMatch(/^Set the yearly use limit to at least 40 hours/)
    expect(sickPolicyProblem({ ...sick, annualHours: 50, usageCapHours: 40, capHours: null }, 10)).toMatch(/at least 50 hours.*5 days is 50 hours/)
  })
  it('rejects an accrual cap under 80 hours or 10 days, and accrual slower than 1 per 30', () => {
    const accrual = { ...sick, method: 'accrual' as const, annualHours: 70, usageCapHours: null }
    expect(sickPolicyProblem({ ...accrual, capHours: 80 })).toBeNull()
    expect(sickPolicyProblem({ ...accrual, capHours: 48 })).toMatch(/^Set the balance cap to at least 80 hours/)
    expect(sickPolicyProblem({ ...accrual, capHours: null, annualHours: 40 })).toMatch(/1 hour of sick leave for every 30 hours/)
  })
  it('rejects a front-loaded balance cap below the grant', () => {
    expect(sickPolicyProblem({ ...sick, capHours: 32 })).toMatch(/at least 40 hours, or leave it blank/)
    expect(sickPolicyProblem({ ...sick, annualHours: 48, capHours: 40, usageCapHours: null })).toMatch(/at least 48 hours/)
  })
  it('works out the floors from the workday', () => {
    expect(sickLeaveMinimums()).toEqual({ yearly: 40, cap: 80, accrualYearly: 69.33, maxWaitDays: 90 })
    expect(sickLeaveMinimums(10)).toMatchObject({ yearly: 50, cap: 100 })
    expect(sickLeaveMinimums(6)).toMatchObject({ yearly: 40, cap: 80 })
  })
  it('finds the longest workday among current staff in the covered states', () => {
    const db = base()
    const founder = db.people[0]
    expect(longestWorkday(db.people, TODAY, ['CA'])).toBe(8)
    const long = { ...founder, id: 'p-long', hoursPerWeek: 50, homeState: 'CA' }
    const elsewhere = { ...founder, id: 'p-co', hoursPerWeek: 60, homeState: 'CO' }
    const gone = { ...founder, id: 'p-gone', hoursPerWeek: 60, homeState: 'CA', endDate: '2026-01-31' }
    const people = [founder, long, elsewhere, gone]
    expect(longestWorkday(people, TODAY, ['CA'])).toBe(10)
    expect(longestWorkday(people, TODAY)).toBe(12)
  })
})

describe('packFileName', () => {
  it('names a graduation CSV after the company, pack and date', () => {
    expect(packFileName('Ledgerlark, Inc.', 'people', '2026-10-10')).toBe('ledgerlark-inc-people-2026-10-10.csv')
    expect(packFileName('  ', 'equity-grants', '2026-10-10')).toBe('first-twenty-equity-grants-2026-10-10.csv')
  })
})

describe('exempt recheck', () => {
  const comp = (personId: string, salary: number) => ({
    id: `cr-${personId}`,
    personId,
    effectiveOn: '2026-01-05',
    payType: 'salary' as const,
    salary,
    title: 'Engineer',
    levelId: 'lv-l3',
    reason: 'hire' as const,
  })
  it('counts only exempt people with a salary on file and names the rest', () => {
    const db = base()
    // A fresh company: the founder is exempt with no job and pay record.
    const solo = exemptRecheck(db, TODAY)
    expect(solo).toEqual({ withSalary: [], noSalary: [{ personId: 'p-founder', name: 'Ada Lovelace', founder: true }] })
    expect(exemptRecheckText(solo, 70_304)).toBe('No exempt salaries on file yet.')
    db.comp.push(comp('p-founder', 150_000))
    const one = exemptRecheck(db, TODAY)
    expect(one.noSalary).toEqual([])
    expect(exemptRecheckText(one, 70_304)).toBe("Ada Lovelace's salary clears the $70,304 floor and the computer professional minimum where it applies.")
    db.people.push(
      { ...db.people[0], id: 'p-b', firstName: 'Bo', isFounder: false, hireNumber: 2 },
      { ...db.people[0], id: 'p-c', firstName: 'Cy', isFounder: false, hireNumber: 3 },
      { ...db.people[0], id: 'p-hourly', firstName: 'Hal', flsa: 'non_exempt', isFounder: false, hireNumber: 4 },
      { ...db.people[0], id: 'p-gone', firstName: 'Gil', endDate: '2026-06-30', isFounder: false, hireNumber: 5 },
    )
    db.comp.push(comp('p-b', 180_000), comp('p-gone', 180_000))
    const many = exemptRecheck(db, TODAY)
    expect(many.withSalary.map((p) => p.personId)).toEqual(['p-founder', 'p-b'])
    expect(many.noSalary).toEqual([{ personId: 'p-c', name: 'Cy Lovelace', founder: false }])
    expect(exemptRecheckText(many, 70_304)).toBe('All 2 exempt salaries clear the $70,304 floor and the computer professional minimum where it applies.')
  })
})

describe('edit forms and saves from another computer', () => {
  type Cash = { cashOnHand: number | null; cashAsOf: string; otherMonthlySpend: number | null }
  const opened: Cash = { cashOnHand: 1_000_000, cashAsOf: '2026-10-01', otherMonthlySpend: 50_000 }

  it('lists the fields the user changed', () => {
    expect(changedKeys(opened, { ...opened })).toEqual([])
    expect(changedKeys(opened, { ...opened, otherMonthlySpend: 60_000 })).toEqual(['otherMonthlySpend'])
    expect(changedKeys({ a: [1, 2] }, { a: [1, 2] })).toEqual([])
  })

  it('takes in untouched fields saved elsewhere and flags the ones both changed', () => {
    const draft = { ...opened, otherMonthlySpend: 60_000 }
    // Nothing saved elsewhere: the same objects come back.
    const quiet = mergeIncoming(opened, draft, { ...opened })
    expect(quiet.opened).toBe(opened)
    expect(quiet.draft).toBe(draft)
    expect(quiet.conflicts).toEqual([])
    // Cash on hand was updated on another computer; the user only changed spend.
    const theirs = { ...opened, cashOnHand: 900_000, cashAsOf: '2026-10-09' }
    const m = mergeIncoming(opened, draft, theirs)
    expect(m.draft).toEqual({ cashOnHand: 900_000, cashAsOf: '2026-10-09', otherMonthlySpend: 60_000 })
    expect(m.conflicts).toEqual([])
    // So Save writes only spend, and the newer cash figure stays.
    expect(changedKeys(m.opened, m.draft)).toEqual(['otherMonthlySpend'])
    // Both changed spend: a conflict until one side is chosen.
    const clash = mergeIncoming(opened, draft, { ...opened, otherMonthlySpend: 55_000 })
    expect(clash.conflicts).toEqual(['otherMonthlySpend'])
    const useTheirs = resolveConflicts(clash, { ...opened, otherMonthlySpend: 55_000 }, clash.conflicts, 'theirs')
    expect(useTheirs.draft.otherMonthlySpend).toBe(55_000)
    expect(changedKeys(useTheirs.opened, useTheirs.draft)).toEqual([])
    const keepMine = resolveConflicts(clash, { ...opened, otherMonthlySpend: 55_000 }, clash.conflicts, 'mine')
    expect(keepMine.draft.otherMonthlySpend).toBe(60_000)
    expect(mergeIncoming(keepMine.opened, keepMine.draft, { ...opened, otherMonthlySpend: 55_000 }).conflicts).toEqual([])
    expect(changedKeys(keepMine.opened, keepMine.draft)).toEqual(['otherMonthlySpend'])
    // The same change on both sides is no conflict and nothing left to save.
    const agreed = mergeIncoming(opened, draft, { ...opened, otherMonthlySpend: 60_000 })
    expect(agreed.conflicts).toEqual([])
    expect(changedKeys(agreed.opened, agreed.draft)).toEqual([])
  })

  it('says what the other computer saved, so Use theirs is not a blind choice (r2-42)', () => {
    expect(conflictValueText('B: close in a day')).toBe('"B: close in a day"')
    expect(conflictValueText('  Monthly  ')).toBe('"Monthly"')
    expect(conflictValueText('2026-10-01')).toBe('Oct 1, 2026')
    expect(conflictValueText(1_200_000)).toBe('1,200,000')
    expect(conflictValueText('')).toBe('blank')
    expect(conflictValueText(null)).toBe('blank')
    // Long text is cut short; lists, records and yes or no are not said (the notice only names the field).
    const long = conflictValueText('AI agents that close the books, reconcile every account and get audits ready in days')
    expect(long).toBe('"AI agents that close the books, reconcile every account..."')
    expect(conflictValueText(['a', 'b'])).toBeNull()
    expect(conflictValueText({ a: 1 })).toBeNull()
    expect(conflictValueText(true)).toBeNull()
    expect(conflictValueText(Number.NaN)).toBeNull()
  })
})

describe('group health plan', () => {
  it('reads the three states', () => {
    expect(healthPlanChoice('2025-05-12')).toBe('yes')
    expect(healthPlanChoice(null)).toBe('no')
    expect(healthPlanChoice(undefined)).toBe('unknown')
  })

  it('needs a past start date when the company offers a plan', () => {
    expect(healthPlanProblem('yes', '', '2026-10-10')).toMatch(/Pick the date/)
    expect(healthPlanProblem('yes', '2026-11-01', '2026-10-10')).toMatch(/future/)
    expect(healthPlanProblem('yes', '2026-10-01', '2026-10-10')).toBeNull()
    expect(healthPlanProblem('no', '', '2026-10-10')).toBeNull()
  })

  it('writes a date, null for no plan, or clears the field', () => {
    const c: { groupHealthPlanStartedOn?: string | null } = {}
    setHealthPlan(c, 'yes', '2025-05-12')
    expect(c.groupHealthPlanStartedOn).toBe('2025-05-12')
    setHealthPlan(c, 'no', '2025-05-12')
    expect(c.groupHealthPlanStartedOn).toBeNull()
    setHealthPlan(c, 'unknown', '')
    expect('groupHealthPlanStartedOn' in c).toBe(false)
  })
})
