// The compliance rule catalog: rules as data. Each rule says when it starts to apply (a headcount
// threshold counted a specific way, a site count, a first-time event, or always), what to do in plain
// English, and where the official source is. Facts come from docs/LAW.md (ids in `lawIds`); rules
// marked `verification: 'needs_review'` rest on general knowledge that the research pass did not check.
// Not legal advice; every card in the UI says to confirm with counsel or the PEO.
import type { ISODate } from '@/lib/dates'

export type Jurisdiction = 'federal' | 'california' | 'san_jose' | 'other_state'

export type RuleCategory = 'hiring' | 'pay' | 'leave' | 'safety' | 'notices' | 'benefits' | 'records' | 'tax' | 'equity'

/**
 * How a rule counts people.
 * - w2_one_in_ca: W-2 employees in any state, part-time and interns included, on leave included (at least one in CA).
 * - w2_plus_contractors: W-2 employees plus active contractors. Harassment training threshold. Advisors are left out
 *   (a product judgment call: Gov. Code 12950.1 counts people serving under contract, so the count explains when
 *   counting advisors would change the answer and the admin can override it).
 * - weeks_20: n+ employees on every weekday of 20 calendar weeks in the current or prior calendar year (federal test).
 * - cobra_prior_year: n+ employees on more than half of typical business days in the prior calendar year.
 * - site: people at one workplace at the same time (Location.typicalMaxOnSite); remote staff excluded.
 * - w2_at_location: employees who work at one location (onsite or hybrid).
 * - in_san_jose: employees who work within San Jose city limits (at a San Jose site, or remote from San Jose).
 */
export type CountMethod =
  | 'w2_one_in_ca'
  | 'w2_plus_contractors'
  | 'weeks_20'
  | 'cobra_prior_year'
  | 'site'
  | 'w2_at_location'
  | 'in_san_jose'

export type ComplianceEvent =
  | 'first_payroll'
  | 'first_non_owner_employee'
  | 'first_contractor'
  | 'first_option_grant'
  | 'first_out_of_state_employee'
  | 'first_remote_employee'
  | 'first_group_health_plan'
  | 'first_non_founder_manager'
  | 'first_non_exempt_hire'
  | 'first_visa_sponsorship'
  | 'first_separation'
  | 'ccpa_revenue'
  | 'credit_check'

export type RuleTrigger =
  | { kind: 'headcount'; n: number; method: CountMethod }
  | { kind: 'site'; n: number }
  | { kind: 'event'; event: ComplianceEvent }
  | { kind: 'always' }

/** One-tap task on a rule card. Ids are stable within the rule (done dates are stored by id). */
export type RuleAction = { id: string; title: string; link?: string }

/**
 * A yearly obligation inside a rule (the Feb 1 SB 294 notice, January posters, the Jan 31 1099-NEC filing).
 * The cycle for year Y runs from the day after the year Y-1 due date through the year Y due date. Its actions
 * count as done only for the cycle they were done in, so a card never stays done forever.
 */
export type RuleCycle = {
  kind: 'annual'
  /** 'MM-DD' due date each year. */
  dueMonthDay: string
  /** The rule's actions that repeat every cycle. */
  actionIds: string[]
  /** First year the yearly duty exists (SB 294's first notice was due Feb 1, 2026). */
  firstYear?: number
  /**
   * contractors_1099: owed only when a contractor was paid at or above the 1099-NEC threshold in the year before.
   * paid_employees: owed only when someone other than an owner with no pay is employed on the due date (the
   * yearly employee notices; a solo founder working unpaid has no one to send them to).
   */
  requires?: 'contractors_1099' | 'paid_employees'
}

export type ComplianceRule = {
  /** Stable kebab id; db.complianceStatus is keyed by it. */
  id: string
  title: string
  /** Plain-English what to do, 1 to 3 sentences. */
  summary: string
  jurisdiction: Jurisdiction
  trigger: RuleTrigger
  /** Plain note on how this rule counts, shown under 'How we counted'. */
  countMethod: string
  actions: RuleAction[]
  citation: { label: string; url: string }
  lastReviewedOn: ISODate
  statutory: boolean
  /** Only the pay scale rule at 15 blocks an action (marking a job posted without a range). */
  hardStop: boolean
  /** Thresholds above 20: shown faded on the ruler. */
  upcoming: boolean
  category: RuleCategory
  /** Recommended (not yet required) once the same count reaches this number. */
  recommendFrom?: number
  /** Applies only when the company has a workplace or people in this city. */
  scope?: { city: string }
  /** Becomes not applicable once this other rule applies (Cal-COBRA gives way to federal COBRA). */
  supersededBy?: string
  /** Statutory clock: the first action is due this many days after the trigger date. */
  dueDaysAfterTrigger?: number
  /**
   * A filing with an agency (EDD's DE 1 and DE 34): when its deadline lands on a weekend or company holiday it
   * gets a 'file by' day, the business day before, like the DE 34 checklist task (taskFileBy).
   */
  agencyFiling?: boolean
  /**
   * What the rule's own deadline asks for, finishing '<title>: <dueLabel>' on the compliance calendar and Home
   * ('file the 25102(o) notice with the DFPI'), where the title alone would not say. Without one: '<title>: due'.
   */
  dueLabel?: string
  /**
   * The law takes effect on this date (for example, contracts entered on or after it). Until then the rule
   * applies as preparation ('Applies to contracts from Jan 1, 2027: prepare now'), never 'since' founding.
   */
  effectiveOn?: ISODate
  /** Counting tweaks for this rule (Cal-COBRA falls back to the prior quarter for a business with no employees last year). */
  countOptions?: { priorQuarterFallback?: boolean }
  /** Yearly actions (see RuleCycle). */
  cycle?: RuleCycle
  /** Fact ids in docs/LAW.md this rule relies on. */
  lawIds: string[]
  /** 'verified' = backed by docs/LAW.md; 'needs_review' = not checked in the research pass. */
  verification: 'verified' | 'needs_review'
}

export const RULES_LAST_REVIEWED: ISODate = '2026-10-09'

/** CCPA revenue threshold for 2025 and 2026 (CPI-adjusted on Jan 1 of odd years; next Jan 1, 2027). */
export const CCPA_REVENUE_THRESHOLD = 26_625_000

/** Recurring items (db.recurring) for the SOC 2 quarterly access review carry this ruleId. Not a legal rule. */
export const SOC2_ACCESS_REVIEW_ID = 'soc2-access-review'

/** Key in complianceStatus[ruleId].actionsDone that marks a whole yearly cycle done (calendar tick, markAnnualDone). */
export function annualDoneKey(year: number): string {
  return `year-${year}`
}

/** Key in complianceStatus[ruleId].actionsDone for one yearly action done for a cycle year ('send-annual@2027'). */
export function cycleActionKey(actionId: string, year: number): string {
  return `${actionId}@${year}`
}

const R = RULES_LAST_REVIEWED

const SRC = {
  workersComp: { label: "Labor Code 3700 (DIR employer page)", url: 'https://www.dir.ca.gov/dwc/employer.htm' },
  eddRegister: { label: 'EDD: register as an employer', url: 'https://edd.ca.gov/en/payroll_taxes/step-1-register-as-an-employer/' },
  de34: { label: 'EDD new hire reporting', url: 'https://edd.ca.gov/en/payroll_taxes/new_hire_reporting/' },
  i9: {
    label: 'USCIS Form I-9, Section 2',
    url: 'https://www.uscis.gov/i-9-central/complete-correct-form-i-9/completing-section-2-employer-review-and-attestation',
  },
  eddRates: { label: 'EDD rates and withholding (W-4 and DE 4)', url: 'https://edd.ca.gov/en/payroll_taxes/rates_and_withholding/' },
  sickLeave: { label: 'DIR paid sick leave (Labor Code 246)', url: 'https://www.dir.ca.gov/dlse/paid_sick_leave.htm' },
  calsavers: { label: 'CalSavers FAQ', url: 'https://www.calsavers.com/home/frequently-asked-questions.html' },
  iipp: { label: '8 CCR 3203 (IIPP)', url: 'https://www.dir.ca.gov/title8/3203.html' },
  dolPosters: { label: 'DOL workplace posters', url: 'https://www.dol.gov/general/topics/posters' },
  caPosters: { label: 'DIR required posters and notices', url: 'https://www.dir.ca.gov/wpnodb.html' },
  sjMinWage: {
    label: 'San Jose minimum wage ordinance',
    url: 'https://www.sanjoseca.gov/your-government/departments-offices/public-works/labor-compliance/minimum-wage-ordinance',
  },
  lc2810_5: {
    label: 'Labor Code 2810.5',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=2810.5.&lawCode=LAB',
  },
  overtime: { label: 'DIR overtime FAQ', url: 'https://www.dir.ca.gov/dlse/faq_overtime.htm' },
  lc1553: {
    label: 'Labor Code 1553 (SB 294)',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=1553.&lawCode=LAB',
  },
  sb294Part: {
    label: 'Labor Code 1550 to 1559 (SB 294)',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?lawCode=LAB&division=2.&title=&part=5.6.&chapter=&article=',
  },
  lc1034: {
    label: 'Labor Code 1034',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=1034.&lawCode=LAB',
  },
  lc432_3: {
    label: 'Labor Code 432.3',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=432.3.&lawCode=LAB',
  },
  bpc16600_1: {
    label: 'Business and Professions Code 16600.1',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=16600.1.&lawCode=BPC',
  },
  ab1697: {
    label: 'AB 1697 (stay-or-pay, B&P 16608)',
    url: 'https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202520260AB1697',
  },
  ccr11008: { label: 'Gov. Code 12940(j) and 2 CCR 11008', url: 'https://www.law.cornell.edu/regulations/california/2-CCR-11008' },
  gov12950: {
    label: 'Gov. Code 12950',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=12950.&lawCode=GOV',
  },
  ads: {
    label: 'CRD automated-decision system regulations',
    url: 'https://calcivilrights.ca.gov/wp-content/uploads/sites/32/2025/06/Final-Text-regulations-automated-employment-decision-systems.pdf',
  },
  lc1198_5: {
    label: 'Labor Code 1198.5',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=1198.5.&lawCode=LAB',
  },
  policy11023: {
    label: '2 CCR 11023 (CRD summary)',
    url: 'https://calcivilrights.ca.gov/wp-content/uploads/sites/32/2017/06/CAamendedFEHAregsEmployers20160401Final.pdf',
  },
  shpt: {
    label: 'Gov. Code 12950.1 (CRD training FAQ)',
    url: 'https://calcivilrights.ca.gov/wp-content/uploads/sites/32/2022/11/Sexual-Harassment-Prevention-Training-For-Employers-FAQ_ENG.pdf',
  },
  cfra: {
    label: 'Gov. Code 12945.2 (CFRA)',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=12945.2.&lawCode=GOV',
  },
  bereavement: {
    label: 'Gov. Code 12945.7 and 12945.6',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=12945.7.&lawCode=GOV',
  },
  fairChance: {
    label: 'Gov. Code 12952 (Fair Chance Act)',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=12952.&lawCode=GOV',
  },
  sb700: {
    label: 'Gov. Code 12954 (SB 700)',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=12954.&lawCode=GOV',
  },
  wvpp: {
    label: 'Labor Code 6401.9 (SB 553)',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=6401.9.&lawCode=LAB',
  },
  payScale: { label: 'Labor Code 432.3 (DIR pay transparency FAQ)', url: 'https://www.dir.ca.gov/dlse/california_equal_pay_act.htm' },
  organDonor: {
    label: 'Labor Code 1510',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=1510.&lawCode=LAB',
  },
  eeoc: { label: 'EEOC Compliance Manual, Section 2', url: 'https://www.eeoc.gov/laws/guidance/section-2-threshold-issues' },
  cobra: {
    label: 'DOL employer guide to COBRA',
    url: 'https://www.dol.gov/sites/dolgov/files/ebsa/about-ebsa/our-activities/resource-center/publications/an-employers-guide-to-group-health-continuation-coverage-under-cobra.pdf',
  },
  calCobra: { label: 'CDI health FAQ (Cal-COBRA)', url: 'https://www.insurance.ca.gov/01-consumers/110-health/frequently-asked-questions.cfm' },
  victims: {
    label: 'Gov. Code 12945.8',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=12945.8.&lawCode=GOV',
  },
  lc230_8: {
    label: 'Labor Code 230.8',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=230.8.&lawCode=LAB',
  },
  lc1025: {
    label: 'Labor Code 1025 and 1041',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=1025.&lawCode=LAB',
  },
  sjOwo: {
    label: 'San Jose Opportunity to Work FAQ',
    url: 'https://www.sanjoseca.gov/home/showpublisheddocument/20083/639252317238600000',
  },
  fmla: { label: 'WHD Fact Sheet 28 (FMLA)', url: 'https://www.dol.gov/agencies/whd/fact-sheets/28-fmla' },
  aca: {
    label: 'IRS: applicable large employer test',
    url: 'https://www.irs.gov/affordable-care-act/employers/determining-if-an-employer-is-an-applicable-large-employer',
  },
  calWarn: { label: 'EDD WARN (Cal-WARN)', url: 'https://edd.ca.gov/en/jobs_and_training/Layoff_Services_WARN/' },
  eeo1: { label: 'EEOC data collections (EEO-1)', url: 'https://www.eeoc.gov/data/eeo-data-collections' },
  payData: { label: 'CRD pay data reporting FAQ', url: 'https://calcivilrights.ca.gov/paydatareporting/faqs/' },
  fedWarn: { label: 'DOL WARN Act', url: 'https://www.dol.gov/agencies/eta/layoffs/warn' },
  abc: { label: 'Labor Code 2775 (ABC test)', url: 'https://california.public.law/codes/labor_code_section_2775' },
  irs1099: { label: 'IRS instructions for 1099-NEC', url: 'https://www.irs.gov/instructions/i1099mec' },
  corp25102o: {
    label: 'Corporations Code 25102(o)',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=25102.&lawCode=CORP',
  },
  lc2802: {
    label: 'Labor Code 2802',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=2802.&lawCode=LAB',
  },
  h1b: { label: 'DOL H-1B program (LCA)', url: 'https://www.dol.gov/agencies/whd/immigration/h1b' },
  ccpa: { label: 'CPPA FAQ (CCPA thresholds)', url: 'https://cppa.ca.gov/faq.html' },
  lc1024_5: { label: 'Labor Code 1024.5', url: 'https://california.public.law/codes/labor_code_section_1024.5' },
  finalPay: { label: 'DIR paydays and final pay FAQ', url: 'https://www.dir.ca.gov/dlse/faq_paydays.htm' },
} satisfies Record<string, { label: string; url: string }>

const CRD_COURSE = 'https://calcivilrights.ca.gov/shpt/'

const W2 = 'W-2 employees in any state, part-time staff and interns included, people on leave included. Contractors and advisors do not count.'

type RuleInput = Omit<ComplianceRule, 'lastReviewedOn' | 'hardStop' | 'upcoming' | 'statutory' | 'verification'> &
  Partial<Pick<ComplianceRule, 'hardStop' | 'upcoming' | 'statutory' | 'verification'>>

function rule(r: RuleInput): ComplianceRule {
  return { statutory: true, hardStop: false, upcoming: false, verification: 'verified', lastReviewedOn: R, ...r }
}

export const RULES: ComplianceRule[] = [
  // ------------------------------------------------------------------------------------------
  // From the first employee (and always)
  // ------------------------------------------------------------------------------------------
  rule({
    id: 'workers-comp',
    title: "Workers' compensation insurance",
    summary:
      "Every California employer needs workers' comp coverage, even with one employee. Bind a policy before your first non-owner hire starts and save the carrier in Settings, because the wage notice and the SB 294 notice both name it.",
    jurisdiction: 'california',
    trigger: { kind: 'event', event: 'first_non_owner_employee' },
    countMethod: 'Starts with the first employee who is not an owner. Owner-officers may exclude themselves.',
    actions: [
      { id: 'bind-policy', title: "Bind a workers' comp policy" },
      { id: 'save-carrier', title: 'Save the carrier name and phone in Settings' },
      { id: 'new-hire-pamphlet', title: "Give each new hire the workers' comp pamphlet by the end of the first pay period" },
    ],
    citation: SRC.workersComp,
    category: 'safety',
    lawIds: ['a-wc-1', 'a-newhire-pamphlets-1'],
  }),
  rule({
    id: 'edd-registration',
    title: 'EDD employer registration (DE 1)',
    summary:
      'Register with EDD for a payroll tax account within 15 days of first paying more than $100 in wages in a quarter, even if the only W-2 employee is you. Save the EDD account number in Settings.',
    jurisdiction: 'california',
    trigger: { kind: 'event', event: 'first_payroll' },
    countMethod:
      'Triggered by the first payroll, not by headcount. Uses the first payroll date from Settings; without it, the first start date on record is an estimate.',
    actions: [
      { id: 'register', title: 'Register in EDD e-Services for Business', link: SRC.eddRegister.url },
      { id: 'save-account', title: 'Save the EDD account number in Settings' },
    ],
    citation: SRC.eddRegister,
    category: 'tax',
    dueDaysAfterTrigger: 15,
    agencyFiling: true,
    lawIds: ['a-edd-register-1'],
  }),
  rule({
    id: 'new-hire-reporting',
    title: 'New hire reporting (DE 34)',
    summary:
      'Report each new or rehired employee who works in California to EDD within 20 days of their start date. Most PEOs file this for you, so confirm it was filed. Someone rehired after a gap of 60 days or more counts as new.',
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 1, method: 'w2_one_in_ca' },
    countMethod: 'Every new or rehired employee working in California, starting with the first.',
    actions: [
      { id: 'confirm-provider', title: 'Confirm your payroll provider or PEO files DE 34' },
      { id: 'onboarding-task', title: 'Keep the DE 34 task in every onboarding checklist' },
    ],
    citation: SRC.de34,
    category: 'tax',
    agencyFiling: true,
    lawIds: ['a-de34-1', 'b-w4-de4-de34'],
  }),
  rule({
    id: 'form-i9',
    title: 'Form I-9 for every employee',
    summary:
      'Every new employee completes Section 1 of Form I-9 by their first day, and you complete Section 2 within 3 business days. Keep each form 3 years after hire or 1 year after exit, whichever is later. Track status and dates here, never the form.',
    jurisdiction: 'federal',
    trigger: { kind: 'headcount', n: 1, method: 'w2_one_in_ca' },
    countMethod: 'Every employee hired, starting with employee 1. Contractors are not included.',
    actions: [
      { id: 'current-edition', title: 'Use the current I-9 edition (01/20/25)', link: 'https://www.uscis.gov/i-9' },
      { id: 'onboarding-tasks', title: 'Keep I-9 section 1 and section 2 tasks in onboarding' },
      { id: 'retention', title: 'Track each I-9 retain-until date' },
    ],
    citation: SRC.i9,
    category: 'hiring',
    lawIds: ['b-i9-deadlines', 'b-i9-retention', 'b-i9-edition'],
  }),
  rule({
    id: 'w4-de4',
    title: 'Tax withholding forms (W-4 and DE 4)',
    summary:
      'New hires complete a federal W-4 and a California DE 4 on day 1. Without a valid DE 4, withhold as single with zero allowances.',
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 1, method: 'w2_one_in_ca' },
    countMethod: 'Every W-2 employee, starting with the first.',
    actions: [{ id: 'onboarding-task', title: 'Add W-4 and DE 4 to day 1 onboarding' }],
    citation: SRC.eddRates,
    category: 'tax',
    lawIds: ['b-w4-de4-de34'],
  }),
  rule({
    id: 'paid-sick-leave',
    title: 'California paid sick leave',
    summary:
      'Give every employee at least 40 hours or 5 days of paid sick leave a year, front-loaded or earned at 1 hour per 30 worked. You may cap use at 40 hours or 5 days a year, whichever is more, and ask for 90 days of employment before use. Show the balance on each pay stub.',
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 1, method: 'w2_one_in_ca' },
    countMethod: 'All employees who work 30 or more days in California within a year, part-time and temporary included.',
    actions: [
      { id: 'set-policy', title: 'Set up the sick leave policy (40 hours front-loaded is the default)' },
      { id: 'pay-stub', title: 'Confirm sick balances print on pay stubs' },
    ],
    citation: SRC.sickLeave,
    category: 'leave',
    lawIds: ['a-psl-1', 'w-psl-accrual', 'w-psl-caps', 'w-psl-wage-statement'],
  }),
  rule({
    id: 'calsavers-or-401k',
    title: 'CalSavers or a retirement plan',
    summary:
      "Once you have an employee who is not an owner, offer a qualified plan such as a 401(k) or register with CalSavers. CalSavers sets your deadline in a notice based on last year's payroll filings, so this is not overdue at your first hire: record the notice deadline here when it arrives. If you register, add each new hire within 30 days.",
    jurisdiction: 'california',
    trigger: { kind: 'event', event: 'first_non_owner_employee' },
    countMethod:
      'Starts with the first employee who is not an owner (owner-only companies are exempt). CalSavers itself assesses coverage each spring from the prior year EDD filings.',
    actions: [
      { id: 'choose-plan', title: 'Choose a 401(k) through your PEO or register with CalSavers' },
      { id: 'file-exemption', title: 'File the CalSavers exemption once you sponsor a qualified plan' },
      { id: 'record-deadline', title: 'Record the CalSavers notice deadline here when it arrives' },
    ],
    citation: SRC.calsavers,
    category: 'benefits',
    lawIds: ['w-calsavers', 'a-calsavers-1'],
  }),
  rule({
    id: 'iipp',
    title: 'Injury and illness prevention program (IIPP)',
    summary:
      'Every employer needs a written IIPP and a named person responsible for it. Under 10 employees you may give safety instructions orally and keep a simple log of them.',
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 1, method: 'w2_one_in_ca' },
    countMethod: 'All employers. The relaxed record rules last while you have fewer than 10 employees.',
    actions: [
      { id: 'write-iipp', title: 'Write the IIPP' },
      { id: 'name-owner', title: 'Name the person responsible' },
      { id: 'safety-training', title: 'Add IIPP safety instructions to onboarding' },
    ],
    citation: SRC.iipp,
    category: 'safety',
    lawIds: ['a-iipp-1'],
  }),
  rule({
    id: 'posters-federal',
    title: 'Federal workplace posters',
    summary:
      'Post the federal notices that apply at your size where employees can see them, and share electronic copies with remote staff. The DOL poster advisor lists which ones you need.',
    jurisdiction: 'federal',
    trigger: { kind: 'headcount', n: 1, method: 'w2_one_in_ca' },
    countMethod: 'From the first employee. Some federal notices (such as the EEO notice) start at 15.',
    actions: [
      { id: 'poster-advisor', title: 'Check the DOL poster advisor', link: 'https://webapps.dol.gov/elaws/posters.htm' },
      { id: 'post', title: 'Post them at HQ and share electronic copies with remote staff' },
    ],
    citation: SRC.dolPosters,
    category: 'notices',
    lawIds: [],
    verification: 'needs_review',
  }),
  rule({
    id: 'posters-california',
    title: 'California workplace posters',
    summary:
      "Post the California required notices at HQ, including the minimum wage order, paid sick leave, CRD discrimination and harassment, workers' comp and EDD DE 1857A notices. Replace them each January.",
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 1, method: 'w2_one_in_ca' },
    countMethod: 'From the first employee.',
    actions: [
      { id: 'post', title: 'Post the current California notices at HQ', link: SRC.caPosters.url },
      { id: 'remote-copies', title: 'Share electronic copies with remote staff' },
    ],
    citation: SRC.caPosters,
    category: 'notices',
    cycle: { kind: 'annual', dueMonthDay: '01-31', actionIds: ['post', 'remote-copies'] },
    lawIds: ['a-newhire-pamphlets-1', 'a-psl-1', 'a-sh-infosheet-5'],
  }),
  rule({
    id: 'posters-san-jose',
    title: 'San Jose minimum wage bulletin',
    summary:
      'Post the 2026 San Jose minimum wage bulletin ($18.45 an hour) at your San Jose workplace. The city rate applies to work done in San Jose at any company size.',
    jurisdiction: 'san_jose',
    trigger: { kind: 'headcount', n: 1, method: 'w2_one_in_ca' },
    countMethod: 'Applies to work done within San Jose city limits, whatever your size.',
    actions: [{ id: 'post', title: 'Post the San Jose minimum wage bulletin', link: SRC.sjMinWage.url }],
    citation: SRC.sjMinWage,
    category: 'notices',
    scope: { city: 'San Jose' },
    cycle: { kind: 'annual', dueMonthDay: '01-01', actionIds: ['post'] },
    lawIds: ['a-sj-minwage-1', 'w-sj-minwage-2026'],
  }),
  rule({
    id: 'sb294-annual-notice',
    title: 'SB 294 workplace rights notice (every Feb 1)',
    summary:
      "Send every employee the Labor Commissioner's stand-alone workplace rights notice by February 1 each year, in a way they receive within one business day. Keep the date each notice was sent for 3 years.",
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 1, method: 'w2_one_in_ca' },
    countMethod: 'All employees.',
    actions: [
      { id: 'send-annual', title: "Send this year's notice by Feb 1" },
      { id: 'record-dates', title: 'Record the date it was sent' },
    ],
    citation: SRC.lc1553,
    category: 'notices',
    cycle: { kind: 'annual', dueMonthDay: '02-01', actionIds: ['send-annual', 'record-dates'], firstYear: 2026, requires: 'paid_employees' },
    lawIds: ['a-sb294-1', 'b-ca-sb294-rights-notice'],
  }),
  rule({
    id: 'sb294-new-hire',
    title: 'SB 294 notice and emergency contact at hire',
    summary:
      'Give each new hire the workplace rights notice when they are hired, and offer them the chance to name an emergency contact to be told if they are arrested or detained at work. They can change it any time.',
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 1, method: 'w2_one_in_ca' },
    countMethod: 'Every new employee.',
    actions: [
      { id: 'onboarding-notice', title: 'Add the SB 294 notice to the notices packet' },
      { id: 'emergency-contact', title: 'Offer the arrest-notification contact at hire' },
    ],
    citation: SRC.sb294Part,
    category: 'notices',
    lawIds: ['a-sb294-1', 'b-ca-sb294-rights-notice'],
  }),
  rule({
    id: 'lactation-policy',
    title: 'Lactation accommodation policy',
    summary:
      'Keep a written lactation accommodation policy in your handbook and give it to every new hire and to anyone who asks about parental leave. Provide a private space that is not a bathroom, near a sink and a refrigerator.',
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 1, method: 'w2_one_in_ca' },
    countMethod: 'All employers. Under 50 employees, some space rules can be eased for undue hardship, but not the written policy.',
    actions: [
      { id: 'write-policy', title: 'Add the lactation policy to the handbook' },
      { id: 'onboarding', title: 'Give it to new hires in the notices packet' },
      { id: 'space', title: 'Identify a private space that is not a bathroom' },
    ],
    citation: SRC.lc1034,
    category: 'leave',
    lawIds: ['a-lactation-1'],
  }),
  rule({
    id: 'victims-leave-notice',
    title: 'Survivors of violence leave notice',
    summary:
      'Give every employee the CRD notice on leave and accommodations for survivors of violence and family members of victims at hire, every year, on request, and when someone tells you they are a victim. Jury duty, witness duty and some victim leave apply at any size.',
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 1, method: 'w2_one_in_ca' },
    countMethod: 'The notice and the basic jury, witness and victim leave apply to all employers. More leave purposes start at 25.',
    actions: [
      { id: 'onboarding', title: 'Add the CRD notice to the notices packet' },
      { id: 'annual', title: 'Send it to everyone once a year' },
    ],
    citation: SRC.victims,
    category: 'notices',
    cycle: { kind: 'annual', dueMonthDay: '02-01', actionIds: ['annual'], requires: 'paid_employees' },
    lawIds: ['a-victims-leave-25'],
  }),
  rule({
    id: 'salary-history-ban',
    title: 'No salary history questions',
    summary:
      'Never ask applicants about their current or past pay, and do not rely on it. You may ask what pay they want; this app keeps desired pay only.',
    jurisdiction: 'california',
    trigger: { kind: 'always' },
    countMethod: 'All employers, at any size.',
    actions: [
      { id: 'interviewers', title: 'Tell interviewers to ask about desired pay only' },
      { id: 'agencies', title: 'Check that recruiters and agencies follow the same rule' },
    ],
    citation: SRC.lc432_3,
    category: 'hiring',
    lawIds: ['a-payreq-1'],
  }),
  rule({
    id: 'pay-scale-on-request',
    title: 'Pay scale on request',
    summary:
      'Give an applicant the pay scale for the job when they reasonably ask, and give an employee the pay scale for their current position when they ask, at any company size.',
    jurisdiction: 'california',
    trigger: { kind: 'always' },
    countMethod: 'All employers, at any size.',
    actions: [
      { id: 'ranges', title: 'Keep a pay range on every job' },
      { id: 'respond', title: 'Answer requests from the job or profile page' },
    ],
    citation: SRC.lc432_3,
    category: 'pay',
    lawIds: ['a-payreq-1', 'b-ca-pay-scale-15'],
  }),
  rule({
    id: 'wage-rate-history',
    title: 'Job title and wage rate history',
    summary:
      "Keep each employee's job title and wage rate history for their employment plus 3 years. The Job and pay tab is that record, so never delete history rows.",
    jurisdiction: 'california',
    trigger: { kind: 'always' },
    countMethod: 'All employers, at any size.',
    actions: [{ id: 'keep-history', title: 'Record every pay or title change as a new history row' }],
    citation: SRC.lc432_3,
    category: 'records',
    lawIds: ['a-payreq-1', 'a-paytrans-15'],
  }),
  rule({
    id: 'noncompete-notice',
    title: 'No noncompetes',
    summary:
      'Noncompete clauses are void in California. Keep them out of offer letters and agreements and use confidentiality and invention assignment terms instead. If an older contract had one, the void notice was due Feb 14, 2024.',
    jurisdiction: 'california',
    trigger: { kind: 'always' },
    countMethod: 'All employers, at any size.',
    actions: [
      { id: 'review-templates', title: 'Review offer letter and PIIA templates for noncompete language' },
      { id: 'void-notice', title: 'Send the void notice for any older contract that had a noncompete' },
    ],
    citation: SRC.bpc16600_1,
    category: 'hiring',
    lawIds: ['a-noncompete-1'],
  }),
  rule({
    id: 'stay-or-pay-ban',
    title: 'No stay-or-pay terms (contracts from 2027)',
    summary:
      'For contracts entered on or after Jan 1, 2027, do not make workers repay training costs or pay a fee for leaving. A sign-on bonus clawback is allowed only in a separate agreement that is prorated over no more than 2 years, charges no interest, allows deferral, gives 5 business days to consult a lawyer, and applies only if they quit or are fired for misconduct.',
    jurisdiction: 'california',
    trigger: { kind: 'always' },
    effectiveOn: '2027-01-01',
    countMethod: 'All employers. "Worker" includes prospective employees.',
    actions: [
      { id: 'review-offers', title: 'Check offer templates for repayment clauses before Jan 1, 2027' },
      { id: 'separate-agreement', title: 'Put any sign-on bonus clawback in a separate agreement' },
    ],
    citation: SRC.ab1697,
    category: 'pay',
    lawIds: ['a-stayorpay-1'],
  }),
  rule({
    id: 'harassment-ban',
    title: 'Harassment is banned at any size',
    summary:
      "California's harassment ban covers employers with even 1 employee or 1 contractor. Take every concern seriously and respond promptly, even before you have a formal policy.",
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 1, method: 'w2_plus_contractors' },
    countMethod: 'One or more employees, or one or more contractors.',
    actions: [{ id: 'complaint-path', title: 'Write down how to raise a concern and who hears it' }],
    citation: SRC.ccr11008,
    category: 'safety',
    lawIds: ['a-feha-5'],
  }),
  rule({
    id: 'harassment-info-sheet',
    title: 'Sexual harassment information sheet',
    summary:
      "Give every employee CRD's sexual harassment information sheet (CRD-185) or equivalent information. It is required at 5 employees and recommended from your first hire, so the notices packet includes it from day one.",
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 5, method: 'w2_one_in_ca' },
    countMethod: `${W2} Recommended from the first hire.`,
    actions: [
      { id: 'add-to-packet', title: 'Add the CRD fact sheet to the notices packet' },
      { id: 'distribute', title: 'Give it to current employees' },
    ],
    citation: SRC.gov12950,
    category: 'notices',
    recommendFrom: 1,
    lawIds: ['a-sh-infosheet-5'],
  }),
  rule({
    id: 'records-retention',
    title: 'Personnel and payroll records',
    summary:
      'Let current and former employees see their personnel file within 30 days of a written request and their payroll records within 21 days. Keep personnel files and applicant records at least 4 years after the employment action once you have 5 employees (Gov. Code 12946); Labor Code 1198.5 sets 3 years below that. Keep payroll records at least 3 years.',
    jurisdiction: 'california',
    trigger: { kind: 'always' },
    countMethod: 'All employers, at any size. The 4-year period applies to FEHA employers (5 or more employees); this app keeps 4 years at every size.',
    actions: [
      { id: 'requests', title: 'Log records requests with their due dates' },
      { id: 'retention', title: 'Check retain-until dates before deleting anything' },
    ],
    citation: SRC.lc1198_5,
    category: 'records',
    lawIds: ['a-records-1', 'a-ads-1', 'w-wage-statement-retention'],
  }),

  // ------------------------------------------------------------------------------------------
  // First-time events
  // ------------------------------------------------------------------------------------------
  rule({
    id: 'wage-notice-2810-5',
    title: 'Wage notice for non-exempt hires (Labor Code 2810.5)',
    summary:
      "Give each non-exempt hire a written notice of pay rate, overtime rate, payday, workers' comp carrier, sick leave and any recent disaster declaration, no later than their first day. Send a written change notice within 7 days unless the change shows on the next timely pay stub.",
    jurisdiction: 'california',
    trigger: { kind: 'event', event: 'first_non_exempt_hire' },
    countMethod: 'Starts with the first non-exempt (overtime-eligible) employee. Exempt employees are excluded.',
    actions: [
      { id: 'template', title: 'Use the DLSE notice template', link: 'https://dir.ca.gov/dlse/FAQs-NoticetoEmployee.html' },
      { id: 'onboarding', title: 'Add the notice to onboarding for non-exempt hires' },
      { id: 'change-notices', title: 'Send change notices within 7 days' },
    ],
    citation: SRC.lc2810_5,
    category: 'notices',
    lawIds: ['a-wtpa-1', 'b-ca-lc2810-5-notice', 'w-wtpa-notice'],
  }),
  rule({
    id: 'first-non-exempt-hire',
    title: 'First non-exempt employee',
    summary:
      'Non-exempt staff earn overtime after 8 hours in a day or 40 in a week, a 30-minute meal period by the end of the fifth hour, and a paid 10-minute rest break per 4 hours. Set up timekeeping in payroll and a meal and rest break policy before they start.',
    jurisdiction: 'california',
    trigger: { kind: 'event', event: 'first_non_exempt_hire' },
    countMethod: 'Starts with the first non-exempt employee.',
    actions: [
      { id: 'timekeeping', title: 'Turn on timekeeping in payroll' },
      { id: 'meal-rest', title: 'Add a meal and rest break policy' },
      { id: 'sick-accrual', title: 'Confirm sick leave for hourly staff' },
    ],
    citation: SRC.overtime,
    category: 'pay',
    lawIds: ['w-daily-overtime', 'w-meal-periods', 'w-rest-periods'],
  }),
  rule({
    id: 'first-contractor',
    title: 'First contractor',
    summary:
      'Before you sign a contractor, run the ABC test: free from your control, doing work outside your usual business, and running their own independent business. File EDD DE 542 within 20 days for individuals paid or contracted for $600 or more, collect a W-9, and file a 1099-NEC by Jan 31 for anyone paid $2,000 or more in 2026.',
    jurisdiction: 'california',
    trigger: { kind: 'event', event: 'first_contractor' },
    countMethod: 'Starts with the first contractor. Advisors paid only in equity do not trigger it.',
    actions: [
      { id: 'ab5-check', title: 'Run the AB5 check for each contractor' },
      { id: 'de542', title: 'File DE 542 for individual contractors within 20 days' },
      { id: 'w9', title: 'Collect a W-9 from each contractor' },
      { id: 'form-1099', title: 'File 1099-NEC forms by Jan 31', link: SRC.irs1099.url },
    ],
    citation: SRC.abc,
    category: 'tax',
    cycle: { kind: 'annual', dueMonthDay: '01-31', actionIds: ['form-1099'], requires: 'contractors_1099' },
    lawIds: ['b-ca-ab5-abc', 'b-1099nec-2026'],
  }),
  rule({
    id: 'first-option-grant',
    title: 'First stock option grant',
    summary:
      'File the California 25102(o) notice with the DFPI within 30 days of the first option grant, and grant options only at or above the fair market value from a current 409A valuation.',
    jurisdiction: 'california',
    trigger: { kind: 'event', event: 'first_option_grant' },
    countMethod: 'The first option issuance (board approval).',
    actions: [
      { id: 'get-409a', title: 'Get a 409A valuation before granting' },
      { id: 'file-25102o', title: 'File the 25102(o) notice within 30 days' },
      { id: 'board-consent', title: 'Approve every grant by board consent' },
    ],
    citation: SRC.corp25102o,
    category: 'equity',
    dueDaysAfterTrigger: 30,
    dueLabel: 'file the 25102(o) notice with the DFPI',
    lawIds: [],
    verification: 'needs_review',
  }),
  rule({
    id: 'first-out-of-state-employee',
    title: 'First employee outside California',
    summary:
      "When someone works from another state, register for that state's withholding and unemployment insurance, follow its paid leave and posting rules, and share required notices electronically. Reimburse necessary work expenses such as home internet (Labor Code 2802).",
    jurisdiction: 'other_state',
    trigger: { kind: 'event', event: 'first_out_of_state_employee' },
    countMethod: 'Starts with the first employee whose home state is not California.',
    actions: [
      { id: 'register-state', title: 'Register for state withholding and unemployment insurance' },
      { id: 'electronic-posting', title: 'Share required notices electronically' },
      { id: 'reimbursement', title: 'Set a home office reimbursement policy' },
      { id: 'state-card', title: 'Review the new-state card for their state' },
    ],
    citation: SRC.lc2802,
    category: 'tax',
    lawIds: [],
    verification: 'needs_review',
  }),
  rule({
    id: 'first-remote-employee',
    title: 'First remote employee',
    summary:
      'When someone works from home, in California or elsewhere, share the required notices electronically as well as on the office wall, and reimburse necessary work expenses such as home internet and a phone used for work (Labor Code 2802).',
    jurisdiction: 'california',
    trigger: { kind: 'event', event: 'first_remote_employee' },
    countMethod: 'Starts with the first employee who works remotely, in any state.',
    actions: [
      { id: 'electronic-posting', title: 'Share required notices electronically' },
      { id: 'reimbursement', title: 'Set a home office reimbursement policy' },
    ],
    citation: SRC.lc2802,
    category: 'pay',
    lawIds: [],
    verification: 'needs_review',
  }),
  rule({
    id: 'first-group-health-plan',
    title: 'First group health plan',
    summary:
      'Once you offer a group health plan, departing employees get continuation coverage (Cal-COBRA through the carrier until federal COBRA applies at 20) and the state notice about help with premiums. Large-employer ACA reporting starts only at 50 full-time equivalents.',
    jurisdiction: 'california',
    trigger: { kind: 'event', event: 'first_group_health_plan' },
    countMethod: 'Starts on the date the group health plan began (Settings, Company).',
    actions: [
      { id: 'carrier-notice', title: 'Confirm who sends continuation notices (the carrier or the PEO)' },
      { id: 'offboarding-notices', title: 'Add continuation and premium-help notices to offboarding' },
      { id: 'aca-pointer', title: 'Note the 50-employee ACA reporting threshold' },
    ],
    citation: SRC.calCobra,
    category: 'benefits',
    lawIds: ['b-calcobra-2-19'],
    verification: 'needs_review',
  }),
  rule({
    id: 'first-non-founder-manager',
    title: 'First manager other than the founder',
    summary:
      "When someone other than the founder gets a direct report, they need the 2-hour supervisor harassment course within 6 months (once you have 5 employees and contractors). Route their team's time off and offers through them.",
    jurisdiction: 'california',
    trigger: { kind: 'event', event: 'first_non_founder_manager' },
    countMethod: 'The first date someone other than a founder has a direct report.',
    actions: [
      { id: 'supervisor-training', title: 'Assign the 2-hour supervisor course', link: CRD_COURSE },
      { id: 'manager-basics', title: 'Share how to handle complaints and time off requests' },
    ],
    citation: SRC.shpt,
    category: 'safety',
    lawIds: ['a-shpt-5', 'b-ca-harassment-training-5'],
  }),
  rule({
    id: 'first-visa-sponsorship',
    title: 'First visa sponsorship',
    summary:
      'Before filing an H-1B petition, post the Labor Condition Application notice at the worksite or electronically for 10 business days and keep a public access file. Store dates only, never immigration documents.',
    jurisdiction: 'federal',
    trigger: { kind: 'event', event: 'first_visa_sponsorship' },
    countMethod: 'The first accepted offer for a candidate who needs sponsorship.',
    actions: [
      { id: 'counsel', title: 'Engage immigration counsel' },
      { id: 'lca-posting', title: 'Post the LCA notice for 10 business days' },
      { id: 'public-file', title: 'Set up the public access file' },
    ],
    citation: SRC.h1b,
    category: 'hiring',
    lawIds: ['b-h1b-portability'],
    verification: 'needs_review',
  }),
  rule({
    id: 'first-separation',
    title: 'First employee departure',
    summary:
      'Final pay is due at the time of a termination or layoff, on the last day for a resignation with 72 hours notice, and within 72 hours otherwise. Give the UI Code 1089 notice and DE 2320 on a discharge, layoff or leave, and the COBRA or Cal-COBRA notice.',
    jurisdiction: 'california',
    trigger: { kind: 'event', event: 'first_separation' },
    countMethod: 'The first employee departure on record.',
    actions: [
      { id: 'final-pay', title: 'Check the final pay deadline in the offboarding wizard' },
      { id: 'notices', title: 'Send the separation notices for the exit type' },
      { id: 'access', title: 'Revoke access on the last day' },
    ],
    citation: SRC.finalPay,
    category: 'pay',
    lawIds: ['w-final-pay-termination', 'w-final-pay-resignation', 'w-waiting-time-penalty'],
  }),
  rule({
    id: 'ccpa-workforce-privacy',
    title: 'CCPA notice for staff and applicants',
    summary:
      'Once prior-year revenue reaches $26,625,000, or you handle data on 100,000 California residents, the CCPA covers employee and applicant data. Give a notice at collection and handle access and deletion requests.',
    jurisdiction: 'california',
    trigger: { kind: 'event', event: 'ccpa_revenue' },
    countMethod:
      'Based on trailing revenue in Settings, not headcount. The data-volume test can apply sooner for a company that processes customer financial data.',
    actions: [
      { id: 'notice', title: 'Add a privacy notice at collection for applicants and staff' },
      { id: 'requests', title: 'Set up access and deletion request handling' },
    ],
    citation: SRC.ccpa,
    category: 'records',
    lawIds: ['a-ccpa-1'],
  }),
  rule({
    id: 'credit-checks',
    title: 'Credit checks in hiring',
    summary:
      'California allows credit reports in hiring only for listed roles, such as executive managers, people who can sign on company accounts or move money, and roles with access to account numbers plus SSNs and birth dates. A business under GLBA regulator oversight is exempt (1024.5(b)). Civil Code 1785.20.5 also calls for a written notice before running one; confirm its contents with counsel.',
    jurisdiction: 'california',
    trigger: { kind: 'event', event: 'credit_check' },
    countMethod: 'Starts when a job turns on credit checks with a Labor Code 1024.5 basis.',
    actions: [
      { id: 'basis', title: 'Record the Labor Code 1024.5 basis on the job' },
      { id: 'notice', title: 'Send the written notice (Civil Code 1785.20.5) before the check' },
    ],
    citation: SRC.lc1024_5,
    category: 'hiring',
    lawIds: ['b-ca-lc1024-5-credit'],
    // The 1024.5 categories and the GLBA carve-out are verified; the Civil Code 1785.20.5 notice is not.
    verification: 'needs_review',
  }),

  // ------------------------------------------------------------------------------------------
  // 2 to 10
  // ------------------------------------------------------------------------------------------
  rule({
    id: 'cal-cobra',
    title: 'Cal-COBRA continuation coverage',
    summary:
      'With 2 to 19 employees and an insured group health plan, Cal-COBRA lets people who leave keep coverage for up to 36 months. Tell the carrier in writing within 30 days of a qualifying event; the carrier sends the election notice.',
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 2, method: 'cobra_prior_year' },
    countMethod:
      '2 or more employees on more than half of typical business days in the prior calendar year (the prior quarter for a business with no employees last year). Applies only with an insured plan and ends once federal COBRA applies.',
    actions: [{ id: 'offboarding-task', title: "Add 'notify the carrier within 30 days' to offboarding" }],
    citation: SRC.calCobra,
    category: 'benefits',
    supersededBy: 'federal-cobra',
    countOptions: { priorQuarterFallback: true },
    lawIds: ['b-calcobra-2-19'],
  }),
  rule({
    id: 'iipp-records',
    title: 'IIPP records at 10 employees',
    summary:
      'At 10 employees the oral-instruction and simple-log allowances end. Keep inspection records for 1 year and a training record for each employee (name, dates, type and provider).',
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 10, method: 'w2_one_in_ca' },
    countMethod: W2,
    actions: [
      { id: 'inspection-records', title: 'Keep inspection records for 1 year' },
      { id: 'training-records', title: 'Keep a safety training record for each employee' },
    ],
    citation: SRC.iipp,
    category: 'safety',
    lawIds: ['a-iipp-1'],
  }),
  rule({
    id: 'wvpp',
    title: 'Workplace violence prevention plan (SB 553)',
    summary:
      'Unless fewer than 10 employees are ever at a workplace at once and it is closed to the public, you need a written workplace violence prevention plan, training when the plan starts and every year, and a violent incident log with no personal details. Staff working remotely from a place they choose are not counted.',
    jurisdiction: 'california',
    trigger: { kind: 'site', n: 10 },
    countMethod:
      'Peak number of employees at one workplace at the same time (Settings: typical peak on site, never below the onsite-only staff assigned there). Remote staff are excluded. Applies at any count if the workplace is open to the public, and the small-site exemption also assumes your IIPP is in place.',
    actions: [
      { id: 'write-plan', title: 'Write the plan and name who runs it' },
      { id: 'train', title: 'Train everyone, then every year' },
      { id: 'incident-log', title: 'Start the violent incident log' },
    ],
    citation: SRC.wvpp,
    category: 'safety',
    lawIds: ['a-wvpp-1'],
  }),

  // ------------------------------------------------------------------------------------------
  // 5 (the big California step)
  // ------------------------------------------------------------------------------------------
  rule({
    id: 'feha',
    title: 'FEHA anti-discrimination rules',
    summary:
      "At 5 employees, California's FEHA discrimination rules apply. Accommodate disability and religion, keep hiring criteria job-related, and post the CRD notices.",
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 5, method: 'w2_one_in_ca' },
    countMethod: W2,
    actions: [
      { id: 'accommodation', title: 'Write a simple accommodation request process' },
      { id: 'notices', title: 'Post the CRD discrimination and harassment notices' },
    ],
    citation: SRC.ccr11008,
    category: 'hiring',
    lawIds: ['a-feha-5'],
  }),
  rule({
    id: 'harassment-policy',
    title: 'Written harassment and discrimination policy',
    summary:
      'Adopt and hand out a written harassment, discrimination and retaliation prevention policy that lists all protected groups, lets people complain to someone other than their manager, and promises a prompt, fair investigation and no retaliation. Translate it for any language spoken by 10% or more of a location.',
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 5, method: 'w2_one_in_ca' },
    countMethod: W2,
    actions: [
      { id: 'adopt', title: 'Adopt the policy (a template is included)' },
      { id: 'acknowledgements', title: 'Collect acknowledgements from everyone' },
    ],
    citation: SRC.policy11023,
    category: 'safety',
    recommendFrom: 1,
    lawIds: ['a-policy-5'],
  }),
  rule({
    id: 'harassment-training',
    title: 'Harassment prevention training',
    summary:
      "With 5 or more employees and contractors, train every California-based employee: 1 hour for staff and 2 hours for supervisors, within 6 months of hire or promotion, then every 2 years. Keep certificates at least 2 years. CRD's online course is free.",
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 5, method: 'w2_plus_contractors' },
    countMethod:
      'Employees in any state plus active contractors. Only California-based employees must be trained. Advisors are left out by default, a judgment call: if an advisor gives regular services under contract, confirm with counsel and override the count.',
    actions: [
      { id: 'assign', title: 'Assign the course to California staff' },
      { id: 'crd-course', title: "Use CRD's free online course", link: CRD_COURSE },
      { id: 'certificates', title: 'Save certificate links for 2 years' },
    ],
    citation: SRC.shpt,
    category: 'safety',
    lawIds: ['a-shpt-5', 'b-ca-harassment-training-5'],
  }),
  rule({
    id: 'cfra-pdl',
    title: 'Family leave (CFRA) and pregnancy disability leave',
    summary:
      'At 5 employees, eligible staff (12 months of service and 1,250 hours) get up to 12 weeks of job-protected CFRA leave, and anyone disabled by pregnancy gets up to 4 months of leave with no service minimum. Respond to each request promptly; this app sets a 5-business-day target for the designation notice, so confirm the exact timing with counsel.',
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 5, method: 'w2_one_in_ca' },
    countMethod: W2,
    actions: [
      { id: 'handbook', title: 'Add CFRA and pregnancy disability leave to the handbook' },
      { id: 'notices', title: 'Post the CFRA and pregnancy disability leave notices' },
      { id: 'leave-cases', title: 'Track requests as leave cases' },
    ],
    citation: SRC.cfra,
    category: 'leave',
    lawIds: ['a-cfra-pdl-5'],
  }),
  rule({
    id: 'bereavement-reproductive-loss',
    title: 'Bereavement and reproductive loss leave',
    summary:
      'Employees with 30 days of service may take up to 5 days of bereavement leave per death and up to 5 days of reproductive loss leave per event (at most 20 days in 12 months), within 3 months. It may be unpaid, but they can use other paid time off. Keep both confidential.',
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 5, method: 'w2_one_in_ca' },
    countMethod: W2,
    actions: [
      { id: 'turn-on', title: 'Turn on the bereavement and reproductive loss leave types' },
      { id: 'handbook', title: 'Add both to the handbook' },
    ],
    citation: SRC.bereavement,
    category: 'leave',
    lawIds: ['a-bereave-rll-5'],
  }),
  rule({
    id: 'fair-chance-act',
    title: 'Fair Chance Act',
    summary:
      'At 5 employees, you may not ask about conviction history before a conditional offer. To withdraw an offer, make an individualized assessment, send a preliminary notice with the report, wait at least 5 business days (5 more if disputed), then send a final notice. This app holds every hire to these steps from day one.',
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 5, method: 'w2_one_in_ca' },
    countMethod: `${W2} The app enforces the steps at every size.`,
    actions: [
      { id: 'postings', title: 'Add the Fair Chance statement to job posts' },
      { id: 'process', title: 'Run background checks only after a conditional offer' },
    ],
    citation: SRC.fairChance,
    category: 'hiring',
    recommendFrom: 1,
    lawIds: ['a-fca-5', 'b-ca-fair-chance'],
  }),
  rule({
    id: 'crd-ads-regulations',
    title: 'Automated decision systems in hiring',
    summary:
      'Since Oct 1, 2025, using an automated decision system or selection criteria that discriminates is a FEHA violation, and applications, selection criteria and any system data must be kept 4 years. This app does no AI scoring or ranking and keeps candidate records 4 years.',
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 5, method: 'w2_one_in_ca' },
    countMethod: `${W2} Vendors that screen candidates for you count as your agent.`,
    actions: [
      { id: 'vendors', title: 'Ask any screening vendor about anti-bias testing' },
      { id: 'retention', title: 'Keep candidate records 4 years (archive, never delete)' },
    ],
    citation: SRC.ads,
    category: 'hiring',
    lawIds: ['a-ads-1'],
  }),
  rule({
    id: 'sb700-cannabis',
    title: 'No questions about past cannabis use',
    summary:
      'At 5 employees, do not ask applicants about prior cannabis use, and do not penalize lawful off-duty, off-site use. Criminal history questions follow the Fair Chance Act instead.',
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 5, method: 'w2_one_in_ca' },
    countMethod: W2,
    actions: [{ id: 'review-forms', title: 'Check application forms and interview scripts' }],
    citation: SRC.sb700,
    category: 'hiring',
    lawIds: [],
    verification: 'needs_review',
  }),

  // ------------------------------------------------------------------------------------------
  // 15 and 20
  // ------------------------------------------------------------------------------------------
  rule({
    id: 'pay-scale-in-postings',
    title: 'Pay scale in every job posting',
    summary:
      'At 15 employees, every job posting must show a good-faith pay range in the posting itself (not a link), including posts by recruiters and job boards. The app blocks marking a job posted without a range once employees plus accepted offers reach 15.',
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 15, method: 'w2_one_in_ca' },
    countMethod: `${W2} At least one employee must be in California. The posting block also counts accepted offers.`,
    actions: [
      { id: 'check-posts', title: 'Check every open post shows its range' },
      { id: 'agencies', title: 'Give the range to any recruiter or board that posts for you' },
    ],
    citation: SRC.payScale,
    category: 'hiring',
    hardStop: true,
    lawIds: ['a-paytrans-15', 'b-ca-pay-scale-15'],
  }),
  rule({
    id: 'organ-bone-marrow-leave',
    title: 'Organ and bone marrow donor leave',
    summary:
      'At 15 employees, staff with at least 90 days of service get up to 30 business days of paid organ donor leave a year, plus up to 30 more business days unpaid, and up to 5 business days of paid bone marrow donor leave a year.',
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 15, method: 'w2_one_in_ca' },
    countMethod: W2,
    actions: [
      { id: 'turn-on', title: 'Turn on the organ and bone marrow donor leave types' },
      { id: 'handbook', title: 'Add both to the handbook' },
    ],
    citation: SRC.organDonor,
    category: 'leave',
    lawIds: [],
    verification: 'needs_review',
  }),
  rule({
    id: 'title-vii-ada-gina-pwfa',
    title: 'Federal EEO laws (Title VII, ADA, GINA, PWFA)',
    summary:
      'Federal anti-discrimination laws apply once you have 15 or more employees on every working day of 20 calendar weeks in this year or last year. Then post the federal EEO notice, run an accommodation process for disability and pregnancy, and be ready to answer an EEOC charge.',
    jurisdiction: 'federal',
    trigger: { kind: 'headcount', n: 15, method: 'weeks_20' },
    countMethod:
      'Weeks with 15 or more on the payroll every Monday to Friday, in the current or prior calendar year. Part-time staff count for the whole week; contractors do not. GINA and the PWFA use the same test.',
    actions: [
      { id: 'eeo-poster', title: "Post the federal 'Know your rights' notice" },
      { id: 'accommodation', title: 'Set up the accommodation process for disability and pregnancy' },
      { id: 'handbook-eeo', title: 'Add the federal EEO statement to the handbook' },
    ],
    citation: SRC.eeoc,
    category: 'hiring',
    lawIds: ['b-titlevii-ada-15'],
  }),
  rule({
    id: 'adea',
    title: 'Age discrimination law (ADEA)',
    summary:
      'The federal ADEA applies at 20 employees for 20 calendar weeks. Severance releases then default to 21 days to review and 7 days to revoke for everyone, so age never needs to be recorded.',
    jurisdiction: 'federal',
    trigger: { kind: 'headcount', n: 20, method: 'weeks_20' },
    countMethod: 'Weeks with 20 or more on the payroll every Monday to Friday, in the current or prior calendar year.',
    actions: [{ id: 'release-template', title: 'Update the severance release template (21 and 7 days)' }],
    citation: SRC.eeoc,
    category: 'hiring',
    lawIds: ['b-adea-20'],
  }),
  rule({
    id: 'federal-cobra',
    title: 'Federal COBRA',
    summary:
      'Federal COBRA applies this year if you had 20 or more employees on more than half of your typical business days last year, counting part-time staff as fractions. Your PEO or carrier usually sends the notices, so confirm who does.',
    jurisdiction: 'federal',
    trigger: { kind: 'headcount', n: 20, method: 'cobra_prior_year' },
    countMethod: 'Prior calendar year. Part-time staff count as weekly hours divided by 40; contractors do not count.',
    actions: [
      { id: 'confirm-admin', title: 'Confirm who sends COBRA notices' },
      { id: 'offboarding', title: 'Switch offboarding from Cal-COBRA to COBRA' },
    ],
    citation: SRC.cobra,
    category: 'benefits',
    lawIds: ['b-cobra-20'],
  }),

  // ------------------------------------------------------------------------------------------
  // Upcoming (above 20)
  // ------------------------------------------------------------------------------------------
  rule({
    id: 'victims-leave-expanded',
    title: "More victims' leave purposes at 25",
    summary:
      'At 25 employees, victims and their family members may take time off for more purposes, such as medical care, counseling and safety planning.',
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 25, method: 'w2_one_in_ca' },
    countMethod: W2,
    actions: [{ id: 'policy', title: 'Update the leave policy' }],
    citation: SRC.victims,
    category: 'leave',
    upcoming: true,
    lawIds: ['a-victims-leave-25'],
  }),
  rule({
    id: 'school-activities-leave',
    title: 'School activities leave',
    summary:
      'At 25 employees working at the same location, parents and guardians may take up to 40 hours a year for school or child care activities.',
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 25, method: 'w2_at_location' },
    countMethod: 'Employees who work at the same location (onsite or hybrid). Remote staff are not counted at any location.',
    actions: [{ id: 'policy', title: 'Add school activities leave to the handbook' }],
    citation: SRC.lc230_8,
    category: 'leave',
    upcoming: true,
    lawIds: [],
    verification: 'needs_review',
  }),
  rule({
    id: 'rehab-literacy-accommodation',
    title: 'Rehabilitation and literacy accommodation',
    summary:
      'At 25 employees, reasonably accommodate an employee who enters an alcohol or drug rehabilitation program or an adult literacy program.',
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 25, method: 'w2_one_in_ca' },
    countMethod: W2,
    actions: [{ id: 'policy', title: 'Add both accommodations to the handbook' }],
    citation: SRC.lc1025,
    category: 'leave',
    upcoming: true,
    lawIds: [],
    verification: 'needs_review',
  }),
  rule({
    id: 'sj-opportunity-to-work',
    title: 'San Jose Opportunity to Work Ordinance',
    summary:
      'At 36 employees, offer more hours to qualified part-time staff before hiring new staff, contractors or temps, post the City notice in four languages, and keep schedules and written hours offers for 4 years.',
    jurisdiction: 'san_jose',
    trigger: { kind: 'headcount', n: 36, method: 'in_san_jose' },
    countMethod:
      'Employees who do at least 2 hours of work a week within San Jose city limits, exempt staff included. Remote staff outside San Jose do not count.',
    actions: [{ id: 'hours-offer', title: 'Offer hours to existing part-timers before opening a job' }],
    citation: SRC.sjOwo,
    category: 'hiring',
    scope: { city: 'San Jose' },
    upcoming: true,
    lawIds: ['a-sjowo-36'],
  }),
  rule({
    id: 'fmla',
    title: 'Family and Medical Leave Act (FMLA)',
    summary:
      'At 50 employees in 20 workweeks of this year or last, the FMLA applies alongside CFRA. Employees qualify after 12 months and 1,250 hours at a site with 50 employees within 75 miles.',
    jurisdiction: 'federal',
    trigger: { kind: 'headcount', n: 50, method: 'weeks_20' },
    countMethod: 'Weeks with 50 or more on the payroll every Monday to Friday, in the current or prior calendar year.',
    actions: [{ id: 'policy', title: 'Add FMLA to the leave policy' }],
    citation: SRC.fmla,
    category: 'leave',
    upcoming: true,
    lawIds: ['b-fmla-50'],
  }),
  rule({
    id: 'aca-employer-mandate',
    title: 'ACA employer mandate',
    summary:
      'At an average of 50 full-time employees including equivalents last year, offer affordable health coverage or pay a penalty, and file Forms 1094-C and 1095-C.',
    jurisdiction: 'federal',
    trigger: { kind: 'headcount', n: 50, method: 'w2_one_in_ca' },
    countMethod:
      "The IRS test is last year's monthly average of full-time employees plus full-time equivalents. The count shown is plain headcount, as a guide.",
    actions: [{ id: 'broker', title: 'Ask your broker or PEO to run the ALE test' }],
    citation: SRC.aca,
    category: 'benefits',
    upcoming: true,
    lawIds: ['b-aca-ale-50'],
  }),
  rule({
    id: 'cal-warn',
    title: 'Cal-WARN layoff notice',
    summary:
      "With 75 employees now or in the last 12 months, give 60 days' notice before laying off 50 or more people within 30 days, shutting down, or relocating 100 miles or more.",
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 75, method: 'w2_one_in_ca' },
    countMethod: 'Full- and part-time employees who worked at least 6 of the 12 months before the notice.',
    actions: [{ id: 'plan', title: 'Check Cal-WARN before any layoff' }],
    citation: SRC.calWarn,
    category: 'notices',
    upcoming: true,
    lawIds: ['a-calwarn-75'],
  }),
  rule({
    id: 'eeo-1',
    title: 'EEO-1 report',
    summary: 'At 100 employees, file the annual EEO-1 workforce report with the EEOC.',
    jurisdiction: 'federal',
    trigger: { kind: 'headcount', n: 100, method: 'w2_one_in_ca' },
    countMethod: W2,
    actions: [{ id: 'self-id', title: 'Set up voluntary self-identification in your HRIS' }],
    citation: SRC.eeo1,
    category: 'records',
    upcoming: true,
    lawIds: ['b-eeo1-100'],
  }),
  rule({
    id: 'ca-pay-data-report',
    title: 'California pay data report',
    summary: 'At 100 employees, file an annual pay data report with CRD each May (the second Wednesday).',
    jurisdiction: 'california',
    trigger: { kind: 'headcount', n: 100, method: 'w2_one_in_ca' },
    countMethod: `${W2} Report data only for California employees.`,
    actions: [{ id: 'prepare', title: 'Prepare pay data from your HRIS' }],
    citation: SRC.payData,
    category: 'records',
    upcoming: true,
    lawIds: ['a-paydata-100'],
  }),
  rule({
    id: 'federal-warn',
    title: 'Federal WARN Act',
    summary: "At 100 full-time employees, give 60 days' notice before a plant closing or mass layoff.",
    jurisdiction: 'federal',
    trigger: { kind: 'headcount', n: 100, method: 'w2_one_in_ca' },
    countMethod: 'Full-time employees; part-time staff count only in some cases.',
    actions: [{ id: 'plan', title: 'Check WARN before any layoff' }],
    citation: SRC.fedWarn,
    category: 'notices',
    upcoming: true,
    lawIds: [],
    verification: 'needs_review',
  }),
]

export const RULE_BY_ID: Record<string, ComplianceRule> = Object.fromEntries(RULES.map((r) => [r.id, r]))

export function getRule(id: string | undefined | null): ComplianceRule | undefined {
  return id ? RULE_BY_ID[id] : undefined
}

export const JURISDICTION_LABELS: Record<Jurisdiction, string> = {
  federal: 'Federal',
  california: 'California',
  san_jose: 'San Jose',
  other_state: 'Other state',
}

export const CATEGORY_LABELS: Record<RuleCategory, string> = {
  hiring: 'Hiring',
  pay: 'Pay',
  leave: 'Leave',
  safety: 'Workplace safety and conduct',
  notices: 'Notices and posters',
  benefits: 'Benefits',
  records: 'Records',
  tax: 'Payroll tax',
  equity: 'Equity',
}

/** Shown on every rule card. */
export const NOT_LEGAL_ADVICE = 'Not legal advice; confirm with counsel or your PEO.'
