# 灵框 LingKuang v3 — 阈限梦核 (Liminal Dreamcore)

> Category: Dreamlike & Experimental
> An AI-driven plugin toolbox (Electron + React) dressed as a half-remembered dream. 8-bit VHS grain, abandoned liminal hallways, the hum of hard drives. Built for an 18-year-old art student who lives inside Threshold Spaces, Dreamcore, and the Backrooms.

## 1. Visual Theme & Atmosphere

灵框 v3 is not a productivity app that happens to be dark — it is a *place you pass through*. The interface borrows the emotional register of liminal space photography: the carpet of an empty mall at 3 AM, the recessed fluorescent light of an endless school corridor, the too-bright wall of a motel hallway that never ends, the faint VHS line-run of a paused videotape.

The presiding mood is **warm-washed-away**. Surfaces are not black — they are the color of old indoor lighting that has faded to a beige-tinted gray. Colors come through as if viewed through frosted glass: muted, desaturated, one step removed from reality. Nothing is crisply saturated. Nothing is pitch black. Everything looks like it was rendering seconds ago and will un-render the moment you stop looking.

Contrast it against the v2 "科技蓝" (tech-blue) dark theme: v3 removes the cold #2f5cff blue entirely. In its place is a sickly-but-soothing accent — the green-white of fluorescent tube light over old linoleum (`#b8d9c0` / `#d6e8da`), occasionally surfacing as soft "backrooms yellow" (`#e3c77a`) for the AI's voice. There are no hard shadows; depth comes from **subtle grain, gentle inset glow, and bled-out blurred edges** rather than drop shadows.

**Signature atmosphere techniques:**
- **VHS bloom / fug:** a faint, seated grain overlay across every surface, strongest at the edges of the viewport, weakening toward focus.
- **"Backroom cavity" panels:** plugin cards, chat bubbles, and dialogs all use a *very* slightly recessed, *very* slightly blurred inset treatment — like rooms you look into through a smudged partition, not floating UI cards.
- **Liminal dividers:** section separators are not hairlines but **threshold lines** — a 1px line with a faint stepped gap, like the joint between two walls that don't quite meet.
- **Cold-warm duality:** page chrome (chrome / chrome-panel / inputs) sits in a desaturated warm-gray; the AI accent and interactive highlights sit in fluorescent tube-green. The eye is *led* toward interactivity by temperature, not by weight.
- **Slow, breathing motion:** the AI panel "breathes" — its glow pulses on a ~8s cycle like an old CRT warming up. Interactions use longer, dreamier easing than a system tool would.

## 2. Color Palette & Roles

> **数值唯一来源 = `tokens.css`。** 2026-10-17 把本文件里的色值按应用**实际在跑**的值重写了一遍
> （此前 `tokens.css` 没被 import，本文与代码各写一份，漂了 4 处；见 `docs/UI-REVIEW-2026-10-17.md`）。

All colors are defined as desaturated, warm-washed tones. None exceed ~65% saturation; most hover in the 20–45% range. Nothing uses pure `#000`.

### Surface & Background (the "old hallway")
- **--bg / Canvas — 褪色的殿堂 `#c5c2ba`** — the faded-beige background that anchors the liminal look. It is *light*, not dark: the app feels like a bright-but-abandoned lobby where the light has burnt out the color. Text on it is a deep warm iron.
- **--surface / Panel — 蒙灰玻璃 `#d8d5cc`** — cardinal surfaced panel, slightly recessed and blurred (see tokens).
- **--surface-2 / 内墙 `#c9c6bd`** — a step-lighter interior surface for nested cards.
- **--surface-warm / 走廊暖壁 `#cfcec7`** — tertiary warm tier (aliases to surface in flat builds).
- **--chrome / 荧光框 `#17171a`** — the *only* true dark element: the sidebar rail and top command strip, acting as the "seam between rooms." Deep charcoal with a faint warm undertone, never pure black.
- **--chrome-2 / 暗房 `#232327`** — elevated dark surface (command palette, dialogs, floating AI window).

### Foreground / Text
- **--fg / 锈铅 `#232324`** — primary text on the light liminal canvas: a deep desaturated warm olive-black. Almost brown, almost green, always warm.
- **--fg-2 / 晕影 `#4e4c47`** — secondary tier.
- **--muted / 尘埃 `#9b998c`** — **装饰专用**（分隔线 / 滚动条 / 光晕）：亮底上只有 1.95:1，**不要用来写字**；文字的第二层级用 --fg-2。
- **--meta / 裂纹 `#514f47`** — tertiary / metadata tier（亮底 5.6:1）。
- **--fg-inverse / 荧光白 `#e8e7df`** — text on dark chrome surfaces; a VHS-pure, slightly warm white.

### Accent (the "fluor tube green" — the living thing in the liminal space)
- **--accent / 冷荧光绿 `#9ec262`** — the life-sign. A desaturated fluorescent-tube green (like old signage, like a glow-in-the-dark keychain). Used *sparingly*: the AI voice, the active nav indicator, the primary send/confirm action, selectable highlights. ≤2 visible uses per screen.
- **--accent-ink / 深橄榄绿 `#40601c`** — --accent 的**文字版**：亮底上 4.9:1（--accent 本身当文字只有 1.38:1）。链接、`color:var(--accent)` 的强调文字一律用它；--accent 只做底色/描边/进度。
- **--accent-2 / 后室黄 `#dfc073`** — the second, rarer living color: the yellow-wash of a backroom that's about to be discovered. Reserved for the AI avatar, "new" badges, and points of narrative emphasis.
- **--accent-on / 荧光白 `#17181a`** — foreground when --accent is the background (a deep mossy ink for contrast against the green).
- **--accent-hover / 荧光绿hover `#aecf76`** — slightly lifted fluorescent green.
- **--accent-active / 荧光绿active `#8cb455`** — slightly sunk fluorescent green.

### Semantic
- **--success / 苔痕绿 `#6f9e6f`** — success: deep, muted, moss-adjacent.
- **--warn / 锈黄 `#c9a24b`** — warning: the backrooms yellow, muted down.
- **--danger / 锈棕 `#833f24`** — danger: a rust brown rather than alarm red; stays inside the warm-washed palette（亮底文字 5.3:1，AA 过线）。

### Border
- **--border / 阈线 `#9a978e`** — default threshold line: a soft dark-ink line at low opacity.
- **--border-strong / 深阈线 `#6f6d66`** — stronger edge for focus / active states.
- **--border-soft / 淡阈线 `rgba(58,58,52,0.10)`** — inner divider that shouldn't compete.

### The "Under-Construction" note
The palette intentionally sits *between* light and dark. Do not "fix" it toward a neutral bootstrap gray or toward a saturated brand theme. The strangeness — beige lit by fluorescent green — *is* the design. When in doubt, ask: "would this read as a real app, or as a place?" Favor the place.

## 3. Typography

Typefaces are chosen to feel *hand-recorded* and slightly displaced — like the off-screen narration in a dream you can almost remember.

- **--font-display: 悠然宋 / display** — a relaxed serif with noticeable stroke contrast, slightly loose tracking. Evokes the worn metal print of an old school-room sign. Fallback: `Georgia, "Songti SC", "Noto Serif SC", serif`.
- **--font-body: 静谧黑 / primary sans** — a quiet, slightly-rounded humanist sans for UI body text; wide x-height, calm. Fallback: `system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`.
- **--font-mono: 断电 / mono** — a thin, terminals-adjacent monospace for timestamps, command hints, and the whisper of the machine. Fallback: `"JetBrains Mono", "SF Mono", "Cascadia Code", monospace`.

Type philosophy: **the interface whispers, the serif is the memory.** Body/UI copy is light and low-emphasis (keeps the liminal calm). Display/serif typography is reserved for the product name, plugin titles, and any single line that should feel like *a memory you're recalling* rather than a label.

| Role | Family | Size | Weight | Leading | Notes |
|------|--------|------|--------|---------|-------|
| Product wordmark | display (serif) | 22px | 500 | 1.2 | Letter-spacing 0.06em, slight all-caps optional |
| Plugin / window title | body (sans) | 15px | 500 | 1.3 | The quiet workhorse label |
| Section eyebrow | mono | 11px | 400 | 1.4 | Uppercase, letter-spacing 0.14em — the "machine whisper" |
| Body / copy | body (sans) | 13px | 400 | 1.65 | Default chat + descriptions |
| Caption / meta | body (sans) | 12px | 400 | 1.5 | Colors via --muted / --meta |
| AI nameplate | display (serif) | 16px | 500 | 1.3 | For the AI persona moments |
| Keycap / kbd | mono | 11px | 400 | 1 | Recessed pill background |
| Timestamp | mono | 11px | 400 | 1.4 | Lower opacity, sits in corner |

### Token type scale (OD A1-structure)
- `--text-xs: 0.75rem` (12px)
- `--text-sm: 0.8438rem` (13.5px)
- `--text-base: 0.9375rem` (15px)
- `--text-lg: 1.125rem` (18px)
- `--text-xl: 1.375rem` (22px) — wordmark tier
- `--text-2xl: 1.75rem` (28px) — the "one remembered heading"
- `--text-3xl: 2.25rem` (36px) — hero / welcome
- `--text-4xl: 3rem` (48px) — rare; the empty-lobby statement

- `--leading-tight: 1.25`
- `--leading-body: 1.65`
- `--tracking-display: 0.06em`
- `--tracking-eyebrow: 0.14em`

## 4. Spacing & Grid

Base unit **8px** (peaceful, roomy). The liminal mood rewards generous silence — leave more space than a dense tool would, especially around the edges of the canvas and between cards.

- `--space-1: 4px` `--space-2: 8px` `--space-3: 12px` `--space-4: 16px` `--space-5: 20px` `--space-6: 24px` `--space-8: 32px` `--space-12: 48px`

Layout rules:
- **Sidebar rail**: dark chrome strip, `220px` expanded / `56px` collapsed. Feels like the seam; icons sit in recessed slots.
- **Content canvas**: the light liminal lobby. Plugin cards sit in a loose responsive grid (`repeat(auto-fill, minmax(260px, 1fr))`) with generous `24px` gutters.
- **Canvas workspace**: a boundless `12000 × 12000px` infinite pannable "backroom" — plugin windows are absolute-positioned and freely arranged.
- **Chat/dock**: recessed warm panel at the bottom or a floating dark chrome window; never visually heavier than the content behind it.
- **Section rhythm (structure)**: `--section-y-desktop: 56px`, `--section-y-tablet: 40px`, `--section-y-phone: 28px`.

## 5. Layout & Composition

The composition is a **threshold narrative**:
1. **The Seam** (dark chrome sidebar + top command strip) — where you enter. Holds navigation, plugin list, window controls.
2. **The Lobby** (light canvas) — the plugin grid / active workspace. This is where the tools live, and because it is *lit*, it draws the eye away from the dark seam.
3. **The Hum** (AI panel) — a floating dark chrome window with a green glow, slightly askew from the grid, like a doorway slightly ajar.

**Principle — *light is signal, dark is structure.*** Interactive and living elements live on light surfaces with green fluorescent accent; the persistent app chrome lives in dark. A user should be able to tell, from across the room, where the "living" part of the app is.

## 6. Components

### Buttons
- **Primary / 荧光绿** — `--accent` background, `--accent-on` (deep moss ink) text, `--radius-md` (8px). On hover lift to `--accent-hover`. No drop shadow — instead a soft outer **bloom** (see elevation). Used for: send, confirm, the one obvious action.
- **Secondary / 亮面灰** — `--surface-2` background, `--border` threshold line, `--fg` text. Quiet, warm, inland.
- **Ghost / 镂空** — transparent, `--muted` text; only underlines on hover. For tertiary actions.
- **Icon button** — 32×32 recessed (inset) square; icon in `--meta`; hover lifts to `--fg`. The recessed-inset is a key liminal signature.

### Cards (plugin gallery)
- Background `--surface`, threshold line `--border`, `--radius-lg` (12px), interior `20px`.
- **Recessed, not raised**: `box-shadow: inset 0 1px 2px rgba(58,58,52,.08), 0 0 0 1px var(--border)`. The card reads as a *niche in the wall*, not a card on the table.
- Hover: the threshold line darkens to `--border-strong`, and a faint fluorescent-green corner glow appears (a small `::after` with `--accent` at low opacity). This is the only place green can "peek."
- Icon slot: a `40×40` recessed tile holding a large emoji/icon in desaturated tone.

### Windows (canvas workspace) & Dialogs
- Dark chrome background `--chrome-2`, `--radius-xl` (16px), threshold line, low-blur.
- Title bar uses the mono eyebrow for the timestamp and the quiet sans for the title.
- Dialogs (command palette) share the same dark recessed language, centered, with a soft bloom.

### Chat
- **AI message**: recessed light bubble `--surface-2` with a **faint green edge** on the left (a thin `--accent`-tinted `1px` left border) — the "living" edge. Text in `--fg`.
- **User message**: `--accent` background, `--accent-on` text, aligned right — the one moment of real presence.
- **AI avatar / seed**: a small serif glyph (e.g. `灵`) in `--accent-2` yellow-wash, inside a recessed tile.

### Inputs
- Recessed field: `--surface-2` background, inset shadow, `--border` line. On focus the line warms to a green-tinted `--border-strong` and gains a soft bloom.
- Placeholder in `--meta`.

### Navigation / Sidebar
- Nav items: icon + quiet label in `--meta`; active item gets a recessed slot plus a **1px green seam** on its left edge, label in `--fg`.
- Section headers are mono eyebrows ("机器" / "插件" / "归档").

## 7. Motion & Interaction

Motion is slow and breath-like, on the "dream" end of the scale — deliberate, not snappy.

- `--motion-fast: 180ms` `--motion-base: 320ms` `--motion-slow: 640ms`
- `--ease-standard: cubic-bezier(0.22, 0.75, 0.25, 1)` — a long, easy settle.
- **The Breath (signature):** the AI glow pulses between `var(--accent)` and `var(--accent)` mixed toward transparent on a **8s** cycle (`@keyframes breath`). Like a CRT powering up. Reserve it for the AI avatar / send button only.
- **Waking fade:** on first mount, the lobby content fades+rises slightly (opacity 0→1, translateY 8px→0, 640ms each, staggered ~40ms per card) — the app "wakes up" into the liminal space.
- **Window arrange:** windows gently scale+smooth into place when dragged/resolved (a settle bounce, `--ease-standard`).
- Respect `prefers-reduced-motion`: disable the breath and staggers; use only `--motion-fast` fades.

## 8. Voice & Brand

The brand voice is **quiet, observant, a little haunted** — the app speaks like the intro narration of a dreamcore video, not like a CLI or a marketer.

- The AI introduces itself as if it has been waiting here a long time.
- Microcopy is lowercase, brief, and slightly poetic without being pretentious. Avoid exclamation marks, avoid corporate fillers, avoid "✨" spam.
- Examples:
  - Empty state: `这里暂时空着。你走后,灯会开多久?` (It's empty here. How long will the lights stay on after you leave?)
  - Chat greeting: `我在。(I'm here.)`
  - Loading state: `仍然在这里。` (Still here.)
- Labels stay literal and usable (按钮、搜索、设置) — poetry lives in the empty states and the AI, not in navigation.

## 9. Anti-patterns

- **Do not** reintroduce a saturated brand blue (`#2f5cff`, `#5484ff`, etc.) anywhere. v3's palette rejects the old tech-blue identity.
- **Do not** use pure black (`#000`) or true white (`#fff`) — everything sits in the warm-washed middling range or the deep warm charcoal.
- **Do not** use hard drop shadows that make elements "float." Depth is **recessed** (inset) and **blurred** — walls and niches, not stacked cards.
- **Do not** saturate the semantic colors to STOP-sign red / traffic green. Danger is rust, success is moss.
- **Do not** overuse the fluorescent accent. ≤2 visible accent elements per screen; the rest must read as quiet muted warmth.
- **Do not** make the chrome heavier than the content. The dark seam is thin and structural; the lit lobby is the actual workspace.
- **Do not** use the serif display face for UI labels — reserve it for memory-lines: wordmark, plugin titles, the AI nameplate.
- **Do not** speed up the motion to feel like a snappy developer tool. The dream registers at 300ms+, not 150ms.
- **Do not** add confetti, gradients-for-pop, or other "delight" that breaks the threshold atmosphere. If it feels celebratory, it's wrong.

## 10. Agent Prompt Guide

### Quick color reference
- Canvas (lobby): "褪色的殿堂 — 暖灰米 `#c5c2ba`"
- Sidebar seam (dark): "荧光框 — 暖炭 `#0f0f11`"
- Panel: "蒙灰玻璃 — `#cecbc7`" (cool name: 蒙灰玻璃)
- Primary text (light): "锈铅 `#3a3a34`"
- Accent (living): "冷荧光绿 `#9ec262`"
- AI/second accent: "后室黄 `#dfc073`"
- Danger: "锈棕 `#a8603f`"
- Success: "苔痕绿 `#6f9e6f`"

### Example component prompts
- "Render the primary AI action as a `--accent` (冷荧光绿 #9ec262) recessed pill button, text `--accent-on`, no drop shadow — only a soft outer green bloom. Add the 8s 'breath' pulse to its glow."
- "Build a plugin gallery card as a *niche in the wall*: `--surface` background, `--radius-lg`, interior 20px, `box-shadow: inset 0 1px 2px rgba(58,58,52,.08), 0 0 0 1px var(--border)`. On hover, darken the threshold line and add a faint green corner glow."
- "Create the sidebar seam: dark `--chrome`, 220px; each nav item recessed, with the active one gaining a 1px green left seam and `--fg` label; section headers as uppercase mono eyebrows."
- "Render the AI chat hum: a floating dark chrome window with a green edge on each AI message; the AI greets with the serif display face in `--accent-2` 后室黄."
