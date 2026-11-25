#!/usr/bin/env python3
"""Gera um SVG animado do Dante atirando no gráfico de contribuições.

Cada tiro acerta uma célula com contribuição e apaga ela (igual a cobrinha).
Quando todas são apagadas, o gráfico volta e a animação recomeça.

Uso:
  GITHUB_TOKEN=... python3 scripts/dante_contrib.py --user EricLps --out dist/dante-contrib.svg
  python3 scripts/dante_contrib.py --fake --out dante.svg   # dados de teste, sem rede
"""
import argparse
import base64
import json
import math
import os
import random
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPRITE_DIR = ROOT / "assets" / "sprite"

# visual
CELL, PITCH, COLS, ROWS = 12, 16, 53, 7
LEVEL_COLORS = {
    "NONE": "#161b22",
    "FIRST_QUARTILE": "#3b0a0a",
    "SECOND_QUARTILE": "#780000",
    "THIRD_QUARTILE": "#c1121f",
    "FOURTH_QUARTILE": "#ff2e2e",
}
EMPTY = LEVEL_COLORS["NONE"]

# ritmo
START = 0.6        # s antes do primeiro tiro
SHOT_GAP = 0.11    # s entre tiros
FLASH = 0.06       # s com o quadro de disparo na tela
SPEED = 2400.0     # unidades/s da bala
HIT_FADE = 0.18    # s do clarão da célula até apagar
PAUSE = 1.8        # s com o gráfico vazio
RESPAWN = 0.6      # s para as células voltarem


def fetch_levels(user, token):
    query = """query($login:String!){user(login:$login){contributionsCollection{
      contributionCalendar{weeks{contributionDays{weekday contributionLevel}}}}}}"""
    req = urllib.request.Request(
        "https://api.github.com/graphql",
        data=json.dumps({"query": query, "variables": {"login": user}}).encode(),
        headers={"Authorization": f"bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    if "errors" in data:
        raise SystemExit(f"Erro da API do GitHub: {data['errors']}")
    weeks = data["data"]["user"]["contributionsCollection"]["contributionCalendar"]["weeks"]
    cells = []
    for col, week in enumerate(weeks[-COLS:]):
        for day in week["contributionDays"]:
            cells.append((col, day["weekday"], day["contributionLevel"]))
    return cells


def fake_levels(seed=7):
    rnd = random.Random(seed)
    levels = list(LEVEL_COLORS)
    weights = [45, 22, 15, 10, 8]
    return [(c, r, rnd.choices(levels, weights)[0]) for c in range(COLS) for r in range(ROWS)]


def b64(path):
    return base64.b64encode(Path(path).read_bytes()).decode()


def pct(t, total):
    return f"{max(0.0, min(100.0, t / total * 100)):.3f}%"


def build_svg(cells):
    meta = json.loads((SPRITE_DIR / "sprite.json").read_text())
    sw, sh = meta["width"], meta["height"]
    muzzles = meta["muzzles"]  # [cima, baixo] em coordenadas do sprite

    grid_w, grid_h = COLS * PITCH - (PITCH - CELL), ROWS * PITCH - (PITCH - CELL)
    gx = sw + 34
    mid = (muzzles[0][1] + muzzles[1][1]) / 2
    gy = max(6, round(mid - grid_h / 2 + 18))
    vw, vh = gx + grid_w + 8, max(sh, gy + grid_h + 6)
    sy = vh - sh  # Dante com os pés no chão
    muz = [(mx + 2, my + sy) for mx, my in muzzles]

    def center(c, r):
        return gx + c * PITCH + CELL / 2, gy + r * PITCH + CELL / 2

    # alvos: da coluna mais próxima para a mais distante
    targets = sorted([(c, r) for c, r, lv in cells if lv != "NONE"])
    dummy = False
    if not targets:  # sem contribuições: atira em algumas células vazias
        targets, dummy = [(c, 3) for c in range(0, 12, 2)], True

    shots = []
    for i, (c, r) in enumerate(targets):
        gun = i % 2
        t = START + i * SHOT_GAP
        mx, my = muz[gun]
        tx, ty = center(c, r)
        hit = t + math.hypot(tx - mx, ty - my) / SPEED
        shots.append({"gun": gun, "t": t, "hit": hit, "c": c, "r": r, "m": (mx, my), "tgt": (tx, ty)})
    last_hit = max(s["hit"] for s in shots)
    respawn_at = last_hit + HIT_FADE + PAUSE
    total = respawn_at + RESPAWN + 0.3

    css = [
        f".a{{animation-duration:{total:.2f}s;animation-iteration-count:infinite}}",
        ".st{animation-timing-function:step-end}",
        ".sprite{image-rendering:pixelated}",
    ]
    els = []

    # ---- grade ----
    hit_of = {(s["c"], s["r"]): s["hit"] for s in shots} if not dummy else {}
    for c, r, lv in cells:
        x, y = gx + c * PITCH, gy + r * PITCH
        color = LEVEL_COLORS.get(lv, EMPTY)
        if (c, r) in hit_of:
            h = hit_of[(c, r)]
            name = f"c{c}_{r}"
            css.append(
                f"@keyframes {name}{{0%{{fill:{color}}}{pct(h, total)}{{fill:{color}}}"
                f"{pct(h + 0.02, total)}{{fill:#fff3c4}}{pct(h + HIT_FADE, total)}{{fill:{EMPTY}}}"
                f"{pct(respawn_at, total)}{{fill:{EMPTY}}}{pct(respawn_at + RESPAWN, total)}{{fill:{color}}}"
                f"100%{{fill:{color}}}}}"
                f".{name}{{animation-name:{name}}}"
            )
            els.append(f'<rect class="a {name}" x="{x}" y="{y}" width="{CELL}" height="{CELL}" rx="2" fill="{color}"/>')
        else:
            els.append(f'<rect x="{x}" y="{y}" width="{CELL}" height="{CELL}" rx="2" fill="{color}"/>')

    # ---- balas e impactos ----
    for i, s in enumerate(shots):
        (mx, my), (tx, ty) = s["m"], s["tgt"]
        dx, dy = tx - mx, ty - my
        d = math.hypot(dx, dy)
        ux, uy = dx / d, dy / d
        L = 16
        css.append(
            f"@keyframes b{i}{{0%{{opacity:0}}{pct(s['t'] - 0.002, total)}{{opacity:0;transform:translate(0,0)}}{pct(s['t'], total)}{{opacity:1;transform:translate(0,0)}}"
            f"{pct(s['hit'], total)}{{opacity:1;transform:translate({dx - L*ux:.1f}px,{dy - L*uy:.1f}px)}}"
            f"{pct(s['hit'] + 0.005, total)}{{opacity:0}}100%{{opacity:0}}}}.b{i}{{animation-name:b{i}}}"
        )
        els.append(
            f'<line class="a b{i}" opacity="0" x1="{mx:.1f}" y1="{my:.1f}" x2="{mx + L*ux:.1f}" y2="{my + L*uy:.1f}" '
            f'stroke="url(#trail)" stroke-width="2.4" stroke-linecap="round"/>'
        )
        css.append(
            f"@keyframes s{i}{{0%{{opacity:0;transform:scale(.3)}}{pct(s['hit'], total)}{{opacity:0;transform:scale(.3)}}"
            f"{pct(s['hit'] + 0.01, total)}{{opacity:1;transform:scale(1)}}{pct(s['hit'] + 0.16, total)}{{opacity:0;transform:scale(1.7)}}"
            f"100%{{opacity:0}}}}.s{i}{{animation-name:s{i};transform-origin:{tx:.1f}px {ty:.1f}px}}"
        )
        els.append(f'<circle class="a s{i}" opacity="0" cx="{tx:.1f}" cy="{ty:.1f}" r="7" fill="none" stroke="#ffcc33" stroke-width="1.6"/>')

    # ---- quadros do sprite ----
    # 0 = mirando, 1 = arma de cima atirando, 2 = arma de baixo atirando, 3 = casaco balançando (pausa)
    events = []
    for s in shots:
        events.append((s["t"], 1 + s["gun"]))
        events.append((s["t"] + FLASH, 0))
    events.append((last_hit + HIT_FADE, 3))
    events.append((respawn_at + RESPAWN, 0))
    events.sort()
    for f in range(4):
        stops = [f"0%{{opacity:{1 if f == 0 else 0}}}"]
        for t, frame in events:
            stops.append(f"{pct(t, total)}{{opacity:{1 if frame == f else 0}}}")
        css.append(f"@keyframes fr{f}{{{''.join(stops)}}}.fr{f}{{animation-name:fr{f}}}")
        uri = "data:image/png;base64," + b64(SPRITE_DIR / f"dante-{f}.png")
        els.append(
            f'<image class="a st sprite fr{f}" opacity="{1 if f == 0 else 0}" x="0" y="{sy}" width="{sw}" height="{sh}" href="{uri}"/>'
        )

    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {vw} {vh}" width="{vw}" height="{vh}">
<defs><linearGradient id="trail" x1="0" x2="1"><stop offset="0" stop-color="#ff6a00" stop-opacity="0"/><stop offset=".6" stop-color="#ffb52e"/><stop offset="1" stop-color="#fff6c0"/></linearGradient></defs>
<style>{''.join(css)}</style>
{''.join(els)}
</svg>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user")
    ap.add_argument("--out", required=True)
    ap.add_argument("--fake", action="store_true")
    args = ap.parse_args()
    if args.fake:
        cells = fake_levels()
    else:
        token = os.environ.get("GITHUB_TOKEN")
        if not (args.user and token):
            raise SystemExit("Informe --user e a variável GITHUB_TOKEN (ou use --fake).")
        cells = fetch_levels(args.user, token)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(build_svg(cells), encoding="utf-8")
    print(f"ok: {out} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
