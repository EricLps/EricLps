// Gera os cards animados do perfil: estatísticas, linguagens por repositório e sequência de contribuições.
//
// Uso:  node scripts/profile-cards.mjs <usuario> <pastaDeSaida>
// Precisa da variável GITHUB_TOKEN (no GitHub Actions ela já existe).
// Com MOCK=1 usa dados de exemplo, para testar o visual sem token.
// Não depende de nenhuma biblioteca: só Node 18+.

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BAT_PNG = readFileSync(join(HERE, '..', 'assets', 'bat-sprite.png')).toString('base64');
const [user = 'EricLps', outDir = 'dist'] = process.argv.slice(2);

// ---------- paleta (a mesma do README) ----------
const C = {
  bg: '#0D0714', border: '#3A2550', purple: '#9D6BE0', lilac: '#B48EE0',
  text: '#E6DDF2', muted: '#7E6A92', glow: '#C9A3FF',
};
const FONT = `'Segoe UI', Ubuntu, 'Helvetica Neue', Arial, sans-serif`;

// ---------- 1. buscar dados ----------

async function gql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${process.env.GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'profile-cards' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GraphQL: ${res.status} ${JSON.stringify(json.errors ?? json)}`);
  return json.data;
}

async function fetchData() {
  // perfil + repositórios próprios (estrelas contam forks; linguagens não)
  let repos = [], cursor = null, info;
  do {
    const d = await gql(`query($login:String!,$cursor:String){user(login:$login){
      createdAt
      pullRequests{totalCount}
      issues{totalCount}
      repositoriesContributedTo(contributionTypes:[COMMIT,ISSUE,PULL_REQUEST,REPOSITORY],includeUserRepositories:true){totalCount}
      repositories(first:100,after:$cursor,ownerAffiliations:OWNER){
        nodes{isFork stargazerCount primaryLanguage{name color}}
        pageInfo{hasNextPage endCursor}}}}`, { login: user, cursor });
    info = d.user;
    repos.push(...info.repositories.nodes);
    cursor = info.repositories.pageInfo.hasNextPage ? info.repositories.pageInfo.endCursor : null;
  } while (cursor);

  // contribuições ano a ano, desde a criação da conta (a API só aceita intervalos de até 1 ano)
  const now = new Date();
  const years = [];
  for (let y = new Date(info.createdAt).getUTCFullYear(); y <= now.getUTCFullYear(); y++) years.push(y);
  const fields = years.map(y => {
    const to = y === now.getUTCFullYear() ? now.toISOString() : `${y}-12-31T23:59:59Z`;
    return `y${y}:contributionsCollection(from:"${y}-01-01T00:00:00Z",to:"${to}"){
      totalCommitContributions
      contributionCalendar{weeks{contributionDays{date contributionCount}}}}`;
  }).join('\n');
  const cc = (await gql(`query($login:String!){user(login:$login){${fields}}}`, { login: user })).user;

  const days = [];
  let commits = 0;
  for (const y of years) {
    commits += cc[`y${y}`].totalCommitContributions;
    for (const w of cc[`y${y}`].contributionCalendar.weeks)
      for (const d of w.contributionDays)
        if (d.date.startsWith(String(y))) days.push({ date: d.date, count: d.contributionCount });
  }

  return {
    stars: repos.reduce((s, r) => s + r.stargazerCount, 0),
    commits,
    prs: info.pullRequests.totalCount,
    issues: info.issues.totalCount,
    contributedTo: info.repositoriesContributedTo.totalCount,
    repos: repos.filter(r => !r.isFork),
    days,
  };
}

function mockData() {
  const days = [];
  const start = new Date('2025-01-01T00:00:00Z'), end = new Date();
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const rnd = Math.abs(Math.sin(d.getTime() / 864e5 * 12.9898) * 43758.5453) % 1;
    days.push({ date: iso, count: iso >= '2025-02-19' && rnd > 0.82 ? 1 + Math.floor(rnd * 5) : 0 });
  }
  for (const d of days) if (d.date >= '2026-11-04' && d.date <= '2026-11-09') d.count = 2;
  const lang = (name, color, n) => Array.from({ length: n }, () => ({ stargazerCount: 0, primaryLanguage: { name, color } }));
  return {
    stars: 3, commits: 134, prs: 0, issues: 0, contributedTo: 8, days,
    repos: [...lang('Java', '#b07219', 4), ...lang('JavaScript', '#f1e05a', 3), ...lang('C#', '#178600', 1),
            ...lang('Python', '#3572A5', 1), ...lang('TypeScript', '#3178c6', 1)],
  };
}

// ---------- 2. utilidades de SVG ----------

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = n => n.toLocaleString('pt-BR');

// CSS comum: entrada com fade e números que "contam" de 0 até o valor
const BASE_CSS = `
text{font-family:${FONT}}
.fade{opacity:0;animation:fade .7s ease-out forwards}
@keyframes fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.n{opacity:0}
@keyframes on{to{opacity:1}}
@keyframes off{to{opacity:0}}`;

// Sem JavaScript no README: a contagem é feita com vários <text>, cada um visível por um instante.
function countUp(value, delay, dur, attrs) {
  const FRAMES = Math.min(16, Math.max(1, value));
  const values = [];
  for (let k = 0; k <= FRAMES; k++) {
    const t = k / FRAMES, ease = 1 - (1 - t) ** 3;
    const v = Math.round(value * ease);
    if (!values.length || values.at(-1) !== v) values.push(v);
  }
  return values.map((v, i) => {
    const on = delay + dur * (i / values.length);
    const off = delay + dur * ((i + 1) / values.length);
    const anim = i === values.length - 1
      ? `on .001s ${on.toFixed(3)}s forwards`
      : `on .001s ${on.toFixed(3)}s forwards, off .001s ${off.toFixed(3)}s forwards`;
    return `<text class="n" ${attrs} style="animation:${anim}">${fmt(v)}</text>`;
  }).join('');
}

const card = (w, h, label, css, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">
<style>${BASE_CSS}${css}</style>
<rect x="0.5" y="0.5" rx="8" width="${w - 1}" height="${h - 1}" fill="${C.bg}" stroke="${C.border}"/>
${body}
</svg>`;

// ---------- 3. card de estatísticas ----------

const ICONS = {   // ícones simples, 16x16
  star: `<path d="M8 1.5l1.9 4 4.3.5-3.2 3 .9 4.3L8 11.1l-3.9 2.2.9-4.3-3.2-3 4.3-.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>`,
  commit: `<circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M1 8h4M11 8h4" stroke="currentColor" stroke-width="1.4"/>`,
  pr: `<circle cx="4" cy="3.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="4" cy="12.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="12" cy="12.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4 5.3v5.4M12 10.7V6.5c0-1.4-.8-2.2-2.2-2.2H7.5m1.6-1.7L7.5 4.3l1.6 1.7" fill="none" stroke="currentColor" stroke-width="1.3"/>`,
  issue: `<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/>`,
  repo: `<path d="M3 2.5h8.5v10H4.5A1.5 1.5 0 0 1 3 11zM3 11a1.5 1.5 0 0 1 1.5-1.5h7M6 12.5v2l1-.8 1 .8v-2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>`,
};

function statsCard(d) {
  const W = 400, H = 180;
  const rows = [
    ['star', 'Estrelas', d.stars],
    ['commit', 'Commits', d.commits],
    ['pr', 'Pull requests', d.prs],
    ['issue', 'Issues', d.issues],
    ['repo', 'Contribuiu em', d.contributedTo],
  ];
  const body = rows.map(([icon, label, value], i) => {
    const y = 64 + i * 23, delay = 0.25 + i * 0.12;
    return `<g class="fade" style="animation-delay:${delay}s;color:${C.purple}">
  <svg x="26" y="${y - 12}" width="15" height="15" viewBox="0 0 16 16">${ICONS[icon]}</svg>
  <text x="50" y="${y}" fill="${C.lilac}" font-size="13.5">${label}</text>
</g>
${countUp(value, delay + 0.15, 1.1, `x="190" y="${y}" fill="${C.text}" font-size="13.5" font-weight="700" text-anchor="end"`)}`;
  }).join('\n');

  const css = `
.halo{transform-origin:308px 98px;animation:halo 3.2s ease-in-out infinite}
@keyframes halo{0%,100%{opacity:.35;transform:scale(1)}50%{opacity:.7;transform:scale(1.08)}}
.bob{animation:bob 1.8s ease-in-out infinite alternate}
@keyframes bob{from{transform:translateY(5px)}to{transform:translateY(-5px)}}
.flap{transform-box:fill-box;transform-origin:50% 60%;animation:flap .5s steps(1) infinite}
@keyframes flap{0%{transform:scale(1,1)}50%{transform:scale(.92,.55)}}`;

  return card(W, H, `Estatísticas de ${user}`, css, `
<text class="fade" x="26" y="34" fill="${C.purple}" font-size="18" font-weight="600">Estatísticas</text>
${body}
<defs><radialGradient id="h"><stop offset="0" stop-color="${C.purple}" stop-opacity=".55"/><stop offset="1" stop-color="${C.purple}" stop-opacity="0"/></radialGradient></defs>
<circle class="halo" cx="308" cy="98" r="62" fill="url(#h)"/>
<g class="fade" style="animation-delay:.4s"><g class="bob"><g class="flap">
  <image x="254" y="72" width="108" height="53" href="data:image/png;base64,${BAT_PNG}" style="image-rendering:pixelated"/>
</g></g></g>`);
}

// ---------- 4. card de linguagens por repositório ----------

function languagesCard(d) {
  const W = 400, H = 180;
  const counts = new Map();
  for (const r of d.repos) {
    if (!r.primaryLanguage) continue;
    const { name, color } = r.primaryLanguage;
    const e = counts.get(name) ?? { name, color: color ?? C.lilac, n: 0 };
    e.n++;
    counts.set(name, e);
  }
  let langs = [...counts.values()].sort((a, b) => b.n - a.n);
  if (langs.length > 5) {
    const rest = langs.slice(4).reduce((s, l) => s + l.n, 0);
    langs = [...langs.slice(0, 4), { name: 'Outras', color: C.muted, n: rest }];
  }
  const total = langs.reduce((s, l) => s + l.n, 0) || 1;

  const CX = 300, CY = 100, R = 46, GAP = 0.8;
  let acc = 0, css = '';
  const segs = langs.map((l, i) => {
    const len = l.n / total * 100;
    const draw = Math.max(len - GAP, 0.5);
    const delay = 0.3 + i * 0.28;
    css += `@keyframes s${i}{from{stroke-dasharray:0 100}to{stroke-dasharray:${draw.toFixed(2)} 100}}`;
    const seg = `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${l.color}" stroke-width="20" pathLength="100"
  stroke-dasharray="0 100" stroke-dashoffset="${(-acc).toFixed(2)}" transform="rotate(-90 ${CX} ${CY})"
  style="animation:s${i} .55s ease-out ${delay.toFixed(2)}s forwards"/>`;
    acc += len;
    return seg;
  }).join('\n');

  const legend = langs.map((l, i) => {
    const y = 66 + i * 22, delay = 0.3 + i * 0.28;
    const pct = Math.round(l.n / total * 100);
    return `<g class="fade" style="animation-delay:${delay.toFixed(2)}s">
  <rect x="26" y="${y - 10}" width="11" height="11" rx="2" fill="${l.color}"/>
  <text x="45" y="${y}" fill="${C.lilac}" font-size="13.5">${esc(l.name)}</text>
  <text x="200" y="${y}" fill="${C.muted}" font-size="12" text-anchor="end">${l.n} · ${pct}%</text>
</g>`;
  }).join('\n');

  const endDraw = 0.3 + langs.length * 0.28 + 0.4;
  css += `
.ringbg{opacity:.18}
.glow{transform-origin:${CX}px ${CY}px;animation:glow 3.2s ease-in-out ${endDraw.toFixed(2)}s infinite}
@keyframes glow{0%,100%{transform:scale(1)}50%{transform:scale(1.035)}}`;

  return card(W, H, `Linguagens dos repositórios de ${user}`, css, `
<text class="fade" x="26" y="34" fill="${C.purple}" font-size="18" font-weight="600">Linguagens por repositório</text>
${legend}
<circle class="ringbg" cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${C.border}" stroke-width="20"/>
<g class="glow">${segs}</g>
${countUp(total, 0.3, 0.28 * langs.length, `x="${CX}" y="${CY + 4}" fill="${C.text}" font-size="20" font-weight="700" text-anchor="middle"`)}
<text class="fade" x="${CX}" y="${CY + 20}" fill="${C.muted}" font-size="11" text-anchor="middle" style="animation-delay:.5s">repos</text>`);
}

// ---------- 5. card de sequência (streak) ----------

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
function dataBR(iso, comAno) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MESES[m - 1]}${comAno ? ` ${y}` : ''}`;
}
function intervalo(a, b) {
  const anoAtual = String(new Date().getUTCFullYear());
  const comAno = !a.startsWith(anoAtual) || !b.startsWith(anoAtual);
  return a === b ? dataBR(a, comAno) : `${dataBR(a, comAno)} – ${dataBR(b, comAno)}`;
}

function streaks(days) {
  days = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const total = days.reduce((s, d) => s + d.count, 0);
  const first = days.find(d => d.count > 0)?.date;

  let longest = { len: 0 }, run = null;
  for (const d of days) {
    if (d.count > 0) {
      run = run ? { ...run, end: d.date, len: run.len + 1 } : { start: d.date, end: d.date, len: 1 };
      if (run.len > longest.len) longest = run;
    } else run = null;
  }

  // sequência atual: se hoje ainda não teve contribuição, conta a partir de ontem
  let i = days.length - 1;
  if (i >= 0 && days[i].count === 0) i--;
  let current = { len: 0 };
  for (; i >= 0 && days[i].count > 0; i--)
    current = { start: days[i].date, end: current.end ?? days[i].date, len: current.len + 1 };

  return { total, first, longest, current };
}

function streakCard(d) {
  const W = 495, H = 195;
  const s = streaks(d.days);
  const CX = 247.5, CY = 71;

  const css = `
.ring{fill:none;stroke:${C.purple};stroke-width:5;stroke-linecap:round;stroke-dasharray:251;stroke-dashoffset:251;
  transform-origin:${CX}px ${CY}px;transform:rotate(-90deg);
  animation:fill 1.4s ease-out .2s forwards, pulse 2.4s ease-in-out 1.6s infinite}
@keyframes fill{to{stroke-dashoffset:0}}
@keyframes pulse{0%,100%{stroke:${C.purple};stroke-width:5}50%{stroke:${C.glow};stroke-width:6.5}}
.fire{fill:${C.lilac};transform-origin:${CX}px 41px;animation:flicker .9s ease-in-out infinite}
@keyframes flicker{0%,100%{transform:scale(1,1) rotate(0)}25%{transform:scale(.9,1.1) rotate(-5deg)}
  50%{transform:scale(1.06,.94) rotate(4deg)}75%{transform:scale(.95,1.07) rotate(-2deg)}}`;

  const side = (x, value, label, dates, delay) => `
${countUp(value, delay + 0.1, 1.1, `x="${x}" y="80" fill="${C.text}" font-size="28" font-weight="700" text-anchor="middle"`)}
<g class="fade" style="animation-delay:${delay}s">
  <text x="${x}" y="118" fill="${C.lilac}" font-size="14" text-anchor="middle">${label}</text>
  <text x="${x}" y="145" fill="${C.muted}" font-size="12" text-anchor="middle">${dates}</text>
</g>`;

  const longestDates = s.longest.len ? intervalo(s.longest.start, s.longest.end) : '—';
  const currentDates = s.current.len ? intervalo(s.current.start, s.current.end) : 'comece hoje 🦇';
  const firstDates = s.first ? `${dataBR(s.first, true)} – hoje` : '—';

  return card(W, H, `Sequência de contribuições de ${user}`, css, `
<line x1="165" y1="28" x2="165" y2="170" stroke="${C.border}"/>
<line x1="330" y1="28" x2="330" y2="170" stroke="${C.border}"/>
${side(82.5, s.total, 'Contribuições', firstDates, 0.2)}
<circle class="ring" cx="${CX}" cy="${CY}" r="40"/>
<rect x="${CX - 13}" y="22" width="26" height="22" fill="${C.bg}"/>
<path class="fire" d="M${CX} 28c-1 4-5 6-5 11a5 5 0 0 0 10 0c0-3-1.5-4.5-2-7-1 2-2 2.5-3 2.5 0-2 .5-4 0-6.5z"/>
${countUp(s.current.len, 0.3, 1.2, `x="${CX}" y="81" fill="${C.text}" font-size="28" font-weight="700" text-anchor="middle"`)}
<g class="fade" style="animation-delay:.5s">
  <text x="${CX}" y="140" fill="${C.purple}" font-size="14" font-weight="700" text-anchor="middle">Sequência atual</text>
  <text x="${CX}" y="164" fill="${C.muted}" font-size="12" text-anchor="middle">${currentDates}</text>
</g>
${side(412.5, s.longest.len, 'Maior sequência', longestDates, 0.35)}`);
}

// ---------- 6. gerar ----------

const data = process.env.MOCK ? mockData() : await fetchData();
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'stats.svg'), statsCard(data));
writeFileSync(join(outDir, 'languages.svg'), languagesCard(data));
writeFileSync(join(outDir, 'streak.svg'), streakCard(data));
const s = streaks(data.days);
console.log(`${user}: ${s.total} contribuições, sequência atual ${s.current.len}, maior ${s.longest.len}, ${data.repos.length} repos -> ${outDir}`);
