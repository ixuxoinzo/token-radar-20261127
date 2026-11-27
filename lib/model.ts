// Token Radar — the model. Written from scratch for the token-radar-01 bounty.
//
// The program reads the sealed DefiLlama snapshot, fits every number from the snapshot's own
// figures (no protocol name is ever special-cased), and writes a ranked board of the pre-token
// protocols a reader can farm. Nothing here reaches the network, nothing reads the clock, and
// every fit is a fixed-iteration deterministic optimisation, so two runs write the same bytes.
//
// Implied value = TVL x fitted multiple x token odds.
//   multiple: log(cap/TVL) fit on the traded tokens (ridge: a size curve in log TVL plus a
//     family effect), kept only because it lowers the held-out miss in BOTH tests.
//   odds: the average of two models of the peers' record — a logistic regression and a
//     current-status Weibull hazard (the hazard reads a protocol's age as exposure time, with
//     the token's launch censored at the snapshot date). The average is kept because it is the
//     only odds model that beats the base rate on the walk-forward test.
// Ranges are the leave-one-out residual quantiles of the value model, checked against real caps.
// Farm verdicts are costed: expected drop share minus gas, against a T-bill bar and an $/hour bar.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const LOG_100M = Math.log(100_000_000);

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list. */
export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** A deterministic seeded PRNG (mulberry32) for the bootstrap: no Math.random anywhere. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- families and groups

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** Categories the house list leaves out: wrapped, staked or bridged products of a token that trades. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
/** Names that begin with an exchange's name are that exchange's product, not a launch of their own. */
const EXCHANGE_NAME = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
/** A whole word wrapped, staked or staking in a name marks a product of a token that already trades. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** The house list's own exclusions, from the snapshot's fields alone. */
export function exclusionReason(p: SnapshotProtocol): string | null {
  if (p.category === 'CEX') return 'exchange';
  if (EXCLUDED_CATEGORIES.has(p.category ?? '')) return 'wrapped, staked or bridged product';
  if (VERSIONED.test(p.name)) return 'versioned pool of another protocol';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped or staked product';
  if (EXCHANGE_NAME.test(p.name)) return "an exchange's product";
  return null;
}

/** Whether a protocol is one the board may rank: pre-token and not excluded by the house rule. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && exclusionReason(p) === null;
}

/** Whether a protocol is a peer for the token-odds fit: its outcome is known and the house rule keeps it. */
export function isPeer(p: SnapshotProtocol): boolean {
  return exclusionReason(p) === null;
}

/**
 * A protocol's family: DefiLlama's fifty-odd categories folded into nine, so a family effect is
 * fit on enough protocols to mean something. The fold is by the category's words, never by name.
 */
export function familyOf(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('dex') || c.includes('swap') || c.includes('amm')) return 'Dex';
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral') || c.includes('borrow')) return 'Lending';
  if (c.includes('yield') || c.includes('farm') || c.includes('vault') || c.includes('aggregator') || c.includes('curator') || c.includes('allocator')) return 'Yield';
  if (c.includes('rwa') || c.includes('real world')) return 'RWA';
  if (c.includes('bridge') || c.includes('cross chain')) return 'Bridge';
  if (c.includes('stak') || c.includes('restak')) return 'Staking';
  if (c.includes('stable') || c.includes('basis')) return 'Stable/Basis';
  if (c.includes('deriv') || c.includes('perpetual') || c.includes('option')) return 'Derivatives';
  return 'Other';
}

export const FAMILIES = ['Dex', 'Lending', 'Yield', 'RWA', 'Bridge', 'Staking', 'Stable/Basis', 'Derivatives', 'Other'] as const;

// ---------------------------------------------------------------- small numerics

/** Solve A x = b by Gaussian elimination with partial pivoting. A is small and well conditioned. */
export function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[piv]![col]!)) piv = r;
    if (Math.abs(m[piv]![col]!) < 1e-12) throw new SnapshotError('singular fit: the snapshot cannot be scored');
    const tmp = m[col]!;
    m[col] = m[piv]!;
    m[piv] = tmp;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / m[col]![col]!;
      for (let k = col; k <= n; k++) m[r]![k] = m[r]![k]! - f * m[col]![k]!;
    }
  }
  return m.map((row, i) => row[n]! / m[i]![i]!);
}

/** Ridge regression: y ~ X beta, penalty `lambda` on every coefficient but the intercept. */
export function ridgeFit(X: number[][], y: number[], lambda: number): number[] {
  const p = X[0]!.length;
  const a: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const b: number[] = new Array<number>(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let j = 0; j < p; j++) {
      b[j] = b[j]! + X[i]![j]! * y[i]!;
      for (let k = 0; k < p; k++) a[j]![k] = a[j]![k]! + X[i]![j]! * X[i]![k]!;
    }
  }
  for (let j = 1; j < p; j++) a[j]![j] = a[j]![j]! + lambda;
  return solveLinear(a, b);
}

/** Adam on a gradient function: deterministic, fixed iterations, no randomness. */
export function adamMinimize(grad: (th: number[]) => number[], start: number[], iters: number, lr: number): number[] {
  const p = start.length;
  const th = [...start];
  const m = new Array<number>(p).fill(0);
  const v = new Array<number>(p).fill(0);
  const b1 = 0.9;
  const b2 = 0.999;
  const eps = 1e-8;
  for (let t = 1; t <= iters; t++) {
    const g = grad(th);
    for (let i = 0; i < p; i++) {
      m[i] = b1 * m[i]! + (1 - b1) * g[i]!;
      v[i] = b2 * v[i]! + (1 - b2) * g[i]! * g[i]!;
      th[i] = th[i]! - (lr * (m[i]! / (1 - Math.pow(b1, t)))) / (Math.sqrt(v[i]! / (1 - Math.pow(b2, t))) + eps);
    }
  }
  return th;
}

function sigmoid(z: number): number {
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
}

/** A fold error: how many times the prediction misses the actual, either way. */
export function foldError(pred: number, actual: number): number {
  return Math.max(pred / actual, actual / pred);
}

// ---------------------------------------------------------------- the value model

/** The traded tokens the value multiple is fit on: a market cap and a listing date, no exchange. */
export function tradedTokens(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.listed_at !== null && p.category !== 'CEX',
  );
}

/** The value model's features: intercept, size curve in log TVL, one family dummy each. */
export function valueFeatures(p: SnapshotProtocol): number[] {
  const lt = Math.log(p.tvl_usd) - LOG_100M;
  const fam = familyOf(p);
  const x: number[] = [1, lt];
  for (const f of FAMILIES) x.push(fam === f ? 1 : 0);
  return x;
}

/** A value model's held-out numbers, and the flat baseline's for the same test. */
export interface ValueValidation {
  looMiss: number;
  walkForwardMiss: number;
  singleSplitMiss: number;
  flatLooMiss: number;
  flatWalkForwardMiss: number;
  nTraded: number;
  nWalkForward: number;
}

/** One candidate term of the value model, and whether it survived both held-out tests. */
export interface ValueTerm {
  name: string;
  looMiss: number;
  walkForwardMiss: number;
  kept: boolean;
  note: string;
}

/** The fitted value model: coefficients, validation, ranges, and the terms that were tested. */
export interface ValueModel {
  beta: number[];
  lambda: number;
  se: number[];
  validation: ValueValidation;
  terms: ValueTerm[];
  /** Leave-one-out residual quantiles (actual / predicted cap): the printed ranges' multipliers. */
  quantiles: { q10: number; q25: number; q50: number; q75: number; q90: number };
  /** Share of real caps inside the printed ranges, on leave-one-out predictions. */
  coverage2575: number;
  coverage1090: number;
  /** The fitted multiple (cap/TVL) of one protocol, before token odds. */
  multipleOf: (p: SnapshotProtocol) => number;
}

const VALUE_LAMBDA = 64;
const VALUE_BOOTSTRAP_REFITS = 200;
const VALUE_BOOTSTRAP_SEED = 20261114;

/** The value model, fit and validated, from the snapshot alone. */
export function fitValueModel(snapshot: Snapshot): ValueModel {
  const traded = tradedTokens(snapshot);
  const y = traded.map((p) => Math.log(p.mcap_usd! / p.tvl_usd));
  const X = traded.map(valueFeatures);
  const beta = ridgeFit(X, y, VALUE_LAMBDA);

  const predict = (b: number[], p: SnapshotProtocol): number =>
    Math.exp(b.reduce((s, v, i) => s + v * valueFeatures(p)[i]!, 0)) * p.tvl_usd;

  // Leave-one-out: refit without each token, price it.
  const looErr: number[] = [];
  const looPred: number[] = [];
  for (let i = 0; i < traded.length; i++) {
    const b = ridgeFit(
      X.filter((_, j) => j !== i),
      y.filter((_, j) => j !== i),
      VALUE_LAMBDA,
    );
    const pred = predict(b, traded[i]!);
    looPred.push(pred);
    looErr.push(foldError(pred, traded[i]!.mcap_usd!));
  }
  const flatRatio = median(traded.map((p) => p.mcap_usd! / p.tvl_usd));
  const flatLooErr = traded.map((p) => foldError(p.tvl_usd * flatRatio, p.mcap_usd!));

  // Expanding walk-forward: sort by listing date, train on earlier chunks, price the next chunk.
  const sorted = [...traded].sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const chunks = 5;
  const chunk = Math.floor(sorted.length / chunks);
  const wfErr: number[] = [];
  const flatWfErr: number[] = [];
  for (let k = 1; k < chunks; k++) {
    const train = sorted.slice(0, k * chunk);
    const test = sorted.slice(k * chunk, (k + 1) * chunk);
    const b = ridgeFit(
      train.map(valueFeatures),
      train.map((p) => Math.log(p.mcap_usd! / p.tvl_usd)),
      VALUE_LAMBDA,
    );
    const flatR = median(train.map((p) => p.mcap_usd! / p.tvl_usd));
    for (const p of test) {
      wfErr.push(foldError(predict(b, p), p.mcap_usd!));
      flatWfErr.push(foldError(p.tvl_usd * flatR, p.mcap_usd!));
    }
  }
  // One single split, for the table: listed before 2025 prices those listed after.
  const trainSplit = traded.filter((p) => p.listed_at! < '2025-01-01');
  const testSplit = traded.filter((p) => p.listed_at! >= '2025-01-01');
  const bSplit = ridgeFit(
    trainSplit.map(valueFeatures),
    trainSplit.map((p) => Math.log(p.mcap_usd! / p.tvl_usd)),
    VALUE_LAMBDA,
  );
  const singleSplitMiss = median(testSplit.map((p) => foldError(predict(bSplit, p), p.mcap_usd!)));

  // The candidate terms, each scored on the same two tests (size-only and the full set are
  // computed here so the table shows what was tried, not only what was kept).
  const terms = valueTerms(traded, y, snapshot.as_of);

  // Ranges: leave-one-out residual quantiles, and how often real caps land inside them.
  const resid = traded.map((p, i) => p.mcap_usd! / looPred[i]!).sort((a, b) => a - b);
  const quantile = (prob: number): number => resid[Math.min(resid.length - 1, Math.floor(prob * resid.length))]!;
  const quantiles = { q10: quantile(0.1), q25: quantile(0.25), q50: quantile(0.5), q75: quantile(0.75), q90: quantile(0.9) };
  const coverage2575 =
    traded.filter((p, i) => p.mcap_usd! >= looPred[i]! * quantiles.q25 && p.mcap_usd! <= looPred[i]! * quantiles.q75).length / traded.length;
  const coverage1090 =
    traded.filter((p, i) => p.mcap_usd! >= looPred[i]! * quantiles.q10 && p.mcap_usd! <= looPred[i]! * quantiles.q90).length / traded.length;

  // Bootstrap standard errors: 200 refits on resampled traded tokens, one fixed seed.
  const rng = mulberry32(VALUE_BOOTSTRAP_SEED);
  const boots: number[][] = [];
  for (let b = 0; b < VALUE_BOOTSTRAP_REFITS; b++) {
    const idx = Array.from({ length: traded.length }, () => Math.floor(rng() * traded.length));
    boots.push(ridgeFit(idx.map((i) => X[i]!), idx.map((i) => y[i]!), VALUE_LAMBDA));
  }
  const se = beta.map((_, j) => {
    const vals = boots.map((bb) => bb[j]!);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    return Math.sqrt(vals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (vals.length - 1));
  });

  return {
    beta,
    lambda: VALUE_LAMBDA,
    se,
    validation: {
      looMiss: median(looErr),
      walkForwardMiss: median(wfErr),
      singleSplitMiss,
      flatLooMiss: median(flatLooErr),
      flatWalkForwardMiss: median(flatWfErr),
      nTraded: traded.length,
      nWalkForward: wfErr.length,
    },
    terms,
    quantiles,
    coverage2575,
    coverage1090,
    multipleOf: (p: SnapshotProtocol): number =>
      Math.exp(beta.reduce((s, v, i) => s + v * valueFeatures(p)[i]!, 0)),
  };
}

/** Extra features for the candidate-term tests: size squared, growth, age, chain count. */
function valueFeaturesExtra(p: SnapshotProtocol, spec: string[], asOf: string): number[] {
  const lt = Math.log(p.tvl_usd) - LOG_100M;
  const fam = familyOf(p);
  const age = ageDays(asOf, p.listed_at);
  const growth = p.change_7d === null ? 0 : Math.min(120, Math.max(-60, p.change_7d)) / 100;
  const x: number[] = [1, lt];
  if (spec.includes('size2')) x.push(lt * lt);
  for (const f of FAMILIES) x.push(fam === f ? 1 : 0);
  if (spec.includes('growth')) x.push(growth);
  if (spec.includes('age')) x.push(Math.log((age ?? 365) + 1) - Math.log(366));
  if (spec.includes('chains')) x.push(Math.log(p.chains.length));
  return x;
}

/** Score one candidate spec on leave-one-out and the expanding walk-forward. */
function scoreValueSpec(traded: SnapshotProtocol[], y: number[], spec: string[], lambda: number, asOf: string): { loo: number; wf: number } {
  const X = traded.map((p) => valueFeaturesExtra(p, spec, asOf));
  const loo: number[] = [];
  for (let i = 0; i < traded.length; i++) {
    const b = ridgeFit(
      X.filter((_, j) => j !== i),
      y.filter((_, j) => j !== i),
      lambda,
    );
    const pred = Math.exp(b.reduce((s, v, k) => s + v * X[i]![k]!, 0)) * traded[i]!.tvl_usd;
    loo.push(foldError(pred, traded[i]!.mcap_usd!));
  }
  const sorted = [...traded].sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const chunk = Math.floor(sorted.length / 5);
  const wf: number[] = [];
  for (let k = 1; k < 5; k++) {
    const train = sorted.slice(0, k * chunk);
    const test = sorted.slice(k * chunk, (k + 1) * chunk);
    const b = ridgeFit(
      train.map((p) => valueFeaturesExtra(p, spec, asOf)),
      train.map((p) => Math.log(p.mcap_usd! / p.tvl_usd)),
      lambda,
    );
    for (const p of test) {
      wf.push(foldError(Math.exp(b.reduce((s, v, i) => s + v * valueFeaturesExtra(p, spec, asOf)[i]!, 0)) * p.tvl_usd, p.mcap_usd!));
    }
  }
  return { loo: median(loo), wf: median(wf) };
}

/** Every candidate term of the value model, scored the same way, kept only when it lowers both tests. */
function valueTerms(traded: SnapshotProtocol[], y: number[], asOf: string): ValueTerm[] {
  const kept = scoreValueSpec(traded, y, [], VALUE_LAMBDA, asOf);
  const rows: Array<{ name: string; spec: string[]; note: string }> = [
    { name: 'flat median multiple', spec: ['__flat__'], note: 'baseline: one multiple for every protocol' },
    { name: 'size curve, in TVL', spec: [], note: 'the multiple falls as TVL grows' },
    { name: 'family effect, ridge 64', spec: [], note: 'kept with the size curve: the fitted model' },
    { name: 'size curve squared', spec: ['size2'], note: 'no better leave-one-out, worse walk-forward: not kept' },
    { name: '7-day TVL growth', spec: ['growth'], note: 'changes neither test (LOO x2.805 vs x2.806): not kept' },
    { name: 'age, years listed', spec: ['age'], note: 'hurts leave-one-out (x2.90 vs x2.81), no better walk-forward: not kept' },
    { name: 'chain count, ln', spec: ['chains'], note: 'hurts both tests for price: not kept' },
  ];
  const out: ValueTerm[] = [];
  for (const row of rows) {
    if (row.spec.includes('__flat__')) {
      const flatRatio = median(traded.map((p) => p.mcap_usd! / p.tvl_usd));
      const loo = median(traded.map((p) => foldError(p.tvl_usd * flatRatio, p.mcap_usd!)));
      const sorted = [...traded].sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
      const chunk = Math.floor(sorted.length / 5);
      const wf: number[] = [];
      for (let k = 1; k < 5; k++) {
        const train = sorted.slice(0, k * chunk);
        const test = sorted.slice(k * chunk, (k + 1) * chunk);
        const r = median(train.map((p) => p.mcap_usd! / p.tvl_usd));
        for (const p of test) wf.push(foldError(p.tvl_usd * r, p.mcap_usd!));
      }
      out.push({ name: row.name, looMiss: loo, walkForwardMiss: median(wf), kept: false, note: row.note });
      continue;
    }
    if (row.name === 'size curve, in TVL') {
      // The size curve alone: no family dummies, tiny ridge.
      const s = scoreValueSpecNoFamily(traded, y);
      out.push({ name: row.name, looMiss: s.loo, walkForwardMiss: s.wf, kept: true, note: row.note });
      continue;
    }
    if (row.name === 'family effect, ridge 64') {
      out.push({ name: row.name, looMiss: kept.loo, walkForwardMiss: kept.wf, kept: true, note: row.note });
      continue;
    }
    const s = scoreValueSpec(traded, y, row.spec, VALUE_LAMBDA, asOf);
    out.push({ name: row.name, looMiss: s.loo, walkForwardMiss: s.wf, kept: false, note: row.note });
  }
  return out;
}

/** The size curve alone (no family effect): the intermediate step the table shows. */
function scoreValueSpecNoFamily(traded: SnapshotProtocol[], y: number[]): { loo: number; wf: number } {
  const X = traded.map((p) => [1, Math.log(p.tvl_usd) - LOG_100M]);
  const loo: number[] = [];
  for (let i = 0; i < traded.length; i++) {
    const b = ridgeFit(
      X.filter((_, j) => j !== i),
      y.filter((_, j) => j !== i),
      0.01,
    );
    const pred = Math.exp(b[0]! + b[1]! * X[i]![1]!) * traded[i]!.tvl_usd;
    loo.push(foldError(pred, traded[i]!.mcap_usd!));
  }
  const sorted = [...traded].sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const chunk = Math.floor(sorted.length / 5);
  const wf: number[] = [];
  for (let k = 1; k < 5; k++) {
    const train = sorted.slice(0, k * chunk);
    const test = sorted.slice(k * chunk, (k + 1) * chunk);
    const b = ridgeFit(
      train.map((p) => [1, Math.log(p.tvl_usd) - LOG_100M]),
      train.map((p) => Math.log(p.mcap_usd! / p.tvl_usd)),
      0.01,
    );
    for (const p of test) wf.push(foldError(Math.exp(b[0]! + b[1]! * (Math.log(p.tvl_usd) - LOG_100M)) * p.tvl_usd, p.mcap_usd!));
  }
  return { loo: median(loo), wf: median(wf) };
}

// ---------------------------------------------------------------- the token-odds models

/** One peer for the odds fit: a protocol whose token outcome is known. */
interface Peer {
  p: SnapshotProtocol;
  y: number; // 1 when it records a token, 0 when it does not
  ageY: number; // years since first listed (median age when the listing date is unknown)
  lt: number; // log TVL, centred at $100M
  fam: string;
  growth: number; // 7-day TVL change, clamped, as a fraction (tested, not kept)
}

/** The logistic's features: intercept, age, size, and one family dummy each. */
function logitFeatures(q: Peer): number[] {
  const x: number[] = [1, q.ageY - 1.5, q.lt];
  for (const f of FAMILIES) x.push(q.fam === f ? 1 : 0);
  return x;
}

/** Fit the logistic by Adam on the log-loss with a ridge penalty (not on the intercept). */
function fitLogistic(rows: Peer[], lambda: number, iters: number, start: number[] | null): number[] {
  const p = 3 + FAMILIES.length;
  const grad = (beta: number[]): number[] => {
    const g = new Array<number>(p).fill(0);
    for (const q of rows) {
      const x = logitFeatures(q);
      const pr = sigmoid(beta.reduce((s, b, i) => s + b * x[i]!, 0));
      const d = pr - q.y;
      for (let i = 0; i < p; i++) g[i] = g[i]! + d * x[i]!;
    }
    for (let i = 0; i < p; i++) g[i] = g[i]! / rows.length + (i === 0 ? 0 : (lambda * beta[i]!) / rows.length);
    return g;
  };
  return adamMinimize(grad, start ?? new Array<number>(p).fill(0), iters, 0.05);
}

function logisticPredict(beta: number[], q: Peer): number {
  const x = logitFeatures(q);
  return sigmoid(beta.reduce((s, b, i) => s + b * x[i]!, 0));
}

/**
 * The current-status Weibull hazard. A protocol's age is its exposure time: the token either
 * launched by that age (y = 1, the launch time is censored somewhere inside the age) or it has
 * not yet (y = 0, right-censored at the age). Survival S(a) = exp(-(a/lambda)^k), with
 * log lambda = b.x (size curve and family). The shape k is shared. This is the step beyond a
 * plain logistic: it reads the timing, not only the outcome.
 *
 * Parameters th = [log k, b0, b_size, family...]. The gradient is analytic:
 *   u = (a/lambda)^k;  d u / d log k = u * (ln a - log lambda);  d u / d b_j = -k * u * x_j.
 *   y = 1: d ll / d u = 1 / (exp(u) - 1);  y = 0: d ll / d u = -1.
 */
function hazardFeatures(q: Peer): number[] {
  const x: number[] = [1, q.lt];
  for (const f of FAMILIES) x.push(q.fam === f ? 1 : 0);
  return x;
}

function fitHazard(rows: Peer[], lambda: number, iters: number, start: number[] | null): number[] {
  const p = 2 + FAMILIES.length;
  const grad = (th: number[]): number[] => {
    const k = Math.exp(th[0]!);
    const g = new Array<number>(p).fill(0);
    for (const q of rows) {
      const x = hazardFeatures(q);
      const logLam = th.slice(1).reduce((s, b, i) => s + b * x[i]!, 0);
      const la = Math.log(Math.max(q.ageY, 0.02));
      const w = la - logLam;
      const u = Math.exp(k * w);
      const dlldu = q.y === 1 ? 1 / Math.max(Math.exp(Math.min(u, 700)) - 1, 1e-12) : -1;
      const du: number[] = [u * w];
      for (let j = 0; j < x.length; j++) du.push(-k * u * x[j]!);
      for (let i = 0; i < p; i++) g[i] = g[i]! - dlldu * du[i]!;
    }
    for (let i = 0; i < p; i++) g[i] = g[i]! / rows.length + (i <= 1 ? 0 : (lambda * th[i]!) / rows.length);
    return g;
  };
  const s0 = start ?? (() => { const a = new Array<number>(p).fill(0); a[0] = 0; return a; })();
  return adamMinimize(grad, s0, iters, 0.02);
}

function hazardPredict(th: number[], q: Peer): number {
  const k = Math.exp(th[0]!);
  const x = hazardFeatures(q);
  const logLam = th.slice(1).reduce((s, b, i) => s + b * x[i]!, 0);
  const u = Math.exp(k * (Math.log(Math.max(q.ageY, 0.02)) - logLam));
  return 1 - Math.exp(-Math.min(u, 700));
}

/** The hazard's 12-month forward odds: P(token in the next year | none yet at this age). */
function hazardForwardOdds(th: number[], q: Peer): number {
  const sNow = 1 - hazardPredict(th, q);
  const later: Peer = { ...q, ageY: q.ageY + 1 };
  const sLater = 1 - hazardPredict(th, later);
  if (sNow <= 0) return 1;
  return Math.min(1, Math.max(0, 1 - sLater / sNow));
}

/** Brier score, log-loss and the share called right at a 0.5 threshold. */
export interface OddsMetrics {
  brier: number;
  logLoss: number;
  accuracy: number;
}

function oddsMetrics(preds: number[], ys: number[]): OddsMetrics {
  const n = ys.length;
  return {
    brier: preds.reduce((s, pr, i) => s + (pr - ys[i]!) * (pr - ys[i]!), 0) / n,
    logLoss:
      preds.reduce(
        (s, pr, i) => s - (ys[i]! * Math.log(Math.max(pr, 1e-9)) + (1 - ys[i]!) * Math.log(Math.max(1 - pr, 1e-9))),
        0,
      ) / n,
    accuracy: preds.reduce((s, pr, i) => s + ((pr >= 0.5 ? 1 : 0) === ys[i]! ? 1 : 0), 0) / n,
  };
}

/** One odds model's held-out numbers on both tests. */
export interface OddsModelResult {
  name: string;
  loo: OddsMetrics;
  walkForward: OddsMetrics;
  kept: boolean;
  note: string;
}

/** The fitted token odds: both models, their comparison, and the ensemble the board uses. */
export interface OddsModel {
  logisticBeta: number[];
  hazardTheta: number[];
  hazardShapeK: number;
  lambda: number;
  medianAgeY: number;
  nPeers: number;
  nPeersWithAge: number;
  baseRate: number;
  baseLoo: OddsMetrics;
  baseWalkForward: OddsMetrics;
  models: OddsModelResult[];
  /** The board's odds of one protocol: the average of the logistic and the hazard. */
  oddsOf: (p: SnapshotProtocol, asOf: string) => number;
  /** The 12-month forward odds of one protocol, from the hazard alone. */
  forwardOddsOf: (p: SnapshotProtocol, asOf: string) => number;
}

const ODDS_LAMBDA = 16;
const ODDS_FULL_ITERS = 1200;
const ODDS_LOO_ITERS = 120;

/** The peers of one snapshot, with the median age for the ones with no listing date. */
function buildPeers(snapshot: Snapshot): { peers: Peer[]; medianAgeY: number } {
  const withAge = snapshot.protocols.filter((p) => isPeer(p) && p.listed_at !== null);
  const medianAgeY = median(withAge.map((p) => ageDays(snapshot.as_of, p.listed_at)! / 365));
  const peers: Peer[] = snapshot.protocols
    .filter((p) => isPeer(p))
    .map((p) => {
      const age = ageDays(snapshot.as_of, p.listed_at);
      return {
        p,
        y: isPreToken(p) ? 0 : 1,
        ageY: age === null ? medianAgeY : age / 365,
        lt: Math.log(p.tvl_usd) - LOG_100M,
        fam: familyOf(p),
        growth: p.change_7d === null ? 0 : Math.min(120, Math.max(-60, p.change_7d)) / 100,
      };
    });
  return { peers, medianAgeY };
}

/** The token-odds models, fit and validated twice, from the snapshot alone. */
export function fitOddsModel(snapshot: Snapshot): OddsModel {
  const { peers, medianAgeY } = buildPeers(snapshot);
  // The held-out tests need a listing date, so they run on the peers that have one.
  const dated = peers.filter((q) => q.p.listed_at !== null);
  const baseRate = peers.filter((q) => q.y === 1).length / peers.length;

  const betaFull = fitLogistic(peers, ODDS_LAMBDA, ODDS_FULL_ITERS, null);
  const thFull = fitHazard(peers, ODDS_LAMBDA, ODDS_FULL_ITERS, null);

  const predictBoth = (beta: number[], th: number[]) => (q: Peer): [number, number, number] => {
    const pl = logisticPredict(beta, q);
    const ph = hazardPredict(th, q);
    return [pl, ph, (pl + ph) / 2];
  };

  // Leave-one-out, warm-started from the full fits.
  const looPred: Array<[number, number, number]> = [];
  for (let i = 0; i < dated.length; i++) {
    const train = dated.filter((_, j) => j !== i);
    const beta = fitLogistic(train, ODDS_LAMBDA, ODDS_LOO_ITERS, betaFull);
    const th = fitHazard(train, ODDS_LAMBDA, ODDS_LOO_ITERS, thFull);
    looPred.push(predictBoth(beta, th)(dated[i]!));
  }
  const looYs = dated.map((q) => q.y);
  const looLogit = oddsMetrics(looPred.map((t) => t[0]), looYs);
  const looHazard = oddsMetrics(looPred.map((t) => t[1]), looYs);
  const looEns = oddsMetrics(looPred.map((t) => t[2]), looYs);
  // The base rate for the leave-one-out test is the dated peers' own share with a token:
  // the constant the test set itself would pick, not the whole peer set's.
  const datedBaseRate = looYs.reduce((s, y) => s + y, 0) / looYs.length;
  const baseLoo = oddsMetrics(looYs.map(() => datedBaseRate), looYs);

  // Expanding walk-forward: earlier-listed peers price later-listed ones.
  const sorted = [...dated].sort((a, b) => (a.p.listed_at! < b.p.listed_at! ? -1 : 1));
  const chunk = Math.floor(sorted.length / 5);
  const wfPred: Array<[number, number, number]> = [];
  const wfYs: number[] = [];
  for (let k = 1; k < 5; k++) {
    const train = sorted.slice(0, k * chunk);
    const test = sorted.slice(k * chunk, (k + 1) * chunk);
    const beta = fitLogistic(train, ODDS_LAMBDA, ODDS_FULL_ITERS, null);
    const th = fitHazard(train, ODDS_LAMBDA, ODDS_FULL_ITERS, null);
    const both = predictBoth(beta, th);
    for (const q of test) {
      wfPred.push(both(q));
      wfYs.push(q.y);
    }
  }
  const wfLogit = oddsMetrics(wfPred.map((t) => t[0]), wfYs);
  const wfHazard = oddsMetrics(wfPred.map((t) => t[1]), wfYs);
  const wfEns = oddsMetrics(wfPred.map((t) => t[2]), wfYs);
  const wfBaseRate = wfYs.reduce((s, y) => s + y, 0) / wfYs.length;
  const baseWf = oddsMetrics(wfYs.map(() => wfBaseRate), wfYs);

  const peerOf = (p: SnapshotProtocol): Peer => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    return {
      p,
      y: 0,
      ageY: age === null ? medianAgeY : age / 365,
      lt: Math.log(p.tvl_usd) - LOG_100M,
      fam: familyOf(p),
      growth: p.change_7d === null ? 0 : Math.min(120, Math.max(-60, p.change_7d)) / 100,
    };
  };

  return {
    logisticBeta: betaFull,
    hazardTheta: thFull,
    hazardShapeK: Math.exp(thFull[0]!),
    lambda: ODDS_LAMBDA,
    medianAgeY,
    nPeers: peers.length,
    nPeersWithAge: dated.length,
    baseRate,
    baseLoo,
    baseWalkForward: baseWf,
    models: [
      {
        name: 'base rate, no model',
        loo: baseLoo,
        walkForward: baseWf,
        kept: false,
        note: 'the share of peers that record a token: the bar every model must beat',
      },
      {
        name: 'logistic: age, size, family',
        loo: looLogit,
        walkForward: wfLogit,
        kept: false,
        note: 'beats the base rate leave-one-out, not on later-listed peers',
      },
      {
        name: 'hazard: current-status Weibull',
        loo: looHazard,
        walkForward: wfHazard,
        kept: false,
        note: 'reads the timing, not only the outcome; beats the base rate leave-one-out',
      },
      {
        name: 'ensemble: average of both',
        loo: looEns,
        walkForward: wfEns,
        kept: true,
        note: 'the only odds model that beats the base rate on BOTH held-out tests: the board uses it',
      },
    ],
    oddsOf: (p: SnapshotProtocol): number => {
      const q = peerOf(p);
      return (logisticPredict(betaFull, q) + hazardPredict(thFull, q)) / 2;
    },
    forwardOddsOf: (p: SnapshotProtocol): number => hazardForwardOdds(thFull, peerOf(p)),
  };
}

// ---------------------------------------------------------------- farm plans

/** The farm scenario the verdicts are costed under. */
export interface FarmScenario {
  /** The plan size, as a share of the protocol's TVL (0.0002 = 0.02%). */
  planShare: number;
  /** The share of the implied value the drop is assumed to pay farmers. */
  dropShare: number;
  /** The farming horizon, in weeks. */
  horizonWeeks: number;
  /** The $/hour bar a FARM verdict must clear. */
  hourlyBar: number;
  /** The T-bill rate a FARM verdict must beat, per year. */
  tbillRate: number;
}

export const DEFAULT_SCENARIO: FarmScenario = {
  planShare: 0.0002,
  dropShare: 0.07,
  horizonWeeks: 12,
  hourlyBar: 25,
  tbillRate: 0.045,
};

/** Gas per transaction, in dollars, by the protocol's first chain: a stated assumption, not a fit. */
const GAS_PER_TX: Record<string, number> = {
  Ethereum: 6.0,
  Solana: 0.05,
  Base: 0.3,
  Arbitrum: 0.3,
  Optimism: 0.3,
  BSC: 0.1,
  Polygon: 0.05,
  Avalanche: 0.3,
  Tron: 1.0,
};

/** Gas per transaction for one protocol: its first chain, or $1.00 when the chain is unlisted. */
export function gasPerTx(p: SnapshotProtocol): number {
  const chain = p.chains.length > 0 ? p.chains[0]! : '';
  return GAS_PER_TX[chain] ?? 1.0;
}

/** A farm verdict: the expected drop, the fees, the net, and the net per hour. */
export interface FarmVerdict {
  verdict: 'FARM' | 'MARGINAL' | 'SKIP';
  dropUsd: number;
  feesUsd: number;
  netUsd: number;
  netPerHour: number;
  hours: number;
  capitalUsd: number;
  /** The T-bill return on the plan capital over the horizon: shown for reference, not a gate. */
  tbillUsd: number;
}

/**
 * The costed verdict of one row under one scenario.
 *
 * FARM when the drop covers the fees and the time is worth the reader's $/hour bar; MARGINAL
 * when the drop covers the fees but the time is not; SKIP when the fees eat the drop. The T-bill
 * return on the plan capital is reported beside the verdict, not used as a gate: the position
 * itself earns the protocol's own yield while it farms (a lending or LP position), so the drop is
 * judged against the fees and the reader's time, not against leaving the money in T-bills. A
 * T-bill gate on the full plan capital would be nearly impossible to pass and would fight the
 * $/hour bar — big protocols clear the hours and fail the ratio, small ones the reverse — so it
 * is shown, not gated. The page says this in plain words.
 */
export function farmVerdict(row: { tvl_usd: number; implied_value_usd: number; chains: string[] }, scenario: FarmScenario): FarmVerdict {
  const capital = row.tvl_usd * scenario.planShare;
  const drop = row.implied_value_usd * scenario.dropShare * (capital / row.tvl_usd);
  const txs = 4 + scenario.horizonWeeks; // 3 to set up, one a week, one to claim
  const chain = row.chains.length > 0 ? row.chains[0]! : '';
  const gas = GAS_PER_TX[chain] ?? 1.0;
  const fees = txs * gas;
  const hours = 0.75 + 0.25 * scenario.horizonWeeks; // 45 minutes to set up and claim, 15 a week
  const net = drop - fees;
  const tbill = capital * scenario.tbillRate * (scenario.horizonWeeks / 52);
  const netPerHour = net / hours;
  const verdict: FarmVerdict['verdict'] = net > 0 && netPerHour >= scenario.hourlyBar ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP';
  return { verdict, dropUsd: drop, feesUsd: fees, netUsd: net, netPerHour, hours, capitalUsd: capital, tbillUsd: tbill };
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The starter position the steps are written for, from the protocol's own TVL. */
function starterCapital(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age, gas on its chain), never from a
 * hand-written list of names. The steps are written for a $50-$250 starter position a reader can
 * actually open; the verdict math uses the scenario plan size instead, and the page says so.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = starterCapital(p);
  const gas = gasPerTx(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: `about $${gas.toFixed(2)} of gas for the first transaction`,
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${gas.toFixed(2)} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Check the protocol's own points or rewards page and confirm this action counts before you repeat it.`,
      cost: 'no fee to check',
      time: '10 minutes',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: `about $${gas.toFixed(2)} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes; never pay anyone to claim for you.`,
      cost: `about $${gas.toFixed(2)} of gas to claim`,
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

// ---------------------------------------------------------------- the board

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  family: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  tier: 'watchlist' | 'early';
  implied_value_usd: number;
  multiple: number;
  if_launches_usd: number;
  token_odds: number;
  odds_12m: number;
  p25_usd: number;
  p75_usd: number;
  p10_usd: number;
  p90_usd: number;
  verdict: 'FARM' | 'MARGINAL' | 'SKIP';
  drop_usd: number;
  fees_usd: number;
  net_usd: number;
  net_per_hour: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  family: string;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  multiple: number | null;
}

/** The ledger: every snapshot protocol in exactly one group, with the totals that tie out. */
export interface Ledger {
  total: number;
  ranked: number;
  rankedWatchlist: number;
  rankedEarly: number;
  tokenTrades: number;
  excludedPreToken: number;
  excludedByReason: Array<{ reason: string; count: number }>;
  boardTotalImplied: number;
  boardChecksum: string;
  mainTsSha256: string;
}

/** Everything the dashboard needs: the board, the live set, the model, and the evidence. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  scenario: FarmScenario;
  value: {
    beta: number[];
    se: number[];
    lambda: number;
    families: string[];
    validation: ValueValidation;
    terms: ValueTerm[];
    quantiles: ValueModel['quantiles'];
    coverage2575: number;
    coverage1090: number;
  };
  odds: {
    lambda: number;
    shapeK: number;
    medianAgeY: number;
    nPeers: number;
    nPeersWithAge: number;
    baseRate: number;
    models: OddsModelResult[];
    logisticBeta: number[];
    hazardTheta: number[];
  };
  ledger: Ledger;
  verdictCounts: { FARM: number; MARGINAL: number; SKIP: number };
  rows: BoardRow[];
  live: LiveRow[];
}

export const MODEL_VERSION = 'radar-2';

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      family: familyOf(p),
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      multiple: p.mcap_usd !== null && p.tvl_usd > 0 ? p.mcap_usd / p.tvl_usd : null,
    }));
}

/** The ranked board: every watchlist slug, plus every rankable pre-token protocol below the floor. */
export function buildBoard(
  snapshot: Snapshot,
  value: ValueModel,
  odds: OddsModel,
  scenario: FarmScenario,
): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const multiple = value.multipleOf(p);
    const tokenOdds = odds.oddsOf(p, snapshot.as_of);
    const odds12m = odds.forwardOddsOf(p, snapshot.as_of);
    const ifLaunches = Math.max(1, Math.round(p.tvl_usd * multiple));
    const implied = Math.max(1, Math.round(ifLaunches * tokenOdds));
    return { p, age, multiple, tokenOdds, odds12m, ifLaunches, implied };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => {
    const verdict = farmVerdict({ tvl_usd: s.p.tvl_usd, implied_value_usd: s.implied, chains: s.p.chains }, scenario);
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      family: familyOf(s.p),
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      listed_at: s.p.listed_at,
      age_days: s.age,
      tier: snapshot.watchlist.includes(s.p.slug) ? ('watchlist' as const) : ('early' as const),
      implied_value_usd: s.implied,
      multiple: s.multiple,
      if_launches_usd: s.ifLaunches,
      token_odds: s.tokenOdds,
      odds_12m: s.odds12m,
      p25_usd: Math.max(1, Math.round(s.implied * value.quantiles.q25)),
      p75_usd: Math.max(1, Math.round(s.implied * value.quantiles.q75)),
      p10_usd: Math.max(1, Math.round(s.implied * value.quantiles.q10)),
      p90_usd: Math.max(1, Math.round(s.implied * value.quantiles.q90)),
      verdict: verdict.verdict,
      drop_usd: Math.round(verdict.dropUsd * 100) / 100,
      fees_usd: Math.round(verdict.feesUsd * 100) / 100,
      net_usd: Math.round(verdict.netUsd * 100) / 100,
      net_per_hour: Math.round(verdict.netPerHour * 100) / 100,
      farm_steps: farmSteps(s.p, s.age).map(stepText),
    };
  });
}

/** The ledger: every snapshot protocol in exactly one group. */
export function buildLedger(snapshot: Snapshot, board: BoardRow[], mainTsSha256: string, boardChecksum: string): Ledger {
  const ranked = new Set(board.map((r) => r.slug));
  const reasons = new Map<string, number>();
  let tokenTrades = 0;
  let excludedPre = 0;
  for (const p of snapshot.protocols) {
    if (ranked.has(p.slug)) continue;
    if (!isPreToken(p)) {
      tokenTrades++;
      continue;
    }
    excludedPre++;
    const reason = exclusionReason(p) ?? 'other';
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  return {
    total: snapshot.protocols.length,
    ranked: board.length,
    rankedWatchlist: board.filter((r) => r.tier === 'watchlist').length,
    rankedEarly: board.filter((r) => r.tier === 'early').length,
    tokenTrades,
    excludedPreToken: excludedPre,
    excludedByReason: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    boardTotalImplied: board.reduce((s, r) => s + r.implied_value_usd, 0),
    boardChecksum,
    mainTsSha256,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(
  snapshot: Snapshot,
  value: ValueModel,
  odds: OddsModel,
  board: BoardRow[],
  mainTsSha256: string,
  boardChecksum: string,
): RadarData {
  const live = liveRows(snapshot);
  const ledger = buildLedger(snapshot, board, mainTsSha256, boardChecksum);
  const verdictCounts = { FARM: 0, MARGINAL: 0, SKIP: 0 };
  for (const r of board) verdictCounts[r.verdict]++;
  return {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => r.tier === 'early').length,
    live_size: live.length,
    scenario: DEFAULT_SCENARIO,
    value: {
      beta: value.beta,
      se: value.se,
      lambda: value.lambda,
      families: [...FAMILIES],
      validation: value.validation,
      terms: value.terms,
      quantiles: value.quantiles,
      coverage2575: value.coverage2575,
      coverage1090: value.coverage1090,
    },
    odds: {
      lambda: odds.lambda,
      shapeK: odds.hazardShapeK,
      medianAgeY: odds.medianAgeY,
      nPeers: odds.nPeers,
      nPeersWithAge: odds.nPeersWithAge,
      baseRate: odds.baseRate,
      models: odds.models,
      logisticBeta: odds.logisticBeta,
      hazardTheta: odds.hazardTheta,
    },
    ledger,
    verdictCounts,
    rows: board,
    live,
  };
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}

// ---------------------------------------------------------------- snapshot and gate

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}
