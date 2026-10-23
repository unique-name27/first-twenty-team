// Pools the sample hiring data draws from: fictional names, places with IANA time zones, and per-role
// profiles (titles, employers, resume highlights) plus scorecard notes. Every person is invented.
// Real big tech, fintech and accounting firm names appear only as employers. No protected
// characteristics and no pay history: candidates carry desired pay only.
// Module rule: functions only (no module-level runtime constants); see rng.ts.

export type ProfileKey = 'ml' | 'eng' | 'data' | 'sec' | 'design' | 'ae' | 'csm' | 'solutions' | 'acct' | 'ops' | 'coord' | 'em' | 'pm'

export type Profile = {
  titles: string[]
  companies: string[]
  summaries: string[]
  github: boolean
  portfolio?: boolean
}

export function firstNames(): string[] {
  return [
    'Aarav', 'Abena', 'Adaeze', 'Adrian', 'Ahmed', 'Aiko', 'Alejandro', 'Alina', 'Amara', 'Ana', 'Andre', 'Anika', 'Arjun',
    'Ayesha', 'Beatriz', 'Bilal', 'Brandon', 'Camila', 'Carlos', 'Chidi', 'Chloe', 'Connor', 'Dalia', 'Darius', 'Deepa',
    'Diego', 'Dmitri', 'Elif', 'Emeka', 'Emily', 'Esther', 'Fatima', 'Felipe', 'Gabriel', 'Gavin', 'Hana', 'Hassan',
    'Ibrahim', 'Ines', 'Irene', 'Ivan', 'Jae', 'Jamal', 'Javier', 'Jia', 'Joanna', 'Jordan', 'Julian', 'Kai', 'Kamala',
    'Karim', 'Kavya', 'Kelechi', 'Keiko', 'Kiran', 'Laila', 'Lauren', 'Lena', 'Liam', 'Lina', 'Lorenzo', 'Lucia', 'Mai',
    'Malik', 'Manuel', 'Mariam', 'Mateo', 'Maxine', 'Mihai', 'Min-jun', 'Mira', 'Nadia', 'Naomi', 'Nathan', 'Neha',
    'Nicolas', 'Nkechi', 'Noor', 'Olga', 'Oliver', 'Owen', 'Pablo', 'Paolo', 'Parisa', 'Pedro', 'Pooja', 'Rafael',
    'Rahul', 'Rana', 'Renee', 'Rohan', 'Rosa', 'Ruth', 'Sabrina', 'Salma', 'Sanjay', 'Sara', 'Sean', 'Sergio', 'Shreya',
    'Simone', 'Sina', 'Soo-ah', 'Stefan', 'Tamar', 'Tanvi', 'Teresa', 'Thanh', 'Tobias', 'Uchenna', 'Valentina', 'Vikram',
    'Wen', 'Xavier', 'Yara', 'Yasmin', 'Yusuf', 'Zainab', 'Zara', 'Zoe',
  ]
}

export function lastNames(): string[] {
  return [
    'Abubakar', 'Acheampong', 'Agarwal', 'Ahn', 'Alvarado', 'Amini', 'Anand', 'Andersen', 'Aziz', 'Banerjee', 'Barros',
    'Bauer', 'Becker', 'Bhatt', 'Brennan', 'Campos', 'Castillo', 'Chandra', 'Chaudhry', 'Chen', 'Cho', 'Costa', 'Cruz',
    'Das', 'Delgado', 'Diallo', 'Dimitrov', 'Dubois', 'Duarte', 'Eze', 'Farah', 'Fernandes', 'Fischer', 'Fitzgerald',
    'Flores', 'Fujita', 'Gallagher', 'Garcia', 'Ghosh', 'Gonzalez', 'Gupta', 'Haddadi', 'Hakimi', 'Hansen', 'Hassan',
    'Hoang', 'Hughes', 'Ibarra', 'Iyer', 'Jansen', 'Jimenez', 'Joshi', 'Kang', 'Kapoor', 'Kaur', 'Kowalski', 'Kumar',
    'Larsen', 'Le', 'Leung', 'Lim', 'Lin', 'Liu', 'Lopez', 'Mahmoud', 'Malhotra', 'Martins', 'Mehta', 'Mendoza',
    'Menon', 'Molina', 'Mukherjee', 'Murphy', 'Nakagawa', 'Navarro', 'Ndlovu', 'Nguyen', 'Novak', 'Nwosu', 'Obi',
    'Oh', 'Olsen', 'Ortiz', 'Owusu', 'Pacheco', 'Patel', 'Pereira', 'Petrov', 'Pham', 'Quintero', 'Rahman', 'Ramos',
    'Reddy', 'Richter', 'Rivera', 'Rojas', 'Romero', 'Saito', 'Salazar', 'Santos', 'Schmidt', 'Sato', 'Sen', 'Serrano',
    'Shah', 'Shapiro', 'Silva', 'Singh', 'Soto', 'Srinivasan', 'Sullivan', 'Suzuki', 'Tan', 'Tran', 'Turner', 'Vargas',
    'Vu', 'Walsh', 'Wang', 'Weber', 'Wu', 'Yamamoto', 'Yang', 'Yilmaz', 'Yoon', 'Zhang', 'Zhou',
  ]
}

/** Full names the generator must never produce (employees, contractors and hand-written candidates). */
export function reservedNames(): string[] {
  return [
    'Maya Raman', 'Tomas Herrera', 'Priya Nair', 'Elena Vasquez', 'Kofi Boateng', 'Sofia Rossi', 'Caleb Washington',
    'Hannah Kim', 'Nikhil Rao', 'Omar Haddad', 'Jasmine Torres', 'Chris Nakamura', 'Luis Ortega', 'Ravi Subramanian',
    'Aisha Bello', 'Lucas Ferreira', 'Mei Tanaka', 'Daniel Reyes', 'Dana Whitaker', 'Marisol Vega', 'Carol Whitfield',
    'Daniel Osei',
  ]
}

/** [location, IANA time zone]. Bay Area first (most applicants), then the rest of California, then elsewhere. */
export function bayAreaPlaces(): Array<[string, string]> {
  const la = 'America/Los_Angeles'
  return [
    ['San Jose, CA', la], ['Sunnyvale, CA', la], ['Santa Clara, CA', la], ['Mountain View, CA', la], ['Palo Alto, CA', la],
    ['Fremont, CA', la], ['Oakland, CA', la], ['San Francisco, CA', la], ['Berkeley, CA', la], ['Milpitas, CA', la],
    ['Cupertino, CA', la], ['Redwood City, CA', la], ['San Mateo, CA', la], ['Campbell, CA', la], ['Los Gatos, CA', la],
    ['Hayward, CA', la], ['Pleasanton, CA', la], ['Menlo Park, CA', la], ['Walnut Creek, CA', la], ['Santa Cruz, CA', la],
  ]
}

export function otherCaliforniaPlaces(): Array<[string, string]> {
  const la = 'America/Los_Angeles'
  return [['Los Angeles, CA', la], ['San Diego, CA', la], ['Sacramento, CA', la], ['Irvine, CA', la]]
}

export function outOfStatePlaces(): Array<[string, string]> {
  return [
    ['Seattle, WA', 'America/Los_Angeles'],
    ['Portland, OR', 'America/Los_Angeles'],
    ['Austin, TX', 'America/Chicago'],
    ['Denver, CO', 'America/Denver'],
    ['New York, NY', 'America/New_York'],
    ['Boston, MA', 'America/New_York'],
    ['Chicago, IL', 'America/Chicago'],
    ['Atlanta, GA', 'America/New_York'],
    ['Phoenix, AZ', 'America/Phoenix'],
    ['Toronto, ON, Canada', 'America/Toronto'],
  ]
}

function bigTech(): string[] {
  return ['Google', 'Meta', 'Apple', 'Amazon', 'Microsoft', 'NVIDIA', 'Salesforce', 'LinkedIn', 'Uber', 'Airbnb', 'Adobe', 'Cisco']
}

function fintechNames(): string[] {
  return ['Intuit', 'Stripe', 'Plaid', 'Brex', 'Ramp', 'Block', 'PayPal', 'Chime', 'Affirm', 'SoFi', 'Robinhood', 'Gusto', 'Rippling', 'Carta', 'Navan']
}

function smallStartups(): string[] {
  return ['Tallyforge', 'Quarry Analytics', 'Bluefin Pay', 'Northbeam Labs', 'Corvid Data', 'Paperkite', 'Halyard Health', 'Mosswood AI', 'Fernway Logistics', 'Kestrel Robotics']
}

export function profile(key: ProfileKey): Profile {
  switch (key) {
    case 'ml':
      return {
        titles: ['Senior ML engineer', 'Machine learning engineer', 'Staff ML engineer', 'Applied scientist', 'AI engineer', 'Senior applied scientist', 'Research engineer'],
        companies: [...bigTech().slice(0, 6), 'Intuit', 'Stripe', 'Plaid', 'Brex', 'Ramp', 'Databricks', 'Snowflake', ...smallStartups().slice(0, 5)],
        summaries: [
          'Built the LLM pipeline that extracts line items from vendor invoices; owns the eval set and the weekly error review.',
          'Shipped transaction categorization models used by small-business bookkeepers; moved the team from one accuracy number to per-category error buckets.',
          'Led retrieval and tool use for an internal support agent; added human review checkpoints before any write action.',
          'Fraud and risk models for card payments; strong on offline evaluation and careful experiment design.',
          'Fine-tuned and distilled extraction models for bank statements; cut inference cost by half without losing recall.',
          'Built labeling guidelines and a model-graded eval harness for a document QA product.',
          'Recommendation and ranking background; recently moved to LLM agents and wants a domain where correctness matters.',
          'Owns evals for a coding assistant; reads hundreds of traces a week and writes up failure patterns for the team.',
          'Built a reconciliation matcher for marketplace payouts using embeddings plus rules, with an audit trail per match.',
          'PhD in NLP, two years shipping LLM features in production; interested in agents that act inside ERPs.',
          'Forecasting and anomaly detection for cash flow; comfortable explaining model output to finance teams.',
          'Built guardrails and red-team suites for an AI assistant handling customer financial data.',
        ],
        github: true,
      }
    case 'eng':
      return {
        titles: ['Senior software engineer', 'Full-stack engineer', 'Software engineer II', 'Senior frontend engineer', 'Staff software engineer', 'Founding engineer', 'Senior backend engineer'],
        companies: [...bigTech(), ...fintechNames(), 'Expensify', 'BILL', ...smallStartups()],
        summaries: [
          'Built the review queue UI for a payments operations team: virtualized tables with 50,000 rows, keyboard-first.',
          'Full-stack TypeScript and Postgres; owned the invoice approval workflow end to end at a spend management company.',
          'Led the migration of a ledger service to double-entry with idempotent writes and replayable events.',
          'React and Node; shipped an accessible data grid used by internal finance teams every close.',
          'Backend in Python and Go; built webhooks and sync jobs for third-party accounting APIs.',
          'Early engineer at a seed-stage startup; wore many hats from infra to customer calls.',
          'Built audit logs and permission models for a B2B product sold to banks; comfortable under SOC 2.',
          'Frontend lead on a design system; cares about loading, empty and error states.',
          'Rebuilt a reporting pipeline so every number in the dashboard links back to source rows.',
          'Built QuickBooks Online and Xero integrations for a payroll product; knows OAuth refresh pain well.',
          'Strong in SQL performance; cut month-end report times from minutes to seconds.',
          'Mobile and web; wants to move closer to data-heavy B2B tools.',
        ],
        github: true,
      }
    case 'data':
      return {
        titles: ['Senior data engineer', 'Data engineer', 'Analytics engineer', 'Senior backend engineer', 'Data platform engineer'],
        companies: ['Intuit', 'Stripe', 'Snowflake', 'Databricks', 'Brex', 'Ramp', 'BILL', 'Oracle NetSuite', 'Workday', 'Uber', 'Airbnb', ...smallStartups().slice(0, 4)],
        summaries: [
          'Built NetSuite SuiteQL and REST connectors with safe reruns and per-record lineage.',
          'Owned the Sage Intacct and QuickBooks Online syncs for a FP&A product; handled custom dimensions and restated periods.',
          'Ran the ledger data platform: dbt, Airflow and Postgres, with tests on every financial model.',
          'Streaming payments data at scale; strong on idempotency and late-arriving events.',
          'Built a multi-entity consolidation model for a finance analytics startup.',
        ],
        github: true,
      }
    case 'sec':
      return {
        titles: ['Security engineer', 'Senior security engineer', 'Cloud security engineer', 'GRC engineer', 'Infrastructure engineer'],
        companies: ['Google', 'Okta', 'Cloudflare', 'Stripe', 'Plaid', 'Coinbase', 'Brex', 'Snowflake', ...smallStartups().slice(2, 6)],
        summaries: [
          'Ran two SOC 2 Type II audits at a fintech startup and automated most evidence collection.',
          'Cloud security for a payments company: identity, secrets, logging and incident response.',
          'Built the vendor security review program and answered 200+ customer questionnaires.',
          'Security engineer with an infrastructure-as-code background; led an incident response for a credential leak.',
        ],
        github: true,
      }
    case 'design':
      return {
        titles: ['Senior product designer', 'Product designer', 'Staff product designer', 'UX designer'],
        companies: ['Intuit', 'Gusto', 'Brex', 'Ramp', 'Rippling', 'Carta', 'Stripe', 'Airbnb', 'Adobe', ...smallStartups().slice(0, 4)],
        summaries: [
          'Designed the expense review flow at a spend management company; portfolio shows real workflow research.',
          'B2B designer focused on dense data tables and approval flows for finance teams.',
          'Led design for an AI writing feature, including how users accept, edit or reject suggestions.',
          'Built a small accessible design system with engineering at a seed-stage startup.',
        ],
        github: false,
        portfolio: true,
      }
    case 'ae':
      return {
        titles: ['Account executive', 'Senior account executive', 'Mid-market account executive', 'Enterprise account executive', 'Sales development lead'],
        companies: ['BILL', 'Brex', 'Ramp', 'Navan', 'Gusto', 'Rippling', 'FloQast', 'BlackLine', 'Expensify', 'Tipalti', 'Oracle NetSuite', 'Sage', 'Carta', ...smallStartups().slice(4, 8)],
        summaries: [
          'Sold close management software to controllers at 200 to 2,000 employee companies; 118% of quota last year.',
          'Mid-market AE selling AP automation to finance teams on NetSuite and Sage Intacct.',
          'First sales hire at a seed-stage fintech; built the pipeline from outbound and partner referrals.',
          'Sells spend management to CFOs; strong at multi-threading into IT and procurement.',
          'Former staff accountant turned AE; speaks the controller language and runs crisp discovery.',
          'Closed six-figure deals selling FP&A software; careful forecaster.',
          'SDR to AE in two years; top of the leaderboard on new logos three quarters running.',
          'Sold payroll and HR software to mid-market companies; wants to sell an AI product to finance.',
        ],
        github: false,
      }
    case 'csm':
      return {
        titles: ['Customer success manager', 'Senior customer success manager', 'Account manager', 'Implementation consultant'],
        companies: ['FloQast', 'BlackLine', 'BILL', 'Gusto', 'Intuit', 'Sage', 'Oracle NetSuite', 'Deloitte', 'Moss Adams', ...smallStartups().slice(5, 8)],
        summaries: [
          'CPA (inactive) running a book of 40 mid-market finance teams; strong renewals and expansion.',
          'Former senior auditor turned customer success; great at QBRs with controllers.',
          'Owned adoption for a close management product; built health scores from usage data.',
        ],
        github: false,
      }
    case 'solutions':
      return {
        titles: ['Solutions engineer', 'Sales engineer', 'Senior solutions consultant', 'Forward deployed engineer', 'Implementation lead'],
        companies: ['Oracle NetSuite', 'Sage', 'BlackLine', 'FloQast', 'Deloitte', 'PwC', 'EY', 'Armanino', 'BILL', 'Stripe', ...smallStartups().slice(0, 3)],
        summaries: [
          'Former Big Four advisory consultant; runs NetSuite demos and security reviews with finance and IT.',
          'Sales engineer for an AP automation product; builds proof-of-concept environments on real customer data.',
          'Implementation lead for multi-entity Sage Intacct rollouts; strong SQL and data mapping.',
          'Forward deployed engineer who scoped and shipped integrations directly with customer finance teams.',
        ],
        github: false,
      }
    case 'acct':
      return {
        titles: ['Senior accountant', 'Accounting manager', 'Audit senior', 'Assurance manager', 'Assistant controller', 'Technical accounting manager', 'Senior financial systems analyst'],
        companies: ['Deloitte', 'PwC', 'EY', 'KPMG', 'Grant Thornton', 'BDO', 'Moss Adams', 'Armanino', 'Intuit', 'Gusto', 'BlackLine', 'FloQast', ...smallStartups().slice(3, 7)],
        summaries: [
          'CPA, five years in Big Four assurance auditing SaaS companies, then assistant controller at a Series B startup.',
          'Runs a 6-day close on NetSuite for a 300-person company; owns the bank and card reconciliations.',
          'CPA with ASC 606 depth from technical accounting at a public software company.',
          'Audit manager at a mid-size firm; led SOC 1 and financial statement audits for fintech clients.',
          'Implemented Sage Intacct for a multi-entity nonprofit and built its close checklist.',
          'Senior accountant who automated accrual schedules and flux commentary with spreadsheets and scripts.',
          'CPA candidate (two sections passed); strong on reconciliations and AP.',
          'Former controller at a small manufacturer; wants to help build software for accountants.',
          'Revenue accountant at a fintech; owns the contract review and billing reconciliation.',
          'Financial systems analyst who administers NetSuite and writes saved searches for the close team.',
        ],
        github: false,
      }
    case 'ops':
      return {
        titles: ['People operations manager', 'HR generalist', 'Business operations lead', 'Finance and HR manager', 'People partner'],
        companies: ['Gusto', 'Rippling', 'Justworks', 'Carta', 'Stripe', ...smallStartups().slice(0, 5)],
        summaries: [
          'People operations generalist at a 60-person startup on a PEO; ran onboarding, leave and compliance calendars.',
          'Finance and HR manager for a seed-stage company; payroll, benefits renewals and the first handbook.',
          'Business operations lead who built the SOC 2 people controls and access reviews.',
        ],
        github: false,
      }
    case 'coord':
      return {
        titles: ['Office coordinator', 'Front desk coordinator', 'Events coordinator', 'Administrative assistant', 'Community coordinator'],
        companies: ['San Jose State University', 'Hilton', 'A local coworking space', 'A dental practice', 'A nonprofit theater', ...smallStartups().slice(6, 9)],
        summaries: [
          'Coordinates events and vendor bookings for a coworking space; organized and calm under pressure.',
          'Front desk and office supplies for a 40-person office; wants part-time hours while finishing a degree.',
          'Event planning for a university department; strong scheduling and budget tracking.',
        ],
        github: false,
      }
    case 'em':
      return {
        titles: ['Engineering manager', 'Senior engineering manager', 'Tech lead manager', 'Staff engineer'],
        companies: ['Stripe', 'Brex', 'Plaid', 'Intuit', 'Google', 'Rippling', ...smallStartups().slice(0, 3)],
        summaries: [
          'Manages a platform team of six; grew two engineers into tech leads.',
          'Tech lead manager for a payments infrastructure team; still writes code weekly.',
          'Engineering manager who led a SOC 2 readiness project and an on-call rebuild.',
        ],
        github: true,
      }
    case 'pm':
      return {
        titles: ['Senior product manager', 'Product manager', 'Group product manager'],
        companies: ['Intuit', 'BILL', 'FloQast', 'BlackLine', 'Ramp', 'Brex', 'Stripe', ...smallStartups().slice(0, 3)],
        summaries: ['Product manager for a close management product; former auditor.', 'PM for AI features in an accounting product.'],
        github: false,
      }
  }
}

/** Sources by board or channel, per role group. */
export function inboundBoards(key: ProfileKey): string[] {
  switch (key) {
    case 'ae':
      return ['LinkedIn', 'Careers page', 'RepVue', 'Wellfound']
    case 'acct':
    case 'csm':
      return ['LinkedIn', 'Careers page', 'CalCPA job board', 'Indeed']
    case 'coord':
    case 'ops':
      return ['Indeed', 'LinkedIn', 'Careers page']
    default:
      return ['Careers page', 'LinkedIn', 'Wellfound', 'Hacker News jobs thread', 'Built In SF']
  }
}

export function outboundChannels(): string[] {
  return ['LinkedIn Recruiter', 'GitHub', 'Conference contact', 'Former colleague of the team']
}

/** Scorecard notes by role group and direction (positive for Yes or Strong yes, negative for No or Strong no). */
export function scoreNotes(key: ProfileKey, positive: boolean): string[] {
  const generic = positive
    ? [
        'Clear, specific examples. Motivated by the close problem, not just by AI.',
        'Asked sharp questions about how controllers use the product today.',
        'Owns outcomes; told a good story about recovering a project that slipped.',
      ]
    : ['Answers stayed general; hard to find evidence of ownership.', 'Mostly interested in a different kind of role than this one.']
  const by: Partial<Record<ProfileKey, [string[], string[]]>> = {
    ml: [
      [
        'Built a small hand-labeled eval set before reaching for metrics. Good instincts on failure buckets.',
        'Knew when to stop prompting and add retrieval; clear about where a human must review before posting.',
        'Strong error analysis: grouped wrong matches by cause and proposed a fix for each.',
        'Explained the accrual suggestion in terms a controller would accept, with the source documents.',
      ],
      [
        'Leaned on a single accuracy number and did not look at examples.',
        'Agent design had no review step before writes; did not see the risk when prompted.',
        'Solid modeling background but little hands-on LLM work.',
      ],
    ],
    eng: [
      [
        'Strong pairing: wrote tests first and kept the review table fast at 10,000 rows.',
        'Clean design for the job runner with sensible retries and idempotent reruns.',
        'Traced every number back to source rows without being asked. Would trust them with customer books.',
        'Thoughtful about loading, empty and error states; good accessibility instincts.',
      ],
      [
        'Struggled to break the job runner into parts; needed heavy prompting.',
        'Code worked but was hard to follow, and there were no tests.',
        'Design skipped partial failures and reruns entirely.',
      ],
    ],
    data: [
      [
        'Handled NetSuite rate limits and safe reruns well; clear lineage story.',
        'Modeled restated periods cleanly. Good questions about multi-entity setups.',
      ],
      ['Pipeline design had no plan for late-arriving or restated data.'],
    ],
    sec: [
      ['Threat model covered ERP credentials and agent write access well.', 'Has run a SOC 2 audit end to end; practical about evidence automation.'],
      ['Strong on tools, thin on explaining risk to auditors and customers.'],
    ],
    design: [
      ['Portfolio shows real workflow thinking for dense tables, not just screens.', 'Exercise handled bulk approval of 2,000 matches with a clear undo story.'],
      ['Visual craft is strong but the exercise ignored how a reviewer would verify suggestions.'],
    ],
    ae: [
      [
        'Crisp discovery: quantified close days and found the economic buyer.',
        'Took coaching mid-call and visibly adjusted on the second try.',
        'Credible with a controller persona; talked reconciliations without notes.',
      ],
      ['Pitched features before understanding the close process.', 'Pipeline plan relied entirely on inbound leads.'],
    ],
    csm: [
      ['Ran a tight QBR with real usage numbers; spotted the churn risk early.'],
      ['Warm with customers but vague on how they would measure adoption.'],
    ],
    solutions: [
      ['Demo was tailored to a NetSuite card feed; handled the IT questions live.', 'Scoped a three-subsidiary rollout with risks called out up front.'],
      ['Demo was a feature tour; struggled with data access questions.'],
    ],
    acct: [
      [
        'Walked a bank rec variance to root cause in minutes; knows ASC 606 well.',
        'Strong close and controls instincts; would be a credible voice with customers.',
        'Reviewed sample agent output and caught two wrong matches the model missed.',
      ],
      ['Thin on accruals; experience is mostly AP.', 'Good auditor instincts but little interest in the product side.'],
    ],
    ops: [
      ['Knows California onboarding basics cold; organized and discreet.', 'Built a compliance calendar from scratch at a PEO-based startup.'],
      ['Process ideas were solid but light on California specifics.'],
    ],
    coord: [
      ['Organized and friendly; the scheduling exercise was quick and accurate.'],
      ['Looking for full-time hours we cannot offer.'],
    ],
    em: [['Grew engineers into leads and still reviews code; credible with the team.'], ['Has not managed through a hiring ramp yet.']],
  }
  const pair = by[key]
  return [...(pair ? pair[positive ? 0 : 1] : []), ...generic]
}
