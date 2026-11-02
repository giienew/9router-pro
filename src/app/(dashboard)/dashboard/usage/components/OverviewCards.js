"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtCost = (n) => `$${(n || 0).toFixed(4)}`;

// R8 sparkline: tiny SVG curve, flat, no library. `values` are the
// /api/usage/chart buckets for the current period.
// opt40: Catmull-Rom smoothing (curve passes through the exact same
// data points the old polyline did — only the stiff joints are gone)
// plus a flat low-opacity fill under the line. No gradient, no glow,
// no shadow: the fill is currentColor at 0.12, same flat color as the
// stroke, so the card palette is untouched.
function smoothPath(pts) {
  if (pts.length < 2) return "";
  let d = `M ${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

export function Sparkline({ values = [], className = "" }) {
  const vals = (values || []).map(Number).filter(Number.isFinite);
  if (vals.length < 2) return null;
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const span = max - min || 1;
  const w = 100;
  const h = 24;
  const pts = vals.map((v, i) => [((i / (vals.length - 1)) * w), (h - 2 - ((v - min) / span) * (h - 4))]);
  const line = smoothPath(pts);
  const fill = `${line} L ${w},${h} L 0,${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={`h-6 w-full ${className}`} aria-hidden="true">
      <path d={fill} fill="currentColor" fillOpacity="0.12" stroke="none" />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// Decorative line-art motif, like the reference cards: faint outline
// artwork floating at the card's right edge. Pure decoration, no data.
function Deco({ children, className = "" }) {
  return (
    <span aria-hidden="true" className={`pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 ${className}`} style={{ opacity: 0.16 }}>
      <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-16 w-16">
        {children}
      </svg>
    </span>
  );
}

export default function OverviewCards({ stats, series = null }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 sm:gap-4">
      <Card className="overview-hero relative flex min-w-0 flex-col items-start overflow-hidden text-left gap-1 px-3 py-3 sm:px-4">
        <span className="text-white/70 text-xs">Total Requests</span>
        <span className="w-full truncate text-3xl font-extrabold tracking-tight" title={fmt(stats.totalRequests)}>{fmt(stats.totalRequests)}</span>
        {series?.requests && <span className="w-full text-white/90"><Sparkline values={series.requests} /></span>}
        <Deco className="text-white">
          <circle cx="32" cy="32" r="22" />
          <path d="M32 32 L44 22" />
          <path d="M32 18 v-4 M18 32 h-4 M46 32 h4" />
        </Deco>
      </Card>
      <Card className="relative flex min-w-0 flex-col items-start overflow-hidden text-left gap-1 px-3 py-3 sm:px-4">
        <span className="text-text-muted text-xs">Total Input Tokens</span>
        <span className="w-full truncate text-3xl font-extrabold tracking-tight" title={fmt(stats.totalPromptTokens)}>{fmt(stats.totalPromptTokens)}</span>
        {series?.tokens && <span className="w-full text-primary"><Sparkline values={series.tokens} /></span>}
        <Deco className="text-primary">
          <path d="M32 12 L52 24 L32 36 L12 24 Z" />
          <path d="M12 32 L32 44 L52 32" />
          <path d="M12 40 L32 52 L52 40" />
        </Deco>
      </Card>
      <Card className="relative flex min-w-0 flex-col items-start overflow-hidden text-left gap-1 px-3 py-3 sm:px-4">
        <span className="text-text-muted text-xs">Cached Tokens</span>
        <span className="w-full truncate text-3xl font-extrabold tracking-tight" title={fmt(stats.totalCachedTokens)}>{fmt(stats.totalCachedTokens)}</span>
        {series?.cached && <span className="w-full text-info"><Sparkline values={series.cached} /></span>}
        <Deco className="text-info">
          <ellipse cx="32" cy="16" rx="18" ry="6" />
          <path d="M14 16 v28 c0 3.3 8 6 18 6 s18-2.7 18-6 V16" />
          <path d="M14 30 c0 3.3 8 6 18 6 s18-2.7 18-6" />
        </Deco>
      </Card>
      <Card className="relative flex min-w-0 flex-col items-start overflow-hidden text-left gap-1 px-3 py-3 sm:px-4">
        <span className="text-text-muted text-xs">Output Tokens</span>
        <span className="w-full truncate text-3xl font-extrabold tracking-tight" title={fmt(stats.totalCompletionTokens)}>{fmt(stats.totalCompletionTokens)}</span>
        {series?.completion && <span className="w-full text-success"><Sparkline values={series.completion} /></span>}
        <Deco className="text-success">
          <path d="M14 50 V34 M26 50 V26 M38 50 V18 M50 50 V30" />
          <path d="M10 54 H54" />
        </Deco>
      </Card>
      <Card className="relative flex min-w-0 flex-col items-start overflow-hidden text-left gap-1 px-3 py-3 sm:px-4">
        <span className="text-text-muted text-xs">Est. Cost</span>
        <span className="w-full truncate text-3xl font-extrabold tracking-tight" title={`~${fmtCost(stats.totalCost)}`}>~{fmtCost(stats.totalCost)}</span>
        <span className="text-[10px] text-text-muted">Estimated, not actual billing</span>
        {series?.cost && <span className="w-full text-warning"><Sparkline values={series.cost} /></span>}
        <Deco className="text-warning">
          <circle cx="32" cy="32" r="20" />
          <text x="32" y="41" textAnchor="middle" fontSize="26" fill="currentColor" stroke="none">$</text>
        </Deco>
      </Card>
    </div>
  );
}

OverviewCards.propTypes = {
  stats: PropTypes.object.isRequired,
  series: PropTypes.object,
};
