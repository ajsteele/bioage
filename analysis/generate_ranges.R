#!/usr/bin/env Rscript
#
# generate_ranges.R
#
# Compute normal and plausible ranges for PhenoAge biomarkers using the
# NHANES III dataset from the BioAge R package. Outputs updated
# config/tests.csv with range columns for the web calculator.
#
# Usage:
#   Rscript analysis/generate_ranges.R
#
# Prerequisites:
#   install.packages("devtools")
#   devtools::install_github("dayoonkwon/BioAge")
#
# Methodology
# -----------
# 1. NORMAL ranges (amber warning when value is outside):
#    2.5th and 97.5th percentiles from the NHANES III cohort (adults 20-84,
#    the same population used to train PhenoAge in Levine 2018).
#
# 2. PLAUSIBLE ranges (red error, blocks calculation):
#    The wider of:
#    (a) 0.1th and 99.9th percentiles from NHANES III (data-driven floor)
#    (b) Clinical case-report extremes for severe pathology
#    Then tightened where possible to catch unit-confusion errors.
#
# 3. UNIT-CONFUSION DETECTION:
#    For biomarkers with multiple entry units, we check whether a normal
#    value entered in the wrong unit would still fall within the plausible
#    range. If so, we tighten the plausible range to exclude it.
#
# All ranges are in CANONICAL units as defined in config/tests.csv.

library(BioAge)

# ── Locate repo paths ──
script_dir <- dirname(sys.frame(1)$ofile)
if (is.null(script_dir) || script_dir == "") {
  # Fallback: assume working directory is the repo root
  script_dir <- "analysis"
}
repo_dir <- normalizePath(file.path(script_dir, ".."))
config_dir <- file.path(repo_dir, "config")

cat("Repository root:", repo_dir, "\n")
cat("Config directory:", config_dir, "\n\n")

# ── Load NHANES III data ──
data(NHANES3)
cat("NHANES III dataset:", nrow(NHANES3), "observations\n")
cat("Age range:", range(NHANES3$age, na.rm = TRUE), "\n\n")

# ── Mapping: our test_id -> BioAge column name -> canonical unit ──
# The BioAge package conveniently provides columns in multiple units.
# We use the columns that match our canonical units directly.
biomarker_map <- data.frame(
  test_id = c("albumin", "creatinine", "glucose", "crp",
              "wbc", "lymphocyte", "mcv", "rcdw", "ap"),
  column = c("albumin_gL", "creat_umol", "glucose_mmol", "crp",
             "wbc", "lymph", "mcv", "rdw", "alp"),
  canonical_unit = c("g/L", "umol/L", "mmol/L", "mg/L",
                     "10^9 cells/L", "%", "fL", "%", "U/L"),
  # For columns only available in non-canonical units, provide conversion
  # (all these are 1 because we're using the pre-converted columns)
  to_canonical = c(1, 1, 1, 1, 1, 1, 1, 1, 1),
  stringsAsFactors = FALSE
)

# ── Compute percentiles from NHANES III ──
cat(strrep("=", 72), "\n")
cat("PhenoAge Biomarker Ranges from NHANES III\n")
cat(strrep("=", 72), "\n")

results <- data.frame(
  test_id = character(),
  normal_low = numeric(),
  normal_high = numeric(),
  plausible_low = numeric(),
  plausible_high = numeric(),
  n = integer(),
  stringsAsFactors = FALSE
)

for (i in seq_len(nrow(biomarker_map))) {
  tid <- biomarker_map$test_id[i]
  col <- biomarker_map$column[i]
  unit <- biomarker_map$canonical_unit[i]
  conv <- biomarker_map$to_canonical[i]

  vals <- NHANES3[[col]]
  if (is.null(vals)) {
    cat("\n  WARNING: Column '", col, "' not found in NHANES3 dataset.\n")
    cat("  Available columns: ", paste(head(names(NHANES3), 20), collapse = ", "), "...\n")
    next
  }

  vals <- vals[!is.na(vals)] * conv
  n <- length(vals)

  # Normal range: 2.5th–97.5th percentile
  normal <- quantile(vals, probs = c(0.025, 0.975))

  # Data-driven plausible floor: 0.1th–99.9th percentile
  extreme <- quantile(vals, probs = c(0.001, 0.999))

  cat("\n", strrep("-", 72), "\n")
  cat(sprintf("%-25s (%s) — canonical unit: %s\n", tid, col, unit))
  cat(sprintf("  N = %d non-missing values\n", n))
  cat(sprintf("  Min: %.4f  Max: %.4f\n", min(vals), max(vals)))
  cat(sprintf("  2.5th pctile: %.4f  97.5th pctile: %.4f\n", normal[1], normal[2]))
  cat(sprintf("  0.1th pctile: %.4f  99.9th pctile: %.4f\n", extreme[1], extreme[2]))
  cat(sprintf("  Mean: %.4f  SD: %.4f  Median: %.4f\n", mean(vals), sd(vals), median(vals)))

  # Additional percentiles for reference
  pctiles <- quantile(vals, probs = c(0.01, 0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99))
  cat("  Percentiles:\n")
  cat(sprintf("    1st: %.3f  5th: %.3f  10th: %.3f  25th: %.3f  50th: %.3f\n",
              pctiles[1], pctiles[2], pctiles[3], pctiles[4], pctiles[5]))
  cat(sprintf("    75th: %.3f  90th: %.3f  95th: %.3f  99th: %.3f\n",
              pctiles[6], pctiles[7], pctiles[8], pctiles[9]))

  results <- rbind(results, data.frame(
    test_id = tid,
    normal_low = round(as.numeric(normal[1]), 4),
    normal_high = round(as.numeric(normal[2]), 4),
    plausible_low = round(as.numeric(extreme[1]), 4),
    plausible_high = round(as.numeric(extreme[2]), 4),
    n = n,
    stringsAsFactors = FALSE
  ))
}

cat("\n\n", strrep("=", 72), "\n")
cat("Summary of NHANES III-derived ranges (canonical units)\n")
cat(strrep("=", 72), "\n\n")
print(results, row.names = FALSE)

# ── Clinical plausible overrides ──
# The 0.1th/99.9th percentiles from NHANES III represent healthy-ish adults
# aged 20-84. For plausible ranges, we want to accommodate severe pathology
# that wouldn't appear in a population survey but could occur in a user.
# We take the WIDER of the NHANES extreme and the clinical case-report value.
clinical_plausible <- list(
  albumin     = c(low = 10,    high = 65),    # nephrotic syndrome / dehydration
  creatinine  = c(low = 15,    high = 1800),   # muscle wasting / severe AKI (~20 mg/dL)
  glucose     = c(low = 1.0,   high = 50),     # hypoglycemic coma / DKA-HHS
  crp         = c(low = 0.01,  high = 500),    # near-zero / severe sepsis
  wbc         = c(low = 0.5,   high = 300),    # severe neutropenia / leukaemia
  lymphocyte  = c(low = 1,     high = 99),     # severe lymphopenia / CLL
  mcv         = c(low = 50,    high = 140),    # severe iron deficiency / megaloblastic
  rcdw        = c(low = 9,     high = 35),     # very uniform / severe mixed deficiency
  ap          = c(low = 5,     high = 2000)    # hypophosphatasia / Paget's
)

for (i in seq_len(nrow(results))) {
  tid <- results$test_id[i]
  if (tid %in% names(clinical_plausible)) {
    clin <- clinical_plausible[[tid]]
    old_low <- results$plausible_low[i]
    old_high <- results$plausible_high[i]
    results$plausible_low[i] <- min(results$plausible_low[i], clin["low"])
    results$plausible_high[i] <- max(results$plausible_high[i], clin["high"])
    if (results$plausible_low[i] != old_low || results$plausible_high[i] != old_high) {
      cat(sprintf("  %s: plausible widened from [%.4f, %.4f] to [%.4f, %.4f] (clinical override)\n",
                  tid, old_low, old_high, results$plausible_low[i], results$plausible_high[i]))
    }
  }
}

# ── Unit-confusion tightening ──
# Load conversions.csv to check for unit-confusion risks
cat("\n", strrep("=", 72), "\n")
cat("Unit-confusion analysis\n")
cat(strrep("=", 72), "\n\n")

convs_csv <- read.csv(file.path(config_dir, "conversions.csv"),
                      stringsAsFactors = FALSE)

# Group conversions by test_id
conv_list <- split(convs_csv, convs_csv$test_id)

for (i in seq_len(nrow(results))) {
  tid <- results$test_id[i]
  convs <- conv_list[[tid]]
  if (is.null(convs) || nrow(convs) <= 1) next

  normal_lo <- results$normal_low[i]
  normal_hi <- results$normal_high[i]
  plaus_lo <- results$plausible_low[i]
  plaus_hi <- results$plausible_high[i]

  cat(sprintf("\n%s:\n", tid))

  # Show ranges in all units
  for (ci in seq_len(nrow(convs))) {
    u <- convs$unit[ci]
    f <- convs$to_canonical_factor[ci]
    cat(sprintf("  %-20s: normal %10.3f - %-10.3f  plausible %10.3f - %-10.3f\n",
                u, normal_lo / f, normal_hi / f, plaus_lo / f, plaus_hi / f))
  }

  # Check each pair for confusion risk
  for (a in seq_len(nrow(convs))) {
    for (b in seq_len(nrow(convs))) {
      if (a == b) next

      fa <- convs$to_canonical_factor[a]
      fb <- convs$to_canonical_factor[b]
      ua <- convs$unit[a]
      ub <- convs$unit[b]

      # Normal range in unit B as raw numbers
      b_normal_lo_raw <- normal_lo / fb
      b_normal_hi_raw <- normal_hi / fb

      # If entered as unit A, these raw numbers become canonical values:
      confused_lo <- min(b_normal_lo_raw * fa, b_normal_hi_raw * fa)
      confused_hi <- max(b_normal_lo_raw * fa, b_normal_hi_raw * fa)

      # Check overlap with plausible range
      overlap_lo <- max(confused_lo, plaus_lo)
      overlap_hi <- min(confused_hi, plaus_hi)

      if (overlap_lo <= overlap_hi) {
        cat(sprintf("  OVERLAP: normal %s value (%.2f-%.2f) entered as %s falls in plausible range\n",
                    ub, b_normal_lo_raw, b_normal_hi_raw, ua))

        # Tighten: if confused range is above normal, lower plausible_high
        if (confused_lo > normal_hi) {
          new_hi <- confused_lo * 0.9
          if (new_hi > normal_hi && new_hi < plaus_hi) {
            cat(sprintf("    -> Tightening plausible_high: %.4f -> %.4f\n", plaus_hi, new_hi))
            plaus_hi <- new_hi
          }
        }
        # If confused range is below normal, raise plausible_low
        if (confused_hi < normal_lo) {
          new_lo <- confused_hi * 1.1
          if (new_lo < normal_lo && new_lo > plaus_lo) {
            cat(sprintf("    -> Tightening plausible_low: %.4f -> %.4f\n", plaus_lo, new_lo))
            plaus_lo <- new_lo
          }
        }
      }
    }
  }

  results$plausible_low[i] <- round(plaus_lo, 4)
  results$plausible_high[i] <- round(plaus_hi, 4)
}

# ── Final summary ──
cat("\n\n", strrep("=", 72), "\n")
cat("Final ranges (canonical units)\n")
cat(strrep("=", 72), "\n\n")
print(results[, c("test_id", "normal_low", "normal_high", "plausible_low", "plausible_high")],
      row.names = FALSE)

# ── Write to config/tests.csv ──
tests_csv <- read.csv(file.path(config_dir, "tests.csv"),
                      stringsAsFactors = FALSE)

# Merge range columns
tests_csv$normal_low <- NULL
tests_csv$normal_high <- NULL
tests_csv$plausible_low <- NULL
tests_csv$plausible_high <- NULL

tests_out <- merge(tests_csv, results[, c("test_id", "normal_low", "normal_high",
                                           "plausible_low", "plausible_high")],
                   by = "test_id", all.x = TRUE)

# Preserve original column order
tests_out <- tests_out[, c("test_id", "name", "canonical_unit",
                            "normal_low", "normal_high",
                            "plausible_low", "plausible_high")]

# Preserve original row order
tests_out <- tests_out[match(tests_csv$test_id, tests_out$test_id), ]

output_path <- file.path(config_dir, "tests.csv")
write.csv(tests_out, output_path, row.names = FALSE)
cat("\nWritten:", output_path, "\n")
cat("Done.\n")
