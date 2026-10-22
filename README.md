# Africa Fiber Map

Interactive map of Africa's subsea and terrestrial fiber: every subsea cable
touching the continent (live and planned), aggregated terrestrial fiber in
derived Core / Distribution / Access tiers, landing stations, and major
cities, with owners, design capacity, egress-cost benchmarks and estimated
latency to US East / US West / Europe. Companion pages: a by-country table
and a sources & assumptions write-up.

Open `index.html` in a browser, or visit the hosted map.

## Deployment

The hosted map uses CARTO Positron tiles, which require a basemap API key.
Request a key from [CARTO Basemaps](https://www.carto.com/basemaps/apikey/index.html)
and restrict its allowed referrer host to `temboanetworks.github.io`.

Add the key to this repository as an Actions secret named
`CARTO_BASEMAP_KEY`, then configure GitHub Pages to use **GitHub Actions** as
its publishing source. Pushes to `main` build the static site, inject the key
into the deployment artifact, and publish it. The key is intentionally absent
from Git history, but it remains visible in browser requests; the CARTO
referrer restriction prevents ordinary use from unrelated websites.

To test the production build locally without using the real key:

```sh
CARTO_BASEMAP_KEY=test-key node scripts/build-pages.mjs
```

## Data & attribution

- Subsea cable geometry and metadata: [TeleGeography Submarine Cable Map](https://www.submarinecablemap.com/) (CC BY-SA).
- Terrestrial fiber and cities: [AfTerFibre](https://afterfibre.opentelecomdata.org/) / NSRC (CC BY).
- Basemap © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, © [CARTO](https://carto.com/attributions).

Capacities, egress rates and latencies are estimates; see the sources page
for methodology. Reuse of the underlying datasets carries their licenses.
