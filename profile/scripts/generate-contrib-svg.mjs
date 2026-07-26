// Draws your GitHub contribution grid as an SVG, themed for oxocarbon.
// Writes assets/contributions.svg, which the README embeds.
//
// Data source, in priority order:
//   MOCK=1              -> random data, for previewing the look offline
//   GH_TOKEN set        -> GraphQL API (includes private / SSO contributions)
//   neither             -> public scrape of github.com/users/<name>/contributions
//                          (real data, NO token or setup required)
//
// Local preview:   MOCK=1 node scripts/generate-contrib-svg.mjs
// Real, no token:  node scripts/generate-contrib-svg.mjs

import fs from "node:fs";
import path from "node:path";

// ── config ──────────────────────────────────────────────────────────────────
// CHANGE THIS to your GitHub username. Nothing else needs editing.
const USERNAME = "luidevo";
const TIMEZONE = "America/Toronto";
const THEME_NAME = "oxocarbon"; // "oxocarbon" | "phosphor" | "amber"

// ── themes ───────────────────────────────────────────────────────────────────
// empty  = the "no activity" cell (kept neutral so it reads on light and dark).
// active = five stops, level 1..5. oxocarbon uses its signature accent gradient
//          (teal -> cyan -> blue -> purple -> magenta) so intensity is read by
//          hue. phosphor/amber use one hue ramped by opacity instead.
const THEMES = {
  oxocarbon: {
    empty: { fill: "#525252", opacity: 0.20 },
    active: [
      { fill: "#08bdba", opacity: 0.85 }, // teal
      { fill: "#3ddbd9", opacity: 0.90 }, // cyan
      { fill: "#33b1ff", opacity: 0.95 }, // blue
      { fill: "#be95ff", opacity: 1.0 },  // purple
      { fill: "#ee5396", opacity: 1.0 },  // magenta
    ],
    text: "#8b949e",
    glow: false,
  },
  phosphor: {
    empty: { fill: "#6e7681", opacity: 0.18 },
    active: [0.32, 0.48, 0.64, 0.82, 1.0].map((o) => ({ fill: "#3bff9a", opacity: o })),
    text: "#8b949e",
    glow: true,
  },
  amber: {
    empty: { fill: "#6e7681", opacity: 0.18 },
    active: [0.30, 0.46, 0.62, 0.80, 1.0].map((o) => ({ fill: "#ffb000", opacity: o })),
    text: "#8b949e",
    glow: true,
  },
};
const THEME = THEMES[THEME_NAME];

// count -> level (0 = empty, 1..5 = ramp)
function levelFor(count) {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  if (count <= 14) return 4;
  return 5;
}

// ── geometry ─────────────────────────────────────────────────────────────────
const CELL = 12, GAP = 3, RX = 2.5, WEEKS = 53, DAYS = 7, PAD = 10, LEGEND_H = 26;

// ── helpers ──────────────────────────────────────────────────────────────────
function localDate(d) { return d.toLocaleDateString("en-CA", { timeZone: TIMEZONE }); }
function weekdayOf(dateStr) { return new Date(dateStr + "T00:00:00Z").getUTCDay(); }
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function tooltip(date, count) {
  if (!date) return "";
  const [, m, d] = date.split("-").map(Number);
  return `${count} contribution${count === 1 ? "" : "s"} on ${MONTHS[m - 1]} ${d}`;
}
function esc(s) {
  return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;");
}
// Turn a flat [{date, count}] list into the weeks[].contributionDays[] shape
// the renderer wants. GitHub's calendar always starts on a Sunday.
function toWeeks(days) {
  days.sort((a, b) => a.date.localeCompare(b.date));
  const weeks = [];
  let cur = null;
  for (const day of days) {
    const wd = weekdayOf(day.date);
    if (wd === 0 || cur === null) { cur = { contributionDays: [] }; weeks.push(cur); }
    cur.contributionDays.push({ date: day.date, weekday: wd, count: day.count });
  }
  return weeks;
}

// ── data source: public scrape (no token) ────────────────────────────────────
async function fetchPublic() {
  const url = `https://github.com/users/${USERNAME}/contributions`;
  const res = await fetch(url, { headers: { "User-Agent": "contrib-graph" } });
  if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${url}`);
  const html = await res.text();

  // id -> count, read from the accessible <tool-tip> labels.
  const counts = new Map();
  const tipRe = /<tool-tip[^>]*for="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g;
  for (let m; (m = tipRe.exec(html)); ) {
    const text = m[2].trim();
    const num = /^\d+/.test(text) ? parseInt(text, 10) : 0; // "No contributions" -> 0
    counts.set(m[1], num);
  }

  // each day cell carries data-date and an id linking it to its tooltip.
  const days = [];
  const cellRe = /<td\b[^>]*class="[^"]*ContributionCalendar-day[^"]*"[^>]*>/g;
  for (let m; (m = cellRe.exec(html)); ) {
    const tag = m[0];
    const date = tag.match(/data-date="([0-9-]+)"/)?.[1];
    const id = tag.match(/id="([^"]+)"/)?.[1];
    if (!date) continue;
    days.push({ date, count: id ? counts.get(id) ?? 0 : 0 });
  }
  if (!days.length) throw new Error("No contribution cells found — is the username right and profile public?");

  const total = days.reduce((s, d) => s + d.count, 0);
  return { weeks: toWeeks(days), total };
}

// ── data source: GraphQL (token, includes private) ───────────────────────────
async function fetchGraphQL(token) {
  const query = `query($login:String!){user(login:$login){contributionsCollection{
    contributionCalendar{totalContributions weeks{contributionDays{date weekday contributionCount}}}}}}`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { login: USERNAME } }),
  });
  if (!res.ok) throw new Error(`GraphQL ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
  const cal = json.data.user.contributionsCollection.contributionCalendar;
  const weeks = cal.weeks.map((w) => ({
    contributionDays: w.contributionDays.map((d) => ({
      date: d.date, weekday: d.weekday, count: d.contributionCount ?? 0 })),
  }));
  return { weeks, total: cal.totalContributions ?? 0 };
}

// ── data source: mock (offline preview) ──────────────────────────────────────
function fetchMock() {
  const days = [];
  const start = new Date();
  start.setDate(start.getDate() - WEEKS * 7);
  for (let i = 0; i < WEEKS * 7; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const wd = d.getDay();
    const base = wd === 0 || wd === 6 ? 0.5 : 1.4;
    const spike = Math.random() < 0.08 ? 12 : 0;
    days.push({ date: localDate(d), count: Math.max(0, Math.round((Math.random() ** 2) * base * 6) + spike) });
  }
  return { weeks: toWeeks(days), total: days.reduce((s, x) => s + x.count, 0) };
}

// ── render ───────────────────────────────────────────────────────────────────
function render({ weeks, total }) {
  const today = localDate(new Date());
  let cols = [...weeks];
  while (cols.length < WEEKS) cols.unshift({ contributionDays: [] });
  if (cols.length > WEEKS) cols = cols.slice(cols.length - WEEKS);

  const W = PAD * 2 + WEEKS * CELL + (WEEKS - 1) * GAP;
  const gridH = PAD * 2 + DAYS * CELL + (DAYS - 1) * GAP;
  const H = gridH + LEGEND_H;

  let cells = "";
  for (let x = 0; x < WEEKS; x++) {
    const byDay = new Map((cols[x].contributionDays ?? []).map((d) => [d.weekday, d]));
    for (let y = 0; y < DAYS; y++) {
      const day = byDay.get(y);
      if (!day) continue;
      if (day.date && day.date > today) continue; // hide only strictly-future days
      const level = levelFor(day.count);
      const stop = level === 0 ? THEME.empty : THEME.active[level - 1];
      const px = PAD + x * (CELL + GAP), py = PAD + y * (CELL + GAP);
      const glow = THEME.glow && level >= 4 ? ' filter="url(#glow)"' : "";
      const t = tooltip(day.date, day.count);
      cells += `\n    <rect x="${px}" y="${py}" width="${CELL}" height="${CELL}" rx="${RX}" `
        + `fill="${stop.fill}" fill-opacity="${stop.opacity}"${glow}>`
        + `${t ? `<title>${esc(t)}</title>` : ""}</rect>`;
    }
  }

  const mono = `font-family="ui-monospace, SFMono-Regular, Menlo, monospace"`;
  const textY = H - 8, sw = 10, sg = 3;
  const legendX = W - PAD - 30 - 5 * (sw + sg) - 30;
  let swatches = "";
  for (let i = 0; i < 5; i++) {
    const lx = legendX + 26 + i * (sw + sg);
    swatches += `\n    <rect x="${lx}" y="${textY - sw + 2}" width="${sw}" height="${sw}" rx="2" `
      + `fill="${THEME.active[i].fill}" fill-opacity="${THEME.active[i].opacity}"/>`;
  }
  const glowDef = THEME.glow ? `
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="0.6" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>` : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"
     role="img" aria-label="GitHub contributions for ${USERNAME}">
  <defs>${glowDef}</defs>
  <g>${cells}
  </g>
  <text x="${PAD}" y="${textY}" ${mono} font-size="9" fill="${THEME.text}">${total.toLocaleString("en-US")} contributions · last year</text>
  <text x="${legendX}" y="${textY}" ${mono} font-size="9" fill="${THEME.text}">less</text>${swatches}
  <text x="${legendX + 26 + 5 * (sw + sg) + 4}" y="${textY}" ${mono} font-size="9" fill="${THEME.text}">more</text>
</svg>
`;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  let data;
  if (process.env.MOCK) data = fetchMock();
  else if (process.env.GH_TOKEN) data = await fetchGraphQL(process.env.GH_TOKEN);
  else data = await fetchPublic();

  const out = path.join(process.cwd(), "assets", "contributions.svg");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, render(data), "utf8");
  console.log(`wrote ${out}  (${data.total} contributions, theme: ${THEME_NAME})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
