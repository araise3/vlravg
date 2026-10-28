# Ping map: held-origin validation

Reproduce with `node scripts/validate-ping-map.cjs`. Use `--json` for full precision results or `--write docs/ping-map-validation.md` to regenerate this report.

Each of 6 origins is hidden in turn, including all eight of its server readings. Each server model is rebuilt using the other 5 origins only, including recalculating its median routing offset. The current model is evaluated through the actual production ping surface with that training model. Parameters stay fixed at 0.016 ms/km and 1000 km influence; no parameter search is performed.

There are 48 city/server predictions, but only 6 distinct geographic holdouts. The eight server readings from one connection are related, so these are not 48 independent geographic samples. Predictions are scored before display rounding. Errors are predicted minus observed; positive bias means overprediction. All metrics are milliseconds.

## Model comparison

| Method | MAE | RMSE | Bias | Largest error |
|---|---:|---:|---:|---:|
| Current interpolation | 9.10 | 13.90 | -1.05 | 72.63 |
| Distance + median offset | 8.50 | 14.40 | -3.14 | 75.25 |
| Nearest measured city | 15.98 | 19.75 | -5.85 | 59.00 |
| Median measured ping | 16.77 | 20.05 | -0.65 | 45.00 |

Baselines use only training origins: distance plus median routing offset omits the local correction; nearest city copies the nearest origin's ping; median ping ignores geography. The old Berlin-only model is excluded because it cannot hold Berlin out without leaking its reading.

The current interpolation's mean absolute error is 9.10 ms versus 8.50 ms for the distance baseline, a deterioration of 0.60 ms on these holdouts. Its worst prediction is Tbilisi → Riyadh: 63.37 ms versus 136 ms observed. This is evidence of a routing difference the remaining origins do not predict, not evidence that the held-out reading is wrong.

## Current model by hidden city

| City | MAE | RMSE | Bias | Largest error |
|---|---:|---:|---:|---:|
| Berlin | 9.01 | 9.20 | 4.77 | 12.63 |
| Tbilisi | 16.00 | 27.45 | -12.11 | 72.63 |
| Helsinki | 5.91 | 6.14 | 2.19 | 9.36 |
| Luton | 7.03 | 8.73 | 7.03 | 16.43 |
| Jerez | 5.36 | 7.11 | 1.98 | 16.61 |
| Gothenburg | 11.29 | 12.54 | -10.15 | 16.84 |

## Current model by server

| Server | MAE | RMSE | Bias | Largest error |
|---|---:|---:|---:|---:|
| Frankfurt | 6.42 | 7.42 | 0.40 | 14.10 |
| Paris | 6.99 | 8.63 | 0.77 | 16.84 |
| London | 6.73 | 7.65 | 0.55 | 14.60 |
| Warsaw | 6.34 | 8.44 | -1.99 | 18.05 |
| Stockholm | 7.53 | 9.42 | -2.10 | 18.89 |
| Istanbul | 8.50 | 9.66 | 0.71 | 14.95 |
| Madrid | 7.25 | 8.64 | 1.10 | 15.60 |
| Riyadh | 23.05 | 32.10 | -7.83 | 72.63 |

## Individual predictions

### Berlin held out

| Server | Screenshot | Predicted | Error |
|---|---:|---:|---:|
| Frankfurt | 13 | 20.91 | 7.91 |
| Paris | 19 | 29.15 | 10.15 |
| London | 24 | 30.43 | 6.43 |
| Warsaw | 31 | 24.05 | -6.95 |
| Stockholm | 35 | 25.01 | -9.99 |
| Istanbul | 44 | 53.17 | 9.17 |
| Madrid | 46 | 54.85 | 8.85 |
| Riyadh | 97 | 109.63 | 12.63 |

### Tbilisi held out

| Server | Screenshot | Predicted | Error |
|---|---:|---:|---:|
| Frankfurt | 52 | 56.07 | 4.07 |
| Paris | 59 | 63.13 | 4.13 |
| London | 63 | 66.84 | 3.84 |
| Warsaw | 68 | 49.95 | -18.05 |
| Stockholm | 74 | 55.11 | -18.89 |
| Istanbul | 40 | 43.50 | 3.50 |
| Madrid | 85 | 82.15 | -2.85 |
| Riyadh | 136 | 63.37 | -72.63 |

### Helsinki held out

| Server | Screenshot | Predicted | Error |
|---|---:|---:|---:|
| Frankfurt | 33 | 36.54 | 3.54 |
| Paris | 39 | 43.56 | 4.56 |
| London | 38 | 43.82 | 5.82 |
| Warsaw | 28 | 32.96 | 4.96 |
| Stockholm | 15 | 21.54 | 6.54 |
| Istanbul | 63 | 57.47 | -5.53 |
| Madrid | 64 | 70.95 | 6.95 |
| Riyadh | 117 | 107.64 | -9.36 |

### Luton held out

| Server | Screenshot | Predicted | Error |
|---|---:|---:|---:|
| Frankfurt | 17 | 21.93 | 4.93 |
| Paris | 13 | 17.42 | 4.42 |
| London | 8 | 13.74 | 5.74 |
| Warsaw | 37 | 41.76 | 4.76 |
| Stockholm | 34 | 38.05 | 4.05 |
| Istanbul | 49 | 63.95 | 14.95 |
| Madrid | 40 | 40.95 | 0.95 |
| Riyadh | 104 | 120.43 | 16.43 |

### Jerez held out

| Server | Screenshot | Predicted | Error |
|---|---:|---:|---:|
| Frankfurt | 42 | 38.06 | -3.94 |
| Paris | 34 | 32.18 | -1.82 |
| London | 41 | 37.09 | -3.91 |
| Warsaw | 59 | 60.79 | 1.79 |
| Stockholm | 60 | 62.66 | 2.66 |
| Istanbul | 71 | 67.12 | -3.88 |
| Madrid | 19 | 27.30 | 8.30 |
| Riyadh | 108 | 124.61 | 16.61 |

### Gothenburg held out

| Server | Screenshot | Predicted | Error |
|---|---:|---:|---:|
| Frankfurt | 35 | 20.90 | -14.10 |
| Paris | 42 | 25.16 | -16.84 |
| London | 40 | 25.40 | -14.60 |
| Warsaw | 30 | 31.55 | 1.55 |
| Stockholm | 19 | 22.03 | 3.03 |
| Istanbul | 68 | 54.04 | -13.96 |
| Madrid | 68 | 52.40 | -15.60 |
| Riyadh | 119 | 108.35 | -10.65 |

## Interpretation limits

This evaluates prediction at unseen origins, rather than the exact fit at known samples. A fold outside the remaining origins' coverage also tests extrapolation. This small set of cities cannot establish Europe-wide accuracy, ISP-specific behavior, temporal variation, or calibrated prediction intervals. Passing software tests does not establish predictive accuracy.

Treat these results as a diagnostic baseline. Changing parameters to improve this report would turn these same origins into tuning data; a later accuracy claim needs new held-out origins or a separate nested validation design. The estimate layer and current parameters are unchanged by this evaluation.
