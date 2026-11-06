// Gera um SVG animado: um morcego em pixel art voa sobre o gráfico de contribuições
// do GitHub e "come" os quadradinhos com contribuição, um por um.
//
// Uso:  node scripts/bat-contrib.mjs <usuario> <pastaDeSaida>
// Com a variável GITHUB_TOKEN definida, usa a API GraphQL oficial (é o caso no GitHub Actions).
// Sem token, lê o calendário público da página do perfil (útil para testar no seu PC).
// Não depende de nenhuma biblioteca: só Node 18+.

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// sprite do morcego (pixel art com fundo transparente), embutido no SVG
const HERE = dirname(fileURLToPath(import.meta.url));
const BAT_PNG = readFileSync(join(HERE, '..', 'assets', 'bat-sprite.png')).toString('base64');

const [user = 'EricLps', outDir = 'dist'] = process.argv.slice(2);

// ---------- 1. buscar as contribuições ----------
// Resultado: lista de { week, day, level } com level de 0 (nenhuma) a 4 (muitas).

const LEVELS = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

async function fromGraphQL(token) {
  const query = `query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{
    weeks{contributionDays{weekday contributionLevel}}}}}}`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'bat-contrib' },
    body: JSON.stringify({ query, variables: { login: user } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GraphQL: ${res.status} ${JSON.stringify(json.errors ?? json)}`);
  const weeks = json.data.user.contributionsCollection.contributionCalendar.weeks;
  return weeks.flatMap((w, week) =>
    w.contributionDays.map(d => ({ week, day: d.weekday, level: LEVELS[d.contributionLevel] ?? 0 })));
}

async function fromProfilePage() {
  const res = await fetch(`https://github.com/users/${user}/contributions`, { headers: { 'User-Agent': 'bat-contrib' } });
  if (!res.ok) throw new Error(`página de contribuições: HTTP ${res.status}`);
  const html = await res.text();
  const cells = [];
  // cada dia é um <td ... id="contribution-day-component-{dia}-{semana}" data-level="N">
  for (const tag of html.match(/<td[^>]*ContributionCalendar-day[^>]*>/g) ?? []) {
    const id = tag.match(/contribution-day-component-(\d+)-(\d+)/);
    const level = tag.match(/data-level="(\d)"/);
    if (id && level) cells.push({ day: +id[1], week: +id[2], level: +level[1] });
  }
  if (!cells.length) throw new Error('não encontrei o calendário na página');
  return cells;
}

const token = process.env.GITHUB_TOKEN;
const cells = token ? await fromGraphQL(token) : await fromProfilePage();
const weeks = Math.max(...cells.map(c => c.week)) + 1;

// ---------- 2. geometria ----------

const CELL = 11, STEP = 14, PAD_X = 30, PAD_Y = 26;
const W = PAD_X * 2 + weeks * STEP - (STEP - CELL);
const H = PAD_Y * 2 + 7 * STEP - (STEP - CELL);
const cx = c => PAD_X + c.week * STEP + CELL / 2;
const cy = c => PAD_Y + c.day * STEP + CELL / 2;

// ---------- 3. rota do morcego ----------
// Visita só os dias com contribuição, numa ordem aleatória que muda a cada dia.
// A "semente" é a data de hoje: no mesmo dia a ordem é sempre a mesma (o arquivo não muda à toa).

function seededRandom(seed) {           // gerador simples (mulberry32): mesma semente -> mesma sequência
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = seededRandom(Number(new Date().toISOString().slice(0, 10).replaceAll('-', '')));

const targets = cells.filter(c => c.level > 0);
for (let i = targets.length - 1; i > 0; i--) {   // embaralhamento de Fisher-Yates
  const j = Math.floor(random() * (i + 1));
  [targets[i], targets[j]] = [targets[j], targets[i]];
}

const start = { x: -40, y: PAD_Y + 3 * STEP };
const end = { x: W + 40, y: PAD_Y + 3 * STEP };
const points = [start, ...targets.map(c => ({ x: cx(c), y: cy(c), cell: c })), end];

const SPEED = 110;           // pixels por segundo (devagar, voo tranquilo)
const EAT_PAUSE = 0.35;      // segundos parado em cada quadrado, "comendo"
const HOLD = 2.5;            // segundos com o gráfico vazio antes de recomeçar
let t = 0;
const timeline = [{ ...points[0], t: 0 }];
for (let i = 1; i < points.length; i++) {
  const a = points[i - 1], b = points[i];
  t += Math.hypot(b.x - a.x, b.y - a.y) / SPEED;
  timeline.push({ ...b, t });
  if (b.cell) { t += EAT_PAUSE; timeline.push({ ...b, t, pause: true }); }
}
const DUR = Math.max(t + HOLD, 6);
const pct = s => +(s / DUR * 100).toFixed(3);

// ---------- 4. o morcego (sprite em pixel art, proporção 512x248) ----------

const BAT_W = 56, BAT_H = Math.round(56 * 248 / 512);

// ---------- 5. montar o SVG ----------

function build(theme) {
  const pal = theme === 'dark'
    ? { empty: '#1c1726', levels: ['#1c1726', '#3d1633', '#6e1534', '#a8162f', '#ff2d3c'], glow: '#c9a6ff88' }
    : { empty: '#ebedf0', levels: ['#ebedf0', '#f2c4ca', '#e07282', '#c0243a', '#7a0a1e'], glow: '#00000040' };

  // posição do morcego ao longo do tempo
  const batFrames = timeline.map(p =>
    `${pct(p.t)}%{transform:translate(${(p.x - BAT_W / 2).toFixed(1)}px,${(p.y - BAT_H / 2 - 4).toFixed(1)}px)}`).join('');

  // cada quadrado com contribuição some quando o morcego chega e volta no fim do ciclo
  let css = '';
  const eaten = targets.map((c, i) => {
    const arrive = timeline.find(p => p.cell === c && !p.pause).t;
    const a = pct(arrive), b = pct(arrive + 0.15);
    css += `.c${i}{animation:e${i} ${DUR.toFixed(2)}s linear infinite}@keyframes e${i}{0%,${a}%{opacity:1}${b}%,97%{opacity:0}100%{opacity:1}}`;
    return `<rect class="c${i}" x="${cx(c) - CELL / 2}" y="${cy(c) - CELL / 2}" width="${CELL}" height="${CELL}" rx="2" fill="${pal.levels[c.level]}"/>`;
  });

  const empties = cells.map(c =>
    `<rect x="${cx(c) - CELL / 2}" y="${cy(c) - CELL / 2}" width="${CELL}" height="${CELL}" rx="2" fill="${pal.empty}"/>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Morcego comendo o gráfico de contribuições de ${user}">
<style>
.bat{animation:fly ${DUR.toFixed(2)}s linear infinite;filter:drop-shadow(0 0 2px ${pal.glow})}
@keyframes fly{${batFrames}}
/* bater de asas: o sprite "achata" em dois quadros, como num jogo antigo */
.flap{transform-box:fill-box;transform-origin:50% 60%;animation:flap .5s steps(1) infinite}
@keyframes flap{0%{transform:scale(1,1)}50%{transform:scale(.92,.55)}}
${css}
</style>
<g>${empties.join('')}</g>
<g>${eaten.join('')}</g>
<g class="bat"><g class="flap">
  <image href="data:image/png;base64,${BAT_PNG}" width="${BAT_W}" height="${BAT_H}" style="image-rendering:pixelated"/>
</g></g>
</svg>`;
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'bat-contrib-dark.svg'), build('dark'));
writeFileSync(join(outDir, 'bat-contrib.svg'), build('light'));
console.log(`${user}: ${cells.length} dias, ${targets.length} com contribuição, ciclo de ${DUR.toFixed(1)}s -> ${outDir}`);
