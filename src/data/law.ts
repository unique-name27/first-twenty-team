// Legal and payroll constants for 2026, each with the source it was verified against
// (research pass, October 2026). Values that change every January are also editable in
// Settings > Compliance rules (DB.settings.law). Not legal advice; confirm with your PEO or counsel.

export const LAW_LAST_REVIEWED = '2026-10-09'

export const DEFAULT_LAW = {
  year: 2026,
  lastReviewedOn: LAW_LAST_REVIEWED,
  /** California statewide minimum wage, all employers, from 2026-01-01. */
  caMinWageHourly: 16.9,
  /** City of San Jose minimum wage for calendar 2026 (corrected from an announced $18.40). */
  sanJoseMinWageHourly: 18.45,
  /** CA exempt (executive/administrative/professional) salary floor: 2 x $16.90 x 2,080. */
  exemptSalaryMin: 70_304,
  /** CA computer software employee exemption (Labor Code 515.5), 2026. */
  computerProHourly: 58.85,
  computerProMonthly: 10_214.44,
  computerProAnnual: 122_573.13,
  /** Form 1099-NEC threshold for payments made in 2026 (was $600; indexed from 2027). */
  form1099Threshold: 2_000,
  /** EDD DE 542 independent contractor report: individuals paid or contracted for $600+, within 20 days. */
  de542Threshold: 600,
} as const

export type LawSource = { label: string; url: string }

export const LAW_SOURCES: Record<string, LawSource> = {
  caMinWage: { label: 'DIR minimum wage FAQ', url: 'https://www.dir.ca.gov/dlse/faq_minimumwage.htm' },
  sanJoseMinWage: {
    label: 'San Jose 2026 minimum wage (corrected to $18.45)',
    url: 'https://news.bloombergtax.com/payroll/san-jose-california-corrects-2026-minimum-wage-announcement',
  },
  exemptSalary: { label: 'DIR news release 2025-118', url: 'https://www.dir.ca.gov/DIRNews/2025/2025-118.html' },
  computerPro: { label: 'DIR computer software exemption', url: 'https://dir.ca.gov/oprl/ComputerSoftware.htm' },
  overtime: { label: 'DIR overtime FAQ', url: 'https://www.dir.ca.gov/dlse/faq_overtime.htm' },
  mealPeriods: { label: 'DIR meal periods FAQ', url: 'https://www.dir.ca.gov/dlse/faq_mealperiods.htm' },
  restPeriods: { label: 'DIR rest periods FAQ', url: 'https://www.dir.ca.gov/dlse/faq_restperiods.htm' },
  finalPay: { label: 'DIR paydays and final pay FAQ', url: 'https://www.dir.ca.gov/dlse/faq_paydays.htm' },
  waitingTime: { label: 'DIR waiting time penalty FAQ', url: 'https://www.dir.ca.gov/dlse/faq_waitingtimepenalty.htm' },
  vacation: { label: 'DIR vacation FAQ', url: 'https://www.dir.ca.gov/dlse/faq_vacation.htm' },
  paidSickLeave: { label: 'DIR paid sick leave', url: 'https://www.dir.ca.gov/dlse/Paid_Sick_Leave.htm' },
  lc246: {
    label: 'Labor Code 246',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=LAB&sectionNum=246',
  },
  lc204: {
    label: 'Labor Code 204',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=LAB&sectionNum=204',
  },
  // Pay run prep (docs/LAW.md, Pay run prep section, 2026-10-12).
  salaryBasis: {
    label: '29 CFR 541.602 (salary basis)',
    url: 'https://www.ecfr.gov/current/title-29/subtitle-B/chapter-V/subchapter-A/part-541/subpart-G/section-541.602',
  },
  dlseManual: { label: 'DLSE Enforcement Manual', url: 'https://www.dir.ca.gov/dlse/DLSEManual/dlse_enfcmanual.pdf' },
  bankHolidays: { label: 'Federal Reserve holidays', url: 'https://www.federalreserve.gov/aboutthefed/k8.htm' },
  lc207: {
    label: 'Labor Code 207',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=LAB&sectionNum=207.',
  },
  lc210: {
    label: 'Labor Code 210',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=LAB&sectionNum=210.',
  },
  lc219: {
    label: 'Labor Code 219',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=LAB&sectionNum=219.',
  },
  lc515: {
    label: 'Labor Code 515',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=LAB&sectionNum=515.',
  },
  lc226: {
    label: 'Labor Code 226',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=LAB&sectionNum=226',
  },
  wtpa: { label: 'DIR Labor Code 2810.5 notice FAQ', url: 'https://dir.ca.gov/dlse/FAQs-NoticetoEmployee.html' },
  eddRates: { label: 'EDD rates and withholding', url: 'https://edd.ca.gov/en/payroll_taxes/rates_and_withholding/' },
  fica: { label: 'IRS Topic 751', url: 'https://www.irs.gov/taxtopics/tc751' },
  futa: { label: 'IRS Topic 759', url: 'https://www.irs.gov/taxtopics/tc759' },
  futaCredit: { label: 'DOL FUTA credit reductions', url: 'https://oui.doleta.gov/unemploy/futa_credit.asp' },
  k401: {
    label: 'IRS 2026 401(k) limits',
    url: 'https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500',
  },
  hsa: { label: 'IRS Rev. Proc. 2025-19', url: 'https://www.irs.gov/irb/2025-21_IRB' },
  calsavers: { label: 'CalSavers FAQ', url: 'https://www.calsavers.com/home/frequently-asked-questions.html' },
  sfMinWage: { label: 'SF minimum wage ordinance', url: 'https://www.sf.gov/information--minimum-wage-ordinance' },
  sfSickLeave: { label: 'SF OLSE paid sick leave FAQ', url: 'https://media.api.sf.gov/documents/311._PSL_FAQ_2023.pdf' },
  bayAreaWages: {
    label: 'UC Berkeley Labor Center minimum wage inventory',
    url: 'https://laborcenter.berkeley.edu/inventory-of-us-city-and-county-minimum-wage-ordinances/',
  },
}

/** Local minimum wages in effect on 2026-10-09 (dated rows so future rates can be added). */
export const LOCAL_MIN_WAGES: Array<{ city: string; hourly: number; effective: string; next?: { hourly: number; effective: string } }> = [
  { city: 'San Jose', hourly: 18.45, effective: '2026-01-01' },
  { city: 'San Francisco', hourly: 19.61, effective: '2026-07-01' },
  { city: 'Oakland', hourly: 17.34, effective: '2026-01-01' },
  { city: 'Mountain View', hourly: 19.7, effective: '2026-01-01' },
  { city: 'Sunnyvale', hourly: 19.5, effective: '2026-01-01' },
  { city: 'Palo Alto', hourly: 18.7, effective: '2026-01-01', next: { hourly: 19.25, effective: '2027-01-01' } },
  { city: 'Santa Clara', hourly: 18.7, effective: '2026-01-01', next: { hourly: 19.25, effective: '2027-01-01' } },
]

/** Employer payroll taxes used for fully loaded cost estimates (2026). */
export const PAYROLL_TAX_2026 = {
  socialSecurityRate: 0.062,
  socialSecurityWageBase: 184_500,
  medicareRate: 0.0145,
  /** FUTA after California's credit reduction. 2025 final was 1.8%. 2026 is estimated at 2.1%
   *  if DOL grants California's add-on waiver, up to 5.9% if not (final after Nov 10, 2026). */
  futaEffectiveRate: 0.021,
  futaEffectiveRateNoWaiver: 0.059,
  futaWageBase: 7_000,
  /** California new-employer UI rate (2-3 years) and Employment Training Tax, on the first $7,000. */
  caUiRate: 0.034,
  caEttRate: 0.001,
  caUiWageBase: 7_000,
  /** SDI is employee-paid (1.3%, no wage cap in 2026); not an employer cost. */
  caSdiEmployeeRate: 0.013,
} as const

/** 2026 benefit plan limits (shown in benefits notes and offer summaries). */
export const BENEFIT_LIMITS_2026 = {
  k401Deferral: 24_500,
  k401CatchUp50: 8_000,
  k401CatchUp60to63: 11_250,
  hsaSelf: 4_400,
  hsaFamily: 8_750,
} as const

/** California paid sick leave (Labor Code 246, as amended by SB 616). */
export const CA_SICK_LEAVE = {
  accrualHoursPerHoursWorked: 1 / 30,
  minUsageHours: 40,
  minUsageDays: 5,
  accrualCapHours: 80,
  accrualCapDays: 10,
  waitingDays: 90,
  /** Must work 30+ days in CA within a year of starting to qualify. */
  qualifyingDays: 30,
  paidOutAtSeparation: false,
  reinstateIfRehiredWithinMonths: 12,
} as const

/** Final pay deadlines (Labor Code 201-203). */
export const FINAL_PAY = {
  involuntary: 'Immediately, at the time of termination (Labor Code 201). Includes accrued, unused vacation.',
  voluntaryWithNotice: 'On the last day of work, when the employee gave at least 72 hours notice (Labor Code 202).',
  voluntaryWithoutNotice: 'Within 72 hours of quitting, when the employee gave less than 72 hours notice (Labor Code 202).',
  waitingTimePenaltyMaxDays: 30,
} as const
