// The sample company's role templates (Ledgerlark, docs/SAMPLE.md): a financial AI startup that sells
// month-end close and reconciliation agents to mid-market controllers (NetSuite, Sage Intacct, QuickBooks
// Online). The sample seed installs them (src/data/seed/hiring.ts); a company that starts fresh gets the
// company-neutral starter set instead (starterRoleTemplates.ts), since a posting goes out with this text.
// Each template prefills the
// level and band (so the posted range), a JD outline, the default stages (the sales role renames
// Technical to 'Mock discovery call') and an interview plan with 3 to 5 scorecard attributes per
// step. Every attribute has a one-line anchor (what a strong yes looks like) and 2 suggested
// questions. Users edit these in Hiring > Interview kits.
//
// Copy rules: sentence case, no em dashes, no age-coded words, no 'rockstar' language, and nothing
// that asks about pay history or criminal history. A name becomes the job title, the offer letter's
// position and the hire's title, so posting qualifiers ('CPA preferred') go in `hint` (shown in the
// template pickers) and the JD, never in the name.
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
    'Motivation for this stage and problem',
    'Says clearly why an early-stage company and the month-end close problem, with past evidence of doing well amid ambiguity.',
    'What draws you to month-end close and reconciliation as a problem to work on?',
    'Tell me about a time you started without a clear spec. What did you do first?',
  ),
  communication: attr(
    'Clear communication',
    'Explains complex work simply, adjusts to the audience, and writes things down without being asked.',
    'Walk me through a technical decision you had to explain to someone outside your field.',
    'Tell me about a write-up or design doc you are proud of. What made it work?',
  ),
  ownership: attr(
    'Ownership and follow-through',
    'Gives specific examples of seeing hard work through to the end, including the unglamorous parts.',
    'Tell me about something you shipped that nobody asked you to do.',
    'Describe a project that went sideways. What did you personally do to recover it?',
  ),
  explainAgent: attr(
    'Explaining agent output to a controller',
    'Turns a model suggestion into a clear, auditable explanation a skeptical controller would sign off on.',
    'Our agent proposes a $48,000 accrual for unbilled cloud usage. How would you show the controller why?',
    'A controller says the agent matched the wrong invoice to a payment. How do you investigate and respond?',
  ),
  accountingJudgment: attr(
    'Accounting judgment (accruals, reconciliations, flux)',
    'Reasons from GAAP and real close experience, spots what does not tie, and knows which question to ask next.',
    'Walk me through how you would investigate a 30% month-over-month jump in hosting expense.',
    'A bank reconciliation is off by $1,214.37 at month end. What are the first five things you check?',
  ),
  llmEvals: attr(
    'LLM evals and error analysis',
    'Builds evals tied to real failure modes, reads outputs by hand, and turns findings into measurable fixes.',
    'How would you build an eval set for an agent that matches bank transactions to open invoices?',
    'A new prompt raises the match rate but controller complaints go up. How do you find out why?',
  ),
  agentSystems: attr(
    'Agent and LLM systems design',
    'Designs agent workflows with tools, retrieval, guardrails and human review, and knows where models fail.',
    'Design an agent that drafts month-end accrual entries from contracts and invoices. Where does a human review?',
    'How do you stop an agent from posting a journal entry it should only suggest?',
  ),
  mlFundamentals: attr(
    'ML fundamentals and experimentation',
    'Picks the simplest model that works, sets up honest baselines, and reads metrics with healthy suspicion.',
    'When would you fine-tune instead of improving prompts and retrieval? What evidence would you want first?',
    'Tell me about an experiment whose result you did not trust. How did you check it?',
  ),
  erpIntegration: attr(
    'ERP integration design',
    'Designs connectors that handle rate limits, partial failures, schema drift and safe reruns across NetSuite, Sage Intacct and QBO.',
    'Design a nightly general ledger sync from NetSuite within its API limits. How do you make it safe to rerun?',
    'A customer adds custom dimensions in Sage Intacct mid-quarter. How does your connector cope?',
  ),
  dataModeling: attr(
    'Data modeling and pipelines',
    'Models messy financial data cleanly, with lineage, tests and late-arriving data handled.',
    'How would you model transactions, matches and adjustments so every number traces back to its source?',
    'A customer reopens and restates last month. How does your pipeline handle it?',
  ),
  systemDesign: attr(
    'System design',
    'Breaks a vague problem into clear parts, names the tradeoffs, and picks a simple design that can grow.',
    'Design the service that runs close-agent jobs for 200 customers who all close in the same three days.',
    'Where does this design break first at 10 times the customers, and what would you change?',
  ),
  codeQuality: attr(
    'Code quality and craft',
    'Writes readable, tested code, refactors with care, and can explain each choice.',
    'In the exercise, what would you change before shipping this to production?',
    'How do you decide what to test and what not to?',
  ),
  frontend: attr(
    'Frontend craft for dense financial data',
    'Builds fast, accessible interfaces for large tables and review flows, with clear loading, error and empty states.',
    'How would you design a review screen where an accountant approves 2,000 suggested matches quickly?',
    'How do you keep a very large data table fast and usable with a keyboard and a screen reader?',
  ),
  securityMindset: attr(
    'Security mindset',
    'Thinks about threat models, least privilege and customer financial data by default, without slowing the team down.',
    'How would you store and rotate customer ERP credentials in our system?',
    'What are the main risks when an LLM agent can read a customer general ledger, and how do you limit them?',
  ),
  soc2: attr(
    'Compliance and audit readiness (SOC 2)',
    'Turns SOC 2 controls into lightweight, automated evidence and talks to auditors with confidence.',
    'Which SOC 2 controls would you automate first at a 20-person company, and how?',
    'An auditor asks for proof that access was removed within 24 hours of every exit. How do you produce it?',
  ),
  incident: attr(
    'Incident response',
    'Stays calm, contains first, communicates clearly, and writes a blameless review that changes something.',
    'Walk me through an incident you handled. What would you do differently now?',
    'A customer reports their ERP token may have leaked. What do you do in the first hour?',
  ),
  productSense: attr(
    'Product sense',
    'Starts from the user job to be done, cuts scope well, and measures what matters.',
    'What would you build first to save a controller a full day at month end?',
    'How would you know whether our reconciliation feature is actually used and trusted?',
  ),
  designCraft: attr(
    'Interaction and visual design craft',
    'Produces clear, polished flows for complex workflows and can defend every decision.',
    'Walk us through a project where you simplified a complex workflow. What did you cut, and why?',
    'How do you design for trust when the user must approve or reject AI suggestions?',
  ),
  userResearch: attr(
    'Research with finance users',
    'Runs crisp research with busy accountants and turns findings into clear decisions.',
    'How would you learn how a controller really runs close in one week of research?',
    'Tell me about research that changed a roadmap. What did you do to make it land?',
  ),
  collaboration: attr(
    'Collaboration with engineering and product',
    'Works in the same loop as engineers, makes tradeoffs openly, and ships iteratively.',
    'How do you hand off a design so engineering can build it without a dozen follow-ups?',
    'Tell me about a disagreement with an engineer or PM. How did you resolve it?',
  ),
  prioritization: attr(
    'Prioritization and roadmap judgment',
    'Makes clear calls with incomplete data, says what not to do, and explains why.',
    'You have three customer asks and one engineer for a quarter. How do you decide?',
    'Tell me about a feature you killed. How did you decide, and how did you tell people?',
  ),
  customerDiscovery: attr(
    'Customer discovery with controllers',
    'Gets past feature requests to the real close problem, and validates before building.',
    'A controller asks for a custom variance report. How do you find out what they really need?',
    'How would you test whether mid-market controllers would pay for automated flux commentary?',
  ),
  discovery: attr(
    'Discovery and qualification',
    'Uncovers pain, budget, timeline and decision process in a natural conversation, and knows when to walk away.',
    'In the mock call, what did you learn about how this controller runs close today?',
    'Tell me about a deal you qualified out. What told you it was not real?',
  ),
  financeBuyer: attr(
    'Selling to finance leaders',
    "Speaks the controller's and CFO's language: days to close, audit findings, team capacity and risk.",
    'How would you build a business case for a CFO who already has a close checklist tool?',
    'What objections do controllers raise about AI touching the books, and how do you answer them?',
  ),
  pipeline: attr(
    'Pipeline generation',
    'Has built pipeline from zero with a repeatable outbound motion and can show the numbers.',
    'How would you build your first 30 qualified opportunities here?',
    'Walk me through your best outbound sequence and the reply rate it got.',
  ),
  closing: attr(
    'Deal execution and forecasting',
    'Runs mutual action plans, multi-threads into finance and IT, and forecasts accurately.',
    'Walk me through your largest deal from first call to signature.',
    'Tell me about a deal you lost late. What would you do differently?',
  ),
  coachability: attr(
    'Coachability',
    'Asks for feedback, takes it without defensiveness, and visibly applies it within the same conversation.',
    'What is the most useful feedback you got in the last year, and what did you change?',
    'After the mock call: what would you do differently on a second try?',
  ),
  techDemo: attr(
    'Technical demo and discovery',
    "Tailors a demo to the buyer's ERP and close pain, and handles hard technical questions live.",
    'Show how our agent would reconcile a corporate card feed in NetSuite. What do you show first, and why?',
    'An IT lead asks exactly how we access their ERP data. How do you answer?',
  ),
  solutionDesign: attr(
    'Solution design and scoping',
    'Turns a messy customer environment into a clear, scoped plan with risks called out early.',
    'A prospect has three NetSuite subsidiaries and a homegrown billing system. How do you scope the rollout?',
    'How do you push back when sales has promised something the product does not do?',
  ),
  projectManagement: attr(
    'Implementation project management',
    'Runs multi-week rollouts with clear plans, owners and risks, and lands go-live on time.',
    'Lay out a 6-week implementation plan for a NetSuite customer with 3 subsidiaries.',
    "The customer's IT contact goes silent in week 3. What do you do?",
  ),
  customerTrust: attr(
    'Customer relationships and retention',
    'Builds trust with controllers, spots churn risk early, and drives adoption with evidence.',
    'How do you run a quarterly business review for a controller who is short on time?',
    'Usage drops 40% after the first close. What do you do?',
  ),
  closeProcess: attr(
    'Close process and controls',
    'Has run a fast, clean close with documented controls and clean audits.',
    'Walk me through how you would get a 15-day close down to 7 days.',
    'Which controls matter most at a 20-person company, and which are overkill?',
  ),
  technicalAccounting: attr(
    'Technical accounting (ASC 606, accruals, stock comp)',
    'Applies the standards to real startup transactions and documents positions an auditor would accept.',
    'How would you recognize revenue on an annual SaaS contract with a paid implementation fee?',
    'Walk me through how you would record stock-based compensation for a new option grant.',
  ),
  financeSystems: attr(
    'Finance systems (NetSuite, Sage Intacct, QBO)',
    'Knows the ERPs our customers run well enough to model their close and spot where the agent fits.',
    'What would you change first when moving a company from QuickBooks Online to NetSuite?',
    'How do intercompany eliminations work in Sage Intacct, and where do they go wrong?',
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

export const SAMPLE_ROLE_TEMPLATES: RoleTemplate[] = [
  {
    id: 'rt-fullstack',
    name: 'Senior full-stack engineer',
    familyId: 'f-eng',
    levelId: 'lv-l3',
    departmentId: 'd-eng',
    jdOutline: jd(
      [
        'Build the review workspace where controllers approve, edit or reject agent suggestions for reconciliations and accruals',
        'Own features end to end, from schema and APIs to fast, accessible interfaces for very large tables',
        'Make every number traceable back to its source transaction in NetSuite, Sage Intacct or QuickBooks Online',
        'Work directly with customers during month-end close to find and fix what slows them down',
      ],
      [
        '5+ years building production web applications, with strong TypeScript and SQL',
        'Comfort across the stack: React, Node or Python services, Postgres',
        'Care for correctness, testing and clear code in software people trust with their books',
        'Clear written communication with a small, fast team',
      ],
      ['Experience with accounting, fintech or ERP software', 'Built UIs for human review of model output', 'Worked under SOC 2 controls'],
    ),
    stages: stages(),
    interviewPlan: [
      step('rt-fullstack', 1, 'intro', 'Intro call', 30, [A.motivation, A.communication, A.ownership]),
      step('rt-fullstack', 2, 'technical', 'Pairing exercise: reconciliation review screen', 90, [A.codeQuality, A.frontend, A.communication]),
      step('rt-fullstack', 3, 'onsite', 'System design: close-agent job runner', 60, [A.systemDesign, A.securityMindset, A.dataModeling]),
      step('rt-fullstack', 4, 'onsite', 'Product and customer session', 45, [A.productSense, A.explainAgent, A.ownership]),
    ],
    emailTemplateIds: EMAILS,
  },
  {
    id: 'rt-ml-agents',
    name: 'ML engineer (agents)',
    familyId: 'f-ml',
    levelId: 'lv-l3',
    departmentId: 'd-eng',
    jdOutline: jd(
      [
        'Design and ship the agents that reconcile bank and card activity, suggest accruals and draft flux commentary',
        'Build tool use, retrieval over ledgers and contracts, guardrails and human-review checkpoints',
        'Run error analysis on real close data and turn it into measurable accuracy gains',
        'Decide when to improve prompts, retrieval or models, and prove it with evals',
      ],
      [
        '4+ years shipping ML or LLM systems to production',
        'Strong Python and a working knowledge of LLM APIs, embeddings and evaluation',
        'A habit of reading model outputs by hand and distrusting a single metric',
        'Interest in accounting and in software that must be right, not just plausible',
      ],
      ['Experience with financial or transactional data', 'Fine-tuning or distillation in production', 'Built agents that act inside third-party systems'],
    ),
    stages: stages(),
    interviewPlan: [
      step('rt-ml-agents', 1, 'intro', 'Intro call', 30, [A.motivation, A.communication, A.ownership]),
      step('rt-ml-agents', 2, 'technical', 'Agent design deep dive', 75, [A.agentSystems, A.llmEvals, A.mlFundamentals]),
      step('rt-ml-agents', 3, 'onsite', 'Error analysis exercise on sample matches', 75, [A.llmEvals, A.accountingJudgment, A.codeQuality]),
      step('rt-ml-agents', 4, 'onsite', 'Systems and safety session', 60, [A.systemDesign, A.securityMindset, A.explainAgent]),
    ],
    emailTemplateIds: EMAILS,
  },
  {
    id: 'rt-applied-ai-evals',
    name: 'Applied AI engineer (evals)',
    familyId: 'f-ml',
    levelId: 'lv-l3',
    departmentId: 'd-eng',
    jdOutline: jd(
      [
        'Own the eval suite that tells us whether a change makes the close agents better or worse',
        'Build labeled datasets from real reconciliations, accruals and flux explanations with our accounting team',
        'Run error analysis, find failure patterns, and turn them into fixes and regression tests',
        'Report quality in terms controllers care about: wrong matches, missed accruals, time saved',
      ],
      [
        '3+ years in applied ML, data science or ML engineering',
        'Strong Python and SQL; comfortable with statistics and sampling',
        'Hands-on experience evaluating LLM output, including model-graded and human-graded evals',
        'Patience for reading hundreds of examples and explaining what you found',
      ],
      ['Accounting or audit background', 'Built labeling workflows or annotation guidelines', 'Experience with tracing and observability tools for LLM apps'],
    ),
    stages: stages(),
    interviewPlan: [
      step('rt-applied-ai-evals', 1, 'intro', 'Intro call', 30, [A.motivation, A.communication, A.ownership]),
      step('rt-applied-ai-evals', 2, 'technical', 'Eval design exercise', 75, [A.llmEvals, A.mlFundamentals, A.dataModeling]),
      step('rt-applied-ai-evals', 3, 'onsite', 'Error analysis on real agent output', 75, [A.llmEvals, A.accountingJudgment, A.explainAgent]),
      step('rt-applied-ai-evals', 4, 'onsite', 'Working with the accounting team', 45, [A.communication, A.productSense, A.ownership]),
    ],
    emailTemplateIds: EMAILS,
  },
  {
    id: 'rt-data-erp',
    name: 'Data engineer (ERP connectors)',
    familyId: 'f-eng',
    levelId: 'lv-l3',
    departmentId: 'd-eng',
    jdOutline: jd(
      [
        'Build and run connectors for NetSuite (SuiteTalk and SuiteQL), Sage Intacct and QuickBooks Online',
        'Sync general ledger, subledger, bank and card data reliably, with safe reruns and clear lineage',
        'Model financial data so every agent suggestion traces back to source transactions',
        'Handle the real world: rate limits, custom fields, restated periods and multi-entity setups',
      ],
      [
        '4+ years in data or backend engineering with production pipelines',
        'Strong SQL and Python or TypeScript; experience with third-party APIs at scale',
        'Care for data quality, testing and observability',
        'Ability to work directly with customer IT and finance teams',
      ],
      ['Hands-on ERP integration experience', 'Accounting knowledge (double entry, subledgers, close)', 'Experience handling sensitive financial data under SOC 2'],
    ),
    stages: stages(),
    interviewPlan: [
      step('rt-data-erp', 1, 'intro', 'Intro call', 30, [A.motivation, A.communication, A.ownership]),
      step('rt-data-erp', 2, 'technical', 'Connector design exercise', 75, [A.erpIntegration, A.dataModeling, A.codeQuality]),
      step('rt-data-erp', 3, 'onsite', 'Pipeline and data model deep dive', 60, [A.dataModeling, A.systemDesign, A.securityMindset]),
      step('rt-data-erp', 4, 'onsite', 'Customer integration scenario', 45, [A.erpIntegration, A.accountingJudgment, A.communication]),
    ],
    emailTemplateIds: EMAILS,
  },
  {
    id: 'rt-security',
    name: 'Security and compliance engineer',
    familyId: 'f-eng',
    levelId: 'lv-l3',
    departmentId: 'd-eng',
    jdOutline: jd(
      [
        'Own our SOC 2 program and the evidence behind it, automating as much as possible',
        'Secure customer ERP credentials, financial data and the agents that touch them',
        'Answer security questionnaires and join calls with customer IT and audit teams',
        'Lead incident response and make the whole team better at security',
      ],
      [
        '4+ years in security engineering, infrastructure or compliance engineering',
        'Hands-on cloud security (identity, secrets, logging, network controls)',
        'Experience running or supporting a SOC 2 audit',
        'Clear writing for auditors, customers and engineers alike',
      ],
      ['Experience securing LLM applications', 'Background in financial services or fintech security', 'Scripting or infrastructure-as-code to automate controls'],
    ),
    stages: stages(),
    interviewPlan: [
      step('rt-security', 1, 'intro', 'Intro call', 30, [A.motivation, A.communication, A.ownership]),
      step('rt-security', 2, 'technical', 'Threat modeling exercise: agent with ERP access', 75, [A.securityMindset, A.systemDesign, A.communication]),
      step('rt-security', 3, 'onsite', 'SOC 2 and audit session', 60, [A.soc2, A.operationalRigor, A.communication]),
      step('rt-security', 4, 'onsite', 'Incident scenario', 45, [A.incident, A.securityMindset, A.ownership]),
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
        'Design how controllers and staff accountants review, trust and correct agent work during close',
        'Turn dense financial workflows (reconciliations, accruals, flux) into calm, fast interfaces',
        'Run research with finance teams and bring what you learn into every decision',
        'Build and grow a small, accessible design system with engineering',
      ],
      [
        '5+ years designing complex B2B or data-heavy products',
        'A portfolio that shows clear thinking about workflows, not just screens',
        'Strong interaction and visual craft, including accessibility',
        'Comfort working directly with customers and engineers every week',
      ],
      ['Design work for finance, accounting or ERP tools', 'Experience designing for AI suggestions and human review', 'Prototyping in code'],
    ),
    stages: stages(),
    interviewPlan: [
      step('rt-designer', 1, 'intro', 'Intro call', 30, [A.motivation, A.communication, A.ownership]),
      step('rt-designer', 2, 'technical', 'Portfolio review', 60, [A.designCraft, A.userResearch, A.communication]),
      step('rt-designer', 3, 'onsite', 'Design exercise: approving 2,000 suggested matches', 90, [A.designCraft, A.productSense, A.explainAgent]),
      step('rt-designer', 4, 'onsite', 'Working session with engineering', 45, [A.collaboration, A.frontend, A.ownership]),
    ],
    emailTemplateIds: EMAILS,
  },
  {
    id: 'rt-pm-close',
    name: 'Product manager (close and reconciliation)',
    familyId: 'f-product',
    levelId: 'lv-l4',
    departmentId: 'd-product',
    jdOutline: jd(
      [
        'Own the roadmap for our close and reconciliation agents, from bank recs to flux analysis',
        'Spend real time with controllers during close and turn what you see into clear priorities',
        'Define quality with the evals team in terms customers feel: accuracy, time saved, audit readiness',
        'Write crisp specs and make tradeoffs with design and engineering every week',
      ],
      [
        '5+ years of product management on B2B software',
        'Deep curiosity about accounting workflows; you can follow a reconciliation end to end',
        'Evidence of shipping products customers pay for and use',
        'Strong writing and the judgment to say no',
      ],
      ['Accounting, audit or FP&A background', 'Experience with AI or ML products', 'Familiarity with NetSuite, Sage Intacct or QuickBooks Online'],
    ),
    stages: stages(),
    interviewPlan: [
      step('rt-pm-close', 1, 'intro', 'Intro call', 30, [A.motivation, A.communication, A.ownership]),
      step('rt-pm-close', 2, 'technical', 'Product case: automated flux commentary', 60, [A.productSense, A.prioritization, A.customerDiscovery]),
      step('rt-pm-close', 3, 'onsite', 'Customer discovery role play with a controller', 45, [A.customerDiscovery, A.accountingJudgment, A.communication]),
      step('rt-pm-close', 4, 'onsite', 'Roadmap and tradeoffs with engineering', 60, [A.prioritization, A.collaboration, A.llmEvals]),
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
        'Sell our close and reconciliation agents to controllers and CFOs at mid-market companies',
        'Build pipeline from zero with the founder: outbound, partners, events and referrals',
        'Run full cycles from discovery to signature, including security and IT reviews',
        'Shape the sales playbook, pricing and the next sales hires',
      ],
      [
        '4+ years closing B2B SaaS, ideally selling to finance or accounting teams',
        'A track record of creating your own pipeline and hitting quota',
        'Comfort talking about close, reconciliations and audit with finance leaders',
        'Curiosity, coachability and a bias to action',
      ],
      ['Experience selling into NetSuite, Sage Intacct or QuickBooks Online customers', 'First sales hire experience', 'Accounting or audit background'],
    ),
    stages: stages('Mock discovery call'),
    interviewPlan: [
      step('rt-ae-founding', 1, 'intro', 'Intro call', 30, [A.motivation, A.communication, A.coachability]),
      step('rt-ae-founding', 2, 'technical', 'Mock discovery call with a controller', 45, [A.discovery, A.financeBuyer, A.coachability]),
      step('rt-ae-founding', 3, 'onsite', 'Deal review and pipeline plan', 60, [A.pipeline, A.closing, A.ownership]),
      step('rt-ae-founding', 4, 'onsite', 'CFO business case presentation', 45, [A.financeBuyer, A.communication, A.closing]),
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
        'Partner with sales to run discovery and tailored demos for controllers and their IT teams',
        "Show how our agents fit each prospect's ERP, chart of accounts and close process",
        'Lead security reviews and proof-of-concept projects on real customer data',
        'Bring field feedback to product and engineering every week',
      ],
      [
        '4+ years in solutions engineering, sales engineering or finance systems consulting',
        'Hands-on experience with at least one of NetSuite, Sage Intacct or QuickBooks Online',
        'Comfort with SQL, APIs and data mapping',
        'Strong presence on calls with both finance leaders and engineers',
      ],
      ['Big Four advisory or CPA background', 'Experience with AI or automation products', 'Built proof-of-concept environments'],
    ),
    stages: stages(),
    interviewPlan: [
      step('rt-solutions', 1, 'intro', 'Intro call', 30, [A.motivation, A.communication, A.ownership]),
      step('rt-solutions', 2, 'technical', 'Demo exercise: card reconciliation in NetSuite', 60, [A.techDemo, A.financeBuyer, A.explainAgent]),
      step('rt-solutions', 3, 'onsite', 'Solution design for a multi-entity prospect', 60, [A.solutionDesign, A.erpIntegration, A.accountingJudgment]),
      step('rt-solutions', 4, 'onsite', 'Security review role play', 45, [A.securityMindset, A.communication, A.techDemo]),
    ],
    emailTemplateIds: EMAILS,
  },
  {
    id: 'rt-implementation',
    name: 'Implementation lead',
    familyId: 'f-solutions',
    levelId: 'lv-l3',
    departmentId: 'd-gtm',
    jdOutline: jd(
      [
        'Lead new customers from signature to their first agent-assisted close',
        'Connect ERPs and bank feeds, map charts of accounts, and configure reconciliation rules',
        'Run clear project plans with customer finance and IT teams, and land go-live on time',
        'Turn every rollout into a better playbook and product feedback',
      ],
      [
        '4+ years implementing finance systems or leading B2B software rollouts',
        'Working knowledge of month-end close, reconciliations and accruals',
        'Hands-on experience with NetSuite, Sage Intacct or QuickBooks Online',
        'Organized, calm and direct with customers',
      ],
      ['CPA or audit experience', 'Data mapping with SQL or spreadsheets at scale', 'Experience at an early-stage company'],
    ),
    stages: stages(),
    interviewPlan: [
      step('rt-implementation', 1, 'intro', 'Intro call', 30, [A.motivation, A.communication, A.ownership]),
      step('rt-implementation', 2, 'technical', 'Implementation plan case', 60, [A.projectManagement, A.solutionDesign, A.financeSystems]),
      step('rt-implementation', 3, 'onsite', 'Chart of accounts mapping exercise', 60, [A.accountingJudgment, A.financeSystems, A.operationalRigor]),
      step('rt-implementation', 4, 'onsite', 'Difficult customer scenario', 45, [A.customerTrust, A.communication, A.projectManagement]),
    ],
    emailTemplateIds: EMAILS,
  },
  {
    id: 'rt-csm',
    name: 'Customer success manager',
    hint: 'CPA preferred',
    familyId: 'f-gtm',
    levelId: 'lv-l2',
    departmentId: 'd-gtm',
    jdOutline: jd(
      [
        'Own a book of controllers and finance teams after go-live, and help them get value every close',
        'Track adoption and outcomes: days to close, reconciliations automated, time saved',
        'Spot churn risk early and lead renewals and expansions with sales',
        'Bring sharp, accounting-literate feedback to product',
      ],
      [
        '3+ years in customer success, account management or accounting',
        'Strong accounting fundamentals; you can talk accruals and reconciliations with a controller',
        'Clear, warm communication and good follow-through',
        'Comfort with data to show customers their results',
      ],
      ['Active or inactive CPA license', 'Experience with NetSuite, Sage Intacct or QuickBooks Online', 'Worked at a Big Four or mid-size accounting firm'],
    ),
    stages: stages(),
    interviewPlan: [
      step('rt-csm', 1, 'intro', 'Intro call', 30, [A.motivation, A.communication, A.ownership]),
      step('rt-csm', 2, 'technical', 'Account review case', 45, [A.customerTrust, A.accountingJudgment, A.communication]),
      step('rt-csm', 3, 'onsite', 'Quarterly business review role play', 45, [A.customerTrust, A.explainAgent, A.financeBuyer]),
      step('rt-csm', 4, 'onsite', 'Churn risk scenario', 45, [A.ownership, A.operationalRigor, A.customerTrust]),
    ],
    emailTemplateIds: EMAILS,
  },
  {
    id: 'rt-accounting-lead',
    name: 'Accounting lead',
    hint: 'CPA',
    familyId: 'f-acct',
    levelId: 'lv-l4',
    departmentId: 'd-ops',
    jdOutline: jd(
      [
        "Run our own close, controls and audit readiness, as the company's first in-house accounting lead",
        'Be the domain expert for the product: review agent output, label eval data and define what correct means',
        'Handle revenue recognition, accruals, stock compensation and audit support',
        'Work with customers and prospects as a trusted accounting voice',
      ],
      [
        'Active CPA license and 6+ years in public accounting and industry',
        'Hands-on month-end close ownership, ideally at a SaaS company',
        'Strong technical accounting (ASC 606, ASC 718) and controls experience',
        'Interest in AI and in shaping a product for accountants',
      ],
      ['Big Four audit experience', 'Experience with NetSuite or Sage Intacct administration', 'SOX or SOC 2 controls work'],
    ),
    stages: stages(),
    interviewPlan: [
      step('rt-accounting-lead', 1, 'intro', 'Intro call', 30, [A.motivation, A.communication, A.ownership]),
      step('rt-accounting-lead', 2, 'technical', 'Technical accounting case', 75, [A.technicalAccounting, A.accountingJudgment, A.communication]),
      step('rt-accounting-lead', 3, 'onsite', 'Close and controls deep dive', 60, [A.closeProcess, A.financeSystems, A.operationalRigor]),
      step('rt-accounting-lead', 4, 'onsite', 'Review agent output with the ML team', 60, [A.explainAgent, A.llmEvals, A.accountingJudgment]),
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
        'Keep compliance on track with our PEO: notices, trainings, filings and deadlines',
        'Own recurring operations: vendors, office, equipment and the SOC 2 people controls',
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
      step('rt-ops-people', 4, 'onsite', 'Systems and SOC 2 people controls', 45, [A.operationalRigor, A.soc2, A.collaboration]),
    ],
    emailTemplateIds: EMAILS,
  },
]

/**
 * Names these templates had before posting qualifiers moved out of the name into `hint` (October 2026).
 * Workspaces saved before then (the sample, and a fresh start, which got this set until the starter set
 * existed) still carry them in settings.roleTemplates; src/store/db.ts migrate renames them on load with
 * upgradeRoleTemplateNames.
 */
export const RENAMED_ROLE_TEMPLATES: ReadonlyArray<{ from: string; name: string; hint: string }> = [
  { from: 'Customer success manager (CPA preferred)', name: 'Customer success manager', hint: 'CPA preferred' },
  { from: 'Accounting lead (CPA)', name: 'Accounting lead', hint: 'CPA' },
]

/**
 * Gives each template that still has an old default name, exactly, the current name and the qualifier as
 * its hint. A name the user changed, by as much as a space, stays as it is. So does a template that has a
 * hint: hints came with the rename (nothing in the app edits them), so a saved template with an old name
 * has none and a renamed one has one, which makes this happen once per template: one renamed back to the
 * old name by hand keeps it. Returns `templates` itself when nothing changes, so running it again is free.
 */
export function upgradeRoleTemplateNames(templates: RoleTemplate[]): RoleTemplate[] {
  let out: RoleTemplate[] | null = null
  templates.forEach((t, i) => {
    const rename = t && !t.hint ? RENAMED_ROLE_TEMPLATES.find((r) => r.from === t.name) : undefined
    if (!rename) return
    out ??= templates.slice()
    out[i] = { ...t, name: rename.name, hint: rename.hint }
  })
  return out ?? templates
}
