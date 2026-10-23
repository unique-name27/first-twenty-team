// California-aware checklist templates: onboarding, offboarding, new state, protected leave and
// job or pay changes. Templates are data (users can edit them in Settings); generate.ts turns a
// template into a person's checklist with computed due dates.
//
// Rules for every task: a short sentence-case title, one plain sentence of why, a citation from
// docs/LAW.md where a law applies, and statutory: true only for real legal deadlines (those show red
// when overdue). Not legal advice; confirm with counsel or your PEO.
import type { ChecklistTemplate, DueRule, TemplateTask } from '@/domain/types'

const LEGINFO = 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml'

/** Citations, keyed for reuse. Ids in comments point at the verified facts in docs/LAW.md. */
export const CHECKLIST_CITATIONS = {
  // b-ca-lc2870-2872-piia
  piia: {
    label: 'Labor Code 2870-2872',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?lawCode=LAB&division=3.&title=&part=&chapter=2.&article=3.5.',
  },
  // b-soc2-bgcheck-training (a SOC 2 expectation, not a law)
  soc2Screening: {
    label: 'SOC 2 CC1.4 (company policy, not law)',
    url: 'https://www.vanta.com/collection/soc-2/soc-2-background-check-requirements',
  },
  soc2Training: {
    label: 'SOC 2 CC2.2 (company policy, not law)',
    url: 'https://www.vanta.com/collection/soc-2/soc-2-background-check-requirements',
  },
  // b-w4-de4-de34
  withholding: { label: 'W-4 and DE 4', url: 'https://edd.ca.gov/en/payroll_taxes/rates_and_withholding/' },
  // b-w4-de4-de34 (checker note: the 2026 Form W-4 is the current revision)
  w4: { label: 'Form W-4 (2026)', url: 'https://www.irs.gov/forms-pubs/about-form-w-4' },
  // b-i9-deadlines
  i9Section1: {
    label: 'Form I-9 section 1',
    url: 'https://www.uscis.gov/i-9-central/complete-correct-form-i-9/completing-section-1-employee-information-and-attestation',
  },
  i9Section2: {
    label: 'Form I-9 section 2',
    url: 'https://www.uscis.gov/i-9-central/complete-correct-form-i-9/completing-section-2-employer-review-and-attestation',
  },
  // a-sh-infosheet-5
  crdFactSheet: { label: 'Gov Code 12950', url: `${LEGINFO}?sectionNum=12950.&lawCode=GOV` },
  // a-newhire-pamphlets-1, a-wc-1
  workersComp: { label: 'Labor Code 3551', url: 'https://www.dir.ca.gov/dwc/employer.htm' },
  eddBrochures: { label: 'EDD DE 2515 and DE 2511', url: 'https://edd.ca.gov/en/disability/employer_requirements/' },
  // Not in docs/LAW.md: FLSA section 18B notice of coverage options.
  aca: {
    label: 'FLSA 18B coverage options notice',
    url: 'https://www.dol.gov/agencies/ebsa/laws-and-regulations/laws/affordable-care-act/for-employers-and-advisers/coverage-options-notice',
  },
  // a-sb294-1, b-ca-sb294-rights-notice
  sb294: { label: 'Labor Code 1553 and 1555 (SB 294)', url: `${LEGINFO}?sectionNum=1553.&lawCode=LAB` },
  // a-lactation-1
  lactation: { label: 'Labor Code 1034', url: `${LEGINFO}?sectionNum=1034.&lawCode=LAB` },
  // a-wtpa-1, w-wtpa-notice, b-ca-lc2810-5-notice
  wageNotice: { label: 'Labor Code 2810.5', url: 'https://dir.ca.gov/dlse/FAQs-NoticetoEmployee.html' },
  // a-cfra-pdl-5
  cfra: { label: 'Gov Code 12945 and 12945.2', url: `${LEGINFO}?sectionNum=12945.2.&lawCode=GOV` },
  // a-victims-leave-25 (notice at hire for every employer)
  survivors: { label: 'Gov Code 12945.8', url: `${LEGINFO}?sectionNum=12945.8.&lawCode=GOV` },
  // a-iipp-1
  iipp: { label: '8 CCR 3203 (IIPP)', url: 'https://www.dir.ca.gov/title8/3203.html' },
  // w-meal-periods
  mealRest: { label: 'Labor Code 226.7 and 512', url: 'https://www.dir.ca.gov/dlse/faq_mealperiods.htm' },
  // a-psl-1
  sickLeave: { label: 'Labor Code 246', url: 'https://www.dir.ca.gov/dlse/paid_sick_leave.htm' },
  // a-de34-1
  de34: { label: 'EDD new hire report (DE 34)', url: 'https://edd.ca.gov/en/payroll_taxes/new_hire_reporting/' },
  // Not in docs/LAW.md: federal new hire reporting (42 USC 653a), 20 days or sooner by state.
  stateNewHire: {
    label: 'Federal new hire reporting',
    url: 'https://www.acf.hhs.gov/css/employers/employer-responsibilities/new-hire-reporting',
  },
  // a-shpt-5, b-ca-harassment-training-5
  harassmentTraining: {
    label: 'Gov Code 12950.1',
    url: 'https://calcivilrights.ca.gov/wp-content/uploads/sites/32/2022/11/Sexual-Harassment-Prevention-Training-For-Employers-FAQ_ENG.pdf',
  },
  // Not in docs/LAW.md: IRC 83(b), filed with IRS Form 15620 or a written statement.
  election83b: { label: 'IRC 83(b) and IRS Form 15620', url: 'https://www.irs.gov/forms-pubs/about-form-15620' },
  // Not in docs/LAW.md: business expense reimbursement.
  lc2802: { label: 'Labor Code 2802', url: `${LEGINFO}?lawCode=LAB&sectionNum=2802` },
  // w-final-pay-termination, w-final-pay-resignation
  finalPayInvoluntary: { label: 'Labor Code 201', url: 'https://www.dir.ca.gov/dlse/faq_paydays.htm' },
  finalPayVoluntary: { label: 'Labor Code 202', url: 'https://www.dir.ca.gov/dlse/faq_paydays.htm' },
  // w-vacation-payout
  vacation: { label: 'Labor Code 227.3', url: 'https://www.dir.ca.gov/dlse/faq_vacation.htm' },
  // Not in docs/LAW.md: EDD required notices at separation (UI Code 1089, DE 2320).
  separationNotices: {
    label: 'UI Code 1089 and DE 2320',
    url: 'https://edd.ca.gov/en/payroll_taxes/required_notices_and_pamphlets/',
  },
  // b-calcobra-2-19, b-cobra-20
  calCobra: { label: 'Cal-COBRA (HSC 1366.25)', url: 'https://www.insurance.ca.gov/01-consumers/110-health/frequently-asked-questions.cfm' },
  // Not in docs/LAW.md: Health Insurance Premium Payment notice.
  hipp: { label: 'Labor Code 2807 (HIPP notice)', url: `${LEGINFO}?lawCode=LAB&sectionNum=2807` },
  // a-ads-1 (4 years, Gov Code 12946 and 2 CCR 11013), a-records-1, b-i9-retention
  retention: { label: 'Gov Code 12946, Labor Code 1198.5 and I-9 retention', url: `${LEGINFO}?sectionNum=12946.&lawCode=GOV` },
  // Not in docs/LAW.md: CFRA regulations on responding to a leave request.
  cfraDesignation: { label: 'CFRA regulations (2 CCR 11091)', url: 'https://calcivilrights.ca.gov/family-medical-pregnancy-leave/' },
} satisfies Record<string, { label: string; url: string }>

const C = CHECKLIST_CITATIONS

function due(anchor: DueRule['anchor'], offset: number, unit: DueRule['unit'] = 'days'): DueRule {
  return { anchor, offset, unit }
}

// ---------------------------------------------------------------------------------------------
// Onboarding (anchor: start date)
// ---------------------------------------------------------------------------------------------

const ONBOARDING: TemplateTask[] = [
  // Pre-start
  {
    id: 'on-piia',
    title: 'PIIA signed with the Labor Code 2870 notice',
    why: 'The invention assignment agreement must come with written notice that inventions made on their own time and equipment stay theirs.',
    ownerRole: 'admin',
    due: due('start', -5, 'business_days'),
    category: 'legal',
    citation: C.piia,
    statutory: false,
  },
  {
    id: 'on-background-check',
    title: 'Background check cleared',
    why: 'The check runs only after a conditional offer, and customers and SOC 2 auditors expect it cleared before day 1.',
    ownerRole: 'admin',
    due: due('start', -3, 'business_days'),
    category: 'security',
    when: { backgroundCheck: true },
    citation: C.soc2Screening,
    soc2Control: 'background-check',
    statutory: false,
  },
  {
    id: 'on-payroll-invite',
    title: 'Payroll or PEO invite sent',
    why: 'The PEO collects the W-4, DE 4 and direct deposit details, so none of that is stored here.',
    ownerRole: 'admin',
    due: due('start', -5, 'business_days'),
    category: 'payroll',
    citation: C.withholding,
    statutory: false,
  },
  {
    id: 'on-laptop',
    title: 'Laptop ordered with MDM and disk encryption',
    why: 'Shipping takes time, and managed, encrypted devices protect customer financial data.',
    ownerRole: 'it',
    due: due('start', -6, 'business_days'),
    category: 'it',
    statutory: false,
  },
  {
    id: 'on-accounts',
    title: 'Accounts created with MFA and least privilege',
    why: 'Give only the access the role needs, with MFA on from the first login.',
    ownerRole: 'it',
    due: due('start', -1, 'business_days'),
    category: 'security',
    statutory: false,
  },
  {
    id: 'on-welcome',
    title: 'Welcome email sent',
    why: 'A note with the first-day plan, where to go and who to ask makes day 1 calmer.',
    ownerRole: 'manager',
    due: due('start', -3, 'business_days'),
    category: 'culture',
    statutory: false,
  },
  {
    id: 'on-new-state',
    title: 'New-state setup started',
    why: 'Working outside California means registering with that state and following its own rules.',
    ownerRole: 'admin',
    due: due('start', -10, 'business_days'),
    category: 'payroll',
    when: { outsideCA: true },
    statutory: false,
  },

  // Day 1
  {
    id: 'on-i9-section1',
    title: 'I-9 section 1 completed',
    why: 'The new employee must complete and sign section 1 no later than their first day of work.',
    ownerRole: 'employee',
    due: due('start', 0),
    category: 'legal',
    citation: C.i9Section1,
    statutory: true,
  },
  {
    // b-w4-de4-de34: W-4 and DE 4 at hire; without a valid DE 4 the employer withholds as single with zero allowances.
    id: 'on-w4-de4',
    title: 'W-4 (2026) and DE 4 completed',
    why: 'Payroll withholds federal and California income tax from these forms, and without a valid DE 4 it withholds as single with zero allowances. Your PEO may collect these during its onboarding; tick this once it has.',
    ownerRole: 'employee',
    due: due('start', 0),
    category: 'payroll',
    when: { outsideCA: false },
    citation: C.withholding,
    statutory: false,
  },
  {
    id: 'on-w4-state',
    title: 'W-4 (2026) and the state withholding form completed',
    why: "Payroll withholds federal income tax from the W-4, and state income tax from the work state's own form where the state has one. Your PEO may collect these during its onboarding; tick this once it has.",
    ownerRole: 'employee',
    due: due('start', 0),
    category: 'payroll',
    when: { outsideCA: true },
    citation: C.w4,
    statutory: false,
  },
  {
    id: 'on-notice-crd',
    title: 'CRD sexual harassment fact sheet given',
    why: 'Employers with 5 or more employees must give every employee the CRD fact sheet or equivalent information.',
    ownerRole: 'admin',
    due: due('start', 0),
    category: 'notice',
    when: { outsideCA: false, minHeadcount: 5 },
    citation: C.crdFactSheet,
    statutory: false,
  },
  {
    id: 'on-notice-crd-early',
    title: 'CRD sexual harassment fact sheet given (recommended)',
    why: 'Required once you reach 5 employees, and a good habit from the first hire because the harassment ban applies at any size.',
    ownerRole: 'admin',
    due: due('start', 0),
    category: 'notice',
    when: { outsideCA: false, belowHeadcount: 5 },
    citation: C.crdFactSheet,
    statutory: false,
  },
  {
    id: 'on-notice-workers-comp',
    title: "Workers' comp pamphlet and physician predesignation form given",
    why: "Every new employee gets the workers' comp time-of-hire notice, at hire or by the end of the first pay period at the latest.",
    ownerRole: 'admin',
    due: due('start', 0),
    category: 'notice',
    when: { outsideCA: false },
    citation: C.workersComp,
    statutory: false,
  },
  {
    id: 'on-notice-de2515',
    title: 'DE 2515 disability insurance brochure given',
    why: 'EDD requires every new hire to receive the State Disability Insurance brochure.',
    ownerRole: 'admin',
    due: due('start', 0),
    category: 'notice',
    when: { outsideCA: false },
    citation: C.eddBrochures,
    statutory: false,
  },
  {
    id: 'on-notice-de2511',
    title: 'DE 2511 paid family leave brochure given',
    why: 'EDD requires every new hire to receive the Paid Family Leave brochure.',
    ownerRole: 'admin',
    due: due('start', 0),
    category: 'notice',
    when: { outsideCA: false },
    citation: C.eddBrochures,
    statutory: false,
  },
  {
    id: 'on-notice-aca',
    title: 'ACA marketplace notice given',
    why: 'Federal law requires the notice of health coverage options within 14 days of the start date.',
    ownerRole: 'admin',
    due: due('start', 14),
    category: 'notice',
    citation: C.aca,
    statutory: true,
  },
  {
    id: 'on-notice-sb294',
    title: 'SB 294 know-your-rights notice given',
    why: 'Each new hire gets the workplace rights notice at hire, plus the option to name a contact to call if they are arrested or detained at work.',
    ownerRole: 'admin',
    due: due('start', 0),
    category: 'notice',
    when: { outsideCA: false },
    citation: C.sb294,
    statutory: true,
  },
  {
    id: 'on-notice-survivors',
    title: 'Survivors of violence leave notice given',
    why: 'Every California employer gives new hires the CRD notice about leave and safety accommodations for victims of violence and their family members.',
    ownerRole: 'admin',
    due: due('start', 0),
    category: 'notice',
    when: { outsideCA: false },
    citation: C.survivors,
    statutory: true,
  },
  {
    id: 'on-notice-lactation',
    title: 'Lactation accommodation policy given',
    why: 'California requires a written lactation policy given to every new hire.',
    ownerRole: 'admin',
    due: due('start', 0),
    category: 'notice',
    when: { outsideCA: false },
    citation: C.lactation,
    statutory: false,
  },
  {
    id: 'on-notice-2810-5',
    title: 'Labor Code 2810.5 wage notice given',
    why: 'Non-exempt hires must get the written pay rate, payday and employer details no later than their first day.',
    ownerRole: 'admin',
    due: due('start', 0),
    category: 'notice',
    when: { outsideCA: false, flsa: 'non_exempt' },
    citation: C.wageNotice,
    statutory: true,
  },
  {
    id: 'on-notice-cfra-pdl',
    title: 'CFRA and pregnancy disability leave notices given',
    why: 'At 5 or more employees, staff have job-protected family and pregnancy leave rights and must be told about them.',
    ownerRole: 'admin',
    due: due('start', 0),
    category: 'notice',
    when: { outsideCA: false, minHeadcount: 5 },
    citation: C.cfra,
    statutory: false,
  },
  {
    id: 'on-notice-sick',
    title: 'Paid sick leave notice given',
    why: 'Every California employee earns paid sick leave and should know how much they have and how to use it.',
    ownerRole: 'admin',
    due: due('start', 0),
    category: 'notice',
    when: { outsideCA: false },
    citation: C.sickLeave,
    statutory: false,
  },
  {
    id: 'on-ack-handbook',
    title: 'Handbook acknowledged',
    why: 'A signed acknowledgement shows the employee received the current handbook and its California leave policies.',
    ownerRole: 'employee',
    due: due('start', 0),
    category: 'legal',
    soc2Control: 'policy-ack',
    statutory: false,
  },
  {
    id: 'on-ack-security',
    title: 'Security policy acknowledged',
    why: 'Auditors check that every new hire acknowledged the security policy within 30 days.',
    ownerRole: 'employee',
    due: due('start', 0),
    category: 'security',
    soc2Control: 'policy-ack',
    statutory: false,
  },
  {
    id: 'on-ack-meal-rest',
    title: 'Meal and rest break policy acknowledged',
    why: 'Non-exempt staff get a 30-minute meal break by the end of the fifth hour and paid rest breaks, and a missed break costs an extra hour of pay.',
    ownerRole: 'employee',
    due: due('start', 0),
    category: 'legal',
    when: { outsideCA: false, flsa: 'non_exempt' },
    citation: C.mealRest,
    statutory: false,
  },
  {
    id: 'on-iipp-training',
    title: 'Injury and illness prevention training given',
    why: 'Every employer trains new hires on its written safety program; under 10 employees the instructions can be given in person and logged simply.',
    ownerRole: 'manager',
    due: due('start', 0),
    category: 'training',
    when: { outsideCA: false },
    citation: C.iipp,
    statutory: false,
  },
  {
    id: 'on-emergency-contacts',
    title: 'Emergency contacts added',
    why: 'Collect at least one contact, and ask whether they should also be told of an arrest or detention at work (SB 294).',
    ownerRole: 'employee',
    due: due('start', 0),
    category: 'legal',
    citation: C.sb294,
    statutory: false,
  },
  {
    id: 'on-remote-setup',
    title: 'Home office set up and Labor Code 2802 reimbursement explained',
    why: 'Remote employees must be reimbursed for necessary work expenses such as internet and phone.',
    ownerRole: 'admin',
    due: due('start', 0),
    category: 'payroll',
    when: { remote: true },
    citation: C.lc2802,
    statutory: false,
  },

  // First weeks
  {
    id: 'on-i9-section2',
    title: 'I-9 section 2 completed',
    why: 'The employer must inspect documents and complete section 2 within 3 business days of the first day of work.',
    ownerRole: 'admin',
    due: due('start', 3, 'business_days'),
    category: 'legal',
    citation: C.i9Section2,
    statutory: true,
  },
  {
    id: 'on-de34',
    title: 'DE 34 new hire report filed',
    why: 'EDD needs every new or rehired California employee reported within 20 calendar days of the start date.',
    ownerRole: 'admin',
    due: due('start', 20),
    category: 'payroll',
    when: { outsideCA: false },
    citation: C.de34,
    statutory: true,
  },
  {
    id: 'on-state-new-hire-report',
    title: "New hire reported to their state's registry",
    why: 'Employees working outside California are reported to their own state within 20 days of hire, sooner in some states.',
    ownerRole: 'admin',
    due: due('start', 20),
    category: 'payroll',
    when: { outsideCA: true },
    citation: C.stateNewHire,
    statutory: true,
  },
  {
    id: 'on-equity-board',
    title: 'Grant added to the next board consent',
    why: 'Options exist only once the board approves them, at the 409A price in effect on the approval date.',
    ownerRole: 'admin',
    due: due('start', 30),
    category: 'equity',
    when: { hasEquity: true },
    statutory: false,
  },
  {
    id: 'on-83b',
    title: '83(b) election filed',
    why: 'An 83(b) election must reach the IRS within 30 days of an early exercise, with no extensions.',
    ownerRole: 'employee',
    due: due('start', 30),
    category: 'equity',
    when: { earlyExercise: true },
    citation: C.election83b,
    statutory: true,
  },

  // Day 30
  {
    id: 'on-security-training',
    title: 'Security awareness training completed',
    why: 'Auditors sample new hires for security training within their first 30 days.',
    ownerRole: 'employee',
    due: due('start', 30),
    category: 'training',
    citation: C.soc2Training,
    soc2Control: 'security-training',
    statutory: false,
  },
  {
    id: 'on-production-access',
    title: 'Production access approved',
    why: 'A recorded manager approval shows production access was granted on purpose and kept to what the role needs.',
    ownerRole: 'manager',
    due: due('start', 30),
    category: 'security',
    soc2Control: 'access-review',
    statutory: false,
  },
  {
    id: 'on-checkin-30',
    title: '30-day check-in',
    why: 'A short conversation about what is going well and what is unclear catches problems early.',
    ownerRole: 'manager',
    due: due('start', 30),
    category: 'culture',
    statutory: false,
  },

  // Day 90 and month 6
  {
    id: 'on-checkin-90',
    title: '90-day check-in',
    why: 'Review goals, give feedback both ways and agree on the next quarter.',
    ownerRole: 'manager',
    due: due('start', 90),
    category: 'culture',
    statutory: false,
  },
  {
    id: 'on-harassment-training',
    title: 'Harassment prevention training (1 hour)',
    why: 'With 5 or more workers, California-based employees need 1 hour of training within 6 months of hire.',
    ownerRole: 'employee',
    due: due('start', 6, 'months'),
    category: 'training',
    when: { minWorkforce: 5, supervisor: false, outsideCA: false, employmentTypes: ['full_time', 'part_time'] },
    citation: C.harassmentTraining,
    statutory: true,
  },
  {
    id: 'on-harassment-training-supervisor',
    title: 'Supervisor harassment prevention training (2 hours)',
    why: 'With 5 or more workers, California-based supervisors need 2 hours of training within 6 months of hire.',
    ownerRole: 'employee',
    due: due('start', 6, 'months'),
    category: 'training',
    when: { minWorkforce: 5, supervisor: true, outsideCA: false, employmentTypes: ['full_time', 'part_time'] },
    citation: C.harassmentTraining,
    statutory: true,
  },
  {
    id: 'on-harassment-training-short-term',
    title: 'Harassment prevention training (short-term hire)',
    why: 'With 5 or more workers, California hires for under 6 months, such as interns, need training within 30 days or 100 hours worked, whichever comes first.',
    ownerRole: 'employee',
    due: due('start', 30),
    category: 'training',
    when: { employmentTypes: ['intern'], minWorkforce: 5, outsideCA: false },
    citation: C.harassmentTraining,
    statutory: true,
  },
]

// ---------------------------------------------------------------------------------------------
// Offboarding (anchor: last day)
// ---------------------------------------------------------------------------------------------

const OFFBOARDING: TemplateTask[] = [
  {
    id: 'off-final-pay-termination',
    title: 'Final paycheck handed over at the termination meeting',
    why: 'A discharged or laid-off employee is owed all final wages, including accrued vacation, immediately.',
    ownerRole: 'admin',
    due: due('last_day', 0),
    category: 'payroll',
    when: { outsideCA: false, separationTypes: ['terminated', 'laid_off'] },
    citation: C.finalPayInvoluntary,
    statutory: true,
  },
  {
    id: 'off-final-pay-contract-end',
    title: 'Final paycheck paid on the last day',
    why: 'The end of a fixed-term job counts as a discharge, so all final wages, including accrued vacation, are due on the last day.',
    ownerRole: 'admin',
    due: due('last_day', 0),
    category: 'payroll',
    when: { outsideCA: false, separationTypes: ['contract_ended'] },
    citation: C.finalPayInvoluntary,
    statutory: true,
  },
  {
    id: 'off-final-pay-notice',
    title: 'Final paycheck paid on the last day',
    why: "An employee who gave at least 72 hours' notice must be paid in full on their last day.",
    ownerRole: 'admin',
    due: due('last_day', 0),
    category: 'payroll',
    when: { outsideCA: false, separationTypes: ['resigned_notice'] },
    citation: C.finalPayVoluntary,
    statutory: true,
  },
  {
    id: 'off-final-pay-72h',
    title: 'Final paycheck paid within 72 hours',
    why: "An employee who quit without at least 72 hours' notice must be paid within 72 hours of quitting.",
    ownerRole: 'admin',
    due: due('last_day', 3),
    category: 'payroll',
    when: { outsideCA: false, separationTypes: ['resigned_no_notice'] },
    citation: C.finalPayVoluntary,
    statutory: true,
  },
  {
    id: 'off-vacation-payout',
    title: 'Accrued vacation included in final pay',
    why: 'Unused vacation is earned wages and is paid at the final rate; truly unlimited flexible vacation has nothing to pay.',
    ownerRole: 'admin',
    due: due('last_day', 0),
    category: 'payroll',
    when: { outsideCA: false },
    citation: C.vacation,
    statutory: true,
  },
  {
    id: 'off-separation-notices',
    title: 'Change-in-relationship notice and DE 2320 given',
    why: 'EDD requires both notices immediately on a discharge or layoff so the person knows how to claim unemployment.',
    ownerRole: 'admin',
    due: due('last_day', 0),
    category: 'notice',
    when: { outsideCA: false, separationTypes: ['terminated', 'laid_off', 'contract_ended'] },
    citation: C.separationNotices,
    statutory: true,
  },
  {
    id: 'off-separation-notices-optional',
    title: 'DE 2320 unemployment pamphlet given (optional)',
    why: 'Not required on a resignation, but it costs nothing and tells the person where to ask about benefits.',
    ownerRole: 'admin',
    due: due('last_day', 0),
    category: 'notice',
    when: { outsideCA: false, separationTypes: ['resigned_notice', 'resigned_no_notice'] },
    citation: C.separationNotices,
    statutory: false,
  },
  {
    id: 'off-state-final-pay',
    title: "Final pay by the work state's deadline",
    why: "Final pay, vacation payout and separation notice rules differ by state. Confirm the work state's rules with the PEO; paying everything on the last day, as California requires, is always on time.",
    ownerRole: 'admin',
    due: due('last_day', 0),
    category: 'payroll',
    when: { outsideCA: true },
    statutory: false,
  },
  {
    id: 'off-cobra',
    title: 'COBRA or Cal-COBRA started through the PEO or carrier',
    why: 'Tell the PEO or health carrier in writing within 30 days so it can send the continuation election notice.',
    ownerRole: 'admin',
    due: due('last_day', 30),
    category: 'benefits',
    citation: C.calCobra,
    statutory: true,
  },
  {
    id: 'off-hipp',
    title: 'HIPP notice given',
    why: 'Departing employees with group health coverage get the state notice about help paying continuation premiums.',
    ownerRole: 'admin',
    due: due('last_day', 0),
    category: 'notice',
    when: { outsideCA: false },
    citation: C.hipp,
    statutory: false,
  },
  {
    id: 'off-access',
    title: 'All access revoked',
    why: 'Remove every account on the last day and keep an evidence link; auditors test removal within 24 hours.',
    ownerRole: 'it',
    due: due('last_day', 0),
    category: 'security',
    soc2Control: 'access-revoked',
    statutory: false,
  },
  {
    id: 'off-equipment',
    title: 'Laptop and equipment returned',
    why: 'Send a prepaid return box if needed, and never deduct unreturned equipment from final pay.',
    ownerRole: 'it',
    due: due('last_day', 0),
    category: 'it',
    statutory: false,
  },
  {
    id: 'off-reassign-reports',
    title: 'Direct reports reassigned',
    why: 'Everyone needs a manager for approvals, check-ins and their own checklists.',
    ownerRole: 'admin',
    due: due('last_day', 0),
    category: 'culture',
    when: { supervisor: true },
    statutory: false,
  },
  {
    id: 'off-exit-note',
    title: 'Exit note sent with vested options and the exercise deadline',
    why: 'Departing option holders usually have 90 days to exercise vested options, and unvested options return to the pool.',
    ownerRole: 'admin',
    due: due('last_day', 0),
    category: 'equity',
    when: { hasEquity: true },
    statutory: false,
  },
  {
    id: 'off-rehire',
    title: 'Rehire eligibility recorded',
    why: 'A yes or no now saves guesswork if they apply again.',
    ownerRole: 'admin',
    due: due('last_day', 0),
    category: 'culture',
    statutory: false,
  },
  {
    id: 'off-retention',
    title: 'Record retention dates set',
    why: 'Keep personnel records 4 years after exit and the I-9 until the later of 3 years after hire or 1 year after exit.',
    ownerRole: 'admin',
    due: due('last_day', 0),
    category: 'legal',
    citation: C.retention,
    statutory: false,
  },
]

// ---------------------------------------------------------------------------------------------
// New state (anchor: start date of the first employee working from that state)
// ---------------------------------------------------------------------------------------------

const NEW_STATE: TemplateTask[] = [
  {
    id: 'ns-register',
    title: 'Registered for withholding and unemployment in the new state',
    why: 'The first paycheck in a new state needs a state tax and unemployment account, plus any state paid leave program.',
    ownerRole: 'admin',
    due: due('start', -5, 'business_days'),
    category: 'payroll',
    statutory: false,
  },
  {
    id: 'ns-workers-comp',
    title: "Workers' comp coverage extended to the new state",
    why: 'Most policies list covered states, so confirm with the carrier that this state is included.',
    ownerRole: 'admin',
    due: due('start', -5, 'business_days'),
    category: 'benefits',
    statutory: false,
  },
  {
    id: 'ns-posting',
    title: 'State notices sent electronically',
    why: 'Remote employees still need the state and federal posters, sent in a way they can reach anytime.',
    ownerRole: 'admin',
    due: due('start', 0),
    category: 'notice',
    statutory: false,
  },
  {
    id: 'ns-sick-leave',
    title: 'State paid sick leave rules applied',
    why: 'Many states set their own accrual, carryover and use rules, which can differ from California.',
    ownerRole: 'admin',
    due: due('start', 0),
    category: 'benefits',
    statutory: false,
  },
  {
    id: 'ns-pay-transparency',
    title: 'State pay transparency rules checked',
    why: 'Some states, such as Colorado, require pay ranges on any posting a resident could fill.',
    ownerRole: 'admin',
    due: due('start', 0),
    category: 'legal',
    statutory: false,
  },
]

// ---------------------------------------------------------------------------------------------
// Protected leave (anchor: leave start; 'created' is the request date)
// ---------------------------------------------------------------------------------------------

const LEAVE: TemplateTask[] = [
  {
    id: 'lv-designation',
    title: 'Response and designation notice sent',
    // A company target, not a statutory date: LAW.md has no 5-business-day CFRA rule (the regulations set an outer limit).
    why: 'Respond promptly and say whether the leave is protected and how it will count. This app targets 5 business days; CFRA regulations set an outer limit, so confirm the timing with counsel.',
    ownerRole: 'admin',
    due: due('created', 5, 'business_days'),
    category: 'legal',
    when: { outsideCA: false, leaveKinds: ['cfra', 'pdl', 'bonding'], minHeadcount: 5 },
    citation: C.cfraDesignation,
    statutory: false,
  },
  {
    id: 'lv-edd',
    title: 'EDD link for disability and paid family leave shared',
    why: 'State Disability Insurance and Paid Family Leave replace part of pay, and the employee applies to EDD directly.',
    ownerRole: 'admin',
    due: due('created', 1, 'business_days'),
    category: 'benefits',
    when: { outsideCA: false },
    citation: C.eddBrochures,
    statutory: false,
  },
  {
    id: 'lv-lactation',
    // Neutral title: managers can see their reports' checklists, and the leave type is private.
    title: 'Policy packet shared',
    why: 'The lactation accommodation policy must go to anyone who asks about or requests parental leave.',
    ownerRole: 'admin',
    due: due('created', 1, 'business_days'),
    category: 'notice',
    when: { leaveKinds: ['pdl', 'bonding'] },
    citation: C.lactation,
    statutory: false,
  },
  {
    id: 'lv-separation-notices',
    title: 'Change-in-relationship notice and DE 2320 given',
    why: 'EDD requires both notices when an employee starts a leave of absence, so they know their benefit options.',
    ownerRole: 'admin',
    due: due('leave_start', 0),
    category: 'notice',
    when: { outsideCA: false },
    citation: C.separationNotices,
    statutory: true,
  },
  {
    id: 'lv-benefits',
    title: 'Health coverage kept in place during the leave',
    why: 'Group health coverage continues on the same terms during CFRA and pregnancy disability leave.',
    ownerRole: 'admin',
    due: due('leave_start', 0),
    category: 'benefits',
    when: { outsideCA: false, leaveKinds: ['cfra', 'pdl', 'bonding'], minHeadcount: 5 },
    citation: C.cfra,
    statutory: false,
  },
  {
    id: 'lv-coverage',
    title: 'Coverage plan agreed',
    why: 'Decide who covers which work and approvals so the employee can fully step away.',
    ownerRole: 'manager',
    due: due('leave_start', -5, 'business_days'),
    category: 'culture',
    statutory: false,
  },
  {
    id: 'lv-return',
    title: 'Return-to-work check',
    why: 'Confirm the return date, restore access and the same or a comparable job, and plan a gentle first week.',
    ownerRole: 'manager',
    due: due('leave_start', 84),
    category: 'culture',
    statutory: false,
  },
]

// ---------------------------------------------------------------------------------------------
// Job or pay change ('created' is the day the change was recorded; changeJobOrPay dates the tasks
// from the effective date where the law counts from the change itself)
// ---------------------------------------------------------------------------------------------

const CHANGE: TemplateTask[] = [
  {
    id: 'ch-payroll',
    title: 'Payroll updated before the next cutoff',
    why: 'The PEO needs the new title, level, pay or overtime status before the payroll that covers the effective date. A manager or team move alone adds no payroll task.',
    ownerRole: 'admin',
    due: due('created', 3, 'business_days'),
    category: 'payroll',
    statutory: false,
  },
  {
    id: 'ch-wage-notice',
    title: 'Labor Code 2810.5 change notice given',
    why: 'Non-exempt employees must get written notice of a pay change within 7 calendar days, unless it shows on the next timely pay stub.',
    ownerRole: 'admin',
    due: due('created', 7),
    category: 'notice',
    when: { outsideCA: false, flsa: 'non_exempt' },
    citation: C.wageNotice,
    statutory: true,
  },
  {
    id: 'ch-supervisor-training',
    title: 'Supervisor harassment prevention training (2 hours)',
    why: 'A new California supervisor needs 2 hours of training within 6 months of starting to supervise.',
    ownerRole: 'admin',
    due: due('created', 6, 'months'),
    category: 'training',
    when: { outsideCA: false, supervisor: true, minWorkforce: 5 },
    citation: C.harassmentTraining,
    statutory: true,
  },
  {
    id: 'ch-refresh-grant',
    title: 'Refresh grant added to the next board consent',
    why: 'The new options exist only once the board approves them at the current 409A price.',
    ownerRole: 'admin',
    due: due('created', 30),
    category: 'equity',
    when: { hasEquity: true },
    statutory: false,
  },
]

export const DEFAULT_CHECKLIST_TEMPLATES: ChecklistTemplate[] = [
  { id: 'tpl-onboarding', kind: 'onboarding', name: 'California onboarding', tasks: ONBOARDING },
  { id: 'tpl-offboarding', kind: 'offboarding', name: 'Offboarding', tasks: OFFBOARDING },
  { id: 'tpl-new-state', kind: 'new_state', name: 'New state setup', tasks: NEW_STATE },
  { id: 'tpl-leave', kind: 'leave', name: 'Protected leave', tasks: LEAVE },
  { id: 'tpl-change', kind: 'change', name: 'Job or pay change', tasks: CHANGE },
]

/** Template task ids the lifecycle code refers to by name. */
export const TASK_IDS = {
  backgroundCheck: 'on-background-check',
  newStatePointer: 'on-new-state',
  de34: 'on-de34',
  piia: 'on-piia',
  /** Not a template task: hireFromOffer adds it to the onboarding checklist when the offer has a sign-on bonus. */
  signOnBonus: 'on-sign-on-bonus',
  election83b: 'on-83b',
  finalPay: ['off-final-pay-termination', 'off-final-pay-contract-end', 'off-final-pay-notice', 'off-final-pay-72h'],
  /** Separation notices, COBRA and HIPP: nothing to send when the person never started work. */
  separationNotices: ['off-separation-notices', 'off-separation-notices-optional', 'off-cobra', 'off-hipp'],
  vacationPayout: 'off-vacation-payout',
  reassignReports: 'off-reassign-reports',
  exitNote: 'off-exit-note',
  rehire: 'off-rehire',
  retention: 'off-retention',
  designation: 'lv-designation',
  returnToWork: 'lv-return',
  payroll: 'ch-payroll',
  wageChangeNotice: 'ch-wage-notice',
  supervisorTraining: 'ch-supervisor-training',
  refreshGrant: 'ch-refresh-grant',
  /**
   * Onboarding obligations that stay open after an early exit: the person was hired, so the new hire
   * report, the I-9 and the ACA notice are still owed even if they leave before the due date.
   */
  survivesExit: ['on-i9-section1', 'on-i9-section2', 'on-de34', 'on-state-new-hire-report', 'on-notice-aca'],
  /**
   * Filings with an agency (EDD's DE 34, another state's new hire registry, an 83(b) election with the IRS).
   * Only these get a "file by" day when the deadline lands on a weekend or holiday (taskFileBy in generate.ts).
   */
  agencyFilings: ['on-de34', 'on-state-new-hire-report', 'on-83b'],
} as const

/** Checklist tasks that are harassment prevention training, and the training tracker kind each completes. */
export const HARASSMENT_TASK_KINDS: Record<string, 'harassment_employee' | 'harassment_supervisor'> = {
  'on-harassment-training': 'harassment_employee',
  'on-harassment-training-short-term': 'harassment_employee',
  'on-harassment-training-supervisor': 'harassment_supervisor',
  'ch-supervisor-training': 'harassment_supervisor',
}
