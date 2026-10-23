# Sample company: Ledgerlark, Inc. (fictional)

The story bible for the sample data. Every name, company and investor here is invented. Numbers are
grounded in `docs/BENCHMARKS.md` (2026 Bay Area pay-transparency postings, Carta, Gem, Ashby) and
legal facts in `docs/LAW.md`. The sample is anchored to **Friday, October 9, 2026** (`SAMPLE_ANCHOR`);
the store shifts every date so "today" in the story is always today.

## Company

- **Ledgerlark, Inc.**, Delaware C corporation, HQ 99 S Almaden Blvd, Suite 410, San Jose, CA 95113.
  Hybrid: office days Tuesday to Thursday. Website ledgerlark.com (fictional).
- Builds AI "close agents" for mid-market controllers on NetSuite, Sage Intacct and QuickBooks Online:
  bank and card reconciliation, accrual suggestions, flux analysis, audit-ready workpapers.
- Founded **2025-02-03** by **Maya Raman** (solo founder, CEO; formerly an ML lead on a small-business
  accounting product and, before that, a Big Four audit senior).
- Funding: pre-seed **$3.0M** SAFE closed 2025-04-15 (lead: Almaden Peak Ventures, fictional);
  seed **$14M** priced round closed **2026-02-24**, post-money $70M, preferred price **$5.83/share**
  (lead: Coyote Valley Capital, fictional). About 14 paying customers, annual revenue about $1.1M
  (far below the CCPA threshold).
- Cap table (fully diluted 12,000,000): founder 7,000,000 common; pre-seed conversion 900,000;
  seed 2,400,000; option pool 1,700,000 (1,200,000 created 2025-04-20, +500,000 at the seed 2026-02-24).
- 409A history: **$0.25** effective 2025-05-01 (provider: fictional "Meridian Valuation Group"),
  **$1.15** effective 2026-03-20 after the seed, expires 2027-03-20. (Grants before 2026-03-20 used $0.25.)
- Payroll and benefits through a PEO (generic name "Your PEO" with a placeholder URL; the app reads that name as
  a placeholder, so sentences say "your PEO"): semi-monthly payroll on the 15th and the last day (the business
  day before when either is a weekend or holiday; run payroll 2 business days ahead), medical covered 90% for employees and 50% for dependents, 401(k) through the PEO since
  2026-01-01 with no match (CalSavers exemption filed). Benefits cost about $1,150 per head per month;
  other per-head costs (software, equipment, stipend) about $375 per month.
- SOC 2 Type I report completed 2026-07-15; Type II observation window 2026-08-01 to 2027-01-31 (soc2Enabled true).
- Cash on hand $13.4M as of 2026-10-01; other non-payroll spend about $110K a month (cloud and model inference, office, audit, tools); revenue about $92K a month.
- Workers' comp carrier: fictional 'Golden Poppy Mutual'. EDD employer account registered 2025-05-14 (first payroll 2025-05-15 when Tomas started). 25102(o) notice filed 2025-06-10 (first grant 2025-05-28).
- Advisors (NSO, 2-year monthly vesting, no cliff): `k-adv-whitfield` Carol Whitfield (former public-company CFO), 24,000 NSOs at $0.25 from 2025-07-01; `k-adv-osei` Dr. Daniel Osei (AI researcher), 24,000 NSOs at $1.15 from 2026-04-01.
- Time off: vacation accrues 15 days a year (cap 22.5 days, paid out at exit); CA sick leave 40 hours
  front-loaded each January 1 and at hire (usable from day 90); bereavement and reproductive loss leave;
  11 company holidays in 2026 (see `defaultHolidays`).

## Departments and managers

| Department | Head |
|---|---|
| Executive | Maya Raman |
| Engineering | Tomas Herrera |
| Applied AI | Priya Nair |
| Product and design | Maya Raman (until the PM hire) |
| Go to market | Caleb Washington |
| Accounting | Elena Vasquez |
| Operations | Jasmine Torres |

Reporting: Maya manages Tomas, Priya, Elena, Sofia, Caleb, Jasmine, Aisha. Tomas manages Kofi, Nikhil,
Ravi and (incoming) Lucas. Priya manages Hannah and (incoming) Mei. Elena manages Chris. Jasmine manages Luis.
Non-founder supervisors: Tomas, Priya, Elena, Jasmine (they need the 2-hour harassment course).

## Roster (hire number, id, name, title, level, start, base, equity)

Ids are fixed so docs, tests and links stay stable. "Market adj." = post-seed market adjustment on 2026-03-01.

1. `p-founder` Maya Raman, Founder and CEO, X1 Executive, 2025-02-03. $120,000, then $175,000 (market adj.).
   Founder stock outside the pool (no grant row). Exempt (executive). Lives in San Jose.
2. `p-tomas` Tomas Herrera, Founding engineer, L4 Staff (Software engineering), 2025-05-12. $185,000, then $212,000.
   150,000 ISOs at $0.25 (board approved 2025-05-28), vesting from start. Lives in San Jose. Network hire (former colleague).
3. `p-priya` Priya Nair, Founding ML engineer, L4 Staff (Machine learning), 2025-06-09. $195,000, then $228,000.
   102,000 ISOs at $0.25. Lives in Sunnyvale. Referral from an angel investor.
4. `p-elena` Elena Vasquez, Head of accounting (CPA), M1 Manager (Accounting), 2025-08-18. $182,000, then $200,000.
   60,000 ISOs at $0.25. Lives in Campbell. Former Big Four audit manager, then controller.
5. `p-kofi` Kofi Boateng, Senior software engineer, L3 Senior (Software engineering), 2025-10-06. $178,000, then $192,000.
   52,000 ISOs at $0.25. Lives in San Jose. Inbound (careers page). **Crossed 5 employees on 2025-10-06.**
6. `p-sofia` Sofia Rossi, Product designer, L3 Senior (Product and design), 2026-01-12. $172,000.
   40,000 ISOs at $0.25 (approved 2026-01-22). Remote in Oakland, CA. Sourced.
7. `p-caleb` Caleb Washington, Founding account executive, L3 Senior (Sales and customer success), 2026-03-02.
   $140,000 base, variable 100% of base (OTE $280,000). 30,000 ISOs at $1.15 (approved 2026-03-26).
   **Remote in Austin, Texas** (Texas payroll registration). Agency hire (20% fee).
8. `p-hannah` Hannah Kim, Applied AI engineer (evals), L3 Senior (Machine learning), 2026-03-16. $205,000.
   40,000 ISOs at $1.15. Lives in Santa Clara. Referral from Priya ($5,000 referral bonus, paid 2026-06-14).
9. `p-nikhil` Nikhil Rao, Security and compliance engineer, L3 Senior (Software engineering), 2026-04-13. $200,000.
   35,000 ISOs at $1.15. Lives in Fremont. Sourced. Owns SOC 2. **Merit raise to $214,000 effective Wed
   2026-10-21** (recorded Oct 2, payroll updated Oct 7), so his Oct 16-31 check splits at the change.
10. `p-omar` Omar Haddad, Data engineer, L3 Senior (Software engineering), 2026-05-04. $188,000. 30,000 ISOs at $1.15.
    **Resigned**: notice given 2026-08-14, last day 2026-08-28 (voluntary, gave 72+ hours notice, reason
    "Joined a later-stage company", rehire eligible). Left before the cliff, so all 30,000 options returned to
    the pool. Final pay issued on his last day with accrued vacation. Offboarding checklist complete.
11. `p-jasmine` Jasmine Torres, Finance and people operations lead, L3 Senior (People and operations), 2026-06-01.
    $150,000. 20,000 ISOs at $1.15. Lives in San Jose. The day-to-day admin user of this app.
12. `p-chris` Chris Nakamura, Solutions engineer, L3 Senior (Solutions and implementation), 2026-07-13.
    $168,000 plus 15% variable. 18,000 ISOs at $1.15. Lives in Milpitas. Former Big Four advisory.
13. `p-luis` Luis Ortega, Office and events coordinator, L1 Associate (People and operations), 2026-07-20.
    **Part time, 24 hours a week, non-exempt, $30.00/hour** (above San Jose's $18.45). No equity.
    Onsite in San Jose. Shows the non-exempt rules: wage notice (Labor Code 2810.5), meal and rest breaks,
    sick leave accrual. **Resigned with notice**: gave notice Thu 2026-10-08, last day Tue 2026-11-10 (going back to
    school full time, rehire eligible). Final pay is due on his last day (Labor Code 202), before the Fri Nov 13
    payday, and his accrued vacation is paid out (227.3). Offboarding checklist `ck-off-luis`.
14. `p-ravi` Ravi Subramanian, Staff software engineer, L4 Staff (Software engineering), 2026-08-10. $235,000.
    45,000 ISOs at $1.15 (approved 2026-08-27). Lives in Cupertino. Sourced.
15. `p-aisha` Aisha Bello, Customer success manager (CPA), L2 Mid-level (Sales and customer success), 2026-09-08.
    $140,000 plus 10% variable. 12,000 ISOs **promised**, waiting for the next board consent. Lives in San Jose.

Employed on 2026-10-09: **14** (all except Omar). Incoming:

16. `p-lucas` Lucas Ferreira, Senior data engineer (backfill for Omar), L3 Senior (Software engineering),
    starts **Monday 2026-10-19**. $195,000 and a **$10,000 sign-on bonus** with his first check. 30,000 ISOs promised. Offer accepted 2026-09-30; background check
    clear 2026-10-06. Onboarding checklist created; pre-start tasks partly done. **His start takes Ledgerlark to 15**,
    which turns on pay scales in every job posting (SB 1162 / SB 642) and federal Title VII/ADA counting.
17. `p-mei` Mei Tanaka, Senior ML engineer (agents), L3 Senior (Machine learning), starts **Monday 2026-11-02**.
    $228,000. 38,000 ISOs promised. Offer accepted 2026-10-07. H-1B transfer (already in the U.S. in valid
    H-1B status, so the September 2025 $100,000 payment does not apply); can start once the petition is filed.

## Plan to 20

| Quarter | Role | Status |
|---|---|---|
| 2026-Q3 | Solutions engineer | filled (Chris) |
| 2026-Q3 | Staff software engineer | filled (Ravi) |
| 2026-Q3 | Customer success manager | filled (Aisha) |
| 2026-Q3 | Senior data engineer (backfill) | filled (Lucas, starts Oct 19) |
| 2026-Q4 | Senior ML engineer, agents | filled (Mei, starts Nov 2) |
| 2026-Q4 | Staff ML engineer, agents and evals | open (job J1) |
| 2026-Q4 | Senior full-stack engineer | open (job J2) |
| 2026-Q4 | Solutions accountant (CPA) | open (job J4) |
| 2027-Q1 | Account executive, mid-market | open early (job J3) |
| 2027-Q2 | Product manager, close and reconciliation | planned (job J5 is a draft with no pay range yet) |
| 2027-Q2 | Engineering manager, platform | planned (job J6 on hold) |

16 after Mei starts, 19 when the three Q4 roles fill, 20 with the Q1 account executive.

## Open jobs and pipelines (ids j-...)

- `j-staff-ml` Staff ML engineer, agents and evals. Machine learning L4, $225,000-$285,000, 0.25%-0.60%.
  HM Priya. Opened 2026-08-24, high priority, no sponsorship for new petitions (transfers OK). About 45 candidates:
  most rejected or withdrawn; active: 6 new, 4 intro call, 3 technical, 2 onsite next week, and 1 offer
  **pending approval** (Daniel Reyes, $262,000, 50,000 options).
- `j-fullstack` Senior full-stack engineer. Software engineering L3, $180,000-$235,000. HM Tomas. Opened 2026-09-14.
  About 40 candidates; active: 12 new (3 of them sourced/outbound), 4 intro call, 2 technical, 1 onsite.
- `j-ae` Account executive, mid-market. Sales L3, $130,000-$160,000 base, OTE 2x base. HM Caleb. Opened 2026-09-28.
  About 18 candidates; active: 6 new, 3 intro call, 1 technical (renamed "Mock discovery call" for this job).
- `j-solutions-acct` Solutions accountant (CPA). Accounting L3, $165,000-$205,000. HM Elena. Opened 2026-10-01.
  About 12 candidates; active: 8 new, 2 intro call.
- `j-pm` Product manager, close and reconciliation. Draft, **no pay range yet** (posting blocked at 15+).
- `j-em-platform` Engineering manager, platform. On hold until Q2 2027.

Filled historical jobs exist for every hire 2-17 with smaller recorded pipelines (the applications that were
reviewed), so hiring metrics have history. Hires 2-4 came from the founder's network (source `network`/`referral`).
Overall source story: inbound is most applications but few hires; referrals are a small share of applications
and a large share of hires; one agency hire (Caleb, 20% fee).

## Contractors

- `k-northline` Northline Finance Partners LLC (Dana Whitaker), fractional CFO, 8 hours a week, $6,500/month,
  since 2025-06-01. Own firm, other clients. ABC: A yes, B yes, C yes. Low risk.
- `k-marisol` Marisol Vega, CPA, reviews close-agent outputs and labels reconciliation data for model evals,
  25 hours a week at $85/hour since 2026-04-01, uses company tools and works on the core product.
  ABC: A no, B no, C yes. **Likely an employee**: convert or restructure.
- `k-fieldnote` Studio Fieldnote (design agency), brand and website project 2025-11-01 to 2026-02-28, $38,000 project. Low risk.

## Hiring conventions

- Default stages per job: New, Intro call, Technical, Onsite, Offer, Hired (ids new, intro, technical, onsite, offer, hired). Rejected and Withdrew are outcomes, not stages.
- Sources: inbound, referral, outbound, agency (sourceDetail holds the board or agency name, e.g. Wellfound, LinkedIn, careers page, 'Bright Path Talent' for the agency).
- Every active candidate has a next step with a due date and an owner; a few are past SLA on purpose.
- Closed historical jobs keep an archivedFunnel (aggregate counts) plus the hired candidate's own application and a handful of notable others (silver medalists tagged 'keep warm').
- Candidate ids for people hired through the pipeline: `c-hire-<key>` (e.g. c-hire-kofi, c-hire-lucas); persons carry fromCandidateId. Hires 2-4 came through the founder's network (source referral, sourceDetail 'Founder network').

## Seeded situations (what the demo should show on day one)

- Lucas starts Monday Oct 19; his pre-start tasks (accounts, laptop) are due; his start crosses 15.
- Pay run prep (Comp and plan > Pay runs): the payrolls from Jul 1 to Sep 30 are marked submitted on their cutoff days,
  with the PEO's totals for September (before the Oct 1 cash date, so runway is unchanged). The Oct 1-15 payroll is
  due in the PEO by Tue Oct 13 (payday Thu Oct 15; Elena's vacation in it). Oct 16-31 (payday Fri Oct 30, Sat Oct 31
  moved back) has Lucas's prorated first check (10 of 11 weekdays) with his sign-on bonus, Nikhil's raise on Oct 21
  and Kofi's pending day off. Nov 1-15 (payday Fri Nov 13) has Mei's first check and Luis's last day, whose final
  pay is due before the payday (an off-cycle check). Pay periods follow the calendar, so the store rebuilds the
  submitted payrolls for today when it shifts the sample (`samplePayRuns` in src/data/seed/payroll.ts).
- Mei's offer accepted Oct 7; she starts Nov 2.
- Daniel Reyes's offer for Staff ML engineer is waiting for Maya's approval.
- 3 scorecards owed for interviews held Oct 7-8 (one by Ravi, two by Hannah).
- 2 onsites and 3 intro calls scheduled next week.
- 2 time off requests pending: Caleb Nov 23-25 (vacation), Kofi Oct 30 (vacation).
- Elena is out Oct 12-16 (approved vacation). Tomas has CFRA baby-bonding leave planned Nov 16, 2026 to Jan 8, 2027.
- Aisha's security awareness training was due Oct 8 (overdue). Hannah's harassment prevention training was due
  Sep 16 (6 months after her start; overdue, statutory). Caleb's is open too, but he works from Texas, so it shows as recommended, not required. Aisha's grant waits for board consent with Lucas's and Mei's.
- Kofi's 1-year cliff was Oct 6 (13,000 options vested). Sofia's cliff is Jan 12, 2027.
- Marisol's contractor check says "likely employee".
- Draft PM job has no pay range; at 15+ the posting is blocked until it has one.
- SOC 2 quarterly access review due Oct 31.
- Handbook 2.0 (effective 2026-09-15) acknowledgments outstanding for Ravi, Aisha and Caleb.
- Aisha's DE 34 new hire report confirmation is overdue (start 2026-09-08, due 2026-09-28): statutory, shows red.
- HQ typically has 11 people on site on Tue-Thu (typicalMaxOnSite 11, not open to the public) and no workplace violence prevention plan is on file: the SB 553 card shows Applies with an open action.
- Omar's offboarding is complete except laptop return.
- Tomas requested CFRA baby-bonding leave on 2026-10-06 for 2026-11-16 to 2027-01-08; the designation notice is due 2026-10-13 (5 business days).
- Hiring manager view candidates: Tomas, Priya, Elena, Caleb, Jasmine. Employee view default: Aisha (newest active hire).
