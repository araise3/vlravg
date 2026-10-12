# Ping map assets and model

- Server cities: user-provided current in-game screenshot, October 12, 2026: Frankfurt, Paris, London, Warsaw, Stockholm, Istanbul, Madrid. Riot Support at https://support.riotgames.com/en-us/valorant/support-tools/server-select also lists Bahrain; the user's current in-game list takes precedence. Coordinates approximate the cities, not datacenter addresses.
- Boundaries: Natural Earth 1:110m Admin 0 countries, https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_admin_0_countries.geojson. Public domain: https://www.naturalearthdata.com/about/terms-of-use/. `countries.js` retains Europe and nearby countries, trims properties, and rounds coordinates to four decimals. Generalized boundaries are for visualization. Omitted microstates use point markers.
- D3 7.9.0: https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js. ISC license in D3-LICENSE.txt. Vendored so the map does not depend on a CDN or tile provider at runtime.
- Routing context: https://technology.riotgames.com/news/leveling-networking-multi-game-future. This explains why geographic distance alone cannot predict an individual's VALORANT latency.

Country reference points are capitals (Ramallah is the reference point for Palestine). No location permission, API key, live ping probe, or user account is required.

Berlin observed reference pings from the user's screenshot: Frankfurt 13, Paris 19, London 24, Warsaw 31, Stockholm 35, Istanbul 44, Madrid 46 ms. These are a single connection's observations, not city averages.

Other country estimates use max(5, Berlin server ping + (capital-to-server distance − Berlin-to-server distance) × 0.016 ms/km). A roughly 200,000 km/s fiber speed gives 0.01 ms/km round trip, multiplied by an assumed 1.6 route-length allowance. The distance slope and floor are assumptions, not a fit across countries. Display ranges use ±25%, with a minimum ±5 ms; they are not statistical confidence intervals. Radius bands are geodesic boundaries of the same model; thresholds below a server's modeled baseline have no ring. Berlin is explicitly labeled observed rather than estimated. No data from the player's match history is used.
