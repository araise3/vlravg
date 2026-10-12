# Lotus static art overlay

The original Lotus geometry export skipped the serialized always-loaded
`Jam_ArtDefPathCExterior` level because its package name lacks the usual
`Jam_Art_` separator. A separate overlay now contains this exact level's
94,461 opaque triangles from 134 mesh instances and 72 source components.
The original 2,358,348-triangle export remains unchanged.

`export-transcription-map.py` accepts only the exact Lotus naming exception.
The level must still be `ULevelStreamingAlwaysLoaded`, belong to the selected
map, and have a matching serialized world object name. Similarly named copies,
gameplay levels, collision volumes, and dynamic levels do not qualify.

## Immutable source directories

- Base: `.local/replay-transcripts/map-Jam-13.06`
- Overlay: `.local/replay-transcripts/map-Jam-static-art-overlay-v1`

The overlay metadata has an `overlay_of` receipt for the exact base `map.json`,
geometry bytes and included-level inventory. Base geometry SHA-256 is
`c9e2f0ab6fc6fd83123ddc98e17970027f0732ab49ccf6c2d11a74981a902ed8`;
overlay geometry SHA-256 is
`e1bf58c04e1a171cbac3f9b247854ee4dcdac46a98a0e206d7dc16bcc7b61114`.

For integration, import `verified_overlay_metadata(base_dir, overlay_dir)`
from `scripts/audit-map-art-overlay.py`. It returns `(base_meta, overlay_meta)`
only after verifying the parent receipts, identical map path, mapping hash and
installed `.utoc` inventory, disjoint level inventories, exact serialized level
classification evidence, source-package membership, and identical minimap
coordinates and image bytes. Keep source IDs local to each geometry layer.
Exporters refuse to overwrite existing map artifacts.

Load the overlay as a separate BVH after verification. For each camera-to-body
segment, test both BVHs and choose the closest intersection to the segment
start. Preserve the base bundle hash and record the overlay metadata,
geometry and BVH hashes separately. The overlay does not change `geometry_complete`
or `asset_build_verified_against_replay` to true.

## Verification

```powershell
.venv-replay/Scripts/python.exe scripts/test-map-art-overlay.py
.venv-replay/Scripts/python.exe scripts/audit-map-art-overlay.py `
  --base .local/replay-transcripts/map-Jam-13.06 `
  --overlay .local/replay-transcripts/map-Jam-static-art-overlay-v1 `
  --bvh-out .local/replay-transcripts/asset-research/map-Jam-static-art-bvh-proof-v1 `
  --out .local/replay-transcripts/asset-research/map-Jam-static-art-overlay-audit-v2.json
node scripts/check-map-art-overlay.cjs `
  .local/replay-transcripts/asset-research/map-Jam-static-art-overlay-audit-v2.json
```

The proof directory above already exists and is immutable; a fresh full export
needs a new directory. The existing report can be checked directly with Node.
Thirteen Python regressions passed. Three short rays through a crate, C-site
pillar and exterior shell wall are clear in the full original base and blocked
by the overlay. Full exported Python and browser BVHs agree for forward,
reverse and composed rays with zero measured hit-coordinate error. Twelve Node
assertions passed against those real exported meshes.

These rays establish missing static geometry, not reachable player viewpoints
or validated gameplay contact times. Twenty-two missing mesh components remain
recorded by the overlay exporter. Per-face culling, shader deformation, detail
settings, masked pixels, runtime barriers/doors, and asset/replay build parity
still require separate evidence. None is certified by this overlay.
