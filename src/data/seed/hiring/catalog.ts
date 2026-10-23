// The Ledgerlark hiring story as data (docs/SAMPLE.md): historical filled jobs with each hire's own
// timeline and offer, the open jobs and their pipelines, and the plan slots. Dates are hand-picked
// business days around the anchor, Friday 2026-10-09. Everything here is fictional.
// Module rule: functions only (no module-level runtime constants); see rng.ts.
import type { EmploymentType, FLSA, ID, Job, OutcomeReason, Role, SourceKind, WorkMode } from '@/domain/types'
import type { ISODate } from '@/lib/dates'
import type { ProfileKey } from './pools'

export type DeptKey = 'exec' | 'eng' | 'ai' | 'product' | 'gtm' | 'acct' | 'ops'
export type LocKey = 'hq' | 'remote-ca' | 'remote-tx'
export type StageKey = 'new' | 'intro' | 'technical' | 'onsite' | 'offer'
export type Bias = 'hire' | 'strong' | 'mixed' | 'weak'

export type StepSpec = { stageId: string; name: string; durationMin: number; attrs: string[]; interviewerIds: ID[] }

export type JobSpec = {
  id: ID
  title: string
  familyId: ID
  levelId: ID
  dept: DeptKey
  hmId: ID
  panelIds: ID[]
  locs: LocKey[]
  workMode: WorkMode
  employmentType?: EmploymentType
  flsa?: FLSA
  payMin: number | null
  payMax: number | null
  equityMinPct?: number
  equityMaxPct?: number
  status: Job['status']
  openedOn: ISODate
  postedOn?: ISODate
  targetStart?: ISODate
  planSlotId?: ID
  roleTemplateId?: ID
  isBackfill?: boolean
  backfillForPersonId?: ID
  /** Renames the Technical stage (the sales roles use 'Mock discovery call'). */
  technicalName?: string
  /** Pipelines without a Technical stage (the office coordinator). */
  skipTechnical?: boolean
  /** Explicit interview plan. Without it the role template's plan is used with `stepPanels`. */
  plan?: StepSpec[]
  /** Interviewers per template step, in template order (used when `plan` is not given). */
  stepPanels?: ID[][]
  /** Keep only these template steps (indexes), e.g. one onsite step for a small panel. */
  keepSteps?: number[]
  description?: string
  sponsorship: Job['sponsorship']
  backgroundCheck: boolean
  priority: Job['priority']
  referralBonus?: number
  profile: ProfileKey
  /** Inbound board names for this job's applicants. */
  boards?: string[]
}

export type OfferDecline = { salary: number; equity: number; sentOn: ISODate; decidedOn: ISODate; declineReason: OutcomeReason; competingNote: string }

export type OtherSpec = {
  name?: [string, string]
  reached: StageKey
  status: 'rejected' | 'withdrawn'
  reason: OutcomeReason
  note?: string
  keepWarm?: boolean
  source?: SourceKind
  sourceDetail?: string
  referrerId?: ID
  place?: [string, string]
  currentTitle?: string
  currentCompany?: string
  summary?: string
  sponsorship?: 'yes' | 'no' | 'unknown'
  offer?: OfferDecline
}

export type HireCand = {
  source: SourceKind
  sourceDetail?: string
  referrerId?: ID
  place: [string, string]
  currentTitle: string
  currentCompany: string
  summary: string
  desiredPay?: number
  sponsorship?: 'yes' | 'no' | 'unknown'
  phone?: string
  portfolio?: boolean
  tags?: string[]
}

export type HireOffer = {
  title: string
  salary?: number
  hourlyRate?: number
  variablePct?: number
  /** A sign-on bonus, paid with the first check (only on hires that go through the real Hire flow). */
  signOnBonus?: number
  equity: number
  hoursPerWeek?: number
  draftedById: ID
  draftedByRole: Role
  approverId?: ID
  managerId: ID
}

export type HireSpec = {
  key: string
  personId: ID
  first: string
  last: string
  job: JobSpec
  applied: ISODate
  accepted: ISODate
  start: ISODate
  cand: HireCand
  offer: HireOffer
  /** Totals for the whole search, including the applications kept on record. */
  funnel: { applied: number; intro: number; technical: number; onsite: number; offers: number }
  others: OtherSpec[]
  /** Incoming hires (Lucas, Mei) go through the real offer and Hire flow. */
  viaHireFlow?: boolean
}

export type InterviewSpec = {
  /** Index into the job's interview plan. */
  step: number
  date: ISODate
  hour: number
  minute?: number
  status: 'completed' | 'scheduled'
  scorecards: 'submitted' | 'owed'
  interviewers?: ID[]
  bias: Bias
  icsIssuedOn?: ISODate
}

export type ActiveSpec = {
  name?: [string, string]
  /** Reuse an existing candidate (a re-engaged silver medalist). */
  candidateId?: ID
  source?: SourceKind
  sourceDetail?: string
  referrerId?: ID
  applied: ISODate
  /** Stage entries after New: [stageId, date, byId]. */
  moves?: Array<[string, ISODate, ID]>
  interviews?: InterviewSpec[]
  next: { text: string; dueOn: ISODate; ownerId: ID }
  snoozedUntil?: ISODate
  lastContactOn?: ISODate
  place?: [string, string]
  currentTitle?: string
  currentCompany?: string
  summary?: string
  desiredPay?: number
  sponsorship?: 'yes' | 'no' | 'unknown'
  tags?: string[]
}

export type ClosedMix = { reached: StageKey; status: 'rejected' | 'withdrawn'; reason: OutcomeReason; count: number; note?: string; keepWarm?: boolean }

export type Pipeline = { jobId: ID; active: ActiveSpec[]; closed: ClosedMix[]; referrers: ID[] }

export type PlanSpec = {
  id: ID
  quarter: string
  title: string
  dept: DeptKey
  familyId: ID
  levelId: ID
  targetStart: ISODate
  budgetBase?: number
  /**
   * The stored status before the hire flow runs. A line a seeded hire fills through hireFromOffer is
   * 'open' (as openJobFromPlan leaves it), since Hire takes only a line nobody holds yet; it reads
   * 'filled' with the person on it once the hire is recorded. 'filled' here needs the personId.
   */
  status: 'planned' | 'open' | 'offer' | 'filled' | 'cut'
  jobId: ID
  personId?: ID
  isBackfill?: boolean
  backfillForPersonId?: ID
  rationale: string
}

// ---------------------------------------------------------------------------------------------
// Start and end dates from the roster (docs/SAMPLE.md), used to keep interview panels honest even
// when a fixture leaves people out.
// ---------------------------------------------------------------------------------------------

export function rosterDates(): Record<ID, { start: ISODate; end?: ISODate }> {
  return {
    'p-founder': { start: '2025-02-03' },
    'p-tomas': { start: '2025-05-12' },
    'p-priya': { start: '2025-06-09' },
    'p-elena': { start: '2025-08-18' },
    'p-kofi': { start: '2025-10-06' },
    'p-sofia': { start: '2026-01-12' },
    'p-caleb': { start: '2026-03-02' },
    'p-hannah': { start: '2026-03-16' },
    'p-nikhil': { start: '2026-04-13' },
    'p-omar': { start: '2026-05-04', end: '2026-08-28' },
    'p-jasmine': { start: '2026-06-01' },
    'p-chris': { start: '2026-07-13' },
    'p-luis': { start: '2026-07-20' },
    'p-ravi': { start: '2026-08-10' },
    'p-aisha': { start: '2026-09-08' },
  }
}

// ---------------------------------------------------------------------------------------------
// Plan to 20
// ---------------------------------------------------------------------------------------------

export function planSpecs(): PlanSpec[] {
  return [
    { id: 'ps-q3-solutions', quarter: '2026-Q3', title: 'Solutions engineer', dept: 'acct', familyId: 'f-solutions', levelId: 'lv-l3', targetStart: '2026-07-06', budgetBase: 170_000, status: 'filled', jobId: 'j-solutions-eng', personId: 'p-chris', rationale: 'Sales needs a technical partner for NetSuite demos and security reviews.' },
    { id: 'ps-q3-staff-swe', quarter: '2026-Q3', title: 'Staff software engineer', dept: 'eng', familyId: 'f-eng', levelId: 'lv-l4', targetStart: '2026-08-03', budgetBase: 235_000, status: 'filled', jobId: 'j-staff-swe', personId: 'p-ravi', rationale: 'Senior technical lead for the agent platform as the team passes ten engineers.' },
    { id: 'ps-q3-csm', quarter: '2026-Q3', title: 'Customer success manager', dept: 'gtm', familyId: 'f-gtm', levelId: 'lv-l2', targetStart: '2026-09-08', budgetBase: 140_000, status: 'filled', jobId: 'j-csm', personId: 'p-aisha', rationale: 'Fourteen paying customers need an accounting-literate owner after go-live.' },
    { id: 'ps-q3-data-backfill', quarter: '2026-Q3', title: 'Senior data engineer (backfill)', dept: 'eng', familyId: 'f-eng', levelId: 'lv-l3', targetStart: '2026-09-28', budgetBase: 190_000, status: 'open', jobId: 'j-data-eng-backfill', isBackfill: true, backfillForPersonId: 'p-omar', rationale: 'Backfill for Omar Haddad, who left on Aug 28. ERP connectors cannot wait.' },
    { id: 'ps-q4-ml-agents', quarter: '2026-Q4', title: 'Senior ML engineer, agents', dept: 'ai', familyId: 'f-ml', levelId: 'lv-l3', targetStart: '2026-11-02', budgetBase: 225_000, status: 'open', jobId: 'j-ml-agents', rationale: 'Second engineer on the reconciliation and accrual agents.' },
    { id: 'ps-q4-staff-ml', quarter: '2026-Q4', title: 'Staff ML engineer, agents and evals', dept: 'ai', familyId: 'f-ml', levelId: 'lv-l4', targetStart: '2026-11-30', budgetBase: 255_000, status: 'open', jobId: 'j-staff-ml', rationale: 'Technical lead for agent quality: evals, error analysis and safety reviews.' },
    { id: 'ps-q4-fullstack', quarter: '2026-Q4', title: 'Senior full-stack engineer', dept: 'eng', familyId: 'f-eng', levelId: 'lv-l3', targetStart: '2026-12-07', budgetBase: 207_000, status: 'open', jobId: 'j-fullstack', rationale: 'The review workspace is the product surface controllers live in during close.' },
    { id: 'ps-q4-solutions-acct', quarter: '2026-Q4', title: 'Solutions accountant (CPA)', dept: 'acct', familyId: 'f-acct', levelId: 'lv-l3', targetStart: '2026-12-14', budgetBase: 185_000, status: 'open', jobId: 'j-solutions-acct', rationale: 'Accounting expert for customer rollouts and eval labeling.' },
    { id: 'ps-q1-ae', quarter: '2027-Q1', title: 'Account executive, mid-market', dept: 'gtm', familyId: 'f-gtm', levelId: 'lv-l3', targetStart: '2027-01-11', budgetBase: 145_000, status: 'open', jobId: 'j-ae', rationale: 'Second quota carrier so Caleb can focus on larger deals. Opened early.' },
    { id: 'ps-q2-pm', quarter: '2027-Q2', title: 'Product manager, close and reconciliation', dept: 'product', familyId: 'f-product', levelId: 'lv-l4', targetStart: '2027-04-05', budgetBase: 215_000, status: 'planned', jobId: 'j-pm', rationale: 'Takes product ownership from Maya as the roadmap grows.' },
    { id: 'ps-q2-em-platform', quarter: '2027-Q2', title: 'Engineering manager, platform', dept: 'eng', familyId: 'f-eng', levelId: 'lv-m1', targetStart: '2027-05-03', budgetBase: 240_000, status: 'planned', jobId: 'j-em-platform', rationale: 'Manager for the platform team once engineering passes ten people.' },
  ]
}

// ---------------------------------------------------------------------------------------------
// Open jobs (docs/SAMPLE.md J1-J6)
// ---------------------------------------------------------------------------------------------

function jd(intro: string, doing: string[], bring: string[], nice: string[], extra?: string): string {
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n')
  return [intro, `What you'll do\n${list(doing)}`, `What you bring\n${list(bring)}`, `Nice to have\n${list(nice)}`, ...(extra ? [extra] : [])].join('\n\n')
}

export function openJobSpecs(): JobSpec[] {
  return [
    {
      id: 'j-staff-ml',
      title: 'Staff ML engineer, agents and evals',
      familyId: 'f-ml',
      levelId: 'lv-l4',
      dept: 'ai',
      hmId: 'p-priya',
      panelIds: ['p-priya', 'p-hannah', 'p-ravi', 'p-tomas'],
      locs: ['hq'],
      workMode: 'hybrid',
      payMin: 225_000,
      payMax: 285_000,
      equityMinPct: 0.0025,
      equityMaxPct: 0.006,
      status: 'open',
      openedOn: '2026-08-24',
      postedOn: '2026-08-25',
      targetStart: '2026-11-30',
      planSlotId: 'ps-q4-staff-ml',
      roleTemplateId: 'rt-ml-agents',
      sponsorship: 'case_by_case',
      backgroundCheck: true,
      priority: 'high',
      referralBonus: 7_500,
      profile: 'ml',
      plan: [
        { stageId: 'intro', name: 'Intro call', durationMin: 30, attrs: ['Motivation for this stage and problem', 'Clear communication', 'Ownership and follow-through'], interviewerIds: ['p-priya'] },
        { stageId: 'technical', name: 'Agent design deep dive', durationMin: 75, attrs: ['Agent and LLM systems design', 'LLM evals and error analysis', 'ML fundamentals and experimentation'], interviewerIds: ['p-hannah', 'p-ravi'] },
        {
          stageId: 'onsite',
          name: 'Onsite loop: evals, systems and safety',
          durationMin: 180,
          attrs: ['LLM evals and error analysis', 'System design', 'Security mindset', 'Explaining agent output to a controller'],
          interviewerIds: ['p-hannah', 'p-ravi', 'p-tomas'],
        },
      ],
      description: jd(
        'Our close agents reconcile bank and card activity, suggest accruals and draft flux commentary for mid-market controllers. You will lead how we measure and improve them, as the technical lead for agent quality.',
        [
          'Set the technical direction for our agents: tool use, retrieval over ledgers and contracts, guardrails and human review before anything posts',
          'Own the eval strategy with the applied AI team: datasets from real closes, model-graded and human-graded evals, and regression gates in CI',
          'Run error analysis on customer data with our accounting team and turn it into measurable accuracy gains',
          'Mentor engineers and raise the bar for how we design, test and ship model changes',
        ],
        [
          '8+ years building production software, including 3+ years shipping ML or LLM systems',
          'Deep experience evaluating model output and a habit of reading examples by hand',
          'Strong Python and system design; comfortable with retrieval, embeddings and LLM APIs',
          'Clear writing and the judgment to say when a model should not act',
        ],
        ['Experience with financial or transactional data', 'Fine-tuning or distillation in production', 'Agents that act inside third-party systems such as ERPs'],
        'Hybrid in San Jose, in the office Tuesday to Thursday. We can support H-1B transfers for people already in H-1B status; we cannot file new cap-subject petitions for this role.',
      ),
    },
    {
      id: 'j-fullstack',
      title: 'Senior full-stack engineer',
      familyId: 'f-eng',
      levelId: 'lv-l3',
      dept: 'eng',
      hmId: 'p-tomas',
      panelIds: ['p-tomas', 'p-kofi', 'p-ravi', 'p-nikhil', 'p-sofia'],
      locs: ['hq'],
      workMode: 'hybrid',
      payMin: 180_000,
      payMax: 235_000,
      equityMinPct: 0.001,
      equityMaxPct: 0.0035,
      status: 'open',
      openedOn: '2026-09-14',
      postedOn: '2026-09-15',
      targetStart: '2026-12-07',
      planSlotId: 'ps-q4-fullstack',
      roleTemplateId: 'rt-fullstack',
      sponsorship: 'case_by_case',
      backgroundCheck: true,
      priority: 'normal',
      profile: 'eng',
      plan: [
        { stageId: 'intro', name: 'Intro call', durationMin: 30, attrs: ['Motivation for this stage and problem', 'Clear communication', 'Ownership and follow-through'], interviewerIds: ['p-tomas', 'p-kofi'] },
        { stageId: 'technical', name: 'Pairing exercise: reconciliation review screen', durationMin: 90, attrs: ['Code quality and craft', 'Frontend craft for dense financial data', 'Clear communication'], interviewerIds: ['p-kofi', 'p-ravi'] },
        {
          stageId: 'onsite',
          name: 'Onsite loop: system design and customer session',
          durationMin: 165,
          attrs: ['System design', 'Security mindset', 'Data modeling and pipelines', 'Product sense'],
          interviewerIds: ['p-tomas', 'p-nikhil', 'p-sofia'],
        },
      ],
      description: jd(
        'Controllers spend close week in our review workspace, approving, editing or rejecting what our agents suggest. You will build it.',
        [
          'Build the review workspace for reconciliations and accruals, from schema and APIs to fast, accessible interfaces for very large tables',
          'Make every number traceable to its source transaction in NetSuite, Sage Intacct or QuickBooks Online',
          'Own features end to end with a small team, including the parts nobody asked for',
          'Join customer calls during close to find and fix what slows controllers down',
        ],
        [
          '5+ years building production web applications, with strong TypeScript and SQL',
          'Comfort across the stack: React, Node or Python services, Postgres',
          'Care for correctness and testing in software people trust with their books',
          'Clear written communication',
        ],
        ['Accounting, fintech or ERP software experience', 'Interfaces for human review of model output', 'Work under SOC 2 controls'],
        'Hybrid in San Jose, in the office Tuesday to Thursday.',
      ),
    },
    {
      id: 'j-ae',
      title: 'Account executive, mid-market',
      familyId: 'f-gtm',
      levelId: 'lv-l3',
      dept: 'gtm',
      hmId: 'p-caleb',
      panelIds: ['p-caleb', 'p-chris', 'p-aisha', 'p-founder'],
      locs: ['hq', 'remote-ca'],
      workMode: 'hybrid',
      payMin: 130_000,
      payMax: 160_000,
      equityMinPct: 0.0008,
      equityMaxPct: 0.0025,
      status: 'open',
      openedOn: '2026-09-28',
      postedOn: '2026-09-29',
      targetStart: '2027-01-11',
      planSlotId: 'ps-q1-ae',
      roleTemplateId: 'rt-ae-founding',
      technicalName: 'Mock discovery call',
      sponsorship: 'no',
      backgroundCheck: true,
      priority: 'normal',
      profile: 'ae',
      plan: [
        { stageId: 'intro', name: 'Intro call', durationMin: 30, attrs: ['Motivation for this stage and problem', 'Clear communication', 'Coachability'], interviewerIds: ['p-caleb'] },
        { stageId: 'technical', name: 'Mock discovery call with a controller', durationMin: 45, attrs: ['Discovery and qualification', 'Selling to finance leaders', 'Coachability'], interviewerIds: ['p-caleb', 'p-chris'] },
        {
          stageId: 'onsite',
          name: 'Onsite: deal review and CFO business case',
          durationMin: 120,
          attrs: ['Pipeline generation', 'Deal execution and forecasting', 'Selling to finance leaders', 'Ownership and follow-through'],
          interviewerIds: ['p-caleb', 'p-founder', 'p-aisha'],
        },
      ],
      description: jd(
        'Join our founding account executive to sell close and reconciliation agents to controllers and CFOs at mid-market companies.',
        [
          'Run full sales cycles from discovery to signature with finance leaders on NetSuite, Sage Intacct and QuickBooks Online',
          'Build pipeline with outbound, partners, events and customer referrals',
          'Work with our solutions engineer through security reviews and proofs of concept',
          'Help shape the playbook, pricing and forecasting as the team grows',
        ],
        [
          '3+ years closing B2B SaaS, ideally selling to finance or accounting teams',
          'A record of creating your own pipeline and hitting quota',
          'Comfort talking about close, reconciliations and audit with a controller',
          'Coachability and follow-through',
        ],
        ['Selling into NetSuite or Sage Intacct customers', 'Accounting or audit background'],
        'On-target earnings are twice the base salary, with commission paid under a written plan. Hybrid in San Jose or remote in California.',
      ),
    },
    {
      id: 'j-solutions-acct',
      title: 'Solutions accountant (CPA)',
      familyId: 'f-acct',
      levelId: 'lv-l3',
      dept: 'acct',
      hmId: 'p-elena',
      panelIds: ['p-elena', 'p-chris', 'p-hannah', 'p-aisha'],
      locs: ['hq'],
      workMode: 'hybrid',
      payMin: 165_000,
      payMax: 205_000,
      equityMinPct: 0.001,
      equityMaxPct: 0.003,
      status: 'open',
      openedOn: '2026-10-01',
      postedOn: '2026-10-02',
      targetStart: '2026-12-14',
      planSlotId: 'ps-q4-solutions-acct',
      roleTemplateId: 'rt-accounting-lead',
      sponsorship: 'no',
      backgroundCheck: true,
      priority: 'normal',
      profile: 'acct',
      plan: [
        { stageId: 'intro', name: 'Intro call', durationMin: 30, attrs: ['Motivation for this stage and problem', 'Clear communication', 'Ownership and follow-through'], interviewerIds: ['p-elena'] },
        { stageId: 'technical', name: 'Technical accounting and reconciliation case', durationMin: 75, attrs: ['Technical accounting (ASC 606, accruals, stock comp)', 'Accounting judgment (accruals, reconciliations, flux)', 'Clear communication'], interviewerIds: ['p-elena', 'p-chris'] },
        {
          stageId: 'onsite',
          name: 'Onsite: agent output review and customer session',
          durationMin: 150,
          attrs: ['Explaining agent output to a controller', 'LLM evals and error analysis', 'Customer relationships and retention', 'Finance systems (NetSuite, Sage Intacct, QBO)'],
          interviewerIds: ['p-elena', 'p-hannah', 'p-aisha'],
        },
      ],
      description: jd(
        'Be the accounting expert in the room when customers roll out our close agents, and define what correct means for the models.',
        [
          'Lead the accounting side of customer rollouts: chart of accounts mapping, reconciliation rules and accrual policies',
          'Review agent output with the applied AI team and label the data our evals run on',
          'Help controllers trust and adopt the agents during their first closes',
          'Write the playbooks that make the next rollout faster',
        ],
        [
          'Active CPA license and 4+ years across public accounting and industry',
          'Hands-on month-end close and reconciliation experience, ideally on NetSuite or Sage Intacct',
          'Clear explanations for controllers, auditors and engineers alike',
          'Curiosity about AI and how it changes accounting work',
        ],
        ['Big Four audit or advisory experience', 'Implementation or consulting work', 'SQL or advanced spreadsheet skills'],
        'Hybrid in San Jose, in the office Tuesday to Thursday.',
      ),
    },
    {
      id: 'j-pm',
      title: 'Product manager, close and reconciliation',
      familyId: 'f-product',
      levelId: 'lv-l4',
      dept: 'product',
      hmId: 'p-founder',
      panelIds: ['p-founder', 'p-sofia', 'p-tomas', 'p-elena'],
      locs: ['hq'],
      workMode: 'hybrid',
      payMin: null,
      payMax: null,
      status: 'draft',
      openedOn: '2026-10-05',
      targetStart: '2027-04-05',
      planSlotId: 'ps-q2-pm',
      roleTemplateId: 'rt-pm-close',
      stepPanels: [['p-founder'], ['p-founder', 'p-sofia'], ['p-elena'], ['p-tomas', 'p-sofia']],
      sponsorship: 'case_by_case',
      backgroundCheck: true,
      priority: 'normal',
      profile: 'pm',
    },
    {
      id: 'j-em-platform',
      title: 'Engineering manager, platform',
      familyId: 'f-eng',
      levelId: 'lv-m1',
      dept: 'eng',
      hmId: 'p-tomas',
      panelIds: ['p-tomas', 'p-ravi', 'p-nikhil', 'p-founder'],
      locs: ['hq'],
      workMode: 'hybrid',
      payMin: 215_000,
      payMax: 265_000,
      equityMinPct: 0.003,
      equityMaxPct: 0.007,
      status: 'on_hold',
      openedOn: '2026-08-31',
      postedOn: '2026-09-01',
      targetStart: '2027-05-03',
      planSlotId: 'ps-q2-em-platform',
      roleTemplateId: 'rt-fullstack',
      sponsorship: 'case_by_case',
      backgroundCheck: true,
      priority: 'normal',
      profile: 'em',
      plan: [
        { stageId: 'intro', name: 'Intro call', durationMin: 30, attrs: ['Motivation for this stage and problem', 'Clear communication', 'Ownership and follow-through'], interviewerIds: ['p-tomas'] },
        { stageId: 'technical', name: 'System design: platform for close agents', durationMin: 75, attrs: ['System design', 'Security mindset', 'Code quality and craft'], interviewerIds: ['p-ravi', 'p-nikhil'] },
        {
          stageId: 'onsite',
          name: 'Onsite: people leadership and delivery',
          durationMin: 150,
          attrs: ['Collaboration with engineering and product', 'Ownership and follow-through', 'Prioritization and roadmap judgment', 'Clear communication'],
          interviewerIds: ['p-tomas', 'p-founder', 'p-kofi'],
        },
      ],
      description: jd(
        'Lead the platform team that runs our close agents for every customer during the same few days each month. On hold until the second quarter of 2027.',
        [
          'Manage and grow a team of four to six engineers working on the agent job runner, ERP connectors and data platform',
          'Own reliability during close week, with clear on-call and incident practices',
          'Partner with product and applied AI on the roadmap and make tradeoffs explicit',
          'Hire well and help engineers grow into leads',
        ],
        [
          '3+ years managing software engineers, after 5+ years as an engineer',
          'Experience running distributed systems or data platforms in production',
          'Calm, direct communication and good judgment under pressure',
          'Comfort working under SOC 2 controls',
        ],
        ['Fintech or accounting software experience', 'Managed through a hiring ramp at an early-stage company'],
      ),
    },
  ]
}

// ---------------------------------------------------------------------------------------------
// Historical filled jobs and their hires (hires 2-17)
// ---------------------------------------------------------------------------------------------

function filledJob(j: Omit<JobSpec, 'status' | 'sponsorship' | 'priority' | 'workMode' | 'locs'> & Partial<Pick<JobSpec, 'sponsorship' | 'priority' | 'workMode' | 'locs'>>): JobSpec {
  return { status: 'filled', sponsorship: 'case_by_case', priority: 'normal', workMode: 'hybrid', locs: ['hq'], ...j }
}

export function historicalHires(): HireSpec[] {
  return [
    {
      key: 'tomas',
      personId: 'p-tomas',
      first: 'Tomas',
      last: 'Herrera',
      job: filledJob({ id: 'j-founding-eng', title: 'Founding engineer', familyId: 'f-eng', levelId: 'lv-l4', dept: 'eng', hmId: 'p-founder', panelIds: ['p-founder'], payMin: 170_000, payMax: 210_000, equityMinPct: 0.0075, equityMaxPct: 0.015, openedOn: '2025-03-10', postedOn: '2025-03-11', roleTemplateId: 'rt-fullstack', stepPanels: [['p-founder'], ['p-founder'], ['p-founder'], ['p-founder']], backgroundCheck: false, profile: 'eng', priority: 'high' }),
      applied: '2025-03-17',
      accepted: '2025-04-18',
      start: '2025-05-12',
      cand: { source: 'referral', sourceDetail: 'Founder network', place: ['San Jose, CA', 'America/Los_Angeles'], currentTitle: 'Staff software engineer', currentCompany: 'Corvid Data', summary: 'Former colleague of Maya on a small-business accounting product, where he led the bank feed and reconciliation services. 11 years of backend and web work.', desiredPay: 185_000, sponsorship: 'no' },
      offer: { title: 'Founding engineer', salary: 185_000, equity: 150_000, draftedById: 'p-founder', draftedByRole: 'admin', managerId: 'p-founder' },
      funnel: { applied: 64, intro: 14, technical: 6, onsite: 3, offers: 1 },
      others: [
        { reached: 'onsite', status: 'withdrawn', reason: 'chose_other_offer', note: 'Took a Series B offer with a larger cash salary.' },
        { reached: 'technical', status: 'rejected', reason: 'skills_gap', note: 'Strong frontend, little backend or data work.' },
      ],
    },
    {
      key: 'priya',
      personId: 'p-priya',
      first: 'Priya',
      last: 'Nair',
      job: filledJob({ id: 'j-founding-ml', title: 'Founding ML engineer', familyId: 'f-ml', levelId: 'lv-l4', dept: 'ai', hmId: 'p-founder', panelIds: ['p-founder', 'p-tomas'], payMin: 180_000, payMax: 220_000, equityMinPct: 0.005, equityMaxPct: 0.0125, openedOn: '2025-04-07', postedOn: '2025-04-08', roleTemplateId: 'rt-ml-agents', stepPanels: [['p-founder'], ['p-founder'], ['p-founder'], ['p-founder']], backgroundCheck: false, profile: 'ml', priority: 'high' }),
      applied: '2025-04-14',
      accepted: '2025-05-16',
      start: '2025-06-09',
      cand: { source: 'referral', sourceDetail: 'Founder network', place: ['Sunnyvale, CA', 'America/Los_Angeles'], currentTitle: 'Senior ML engineer', currentCompany: 'Northbeam Labs', summary: 'Introduced by an angel investor. Built document extraction and invoice matching models for AP automation, with a strong eval habit.', desiredPay: 195_000, sponsorship: 'no' },
      offer: { title: 'Founding ML engineer', salary: 195_000, equity: 102_000, draftedById: 'p-founder', draftedByRole: 'admin', managerId: 'p-founder' },
      funnel: { applied: 88, intro: 16, technical: 7, onsite: 3, offers: 1 },
      others: [
        { reached: 'onsite', status: 'withdrawn', reason: 'comp', note: 'Needed more cash than a pre-seed company could offer.' },
        { reached: 'intro', status: 'rejected', reason: 'not_a_fit_level', note: 'Research focus; little production experience.' },
      ],
    },
    {
      key: 'elena',
      personId: 'p-elena',
      first: 'Elena',
      last: 'Vasquez',
      job: filledJob({ id: 'j-head-accounting', title: 'Head of accounting (CPA)', familyId: 'f-acct', levelId: 'lv-m1', dept: 'acct', hmId: 'p-founder', panelIds: ['p-founder', 'p-tomas', 'p-priya'], payMin: 165_000, payMax: 195_000, equityMinPct: 0.003, equityMaxPct: 0.0075, openedOn: '2025-05-27', postedOn: '2025-05-28', roleTemplateId: 'rt-accounting-lead', stepPanels: [['p-founder'], ['p-founder'], ['p-founder'], ['p-priya', 'p-tomas']], backgroundCheck: false, profile: 'acct' }),
      applied: '2025-06-09',
      accepted: '2025-07-18',
      start: '2025-08-18',
      cand: { source: 'referral', sourceDetail: 'Founder network', place: ['Campbell, CA', 'America/Los_Angeles'], currentTitle: 'Controller', currentCompany: 'Halyard Health', summary: 'CPA. Former Big Four audit manager, then controller of a 250-person company on NetSuite with a 6-day close. Introduced through Maya\'s audit network.', desiredPay: 185_000, sponsorship: 'no' },
      offer: { title: 'Head of accounting (CPA)', salary: 182_000, equity: 60_000, draftedById: 'p-founder', draftedByRole: 'admin', managerId: 'p-founder' },
      funnel: { applied: 52, intro: 11, technical: 5, onsite: 3, offers: 1 },
      others: [
        { reached: 'onsite', status: 'rejected', reason: 'position_filled', keepWarm: true, note: 'Excellent technical accountant; revisit for a controller role.' },
        { reached: 'intro', status: 'withdrawn', reason: 'timing', note: 'Staying through her company\'s audit season.' },
      ],
    },
    {
      key: 'kofi',
      personId: 'p-kofi',
      first: 'Kofi',
      last: 'Boateng',
      job: filledJob({ id: 'j-senior-swe', title: 'Senior software engineer', familyId: 'f-eng', levelId: 'lv-l3', dept: 'eng', hmId: 'p-tomas', panelIds: ['p-tomas', 'p-priya', 'p-founder'], payMin: 165_000, payMax: 200_000, equityMinPct: 0.0025, equityMaxPct: 0.006, openedOn: '2025-07-14', postedOn: '2025-07-15', roleTemplateId: 'rt-fullstack', stepPanels: [['p-tomas'], ['p-tomas', 'p-priya'], ['p-tomas'], ['p-founder', 'p-elena']], backgroundCheck: true, profile: 'eng' }),
      applied: '2025-07-28',
      accepted: '2025-09-05',
      start: '2025-10-06',
      cand: { source: 'inbound', sourceDetail: 'Careers page', place: ['San Jose, CA', 'America/Los_Angeles'], currentTitle: 'Senior software engineer', currentCompany: 'Gusto', summary: 'Full-stack TypeScript and Postgres; built payroll tax filing workflows and their review screens.', desiredPay: 180_000, sponsorship: 'no' },
      offer: { title: 'Senior software engineer', salary: 178_000, equity: 52_000, draftedById: 'p-founder', draftedByRole: 'admin', managerId: 'p-tomas' },
      funnel: { applied: 214, intro: 22, technical: 9, onsite: 4, offers: 1 },
      others: [
        { reached: 'onsite', status: 'rejected', reason: 'position_filled', keepWarm: true, note: 'Close second. Strong systems design; reach out for the next backend role.' },
        { reached: 'technical', status: 'rejected', reason: 'skills_gap' },
        { reached: 'new', status: 'rejected', reason: 'location', note: 'Remote only from New York.', place: ['New York, NY', 'America/New_York'] },
      ],
    },
    {
      key: 'sofia',
      personId: 'p-sofia',
      first: 'Sofia',
      last: 'Rossi',
      job: filledJob({ id: 'j-product-designer', title: 'Product designer', familyId: 'f-design', levelId: 'lv-l3', dept: 'product', hmId: 'p-founder', panelIds: ['p-founder', 'p-tomas', 'p-kofi', 'p-elena'], locs: ['hq', 'remote-ca'], payMin: 155_000, payMax: 190_000, equityMinPct: 0.002, equityMaxPct: 0.005, openedOn: '2025-10-06', postedOn: '2025-10-07', roleTemplateId: 'rt-designer', stepPanels: [['p-founder'], ['p-founder', 'p-kofi'], ['p-elena', 'p-founder'], ['p-tomas', 'p-kofi']], backgroundCheck: true, profile: 'design' }),
      applied: '2025-10-20',
      accepted: '2025-11-24',
      start: '2026-01-12',
      cand: { source: 'outbound', sourceDetail: 'LinkedIn Recruiter', place: ['Oakland, CA', 'America/Los_Angeles'], currentTitle: 'Senior product designer', currentCompany: 'Brex', summary: 'Designed expense review and approval flows; portfolio is heavy on dense tables and bulk actions.', desiredPay: 175_000, sponsorship: 'no', portfolio: true },
      offer: { title: 'Product designer', salary: 172_000, equity: 40_000, draftedById: 'p-founder', draftedByRole: 'admin', managerId: 'p-founder' },
      funnel: { applied: 176, intro: 18, technical: 8, onsite: 4, offers: 1 },
      others: [
        { reached: 'technical', status: 'rejected', reason: 'skills_gap', note: 'Portfolio was mostly marketing sites.' },
        { reached: 'onsite', status: 'withdrawn', reason: 'chose_other_offer' },
      ],
    },
    {
      key: 'caleb',
      personId: 'p-caleb',
      first: 'Caleb',
      last: 'Washington',
      job: filledJob({ id: 'j-founding-ae', title: 'Founding account executive', familyId: 'f-gtm', levelId: 'lv-l3', dept: 'gtm', hmId: 'p-founder', panelIds: ['p-founder', 'p-elena', 'p-sofia'], workMode: 'remote', payMin: 125_000, payMax: 150_000, equityMinPct: 0.0015, equityMaxPct: 0.0035, openedOn: '2025-12-01', postedOn: '2025-12-02', roleTemplateId: 'rt-ae-founding', technicalName: 'Mock discovery call', stepPanels: [['p-founder'], ['p-founder', 'p-elena'], ['p-founder'], ['p-elena', 'p-founder']], backgroundCheck: true, profile: 'ae' }),
      applied: '2026-01-05',
      accepted: '2026-02-06',
      start: '2026-03-02',
      cand: { source: 'agency', sourceDetail: 'Bright Path Talent', place: ['Austin, TX', 'America/Chicago'], currentTitle: 'Senior account executive', currentCompany: 'FloQast', summary: 'Sold close management software to mid-market controllers; 124% of quota in 2025. Submitted by Bright Path Talent at a 20% fee.', desiredPay: 140_000, sponsorship: 'no' },
      offer: { title: 'Founding account executive', salary: 140_000, variablePct: 1, equity: 30_000, draftedById: 'p-founder', draftedByRole: 'admin', managerId: 'p-founder' },
      funnel: { applied: 132, intro: 15, technical: 7, onsite: 3, offers: 1 },
      others: [
        { reached: 'onsite', status: 'rejected', reason: 'not_a_fit_level', note: 'Strong closer, but has always had a large SDR team behind them.' },
        { reached: 'intro', status: 'withdrawn', reason: 'comp', note: 'On-target earnings expectations well above the plan.' },
        { reached: 'technical', status: 'rejected', reason: 'skills_gap', source: 'agency', sourceDetail: 'Bright Path Talent' },
      ],
    },
    {
      key: 'hannah',
      personId: 'p-hannah',
      first: 'Hannah',
      last: 'Kim',
      job: filledJob({ id: 'j-applied-ai-evals', title: 'Applied AI engineer (evals)', familyId: 'f-ml', levelId: 'lv-l3', dept: 'ai', hmId: 'p-priya', panelIds: ['p-priya', 'p-tomas', 'p-elena'], payMin: 185_000, payMax: 225_000, equityMinPct: 0.002, equityMaxPct: 0.0045, openedOn: '2026-01-05', postedOn: '2026-01-06', roleTemplateId: 'rt-applied-ai-evals', stepPanels: [['p-priya'], ['p-priya', 'p-tomas'], ['p-priya', 'p-elena'], ['p-elena', 'p-founder']], backgroundCheck: true, profile: 'ml' }),
      applied: '2026-01-12',
      accepted: '2026-02-17',
      start: '2026-03-16',
      cand: { source: 'referral', sourceDetail: 'Employee referral', referrerId: 'p-priya', place: ['Santa Clara, CA', 'America/Los_Angeles'], currentTitle: 'ML engineer, evals', currentCompany: 'Mosswood AI', summary: 'Owns the eval suite for a document QA product; wrote its labeling guidelines with domain experts. Referred by Priya Nair.', desiredPay: 205_000, sponsorship: 'no' },
      offer: { title: 'Applied AI engineer (evals)', salary: 205_000, equity: 40_000, draftedById: 'p-founder', draftedByRole: 'admin', managerId: 'p-priya' },
      funnel: { applied: 241, intro: 20, technical: 9, onsite: 4, offers: 1 },
      others: [
        { reached: 'onsite', status: 'rejected', reason: 'position_filled', keepWarm: true, note: 'Great error analysis. First call for the next evals opening.' },
        { reached: 'technical', status: 'rejected', reason: 'skills_gap', note: 'Relied on one aggregate metric; did not read examples.' },
      ],
    },
    {
      key: 'nikhil',
      personId: 'p-nikhil',
      first: 'Nikhil',
      last: 'Rao',
      job: filledJob({ id: 'j-security', title: 'Security and compliance engineer', familyId: 'f-eng', levelId: 'lv-l3', dept: 'eng', hmId: 'p-tomas', panelIds: ['p-tomas', 'p-kofi', 'p-elena'], payMin: 175_000, payMax: 230_000, equityMinPct: 0.002, equityMaxPct: 0.004, openedOn: '2026-01-26', postedOn: '2026-01-27', roleTemplateId: 'rt-security', stepPanels: [['p-tomas'], ['p-tomas', 'p-kofi'], ['p-elena', 'p-founder'], ['p-kofi', 'p-tomas']], backgroundCheck: true, profile: 'sec' }),
      applied: '2026-02-02',
      accepted: '2026-03-16',
      start: '2026-04-13',
      cand: { source: 'outbound', sourceDetail: 'LinkedIn Recruiter', place: ['Fremont, CA', 'America/Los_Angeles'], currentTitle: 'Senior security engineer', currentCompany: 'Plaid', summary: 'Automated SOC 2 Type II evidence collection and ran the vendor security review program.', desiredPay: 200_000, sponsorship: 'no' },
      offer: { title: 'Security and compliance engineer', salary: 200_000, equity: 35_000, draftedById: 'p-founder', draftedByRole: 'admin', managerId: 'p-tomas' },
      funnel: { applied: 158, intro: 17, technical: 8, onsite: 4, offers: 2 },
      others: [
        {
          name: ['Victor', 'Alvarez'],
          reached: 'offer',
          status: 'withdrawn',
          reason: 'comp',
          note: 'Declined over base salary.',
          source: 'inbound',
          sourceDetail: 'LinkedIn',
          place: ['San Mateo, CA', 'America/Los_Angeles'],
          currentTitle: 'Security engineer',
          currentCompany: 'Coinbase',
          offer: { salary: 215_000, equity: 35_000, sentOn: '2026-03-02', decidedOn: '2026-03-05', declineReason: 'comp', competingNote: 'Wanted $240,000 base, above the $230,000 top of the range.' },
        },
        { reached: 'technical', status: 'rejected', reason: 'skills_gap' },
        { reached: 'new', status: 'rejected', reason: 'location', place: ['Denver, CO', 'America/Denver'] },
      ],
    },
    {
      key: 'omar',
      personId: 'p-omar',
      first: 'Omar',
      last: 'Haddad',
      job: filledJob({ id: 'j-data-eng', title: 'Data engineer', familyId: 'f-eng', levelId: 'lv-l3', dept: 'eng', hmId: 'p-tomas', panelIds: ['p-tomas', 'p-kofi', 'p-priya'], payMin: 170_000, payMax: 210_000, equityMinPct: 0.0015, equityMaxPct: 0.0035, openedOn: '2026-02-16', postedOn: '2026-02-17', roleTemplateId: 'rt-data-erp', stepPanels: [['p-tomas'], ['p-kofi', 'p-tomas'], ['p-priya', 'p-nikhil'], ['p-elena', 'p-kofi']], backgroundCheck: true, profile: 'data' }),
      applied: '2026-03-02',
      accepted: '2026-04-02',
      start: '2026-05-04',
      cand: { source: 'inbound', sourceDetail: 'Wellfound', place: ['San Jose, CA', 'America/Los_Angeles'], currentTitle: 'Data engineer', currentCompany: 'Snowflake', summary: 'Built ingestion pipelines and dbt models for finance data; careful about tests and lineage.', desiredPay: 190_000, sponsorship: 'no' },
      offer: { title: 'Data engineer', salary: 188_000, equity: 30_000, draftedById: 'p-founder', draftedByRole: 'admin', managerId: 'p-tomas' },
      funnel: { applied: 263, intro: 21, technical: 9, onsite: 4, offers: 1 },
      others: [
        {
          name: ['Grace', 'Okafor'],
          reached: 'onsite',
          status: 'rejected',
          reason: 'position_filled',
          keepWarm: true,
          note: 'Very close second. Strong full-stack range; re-engage for the next product engineering role.',
          source: 'inbound',
          sourceDetail: 'Careers page',
          place: ['Santa Clara, CA', 'America/Los_Angeles'],
          currentTitle: 'Senior software engineer',
          currentCompany: 'Ramp',
          summary: 'Full-stack engineer on bill pay and accounting sync; built the QuickBooks Online and NetSuite export screens.',
        },
        { reached: 'intro', status: 'withdrawn', reason: 'no_response' },
      ],
    },
    {
      key: 'jasmine',
      personId: 'p-jasmine',
      first: 'Jasmine',
      last: 'Torres',
      job: filledJob({ id: 'j-finance-people-ops', title: 'Finance and people operations lead', familyId: 'f-ops', levelId: 'lv-l3', dept: 'ops', hmId: 'p-founder', panelIds: ['p-founder', 'p-elena', 'p-nikhil'], payMin: 135_000, payMax: 165_000, equityMinPct: 0.0008, equityMaxPct: 0.0025, openedOn: '2026-03-16', postedOn: '2026-03-17', roleTemplateId: 'rt-ops-people', stepPanels: [['p-founder'], ['p-elena'], ['p-founder', 'p-elena'], ['p-nikhil']], backgroundCheck: true, profile: 'ops' }),
      applied: '2026-03-30',
      accepted: '2026-05-07',
      start: '2026-06-01',
      cand: { source: 'inbound', sourceDetail: 'LinkedIn', place: ['San Jose, CA', 'America/Los_Angeles'], currentTitle: 'Finance and HR manager', currentCompany: 'Paperkite', summary: 'Ran payroll, benefits and compliance for a 45-person startup on a PEO and built its first SOC 2 people controls.', desiredPay: 150_000, sponsorship: 'no' },
      offer: { title: 'Finance and people operations lead', salary: 150_000, equity: 20_000, draftedById: 'p-founder', draftedByRole: 'admin', managerId: 'p-founder' },
      funnel: { applied: 189, intro: 16, technical: 6, onsite: 3, offers: 1 },
      others: [
        { reached: 'onsite', status: 'rejected', reason: 'not_a_fit_level', note: 'Great recruiter, but light on payroll and finance operations.' },
        { reached: 'intro', status: 'withdrawn', reason: 'timing' },
        { reached: 'new', status: 'rejected', reason: 'skills_gap' },
      ],
    },
    {
      key: 'chris',
      personId: 'p-chris',
      first: 'Chris',
      last: 'Nakamura',
      job: filledJob({ id: 'j-solutions-eng', title: 'Solutions engineer', familyId: 'f-solutions', levelId: 'lv-l3', dept: 'acct', hmId: 'p-elena', panelIds: ['p-elena', 'p-caleb', 'p-nikhil', 'p-founder'], payMin: 150_000, payMax: 185_000, equityMinPct: 0.001, equityMaxPct: 0.0025, openedOn: '2026-04-20', postedOn: '2026-04-21', planSlotId: 'ps-q3-solutions', roleTemplateId: 'rt-solutions', stepPanels: [['p-elena'], ['p-caleb', 'p-elena'], ['p-elena', 'p-founder'], ['p-nikhil']], backgroundCheck: true, profile: 'solutions' }),
      applied: '2026-05-04',
      accepted: '2026-06-11',
      start: '2026-07-13',
      cand: { source: 'inbound', sourceDetail: 'Careers page', place: ['Milpitas, CA', 'America/Los_Angeles'], currentTitle: 'Senior consultant, risk advisory', currentCompany: 'Deloitte', summary: 'Big Four advisory on financial systems and controls; led NetSuite and Sage Intacct implementation workstreams.', desiredPay: 170_000, sponsorship: 'no' },
      offer: { title: 'Solutions engineer', salary: 168_000, variablePct: 0.15, equity: 18_000, draftedById: 'p-jasmine', draftedByRole: 'admin', managerId: 'p-elena' },
      funnel: { applied: 147, intro: 15, technical: 7, onsite: 4, offers: 2 },
      others: [
        {
          name: ['Megan', 'Sullivan'],
          reached: 'offer',
          status: 'withdrawn',
          reason: 'location',
          note: 'Decided not to relocate for a hybrid role.',
          source: 'inbound',
          sourceDetail: 'LinkedIn',
          place: ['Seattle, WA', 'America/Los_Angeles'],
          currentTitle: 'Sales engineer',
          currentCompany: 'BlackLine',
          offer: { salary: 172_000, equity: 18_000, sentOn: '2026-05-28', decidedOn: '2026-06-02', declineReason: 'location', competingNote: 'Wanted to stay fully remote in Seattle.' },
        },
        { reached: 'technical', status: 'rejected', reason: 'skills_gap', note: 'Demo was a feature tour.' },
      ],
    },
    {
      key: 'luis',
      personId: 'p-luis',
      first: 'Luis',
      last: 'Ortega',
      job: filledJob({
        id: 'j-office-coordinator',
        title: 'Office and events coordinator (part time)',
        familyId: 'f-ops',
        levelId: 'lv-l1',
        dept: 'ops',
        hmId: 'p-jasmine',
        panelIds: ['p-jasmine', 'p-founder'],
        locs: ['hq'],
        workMode: 'onsite',
        employmentType: 'part_time',
        flsa: 'non_exempt',
        payMin: 26,
        payMax: 32,
        openedOn: '2026-06-01',
        postedOn: '2026-06-02',
        skipTechnical: true,
        plan: [
          { stageId: 'intro', name: 'Intro call', durationMin: 30, attrs: ['Motivation for this stage and problem', 'Clear communication', 'Operational rigor'], interviewerIds: ['p-jasmine'] },
          { stageId: 'onsite', name: 'Office visit and scheduling exercise', durationMin: 60, attrs: ['Operational rigor', 'Judgment and discretion', 'Collaboration with engineering and product'], interviewerIds: ['p-jasmine', 'p-founder'] },
        ],
        description:
          "Keep the San Jose office running and bring the team together, about 24 hours a week on site.\n\nWhat you'll do\n- Run the office day to day: supplies, deliveries, visitors and vendors\n- Plan team lunches, offsites and customer events\n- Help with onboarding logistics for new hires\n\nWhat you bring\n- 1+ years in an office, events or front desk role\n- Organization, warmth and follow-through\n- Availability Tuesday to Thursday",
        backgroundCheck: true,
        profile: 'coord',
      }),
      applied: '2026-06-08',
      accepted: '2026-07-02',
      start: '2026-07-20',
      cand: { source: 'inbound', sourceDetail: 'Indeed', place: ['San Jose, CA', 'America/Los_Angeles'], currentTitle: 'Events coordinator', currentCompany: 'San Jose State University', summary: 'Plans department events and manages vendors; wants part-time hours while finishing a degree.', sponsorship: 'no' },
      offer: { title: 'Office and events coordinator', hourlyRate: 30, equity: 0, hoursPerWeek: 24, draftedById: 'p-jasmine', draftedByRole: 'admin', managerId: 'p-jasmine' },
      funnel: { applied: 118, intro: 12, technical: 0, onsite: 3, offers: 1 },
      others: [
        { reached: 'onsite', status: 'rejected', reason: 'not_a_fit_level' },
        { reached: 'intro', status: 'withdrawn', reason: 'timing', note: 'Wanted full-time hours.' },
      ],
    },
    {
      key: 'ravi',
      personId: 'p-ravi',
      first: 'Ravi',
      last: 'Subramanian',
      job: filledJob({ id: 'j-staff-swe', title: 'Staff software engineer', familyId: 'f-eng', levelId: 'lv-l4', dept: 'eng', hmId: 'p-tomas', panelIds: ['p-tomas', 'p-kofi', 'p-nikhil', 'p-priya', 'p-founder'], payMin: 210_000, payMax: 255_000, equityMinPct: 0.003, equityMaxPct: 0.006, openedOn: '2026-05-11', postedOn: '2026-05-12', planSlotId: 'ps-q3-staff-swe', roleTemplateId: 'rt-fullstack', stepPanels: [['p-tomas'], ['p-kofi', 'p-nikhil'], ['p-tomas', 'p-priya'], ['p-founder', 'p-sofia']], backgroundCheck: true, profile: 'eng', priority: 'high' }),
      applied: '2026-05-26',
      accepted: '2026-07-09',
      start: '2026-08-10',
      cand: { source: 'outbound', sourceDetail: 'LinkedIn Recruiter', place: ['Cupertino, CA', 'America/Los_Angeles'], currentTitle: 'Staff software engineer', currentCompany: 'Stripe', summary: 'Led ledger and reconciliation services; 12 years of backend and distributed systems. Sourced by Tomas.', desiredPay: 240_000, sponsorship: 'no' },
      offer: { title: 'Staff software engineer', salary: 235_000, equity: 45_000, draftedById: 'p-tomas', draftedByRole: 'manager', approverId: 'p-founder', managerId: 'p-tomas' },
      funnel: { applied: 296, intro: 24, technical: 11, onsite: 5, offers: 2 },
      others: [
        {
          name: ['Marcus', 'Lindqvist'],
          reached: 'offer',
          status: 'withdrawn',
          reason: 'chose_other_offer',
          note: 'Accepted a counteroffer from his current employer.',
          source: 'outbound',
          sourceDetail: 'LinkedIn Recruiter',
          place: ['Mountain View, CA', 'America/Los_Angeles'],
          currentTitle: 'Staff software engineer',
          currentCompany: 'Google',
          offer: { salary: 250_000, equity: 55_000, sentOn: '2026-06-24', decidedOn: '2026-07-01', declineReason: 'chose_other_offer', competingNote: 'Big-tech counteroffer: a retention grant and a promotion from his current employer.' },
        },
        { reached: 'onsite', status: 'rejected', reason: 'position_filled', keepWarm: true, note: 'Strong platform engineer; consider for the engineering manager role in 2027.' },
        { reached: 'technical', status: 'rejected', reason: 'skills_gap' },
      ],
    },
    {
      key: 'aisha',
      personId: 'p-aisha',
      first: 'Aisha',
      last: 'Bello',
      job: filledJob({ id: 'j-csm', title: 'Customer success manager', familyId: 'f-gtm', levelId: 'lv-l2', dept: 'gtm', hmId: 'p-founder', panelIds: ['p-founder', 'p-caleb', 'p-elena', 'p-chris'], payMin: 125_000, payMax: 150_000, equityMinPct: 0.0005, equityMaxPct: 0.0015, openedOn: '2026-06-15', postedOn: '2026-06-16', planSlotId: 'ps-q3-csm', roleTemplateId: 'rt-csm', stepPanels: [['p-founder'], ['p-elena', 'p-caleb'], ['p-caleb', 'p-chris'], ['p-jasmine']], backgroundCheck: true, profile: 'csm' }),
      applied: '2026-07-06',
      accepted: '2026-08-12',
      start: '2026-09-08',
      cand: { source: 'referral', sourceDetail: 'Employee referral', referrerId: 'p-elena', place: ['San Jose, CA', 'America/Los_Angeles'], currentTitle: 'Customer success manager', currentCompany: 'FloQast', summary: 'CPA. Audited SaaS and fintech clients at a mid-size firm, then ran a book of 35 controllers for a close management product. Referred by Elena Vasquez.', desiredPay: 140_000, sponsorship: 'no' },
      offer: { title: 'Customer success manager (CPA)', salary: 140_000, variablePct: 0.1, equity: 12_000, draftedById: 'p-jasmine', draftedByRole: 'admin', managerId: 'p-founder' },
      funnel: { applied: 167, intro: 16, technical: 7, onsite: 4, offers: 1 },
      others: [
        { reached: 'onsite', status: 'rejected', reason: 'not_a_fit_level', note: 'Strong relationships, limited accounting depth.' },
        { reached: 'intro', status: 'withdrawn', reason: 'comp' },
      ],
    },
    {
      key: 'lucas',
      personId: 'p-lucas',
      first: 'Lucas',
      last: 'Ferreira',
      job: filledJob({ id: 'j-data-eng-backfill', title: 'Senior data engineer', familyId: 'f-eng', levelId: 'lv-l3', dept: 'eng', hmId: 'p-tomas', panelIds: ['p-tomas', 'p-kofi', 'p-ravi', 'p-nikhil'], payMin: 180_000, payMax: 215_000, equityMinPct: 0.0015, equityMaxPct: 0.0035, openedOn: '2026-08-17', postedOn: '2026-08-18', planSlotId: 'ps-q3-data-backfill', roleTemplateId: 'rt-data-erp', isBackfill: true, backfillForPersonId: 'p-omar', stepPanels: [['p-tomas'], ['p-kofi', 'p-ravi'], ['p-ravi', 'p-nikhil'], ['p-elena', 'p-kofi']], backgroundCheck: true, profile: 'data', priority: 'high' }),
      applied: '2026-08-24',
      accepted: '2026-09-30',
      start: '2026-10-19',
      cand: { source: 'outbound', sourceDetail: 'LinkedIn Recruiter', place: ['Mountain View, CA', 'America/Los_Angeles'], currentTitle: 'Senior data engineer', currentCompany: 'BILL', summary: 'Built NetSuite and QuickBooks Online sync services with safe reruns and per-record lineage. Sourced for the backfill.', desiredPay: 195_000, sponsorship: 'no', phone: '(650) 555-0143' },
      offer: { title: 'Senior data engineer', salary: 195_000, signOnBonus: 10_000, equity: 30_000, draftedById: 'p-tomas', draftedByRole: 'manager', approverId: 'p-founder', managerId: 'p-tomas' },
      funnel: { applied: 228, intro: 19, technical: 8, onsite: 4, offers: 1 },
      others: [
        { reached: 'onsite', status: 'rejected', reason: 'position_filled', keepWarm: true, note: 'Solid ERP experience; keep warm for the platform team.' },
        { reached: 'technical', status: 'rejected', reason: 'skills_gap' },
        { reached: 'intro', status: 'withdrawn', reason: 'chose_other_offer' },
      ],
      viaHireFlow: true,
    },
    {
      key: 'mei',
      personId: 'p-mei',
      first: 'Mei',
      last: 'Tanaka',
      job: filledJob({ id: 'j-ml-agents', title: 'Senior ML engineer (agents)', familyId: 'f-ml', levelId: 'lv-l3', dept: 'ai', hmId: 'p-priya', panelIds: ['p-priya', 'p-hannah', 'p-ravi', 'p-elena'], payMin: 200_000, payMax: 240_000, equityMinPct: 0.002, equityMaxPct: 0.0045, openedOn: '2026-07-27', postedOn: '2026-07-28', planSlotId: 'ps-q4-ml-agents', roleTemplateId: 'rt-ml-agents', stepPanels: [['p-priya'], ['p-hannah', 'p-priya'], ['p-hannah', 'p-elena'], ['p-ravi', 'p-tomas']], backgroundCheck: true, profile: 'ml' }),
      applied: '2026-08-31',
      accepted: '2026-10-07',
      start: '2026-11-02',
      cand: {
        source: 'referral',
        sourceDetail: 'Employee referral',
        referrerId: 'p-hannah',
        place: ['Palo Alto, CA', 'America/Los_Angeles'],
        currentTitle: 'ML engineer',
        currentCompany: 'Ramp',
        summary: 'Built agents that draft accounting entries from receipts and contracts, with human review before posting. In the U.S. in H-1B status; needs an H-1B transfer. Referred by Hannah Kim.',
        desiredPay: 228_000,
        sponsorship: 'yes',
        phone: '(650) 555-0178',
        tags: ['H-1B transfer'],
      },
      offer: { title: 'Senior ML engineer (agents)', salary: 228_000, equity: 38_000, draftedById: 'p-priya', draftedByRole: 'manager', approverId: 'p-founder', managerId: 'p-priya' },
      funnel: { applied: 274, intro: 22, technical: 10, onsite: 4, offers: 1 },
      others: [
        { reached: 'onsite', status: 'withdrawn', reason: 'chose_other_offer', note: 'Accepted an offer from a frontier AI lab.' },
        { reached: 'technical', status: 'rejected', reason: 'skills_gap', note: 'No review step before writes in the agent design.' },
        { reached: 'onsite', status: 'rejected', reason: 'position_filled', keepWarm: true, note: 'Strong agent design; revisit for the staff role.' },
      ],
      viaHireFlow: true,
    },
  ]
}

// ---------------------------------------------------------------------------------------------
// Open pipelines (active candidates are hand-placed; closed ones are generated from a mix)
// ---------------------------------------------------------------------------------------------

export function openPipelines(): Pipeline[] {
  const review = (dueOn: ISODate, ownerId: ID) => ({ text: 'Review application', dueOn, ownerId })
  return [
    {
      jobId: 'j-staff-ml',
      referrers: ['p-priya', 'p-hannah', 'p-ravi', 'p-tomas'],
      active: [
        { applied: '2026-10-07', source: 'inbound', sourceDetail: 'Careers page', next: review('2026-10-12', 'p-priya') },
        { applied: '2026-10-08', source: 'inbound', sourceDetail: 'LinkedIn', next: review('2026-10-13', 'p-priya') },
        { applied: '2026-10-09', source: 'inbound', sourceDetail: 'Wellfound', next: review('2026-10-14', 'p-priya') },
        { applied: '2026-10-06', source: 'outbound', sourceDetail: 'LinkedIn Recruiter', next: { text: 'Follow up on outreach', dueOn: '2026-10-13', ownerId: 'p-hannah' } },
        { applied: '2026-10-07', source: 'referral', referrerId: 'p-ravi', sourceDetail: 'Employee referral', next: { text: 'Review referral and reply to Ravi', dueOn: '2026-10-12', ownerId: 'p-priya' } },
        { applied: '2026-10-02', source: 'inbound', sourceDetail: 'Hacker News jobs thread', snoozedUntil: '2026-10-14', next: { text: 'Reconnect after their conference travel', dueOn: '2026-10-14', ownerId: 'p-priya' } },
        {
          name: ['Ritika', 'Sharma'],
          applied: '2026-09-30',
          source: 'inbound',
          sourceDetail: 'LinkedIn',
          moves: [['intro', '2026-10-07', 'p-priya']],
          interviews: [{ step: 0, date: '2026-10-13', hour: 11, status: 'scheduled', scorecards: 'owed', bias: 'strong', icsIssuedOn: '2026-10-08' }],
          next: { text: 'Debrief and decide', dueOn: '2026-10-14', ownerId: 'p-priya' },
          place: ['San Francisco, CA', 'America/Los_Angeles'],
          currentTitle: 'Senior ML engineer',
          currentCompany: 'Databricks',
          summary: 'Built the eval and tracing stack for an LLM data assistant; reads traces every day and writes up failure patterns.',
          desiredPay: 255_000,
        },
        {
          applied: '2026-09-28',
          source: 'outbound',
          sourceDetail: 'GitHub',
          moves: [['intro', '2026-10-02', 'p-priya']],
          interviews: [{ step: 0, date: '2026-10-08', hour: 9, minute: 30, status: 'completed', scorecards: 'submitted', bias: 'strong' }],
          next: { text: 'Debrief and decide', dueOn: '2026-10-09', ownerId: 'p-priya' },
        },
        { applied: '2026-10-01', source: 'referral', referrerId: 'p-hannah', sourceDetail: 'Employee referral', moves: [['intro', '2026-10-07', 'p-priya']], next: { text: 'Schedule intro call', dueOn: '2026-10-09', ownerId: 'p-jasmine' } },
        { applied: '2026-10-02', source: 'inbound', sourceDetail: 'Careers page', moves: [['intro', '2026-10-08', 'p-priya']], next: { text: 'Schedule intro call', dueOn: '2026-10-12', ownerId: 'p-jasmine' } },
        {
          name: ['Kenji', 'Watanabe'],
          applied: '2026-09-14',
          source: 'inbound',
          sourceDetail: 'Careers page',
          moves: [['intro', '2026-09-21', 'p-priya'], ['technical', '2026-10-02', 'p-priya']],
          interviews: [
            { step: 0, date: '2026-09-24', hour: 10, status: 'completed', scorecards: 'submitted', bias: 'strong' },
            { step: 1, date: '2026-10-07', hour: 14, status: 'completed', scorecards: 'owed', interviewers: ['p-hannah'], bias: 'strong' },
          ],
          next: { text: 'Debrief and decide (waiting on Hannah\'s scorecard)', dueOn: '2026-10-08', ownerId: 'p-priya' },
          place: ['San Mateo, CA', 'America/Los_Angeles'],
          currentTitle: 'Staff ML engineer',
          currentCompany: 'Intuit',
          summary: 'Led the categorization models behind small-business bookkeeping; recently built LLM-assisted reconciliation suggestions.',
          desiredPay: 270_000,
        },
        {
          name: ['Leila', 'Moradi'],
          applied: '2026-09-17',
          source: 'outbound',
          sourceDetail: 'Conference contact',
          moves: [['intro', '2026-09-23', 'p-priya'], ['technical', '2026-10-05', 'p-priya']],
          interviews: [
            { step: 0, date: '2026-09-28', hour: 13, status: 'completed', scorecards: 'submitted', bias: 'strong' },
            { step: 1, date: '2026-10-08', hour: 10, status: 'completed', scorecards: 'owed', interviewers: ['p-hannah'], bias: 'strong' },
          ],
          next: { text: 'Debrief and decide', dueOn: '2026-10-09', ownerId: 'p-priya' },
          place: ['Berkeley, CA', 'America/Los_Angeles'],
          currentTitle: 'Senior applied scientist',
          currentCompany: 'Amazon',
          summary: 'Applied scientist on document understanding for invoices and receipts; built a model-graded eval pipeline with human spot checks.',
          desiredPay: 260_000,
          sponsorship: 'yes',
          tags: ['H-1B transfer'],
        },
        {
          applied: '2026-09-22',
          source: 'outbound',
          sourceDetail: 'LinkedIn Recruiter',
          moves: [['intro', '2026-09-25', 'p-priya'], ['technical', '2026-10-07', 'p-priya']],
          interviews: [{ step: 0, date: '2026-10-01', hour: 15, status: 'completed', scorecards: 'submitted', bias: 'strong' }],
          next: { text: 'Schedule agent design deep dive', dueOn: '2026-10-09', ownerId: 'p-jasmine' },
        },
        {
          name: ['Ananya', 'Krishnan'],
          applied: '2026-09-08',
          source: 'inbound',
          sourceDetail: 'Careers page',
          moves: [['intro', '2026-09-14', 'p-priya'], ['technical', '2026-09-22', 'p-priya'], ['onsite', '2026-10-07', 'p-priya']],
          interviews: [
            { step: 0, date: '2026-09-17', hour: 11, status: 'completed', scorecards: 'submitted', bias: 'hire' },
            { step: 1, date: '2026-09-30', hour: 13, status: 'completed', scorecards: 'submitted', bias: 'strong' },
            { step: 2, date: '2026-10-13', hour: 9, minute: 30, status: 'scheduled', scorecards: 'owed', bias: 'strong', icsIssuedOn: '2026-10-07' },
          ],
          next: { text: 'Debrief and decide', dueOn: '2026-10-14', ownerId: 'p-priya' },
          place: ['Sunnyvale, CA', 'America/Los_Angeles'],
          currentTitle: 'Staff machine learning engineer',
          currentCompany: 'PayPal',
          summary: 'Led risk model evaluation and an LLM agent pilot for dispute handling, with a review queue for analysts.',
          desiredPay: 275_000,
        },
        {
          name: ['Jonah', 'Feldman'],
          applied: '2026-09-10',
          source: 'outbound',
          sourceDetail: 'GitHub',
          moves: [['intro', '2026-09-15', 'p-priya'], ['technical', '2026-09-24', 'p-priya'], ['onsite', '2026-10-08', 'p-priya']],
          interviews: [
            { step: 0, date: '2026-09-18', hour: 14, status: 'completed', scorecards: 'submitted', bias: 'strong' },
            { step: 1, date: '2026-10-06', hour: 10, status: 'completed', scorecards: 'submitted', bias: 'strong' },
            { step: 2, date: '2026-10-15', hour: 13, status: 'scheduled', scorecards: 'owed', bias: 'strong', icsIssuedOn: '2026-10-08' },
          ],
          next: { text: 'Debrief and decide', dueOn: '2026-10-16', ownerId: 'p-priya' },
          place: ['Oakland, CA', 'America/Los_Angeles'],
          currentTitle: 'Research engineer',
          currentCompany: 'Mosswood AI',
          summary: 'Maintains an open-source LLM eval library; built agent sandboxes with tool permission checks.',
          desiredPay: 250_000,
        },
        {
          name: ['Daniel', 'Reyes'],
          applied: '2026-08-31',
          source: 'outbound',
          sourceDetail: 'LinkedIn Recruiter',
          moves: [['intro', '2026-09-03', 'p-priya'], ['technical', '2026-09-10', 'p-priya'], ['onsite', '2026-09-21', 'p-priya'], ['offer', '2026-10-08', 'p-priya']],
          interviews: [
            { step: 0, date: '2026-09-08', hour: 10, status: 'completed', scorecards: 'submitted', bias: 'hire' },
            { step: 1, date: '2026-09-16', hour: 13, status: 'completed', scorecards: 'submitted', bias: 'hire' },
            { step: 2, date: '2026-10-01', hour: 9, minute: 30, status: 'completed', scorecards: 'submitted', bias: 'hire' },
          ],
          next: { text: 'Send the offer once Maya approves', dueOn: '2026-10-12', ownerId: 'p-priya' },
          place: ['Palo Alto, CA', 'America/Los_Angeles'],
          currentTitle: 'Staff machine learning engineer',
          currentCompany: 'Intuit',
          summary: 'Built the eval harness and guardrails for an accounting assistant used by small businesses; 10 years in production ML, the last three on LLM agents.',
          desiredPay: 265_000,
          sponsorship: 'no',
        },
      ],
      closed: [
        { reached: 'new', status: 'rejected', reason: 'skills_gap', count: 7 },
        { reached: 'new', status: 'rejected', reason: 'not_a_fit_level', count: 4 },
        { reached: 'new', status: 'rejected', reason: 'location', count: 3 },
        { reached: 'new', status: 'withdrawn', reason: 'no_response', count: 3 },
        { reached: 'new', status: 'withdrawn', reason: 'chose_other_offer', count: 1 },
        { reached: 'intro', status: 'rejected', reason: 'not_a_fit_level', count: 2 },
        { reached: 'intro', status: 'rejected', reason: 'skills_gap', count: 1 },
        { reached: 'intro', status: 'withdrawn', reason: 'comp', count: 1 },
        { reached: 'intro', status: 'withdrawn', reason: 'timing', count: 1 },
        { reached: 'intro', status: 'withdrawn', reason: 'chose_other_offer', count: 1 },
        { reached: 'technical', status: 'rejected', reason: 'skills_gap', count: 3 },
        { reached: 'onsite', status: 'rejected', reason: 'not_a_fit_level', count: 1, keepWarm: true, note: 'Strong at evals, not yet staff-level systems design. Revisit for a senior role.' },
        { reached: 'onsite', status: 'withdrawn', reason: 'chose_other_offer', count: 1 },
      ],
    },
    {
      jobId: 'j-fullstack',
      referrers: ['p-kofi', 'p-tomas', 'p-nikhil', 'p-ravi', 'p-sofia'],
      active: [
        { applied: '2026-10-06', source: 'inbound', sourceDetail: 'Careers page', next: review('2026-10-09', 'p-tomas') },
        { applied: '2026-10-06', source: 'inbound', sourceDetail: 'LinkedIn', next: review('2026-10-09', 'p-tomas') },
        { applied: '2026-10-07', source: 'inbound', sourceDetail: 'Wellfound', next: review('2026-10-12', 'p-tomas') },
        { applied: '2026-10-07', source: 'inbound', sourceDetail: 'Built In SF', next: review('2026-10-12', 'p-tomas') },
        { applied: '2026-10-08', source: 'inbound', sourceDetail: 'Careers page', next: review('2026-10-13', 'p-tomas') },
        { applied: '2026-10-08', source: 'inbound', sourceDetail: 'LinkedIn', next: review('2026-10-13', 'p-tomas') },
        { applied: '2026-10-08', source: 'inbound', sourceDetail: 'Hacker News jobs thread', next: review('2026-10-13', 'p-kofi') },
        { applied: '2026-10-09', source: 'inbound', sourceDetail: 'Careers page', next: review('2026-10-14', 'p-tomas') },
        { applied: '2026-10-09', source: 'inbound', sourceDetail: 'LinkedIn', next: review('2026-10-14', 'p-kofi') },
        { applied: '2026-10-06', source: 'outbound', sourceDetail: 'LinkedIn Recruiter', next: { text: 'Follow up on outreach', dueOn: '2026-10-12', ownerId: 'p-tomas' } },
        { applied: '2026-10-07', source: 'outbound', sourceDetail: 'GitHub', next: { text: 'Follow up on outreach', dueOn: '2026-10-13', ownerId: 'p-kofi' } },
        { applied: '2026-10-08', source: 'outbound', sourceDetail: 'Former colleague of the team', next: { text: 'Follow up on outreach', dueOn: '2026-10-14', ownerId: 'p-tomas' } },
        {
          candidateId: 'c-grace-okafor',
          applied: '2026-10-01',
          moves: [['intro', '2026-10-05', 'p-tomas']],
          interviews: [{ step: 0, date: '2026-10-12', hour: 10, status: 'scheduled', scorecards: 'owed', interviewers: ['p-tomas'], bias: 'hire', icsIssuedOn: '2026-10-06' }],
          next: { text: 'Debrief and decide', dueOn: '2026-10-13', ownerId: 'p-tomas' },
        },
        {
          name: ['Ethan', 'Brooks'],
          applied: '2026-09-30',
          source: 'inbound',
          sourceDetail: 'Careers page',
          moves: [['intro', '2026-10-06', 'p-tomas']],
          interviews: [{ step: 0, date: '2026-10-14', hour: 13, minute: 30, status: 'scheduled', scorecards: 'owed', interviewers: ['p-kofi'], bias: 'strong', icsIssuedOn: '2026-10-07' }],
          next: { text: 'Debrief and decide', dueOn: '2026-10-15', ownerId: 'p-tomas' },
          place: ['Fremont, CA', 'America/Los_Angeles'],
          currentTitle: 'Software engineer II',
          currentCompany: 'Expensify',
          summary: 'Built receipt review and approval screens in React; wants a smaller team closer to accounting workflows.',
          desiredPay: 195_000,
        },
        {
          name: ['Marco', 'Bianchi'],
          applied: '2026-09-21',
          source: 'inbound',
          sourceDetail: 'LinkedIn',
          moves: [['intro', '2026-09-28', 'p-tomas']],
          next: { text: 'Schedule intro call', dueOn: '2026-09-30', ownerId: 'p-tomas' },
          lastContactOn: '2026-09-28',
          place: ['San Jose, CA', 'America/Los_Angeles'],
          currentTitle: 'Senior software engineer',
          currentCompany: 'Cisco',
          summary: 'Backend in Go and Python; built usage billing pipelines and invoice exports.',
          desiredPay: 210_000,
        },
        {
          name: ['Hyejin', 'Park'],
          applied: '2026-09-23',
          source: 'referral',
          referrerId: 'p-kofi',
          sourceDetail: 'Employee referral',
          moves: [['intro', '2026-09-30', 'p-tomas']],
          next: { text: 'Schedule intro call', dueOn: '2026-10-02', ownerId: 'p-jasmine' },
          lastContactOn: '2026-09-30',
          place: ['Santa Clara, CA', 'America/Los_Angeles'],
          currentTitle: 'Senior frontend engineer',
          currentCompany: 'Gusto',
          summary: 'Frontend lead for payroll run review; strong accessibility and data grid experience. Referred by Kofi Boateng.',
          desiredPay: 215_000,
        },
        {
          name: ['Samuel', 'Adeyemi'],
          applied: '2026-09-16',
          source: 'inbound',
          sourceDetail: 'Wellfound',
          moves: [['intro', '2026-09-22', 'p-tomas'], ['technical', '2026-10-02', 'p-tomas']],
          interviews: [
            { step: 0, date: '2026-09-25', hour: 11, status: 'completed', scorecards: 'submitted', interviewers: ['p-tomas'], bias: 'strong' },
            { step: 1, date: '2026-10-08', hour: 13, status: 'completed', scorecards: 'owed', interviewers: ['p-ravi'], bias: 'strong' },
          ],
          next: { text: 'Debrief and decide', dueOn: '2026-10-09', ownerId: 'p-tomas' },
          place: ['Hayward, CA', 'America/Los_Angeles'],
          currentTitle: 'Full-stack engineer',
          currentCompany: 'Bluefin Pay',
          summary: 'Full-stack TypeScript at a payments startup; built the merchant payout reconciliation dashboard.',
          desiredPay: 205_000,
        },
        {
          applied: '2026-09-24',
          source: 'inbound',
          sourceDetail: 'Careers page',
          moves: [['intro', '2026-09-29', 'p-tomas'], ['technical', '2026-10-07', 'p-tomas']],
          interviews: [{ step: 0, date: '2026-10-05', hour: 15, status: 'completed', scorecards: 'submitted', interviewers: ['p-kofi'], bias: 'strong' }],
          next: { text: 'Schedule pairing exercise', dueOn: '2026-10-09', ownerId: 'p-jasmine' },
        },
        {
          name: ['Isabel', 'Moreno'],
          applied: '2026-09-15',
          source: 'outbound',
          sourceDetail: 'GitHub',
          moves: [['intro', '2026-09-17', 'p-tomas'], ['technical', '2026-09-23', 'p-tomas'], ['onsite', '2026-10-06', 'p-tomas']],
          interviews: [
            { step: 0, date: '2026-09-21', hour: 10, status: 'completed', scorecards: 'submitted', interviewers: ['p-tomas'], bias: 'hire' },
            { step: 1, date: '2026-09-29', hour: 13, status: 'completed', scorecards: 'submitted', bias: 'hire' },
            { step: 2, date: '2026-10-07', hour: 10, status: 'completed', scorecards: 'submitted', bias: 'hire' },
          ],
          next: { text: 'Debrief and decide', dueOn: '2026-10-09', ownerId: 'p-tomas' },
          place: ['Mountain View, CA', 'America/Los_Angeles'],
          currentTitle: 'Senior software engineer',
          currentCompany: 'Brex',
          summary: 'Owns the accounting export and review surfaces for card spend; deep on large-table performance and audit trails.',
          desiredPay: 225_000,
        },
      ],
      closed: [
        { reached: 'new', status: 'rejected', reason: 'skills_gap', count: 5 },
        { reached: 'new', status: 'rejected', reason: 'not_a_fit_level', count: 3 },
        { reached: 'new', status: 'rejected', reason: 'location', count: 2 },
        { reached: 'new', status: 'withdrawn', reason: 'no_response', count: 2 },
        { reached: 'new', status: 'withdrawn', reason: 'timing', count: 1 },
        { reached: 'intro', status: 'rejected', reason: 'not_a_fit_level', count: 2 },
        { reached: 'intro', status: 'rejected', reason: 'skills_gap', count: 1 },
        { reached: 'intro', status: 'withdrawn', reason: 'chose_other_offer', count: 1 },
        { reached: 'intro', status: 'withdrawn', reason: 'comp', count: 1 },
        { reached: 'technical', status: 'rejected', reason: 'skills_gap', count: 2 },
        { reached: 'technical', status: 'withdrawn', reason: 'chose_other_offer', count: 1 },
      ],
    },
    {
      jobId: 'j-ae',
      referrers: ['p-caleb', 'p-aisha', 'p-chris'],
      active: [
        { applied: '2026-10-06', source: 'agency', sourceDetail: 'Bright Path Talent', next: { text: 'Review agency submittal', dueOn: '2026-10-09', ownerId: 'p-caleb' } },
        { applied: '2026-10-07', source: 'inbound', sourceDetail: 'LinkedIn', next: review('2026-10-12', 'p-caleb') },
        { applied: '2026-10-07', source: 'inbound', sourceDetail: 'RepVue', next: review('2026-10-12', 'p-caleb') },
        { applied: '2026-10-08', source: 'inbound', sourceDetail: 'Careers page', next: review('2026-10-13', 'p-caleb') },
        { applied: '2026-10-08', source: 'inbound', sourceDetail: 'LinkedIn', next: review('2026-10-13', 'p-caleb') },
        { applied: '2026-10-09', source: 'inbound', sourceDetail: 'Wellfound', next: review('2026-10-14', 'p-caleb') },
        {
          applied: '2026-09-29',
          source: 'inbound',
          sourceDetail: 'LinkedIn',
          moves: [['intro', '2026-10-02', 'p-caleb']],
          interviews: [{ step: 0, date: '2026-10-08', hour: 10, minute: 30, status: 'completed', scorecards: 'submitted', bias: 'strong' }],
          next: { text: 'Debrief and decide', dueOn: '2026-10-09', ownerId: 'p-caleb' },
        },
        {
          applied: '2026-09-30',
          source: 'outbound',
          sourceDetail: 'LinkedIn Recruiter',
          moves: [['intro', '2026-10-05', 'p-caleb']],
          snoozedUntil: '2026-10-16',
          next: { text: 'Schedule intro call after their sales kickoff', dueOn: '2026-10-16', ownerId: 'p-caleb' },
        },
        { applied: '2026-10-01', source: 'referral', referrerId: 'p-aisha', sourceDetail: 'Employee referral', moves: [['intro', '2026-10-07', 'p-caleb']], next: { text: 'Schedule intro call', dueOn: '2026-10-09', ownerId: 'p-jasmine' } },
        {
          applied: '2026-09-29',
          source: 'agency',
          sourceDetail: 'Bright Path Talent',
          moves: [['intro', '2026-09-30', 'p-caleb'], ['technical', '2026-10-02', 'p-caleb']],
          interviews: [
            { step: 0, date: '2026-10-01', hour: 9, status: 'completed', scorecards: 'submitted', bias: 'strong' },
            { step: 1, date: '2026-10-06', hour: 9, status: 'completed', scorecards: 'submitted', bias: 'strong' },
          ],
          next: { text: 'Set up the onsite with Maya', dueOn: '2026-10-12', ownerId: 'p-caleb' },
        },
      ],
      closed: [
        { reached: 'new', status: 'rejected', reason: 'not_a_fit_level', count: 2 },
        { reached: 'new', status: 'rejected', reason: 'skills_gap', count: 2 },
        { reached: 'new', status: 'rejected', reason: 'location', count: 1 },
        { reached: 'new', status: 'withdrawn', reason: 'no_response', count: 1 },
        { reached: 'intro', status: 'rejected', reason: 'comp', count: 1, note: 'On-target earnings expectations above the range.' },
        { reached: 'intro', status: 'withdrawn', reason: 'timing', count: 1 },
      ],
    },
    {
      jobId: 'j-solutions-acct',
      referrers: ['p-elena', 'p-aisha', 'p-chris'],
      active: [
        { applied: '2026-10-06', source: 'inbound', sourceDetail: 'LinkedIn', next: review('2026-10-09', 'p-elena') },
        { applied: '2026-10-06', source: 'inbound', sourceDetail: 'CalCPA job board', next: review('2026-10-09', 'p-elena') },
        { applied: '2026-10-07', source: 'inbound', sourceDetail: 'Careers page', next: { text: 'Review application while Elena is out', dueOn: '2026-10-12', ownerId: 'p-chris' } },
        { applied: '2026-10-07', source: 'outbound', sourceDetail: 'LinkedIn Recruiter', next: { text: 'Follow up on outreach', dueOn: '2026-10-19', ownerId: 'p-elena' } },
        { applied: '2026-10-08', source: 'inbound', sourceDetail: 'LinkedIn', next: { text: 'Review application while Elena is out', dueOn: '2026-10-13', ownerId: 'p-chris' } },
        { applied: '2026-10-08', source: 'inbound', sourceDetail: 'Indeed', next: { text: 'Review application while Elena is out', dueOn: '2026-10-13', ownerId: 'p-chris' } },
        { applied: '2026-10-09', source: 'inbound', sourceDetail: 'CalCPA job board', next: { text: 'Review application while Elena is out', dueOn: '2026-10-14', ownerId: 'p-chris' } },
        { applied: '2026-10-09', source: 'referral', referrerId: 'p-chris', sourceDetail: 'Employee referral', next: { text: 'Review referral and reply to Chris', dueOn: '2026-10-14', ownerId: 'p-chris' } },
        {
          applied: '2026-10-02',
          source: 'inbound',
          sourceDetail: 'LinkedIn',
          moves: [['intro', '2026-10-05', 'p-elena']],
          interviews: [{ step: 0, date: '2026-10-08', hour: 15, status: 'completed', scorecards: 'submitted', bias: 'hire' }],
          next: { text: 'Debrief and decide', dueOn: '2026-10-09', ownerId: 'p-elena' },
        },
        {
          applied: '2026-10-05',
          source: 'referral',
          referrerId: 'p-aisha',
          sourceDetail: 'Employee referral',
          moves: [['intro', '2026-10-07', 'p-elena']],
          snoozedUntil: '2026-10-19',
          next: { text: 'Schedule intro call when Elena is back', dueOn: '2026-10-19', ownerId: 'p-elena' },
        },
      ],
      closed: [
        { reached: 'new', status: 'rejected', reason: 'skills_gap', count: 1, note: 'No CPA license and no plans to pursue one.' },
        { reached: 'new', status: 'rejected', reason: 'not_a_fit_level', count: 1 },
      ],
    },
    {
      jobId: 'j-em-platform',
      referrers: ['p-tomas', 'p-ravi'],
      active: [],
      closed: [
        { reached: 'intro', status: 'withdrawn', reason: 'timing', count: 2, note: 'Role on hold until the second quarter of 2027.' },
        { reached: 'intro', status: 'rejected', reason: 'timing', count: 1, keepWarm: true, note: 'Role on hold until the second quarter of 2027. Strong fit; reach out in March.' },
      ],
    },
  ]
}
