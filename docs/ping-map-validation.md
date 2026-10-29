# Ping map: held-origin validation

Reproduce with `node scripts/validate-ping-map.cjs`. Use `--json` for full precision results or `--write docs/ping-map-validation.md` to regenerate this report.

Each of 7 origins is hidden in turn, including all eight of its server readings. Each server model is rebuilt using the other 6 origins only, including recalculating its median routing offset. The current model is evaluated through the actual production ping surface with that training model. Parameters stay fixed at 0.016 ms/km and 1000 km influence; no parameter search is performed.

There are 56 city/server predictions, but only 7 distinct geographic holdouts. The eight server readings from one connection are related, so these are not 56 independent geographic samples. Predictions are scored before display rounding. Errors are predicted minus observed; positive bias means overprediction. All metrics are milliseconds.

## Model comparison

| Method | MAE | RMSE | Bias | Largest error |
|---|---:|---:|---:|---:|
| Current interpolation | 7.65 | 12.14 | -0.66 | 65.57 |
| Distance + median offset | 7.59 | 12.76 | -2.24 | 67.59 |
| Nearest measured city | 14.25 | 17.49 | -4.61 | 51.00 |
| Median measured ping | 14.71 | 18.48 | 0.13 | 47.00 |

Baselines use only training origins: distance plus median routing offset omits the local correction; nearest city copies the nearest origin's ping; median ping ignores geography. The old Berlin-only model is excluded because it cannot hold Berlin out without leaking its reading.

The current interpolation's mean absolute error is 7.65 ms versus 7.59 ms for the distance baseline, a deterioration of 0.06 ms on these holdouts. Its worst prediction is Tbilisi → Riyadh: 70.43 ms versus 136 ms observed. This is evidence of a routing difference the remaining origins do not predict, not evidence that the held-out reading is wrong.

## Current model by hidden city

| City | MAE | RMSE | Bias | Largest error |
|---|---:|---:|---:|---:|
| Berlin | 9.14 | 9.44 | 4.96 | 14.02 |
| Tbilisi | 15.37 | 25.15 | -10.54 | 65.57 |
| Helsinki | 3.22 | 3.51 | 3.22 | 5.66 |
| Luton | 7.37 | 9.31 | 7.37 | 17.70 |
| Jerez | 4.98 | 7.38 | 2.74 | 17.96 |
| Gothenburg | 10.32 | 11.67 | -9.29 | 16.40 |
| Saint Petersburg | 3.15 | 4.50 | -3.10 | 10.05 |

## Current model by server

| Server | MAE | RMSE | Bias | Largest error |
|---|---:|---:|---:|---:|
| Frankfurt | 4.98 | 6.51 | 0.14 | 13.70 |
| Paris | 5.50 | 7.64 | 0.36 | 16.40 |
| London | 5.39 | 6.74 | -0.01 | 14.41 |
| Warsaw | 5.42 | 7.56 | -2.15 | 17.61 |
| Stockholm | 6.21 | 8.43 | -2.52 | 18.73 |
| Istanbul | 7.73 | 9.29 | 2.37 | 16.32 |
| Madrid | 6.48 | 7.82 | 0.58 | 14.87 |
| Riyadh | 19.53 | 27.52 | -4.07 | 65.57 |

## Individual predictions

### Berlin held out

| Server | Screenshot | Predicted | Error |
|---|---:|---:|---:|
| Frankfurt | 13 | 20.51 | 7.51 |
| Paris | 19 | 28.73 | 9.73 |
| London | 24 | 30.11 | 6.11 |
| Warsaw | 31 | 24.20 | -6.80 |
| Stockholm | 35 | 25.05 | -9.95 |
| Istanbul | 44 | 54.32 | 10.32 |
| Madrid | 46 | 54.71 | 8.71 |
| Riyadh | 97 | 111.02 | 14.02 |

### Tbilisi held out

| Server | Screenshot | Predicted | Error |
|---|---:|---:|---:|
| Frankfurt | 52 | 56.11 | 4.11 |
| Paris | 59 | 63.41 | 4.41 |
| London | 63 | 67.23 | 4.23 |
| Warsaw | 68 | 50.39 | -17.61 |
| Stockholm | 74 | 55.27 | -18.73 |
| Istanbul | 40 | 46.60 | 6.60 |
| Madrid | 85 | 83.28 | -1.72 |
| Riyadh | 136 | 70.43 | -65.57 |

### Helsinki held out

| Server | Screenshot | Predicted | Error |
|---|---:|---:|---:|
| Frankfurt | 33 | 34.24 | 1.24 |
| Paris | 39 | 40.95 | 1.95 |
| London | 38 | 40.71 | 2.71 |
| Warsaw | 28 | 31.62 | 3.62 |
| Stockholm | 15 | 19.11 | 4.11 |
| Istanbul | 63 | 65.09 | 2.09 |
| Madrid | 64 | 69.66 | 5.66 |
| Riyadh | 117 | 121.42 | 4.42 |

### Luton held out

| Server | Screenshot | Predicted | Error |
|---|---:|---:|---:|
| Frankfurt | 17 | 21.84 | 4.84 |
| Paris | 13 | 17.43 | 4.43 |
| London | 8 | 13.76 | 5.76 |
| Warsaw | 37 | 41.64 | 4.64 |
| Stockholm | 34 | 37.77 | 3.77 |
| Istanbul | 49 | 65.32 | 16.32 |
| Madrid | 40 | 41.54 | 1.54 |
| Riyadh | 104 | 121.70 | 17.70 |

### Jerez held out

| Server | Screenshot | Predicted | Error |
|---|---:|---:|---:|
| Frankfurt | 42 | 38.77 | -3.23 |
| Paris | 34 | 32.70 | -1.30 |
| London | 41 | 37.18 | -3.82 |
| Warsaw | 59 | 60.74 | 1.74 |
| Stockholm | 60 | 62.39 | 2.39 |
| Istanbul | 71 | 70.36 | -0.64 |
| Madrid | 19 | 27.79 | 8.79 |
| Riyadh | 108 | 125.96 | 17.96 |

### Gothenburg held out

| Server | Screenshot | Predicted | Error |
|---|---:|---:|---:|
| Frankfurt | 35 | 21.30 | -13.70 |
| Paris | 42 | 25.60 | -16.40 |
| London | 40 | 25.59 | -14.41 |
| Warsaw | 30 | 31.45 | 1.45 |
| Stockholm | 19 | 21.65 | 2.65 |
| Istanbul | 68 | 55.90 | -12.10 |
| Madrid | 68 | 53.13 | -14.87 |
| Riyadh | 119 | 112.03 | -6.97 |

### Saint Petersburg held out

| Server | Screenshot | Predicted | Error |
|---|---:|---:|---:|
| Frankfurt | 37 | 37.20 | 0.20 |
| Paris | 44 | 43.73 | -0.27 |
| London | 44 | 43.34 | -0.66 |
| Warsaw | 33 | 30.93 | -2.07 |
| Stockholm | 23 | 21.13 | -1.87 |
| Istanbul | 67 | 60.98 | -6.02 |
| Madrid | 73 | 68.95 | -4.05 |
| Riyadh | 123 | 112.95 | -10.05 |

## Interpretation limits

This evaluates prediction at unseen origins, rather than the exact fit at known samples. A fold outside the remaining origins' coverage also tests extrapolation. This small set of cities cannot establish Europe-wide accuracy, ISP-specific behavior, temporal variation, or calibrated prediction intervals. Passing software tests does not establish predictive accuracy.

Treat these results as a diagnostic baseline. Changing parameters to improve this report would turn these same origins into tuning data; a later accuracy claim needs new held-out origins or a separate nested validation design. The estimate layer and current parameters are unchanged by this evaluation.
