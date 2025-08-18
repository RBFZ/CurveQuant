# Graph Analyzer

A small local web tool to digitize slow-onset curve graphs (similar to WebPlotDigitizer) with these features:
- Load an image of your plotted curves.
- Calibrate axes by placing x1/x2 (horizontal) and y1/y2 (vertical) points with snapping rules.
- Zoom/pan the image while keeping overlays aligned.
- Add draggable vertical probes at arbitrary X (or type an exact X).
- Automatic detection of curve intersections with a probe (pixel sampling).
- Manual picking mode (lock X and click up/down to select Y for a specific curve label).
- Label curves (e.g., 5,10,20) and generate a table of sampled values.
- Export sampled data to CSV.

This project is a local Vite + React + TypeScript app using Konva for overlay rendering.

Prerequisites
- Node.js (LTS recommended, v16+)
- npm (comes with Node.js)

Install and run (VS Code)
1. Open the project folder in VS Code.
2. Open an integrated terminal (Terminal → New Terminal).
3. Install dependencies:
   npm install
4. Start the dev server:
   npm run dev
5. Open the app in your browser at:
   http://localhost:5173/

(Alternatively you can run `start http://localhost:5173` from a Windows command prompt to open the URL.)

Usage
1. Load an image
   - Click "Choose File" and select a graph image (PNG/JPG/etc).
2. Calibrate axes
   - Click "Place x1" then click on a known x-axis point (e.g., at leftmost 0).
   - Click "Place x2 (snap horiz)" then click roughly on a second known x-axis point to the right; x2 will snap horizontally to x1's row.
   - Click "Place y1" then click a known y-axis point (e.g., bottom 0).
   - Click "Place y2 (snap vert)" then click a second y-axis point; y2 will snap vertically to y1's column.
   - Enter the numeric values for x1/x2 and y1/y2 (e.g., x1=0, x2=30, y1=0, y2=50). This builds the pixel↔data transform.
3. Labels
   - Edit the "Labels" box with comma-separated numeric labels in ascending order (top → bottom: least → greatest). Example: `5,10,20`.
4. Add probes
   - Click "Add probe (center)" to create a probe at the calibrated center X, or type an X value in the input and press Enter to place a probe at that time.
   - Drag the vertical probe left/right to adjust; the app will re-run detection after dragging.
5. Automatic detection
   - Use "Detect All" to automatically sample y-values for each probe. Detection scans a small horizontal band around the probe, computes a brightness profile, finds edges, and maps them to data y-values.
   - Tune Detection: use the "Sensitivity" slider and "Band px" to help the detector find the curves more or less aggressively.
6. Manual picking (for overlapping early times)
   - Enable "Manual mode (lock X and pick Y)".
   - Select the active probe and the active label (which curve you are intending to pick).
   - Click on the curve (moving only vertically) to set the y-value for that probe/label.
   - Manual values override auto-detected ones.
7. Table preview & Export
   - The right panel shows a table of Time (s) vs label columns (labels sorted ascending).
   - Click "Export CSV" to download `graph-data.csv` with the sampled values.

Tips and notes
- Zoom: use the mouse wheel over the canvas. Pan: drag the stage.
- The calibration assumes linear, orthogonal axes (no perspective or skew).
- If curves are drawn in strong colored strokes (red/green/orange), detection will still work but you can improve results by reducing "Band px" and adjusting sensitivity.
- If detection fails for some probes, use manual mode to set the points.
- Session persistence (save/load) is not implemented yet — consider copying the CSV for record-keeping.
- For more robust or noisy images, we can add an optional opencv.js-based detector in a future iteration.

Development notes
- Source: `src/App.tsx`, `src/utils.ts`, `src/styles.css`
- Build for production:
  npm run build
  npm run preview

License
- MIT (You may modify as needed)

If you want additional features (e.g., save/load sessions, color-based curve separation, improved edge detection with OpenCV), tell me which to prioritize and I will add them next.
