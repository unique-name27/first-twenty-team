// The hiring-to-payroll journey, through the real server and database (docs/DEV.md, "Journey tests"): a
// candidate applies on Ledgerlark's careers page; the admin's browser takes the application through an
// interview, a scorecard and an offer to a hire, onboards the new person and submits the first pay run that
// pays them. Every change is the domain function the app's screens call, made in the browser's store and
// synced to the server. Then the read model says the hire is whole, the integrity checks find nothing (in
// SQL and in the browser), the change log holds every write in order under the right login, and a second
// login sees the new person and the pay run. One fixed clock: the app's clock override, moved forward.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setTaskStatus } from '@/domain/checklists/actions'
import {
  advanceApplication,
  applicationLabel,
  approveOffer,
  createOffer,
  lowerFirst,
  markAccepted,
  markSent,
  nextStage,
  offerDefaults,
  proposeTimesFor,
  scheduleInterview,
  sendBlockers,
  submitScorecard,
} from '@/domain/hiring'
import { integrityProblems } from '@/domain/integrity'
import { hireFromOffer } from '@/domain/lifecycle'
import { markPayRunSubmitted, payRunPrep, periodContaining, periodLabel, providerPhrase } from '@/domain/payrun'
import { personNameById } from '@/domain/people'
import type { Offer, Rating } from '@/domain/types'
import { nowISO, pacificDateOf, today } from '@/lib/dates'
import { diffDB } from '../../../src/sync/diff'
import { WORKSPACE_ID } from '../sqlgen'
import { type Journey, startJourney } from './kit'

const JOB = 'Senior full-stack engineer'
const CANDIDATE = {
  name: 'Noor Lindqvist',
  email: 'noor.lindqvist@example.test',
  phone: '408 555 0199',
  link: 'github.com/noor-lindqvist',
  answer: 'I built the reconciliation service our finance team trusted at every close. Property tests caught what reviews missed.',
}

describe('journey: a careers application to a hire, onboarding and the first pay run', () => {
  let j: Journey

  beforeAll(async () => {
    j = await startJourney({ start: '2026-10-09' })
  }, 60_000)
  afterAll(async () => {
    await j?.close()
  })

  it('works end to end through the real server and database', async () => {
    const { admin } = j
    const ws = WORKSPACE_ID

    // ---- The careers page ----------------------------------------------------------------------
    await j.step('a candidate applies on the careers page', async () => {
      // A typo first: the real validation sends the form back with the problem, and nothing is stored.
      const typo = await j.apply({ job: JOB, fields: { ...CANDIDATE, email: 'noor.lindqvist at example.test' } })
      expect(typo.status).toBe(400)
      expect(typo.page).toContain('Enter an email address in the format name@example.com.')
      expect(await j.sql(`SELECT id FROM v_candidates WHERE workspace_id = $1 AND email = $2`, [ws, CANDIDATE.email])).toEqual([])

      const sent = await j.apply({ job: JOB, fields: CANDIDATE })
      expect(sent).toMatchObject({ status: 303, sent: true })
      expect(sent.page).toContain('Thanks for applying')
      // A second click sends the same form again: the same answer, and nothing more is stored.
      expect(await j.apply({ job: JOB, fields: CANDIDATE })).toMatchObject({ status: 303, sent: true })

      const rows = await j.sql(
        `SELECT a.stage_id, a.status, a.applied_on::text AS applied_on, c.source
           FROM v_applications a JOIN v_candidates c ON c.workspace_id = a.workspace_id AND c.id = a.candidate_id
          WHERE a.workspace_id = $1 AND c.email = $2`,
        [ws, CANDIDATE.email],
      )
      expect(rows).toEqual([{ stage_id: 'new', status: 'active', applied_on: '2026-10-09', source: 'inbound' }])
    })

    // ---- The admin's browser: pipeline, interview, scorecard ---------------------------------------
    const appId = await j.step("the admin's browser pulls the application", async () => {
      j.advanceTo('2026-10-12')
      await admin.sync()
      const cand = admin.db().candidates.find((c) => c.email === CANDIDATE.email)
      const app = cand && admin.db().applications.find((a) => a.candidateId === cand.id)
      expect(app).toMatchObject({ jobId: 'j-fullstack', stageId: 'new', status: 'active' })
      return app!.id
    })
    const name = applicationLabel(admin.db(), appId)
    const job = admin.db().jobs.find((x) => x.id === 'j-fullstack')!

    /** Advance (A on the pipeline): the next stage, as src/features/hiring/actions.ts advance() moves it. */
    const advance = async () => {
      const at = admin.db().applications.find((a) => a.id === appId)!
      const next = nextStage(job, at.stageId)!
      await j.act(admin, `Moved ${name} to ${next.name}`, (d) => advanceApplication(d, appId, { date: today(), actorId: admin.viewerId() }))
      return next.id
    }

    const interview = await j.step('moves it to the intro call and schedules the interview', async () => {
      expect(await advance()).toBe('intro')
      const plan = job.interviewPlan.find((s) => s.stageId === 'intro')!
      // The first time the schedule sheet proposes for this panel.
      const [startsAt] = proposeTimesFor(admin.db(), today(), 1, { panelIds: plan.interviewerIds, durationMin: plan.durationMin })
      const id = await j.act(admin, `Scheduled ${lowerFirst(plan.name)} with ${name}`, (d) =>
        scheduleInterview(
          d,
          {
            applicationId: appId,
            stepId: plan.id,
            stageId: plan.stageId,
            name: plan.name,
            startsAt,
            durationMin: plan.durationMin,
            interviewerIds: plan.interviewerIds,
            format: 'video',
            videoLink: 'https://meet.example.test/ledgerlark-intro',
            attributes: plan.attributes,
          },
          { date: today() },
        ),
      )
      const owed = admin.db().scorecards.filter((s) => s.interviewId === id)
      expect(owed.map((s) => s.interviewerId).sort()).toEqual([...plan.interviewerIds].sort())
      return admin.db().interviews.find((i) => i.id === id)!
    })

    await j.step("enters the interviewer's scorecard after the interview", async () => {
      j.advanceTo(pacificDateOf(interview.startsAt))
      const card = admin.db().scorecards.find((s) => s.interviewId === interview.id && s.interviewerId === job.hiringManagerId)!
      const ratings = Object.fromEntries(interview.attributes.map((a) => [a, 4 as Rating]))
      const interviewer = personNameById(admin.db(), card.interviewerId, 'the interviewer')
      // An admin entering it for the interviewer, as the scorecard sheet does (enteredById).
      await j.act(admin, `Entered ${interviewer}'s scorecard for ${name}`, (d) =>
        submitScorecard(d, card.id, { ratings, overall: 4, notes: 'Clear on testing money code. Strong yes.', enteredById: admin.viewerId() }, nowISO()),
      )
      expect(admin.db().interviews.find((i) => i.id === interview.id)?.status).toBe('completed')
    })

    await j.step('moves it through the technical and onsite stages to the offer stage', async () => {
      j.advanceTo('2026-10-14')
      expect(await advance()).toBe('technical')
      expect(await advance()).toBe('onsite')
      j.advanceTo('2026-10-15')
      expect(await advance()).toBe('offer')
    })

    // ---- The offer and the hire ----------------------------------------------------------------
    const offerId = await j.step('drafts the offer, approves it and sends it', async () => {
      // As the offer builder saves a new offer from its defaults (OfferBuilder.tsx save).
      const draft = {
        ...(offerDefaults(admin.db(), appId, today()) as Omit<Offer, 'id'>),
        draftedById: admin.viewerId(),
        draftedByRole: admin.viewAs.role,
        status: 'draft',
        createdOn: today(),
        approvals: [],
      } satisfies Omit<Offer, 'id'>
      const created = await j.act(admin, `Drafted an offer for ${name}`, (d) => createOffer(d, draft))
      if (!created.ok) throw new Error(created.reason)
      const id = created.id
      await j.act(admin, `Approved the offer for ${name}`, (d) => approveOffer(d, id, { approverId: admin.viewerId(), at: nowISO() }))
      const offer = admin.db().offers.find((o) => o.id === id)!
      expect(sendBlockers(admin.db(), offer, today())).toEqual([])
      await j.act(admin, `Marked the offer to ${name} sent`, (d) => markSent(d, id, { date: today() }))
      expect(admin.db().grants.some((g) => g.fromOfferId === id && g.status === 'reserved')).toBe(true)
      return id
    })

    const personId = await j.step('records the acceptance and hires from the offer', async () => {
      j.advanceTo('2026-10-16')
      await j.act(admin, `Recorded that ${name} accepted the offer`, (d) => markAccepted(d, offerId, { date: today() }))
      const next = Math.max(...admin.db().people.map((p) => p.hireNumber)) + 1
      const id = await j.act(admin, `Hired ${name} as employee #${next}`, (d) => hireFromOffer(d, offerId, { date: today(), actorId: admin.viewerId() }))
      const db = admin.db()
      const offer = db.offers.find((o) => o.id === offerId)!
      expect(db.people.find((p) => p.id === id)).toMatchObject({ hireNumber: next, fromApplicationId: appId, startDate: offer.startDate })
      expect(db.comp.filter((c) => c.personId === id)).toMatchObject([{ reason: 'hire', salary: offer.salary, effectiveOn: offer.startDate }])
      expect(db.applications.find((a) => a.id === appId)).toMatchObject({ status: 'hired', stageId: 'hired' })
      return id
    })
    const startDate = admin.db().people.find((p) => p.id === personId)!.startDate

    // ---- Onboarding ----------------------------------------------------------------------------
    await j.step('completes the onboarding checklist from the first day', async () => {
      const checklist = admin.db().checklists.find((c) => c.personId === personId && c.kind === 'onboarding')
      expect(checklist?.tasks.length).toBeGreaterThan(0)
      j.advanceTo(startDate)
      // One tap per task, as the task row's Done button marks it (src/features/people/parts.tsx).
      for (const task of checklist!.tasks.filter((t) => t.status === 'open')) {
        await j.act(admin, `Marked done: ${task.title}`, (d) => setTaskStatus(d, checklist!.id, task.id, 'done', { date: today(), byId: admin.viewerId() }))
      }
      const done = admin.db().checklists.find((c) => c.id === checklist!.id)!
      expect(done.tasks.filter((t) => t.status === 'open')).toEqual([])
      expect(done.completedOn).toBe(startDate)
    })

    // ---- The first pay run ---------------------------------------------------------------------
    const period = periodContaining(admin.db(), startDate)
    await j.step('prepares and submits the first pay run that pays them', async () => {
      j.advanceTo(period.cutoff)
      const prep = payRunPrep(admin.db(), period, today())
      expect(prep.status).toBe('open')
      const offer = admin.db().offers.find((o) => o.id === offerId)!
      const row = prep.rows.find((r) => r.personId === personId)
      expect(row).toMatchObject({ startInPeriod: startDate, payType: 'salary', rate: offer.salary })
      expect(row!.estimatedGross).toBeGreaterThan(0)
      expect(row!.flags.filter((f) => f.tone === 'bad')).toEqual([])
      const label = `Marked the ${periodLabel(period)} payroll submitted to ${providerPhrase(admin.db().company)}`
      await j.act(admin, label, (d) => markPayRunSubmitted(d, period, { date: today(), actorId: admin.viewerId() }))
      expect(payRunPrep(admin.db(), period, today()).status).toBe('submitted')
    })

    // ---- What the server holds, in SQL over the read model -------------------------------------
    await j.step('the read model shows one complete hire', async () => {
      const offer = admin.db().offers.find((o) => o.id === offerId)!
      const comp = admin.db().comp.find((c) => c.personId === personId && c.reason === 'hire')!
      const checklist = admin.db().checklists.find((c) => c.personId === personId && c.kind === 'onboarding')!
      const rows = await j.sql(
        `SELECT job_id, application_id, candidate_name, applied_on::text, hired_on::text, offer_id, offer_accepted_on::text, offer_salary::float8,
                person_id, start_date::text, hire_comp_id, hire_salary::float8, onboarding_checklist_id, onboarding_tasks_open,
                onboarding_completed_on::text, first_pay_period_start::text, first_payday::text
           FROM v_hire_journey WHERE workspace_id = $1 AND (application_id = $2 OR person_id = $3)`,
        [ws, appId, personId],
      )
      expect(rows).toEqual([
        {
          job_id: 'j-fullstack',
          application_id: appId,
          candidate_name: CANDIDATE.name,
          applied_on: '2026-10-09',
          hired_on: '2026-10-16',
          offer_id: offerId,
          offer_accepted_on: '2026-10-16',
          offer_salary: offer.salary,
          person_id: personId,
          start_date: startDate,
          hire_comp_id: comp.id,
          hire_salary: offer.salary,
          onboarding_checklist_id: checklist.id,
          onboarding_tasks_open: 0,
          onboarding_completed_on: startDate,
          first_pay_period_start: period.start,
          first_payday: period.payday,
        },
      ])
      expect(await j.sql(`SELECT employment_state, title, salary::float8 FROM v_current_job WHERE workspace_id = $1 AND id = $2`, [ws, personId])).toEqual([
        { employment_state: 'active', title: offer.title, salary: offer.salary },
      ])
    })

    await j.step('the integrity checks find nothing, in SQL and in the browser', async () => {
      expect(await j.sql(`SELECT code, collection, record_id, field FROM v_integrity_problems WHERE workspace_id = $1`, [ws])).toEqual([])
      expect(integrityProblems(admin.db())).toEqual([])
    })

    await j.step('the change log holds every write in order, under the right login', async () => {
      const db = admin.db()
      const cand = db.candidates.find((c) => c.email === CANDIDATE.email)!
      const ids = {
        candidate: cand.id,
        application: appId,
        interview: interview.id,
        offer: offerId,
        person: personId,
        comp: db.comp.find((c) => c.personId === personId && c.reason === 'hire')!.id,
        checklist: db.checklists.find((c) => c.personId === personId && c.kind === 'onboarding')!.id,
      }
      const log = await j.sql<{ seq: number; collection: string; record_id: string; user_id: string | null }>(
        `SELECT seq::int AS seq, collection, record_id, user_id::text AS user_id FROM change_log
          WHERE workspace_id = $1
            AND seq >= (SELECT min(seq) FROM change_log WHERE workspace_id = $1 AND record_id = $2)
            AND (record_id = ANY($3::text[]) OR (collection = '$doc' AND record_id = 'company'))
          ORDER BY seq`,
        [ws, ids.candidate, Object.values(ids)],
      )
      // The careers form wrote the candidate and the application, with no login; every later write is the admin's.
      expect(log.slice(0, 2).map((r) => [r.collection, r.record_id, r.user_id])).toEqual([
        ['candidates', ids.candidate, null],
        ['applications', ids.application, null],
      ])
      const later = log.slice(2)
      expect(later.length).toBeGreaterThan(0)
      expect(later.filter((r) => r.user_id !== admin.userId)).toEqual([])
      // Each record first reached the server in the order the journey made it; the pay run is the last write.
      const firsts: string[] = []
      for (const r of log) {
        const key = r.collection === '$doc' ? '$doc company' : r.record_id
        if (!firsts.includes(key)) firsts.push(key)
      }
      const order = [ids.candidate, ids.application, ids.interview, ids.offer, ids.person, ids.comp, ids.checklist]
      expect(firsts.filter((k) => order.includes(k))).toEqual(order)
      expect(log[log.length - 1]).toMatchObject({ collection: '$doc', record_id: 'company', user_id: admin.userId })

      // The activity rows say who did it in the company: nobody for the careers form, the admin's person
      // (Viewing as Admin: the founder) for everything the admin's browser did.
      const actors = await j.sql(
        `SELECT user_id::text AS user_id, data ->> 'actorId' AS actor_id, count(*)::int AS rows FROM change_log
          WHERE workspace_id = $1 AND collection = 'activity' AND seq >= $2
          GROUP BY 1, 2 ORDER BY 1 NULLS FIRST, 2`,
        [ws, log[0].seq],
      )
      expect(actors).toEqual([
        { user_id: null, actor_id: null, rows: 3 },
        { user_id: admin.userId, actor_id: admin.viewerId(), rows: expect.any(Number) },
      ])
    })

    // ---- A second login ------------------------------------------------------------------------
    await j.step('a second login, invited the normal way, sees the new person and the pay run', async () => {
      const ops = await j.invite('second login', 'people.ops@example.test')
      expect(ops.userId).not.toBe(admin.userId)
      expect(ops.db().people.find((p) => p.id === personId)).toEqual(admin.db().people.find((p) => p.id === personId))
      expect(ops.db().company.payRuns?.find((r) => r.periodStart === period.start)).toMatchObject({ payday: period.payday, submittedOn: period.cutoff })
      // Opening a workspace applies the changes whose date has come (applyLoadChanges): here a raise in the
      // sample that took effect after the admin's browser opened the workspace. The second browser sends it,
      // the admin's takes it, and the two copies agree.
      await admin.sync()
      expect(diffDB(admin.db(), ops.db())).toEqual([])
    })
  }, 120_000)
})
