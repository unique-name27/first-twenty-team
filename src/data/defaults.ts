// Defaults every workspace starts with (blank or sample). Users edit all of these in Settings.
import type {
  Band,
  Department,
  EmailTemplate,
  Holiday,
  JobFamily,
  JobStage,
  Level,
  Policy,
  TimeOffPolicy,
} from '@/domain/types'

/** Default pipeline: New, Intro call, Technical, Onsite, Offer, Hired. SLAs in business days. */
export const DEFAULT_STAGES: JobStage[] = [
  { id: 'new', kind: 'new', name: 'New', slaBusinessDays: 3 },
  { id: 'intro', kind: 'intro', name: 'Intro call', slaBusinessDays: 5 },
  { id: 'technical', kind: 'technical', name: 'Technical', slaBusinessDays: 5 },
  { id: 'onsite', kind: 'onsite', name: 'Onsite', slaBusinessDays: 3 },
  { id: 'offer', kind: 'offer', name: 'Offer' },
  { id: 'hired', kind: 'hired', name: 'Hired' },
]

export const DEFAULT_DEPARTMENTS: Department[] = [
  { id: 'd-exec', name: 'Executive' },
  { id: 'd-eng', name: 'Engineering' },
  { id: 'd-product', name: 'Product and design' },
  { id: 'd-gtm', name: 'Go to market' },
  { id: 'd-ops', name: 'Finance and operations' },
]

export const DEFAULT_FAMILIES: JobFamily[] = [
  { id: 'f-exec', name: 'Executive', track: 'executive' },
  { id: 'f-eng', name: 'Software engineering', track: 'engineering' },
  { id: 'f-ml', name: 'Machine learning', track: 'engineering' },
  { id: 'f-design', name: 'Design', track: 'product_design' },
  { id: 'f-product', name: 'Product management', track: 'product_design' },
  { id: 'f-gtm', name: 'Sales and customer success', track: 'gtm' },
  { id: 'f-solutions', name: 'Solutions and implementation', track: 'gtm' },
  { id: 'f-acct', name: 'Accounting', track: 'finance_ops' },
  { id: 'f-ops', name: 'People and operations', track: 'finance_ops' },
]

export const DEFAULT_LEVELS: Level[] = [
  { id: 'lv-l1', code: 'L1', name: 'Associate', track: 'ic', order: 1, description: 'Early career; works on well-scoped tasks with guidance.' },
  { id: 'lv-l2', code: 'L2', name: 'Mid-level', track: 'ic', order: 2, description: 'Owns features end to end; needs little direction.' },
  { id: 'lv-l3', code: 'L3', name: 'Senior', track: 'ic', order: 3, description: 'Owns a product area; sets technical direction for it.' },
  { id: 'lv-l4', code: 'L4', name: 'Staff', track: 'ic', order: 4, description: 'Shapes direction across areas; multiplies the team.' },
  { id: 'lv-l5', code: 'L5', name: 'Principal', track: 'ic', order: 5, description: 'Company-level technical or domain leadership.' },
  { id: 'lv-m1', code: 'M1', name: 'Manager', track: 'manager', order: 4, description: 'Manages a team of 3-8.' },
  { id: 'lv-m2', code: 'M2', name: 'Head of', track: 'manager', order: 5, description: 'Leads a function.' },
  { id: 'lv-x1', code: 'X1', name: 'Executive', track: 'executive', order: 6, description: 'Founder or C-level.' },
]

type BandRow = [levelId: string, min: number, mid: number, max: number, eqMin: number, eqMax: number, variablePct?: number]

// Starting points for a seed-stage company in the San Jose / Bay Area market (base salary, USD).
// The sample company overrides these with its own researched bands.
const BAND_TABLE: Record<string, BandRow[]> = {
  'f-eng': [
    ['lv-l2', 150_000, 172_000, 195_000, 0.0005, 0.0015],
    ['lv-l3', 180_000, 205_000, 230_000, 0.001, 0.0035],
    ['lv-l4', 210_000, 237_000, 265_000, 0.0025, 0.006],
    ['lv-l5', 240_000, 268_000, 295_000, 0.005, 0.01],
    ['lv-m1', 215_000, 240_000, 265_000, 0.003, 0.007],
  ],
  'f-ml': [
    ['lv-l2', 165_000, 188_000, 210_000, 0.0007, 0.002],
    ['lv-l3', 195_000, 222_000, 250_000, 0.0015, 0.004],
    ['lv-l4', 225_000, 255_000, 285_000, 0.003, 0.0075],
    ['lv-l5', 255_000, 285_000, 315_000, 0.006, 0.012],
  ],
  'f-design': [
    ['lv-l2', 135_000, 155_000, 175_000, 0.0005, 0.0012],
    ['lv-l3', 160_000, 182_000, 205_000, 0.001, 0.003],
    ['lv-l4', 190_000, 212_000, 235_000, 0.002, 0.005],
  ],
  'f-product': [
    ['lv-l2', 145_000, 165_000, 185_000, 0.0005, 0.0015],
    ['lv-l3', 170_000, 195_000, 220_000, 0.002, 0.006],
    ['lv-l4', 200_000, 225_000, 250_000, 0.003, 0.008],
  ],
  'f-solutions': [
    ['lv-l2', 130_000, 147_000, 165_000, 0.0005, 0.0015, 0.1],
    ['lv-l3', 150_000, 175_000, 200_000, 0.0008, 0.003, 0.15],
  ],
  'f-gtm': [
    ['lv-l1', 85_000, 95_000, 105_000, 0.0002, 0.0005, 0.15],
    ['lv-l2', 110_000, 125_000, 140_000, 0.0003, 0.001, 0.2],
    ['lv-l3', 135_000, 150_000, 165_000, 0.0008, 0.0025, 1.0],
    ['lv-m2', 170_000, 190_000, 210_000, 0.004, 0.01, 1.0],
  ],
  'f-acct': [
    ['lv-l2', 115_000, 130_000, 145_000, 0.0003, 0.001],
    ['lv-l3', 145_000, 165_000, 185_000, 0.001, 0.003],
    ['lv-l4', 175_000, 195_000, 215_000, 0.002, 0.006],
  ],
  'f-ops': [
    ['lv-l1', 60_000, 70_000, 80_000, 0.0001, 0.0003],
    ['lv-l2', 105_000, 120_000, 135_000, 0.0003, 0.001],
    ['lv-l3', 135_000, 152_000, 170_000, 0.0008, 0.0025],
  ],
}

export const DEFAULT_BANDS: Band[] = Object.entries(BAND_TABLE).flatMap(([familyId, rows]) =>
  rows.map(([levelId, min, mid, max, equityMinPct, equityMaxPct, variablePct]) => ({
    id: `b-${familyId.slice(2)}-${levelId.slice(3)}`,
    familyId,
    levelId,
    min,
    mid,
    max,
    equityMinPct,
    equityMaxPct,
    ...(variablePct != null ? { variablePct } : {}),
  })),
)

export const DEFAULT_TIME_OFF_POLICIES: TimeOffPolicy[] = [
  {
    id: 'pol-vacation',
    name: 'Vacation',
    kind: 'vacation',
    method: 'accrual',
    annualHours: 120,
    capHours: 180,
    paidOutOnExit: true,
    appliesTo: 'all',
    description:
      '15 days a year, earned each pay period. Earning pauses at 180 hours (22.5 days) and starts again once you use some. Unused vacation is paid out when you leave, as California requires.',
  },
  {
    id: 'pol-sick',
    name: 'Sick leave',
    kind: 'sick',
    method: 'frontload',
    annualHours: 40,
    usageCapHours: 40,
    capHours: 80,
    usableAfterDays: 90,
    autoApprove: true,
    appliesToStates: ['CA'],
    citation: { label: 'Labor Code 246', url: 'https://www.dir.ca.gov/dlse/Paid_Sick_Leave.htm' },
    paidOutOnExit: false,
    appliesTo: 'all',
    description:
      'California paid sick leave: 40 hours (5 days) available at the start of each calendar year, usable from day 90. For yourself or a family member, including preventive care and safe time. Not paid out at separation; restored if rehired within 12 months.',
  },
  {
    id: 'pol-bereavement',
    name: 'Bereavement',
    kind: 'bereavement',
    method: 'as_needed',
    perEventHours: 40,
    appliesFromHeadcount: 5,
    usableAfterDays: 30,
    citation: { label: 'Gov Code 12945.7', url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=GOV&sectionNum=12945.7.' },
    paidOutOnExit: false,
    appliesTo: 'all',
    description:
      'Up to 5 days after the death of a family member, once you have worked here 30 days (California Government Code 12945.7, employers with 5+ employees). Take it within 3 months of the death.',
  },
  {
    id: 'pol-repro-loss',
    name: 'Reproductive loss',
    kind: 'reproductive_loss',
    method: 'as_needed',
    perEventHours: 40,
    appliesFromHeadcount: 5,
    usableAfterDays: 30,
    citation: { label: 'Gov Code 12945.6', url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=GOV&sectionNum=12945.6.' },
    paidOutOnExit: false,
    appliesTo: 'all',
    description:
      'Up to 5 days after a reproductive loss event, once you have worked here 30 days (California Government Code 12945.6, employers with 5+ employees). Take it within 3 months of the event.',
  },
  {
    id: 'pol-jury',
    name: 'Jury and witness duty',
    kind: 'jury_duty',
    method: 'as_needed',
    paidOutOnExit: false,
    appliesTo: 'all',
    description: 'Time off for jury or witness duty. Exempt employees keep full salary for any week they work.',
  },
  {
    id: 'pol-voting',
    name: 'Voting time',
    kind: 'voting',
    method: 'as_needed',
    perEventHours: 2,
    paidOutOnExit: false,
    appliesTo: 'all',
    description: 'Up to 2 hours of paid time to vote when you cannot vote outside working hours (Elections Code 14000). Ask 2 working days ahead.',
    citation: { label: 'Elections Code 14000', url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=ELEC&sectionNum=14000.' },
  },
  {
    id: 'pol-organ',
    name: 'Organ donor leave',
    kind: 'organ_donor',
    method: 'as_needed',
    perEventHours: 240,
    appliesFromHeadcount: 15,
    paidOutOnExit: false,
    appliesTo: 'all',
    description: 'Up to 30 business days of paid leave in a year to donate an organ (Labor Code 1510, employers with 15+ employees), after 90 days of employment.',
    citation: { label: 'Labor Code 1510', url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=LAB&sectionNum=1510.' },
  },
  {
    id: 'pol-marrow',
    name: 'Bone marrow donor leave',
    kind: 'bone_marrow_donor',
    method: 'as_needed',
    perEventHours: 40,
    appliesFromHeadcount: 15,
    paidOutOnExit: false,
    appliesTo: 'all',
    description: 'Up to 5 business days of paid leave in a year to donate bone marrow (Labor Code 1510, employers with 15+ employees), after 90 days of employment.',
    citation: { label: 'Labor Code 1510', url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=LAB&sectionNum=1510.' },
  },
  {
    id: 'pol-unpaid',
    name: 'Unpaid leave',
    kind: 'unpaid',
    method: 'as_needed',
    paidOutOnExit: false,
    appliesTo: 'all',
    description: 'Unpaid personal leave by agreement with your manager.',
  },
]

/** Company holidays (observed dates) for 2025-2027. */
export function defaultHolidays(): Holiday[] {
  const rows: Array<[string, string]> = [
    ['2025-01-01', "New Year's Day"],
    ['2025-01-20', 'Martin Luther King Jr. Day'],
    ['2025-02-17', "Presidents' Day"],
    ['2025-05-26', 'Memorial Day'],
    ['2025-06-19', 'Juneteenth'],
    ['2025-07-04', 'Independence Day'],
    ['2025-09-01', 'Labor Day'],
    ['2025-11-27', 'Thanksgiving'],
    ['2025-11-28', 'Day after Thanksgiving'],
    ['2025-12-24', 'Christmas Eve'],
    ['2025-12-25', 'Christmas Day'],
    ['2026-01-01', "New Year's Day"],
    ['2026-01-19', 'Martin Luther King Jr. Day'],
    ['2026-02-16', "Presidents' Day"],
    ['2026-05-25', 'Memorial Day'],
    ['2026-06-19', 'Juneteenth'],
    ['2026-07-03', 'Independence Day (observed)'],
    ['2026-09-07', 'Labor Day'],
    ['2026-11-26', 'Thanksgiving'],
    ['2026-11-27', 'Day after Thanksgiving'],
    ['2026-12-24', 'Christmas Eve'],
    ['2026-12-25', 'Christmas Day'],
    ['2027-01-01', "New Year's Day"],
    ['2027-01-18', 'Martin Luther King Jr. Day'],
    ['2027-02-15', "Presidents' Day"],
    ['2027-05-31', 'Memorial Day'],
    ['2027-06-18', 'Juneteenth (observed)'],
    ['2027-07-05', 'Independence Day (observed)'],
    ['2027-09-06', 'Labor Day'],
    ['2027-11-25', 'Thanksgiving'],
    ['2027-11-26', 'Day after Thanksgiving'],
    ['2027-12-24', 'Christmas Day (observed)'],
    ['2027-12-31', "New Year's Day (observed)"],
  ]
  return rows.map(([date, name]) => ({ id: `hol-${date}`, date, name }))
}

/**
 * The starter policies for a new workspace: version 1.0 of each, in effect from `effectiveOn` (the
 * founding date), so a company never inherits dates from before it existed.
 */
export function defaultPolicies(effectiveOn: string): Policy[] {
  return DEFAULT_POLICIES.map((p) => ({
    ...p,
    version: '1.0',
    effectiveOn,
    ...(p.id === 'pl-aup' ? { summary: 'Device, password, MFA and customer financial data handling rules.' } : {}),
  }))
}

export const DEFAULT_POLICIES: Policy[] = [
  {
    id: 'pl-handbook',
    title: 'Employee handbook',
    version: '1.0',
    effectiveOn: '2025-05-01',
    summary: 'At-will employment, conduct, time off, pay practices, and California leave rights.',
    requiresAck: true,
  },
  {
    id: 'pl-harassment',
    title: 'Harassment, discrimination and retaliation prevention policy',
    version: '1.0',
    effectiveOn: '2025-05-01',
    summary: 'How to report concerns, how complaints are investigated, and the ban on retaliation (written policy required under FEHA regulations).',
    requiresAck: true,
  },
  {
    id: 'pl-aup',
    title: 'Acceptable use and information security policy',
    version: '2.1',
    effectiveOn: '2026-04-15',
    summary: 'Device, password, MFA and customer financial data handling rules. A SOC 2 control.',
    requiresAck: true,
  },
  {
    id: 'pl-confidentiality',
    title: 'Confidential information and invention assignment agreement',
    version: '1.0',
    effectiveOn: '2025-05-01',
    summary: 'Protects company and customer information. Includes the Labor Code 2870 notice about inventions made on your own time.',
    requiresAck: true,
  },
]

export const DEFAULT_EMAIL_TEMPLATES: EmailTemplate[] = [
  {
    id: 'em-received',
    kind: 'other',
    name: 'Application received',
    subject: 'Thanks for applying to {{companyName}}',
    body:
      'Hi {{firstName}},\n\nThanks for applying for the {{jobTitle}} role at {{companyName}}. We read every application and will get back to you within 5 business days.\n\n{{senderName}}',
  },
  {
    id: 'em-screen',
    kind: 'scheduling',
    name: 'Screen invite',
    subject: 'Intro call for {{jobTitle}} at {{companyName}}',
    body:
      'Hi {{firstName}},\n\nWe would love to set up a 30-minute intro call about the {{jobTitle}} role. Do any of these times work for you?\n\n{{times}}\n\nAll times are Pacific. If none work, reply with a few that do.\n\n{{senderName}}',
  },
  {
    id: 'em-onsite',
    kind: 'scheduling',
    name: 'Onsite invite',
    subject: 'Next step: onsite for {{jobTitle}}',
    body:
      'Hi {{firstName}},\n\nThe team enjoyed meeting you. The next step is a half-day onsite at our San Jose office (or video, if you prefer). Here are the proposed times:\n\n{{times}}\n\nWe will send the agenda and who you will meet the day before.\n\n{{senderName}}',
  },
  {
    id: 'em-reject-early',
    kind: 'rejection',
    stageKinds: ['new', 'recruiter_screen', 'intro'],
    tone: 'kind',
    name: 'Not moving forward (early stage)',
    subject: 'Your application to {{companyName}}',
    body:
      'Hi {{firstName}},\n\nThank you for your interest in the {{jobTitle}} role. We have decided not to move forward right now. We appreciate the time you spent, and we wish you the best in your search.\n\n{{senderName}}',
  },
  {
    id: 'em-reject-late',
    kind: 'rejection',
    stageKinds: ['technical', 'onsite', 'offer', 'custom'],
    tone: 'kind',
    name: 'Not moving forward (after interviews)',
    subject: 'Following up on your interviews',
    body:
      'Hi {{firstName}},\n\nThank you for spending so much time with our team. It was a close decision, and we have decided not to move forward for the {{jobTitle}} role. I would be glad to share feedback on a short call if that would help.\n\n{{senderName}}',
  },
  {
    id: 'em-offer',
    kind: 'offer',
    name: 'Offer',
    subject: 'Your offer from {{companyName}}',
    body:
      'Hi {{firstName}},\n\nWe are thrilled to offer you the {{jobTitle}} role. Your offer letter is attached. Happy to walk through it together, including the equity details.\n\n{{senderName}}',
  },
  {
    // Sent before day 1 (the onboarding "Welcome email sent" task); pairs with the Day 1 ready badge.
    id: 'em-welcome',
    kind: 'welcome',
    name: 'First-day welcome',
    subject: 'Welcome to {{companyName}}: your first day, {{startDate}}',
    body:
      'Hi {{firstName}},\n\nWe are so glad you are joining us as {{jobTitle}}. Here is what to expect on your first day.\n\nWhen: {{startDate}} at {{startTime}}\nWhere: {{location}}\nYour first day: a welcome coffee, your laptop and accounts, a walkthrough of how we work, and lunch with the team.\nWho to ask: {{managerName}} is your manager and will meet you when you arrive. Reply to this email with any questions before then.\n\nSee you soon,\n{{senderName}}',
  },
]

