# iSub brand assets

Concept **A — cap + stripes**: a spending *cap* line above three decreasing stripes. The stripes
read as invoice line-items (billing) and as Stripe-stripes; the cap above is iSub's differentiator —
the capped, revocable mandate ("the user always in control").

## Files

| File | Use |
| --- | --- |
| `isub-logo-light.svg` / `.png` | Full lockup (mark + wordmark) on **light** backgrounds |
| `isub-logo-dark.svg` / `.png` | Full lockup on **dark** backgrounds |
| `isub-mark-light.svg` / `.png` | Icon only, light backgrounds (app tiles, avatars) |
| `isub-mark-dark.svg` / `.png` | Icon only, dark backgrounds |
| `isub-mark-mono.svg` | Single-ink icon (`fill: currentColor`) — stamps, watermarks, one-color print |

The favicon lives at `web/app/icon.svg`; the React component at `web/components/logo.tsx`
(`<Logo/>` lockup, `<LogoMark/>` icon — the mark's cap uses `currentColor`, so it adapts to light/dark).

## Colors

| Token | Hex |
| --- | --- |
| Blue (Sui) | `#2b7fff` (dark UI: `#5aa2ff`) |
| Purple | `#7b5cff` |
| Pink | `#ff6fae` |
| Ink (cap + wordmark, light) | `#16161a` |
| Paper (cap + wordmark, dark) | `#ececf0` |

The three stripe colors are the same stops used by the homepage gradient headline, so the mark and
the site reinforce each other.

## Clear space & sizing

* Keep clear space ≥ the cap's height on all sides.
* Minimum mark size 16px (favicon). Below ~20px prefer the mark alone over the full lockup.
* Don't recolor the stripes, rotate the mark, add effects, or change the stripe order/decrease.
