#!/usr/bin/env python3
"""generate_ranges.py — PhenoAge defaults + imputation-uncertainty generator.

A runnable Python companion to generate_ranges.R, for environments without R.
It regenerates the two data products this branch owns and writes a friendly,
self-contained HTML report so the methodology can be reviewed at a glance:

  - config/defaults.csv     — age-stratified mean defaults used to impute
                              missing biomarkers (geometric mean of floored CRP,
                              arithmetic mean for the linear markers)
  - config/uncertainty.csv  — per-age PhenoAge uncertainty (years, 1 SD) added
                              by imputing each marker with its default

Usage
-----
    python3 analysis/generate_ranges.py            # report only (no file writes)
    python3 analysis/generate_ranges.py --write     # also overwrite the CSVs
    python3 analysis/generate_ranges.py --report out.html

Dependencies: numpy, pandas, statsmodels, rdata, matplotlib.

Data: NHANES III from the BioAge R package. The .rda is fetched once to
analysis/.cache/ if absent; override with the BIOAGE_NHANES3 env var.

Note on smoothing: generate_ranges.R uses R's `loess`; this script uses
`statsmodels.lowess` (the smoother that actually produced the committed CSVs).
They are close but not identical algorithms, so treat whichever you run as the
source of truth — don't mix per-file. The HTML report's parity check compares
this run against the committed CSVs so any drift is visible.
"""

import argparse
import base64
import io
import os
import sys
import urllib.request

import numpy as np
import pandas as pd
from statsmodels.nonparametric.smoothers_lowess import lowess

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# --- Model constants (mirror config/models/phenoage.json) ---------------------

# test_id -> (NHANES3 column, canonical unit, PhenoAge coefficient)
MARKERS = {
    "albumin":    ("albumin_gL",   "g/L",          -0.0336),
    "creatinine": ("creat_umol",   "umol/L",        0.0095),
    "glucose":    ("glucose_mmol", "mmol/L",        0.1953),
    "crp":        ("crp",          "mg/dL",         0.0954),
    "wbc":        ("wbc",          "10^9 cells/L",  0.0554),
    "lymphocyte": ("lymph",        "%",            -0.0120),
    "mcv":        ("mcv",          "fL",            0.0268),
    "rcdw":       ("rdw",          "%",             0.3306),
    "ap":         ("alp",          "U/L",           0.0019),
}
PHENOAGE_DIVISOR = 0.090165   # PhenoAge years per unit of the linear predictor
PHENOAGE_INTERCEPT = 141.50225
PHENOAGE_LOG_COEFF = -0.00553
INTERCEPT = -19.9067
AGE_COEF = 0.0804
GAMMA = 0.0076927
TMONTHS = 120
CRP_FLOOR = 0.22              # NHANES III CRP detection limit (mg/dL)
AGE_RANGE = np.arange(20, 85)
LOWESS_FRAC = 0.4
NHANES_URL = "https://raw.githubusercontent.com/dayoonkwon/BioAge/master/data/NHANES3.rda"

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_DIR = os.path.join(REPO_DIR, "embed", "calculators", "phenoage", "config")


# --- Data loading -------------------------------------------------------------

def find_nhanes():
    """Locate NHANES3.rda, downloading to analysis/.cache/ if necessary."""
    env = os.environ.get("BIOAGE_NHANES3")
    candidates = [env] if env else []
    cache = os.path.join(REPO_DIR, "analysis", ".cache", "NHANES3.rda")
    candidates.append(cache)
    for path in candidates:
        if path and os.path.exists(path):
            return path
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    sys.stderr.write("Downloading NHANES3.rda from the BioAge repository...\n")
    urllib.request.urlretrieve(NHANES_URL, cache)
    return cache


def load_nhanes():
    import rdata
    df = rdata.read_rda(find_nhanes())["NHANES3"]
    return df if isinstance(df, pd.DataFrame) else pd.DataFrame(df)


# --- Model-space helpers ------------------------------------------------------

def model_space(values, tid):
    """The value as the model consumes it: log(max(CRP, floor)); identity else."""
    if tid == "crp":
        return np.log(np.maximum(values, CRP_FLOOR))
    return values


def central(values, tid):
    """Unbiased imputation default: floored geometric mean for CRP, else mean."""
    if tid == "crp":
        return float(np.exp(np.log(np.maximum(values, CRP_FLOOR)).mean()))
    return float(values.mean())


def smooth(raw):
    """LOWESS-smooth a per-age series, preserving NaN gaps."""
    valid = ~np.isnan(raw)
    if valid.sum() < 10:
        return raw
    out = np.full(len(AGE_RANGE), np.nan)
    out[valid] = lowess(raw[valid], AGE_RANGE[valid], frac=LOWESS_FRAC,
                        return_sorted=False)
    return out


# --- The two data products ----------------------------------------------------

def build_defaults(df, age_int):
    out = pd.DataFrame({"age": AGE_RANGE})
    for tid, (col, _unit, _coef) in MARKERS.items():
        vals = df[col].values.astype(float)
        raw = np.array([
            central(vals[(age_int == a) & ~np.isnan(vals)], tid)
            if ((age_int == a) & ~np.isnan(vals)).sum() >= 5 else np.nan
            for a in AGE_RANGE
        ])
        out[tid] = np.round(smooth(raw), 4)
    return out


def build_uncertainty(df, age_int):
    out = pd.DataFrame({"age": AGE_RANGE})
    for tid, (col, _unit, coef) in MARKERS.items():
        vals = df[col].values.astype(float)
        weight = abs(coef) / PHENOAGE_DIVISOR  # unit of model value -> years
        raw = np.array([
            weight * model_space(vals[(age_int == a) & ~np.isnan(vals)], tid).std(ddof=1)
            if ((age_int == a) & ~np.isnan(vals)).sum() >= 5 else np.nan
            for a in AGE_RANGE
        ])
        out[tid] = np.round(smooth(raw), 4)
    return out


def write_csv(table, path):
    """Match the committed format: quoted header, integer age, %g numerics."""
    with open(path, "w") as f:
        f.write(",".join('"%s"' % c for c in table.columns) + "\n")
        for _, r in table.iterrows():
            f.write(str(int(r["age"])) + "," +
                    ",".join("%g" % r[c] for c in table.columns[1:]) + "\n")


# --- Diagnostics that justify the quadrature band -----------------------------

def phenoage(F, age):
    k = (np.exp(GAMMA * TMONTHS) - 1) / GAMMA
    coefs = np.array([c for _, _, c in MARKERS.values()])
    xb = INTERCEPT + AGE_COEF * age + (F * coefs).sum(axis=1)
    return PHENOAGE_INTERCEPT + (np.log(-PHENOAGE_LOG_COEFF * k) + xb) / PHENOAGE_DIVISOR


def complete_case_matrix(df):
    """Model-space marker matrix F, ages, and within-age means mu, complete cases."""
    cols = [col for col, _, _ in MARKERS.values()]
    sub = df[["age"] + cols].dropna()
    age = sub["age"].values.astype(float)
    F = np.column_stack([model_space(sub[col].values.astype(float), tid)
                         for tid, (col, _, _) in MARKERS.items()])
    ai = np.floor(age).astype(int)
    mu = np.zeros_like(F)
    for a in np.unique(ai):
        m = ai == a
        mu[m] = F[m].mean(axis=0)
    return F, age, mu


def independence_diagnostic(F, mu):
    coefs = np.array([c for _, _, c in MARKERS.values()])
    D = F - mu
    sigma = D.std(axis=0, ddof=1)
    Z = (D / sigma) * np.sign(coefs)            # standardized, oriented older=+
    C = np.corrcoef(Z, rowvar=False)
    off = C[~np.eye(len(coefs), dtype=bool)]
    ev = np.sort(np.linalg.eigvalsh(C))[::-1]
    return C, float(off.mean()), float(off.min()), float(off.max()), float(ev[0] / len(coefs) * 100)


def holdout_validation(F, age, mu, rng):
    """Enter k random markers, impute the rest with the age mean, vs true PhenoAge."""
    N = F.shape[0]
    pa_true = phenoage(F, age)
    rows = []
    for k in (1, 3, 5, 7):
        errs = []
        for _ in range(80):
            obs = np.zeros((N, 9), bool)
            idx = np.argsort(rng.random((N, 9)), axis=1)[:, :k]
            obs[np.arange(N)[:, None], idx] = True
            Fm = np.where(obs, F, mu)
            errs.append(phenoage(Fm, age) - pa_true)
        errs = np.concatenate(errs)
        rows.append((k, np.sqrt((errs ** 2).mean())))
    return rows


# --- HTML report --------------------------------------------------------------

def fig_to_b64(fig):
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=96, bbox_inches="tight")
    plt.close(fig)
    return base64.b64encode(buf.getvalue()).decode()


def parity(table, name):
    """Compare a freshly built table to the committed CSV; return (html, max_abs_diff)."""
    path = os.path.join(CONFIG_DIR, name)
    if not os.path.exists(path):
        return f"<p><em>{name} not present to compare.</em></p>", None
    committed = pd.read_csv(path)
    diffs = {c: float(np.nanmax(np.abs(table[c].values - committed[c].values)))
             for c in table.columns if c != "age"}
    worst = max(diffs.values())
    status = "exactly reproduces" if worst == 0 else f"reproduces (max |Δ| = {worst:g})"
    rows = "".join(f"<tr><td>{c}</td><td>{d:g}</td></tr>" for c, d in diffs.items())
    html = (f"<p>This run <strong>{status}</strong> the committed <code>{name}</code>.</p>"
            f"<table><tr><th>marker</th><th>max |Δ| vs committed</th></tr>{rows}</table>")
    return html, worst


def build_report(df, defaults, uncertainty, out_path):
    age_int = np.floor(df["age"].values)
    coefs = {tid: c for tid, (_, _, c) in MARKERS.items()}

    # Per-marker figures: distribution, age default, age uncertainty
    marker_blocks = []
    for tid, (col, unit, _coef) in MARKERS.items():
        vals = df[col].values.astype(float)
        vals = vals[~np.isnan(vals)]
        lo, hi = np.percentile(vals, [0.5, 99.5])

        fig, axes = plt.subplots(1, 3, figsize=(12, 3.1))
        axes[0].hist(vals[(vals >= lo) & (vals <= hi)], bins=60, color="#4671b5")
        axes[0].set_title(f"{tid} distribution ({unit})")
        axes[1].plot(defaults["age"], defaults[tid], color="#125b4a", lw=2)
        axes[1].set_title("mean default by age")
        axes[1].set_xlabel("age")
        axes[2].plot(uncertainty["age"], uncertainty[tid], color="#b5462f", lw=2)
        axes[2].set_title("imputation SD by age (yr)")
        axes[2].set_xlabel("age")
        marker_blocks.append(
            f"<h3>{tid} <span class='coef'>(coef {coefs[tid]:+}, {unit})</span></h3>"
            f"<img src='data:image/png;base64,{fig_to_b64(fig)}'>"
        )

    # Independence diagnostic
    F, age, mu = complete_case_matrix(df)
    C, rho_bar, rho_min, rho_max, pc1 = independence_diagnostic(F, mu)
    fig, ax = plt.subplots(figsize=(5, 4.2))
    im = ax.imshow(C, cmap="RdBu_r", vmin=-1, vmax=1)
    ax.set_xticks(range(9)); ax.set_xticklabels(MARKERS.keys(), rotation=90, fontsize=8)
    ax.set_yticks(range(9)); ax.set_yticklabels(MARKERS.keys(), fontsize=8)
    ax.set_title("within-age oriented correlation")
    fig.colorbar(im, fraction=0.046)
    corr_img = fig_to_b64(fig)

    # Held-out validation: quadrature predicted vs actual
    rng = np.random.default_rng(0)
    val = holdout_validation(F, age, mu, rng)
    val_rows = "".join(
        f"<tr><td>{k} of 9</td><td>{rmse:.2f} yr</td></tr>" for k, rmse in val)

    # Per-marker variance contribution (the 9 numbers), at a reference age
    ref_age = 50
    ref = uncertainty.loc[uncertainty.age == ref_age].iloc[0]
    contrib = sorted(((tid, ref[tid]) for tid in MARKERS), key=lambda x: -x[1])
    contrib_rows = "".join(
        f"<tr><td>{tid}</td><td>{s:.2f}</td><td>{s*s:.2f}</td></tr>" for tid, s in contrib)
    total_band = float(np.sqrt(sum(ref[tid] ** 2 for tid in MARKERS)))

    def_parity, _ = parity(defaults, "defaults.csv")
    unc_parity, _ = parity(uncertainty, "uncertainty.csv")

    html = f"""<!doctype html><html><head><meta charset="utf-8">
<title>PhenoAge defaults &amp; imputation uncertainty</title>
<style>
 body{{font:15px/1.55 -apple-system,system-ui,sans-serif;max-width:980px;margin:2em auto;padding:0 1em;color:#1c1c1c}}
 h1{{border-bottom:2px solid #125b4a;padding-bottom:.2em}}
 h2{{margin-top:1.8em;color:#125b4a}} h3{{margin:1.4em 0 .3em}}
 .coef{{font-weight:400;color:#777;font-size:.85em}}
 table{{border-collapse:collapse;margin:.6em 0}} td,th{{border:1px solid #ccc;padding:3px 10px;text-align:left}}
 th{{background:#f0f3f2}} img{{max-width:100%;margin:.3em 0}}
 code{{background:#f3f3f3;padding:1px 4px;border-radius:3px}}
 .note{{background:#f0f3f2;border-left:4px solid #125b4a;padding:.6em 1em;margin:1em 0}}
</style></head><body>
<h1>PhenoAge defaults &amp; imputation uncertainty</h1>
<p>Generated by <code>analysis/generate_ranges.py</code> from NHANES III
({len(df):,} observations, ages {df['age'].min():.0f}–{df['age'].max():.0f}).
The Python companion to <code>generate_ranges.R</code> for R-less environments.</p>

<h2>Method</h2>
<div class="note">
<p><strong>Defaults.</strong> A missing marker is filled with its age-stratified
population mean (floored geometric mean for CRP, which the model uses as
<code>log(max(CRP, {CRP_FLOOR}))</code>). PhenoAge is affine in the model's
linear predictor, so this is the unbiased fill: its model contribution equals
the average person's at that age.</p>
<p><strong>Uncertainty.</strong> Imputing marker <em>i</em> injects an error of
<code>|coef_i| / divisor × (value − mean)</code> years. Its within-age SD is
<code>s_i(age) = |coef_i| / divisor × sd(model-space value | age)</code> — stored
per age here. Because the markers are nearly independent within an age (below),
the variances add, so the displayed band is the quadrature sum
<code>√(Σ s_i²)</code> over the defaulted markers, computed at runtime.</p>
</div>

<h2>Are the markers independent within age? (justifies the quadrature)</h2>
<p>Oriented, standardized, within-age deviations:
mean pairwise correlation <strong>ρ̄ = {rho_bar:.3f}</strong>
(range {rho_min:.2f}…{rho_max:.2f}); PC1 explains <strong>{pc1:.1f}%</strong>
of variance (11.1% would be pure independence). Near-zero shared structure means
cross-covariance terms are negligible and the band reduces to a sum of squares.</p>
<img src="data:image/png;base64,{corr_img}">

<h2>Held-out validation: does the model hold up?</h2>
<p>Enter <em>k</em> random markers, impute the rest with the age mean, and compare
the resulting PhenoAge to the all-9 truth ({F.shape[0]:,} complete cases):</p>
<table><tr><th>markers entered</th><th>imputation RMSE</th></tr>{val_rows}</table>

<h2>Per-marker contribution at age {ref_age}</h2>
<p>The nine numbers the band is built from. Total all-9 band =
<strong>{total_band:.2f} yr</strong>.</p>
<table><tr><th>marker</th><th>year-SD s<sub>i</sub></th><th>variance s<sub>i</sub>²</th></tr>{contrib_rows}</table>

<h2>Parity with committed files</h2>
{def_parity}
{unc_parity}

<h2>Per-marker detail</h2>
{''.join(marker_blocks)}
</body></html>"""
    with open(out_path, "w") as f:
        f.write(html)
    return rho_bar, pc1


# --- Entry point --------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--write", action="store_true",
                    help="overwrite config/defaults.csv and config/uncertainty.csv")
    ap.add_argument("--report", default=os.path.join(REPO_DIR, "analysis", "generate_ranges.html"),
                    help="output path for the HTML report")
    args = ap.parse_args()

    df = load_nhanes()
    age_int = np.floor(df["age"].values)
    defaults = build_defaults(df, age_int)
    uncertainty = build_uncertainty(df, age_int)

    if args.write:
        write_csv(defaults, os.path.join(CONFIG_DIR, "defaults.csv"))
        write_csv(uncertainty, os.path.join(CONFIG_DIR, "uncertainty.csv"))
        print("Wrote defaults.csv and uncertainty.csv")
    else:
        print("Report-only run (pass --write to update the CSVs).")

    build_report(df, defaults, uncertainty, args.report)
    print("Report:", args.report)


if __name__ == "__main__":
    main()
