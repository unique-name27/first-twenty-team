// npm run sim runs in California time, whatever this computer's time zone (docs/DEV.md, "Simulate a
// company"). Every simulated action happens at a time of day in California (src/lib/runContext.ts), and a
// run refuses a moment that falls on another date in this computer's zone: from Central Europe eastwards,
// 3 PM in California is already the next day. California time also makes today() the date the company
// sees, so reset moves a company to California's today on every computer. sim.ts imports this file first,
// so the zone is set before any date code runs (Node reads TZ again whenever it changes).
export const SIM_TIME_ZONE = 'America/Los_Angeles'

process.env.TZ = SIM_TIME_ZONE
