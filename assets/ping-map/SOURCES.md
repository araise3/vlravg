# Ping map assets and model

- Server cities: user-provided current in-game screenshot, October 12, 2026: Frankfurt, Paris, London, Warsaw, Stockholm, Istanbul, Madrid, Riyadh. Riot Support at https://support.riotgames.com/en-us/valorant/support-tools/server-select also lists Bahrain; the user's current in-game list takes precedence. Coordinates approximate the cities, not datacenter addresses.
- Boundaries: Natural Earth 1:110m Admin 0 countries, https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_admin_0_countries.geojson. Public domain: https://www.naturalearthdata.com/about/terms-of-use/. `countries.js` retains Europe and nearby countries, trims properties, and rounds coordinates to four decimals. Generalized boundaries are for visualization. Omitted microstates use point markers.
- D3 7.9.0: https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js. ISC license in D3-LICENSE.txt. Vendored so the map does not depend on a CDN or tile provider at runtime.
- Routing context: https://technology.riotgames.com/news/leveling-networking-multi-game-future. This explains why geographic distance alone cannot predict an individual's VALORANT latency.

Countries use capital reference points unless an observed city is available (Luton for the United Kingdom, Jerez for Spain; Ramallah is the reference point for Palestine). The country selector provides the same selection without finding a small polygon. These are city references, not measured country averages. No location permission, API key, live ping probe, or user account is required.

Berlin observed reference pings from the user's screenshot: Frankfurt 13, Paris 19, London 24, Warsaw 31, Stockholm 35, Istanbul 44, Madrid 46, Riyadh 97 ms.

Tbilisi observed reference pings from the user's screenshot, October 13, 2026: Frankfurt 52, Paris 59, London 63, Warsaw 68, Stockholm 74, Istanbul 40, Madrid 85, Riyadh 136 ms. Selecting Georgia uses these exact values and labels them as observed Tbilisi references in the readout and tooltip. Each origin's values are a single connection's observations, not city or country averages.

Helsinki observed reference pings from the user's screenshot, October 14, 2026 (`Screenshot 2026-10-14 235846.png`): Frankfurt 33, Paris 39, London 38, Warsaw 28, Stockholm 15, Istanbul 63, Madrid 64, Riyadh 117 ms. Selecting Finland uses these exact values.

Luton observed reference pings from the user's screenshot, October 15, 2026 (`Screenshot 2026-10-15 172232.png`): Frankfurt 17, Paris 13, London 8, Warsaw 37, Stockholm 34, Istanbul 49, Madrid 40, Riyadh 104 ms. Selecting the United Kingdom uses Luton as its origin, not London. The user identified both screenshots' origin cities. Additional readings outside the map's server list are Helsinki: Mumbai 151, Cape Town 181, Tokyo 329 ms; Luton: Mumbai 126, Cape Town 156, Tokyo 229 ms.

Jerez observed reference pings from the user's screenshot, October 17, 2026 (`Screenshot 2026-10-17 231755.png`): Frankfurt 42, Paris 34, London 41, Warsaw 59, Stockholm 60, Istanbul 71, Madrid 19, Riyadh 108 ms. Selecting Spain uses Jerez as its reference instead of Madrid. Jerez is interpreted as Jerez de la Frontera, with approximate city coordinates [-6.137, 36.685]; the user supplied the origin city, not an exact connection location. Additional readings outside the map's server list: Mumbai 146, Cape Town 134, Tokyo 247 ms.

All five observed origins now calibrate the entire map independently for each server. For each sample, its routing offset is `measured ms − great-circle distance to server × 0.016 ms/km`. The server baseline is the median of its five offsets. At an unmeasured location, the estimate is:

```
weight_i = (1000 km / distance to sample_i)^2
correction = sum(weight_i × (sample offset_i − baseline)) / (1 + sum(weight_i))
ping = max(5, baseline + distance to server × 0.016 + correction)
```

At an observed coordinate, use the screenshot's exact value. The interpolated field approaches that value continuously. The inverse-square weighting spreads each sample's routing differences into nearby areas, instead of only overriding the observed country readouts. The denominator's prior weight of 1 fades corrections toward the median baseline away from samples. The 1000 km influence scale, distance slope and 5 ms floor are modeling assumptions, not validated routing measurements. There are no hard city or country boundaries. A roughly 200,000 km/s fiber speed gives 0.01 ms/km round trip; 0.016 allows an assumed 1.6 route-length factor. The distance term is only the extrapolation prior: the combined field is not radial or linear in server distance.

Contours use this same unrounded ping field at 10 ms thresholds from 10 through 150 ms, computed with D3 marching squares (https://d3js.org/d3-contour/contour). A 317 × 244 grid at 6 projected map units covers the map's pan extent. Every polygon boundary is rendered, including disconnected islands and interior holes; artificial closing edges at the grid boundary are omitted. Geometry is cached per server and reused when the country selection changes. Country colors and rounded readouts use the same model. Country selections for Germany, Georgia, Finland, the United Kingdom and Spain preserve the observed cities' reference coordinates and exact screenshot pings.

Five individual connections cannot establish real routing everywhere or reveal unobserved ISP boundaries. Contour irregularities are interpolations suggested by these samples, not measured coverage boundaries. Display ranges remain a heuristic ±25%, with a minimum ±5 ms; they are not statistical confidence intervals or a claim of validated prediction accuracy. Berlin, Tbilisi, Helsinki, Luton and Jerez are explicitly labeled observed; other locations are labeled sample-informed estimates. No data from the player's match history is used.

Held-origin prediction validation is reproducible with `node scripts/validate-ping-map.cjs`; the checked-in results and limitations are in [docs/ping-map-validation.md](../../docs/ping-map-validation.md). Each fold removes one city's eight readings and refits all per-server baselines from the other four cities before predicting. The evaluation compares the production interpolation against distance-only, nearest-city and median-ping baselines without tuning parameters. Tests also verify that changing a hidden city's readings cannot change its predictions.
