import { describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import { DEFAULT_BANDS, DEFAULT_DEPARTMENTS, DEFAULT_FAMILIES, DEFAULT_LEVELS, DEFAULT_STAGES } from '@/data/defaults'
import { SAMPLE_ROLE_TEMPLATES } from '@/data/roleTemplates'
import { buildSampleDB } from '@/data/seed'
import { postingLint, salaryHistoryLint } from '@/domain/hiring/postings'
import type { RoleTemplate } from '@/domain/types'
import { DEFAULT_ROLE_TEMPLATES } from './starterRoleTemplates'

const T = DEFAULT_ROLE_TEMPLATES

/** Every word a template shows: its name, JD, interview steps, attribute names, anchors and questions. */
function allText(t: RoleTemplate): string {
  return [t.name, t.jdOutline, ...t.interviewPlan.flatMap((s) => [s.name, ...s.attributes.flatMap((a) => [a.name, a.anchor ?? '', ...(a.questions ?? [])])])].join('\n')
}

/** What only the sample company (an AI close and reconciliation product for controllers) would say. */
const SAMPLE_COMPANY_WORDS = [/NetSuite/i, /Sage Intacct/i, /QuickBooks/i, /\bQBO\b/, /\bERP\b/, /reconcil/i, /controllers?\b/i, /\bagents?\b/i, /close-agent/i, /\bflux\b/i, /Ledgerlark/i, /financial AI/i]

describe('DEFAULT_ROLE_TEMPLATES (the starters a company that starts fresh gets)', () => {
  it('describes no product, industry or customer of the sample company (the posting goes out with this text)', () => {
    for (const t of T) {
      const text = allText(t)
      for (const re of SAMPLE_COMPANY_WORDS) expect(text, `${t.id} matches ${re}`).not.toMatch(re)
    }
  })

  it('has unique ids and names, on real families, levels and teams with a band for each', () => {
    expect(new Set(T.map((t) => t.id)).size).toBe(T.length)
    expect(new Set(T.map((t) => t.name)).size).toBe(T.length)
    expect(T.length).toBeGreaterThanOrEqual(8)
    for (const t of T) {
      expect(DEFAULT_FAMILIES.some((f) => f.id === t.familyId)).toBe(true)
      expect(DEFAULT_LEVELS.some((l) => l.id === t.levelId)).toBe(true)
      expect(DEFAULT_DEPARTMENTS.some((d) => d.id === t.departmentId)).toBe(true)
      expect(DEFAULT_BANDS.some((b) => b.familyId === t.familyId && b.levelId === t.levelId)).toBe(true)
    }
  })

  it('uses the default stages and SLAs, with the sales role renaming Technical', () => {
    for (const t of T) {
      expect(t.stages.map((s) => [s.id, s.kind, s.slaBusinessDays ?? null])).toEqual(DEFAULT_STAGES.map((s) => [s.id, s.kind, s.slaBusinessDays ?? null]))
      expect(t.stages.find((s) => s.id === 'technical')?.name).toBe(t.id === 'rt-ae-founding' ? 'Mock discovery call' : 'Technical')
    }
  })

  it('has an interview plan on real stages with 3 to 5 attributes, each with an anchor and 2 questions', () => {
    for (const t of T) {
      const ids = new Set<string>()
      for (const s of t.interviewPlan) {
        expect(t.stages.some((st) => st.id === s.stageId)).toBe(true)
        expect(ids.has(s.id)).toBe(false)
        ids.add(s.id)
        expect(s.durationMin).toBeGreaterThan(0)
        expect(s.attributes.length).toBeGreaterThanOrEqual(3)
        expect(s.attributes.length).toBeLessThanOrEqual(5)
        for (const a of s.attributes) {
          expect(a.anchor && a.anchor.length > 20).toBe(true)
          expect(a.questions).toHaveLength(2)
        }
      }
      for (const stage of ['intro', 'technical', 'onsite']) expect(t.interviewPlan.some((s) => s.stageId === stage)).toBe(true)
    }
  })

  it('has JD outlines with the three sections, passing the posting linter and copy rules', () => {
    for (const t of T) {
      expect(t.jdOutline).toContain("What you'll do\n- ")
      expect(t.jdOutline).toContain('\n\nWhat you bring\n- ')
      expect(t.jdOutline).toContain('\n\nNice to have\n- ')
      const text = allText(t)
      expect(postingLint({ payMin: 1, payMax: 2, description: text })).toEqual([])
      expect(salaryHistoryLint(text)).toBeNull()
      expect(text.includes(String.fromCharCode(0x2014)) || text.includes(String.fromCharCode(0x2013))).toBe(false)
      expect(t.name.charAt(0)).toBe(t.name.charAt(0).toUpperCase())
      expect(t.name, t.id).not.toMatch(/\b(CPA|preferred|required)\b/i)
    }
  })
})

describe('which templates a workspace starts with', () => {
  it('Start fresh (blankDB) gets the company-neutral starters, as copies', () => {
    const db = blankDB({ companyName: 'Tidewater Robotics', founderFirstName: 'Rae', founderLastName: 'Okafor', founderEmail: '' })
    expect(db.settings.roleTemplates.map((t) => t.id)).toEqual(T.map((t) => t.id))
    expect(db.settings.roleTemplates[0]).not.toBe(T[0])
    const text = db.settings.roleTemplates.map(allText).join('\n')
    for (const re of SAMPLE_COMPANY_WORDS) expect(text).not.toMatch(re)
  })

  it('the sample keeps its own product-specific set', () => {
    const db = buildSampleDB()
    expect(db.settings.roleTemplates.map((t) => t.id)).toEqual(SAMPLE_ROLE_TEMPLATES.map((t) => t.id))
    expect(db.settings.roleTemplates.some((t) => t.name === 'ML engineer (agents)')).toBe(true)
    // Its jobs were built from those templates (their interview steps came along).
    expect(db.jobs.some((j) => j.interviewPlan.some((s) => /reconciliation/i.test(s.name)))).toBe(true)
  })
})
