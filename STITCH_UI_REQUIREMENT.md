# Stitch UI generation prompt — Greek Analysis (3-zone trend view)

Paste the section below into Google Stitch (stitch.withgoogle.com) to
generate a visual design for this screen. It describes the "Greek Analysis"
tab of a trading dashboard app.

---

## Prompt

Design a **"Greek Analysis"** screen for a trading dashboard web app (dark
finance/trading aesthetic, data-dense but readable). The screen has two
parts: a compact input form at the top, and a **3-zone results area** below
it that appears after the form is submitted.

### Input form (top of screen)
A single-row form with: Exchange (dropdown: NSE/BSE), Underlying Symbol
(text, e.g. "NIFTY"), Trading Symbol (text), Points Range (number, default
500), Expiry Date (date picker), and a primary "Start Greek Analysis"
button. Above the form, a small status line: "Auto-refreshing every 15
minutes" with a subtle live/pulsing indicator when a refresh is in progress.

### Results area — 3 side-by-side zones (stacking vertically on mobile)

**Zone 1 — "Latest" (leftmost, full visual emphasis)**
The most recent snapshot, refreshed every 15 minutes. Contains:
- A small "as of HH:MM:SS" timestamp badge.
- A 3-box range strip: Minimum / Current LTP / Maximum (₹ values), each
  color-coded (red for min, blue for current, green for max).
- A scrollable data table of option strikes: Strike, Type (CE/PE badge,
  green for CE / red for PE), LTP, OI, Delta, Gamma, Theta, Vega, Rho, IV.
- An AI analysis card below the table: a sentiment badge (Bullish=green,
  Bearish=red, Neutral=orange), Support/Resistance levels, a confidence
  percentage, then expandable sections for "Recommended Strategy", "Risk
  Assessment", and "Detailed Analysis".

**Zone 2 — "~15 Min Before" (middle, visually secondary/muted)**
Identical structure to Zone 1, but styled to read as "past" data — slightly
reduced opacity or a desaturated/greyscale tint, a muted-colored header, and
its own "as of HH:MM:SS" timestamp so it's clearly a different point in
time from Zone 1. Before the first auto-refresh happens, this zone shows a
simple empty-state message instead: "Waiting for the next auto-refresh cycle
to have a prior snapshot to show."

**Zone 3 — "Trend Comparison" (rightmost, distinct visual treatment from 1 & 2)**
An AI-generated interpretation of what changed between Zone 2 and Zone 1.
Not a table — a narrative/insight card:
- A prominent "Trend" badge: Strengthening (green), Weakening (orange),
  Reversing (red), or Unchanged (blue/grey).
- A confidence percentage for this trend read.
- Short labeled paragraphs: "LTP Change", "Sentiment Shift", "Updated
  Recommendation", "Narrative" — each a sentence or two of plain-language
  explanation, not raw numbers.
- Loading state: "Generating comparison inference..." while waiting.
- Before two snapshots exist yet: empty-state message "Comparison appears
  once there are two snapshots to compare."

### Visual language
- Consistent color coding across all 3 zones: green = bullish/positive/CE,
  red = bearish/negative/PE, orange = neutral/weakening, blue = informational.
- Cards with soft shadows, rounded corners, generous padding — data-dense
  but not cramped.
- Zone 1 should feel like the "hero" (full color, most prominent), Zone 2
  clearly secondary/muted, Zone 3 visually distinct as an "insight" panel
  rather than another data table (e.g. different background tint or an
  icon/accent marking it as AI-generated commentary).

---

## Reference: current implementation (for consistency, not required reading for Stitch)

This mirrors what's already built in `src/components/GreekAnalysis.jsx`,
`src/components/AnalysisSnapshotCard.jsx`, and `src/components/GreekAnalysis.css`
— existing class names: `.zones-grid`, `.zone`, `.snapshot-card`,
`.snapshot-card-latest` / `.snapshot-card-previous`, `.comparison-card`,
`.sentiment-bullish/bearish/neutral`, `.trend-strengthening/weakening/reversing/unchanged`.
If Stitch's output is used to restyle the screen, these are the hooks to
reuse rather than introducing a parallel class system.
