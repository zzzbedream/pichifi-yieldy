# Design System: PICHIFI — Editorial Financial Terminal

## 1. Visual Theme & Atmosphere
PICHIFI looks like a printed financial broadsheet that turned into a live trading terminal: warm paper surfaces, near-black ink, faint ruled lines like ledger paper, and figures set in monospace.
- Calm and auditable rather than flashy.
- Every colour carries meaning: a regime, or a leg of the vault. Colour is never decoration.
- Density is editorial. Large hero figures sit against small, tracked, uppercase labels.
- Hierarchy comes from scale contrast and hairline rules, not from shadows or gradients.

## 2. Color Palette & Roles
| Name | Hex (approx. of oklch source) | Role |
|---|---|---|
| Ledger Paper | `#F3EFE6` | Page background |
| Raised Paper | `#FAF8F3` | Cards, panels, the regime callout |
| Sunk Paper | `#EAE5DA` | Inputs, wells |
| Ink | `#14161B` | Primary text, strong rules, primary buttons (ink fill, paper text) |
| Soft Ink | `#545862` | Secondary text, descriptions |
| Faint Ink | `#8A8D94` | Placeholders, tertiary metadata |
| Hairline Rule | `#CFCBC2` | Dividers, ledger lines, card borders |
| Risk-On Green | `#0B914A` | RISK_ON regime, "verified" and "live" states |
| Volatile Amber | `#D9922A` | VOLATILE regime, warnings |
| Morpho Blue | `#3F5BBD` | Morpho lending leg, RISK_OFF regime |
| Uniswap Magenta | `#D9519C` | Uniswap v4 LP leg |
| Idle Hatch | `#BFBAB0` | Idle buffer, drawn as diagonal hatching |
| Error Red | `#C8453A` | Errors, rejections |

Dark mode inverts paper and ink (`#1B1D22` paper, `#ECE8DF` ink) and keeps the signal colours.

## 3. Typography Rules
- **IBM Plex Sans** (400/500/600) for headings and body. Headings are 600 with slightly tight tracking.
- **IBM Plex Mono** (400/500) for every number, address, hash, label and eyebrow.
- Eyebrows are mono, uppercase, letter-spaced (~0.12em), and small (0.72rem).
- The hero figure is mono, very large (clamp up to about 5.2rem), with tight tracking.
- Scale runs 0.72 / 0.84 / 0.95 / 1.15 / ~1.9 / ~5.2 rem.

## 4. Component Stylings
- **Buttons:** sharp, nearly square corners (2px radius).
  - Primary: solid ink fill with paper text.
  - Ghost: 1px ink outline on transparent.
  - Hover inverts or tints; focus draws a 2px offset ink ring.
- **Cards and panels:** Raised Paper, 1px hairline border, 2px radius. One soft, long, low-opacity shadow appears only on the featured callout. A 6px coloured top border marks the active regime.
- **Badges:** mono, small, 1px border, 2px radius. The "verified" badge uses Risk-On Green text and border.
- **Allocation bar:** a flat, full-width horizontal stacked bar (Morpho Blue, Uniswap Magenta, Idle Hatch) with no rounding, about 56px tall.
- **Inputs:** Sunk Paper fill, 1px ink border, mono text, with a "MAX" affordance inside.
- **Lists and feeds:** separated by hairline rules. Each entry carries a 4px left accent bar in its regime colour.

## 5. Layout Principles
- The max content width is about 1240px, with a fluid gutter (`clamp(1rem, 2vw, 2.5rem)`).
- Ruled background lines run every 64px, like ledger paper.
- Grids are asymmetric: a 2:1 main/side split for the app, and an editorial 7/5 split for the hero.
- Generous vertical rhythm between sections (3–6rem). Sections open with a mono eyebrow and a hairline rule.
- Motion is limited to transforms and opacity: the allocation bar eases with an expo-out curve over 700ms, and hovers take 160ms.
