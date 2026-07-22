#!/usr/bin/env python3
"""generate_bounds.py — empirical bounds for a "this result is impossible" check.

The calculator happily prints a biological age of 1067 when someone types glucose
in the wrong units. We want to flag that, but the threshold has to come from data
rather than from a number we invented: a fixed +/-30-year band is no better
founded than a percentile cut, and a negative PhenoAge is not automatically
absurd (the model is only validated on adults, so it can legitimately go low on
a young, healthy person).

So: compute PhenoAge acceleration (phenoage - chronological age) for every
complete-case NHANES III participant and look at where the real population
actually stops. The threshold is then set outside the observed extremes, so
tripping it means "no real NHANES participant looked remotely like this" rather
than "you are unusual". That distinction matters — a 0.5/99.5 percentile cut
would unfairly flag 1% of genuine users.

Setup
-----
Shares the loader, model constants and PhenoAge maths with generate_ranges.py.
Same virtualenv:

    python3 -m venv analysis/.venv
    analysis/.venv/bin/pip install -r analysis/requirements.txt

Usage
-----
    analysis/.venv/bin/python analysis/generate_bounds.py           # report only
    analysis/.venv/bin/python analysis/generate_bounds.py --write   # also write bounds.csv
"""

import argparse
import os

import numpy as np
import pandas as pd

from generate_ranges import (
    CONFIG_DIR,
    complete_case_matrix,
    load_nhanes,
    phenoage,
)

# Percentiles worth seeing: the extreme tails are what we actually care about,
# but the 1/99 pair shows how much headroom we are leaving over a naive cut.
PERCENTILES = [0.01, 0.1, 0.5, 1, 5, 25, 50, 75, 95, 99, 99.5, 99.9, 99.99]

# Round the observed extremes outward to this multiple, then add SAFETY_MARGIN
# years on top, so the bound sits clear of the real population.
ROUND_TO = 5
SAFETY_MARGIN = 10


def acceleration_table(df):
    """PhenoAge acceleration for every complete-case participant."""
    F, age, _mu = complete_case_matrix(df)
    pa = phenoage(F, age)
    return pd.DataFrame({"age": age, "phenoage": pa, "accel": pa - age})


def describe(tab):
    accel = tab["accel"].values
    pct = np.percentile(accel, PERCENTILES)

    print("PhenoAge acceleration (phenoage - chronological), NHANES III")
    print("complete cases: n = %d, age %.0f-%.0f" %
          (len(accel), tab["age"].min(), tab["age"].max()))
    print("mean %+.2f, SD %.2f" % (accel.mean(), accel.std(ddof=1)))
    print()
    print("  percentile     accel (years)")
    for p, v in zip(PERCENTILES, pct):
        print("  %8.2f       %+8.2f" % (p, v))
    print()
    print("  observed min   %+8.2f" % accel.min())
    print("  observed max   %+8.2f" % accel.max())
    print()

    print("By age decade:")
    print("  decade      n     min      p1     p99     max")
    dec = (tab["age"] // 10 * 10).astype(int)
    for d in sorted(dec.unique()):
        a = tab.loc[dec == d, "accel"].values
        if len(a) < 30:
            continue
        print("  %4d   %6d  %+6.1f  %+6.1f  %+6.1f  %+6.1f" %
              (d, len(a), a.min(), np.percentile(a, 1),
               np.percentile(a, 99), a.max()))
    print()

    # Absolute PhenoAge range too — useful as a secondary sanity bound.
    pa = tab["phenoage"].values
    print("Absolute PhenoAge: min %.1f, max %.1f" % (pa.min(), pa.max()))
    print()
    return accel


def choose_bounds(accel):
    """Round the observed extremes outward and add a margin."""
    lo = np.floor(accel.min() / ROUND_TO) * ROUND_TO - SAFETY_MARGIN
    hi = np.ceil(accel.max() / ROUND_TO) * ROUND_TO + SAFETY_MARGIN
    return float(lo), float(hi)


def write_bounds(lo, hi, path):
    """One-row CSV, matching the quoted-header style of the other config files."""
    with open(path, "w") as f:
        f.write('"accel_low","accel_high"\n')
        f.write("%g,%g\n" % (lo, hi))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--write", action="store_true",
                    help="write embed/.../config/bounds.csv")
    args = ap.parse_args()

    tab = acceleration_table(load_nhanes())
    accel = describe(tab)
    lo, hi = choose_bounds(accel)

    print("Proposed bounds: accel_low = %+g, accel_high = %+g" % (lo, hi))
    print("  (observed extremes rounded out to %d and padded by %d years)"
          % (ROUND_TO, SAFETY_MARGIN))
    frac = float(((accel < lo) | (accel > hi)).mean())
    print("  NHANES participants that would be flagged: %d (%.4f%%)"
          % (int(((accel < lo) | (accel > hi)).sum()), frac * 100))

    if args.write:
        path = os.path.join(CONFIG_DIR, "bounds.csv")
        write_bounds(lo, hi, path)
        print("Wrote", path)
    else:
        print("Report-only run (pass --write to update bounds.csv).")


if __name__ == "__main__":
    main()
