// Starter role templates for a company that starts fresh: the first hires most startups make, written for
// any product and any customer. Nothing here names a product, an industry or a customer: the posting
// goes out with this text when it is left as is, so it must be true of whatever the company builds. (The
// sample company keeps its own, product-specific set in roleTemplates.ts.)
//
// Each template prefills the level and band (so the posted range), a JD outline, the default stages (the
// sales role renames Technical to 'Mock discovery call') and an interview plan with 3 to 5 scorecard
// attributes per step. Every attribute has a one-line anchor (what a strong yes looks like) and 2
// suggested questions. Users edit these in Hiring > Interview kits.
//
// Copy rules (as in roleTemplates.ts): sentence case, no em dashes, no age-coded words, no 'rockstar'
// language, nothing that asks about pay history or criminal history, and posting qualifiers in `hint`
// and the JD, never in the name (it becomes the job, letter and employee title).
import type { Attribute, JobStage, RoleTemplate } from '@/domain/types'

/** Default pipeline (matches DEFAULT_STAGES in src/data/defaults.ts). */
function stages(technicalName = 'Technical'): JobStage[] {
  return [
    { id: 'new', kind: 'new', name: 'New', slaBusinessDays: 3 },
    { id: 'intro', kind: 'intro', name: 'Intro call', slaBusinessDays: 5 },
    { id: 'technical', kind: 'technical', name: technicalName, slaBusinessDays: 5 },
    { id: 'onsite', kind: 'onsite', name: 'Onsite', slaBusinessDays: 3 },
    { id: 'offer', kind: 'offer', name: 'Offer' },
    { id: 'hired', kind: 'hired', name: 'Hired' },
  ]
}

const EMAILS = ['em-received', 'em-screen', 'em-onsite', 'em-reject-early', 'em-reject-late', 'em-offer']

function attr(name: string, anchor: string, q1: string, q2: string): Attribute {
  return { name, anchor, questions: [q1, q2] }
}

// ---- Attribute library ------------------------------------------------------------------------

const A = {
  motivation: attr(
    'Motivation for this stage and role',
    'Says clearly why an early-stage company and this role, with past evidence of doing well amid ambiguity.',
    'What draws you to joining a company this early, and to this role in particular?',
    'Tell me about a time you started without a clear spec. What did you do first?',
  ),
  communication: attr(
    'Clear communication',
    'Explains complex work simply, adjusts to the audience, and writes things down without being asked.',
    'Walk me through a decision you had to explain to someone outside your field.',
    'Tell me about a write-up or document you are proud of. What made it work?',
  ),
  ownership: attr(
    'Ownership and follow-through',
    'Gives specific examples of seeing hard work through to the end, including the unglamorous parts.',
    'Tell me about something you shipped or finished that nobody asked you to do.',
    'Describe a project that went sideways. What did you personally do to recover it?',
  ),
  codeQuality: attr(
    'Code quality and craft',
    'Writes readable, tested code, refactors with care, and can explain each choice.',
    'In the exercise, what would you change before shipping this to production?',
    'How do you decide what to test and what not to?',
  ),
  frontend: attr(
    'Frontend craft',
    'Builds fast, accessible interfaces with clear loading, error and empty states, and works well with a keyboard and a screen reader.',
    'How would you build a screen where someone reviews and approves a long list of items quickly?',
    'How do you keep a large, interactive page fast as the data grows?',
  ),
  systemDesign: attr(
    'System design',
    'Breaks a vague problem into clear parts, names the tradeoffs, and picks a simple design that can grow.',
    'Design a service that runs background jobs for many customers who all need them at the same time of day.',
    'Where does this design break first at 10 times the customers, and what would you change?',
  ),
  dataModeling: attr(
    'Data modeling',
    'Models messy real-world data cleanly, with clear ownership, tests and a plan for changes over time.',
    'How would you model a record that people edit over time so every change can be traced?',
    'A customer asks to restore last month\'s data after a bad import. How does your design handle it?',
  ),
  securityMindset: attr(
    'Security mindset',
    'Thinks about threat models, least privilege and customer data by default, without slowing the team down.',
    'How would you store and rotate the credentials our system uses to reach a customer\'s other tools?',
    'What are the main risks when a new feature reads customer data, and how do you limit them?',
  ),
  mlFundamentals: attr(
    'ML fundamentals and experimentation',
    'Picks the simplest model that works, sets up honest baselines, and reads metrics with healthy suspicion.',
    'When would you fine-tune a model instead of improving prompts or features? What evidence would you want first?',
    'Tell me about an experiment whose result you did not trust. How did you check it?',
  ),
  evals: attr(
    'Evaluation and error analysis',
    'Builds evaluations tied to real failure modes, reads outputs by hand, and turns findings into measurable fixes.',
    'How would you build an evaluation set for a model feature before it ships?',
    'A change raises the main metric but user complaints go up. How do you find out why?',
  ),
  mlSystems: attr(
    'ML systems in production',
    'Ships models and LLM features with monitoring, fallbacks and human review where it matters, and knows where models fail.',
    'Design a feature where a model suggests an action and a person approves it. Where does the review happen?',
    'How do you stop a model-driven feature from taking an action it should only suggest?',
  ),
  productSense: attr(
    'Product sense',
    'Starts from the user job to be done, cuts scope well, and measures what matters.',
    'What would you build first to save our users the most time, and how would you know it worked?',
    'How would you tell whether a feature is actually used and trusted?',
  ),
  designCraft: attr(
    'Interaction and visual design craft',
    'Produces clear, polished flows for complex work and can defend every decision.',
    'Walk us through a project where you simplified a complex workflow. What did you cut, and why?',
    'How do you design for trust when the user must approve or reject a suggestion?',
  ),
  userResearch: attr(
    'User research',
    'Runs crisp research with busy users and turns findings into clear decisions.',
    'How would you learn how our users really work in one week of research?',
    'Tell me about research that changed a roadmap. What did you do to make it land?',
  ),
  collaboration: attr(
    'Collaboration with engineering and product',
    'Works in the same loop as engineers, makes tradeoffs openly, and ships iteratively.',
    'How do you hand off a design or a spec so engineering can build it without a dozen follow-ups?',
    'Tell me about a disagreement with an engineer or designer. How did you resolve it?',
  ),
  prioritization: attr(
    'Prioritization and roadmap judgment',
    'Makes clear calls with incomplete data, says what not to do, and explains why.',
    'You have three customer asks and one engineer for a quarter. How do you decide?',
    'Tell me about a feature you killed. How did you decide, and how did you tell people?',
  ),
  customerDiscovery: attr(
    'Customer discovery',
    'Gets past feature requests to the real problem, and validates before building.',
    'A customer asks for a custom report. How do you find out what they really need?',
    'How would you test whether customers would pay for a new feature before building it?',
  ),
  discovery: attr(
    'Discovery and qualification',
    'Uncovers pain, budget, timeline and decision process in a natural conversation, and knows when to walk away.',
    'In the mock call, what did you learn about how this buyer works today?',
    'Tell me about a deal you qualified out. What told you it was not real?',
  ),
  pipeline: attr(
    'Pipeline generation',
    'Has built pipeline from zero with a repeatable outbound motion and can show the numbers.',
    'How would you build your first 30 qualified opportunities here?',
    'Walk me through your best outbound sequence and the reply rate it got.',
  ),
  closing: attr(
    'Deal execution and forecasting',
    'Runs mutual action plans, multi-threads into the buying committee, and forecasts accurately.',
    'Walk me through your largest deal from first call to signature.',
    'Tell me about a deal you lost late. What would you do differently?',
  ),
  businessCase: attr(
    'Building the business case',
    "Speaks the buyer's language: the cost of the problem, the time saved and the risk, backed by numbers.",
    'How would you build a business case for a buyer who already has a tool that partly does this?',
    'What objections do buyers raise about switching to a young company, and how do you answer them?',
  ),
  coachability: attr(
    'Coachability',
    'Asks for feedback, takes it without defensiveness, and visibly applies it within the same conversation.',
    'What is the most useful feedback you got in the last year, and what did you change?',
    'After the mock call: what would you do differently on a second try?',
  ),
  techDemo: attr(
    'Technical demo and discovery',
    "Tailors a demo to the buyer's setup and pain, and handles hard technical questions live.",
    'Show how you would demo our product to a technical buyer. What do you show first, and why?',
    'An IT lead asks exactly how we access and store their data. How do you answer?',
  ),
  solutionDesign: attr(
    'Solution design and scoping',
    'Turns a messy customer environment into a clear, scoped plan with risks called out early.',
    'A prospect runs several older systems that must connect to ours. How do you scope the rollout?',
    'How do you push back when sales has promised something the product does not do?',
  ),
  customerTrust: attr(
    'Customer relationships and retention',
    'Builds trust with customers, spots churn risk early, and drives adoption with evidence.',
    'How do you run a quarterly business review for a customer who is short on time?',
    'Usage drops 40% a month after launch. What do you do?',
  ),
  closeProcess: attr(
    'Close process and controls',
    'Has run a fast, clean month-end close with documented controls and clean audits.',
    'Walk me through how you would get a 15-day close down to 7 days.',
    'Which controls matter most at a 20-person company, and which are overkill?',
  ),
  technicalAccounting: attr(
    'Technical accounting (ASC 606, accruals, stock comp)',
    'Applies the standards to real startup transactions and documents positions an auditor would accept.',
    'How would you recognize revenue on an annual contract with a paid setup fee?',
    'Walk me through how you would record stock-based compensation for a new option grant.',
  ),
  peopleOps: attr(
    'People operations and California basics',
    'Knows California employment basics and builds simple, compliant processes for a small team.',
    'Walk me through what has to happen for a new California hire before and during their first week.',
    'An employee moves to Texas and keeps working for us remotely. What changes?',
  ),
  operationalRigor: attr(
    'Operational rigor',
    'Builds checklists and systems that make recurring work reliable, and catches details others miss.',
    'Tell me about a process you built from scratch. How did you know it worked?',
    'How do you keep track of recurring deadlines across payroll, benefits and compliance?',
  ),
  discretion: attr(
    'Judgment and discretion',
    'Handles sensitive information carefully and knows when to escalate or get counsel.',
    'Someone shares something in confidence that may require action. What do you do?',
    'How do you decide what to handle yourself and what to take to counsel or the PEO?',
  ),
}

type Step = RoleTemplate['interviewPlan'][number]

function step(templateId: string, n: number, stageId: string, name: string, durationMin: number, attributes: Attribute[]): Step {
  return { id: `${templateId}-s${n}`, stageId, name, durationMin, attributes }
}

function jd(doing: string[], bring: string[], nice: string[]): string {
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n')
  return `What you'll do\n${list(doing)}\n\nWhat you bring\n${list(bring)}\n\nNice to have\n${list(nice)}`
}

export const DEFAULT_ROLE_TEMPLATES: RoleTemplate[] = [
  {
    id: 'rt-fullstack',
    name: 'Senior full-stack engineer',
    familyId: 'f-eng',
    levelId: 'lv-l3',
    departmentId: 'd-eng',
    jdOutline: jd(
      [
        'Build core product features end to end, from the data model and APIs to fast, accessible interfaces',
        'Shape the architecture and engineering habits of a small team as one of its first engineers',
        'Talk with customers to find what slows them down, then fix it',
        'Keep quality high with tests, code review and careful releases',
      ],
      [
        '5+ years building production web applications, with strong TypeScript and SQL',
        'Comfort across the stack: a modern frontend framework, backend services and a relational database',
        'Care for correctness, testing and clear code',
        'Clear written communication with a small, fast team',
      ],
      ['Experience at an early-stage startup', 'Built accessible interfaces for data-heavy work', 'Worked under SOC 2 or similar controls'],
    ),
    stages: stages(),
    interviewPlan: [
      step('rt-fullstack', 1, 'intro', 'Intro call', 30, [A.motivation, A.communication, A.ownership]),
      step('rt-fullstack', 2, 'technical', 'Pairing exercise', 90, [A.codeQuality, A.frontend, A.communication]),
      step('rt-fullstack', 3, 'onsite', 'System design', 60, [A.systemDesign, A.securityMindset, A.dataModeling]),
      step('rt-fullstack', 4, 'onsite', 'Product and customer session', 45, [A.productSense, A.collaboration, A.ownership]),
    ],
    emailTemplateIds: EMAILS,
  },
  {
    id: 'rt-ml',
    name: 'Machine learning engineer',
    familyId: 'f-ml',
    levelId: 'lv-l3',
    departmentId: 'd-eng',
    jdOutline: jd(
      [
        'Design, ship and improve the model and LLM features in our product',
        'Build the evaluations, monitoring and human review that keep those features trustworthy',
        'Run error analysis on real usage and turn it into measurable gains',
        'Decide when to improve data, prompts or models, and prove it with evaluations',
      ],
      [
        '4+ years shipping ML or LLM systems to production',
        'Strong Python and working knowledge of model APIs, embeddings and evaluation',
        'A habit of reading model outputs by hand and distrusting a single metric',
        'Clear communication about what a model can and cannot do',
      ],
      ['Experience at an early-stage startup', 'Built human-in-the-loop review flows', 'Published or open-source ML work'],
    ),
    stages: stages(),
    interviewPlan: [
      step('rt-ml', 1, 'intro', 'Intro call', 30, [A.motivation, A.communication, A.ownership]),
      step('rt-ml', 2, 'technical', 'ML design deep dive', 75, [A.mlSystems, A.evals, A.mlFundamentals]),
      step('rt-ml', 3, 'onsite', 'Error analysis exercise', 75, [A.evals, A.codeQuality, A.communication]),
      step('rt-ml', 4, 'onsite', 'Systems and safety session', 60, [A.systemDesign, A.securityMindset, A.productSense]),
    ],
    emailTemplateIds: EMAILS,
  },
  {
    id: 'rt-designer',
    name: 'Product designer',
    familyId: 'f-design',
    levelId: 'lv-l3',
    departmentId: 'd-product',
    jdOutline: jd(
      [
        'Own the end-to-end design of our product, from research to polished, accessible flows',
        'Run research with customers and turn it into clear decisions',
        'Build and grow a simple design system with engineering',
        'Raise the bar on craft as the first or second designer on the team',
      ],
      [
        '4+ years designing software products, with a portfolio that shows your process',
        'Strong interaction and visual design for complex workflows',
        'Comfort running your own research',
        'Clear communication and a habit of shipping iteratively',
      ],
      ['Experience at an early-stage startup', 'Accessibility expertise', 'Comfort prototyping in code'],
    ),
    stages: stages(),
    interviewPlan: [
      step('rt-designer', 1, 'intro', 'Intro call', 30, [A.motivation, A.communication, A.ownership]),
      step('rt-designer', 2, 'technical', 'Portfolio review', 60, [A.designCraft, A.userResearch, A.communication]),
      step('rt-designer', 3, 'onsite', 'Design exercise', 90, [A.designCraft, A.productSense, A.userResearch]),
      step('rt-designer', 4, 'onsite', 'Working session with engineering', 45, [A.collaboration, A.frontend, A.ownership]),
    ],
    emailTemplateIds: EMAILS,
  },
  {
    id: 'rt-pm',
    name: 'Product manager',
    familyId: 'f-product',
    levelId: 'lv-l3',
    departmentId: 'd-product',
    jdOutline: jd(
      [
        'Own the roadmap for a core part of our product, from discovery to launch and adoption',
        'Talk with customers every week and turn what you learn into clear priorities',
        'Work in the same loop as design and engineering, writing crisp specs and cutting scope well',
        'Define what success looks like and measure it',
      ],
      [
        '4+ years in product management for software products',
        'A track record of shipping products customers rely on',
        'Strong judgment with incomplete data, and the ability to say no and explain why',
        'Clear written communication',
      ],
      ['Experience at an early-stage startup', 'A technical or design background', 'Experience selling to businesses'],
    ),
    stages: stages(),
    interviewPlan: [
      step('rt-pm', 1, 'intro', 'Intro call', 30, [A.motivation, A.communication, A.ownership]),
      step('rt-pm', 2, 'technical', 'Product case', 60, [A.productSense, A.prioritization, A.customerDiscovery]),
      step('rt-pm', 3, 'onsite', 'Customer discovery role play', 45, [A.customerDiscovery, A.communication, A.productSense]),
      step('rt-pm', 4, 'onsite', 'Roadmap and tradeoffs with engineering', 60, [A.prioritization, A.collaboration, A.ownership]),
    ],
    emailTemplateIds: EMAILS,
  },
  {
    id: 'rt-ae-founding',
    name: 'Founding account executive',
    familyId: 'f-gtm',
    levelId: 'lv-l3',
    departmentId: 'd-gtm',
    jdOutline: jd(
      [
        'Own the full sales cycle, from first outreach to signed contract',
        'Build the sales playbook with the founders: messaging, qualification and pricing',
        'Bring what you hear from buyers back to product',
        'Forecast accurately and keep the pipeline honest',
      ],
      [
        '4+ years closing business software deals, with a record of hitting quota',
        'Experience building pipeline from zero with outbound',
        'Comfort leading discovery and demos with technical and business buyers',
        'Coachable, organized and clear in writing',
      ],
      ['Experience as an early sales hire at a startup', 'Experience selling to the buyers we serve', 'Familiarity with a CRM and sales tooling'],
    ),
    stages: stages('Mock discovery call'),
    interviewPlan: [
      step('rt-ae-founding', 1, 'intro', 'Intro call', 30, [A.motivation, A.communication, A.coachability]),
      step('rt-ae-founding', 2, 'technical', 'Mock discovery call', 45, [A.discovery, A.businessCase, A.coachability]),
      step('rt-ae-founding', 3, 'onsite', 'Deal review and pipeline plan', 60, [A.pipeline, A.closing, A.ownership]),
      step('rt-ae-founding', 4, 'onsite', 'Business case presentation', 45, [A.businessCase, A.communication, A.closing]),
    ],
    emailTemplateIds: EMAILS,
  },
  {
    id: 'rt-csm',
    name: 'Customer success manager',
    familyId: 'f-gtm',
    levelId: 'lv-l2',
    departmentId: 'd-gtm',
    jdOutline: jd(
      [
        'Onboard new customers and get them to value quickly',
        'Run regular reviews, track health and spot churn risk early',
        'Turn customer feedback into clear requests for product and engineering',
        'Grow accounts by showing results with evidence',
      ],
      [
        '3+ years in customer success, account management or a customer-facing role',
        'A record of strong retention and happy customers',
        'Clear, organized communication with busy people',
        'Comfort learning a technical product in depth',
      ],
      ['Experience at an early-stage startup', 'Experience with the customers we serve', 'Familiarity with a CRM and support tooling'],
    ),
    stages: stages(),
    interviewPlan: [
      step('rt-csm', 1, 'intro', 'Intro call', 30, [A.motivation, A.communication, A.ownership]),
      step('rt-csm', 2, 'technical', 'Account review case', 45, [A.customerTrust, A.communication, A.operationalRigor]),
      step('rt-csm', 3, 'onsite', 'Quarterly business review role play', 45, [A.customerTrust, A.businessCase, A.communication]),
      step('rt-csm', 4, 'onsite', 'Churn risk scenario', 45, [A.ownership, A.operationalRigor, A.customerTrust]),
    ],
    emailTemplateIds: EMAILS,
  },
  {
    id: 'rt-solutions',
    name: 'Solutions engineer',
    familyId: 'f-solutions',
    levelId: 'lv-l3',
    departmentId: 'd-gtm',
    jdOutline: jd(
      [
        'Run technical discovery and tailored demos with prospects alongside sales',
        'Scope rollouts and integrations, and call out risks early',
        'Answer security and technical reviews with confidence',
        'Bring what customers need back to product and engineering',
      ],
      [
        '4+ years as a solutions or sales engineer, or in a technical customer-facing role',
        'Enough engineering depth to discuss APIs, data and security with an IT team',
        'Excellent demos and clear written answers',
        'Comfort with ambiguity at an early-stage company',
      ],
      ['Experience at an early-stage startup', 'Hands-on integration or implementation work', 'Experience with security questionnaires'],
    ),
    stages: stages(),
    interviewPlan: [
      step('rt-solutions', 1, 'intro', 'Intro call', 30, [A.motivation, A.communication, A.ownership]),
      step('rt-solutions', 2, 'technical', 'Demo exercise', 60, [A.techDemo, A.businessCase, A.communication]),
      step('rt-solutions', 3, 'onsite', 'Solution design for a complex prospect', 60, [A.solutionDesign, A.systemDesign, A.communication]),
      step('rt-solutions', 4, 'onsite', 'Security review role play', 45, [A.securityMindset, A.communication, A.techDemo]),
    ],
    emailTemplateIds: EMAILS,
  },
  {
    id: 'rt-finance',
    name: 'Finance and accounting lead',
    hint: 'CPA preferred',
    familyId: 'f-acct',
    levelId: 'lv-l3',
    departmentId: 'd-ops',
    jdOutline: jd(
      [
        "Run the company's close, controls and audit readiness as its first in-house finance hire",
        'Own revenue recognition, accruals, stock compensation and audit support',
        'Build budgets, forecasts and the reporting the founders and board rely on',
        'Work with our payroll provider, bookkeepers and tax advisors',
      ],
      [
        '5+ years in accounting or finance, in public accounting, industry or both',
        'Hands-on month-end close ownership, ideally at a startup',
        'Strong technical accounting (ASC 606, ASC 718) and controls experience',
        'Organized, precise and clear with people outside finance',
      ],
      ['Active CPA license', 'Experience at a venture-backed startup', 'Experience with SOC 2 or audit controls'],
    ),
    stages: stages(),
    interviewPlan: [
      step('rt-finance', 1, 'intro', 'Intro call', 30, [A.motivation, A.communication, A.ownership]),
      step('rt-finance', 2, 'technical', 'Technical accounting case', 75, [A.technicalAccounting, A.closeProcess, A.communication]),
      step('rt-finance', 3, 'onsite', 'Close and controls deep dive', 60, [A.closeProcess, A.operationalRigor, A.discretion]),
      step('rt-finance', 4, 'onsite', 'Working with the founders', 45, [A.communication, A.prioritization, A.ownership]),
    ],
    emailTemplateIds: EMAILS,
  },
  {
    id: 'rt-ops-people',
    name: 'Ops and people generalist',
    familyId: 'f-ops',
    levelId: 'lv-l2',
    departmentId: 'd-ops',
    jdOutline: jd(
      [
        'Run people operations for a growing California team: onboarding, offboarding, time off and records',
        'Keep compliance on track with our payroll provider or PEO: notices, trainings, filings and deadlines',
        'Own recurring operations: vendors, equipment and the people side of security reviews',
        'Make the company a great place to work as it grows past 20',
      ],
      [
        '3+ years in people operations, HR generalist or business operations roles',
        'Working knowledge of California employment basics (or the drive to learn fast)',
        'Excellent organization and follow-through on recurring deadlines',
        'Discretion with sensitive information',
      ],
      ['Experience at an early-stage startup', 'PEO administration experience', 'Exposure to SOC 2 or other audits'],
    ),
    stages: stages(),
    interviewPlan: [
      step('rt-ops-people', 1, 'intro', 'Intro call', 30, [A.motivation, A.communication, A.ownership]),
      step('rt-ops-people', 2, 'technical', 'Operations case: onboarding a California hire', 60, [A.peopleOps, A.operationalRigor, A.communication]),
      step('rt-ops-people', 3, 'onsite', 'Judgment scenarios', 45, [A.discretion, A.peopleOps, A.ownership]),
      step('rt-ops-people', 4, 'onsite', 'Systems and recurring deadlines', 45, [A.operationalRigor, A.collaboration, A.communication]),
    ],
    emailTemplateIds: EMAILS,
  },
]
