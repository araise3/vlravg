# Ping map: held-origin validation

Reproduce with `node scripts/validate-ping-map.cjs`. Use `--json` for full precision results or `--write docs/ping-map-validation.md` to regenerate this report.

Each of 5 origins is hidden in turn, including all eight of its server readings. Each server model is rebuilt using the other 4 origins only, including recalculating its median routing offset. The current model is evaluated through the actual production ping surface with that training model. Parameters stay fixed at 0.016 ms/km and 1000 km influence; no parameter search is performed.

There are 40 city/server predictions, but only 5 distinct geographic holdouts. The eight server readings from one connection are related, so these are not 40 independent geographic samples. Predictions are scored before display rounding. Errors are predicted minus observed; positive bias means overprediction. All metrics are milliseconds.

## Model comparison

| Method | MAE | RMSE | Bias | Largest error |
|---|---:|---:|---:|---:|
| Current interpolation | 7.53 | 14.08 | -2.13 | 75.36 |
| Distance + median offset | 7.72 | 14.63 | -2.31 | 77.68 |
| Nearest measured city | 15.90 | 19.66 | -10.00 | 59.00 |
| Median measured ping | 19.15 | 21.83 | -1.55 | 42.00 |

Baselines use only training origins: distance plus median routing offset omits the local correction; nearest city copies the nearest origin's ping; median ping ignores geography. The old Berlin-only model is excluded because it cannot hold Berlin out without leaking its reading.

The current interpolation's mean absolute error is 7.53 ms versus 7.72 ms for the distance baseline, an improvement of 0.19 ms on these holdouts. Its worst prediction is Tbilisi → Riyadh: 60.64 ms versus 136 ms observed. This is evidence of a routing difference the remaining origins do not predict, not evidence that the held-out reading is wrong.

## Current model by hidden city

| City | MAE | RMSE | Bias | Largest error |
|---|---:|---:|---:|---:|
| Berlin | 4.36 | 5.58 | -0.49 | 10.57 |
| Tbilisi | 15.67 | 28.34 | -13.67 | 75.36 |
| Helsinki | 6.29 | 8.20 | -1.90 | 14.82 |
| Luton | 5.42 | 6.91 | 4.53 | 12.59 |
| Jerez | 5.89 | 6.50 | 0.86 | 12.51 |

## Current model by server

| Server | MAE | RMSE | Bias | Largest error |
|---|---:|---:|---:|---:|
| Frankfurt | 2.46 | 2.83 | -0.53 | 5.11 |
| Paris | 2.30 | 2.56 | -0.31 | 3.62 |
| London | 2.34 | 2.96 | -0.39 | 5.55 |
| Warsaw | 8.55 | 10.09 | -2.10 | 18.68 |
| Stockholm | 10.21 | 11.31 | -1.62 | 19.02 |
| Istanbul | 6.50 | 8.04 | -0.84 | 12.47 |
| Madrid | 3.28 | 3.88 | 0.24 | 6.52 |
| Riyadh | 24.57 | 35.42 | -11.50 | 75.36 |

## Individual predictions

### Berlin held out

| Server | Screenshot | Predicted | Error |
|---|---:|---:|---:|
| Frankfurt | 13 | 14.34 | 1.34 |
| Paris | 19 | 21.59 | 2.59 |
| London | 24 | 23.13 | -0.87 |
| Warsaw | 31 | 23.06 | -7.94 |
| Stockholm | 35 | 24.43 | -10.57 |
| Istanbul | 44 | 46.21 | 2.21 |
| Madrid | 46 | 47.79 | 1.79 |
| Riyadh | 97 | 104.55 | 7.55 |

### Tbilisi held out

| Server | Screenshot | Predicted | Error |
|---|---:|---:|---:|
| Frankfurt | 52 | 54.28 | 2.28 |
| Paris | 59 | 61.40 | 2.40 |
| London | 63 | 65.68 | 2.68 |
| Warsaw | 68 | 49.32 | -18.68 |
| Stockholm | 74 | 54.98 | -19.02 |
| Istanbul | 40 | 40.62 | 0.62 |
| Madrid | 85 | 80.70 | -4.30 |
| Riyadh | 136 | 60.64 | -75.36 |

### Helsinki held out

| Server | Screenshot | Predicted | Error |
|---|---:|---:|---:|
| Frankfurt | 33 | 30.63 | -2.37 |
| Paris | 39 | 36.32 | -2.68 |
| London | 38 | 37.58 | -0.42 |
| Warsaw | 28 | 35.13 | 7.13 |
| Stockholm | 15 | 24.95 | 9.95 |
| Istanbul | 63 | 50.53 | -12.47 |
| Madrid | 64 | 64.49 | 0.49 |
| Riyadh | 117 | 102.18 | -14.82 |

### Luton held out

| Server | Screenshot | Predicted | Error |
|---|---:|---:|---:|
| Frankfurt | 17 | 18.19 | 1.19 |
| Paris | 13 | 12.76 | -0.24 |
| London | 8 | 10.20 | 2.20 |
| Warsaw | 37 | 43.21 | 6.21 |
| Stockholm | 34 | 40.34 | 6.34 |
| Istanbul | 49 | 60.29 | 11.29 |
| Madrid | 40 | 36.69 | -3.31 |
| Riyadh | 104 | 116.59 | 12.59 |

### Jerez held out

| Server | Screenshot | Predicted | Error |
|---|---:|---:|---:|
| Frankfurt | 42 | 36.89 | -5.11 |
| Paris | 34 | 30.38 | -3.62 |
| London | 41 | 35.45 | -5.55 |
| Warsaw | 59 | 61.78 | 2.78 |
| Stockholm | 60 | 65.18 | 5.18 |
| Istanbul | 71 | 65.12 | -5.88 |
| Madrid | 19 | 25.52 | 6.52 |
| Riyadh | 108 | 120.51 | 12.51 |

## Interpretation limits

This evaluates prediction at unseen origins, rather than the exact fit at known samples. A fold outside the remaining origins' coverage also tests extrapolation. This small set of cities cannot establish Europe-wide accuracy, ISP-specific behavior, temporal variation, or calibrated prediction intervals. Passing software tests does not establish predictive accuracy.

Treat these results as a diagnostic baseline. Changing parameters to improve this report would turn these same origins into tuning data; a later accuracy claim needs new held-out origins or a separate nested validation design. The estimate layer and current parameters are unchanged by this evaluation.
