# Apple design refinement

Applied the installed `apple-design` skill to the existing frontend on 10 October 2026.

- Platform system fonts replace the remote font request. Heading tracking and leading are tighter; body copy has comfortable leading, and numeric data keeps tabular figures.
- Cards use consistent radii, quieter borders and subtle surface depth. Section titles rely on weight rather than uppercase text and accent rules. Existing rank and outcome colors remain useful data cues.
- A sticky translucent navigation bar keeps destinations available during scrolling. Mobile destinations scroll horizontally, and selection stays visible after navigation or resizing. Route changes bring the destination into view without a sliding page transition.
- Buttons respond on press. Search focus has a visible halo. Pro-player and act pickers use heavier translucent materials with readable foreground text.
- Roster disclosure uses an analytic critically damped spring, retaining its current position and velocity when reversed. Opacity, translation and the chevron animate; input remains available throughout. Closed/closing rosters are inert and hidden from assistive technology.
- Card pagination updates content immediately and cancels the previous fade. Removing its delayed content swap prevents older clicks from replacing a newer selection.
- Reduced motion settles disclosures immediately, suppresses decorative movement and keeps static loading feedback. Reduced transparency uses opaque chrome; increased contrast strengthens surfaces, navigation and relevant labels.

Validation: 28 Node tests pass, including disclosure settling, reversal/reopening, preference changes during motion and delayed background frames. All 42 demo/worst-case result-page checks fit 320/1180/2560px viewports, with the selected navigation destination visible. The actual search screen was checked at desktop and mobile widths; keyboard roster toggling and the pro-player picker's Escape behavior were checked in the browser. No console warnings or errors appeared during the result-page checks. Accessibility media preferences have CSS implementations and reduced-motion logic tests; OS preference changes were not simulated in the browser.

Screenshots and responsive measurements are in `artifacts/apple-design/`. The local fixture server remains available at `http://127.0.0.1:8767/stress-test`. The UI changes require no new dependency or build step.
