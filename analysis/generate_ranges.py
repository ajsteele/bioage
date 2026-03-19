#!/usr/bin/env python3
"""
Generate normal and plausible ranges for PhenoAge biomarkers.

This script documents and computes the validation ranges used by the
biological age calculator. It outputs updated CSV files that the web app
reads at runtime.

Methodology
-----------
1. NORMAL ranges (amber warning when exceeded):
   Clinical reference intervals representing ~2.5th–97.5th percentiles
   for healthy adults. Sources: standard clinical laboratory references
   (Tietz Clinical Chemistry, NHANES III published summaries, major
   clinical laboratory reference ranges).

2. PLAUSIBLE ranges (red error when exceeded):
   The widest values that could realistically occur in a living patient.
   These are set wide enough to accommodate severe pathology but narrow
   enough to catch unit-confusion errors.

3. UNIT-CONFUSION DETECTION:
   For biomarkers with multiple entry units, we check whether normal-range
   values in one unit could be mistaken for values in another unit. The
   plausible range in each unit is set tight enough that a normal value
   entered in the wrong unit would be flagged.

   Example: Glucose normal range is 3.9–6.1 mmol/L or 70–110 mg/dL.
   If someone enters 90 (meaning mg/dL) but selects mmol/L, the value
   90 mmol/L should be flagged as implausible (plausible max ~30 mmol/L).

All ranges are stored in CANONICAL units (as defined in tests.csv) and
converted to display units by the web app at runtime.
"""

import csv
import json
import os
import sys

# ── Biomarker reference data ──
# Each entry defines ranges in the CANONICAL unit from tests.csv.
#
# normal_low/high: clinical reference interval (~2.5th–97.5th percentile)
# plausible_low/high: extreme but physiologically possible values
#
# Sources cited inline. Where a range spans multiple sources, the widest
# published interval is used for normal, and clinical case-report extremes
# for plausible.

BIOMARKERS = {
    "albumin": {
        # Canonical unit: g/L
        # Normal: 35–55 g/L (Tietz, most clinical labs report 3.5–5.5 g/dL)
        # Plausible: severe hypoalbuminemia ~10 g/L (nephrotic syndrome),
        #   upper end ~60 g/L (dehydration/haemoconcentration)
        "normal_low": 35,
        "normal_high": 55,
        "plausible_low": 10,
        "plausible_high": 65,
        "sources": [
            "Tietz Clinical Chemistry (6th ed): serum albumin 3.5–5.2 g/dL",
            "Mayo Clinic reference: 3.4–5.4 g/dL",
        ],
    },
    "creatinine": {
        # Canonical unit: µmol/L
        # Normal: 44–133 µmol/L (Tietz: 0.5–1.5 mg/dL, spans M+F adult range)
        # Plausible: as low as ~20 µmol/L (severe muscle wasting),
        #   as high as ~1800 µmol/L (~20 mg/dL, severe renal failure pre-dialysis)
        "normal_low": 44,
        "normal_high": 133,
        "plausible_low": 15,
        "plausible_high": 1800,
        "sources": [
            "Tietz: serum creatinine 0.7–1.3 mg/dL (male), 0.5–1.1 mg/dL (female)",
            "Upper plausible ~20 mg/dL per case reports of severe AKI",
        ],
    },
    "glucose": {
        # Canonical unit: mmol/L
        # Normal (fasting): 3.9–6.1 mmol/L (ADA fasting glucose reference)
        # Normal (non-fasting/broader): 3.3–7.8 mmol/L
        # We use broader range since users may not be fasting
        # Plausible: hypoglycemic coma ~1.0 mmol/L,
        #   diabetic emergency ~50 mmol/L (case reports of DKA/HHS)
        "normal_low": 3.3,
        "normal_high": 7.8,
        "plausible_low": 1.0,
        "plausible_high": 50,
        "sources": [
            "ADA: fasting glucose normal <5.6 mmol/L, prediabetes 5.6–6.9",
            "WHO: random glucose up to 7.8 mmol/L is normal",
            "DKA/HHS case reports: glucose up to ~50 mmol/L (~900 mg/dL)",
        ],
    },
    "crp": {
        # Canonical unit: mg/L
        # Normal: 0–10 mg/L (most labs; <3 mg/L is low-risk for CVD)
        # Note: PhenoAge uses log(CRP) so CRP must be > 0
        # Plausible: severe sepsis/trauma can reach ~500 mg/L
        "normal_low": 0.1,
        "normal_high": 10,
        "plausible_low": 0.01,
        "plausible_high": 500,
        "sources": [
            "Standard clinical reference: CRP <10 mg/L normal",
            "AHA/CDC: hs-CRP <1 mg/L low risk, 1–3 average, >3 high risk",
            "Severe infection/sepsis: CRP up to 300–500 mg/L",
        ],
    },
    "wbc": {
        # Canonical unit: 10⁹ cells/L (= 1000 cells/µL)
        # Normal: 4.5–11.0 (standard CBC reference)
        # Plausible: neutropenia ~0.5, leukaemia up to ~300+
        "normal_low": 3.5,
        "normal_high": 11.0,
        "plausible_low": 0.5,
        "plausible_high": 300,
        "sources": [
            "Standard CBC: WBC 4.5–11.0 × 10⁹/L",
            "Widened low to 3.5 to accommodate benign ethnic neutropenia",
        ],
    },
    "lymphocyte": {
        # Canonical unit: %
        # Normal: 20–40% (standard differential)
        # Plausible: can be <5% in severe lymphopenia (HIV, chemo),
        #   up to 90%+ in CLL/lymphoproliferative disorders
        "normal_low": 15,
        "normal_high": 45,
        "plausible_low": 1,
        "plausible_high": 99,
        "sources": [
            "Standard differential: lymphocytes 20–40%",
            "Widened for clinical outliers",
        ],
    },
    "mcv": {
        # Canonical unit: fL
        # Normal: 80–100 fL (standard CBC)
        # Plausible: severe iron deficiency ~50 fL, megaloblastic anaemia ~130 fL
        "normal_low": 78,
        "normal_high": 100,
        "plausible_low": 50,
        "plausible_high": 140,
        "sources": [
            "Standard CBC: MCV 80–100 fL",
            "Hollowell et al. (NHANES III): 2.5th–97.5th ~79–98 fL",
        ],
    },
    "rcdw": {
        # Canonical unit: %
        # Normal: 11.5–14.5% (standard CBC, RDW-CV)
        # Plausible: ~10% (very uniform cells) to ~35% (severe mixed deficiency)
        "normal_low": 11.5,
        "normal_high": 14.5,
        "plausible_low": 9,
        "plausible_high": 35,
        "sources": [
            "Standard CBC: RDW 11.5–14.5%",
        ],
    },
    "ap": {
        # Canonical unit: U/L
        # Normal: 44–147 U/L (Tietz, adult combined)
        # Plausible: very low ~5 U/L (hypophosphatasia),
        #   very high ~2000 U/L (Paget's disease, cholestasis)
        "normal_low": 35,
        "normal_high": 150,
        "plausible_low": 5,
        "plausible_high": 2000,
        "sources": [
            "Tietz: ALP 44–147 U/L (adult, method-dependent)",
            "Widened to 35–150 to accommodate inter-lab variation",
        ],
    },
}


def load_conversions(config_dir):
    """Load unit conversions from conversions.csv."""
    conversions = {}  # test_id -> [{unit, to_canonical_factor}]
    path = os.path.join(config_dir, "conversions.csv")
    with open(path) as f:
        reader = csv.DictReader(f)
        for row in reader:
            tid = row["test_id"]
            if tid not in conversions:
                conversions[tid] = []
            conversions[tid].append({
                "unit": row["unit"],
                "factor": float(row["to_canonical_factor"]),
            })
    return conversions


def load_tests(config_dir):
    """Load test definitions from tests.csv."""
    tests = {}
    path = os.path.join(config_dir, "tests.csv")
    with open(path) as f:
        reader = csv.DictReader(f)
        for row in reader:
            tests[row["test_id"]] = row
    return tests


def canonical_to_unit(value, factor):
    """Convert from canonical units to display unit. Display = canonical / factor."""
    return value / factor


def unit_to_canonical(value, factor):
    """Convert from display unit to canonical. Canonical = display * factor."""
    return value * factor


def check_unit_confusion(test_id, biomarker, conversions):
    """
    For each pair of units, check whether a normal-range value in one unit
    could be numerically plausible in another unit. Returns warnings and
    suggested plausible range adjustments.
    """
    convs = conversions.get(test_id, [])
    if len(convs) <= 1:
        return []

    warnings = []
    normal_low = biomarker["normal_low"]
    normal_high = biomarker["normal_high"]
    plausible_low = biomarker["plausible_low"]
    plausible_high = biomarker["plausible_high"]

    for i, conv_a in enumerate(convs):
        # Normal range in unit A's numerical values
        a_low = canonical_to_unit(normal_low, conv_a["factor"])
        a_high = canonical_to_unit(normal_high, conv_a["factor"])

        for j, conv_b in enumerate(convs):
            if i == j:
                continue

            # Plausible range in unit B's numerical values
            b_plaus_low = canonical_to_unit(plausible_low, conv_b["factor"])
            b_plaus_high = canonical_to_unit(plausible_high, conv_b["factor"])

            # Check: would a normal value in unit A (numerically) fall within
            # the plausible range of unit B?
            # If someone enters a_high thinking it's unit A but selects unit B,
            # the number a_high should be OUTSIDE b's plausible range.
            overlap_low = max(a_low, b_plaus_low)
            overlap_high = min(a_high, b_plaus_high)

            if overlap_low <= overlap_high:
                warnings.append({
                    "test_id": test_id,
                    "unit_intended": conv_a["unit"],
                    "unit_selected": conv_b["unit"],
                    "normal_range_intended": (a_low, a_high),
                    "plausible_range_selected": (b_plaus_low, b_plaus_high),
                    "overlap": (overlap_low, overlap_high),
                    "message": (
                        f"  OVERLAP: A normal {conv_a['unit']} value "
                        f"({a_low:.2f}–{a_high:.2f}) would appear plausible "
                        f"if entered as {conv_b['unit']} "
                        f"(plausible: {b_plaus_low:.2f}–{b_plaus_high:.2f}). "
                        f"Overlap region: {overlap_low:.2f}–{overlap_high:.2f}"
                    ),
                })

    return warnings


def suggest_tighter_plausible(test_id, biomarker, conversions):
    """
    For each unit, compute the tightest plausible range that still:
    1. Contains all clinically plausible values
    2. Excludes normal-range values from OTHER units

    Returns adjusted plausible bounds in canonical units.
    """
    convs = conversions.get(test_id, [])
    if len(convs) <= 1:
        return biomarker["plausible_low"], biomarker["plausible_high"]

    adj_plaus_low = biomarker["plausible_low"]
    adj_plaus_high = biomarker["plausible_high"]

    for i, conv_a in enumerate(convs):
        for j, conv_b in enumerate(convs):
            if i == j:
                continue

            # Normal range in unit B, as raw numbers
            b_normal_low = canonical_to_unit(biomarker["normal_low"], conv_b["factor"])
            b_normal_high = canonical_to_unit(biomarker["normal_high"], conv_b["factor"])

            # These raw numbers, if entered as unit A, would convert to canonical as:
            confused_canonical_low = unit_to_canonical(b_normal_low, conv_a["factor"])
            confused_canonical_high = unit_to_canonical(b_normal_high, conv_a["factor"])

            confused_lo = min(confused_canonical_low, confused_canonical_high)
            confused_hi = max(confused_canonical_low, confused_canonical_high)

            # If the confused range is ABOVE the normal range, tighten plausible_high
            if confused_lo > biomarker["normal_high"]:
                new_high = min(adj_plaus_high, confused_lo * 0.9)
                if new_high > biomarker["normal_high"]:
                    adj_plaus_high = new_high

            # If the confused range is BELOW the normal range, tighten plausible_low
            if confused_hi < biomarker["normal_low"]:
                new_low = max(adj_plaus_low, confused_hi * 1.1)
                if new_low < biomarker["normal_low"]:
                    adj_plaus_low = new_low

    return adj_plaus_low, adj_plaus_high


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_dir = os.path.dirname(script_dir)
    config_dir = os.path.join(repo_dir, "config")

    conversions = load_conversions(config_dir)
    tests = load_tests(config_dir)

    print("=" * 72)
    print("PhenoAge Biomarker Range Generation")
    print("=" * 72)

    # Check for unit-confusion issues and compute adjusted ranges
    adjusted = {}
    for test_id, bm in BIOMARKERS.items():
        canonical_unit = tests[test_id]["canonical_unit"]

        print(f"\n{'─' * 72}")
        print(f"{tests[test_id]['name']} ({test_id}) — canonical unit: {canonical_unit}")
        print(f"  Normal:    {bm['normal_low']} – {bm['normal_high']} {canonical_unit}")
        print(f"  Plausible: {bm['plausible_low']} – {bm['plausible_high']} {canonical_unit}")

        # Show ranges in all available units
        convs = conversions.get(test_id, [])
        if len(convs) > 1:
            print(f"  Available units:")
            for conv in convs:
                n_lo = canonical_to_unit(bm["normal_low"], conv["factor"])
                n_hi = canonical_to_unit(bm["normal_high"], conv["factor"])
                p_lo = canonical_to_unit(bm["plausible_low"], conv["factor"])
                p_hi = canonical_to_unit(bm["plausible_high"], conv["factor"])
                print(f"    {conv['unit']:>20s}: normal {n_lo:>10.3f} – {n_hi:<10.3f}"
                      f"  plausible {p_lo:>10.3f} – {p_hi:<10.3f}")

        # Check for unit confusion
        warnings = check_unit_confusion(test_id, bm, conversions)
        if warnings:
            print(f"  ⚠ Unit-confusion risks:")
            for w in warnings:
                print(w["message"])

        # Compute tightened plausible ranges
        adj_low, adj_high = suggest_tighter_plausible(test_id, bm, conversions)
        if adj_low != bm["plausible_low"] or adj_high != bm["plausible_high"]:
            print(f"  → Adjusted plausible: {adj_low:.4f} – {adj_high:.4f} {canonical_unit}")
            # Show in all units
            for conv in convs:
                a_lo = canonical_to_unit(adj_low, conv["factor"])
                a_hi = canonical_to_unit(adj_high, conv["factor"])
                print(f"    {conv['unit']:>20s}: {a_lo:>10.3f} – {a_hi:<10.3f}")
        else:
            adj_low, adj_high = bm["plausible_low"], bm["plausible_high"]

        adjusted[test_id] = {
            "normal_low": bm["normal_low"],
            "normal_high": bm["normal_high"],
            "plausible_low": round(adj_low, 4),
            "plausible_high": round(adj_high, 4),
        }

        # Print sources
        print(f"  Sources:")
        for src in bm["sources"]:
            print(f"    - {src}")

    # Write updated tests.csv with range columns
    tests_path = os.path.join(config_dir, "tests.csv")
    fieldnames = [
        "test_id", "name", "canonical_unit",
        "normal_low", "normal_high", "plausible_low", "plausible_high",
    ]

    rows = []
    with open(tests_path) as f:
        reader = csv.DictReader(f)
        for row in reader:
            test_id = row["test_id"]
            if test_id in adjusted:
                row.update(adjusted[test_id])
            else:
                row.update({
                    "normal_low": "",
                    "normal_high": "",
                    "plausible_low": "",
                    "plausible_high": "",
                })
            rows.append(row)

    with open(tests_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(f"\n{'=' * 72}")
    print(f"Written: {tests_path}")
    print(f"{'=' * 72}")


if __name__ == "__main__":
    main()
