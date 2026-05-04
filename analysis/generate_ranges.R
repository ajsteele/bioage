#!/usr/bin/env Rscript
#
# generate_ranges.R — PhenoAge Biomarker Range Analysis
#
# Dual-mode: works as both a headless script and a knitr::spin report.
#
#   Headless:  Rscript analysis/generate_ranges.R
#   Report:    knitr::spin("analysis/generate_ranges.R")  # -> HTML
#
# Prerequisites:
#   install.packages("devtools")
#   devtools::install_github("dayoonkwon/BioAge")

#' ---
#' title: "PhenoAge Biomarker Range Analysis"
#' subtitle: "NHANES III data exploration and config generation"
#' output:
#'   html_document:
#'     toc: true
#'     toc_float: true
#'     code_folding: hide
#' ---

#+ setup, include=FALSE
is_spinning <- isTRUE(getOption("knitr.in.progress"))
if (is_spinning) {
  knitr::opts_chunk$set(echo = TRUE, warning = FALSE, message = FALSE,
                        fig.width = 9, fig.height = 5)
}

#' # Overview
#'
#' This script computes normal ranges, plausible ranges, and age-stratified
#' median defaults for the PhenoAge biological age calculator, using the
#' NHANES III dataset from the BioAge R package. It writes:
#'
#' - `config/tests.csv` — updated with data-driven normal and plausible ranges
#' - `config/defaults.csv` — LOESS-smoothed medians at each integer age (20-84)
#'
#' ## Methodology
#'
#' 1. **Normal ranges** (amber warning): 2.5th-97.5th percentiles from NHANES III
#' 2. **Plausible ranges** (red error): wider of 0.1th-99.9th percentiles and
#'    clinical case-report extremes, then tightened to catch unit-confusion errors
#' 3. **Manual overrides** from `config/overrides.csv` applied last (always win)
#' 4. **Age defaults**: raw medians at each integer age, LOESS-smoothed

#+ install-bioage
if (!requireNamespace("BioAge", quietly = TRUE)) {
  if (!requireNamespace("devtools", quietly = TRUE)) {
    install.packages("devtools")
  }
  devtools::install_github("dayoonkwon/BioAge")
}
library(BioAge)

#+ paths
# Locate repo root: sys.frame(1)$ofile exists when run via Rscript/source(),
# but not when knitting via spin. Fall back to getwd() parent in that case.
script_dir <- tryCatch(
  dirname(sys.frame(1)$ofile),
  error = function(e) NULL
)
if (is.null(script_dir) || script_dir == "") {
  # Spinning or interactive: assume working directory is analysis/
  repo_dir <- normalizePath(file.path(getwd(), ".."))
} else {
  repo_dir <- normalizePath(file.path(script_dir, ".."))
}
config_dir <- file.path(repo_dir, "config")
cat("Repository root:", repo_dir, "\nConfig directory:", config_dir, "\n")

#' # Load NHANES III

#+ load-data
data(NHANES3)
cat("NHANES III dataset:", nrow(NHANES3), "observations\n")
cat("Age range:", range(NHANES3$age, na.rm = TRUE), "\n")

#+ biomarker-map
biomarker_map <- data.frame(
  test_id = c("albumin", "creatinine", "glucose", "crp",
              "wbc", "lymphocyte", "mcv", "rcdw", "ap"),
  column = c("albumin_gL", "creat_umol", "glucose_mmol", "crp",
             "wbc", "lymph", "mcv", "rdw", "alp"),
  canonical_unit = c("g/L", "umol/L", "mmol/L", "mg/dL",
                     "10^9 cells/L", "%", "fL", "%", "U/L"),
  to_canonical = c(1, 1, 1, 1, 1, 1, 1, 1, 1),
  stringsAsFactors = FALSE
)

#' # Distribution of each biomarker {.tabset}
#'
#' Histograms of each biomarker across the full NHANES III cohort, with the
#' 2.5th/97.5th (normal) and 0.1th/99.9th (plausible) percentile boundaries.

#+ compute-ranges
results <- data.frame(
  test_id = character(),
  normal_low = numeric(), normal_high = numeric(),
  plausible_low = numeric(), plausible_high = numeric(),
  n = integer(),
  stringsAsFactors = FALSE
)

biomarker_vals <- list()

for (i in seq_len(nrow(biomarker_map))) {
  tid <- biomarker_map$test_id[i]
  col <- biomarker_map$column[i]
  unit <- biomarker_map$canonical_unit[i]
  conv <- biomarker_map$to_canonical[i]

  vals <- NHANES3[[col]]
  if (is.null(vals)) {
    warning(paste("Column", col, "not found in NHANES3"))
    next
  }

  vals <- vals[!is.na(vals)] * conv
  biomarker_vals[[tid]] <- vals
  n <- length(vals)

  normal <- quantile(vals, probs = c(0.025, 0.975))
  extreme <- quantile(vals, probs = c(0.001, 0.999))

  cat(sprintf("\n%s (%s) — %s: N=%d, normal=[%.3f, %.3f], extreme=[%.3f, %.3f]\n",
              tid, col, unit, n, normal[1], normal[2], extreme[1], extreme[2]))

  pctiles <- quantile(vals, probs = c(0.01, 0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99))
  cat(sprintf("  1st: %.3f  5th: %.3f  25th: %.3f  50th: %.3f  75th: %.3f  95th: %.3f  99th: %.3f\n",
              pctiles[1], pctiles[2], pctiles[4], pctiles[5], pctiles[6], pctiles[8], pctiles[9]))

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

#+ histograms, results='asis', fig.height=4, eval=is_spinning
for (i in seq_len(nrow(results))) {
  tid <- results$test_id[i]
  unit <- biomarker_map$canonical_unit[biomarker_map$test_id == tid]
  vals <- biomarker_vals[[tid]]

  cat(sprintf("\n## %s\n\n", tid))

  qlim <- quantile(vals, probs = c(0.001, 0.999))
  trimmed <- vals[vals >= qlim[1] & vals <= qlim[2]]

  hist(trimmed, breaks = 80, col = "steelblue", border = "white",
       main = paste0(tid, " (", unit, ") — N = ", format(length(vals), big.mark = ",")),
       xlab = unit, ylab = "Frequency")
  abline(v = results$normal_low[i], col = "orange", lwd = 2, lty = 2)
  abline(v = results$normal_high[i], col = "orange", lwd = 2, lty = 2)
  abline(v = results$plausible_low[i], col = "red", lwd = 2, lty = 3)
  abline(v = results$plausible_high[i], col = "red", lwd = 2, lty = 3)
  legend("topright", legend = c("Normal (2.5-97.5%)", "Plausible (0.1-99.9%)"),
         col = c("orange", "red"), lty = c(2, 3), lwd = 2, cex = 0.8)

  cat(sprintf("\n- **Normal range**: %.3f - %.3f %s\n", results$normal_low[i], results$normal_high[i], unit))
  cat(sprintf("- **Plausible range**: %.3f - %.3f %s\n\n", results$plausible_low[i], results$plausible_high[i], unit))
}

#' # Percentile summary

#+ percentile-table, eval=is_spinning
knitr::kable(results[, c("test_id", "normal_low", "normal_high",
                          "plausible_low", "plausible_high", "n")],
             caption = "NHANES III-derived ranges (canonical units)")

#+ percentile-print, eval=!is_spinning
print(results, row.names = FALSE)

#' # Unit-confusion tightening

#+ unit-confusion
convs_csv <- read.csv(file.path(config_dir, "conversions.csv"),
                      stringsAsFactors = FALSE)
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

  for (ci in seq_len(nrow(convs))) {
    u <- convs$unit[ci]
    f <- convs$to_canonical_factor[ci]
    cat(sprintf("  %-20s: normal %10.3f - %-10.3f  plausible %10.3f - %-10.3f\n",
                u, normal_lo / f, normal_hi / f, plaus_lo / f, plaus_hi / f))
  }

  for (a in seq_len(nrow(convs))) {
    for (b in seq_len(nrow(convs))) {
      if (a == b) next
      fa <- convs$to_canonical_factor[a]
      fb <- convs$to_canonical_factor[b]
      ua <- convs$unit[a]
      ub <- convs$unit[b]

      b_normal_lo_raw <- normal_lo / fb
      b_normal_hi_raw <- normal_hi / fb
      confused_lo <- min(b_normal_lo_raw * fa, b_normal_hi_raw * fa)
      confused_hi <- max(b_normal_lo_raw * fa, b_normal_hi_raw * fa)

      overlap_lo <- max(confused_lo, plaus_lo)
      overlap_hi <- min(confused_hi, plaus_hi)

      if (overlap_lo <= overlap_hi) {
        cat(sprintf("  OVERLAP: normal %s value (%.2f-%.2f) entered as %s falls in plausible range\n",
                    ub, b_normal_lo_raw, b_normal_hi_raw, ua))

        if (confused_lo > normal_hi) {
          new_hi <- confused_lo * 0.9
          if (new_hi > normal_hi && new_hi < plaus_hi) {
            cat(sprintf("    -> Tightening plausible_high: %.4f -> %.4f\n", plaus_hi, new_hi))
            plaus_hi <- new_hi
          }
        }
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

#' # Manual overrides
#'
#' Values from `config/overrides.csv` are applied last and always win over
#' computed ranges. This is for cases where algorithmic derivation can't
#' capture domain knowledge (e.g. hsCRP plausible floor).

#+ manual-overrides
overrides_path <- file.path(config_dir, "overrides.csv")
if (file.exists(overrides_path)) {
  overrides <- read.csv(overrides_path, stringsAsFactors = FALSE)
  cat(sprintf("Loaded %d manual override(s) from overrides.csv\n", nrow(overrides)))

  for (j in seq_len(nrow(overrides))) {
    tid <- overrides$test_id[j]
    field <- overrides$field[j]
    value <- overrides$value[j]
    reason <- overrides$reason[j]

    idx <- which(results$test_id == tid)
    if (length(idx) == 0) {
      cat(sprintf("  WARNING: override for unknown test_id '%s', skipping\n", tid))
      next
    }
    if (!(field %in% c("normal_low", "normal_high", "plausible_low", "plausible_high"))) {
      cat(sprintf("  WARNING: override for unknown field '%s', skipping\n", field))
      next
    }

    old_val <- results[[field]][idx]
    results[[field]][idx] <- value
    cat(sprintf("  %s.%s: %.4f -> %.4f (%s)\n", tid, field, old_val, value, reason))
  }
} else {
  cat("No overrides.csv found, skipping manual overrides.\n")
}

#' # Final ranges

#+ final-ranges-table, eval=is_spinning
knitr::kable(results[, c("test_id", "normal_low", "normal_high",
                          "plausible_low", "plausible_high")],
             caption = "Final ranges after clinical overrides, unit-confusion tightening, and manual overrides")

#+ final-ranges-print, eval=!is_spinning
cat("\nFinal ranges (canonical units):\n")
print(results[, c("test_id", "normal_low", "normal_high", "plausible_low", "plausible_high")],
      row.names = FALSE)

#' # Age-stratified defaults {.tabset}
#'
#' For each biomarker, we compute the raw median at each integer age,
#' then fit a LOESS smooth. In the report, plots show:
#'
#' - **Grey dots**: raw medians at each integer age
#' - **Blue line**: LOESS-smoothed median
#' - **Orange band**: 2.5th-97.5th percentile at each age (raw)
#' - **Red dots**: 97.5th percentile at each age

#+ age-defaults
age_range <- 20:84
ages_all <- floor(NHANES3$age)

medians_df <- data.frame(age = age_range)

for (i in seq_len(nrow(biomarker_map))) {
  tid <- biomarker_map$test_id[i]
  col <- biomarker_map$column[i]
  conv <- biomarker_map$to_canonical[i]
  unit <- biomarker_map$canonical_unit[i]

  vals <- NHANES3[[col]] * conv

  raw_medians <- sapply(age_range, function(a) {
    v <- vals[ages_all == a & !is.na(vals)]
    if (length(v) >= 5) median(v) else NA
  })

  valid <- !is.na(raw_medians)
  if (sum(valid) >= 10) {
    fit <- loess(raw_medians[valid] ~ age_range[valid], span = 0.4)
    smoothed <- predict(fit, newdata = data.frame(x = age_range))
    smoothed[!valid & is.na(smoothed)] <- NA
  } else {
    smoothed <- raw_medians
  }

  medians_df[[tid]] <- round(smoothed, 4)

  cat(sprintf("  %s: smoothed %d ages (%.1f-%.1f range)\n",
              tid, sum(!is.na(smoothed)),
              min(smoothed, na.rm = TRUE), max(smoothed, na.rm = TRUE)))
}

#+ age-plots, results='asis', fig.height=5, eval=is_spinning
for (i in seq_len(nrow(biomarker_map))) {
  tid <- biomarker_map$test_id[i]
  col <- biomarker_map$column[i]
  conv <- biomarker_map$to_canonical[i]
  unit <- biomarker_map$canonical_unit[i]

  vals <- NHANES3[[col]] * conv

  cat(sprintf("\n## %s\n\n", tid))

  raw_medians <- sapply(age_range, function(a) {
    v <- vals[ages_all == a & !is.na(vals)]
    if (length(v) >= 5) median(v) else NA
  })
  raw_p025 <- sapply(age_range, function(a) {
    v <- vals[ages_all == a & !is.na(vals)]
    if (length(v) >= 5) quantile(v, 0.025) else NA
  })
  raw_p975 <- sapply(age_range, function(a) {
    v <- vals[ages_all == a & !is.na(vals)]
    if (length(v) >= 5) quantile(v, 0.975) else NA
  })
  raw_n <- sapply(age_range, function(a) sum(ages_all == a & !is.na(vals)))

  ylim <- range(c(raw_p025, raw_p975), na.rm = TRUE)
  plot(age_range, raw_medians, pch = 16, col = "grey50", cex = 0.8,
       xlab = "Age (years)", ylab = paste0(tid, " (", unit, ")"),
       main = paste0(tid, " — median and 95% range by age"), ylim = ylim)

  valid_band <- !is.na(raw_p025) & !is.na(raw_p975)
  polygon(c(age_range[valid_band], rev(age_range[valid_band])),
          c(raw_p025[valid_band], rev(raw_p975[valid_band])),
          col = rgb(1, 0.65, 0, 0.15), border = NA)
  points(age_range, raw_p975, pch = 4, col = "red", cex = 0.6)
  points(age_range, raw_p025, pch = 4, col = "red", cex = 0.6)
  lines(age_range, medians_df[[tid]], col = "steelblue", lwd = 2.5)
  legend("topright",
         legend = c("Raw median", "LOESS smooth", "2.5th/97.5th pctile"),
         col = c("grey50", "steelblue", "red"),
         pch = c(16, NA, 4), lty = c(NA, 1, NA), lwd = c(NA, 2.5, NA),
         cex = 0.8, bg = "white")

  cat(sprintf("\n- **Age coverage**: %d of %d integer ages have N >= 5\n",
              sum(raw_n >= 5), length(age_range)))
  cat(sprintf("- **N per age**: min %d, median %d, max %d\n",
              min(raw_n), median(raw_n), max(raw_n)))
  cat(sprintf("- **LOESS range**: %.3f - %.3f %s\n\n",
              min(medians_df[[tid]], na.rm = TRUE), max(medians_df[[tid]], na.rm = TRUE), unit))
}

#' # Sample size by age

#+ sample-size, fig.height=4, eval=is_spinning
n_per_age <- sapply(age_range, function(a) sum(ages_all == a, na.rm = TRUE))
barplot(n_per_age, names.arg = age_range, col = "steelblue", border = "white",
        xlab = "Age (years)", ylab = "N observations",
        main = "NHANES III sample size by integer age")

#' # Write output files

#+ write-outputs
medians_path <- file.path(config_dir, "defaults.csv")
write.csv(medians_df, medians_path, row.names = FALSE)
cat("Written:", medians_path, "\n")

#+ defaults-preview, eval=is_spinning
knitr::kable(head(medians_df, 10), caption = "First 10 rows of defaults.csv")

#+ write-tests
tests_csv <- read.csv(file.path(config_dir, "tests.csv"), stringsAsFactors = FALSE)

tests_csv$normal_low <- NULL
tests_csv$normal_high <- NULL
tests_csv$plausible_low <- NULL
tests_csv$plausible_high <- NULL

tests_out <- merge(tests_csv, results[, c("test_id", "normal_low", "normal_high",
                                           "plausible_low", "plausible_high")],
                   by = "test_id", all.x = TRUE)

tests_out <- tests_out[, c("test_id", "name", "canonical_unit",
                            "normal_low", "normal_high",
                            "plausible_low", "plausible_high")]
tests_out <- tests_out[match(tests_csv$test_id, tests_out$test_id), ]

output_path <- file.path(config_dir, "tests.csv")
write.csv(tests_out, output_path, row.names = FALSE)
cat("Written:", output_path, "\n")

#+ tests-preview, eval=is_spinning
knitr::kable(tests_out, caption = "Final tests.csv", row.names = FALSE)

#+ done, eval=!is_spinning
cat("Done.\n")
