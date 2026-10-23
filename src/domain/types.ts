// The data contract. Every module reads and writes these shapes through the store (src/store/db.ts).
// Rules: money is whole USD per year unless named otherwise (hourlyRate); dates are 'YYYY-MM-DD';
// timestamps are full ISO strings. Never add protected characteristics (gender, race, age, birthday,
// disability, veteran status, pronouns), SSNs, bank details, home street addresses, identity documents,
// I-9 forms, background check reports or medical details. Track status + date (+ a link) only.
import type { ISODate, ISODateTime } from '@/lib/dates'

export type ID = string

// ---------------------------------------------------------------------------------------------
// Company and org setup
// ---------------------------------------------------------------------------------------------

export type Address = { street: string; suite?: string; city: string; state: string; zip: string }

export type FundingRound = {
  id: ID
  name: string // 'Pre-seed', 'Seed'
  closedOn: ISODate
  amount: number
  postMoney?: number
  leadInvestor?: string
  /** Preferred price per share (priced rounds). */
  pricePerShare?: number
  instrument?: 'SAFE' | 'Priced'
}

export type LinkOuts = {
  payroll?: string
  backgroundCheck?: string
  eSign?: string
  capTable?: string
  calendly?: string
  training?: string
  handbook?: string
  benefits?: string
  /** Default video meeting room, prefilled as the link when an interview is on video. */
  videoRoom?: string
}

export type Company = {
  name: string // 'Ledgerlark'
  legalName: string // 'Ledgerlark, Inc.'
  tagline: string
  hq: Address
  foundedOn: ISODate
  incorporatedIn: string // 'Delaware'
  entityType: string // 'C corporation'
  timezone: string // 'America/Los_Angeles'
  stage: string // 'Seed'
  workweek: string // 'Hybrid, office Tue-Thu'
  paySchedule: 'semi_monthly' | 'biweekly' | 'monthly'
  fundingRounds: FundingRound[]
  payrollProvider: { name: string; kind: 'PEO' | 'Payroll'; url: string }
  linkOuts: LinkOuts
  /** Workers' comp carrier (needed on the Labor Code 2810.5 and SB 294 notices). */
  workersCompCarrier?: {
    name: string
    phone?: string
    policyNumber?: string
    /** Carrier address (Labor Code 2810.5(a)(1)(H) needs name, address and phone). */
    address?: string
  }
  /** Main business phone (printed on the Labor Code 2810.5 wage notice). */
  phone?: string
  /** Regular payday in plain words, e.g. 'the 15th and the last day of each month' (Labor Code 2810.5 notice). */
  regularPayday?: string
  eddAccountNumber?: string
  /**
   * Date of the first W-2 payroll (starts the EDD DE 1 clock). When missing, the earliest start date stands in.
   * The first pay run marked submitted in Comp and plan > Pay runs fills it with that payday when it is empty.
   */
  firstPayrollOn?: ISODate
  /** Pay run prep settings (Settings > Company and Link-outs). Unset fields use the defaults in src/domain/payrun. */
  payroll?: PayrollPrepSettings
  /**
   * Pay periods marked submitted to the provider, and the totals entered from it (Comp and plan > Pay runs).
   * Its own top-level field so a Mark submitted never collides with a Settings edit (documents merge by field).
   */
  payRuns?: PayRunRecord[]
  /** Cash and non-payroll spend, for runway. */
  cashOnHand?: number
  cashAsOf?: ISODate
  otherMonthlySpend?: number
  monthlyRevenue?: number
  /** Trailing-12-month revenue, used only to say when CCPA employee-data rules would apply. */
  annualRevenue?: number
  /**
   * When the company's group health plan started (Settings > Company). Starts the 'first group health
   * plan' rule. null = no group health plan (Cal-COBRA does not apply); undefined = not recorded yet.
   */
  groupHealthPlanStartedOn?: ISODate | null
  /** Employer cost assumptions for fully loaded run-rate (employer taxes come from law constants). */
  costModel: {
    benefitsPerHeadMonthly: number
    peoToolsPerHeadMonthly: number
    workersCompPct: number // of wages, e.g. 0.003
    /**
     * Optional overrides of the employer tax assumptions in PAYROLL_TAX_2026 (src/data/law.ts): the California
     * FUTA scenario until DOL finalizes it after Nov 10, 2026, an experience-rated UI rate, another state's rate.
     */
    taxOverrides?: {
      futaScenario?: 'waiver' | 'no_waiver'
      rates?: PayrollTaxRateOverrides
    }
  }
  /** SOC 2 evidence features on (financial customers ask early). */
  soc2Enabled: boolean
  soc2?: { typeIReportOn?: ISODate; typeIIWindow?: { from: ISODate; to: ISODate } }
  website?: string
  /**
   * What the in-app assistant is called (Settings > Company), at most ASSISTANT_NAME_MAX characters. Unset or
   * blank: '<company name> Bot' (assistantDisplayName in src/domain/assistant.ts). The sample calls it Lark.
   */
  assistantName?: string
}

/**
 * Pay run prep settings (docs/SPEC.md PAY RUN PREP; docs/LAW.md w-pay-frequency, w-payday-holiday). The app
 * prepares each pay period and exports it; the provider or PEO calculates taxes and net pay and moves the money.
 */
export type PayrollPrepSettings = {
  /** 'Run payroll by' this many business days before payday (the provider's cutoff; default 2). */
  cutoffBusinessDays?: number
  /** A scheduled payday on a weekend or holiday moves to the business day before (default) or after. */
  paydayShift?: 'before' | 'after'
  /**
   * Semi-monthly paydays: `first` is the day of the month that pays the 1st to the 15th (15 to 26, same month);
   * `second` pays the 16th to month end (0 = the last day of that month, 1 to 10 = that day of the next month).
   * Default 15 and 0 (the 15th and the last day).
   */
  semiMonthlyPaydays?: { first: number; second: number }
  /** ADP RUN time sheet import: the company code (IID) and the company's own earnings codes. */
  adp?: { companyCode?: string; bonusCode?: string; vacationCode?: string; sickCode?: string }
}

/** One pay period marked submitted to the payroll provider, and the totals entered from its register afterwards. */
export type PayRunRecord = {
  periodStart: ISODate
  periodEnd: ISODate
  payday: ISODate
  submittedOn?: ISODate
  submittedById?: ID | null
  /** Copied from the provider after payroll ran: gross wages and employer taxes (actuals for Cost and runway). */
  totals?: { gross: number; employerTaxes: number; enteredOn: ISODate }
}

/** Employer tax rates and wage bases that Settings may override (fractions, e.g. 0.034 = 3.4%; bases in USD). */
export type PayrollTaxRateOverrides = {
  socialSecurityRate?: number
  socialSecurityWageBase?: number
  medicareRate?: number
  /** California FUTA effective rate if the add-on waiver is granted (2.1% estimate for 2026). */
  futaEffectiveRate?: number
  /** California FUTA effective rate without the waiver (5.9% for 2026). */
  futaEffectiveRateNoWaiver?: number
  /** FUTA rate outside California (0.6% after the full credit). */
  futaBaseRate?: number
  futaWageBase?: number
  caUiRate?: number
  caEttRate?: number
  caUiWageBase?: number
  /** Unemployment rate and wage base used for states other than California (generic 2.7% on $9,000). */
  otherStateSuiRate?: number
  otherStateSuiWageBase?: number
}

export type Department = { id: ID; name: string; headId?: ID | null }

export type Location = {
  id: ID
  name: string // 'San Jose HQ', 'Remote (California)', 'Remote (Texas)'
  kind: 'hq' | 'remote'
  city?: string
  state: string // two-letter
  /** Local minimum wage in effect, editable yearly. */
  minWageHourly: number
  minWageNote?: string
  /** SB 553 workplace violence plan inputs: is the site open to the public, and peak people on site at once. */
  publicAccess?: boolean
  typicalMaxOnSite?: number
}

/** Job family, e.g. Software engineering, Machine learning. Bands are family x level. */
export type JobFamily = { id: ID; name: string; track: 'engineering' | 'product_design' | 'gtm' | 'finance_ops' | 'executive' }

export type Level = {
  id: ID
  code: string // 'L3', 'M1'
  name: string // 'Senior'
  track: 'ic' | 'manager' | 'executive'
  order: number // sort key, higher = more senior
  description?: string
}

export type Band = {
  id: ID
  familyId: ID
  levelId: ID
  min: number
  mid: number
  max: number
  /** Option grant guideline as a fraction of fully diluted shares (0.005 = 0.5%). */
  equityMinPct: number
  equityMaxPct: number
  /** Bonus target or sales variable at target, as a fraction of base (1.0 = 50/50 OTE). */
  variablePct?: number
  flsaDefault?: FLSA
}

// ---------------------------------------------------------------------------------------------
// People (W-2 employees). Contractors and advisors are a separate entity and never count toward headcount.
// ---------------------------------------------------------------------------------------------

export type EmploymentType = 'full_time' | 'part_time' | 'intern'
export type FLSA = 'exempt' | 'non_exempt'
export type ExemptionBasis = 'executive' | 'administrative' | 'professional' | 'computer_professional' | 'outside_sales'
export type WorkMode = 'onsite' | 'hybrid' | 'remote'

export type EmergencyContact = {
  name: string
  relation: string
  phone: string
  /** SB 294: the employee chose this contact to be told if they are arrested or detained at work. */
  sb294Notify?: boolean
}

export type SeparationType = 'resigned_notice' | 'resigned_no_notice' | 'terminated' | 'laid_off' | 'contract_ended'

export type Separation = {
  type: SeparationType
  reason: string // short plain-language reason chip, never a protected category
  noticeGivenOn?: ISODate
  lastDay: ISODate
  rehireEligible?: boolean
  finalPayDueOn?: ISODate
  finalPayIssuedOn?: ISODate
  /** Vested options left at separation and the exercise deadline (typically last day + 90 days). */
  vestedAtSeparation?: number
  exerciseDeadline?: ISODate
  /**
   * Roles the leaver hands off (hiring manager, candidate next steps, interviews, contractors,
   * department head), chosen in the offboarding wizard. Applied on the last day (or at once when
   * chosen), then handoffsAppliedOn is set. See src/domain/handoff.ts.
   */
  handoffs?: Handoff[]
  handoffsAppliedOn?: ISODate
}

/** One role moved from a leaver to someone else. `id` is the job, application, interview, contractor or department. */
export type Handoff = {
  kind: 'job' | 'next_step' | 'interview' | 'contractor' | 'department'
  id: ID
  toId: ID
}

export type Person = {
  id: ID
  firstName: string
  lastName: string
  preferredName?: string
  workEmail: string
  personalEmail?: string
  phone?: string
  title: string
  departmentId: ID
  familyId: ID
  levelId: ID
  managerId: ID | null
  locationId: ID
  workMode: WorkMode
  /** City and state they work from (drives state payroll registration and local rules). Never a street address. */
  homeCity?: string
  homeState: string
  employmentType: EmploymentType
  hoursPerWeek: number // 40 for full time
  flsa: FLSA
  exemptionBasis?: ExemptionBasis
  startDate: ISODate
  endDate?: ISODate | null
  /** Employee number in order of hire, 1 = founder. */
  hireNumber: number
  /** The provider's own employee ID (ADP Employee ID or time clock ID), for pay run exports. Optional. */
  payrollId?: string
  isFounder?: boolean
  /** Candidate and application this person was hired from (ATS link). */
  fromCandidateId?: ID
  fromApplicationId?: ID
  /**
   * The earlier record of the same person when this is a rehire (set on hire, or found by priorStint in
   * src/domain/people.ts). Sick leave left at separation comes back on a rehire within 12 months.
   */
  rehireOfPersonId?: ID
  /** Contractor record this person was converted from (AB5); the contractor carries convertedToPersonId. */
  fromContractorId?: ID
  emergencyContacts: EmergencyContact[]
  /** I-9 reverification date for time-limited work authorization (date only; never the document). */
  i9ReverifyOn?: ISODate
  backgroundCheck?: { status: 'not_required' | 'clear' | 'pending'; completedOn?: ISODate }
  separation?: Separation
  bio?: string
  notes?: string
}

export type CompReason =
  | 'hire'
  | 'promotion'
  | 'merit'
  | 'market'
  | 'title_only'
  | 'manager_change'
  | 'transfer'
  | 'correction'

/**
 * Effective-dated job and pay history. The latest row on or before a date is the person's job and pay on
 * that date. Doubles as the job title and wage rate history California requires (Labor Code 432.3).
 */
export type CompRecord = {
  id: ID
  personId: ID
  effectiveOn: ISODate
  payType: 'salary' | 'hourly'
  /** Annual salary in USD (payType salary). */
  salary?: number
  /** Hourly rate in USD (payType hourly). */
  hourlyRate?: number
  /** Bonus target or sales variable at target, as a fraction of base (0.1 = 10%). */
  variablePct?: number
  title: string
  levelId: ID
  managerId?: ID | null
  departmentId?: ID
  flsa?: FLSA
  /** The exemption that applies while flsa is exempt (sets which pay minimum the exempt check uses). */
  exemptionBasis?: ExemptionBasis
  reason: CompReason
  /** Why pay sits outside the band, e.g. 'Founding, equity-heavy'. */
  exceptionReason?: string
  note?: string
  approvedById?: ID
  approvedOn?: ISODate
  /** Date the row's title, level, manager, department and FLSA were copied onto the Person (future-dated rows wait). */
  appliedOn?: ISODate
  /** Recorded ahead of its effective date; applyScheduledChanges copies it onto the Person once effective. */
  scheduled?: boolean
}

export type Valuation409A = {
  id: ID
  effectiveOn: ISODate
  fmvPerShare: number
  provider: string
  /** Safe harbor generally lasts 12 months or until a material event such as a priced round. */
  expiresOn: ISODate
  note?: string
}

export type EquitySetup = {
  authorizedShares: number
  fullyDilutedShares: number
  founderShares: number
  poolShares: number
  poolIncreases: Array<{ id: ID; date: ISODate; shares: number; note: string }>
  valuations: Valuation409A[]
  /** First option issuance and the CA 25102(o) notice (due within 30 days of the first issuance). */
  firstIssuanceOn?: ISODate
  filing25102oOn?: ISODate
  /**
   * When an admin entered or confirmed the cap table numbers. Unset after Start fresh, whose numbers are
   * placeholders: until then offer letters leave out the % of fully diluted shares.
   */
  capTableConfirmedOn?: ISODate
}

export type EquityGrant = {
  id: ID
  /** Employee id, contractor/advisor id, or candidate id while reserved by an offer. */
  personId: ID
  holderType: 'employee' | 'advisor' | 'contractor' | 'candidate'
  type: 'ISO' | 'NSO' | 'RSA'
  shares: number
  strikePrice: number
  vestingStart: ISODate
  cliffMonths: number // 12 (advisors often 0)
  vestingMonths: number // 48 (advisors often 24)
  /**
   * reserved = in an outstanding offer; promised = accepted offer, waiting for board consent;
   * approved = granted by the board; cancelled = rescinded or fully forfeited.
   */
  status: 'reserved' | 'promised' | 'approved' | 'cancelled'
  proposedOn?: ISODate
  boardApprovedOn?: ISODate
  /** Unvested shares returned to the pool at separation (or all shares when cancelled). */
  cancelledShares?: number
  cancelledOn?: ISODate
  exercisedShares: number
  earlyExercise?: boolean
  election83bDueOn?: ISODate
  postTerminationExerciseDays: number // 90
  fromOfferId?: ID
  note?: string
}

export type Ab5Exemption = 'b2b' | 'professional_services' | 'none'

/** Contractors and advisors. Never count toward headcount; contractors do count toward the harassment-training threshold. */
export type Contractor = {
  id: ID
  kind: 'contractor' | 'advisor'
  name: string
  entityName?: string // firm, if any
  entityType: 'individual' | 'llc' | 'corporation'
  email: string
  scope: string
  rate: number
  rateUnit: 'hour' | 'month' | 'project'
  hoursPerWeek?: number
  startOn: ISODate
  endOn?: ISODate | null
  managerId: ID
  departmentId: ID
  state: string
  ab5: {
    exemption: Ab5Exemption
    /** true = prong satisfied (supports contractor status); null = not answered. */
    a: boolean | null
    b: boolean | null
    c: boolean | null
    assessedOn?: ISODate
    note?: string
  }
  w9OnFile: boolean
  /** EDD DE 542 (individual contractors only) within 20 days of paying or contracting for $600+. */
  de542FiledOn?: ISODate
  agreementSignedOn?: ISODate
  notes?: string
  /** Employee record this contractor was converted to (settles the AB5 risk; blocks a second conversion). */
  convertedToPersonId?: ID
  convertedOn?: ISODate
}

// ---------------------------------------------------------------------------------------------
// Hiring (ATS)
// ---------------------------------------------------------------------------------------------

/** Stage kinds. A job's stages are an ordered list of these (renamable, optional ones addable). */
export type StageKind = 'new' | 'recruiter_screen' | 'intro' | 'technical' | 'onsite' | 'offer' | 'hired' | 'custom'

export type JobStage = {
  /** Stable id within the job. Default stages use their kind as id ('new', 'intro', ...). */
  id: string
  kind: StageKind
  name: string // 'New', 'Intro call', 'Technical', 'Onsite', 'Offer', 'Hired'
  /** Business days before a candidate in this stage counts as waiting too long (offer: until expiry). */
  slaBusinessDays?: number
}

export type SourceKind = 'inbound' | 'referral' | 'outbound' | 'agency'

export type PlanSlot = {
  id: ID
  quarter: string // '2026-Q4'
  title: string
  departmentId: ID
  familyId: ID
  levelId: ID
  targetStart: ISODate
  budgetBase?: number
  status: 'planned' | 'open' | 'offer' | 'filled' | 'cut'
  isBackfill?: boolean
  backfillForPersonId?: ID | null
  jobId?: ID | null
  personId?: ID | null // who filled it
  rationale?: string
}

/** Scorecard attribute with a one-line anchor and suggested questions. */
export type Attribute = { name: string; anchor?: string; questions?: string[] }

export type InterviewStep = {
  id: ID
  stageId: string // JobStage.id
  name: string // 'Intro call', 'LLM systems deep dive'
  durationMin: number
  interviewerIds: ID[]
  /** 3-5 attributes scored on the scorecard. */
  attributes: Attribute[]
}

export type RoleTemplate = {
  id: ID
  name: string // 'Senior full-stack engineer' (becomes the job title, so no posting qualifiers here)
  /** A short note shown next to the name in template pickers ('CPA preferred'); never part of the title. */
  hint?: string
  familyId: ID
  levelId: ID
  departmentId: ID
  jdOutline: string
  stages: JobStage[]
  interviewPlan: Array<Omit<InterviewStep, 'interviewerIds'>>
  emailTemplateIds?: ID[]
}

export type Job = {
  id: ID
  title: string
  departmentId: ID
  familyId: ID
  levelId: ID
  hiringManagerId: ID
  /** Interview panel (people who interview for this job). */
  panelIds: ID[]
  locationIds: ID[]
  workMode: WorkMode
  employmentType: EmploymentType
  flsa: FLSA
  /** Good-faith pay scale (CA SB 1162 / SB 642). Hard stop on posting at 15+ employees without one. */
  payMin: number | null
  payMax: number | null
  equityMinPct?: number
  equityMaxPct?: number
  status: 'draft' | 'open' | 'on_hold' | 'filled' | 'closed'
  openedOn?: ISODate
  postedOn?: ISODate
  closedOn?: ISODate
  targetStart?: ISODate
  planSlotId?: ID | null
  roleTemplateId?: ID
  isBackfill?: boolean
  backfillForPersonId?: ID | null
  stages: JobStage[]
  interviewPlan: InterviewStep[]
  /** Posting body (plain text, blank-line paragraphs). Pay scale, EEO and Fair Chance lines are generated. */
  description: string
  sponsorship: 'yes' | 'no' | 'case_by_case'
  backgroundCheck: boolean
  /** Credit checks are off by default; turning one on needs a Labor Code 1024.5 basis. */
  creditCheckBasis?: string | null
  priority: 'high' | 'normal'
  referralBonus?: number
  /** Closed jobs: aggregate funnel counts beyond the applications kept on record. */
  archivedFunnel?: { applied: number; intro: number; technical: number; onsite: number; offers: number; accepted: number }
  /** A hiring manager's request for this job. It stays a draft that cannot be posted until Admin approves. */
  requisition?: JobRequisition
}

/** A job request from a hiring manager (an approval in Admin's inbox). No cost is stored or shown. */
export type JobRequisition = {
  requestedById: ID
  requestedOn: ISODate
  /** Target quarter, '2026-Q4'. */
  quarter: string
  reason: string
  status: 'pending' | 'approved' | 'declined'
  decidedById?: ID | null
  decidedOn?: ISODate
}

export type Candidate = {
  id: ID
  firstName: string
  lastName: string
  email: string
  phone?: string
  links: { linkedin?: string; github?: string; resume?: string; portfolio?: string }
  location?: string // 'Sunnyvale, CA'
  timezone?: string // IANA, e.g. 'America/New_York'
  currentTitle?: string
  currentCompany?: string
  source: SourceKind
  sourceDetail?: string // 'Wellfound', 'SJSU career fair', agency name
  referrerId?: ID | null
  /**
   * Teammates who referred this person again after they were already on file (Refer someone found a
   * duplicate). Each referrer sees the entry under "Your referrals" with a neutral status, so a
   * duplicate looks the same as a new referral and never reveals that the person was already a candidate.
   */
  otherReferrals?: Array<{ referrerId: ID; jobId: ID; on: ISODate }>
  /** Desired pay only. California bans asking about current or past pay (Labor Code 432.3). */
  desiredPay?: number
  /** What desiredPay counts: dollars a year (the default when absent) or an hourly rate, for hourly and part-time jobs. */
  desiredPayUnit?: 'year' | 'hour'
  sponsorship: 'yes' | 'no' | 'unknown'
  tags: string[] // 'keep warm', 'silver medalist', ...
  summary?: string // short resume highlights
  createdOn: ISODate
  /** Keep applicant records 4 years after the decision (Gov Code 12946); Delete becomes Archive. */
  retainUntil?: ISODate
  archived?: boolean
  /** Set when the record was anonymized after its retention date (src/domain/compliance/retention.ts). */
  anonymizedOn?: ISODate
}

export type OutcomeReason =
  | 'not_a_fit_level'
  | 'skills_gap'
  | 'chose_other_offer'
  | 'comp'
  | 'location'
  | 'timing'
  | 'no_response'
  | 'withdrew'
  | 'position_filled'
  | 'other'

export type Application = {
  id: ID
  candidateId: ID
  jobId: ID
  /** JobStage.id in the job's stage list. */
  stageId: string
  status: 'active' | 'rejected' | 'withdrawn' | 'hired'
  appliedOn: ISODate
  stageEnteredOn: ISODate
  history: Array<{ stageId: string; at: ISODate; byId?: ID }>
  /** Every active candidate always has a next step with a due date and an owner. */
  nextStep?: { text: string; dueOn: ISODate; ownerId: ID }
  snoozedUntil?: ISODate
  lastContactOn?: ISODate
  outcomeReason?: OutcomeReason
  outcomeNote?: string
  closedOn?: ISODate
  /** When the candidate was told (rejection/close-out sent). */
  notifiedOn?: ISODate
  /** Accepted offer date; unlocks background checks and criminal-history steps (Fair Chance Act). */
  conditionalOfferOn?: ISODate
}

export type Interview = {
  id: ID
  applicationId: ID
  stepId?: ID // InterviewStep in the job's plan
  stageId: string
  name: string
  startsAt: ISODateTime
  durationMin: number
  interviewerIds: ID[]
  format: 'video' | 'onsite' | 'phone'
  /** The meeting link for a video interview (in the confirmation message and the .ics). */
  videoLink?: string
  status: 'scheduled' | 'completed' | 'cancelled' | 'no_show'
  attributes: string[]
  icsIssuedOn?: ISODate
}

export type Rating = 1 | 2 | 3 | 4 // strong no, no, yes, strong yes (no neutral)

export type Scorecard = {
  id: ID
  interviewId: ID
  applicationId: ID
  interviewerId: ID
  /** 24 hours after the interview ends. */
  dueAt: ISODateTime
  submittedAt?: ISODateTime
  ratings: Record<string, Rating>
  overall?: Rating
  notes?: string
  /** Set when an admin entered it on the interviewer's behalf. */
  enteredById?: ID
}

export type BackgroundCheck = {
  status: 'not_started' | 'consent_sent' | 'in_progress' | 'complete' | 'cancelled'
  /** Clear, or Consider (status only, never the report). Consider opens the Fair Chance steps. */
  result?: 'clear' | 'consider'
  consentSentOn?: ISODate
  completedOn?: ISODate
  provider?: string
  fairChance?: {
    assessmentOn?: ISODate
    assessmentNote?: string
    preliminaryNoticeOn?: ISODate
    /** How the preliminary notice went out. A mailed notice without confirmed receipt counts as received 5 calendar days after mailing (2 CCR 11017.1(c)(2)(E)). */
    preliminaryNoticeMethod?: 'email' | 'mail' | 'hand'
    /** At least 5 business days after the preliminary notice (5 more if disputed). */
    responseDueOn?: ISODate
    disputed?: boolean
    finalNoticeOn?: ISODate
    decision?: 'proceed' | 'rescind'
  }
}

export type OfferStatus = 'draft' | 'awaiting_approval' | 'approved' | 'sent' | 'accepted' | 'declined' | 'expired' | 'rescinded'

export type Offer = {
  id: ID
  applicationId: ID
  candidateId: ID
  jobId: ID
  version: number
  title: string
  levelId: ID
  familyId: ID
  departmentId: ID
  managerId: ID
  locationId: ID
  workMode: WorkMode
  employmentType: EmploymentType
  hoursPerWeek?: number
  flsa: FLSA
  exemptionBasis?: ExemptionBasis
  payType: 'salary' | 'hourly'
  salary?: number
  hourlyRate?: number
  variablePct?: number
  signOnBonus?: number
  equityType: 'ISO' | 'NSO'
  equityShares: number
  vestingMonths: number
  cliffMonths: number
  startDate: ISODate
  expiresOn: ISODate
  /** Required when pay or equity goes above band or guideline. */
  exceptionReason?: string
  contingencies: Array<'background_check' | 'i9' | 'piia'>
  status: OfferStatus
  createdOn: ISODate
  draftedById?: ID
  /** The Viewing-as role the offer was drafted in; 'admin' drafts need no separate approval. */
  draftedByRole?: Role
  approvals: Array<{ approverId: ID; decision: 'approved' | 'changes_requested'; at: ISODateTime; note?: string }>
  sentOn?: ISODate
  decidedOn?: ISODate
  declineReason?: string
  competingNote?: string
  /** Why the offer was rescinded, or why a draft that never went out was discarded. */
  rescindReason?: string
  backgroundCheck?: BackgroundCheck
  /** Set when Hire converts the accepted offer into a Person. */
  personId?: ID
}

export type Referral = {
  id: ID
  candidateId: ID
  referrerId: ID
  bonusAmount: number
  /** Typically payable 90 days after the referred hire starts. */
  payableOn?: ISODate
  paidOn?: ISODate
}

export type EmailTemplate = {
  id: ID
  kind: 'scheduling' | 'rejection' | 'close_out' | 'offer' | 'offer_nudge' | 'welcome' | 'reminder' | 'other'
  /** For rejections: which stage kinds this template suits. */
  stageKinds?: StageKind[]
  tone?: 'kind' | 'brief'
  name: string
  subject: string
  /** Merge fields: {{firstName}} {{jobTitle}} {{companyName}} {{senderName}} {{times}} {{calendly}} */
  body: string
}

// ---------------------------------------------------------------------------------------------
// Onboarding, offboarding, new-state and leave checklists
// ---------------------------------------------------------------------------------------------

export type OwnerRole = 'admin' | 'manager' | 'employee' | 'it'
export type TaskCategory = 'legal' | 'payroll' | 'benefits' | 'it' | 'security' | 'equity' | 'culture' | 'training' | 'notice'

export type DueRule = {
  anchor: 'start' | 'last_day' | 'offer_accepted' | 'leave_start' | 'created'
  offset: number
  unit: 'days' | 'business_days' | 'months'
}

/** Template task applies only when every set condition matches. */
export type TaskCondition = {
  minHeadcount?: number // company W-2 headcount on the anchor date
  supervisor?: boolean
  flsa?: FLSA
  remote?: boolean
  outsideCA?: boolean
  hasEquity?: boolean
  earlyExercise?: boolean
  separationTypes?: SeparationType[]
  employmentType?: EmploymentType
  /** Applies only to these employment types (e.g. short-term training rules for interns). */
  employmentTypes?: EmploymentType[]
  /** Applies only while W-2 headcount is below this (e.g. 'recommended' variants before a threshold). */
  belowHeadcount?: number
  /** W-2 employees plus contractors on the anchor date (harassment training count, Gov Code 12950.1(h)(1)). */
  minWorkforce?: number
  /** The person's job requires a background check (job.backgroundCheck or the offer contingency). */
  backgroundCheck?: boolean
  /** Leave checklists: applies only to these leave kinds. */
  leaveKinds?: Array<LeaveCase['kind']>
}

export type TemplateTask = {
  id: ID
  title: string
  /** Why this task exists, in plain words. */
  why?: string
  ownerRole: OwnerRole
  due: DueRule
  category: TaskCategory
  when?: TaskCondition
  citation?: { label: string; url?: string } // 'Labor Code 2810.5'
  soc2Control?: string
  link?: string
  /** Statutory deadline: shows red when overdue and cannot be snoozed past due. */
  statutory: boolean
}

export type ChecklistKind = 'onboarding' | 'offboarding' | 'new_state' | 'leave' | 'change'

export type ChecklistTemplate = {
  id: ID
  kind: ChecklistKind
  name: string
  tasks: TemplateTask[]
}

export type ChecklistTask = {
  id: ID
  templateTaskId?: ID
  title: string
  why?: string
  ownerRole: OwnerRole
  assigneeId?: ID | null
  dueOn: ISODate
  /** 'Start + 3 business days' */
  dueRuleText?: string
  status: 'open' | 'done' | 'not_applicable'
  doneOn?: ISODate
  doneById?: ID
  category: TaskCategory
  citation?: { label: string; url?: string }
  soc2Control?: string
  link?: string
  statutory: boolean
  note?: string
  /** Where the proof lives (PEO, Drive). Never a file. */
  evidenceLink?: string
}

export type Checklist = {
  id: ID
  personId: ID
  kind: ChecklistKind
  templateId: ID
  anchorDate: ISODate // start date, last day or leave start
  separationType?: SeparationType
  createdOn: ISODate
  tasks: ChecklistTask[]
  completedOn?: ISODate
}

/** Documents tracked as status + date + link, never the file. */
export type DocumentRecord = {
  id: ID
  personId: ID
  type: 'offer_letter' | 'piia' | 'i9_section1' | 'i9_section2' | 'wage_notice_2810_5' | 'notice' | 'handbook_ack' | 'grant_agreement' | 'election_83b' | 'other'
  name: string
  status: 'not_sent' | 'sent' | 'signed' | 'filed' | 'delivered'
  date?: ISODate
  link?: string
  retainUntil?: ISODate
}

// ---------------------------------------------------------------------------------------------
// Time off and leave
// ---------------------------------------------------------------------------------------------

export type TimeOffKind =
  | 'vacation'
  | 'flexible_vacation'
  | 'sick'
  | 'bereavement'
  | 'reproductive_loss'
  | 'organ_donor'
  | 'bone_marrow_donor'
  | 'jury_duty'
  | 'voting'
  | 'unpaid'

export type TimeOffPolicy = {
  id: ID
  name: string // 'Vacation', 'Sick leave (CA)'
  kind: TimeOffKind
  method: 'accrual' | 'frontload' | 'flexible' | 'as_needed'
  /** Hours earned per year (accrual) or granted each Jan 1 and at hire (frontload). */
  annualHours?: number
  /** Accrual cap in hours (vacation caps are allowed in CA; use-it-or-lose-it is not). */
  capHours?: number
  /** Annual usage limit (CA sick leave lets employers cap use at 40 hours / 5 days). */
  usageCapHours?: number
  /** Days of employment before use (CA sick leave allows up to 90). */
  usableAfterDays?: number
  /** Per-event limit, e.g. 5 days (40 hours) of bereavement. */
  perEventHours?: number
  paidOutOnExit: boolean
  /** Auto-approve (CA sick leave: no reason asked). */
  autoApprove?: boolean
  /** Shown only once the company reaches this headcount (e.g. bereavement at 5, organ donor at 15). */
  appliesFromHeadcount?: number
  appliesTo: 'all' | 'full_time' | 'non_exempt' | 'exempt'
  /** Work states the policy covers (two letters, e.g. ['CA'] for California sick leave); unset = every state. */
  appliesToStates?: string[]
  description: string
  citation?: { label: string; url?: string }
}

export type TimeOffRequest = {
  id: ID
  personId: ID
  policyId: ID
  startDate: ISODate
  endDate: ISODate
  partial?: 'am' | 'pm'
  hours: number
  status: 'pending' | 'approved' | 'declined' | 'cancelled'
  note?: string
  requestedOn: ISODate
  approverId?: ID
  decidedOn?: ISODate
  decisionNote?: string
  /**
   * The policy the request was made on when Admin recorded it as unpaid instead (sick leave before the 90-day
   * wait). Pay run prep flags those days for exempt staff rather than docking pay (docs/LAW.md w-exempt-deductions-ca).
   */
  recordedUnpaidFrom?: ID
}

export type TimeOffAdjustment = {
  id: ID
  personId: ID
  policyId: ID
  date: ISODate
  hours: number // + adds, - removes
  reason: string
}

export type Holiday = { id: ID; date: ISODate; name: string }

/** Protected leave case. No medical details are stored. */
export type LeaveCase = {
  id: ID
  personId: ID
  kind: 'cfra' | 'pdl' | 'bonding' | 'military' | 'other'
  requestedOn: ISODate
  startDate: ISODate
  expectedReturn?: ISODate
  /** Response/designation notice due within 5 business days of the request. */
  designationNoticeDueOn?: ISODate
  designationNoticeSentOn?: ISODate
  returnedOn?: ISODate
  /** The case closed without a return to work, e.g. employment ended during the leave. */
  endedOn?: ISODate
  note?: string
}

// ---------------------------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------------------------

/** What the user recorded against a rule from the rule catalog (src/domain/compliance). */
export type ComplianceStatus = {
  status?: 'done' | 'in_progress' | 'not_applicable'
  doneOn?: ISODate
  note?: string
  ownerId?: ID
  /** Done dates for the rule's individual actions. */
  actionsDone?: Record<string, ISODate>
  /** Admin override of the computed count, with a note. */
  countOverride?: { value: number; note: string }
  /** A deadline the user recorded for this rule, e.g. the date in a CalSavers notice. Shows on the compliance calendar. */
  dueOn?: ISODate
}

export type RecurringItem = {
  id: ID
  title: string
  cadence: 'monthly' | 'quarterly' | 'annual' | 'biennial' | 'once'
  nextDueOn: ISODate
  lastDoneOn?: ISODate
  ownerId?: ID
  ruleId?: string
  link?: string
  notes?: string
}

export type TrainingKind = 'harassment_supervisor' | 'harassment_employee' | 'security_awareness' | 'wvpp'

export type Training = {
  id: ID
  personId: ID
  kind: TrainingKind
  dueOn: ISODate
  completedOn?: ISODate
  provider?: string
  certificateLink?: string
}

export type Policy = {
  id: ID
  title: string
  version: string
  effectiveOn: ISODate
  summary: string
  link?: string
  requiresAck: boolean
  /** Earlier versions, oldest first (written when a new version is published in Compliance > Notices). */
  history?: Array<{ version: string; effectiveOn: ISODate; summary?: string; link?: string }>
}

export type Acknowledgment = { id: ID; policyId: ID; version: string; personId: ID; acknowledgedOn: ISODate }

export type RecordsRequest = {
  id: ID
  personId: ID
  type: 'personnel_file' | 'payroll_records' | 'signed_documents'
  receivedOn: ISODate
  dueOn: ISODate
  fulfilledOn?: ISODate
}

// ---------------------------------------------------------------------------------------------
// Activity, settings, database
// ---------------------------------------------------------------------------------------------

export type EntityType =
  | 'candidate'
  | 'application'
  | 'job'
  | 'offer'
  | 'interview'
  | 'person'
  | 'checklist'
  | 'timeoff'
  | 'leave'
  | 'compliance'
  | 'equity'
  | 'plan'
  | 'contractor'
  | 'company'
  | 'settings'

export type Role = 'admin' | 'manager' | 'employee'

export type Activity = {
  id: ID
  at: ISODateTime
  actorId?: ID | null
  /** The Viewing-as mode the change was made in (preview approvals stay honest). */
  viewingAs?: Role
  entityType: EntityType
  entityId: ID
  /** Secondary entity, e.g. the candidate for an application event. */
  relatedId?: ID
  kind: string // 'stage_moved', 'note', 'emailed', 'called', 'offer_sent', 'hired', ...
  text: string
}

/** Inbox items are computed; only snoozes and dismissals are stored, keyed by a stable item key. */
export type InboxState = { snoozedUntil?: ISODate; dismissedOn?: ISODate }

/** Yearly legal values the user can update in Settings > Rules and rates (defaults: src/data/law.ts). */
export type LawSettings = {
  year: number
  caMinWageHourly: number
  exemptSalaryMin: number
  computerProHourly: number
  computerProAnnual: number
  form1099Threshold: number // 2000 for payments in 2026
  de542Threshold: number // 600
  lastReviewedOn: ISODate
  /** Per-value review dates from Settings > Rules and rates, keyed by field name (falls back to lastReviewedOn). */
  reviewedOn?: Record<string, ISODate>
}

export type Settings = {
  outcomeReasons: OutcomeReason[]
  defaultStages: JobStage[]
  scorecardDueHours: number // 24
  responseSlaBusinessDays: number // 5
  offerExpiryBusinessDays: number // 5
  referralBonusDefault: number
  referralBonusPayableDays: number // 90
  defaultVestingMonths: number
  defaultCliffMonths: number
  law: LawSettings
  roleTemplates: RoleTemplate[]
}

export type DB = {
  schemaVersion: 1
  meta: {
    createdOn: ISODate
    sample: boolean
    /** The date the sample was authored against; sample dates shift so it always looks current. */
    sampleAnchor?: ISODate
    /** Days the sample was shifted on load (whole weeks). */
    sampleShiftDays?: number
    lastExportedOn?: ISODateTime
    /**
     * Facts a demo sign-up filled in rather than asked for, as it filled them (src/features/settings/
     * demoLogic.ts). The public careers page shows each one only once the company changed it.
     */
    signupDefaults?: { hqCity: string; hqState: string; stage: string; workweek: string; foundedOn: ISODate }
  }
  company: Company
  departments: Department[]
  locations: Location[]
  families: JobFamily[]
  levels: Level[]
  bands: Band[]

  people: Person[]
  comp: CompRecord[]
  equity: EquitySetup
  grants: EquityGrant[]
  contractors: Contractor[]
  documents: DocumentRecord[]

  plan: PlanSlot[]
  jobs: Job[]
  candidates: Candidate[]
  applications: Application[]
  interviews: Interview[]
  scorecards: Scorecard[]
  offers: Offer[]
  referrals: Referral[]
  emailTemplates: EmailTemplate[]

  checklistTemplates: ChecklistTemplate[]
  checklists: Checklist[]

  timeOffPolicies: TimeOffPolicy[]
  timeOffRequests: TimeOffRequest[]
  timeOffAdjustments: TimeOffAdjustment[]
  holidays: Holiday[]
  leaveCases: LeaveCase[]

  complianceStatus: Record<string, ComplianceStatus>
  recurring: RecurringItem[]
  trainings: Training[]
  policies: Policy[]
  acks: Acknowledgment[]
  recordsRequests: RecordsRequest[]

  inboxState: Record<string, InboxState>
  activity: Activity[]
  settings: Settings
}

/** Keys of DB whose value is an array of records with an id. */
export type CollectionKey = {
  [K in keyof DB]: DB[K] extends Array<{ id: ID }> ? K : never
}[keyof DB]

/** Who is looking: the Viewing-as role plus the person viewed as. */
export type Viewer = { role: Role; person: Person | undefined; personId: ID | null }
