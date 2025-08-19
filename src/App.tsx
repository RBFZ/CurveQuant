import React, { useRef, useState, useEffect } from "react";
import { Stage, Layer, Image as KImage, Line, Circle, Text, Rect } from "react-konva";
import useImage from "use-image";
import { saveAs } from "file-saver";
import { pixelToData, dataToPixel, exportCSV } from "./utils";

type Point = { x: number; y: number };
type CalPoint = {
  pixel: Point | null;
  value: number | null;
};

type Probe = {
  id: string;
  xData: number; // in data coordinates (time/sec)
  pixelX: number; // px on image (keeps synced)
  automaticY: number[] | null; // array of y-values for each curve (filled by detection)
  manual: { label: string; yData: number }[]; // manual overrides
  // per-probe detection overrides (optional)
  sensitivity?: number | null;
  bandPx?: number | null;
};

function uid(prefix = "") {
  return prefix + Math.random().toString(36).slice(2, 9);
}

export default function App() {
  // Image loading & replay
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [img] = useImage(imageSrc || "");
  const imgRef = useRef<HTMLImageElement | null>(null);
  const imageObjectURLRef = useRef<string | null>(null);

  // Konva stage refs and transforms
  const stageRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const [stageSize, setStageSize] = useState({ width: 1000, height: 600 });
  const [scale, setScale] = useState(1);
  const [stagePos, setStagePos] = useState({ x: 0, y: 0 });

  // Calibration points (x1,x2) horizontal; (y1,y2) vertical with snapping rules
  const [x1, setX1] = useState<CalPoint>({ pixel: null, value: 0 });
  const [x2, setX2] = useState<CalPoint>({ pixel: null, value: 30 });
  const [y1, setY1] = useState<CalPoint>({ pixel: null, value: 0 });
  const [y2, setY2] = useState<CalPoint>({ pixel: null, value: 50 });

  // Probes and curve labels
  const [probes, setProbes] = useState<Probe[]>([]);
  const [labels, setLabels] = useState<string[]>(["5", "10", "20"]);
  const [labelsText, setLabelsText] = useState<string>(labels.join(","));

  // derived sorted probes for UI and CSV (lowest time first)
  const sortedProbes = [...probes].sort((a, b) => a.xData - b.xData);

  // Detection settings
  const [sensitivity, setSensitivity] = useState(0.6); // 0..1
  const [bandPx, setBandPx] = useState(6); // +/- px to search around probe
  const [detectionResults, setDetectionResults] = useState<Record<string, number[]>>({});

  // Generator state for bulk probe creation
  const [genStart, setGenStart] = useState<number>(x1.value ?? 0);
  const [genEnd, setGenEnd] = useState<number>(x2.value ?? 30);
  const [genInterval, setGenInterval] = useState<number>(1);
  const [genAutoDetect, setGenAutoDetect] = useState<boolean>(true);
  // visual-only multiplier for displayed times: 1 or 60
  const [timeMultiplier, setTimeMultiplier] = useState<number>(1);


  // Manual mode
  const [manualMode, setManualMode] = useState(false);
  const [activeProbeId, setActiveProbeId] = useState<string | null>(null);
  const [activeLabel, setActiveLabel] = useState<string | null>(labels[0] || null);
  const [lockImage, setLockImage] = useState(false);

  // selected-probe temporary settings (only band remains; sensitivity is controlled by the top slider + dropdown)
  const [selProbeBand, setSelProbeBand] = useState<number | null>(null);

  // UI state
  const [probesCollapsed, setProbesCollapsed] = useState<boolean>(false);
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try { return localStorage.getItem("theme") === "dark"; } catch { return false; }
  });
  const [sensitivityTarget, setSensitivityTarget] = useState<string>("global"); // "global" or probe.id

  // band target (global or probe) and per-probe editing
  const [bandTarget, setBandTarget] = useState<string>("global"); // "global" or probe.id

  // local slider state to ensure smooth live updates while dragging
  const [sensitivityLocal, setSensitivityLocal] = useState<number>(sensitivity);
  const [bandLocal, setBandLocal] = useState<number>(bandPx);

  // refs for scheduling/deduping detection runs while sliding
  const rafRef = useRef<Record<string, number | null>>({});
  const rightWidthRef = useRef<number>(320);
  const [rightWidth, setRightWidth] = useState<number>(320);
  const resizingRef = useRef<boolean>(false);
  const startXRef = useRef<number | null>(null);
  const startWidthRef = useRef<number | null>(null);

  // Left panel resizing refs/state
  const leftWidthRef = useRef<number>(320);
  const [leftWidth, setLeftWidth] = useState<number>(320);
  const leftResizingRef = useRef<boolean>(false);
  const leftStartXRef = useRef<number | null>(null);
  const leftStartWidthRef = useRef<number | null>(null);

  // mask canvas & highlighter state for freehand selection
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // keep strokes painted directly to the mask canvas so disconnected areas are supported
  const highlightPathsRef = useRef<{ x: number; y: number }[][]>([]);
  const drawingRef = useRef<boolean>(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [highlightEnabled, setHighlightEnabled] = useState<boolean>(false);
  const [highlightSize, setHighlightSize] = useState<number>(10);
  const MIN_VERTICAL_SEPARATION = 3;

  // highlighter mode: "pen" (draw) or "eraser" (remove)
  const [highlightMode, setHighlightMode] = useState<"pen" | "eraser">("pen");

  // probe dot size and whether to show the text label next to the dot
  const [probeDotSize, setProbeDotSize] = useState<number>(8);
  const [showProbeText, setShowProbeText] = useState<boolean>(true);

  // manual-entry textarea state (left panel)
  const [manualTextarea, setManualTextarea] = useState<string>("");

  // mask stats (for visible debug indicator)
  const [maskCount, setMaskCount] = useState<number>(0);

  function updateMaskCount() {
    const c = maskCanvasRef.current;
    if (!c) {
      setMaskCount(0);
      return;
    }
    try {
      const ctx = c.getContext("2d");
      if (!ctx) {
        setMaskCount(0);
        return;
      }
      const w = c.width;
      const h = c.height;
      // count non-transparent pixels but sample every 4th pixel to be faster on large images
      let count = 0;
      const s = 4; // sample stride
      const data = ctx.getImageData(0, 0, w, h).data;
      for (let i = 3; i < data.length; i += 4 * s) {
        if (data[i] > 0) count++;
      }
      setMaskCount(count);
    } catch (err) {
      setMaskCount(0);
    }
  }

  // ensure mask canvas exists and matches image size
  function ensureMaskCanvas() {
    if (!imgRef.current) return;
    let c = maskCanvasRef.current;
    if (!c) {
      c = document.createElement("canvas");
      maskCanvasRef.current = c;
    }
    const w = imgRef.current!.naturalWidth;
    const h = imgRef.current!.naturalHeight;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, c.width, c.height);
      }
      // reset stored strokes (we'll keep mask canvas authoritative)
      highlightPathsRef.current = [];
    }
  }

  function clearHighlight() {
    highlightPathsRef.current = [];
    const c = maskCanvasRef.current;
    if (c) {
      const ctx = c.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, c.width, c.height);
      }
    }
    // force re-draw of Konva layer visually
    try { layerRef.current?.batchDraw(); } catch {}
  }

  // paint a single stroke (array of points) to the mask canvas (white opaque)
  function paintStrokeToMask(stroke: { x: number; y: number }[]) {
    ensureMaskCanvas();
    const c = maskCanvasRef.current;
    if (!c || !stroke.length) return;
    const ctx = c.getContext("2d")!;
    ctx.save();
    // set composite mode for eraser vs pen
    if (highlightMode === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
      ctx.fillStyle = "rgba(0,0,0,1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "rgba(255,230,0,0.45)";
      ctx.fillStyle = "rgba(255,230,0,0.45)";
    }
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(1, highlightSize) * 2;
    ctx.beginPath();
    ctx.moveTo(stroke[0].x, stroke[0].y);
    for (let i = 1; i < stroke.length; i++) {
      ctx.lineTo(stroke[i].x, stroke[i].y);
    }
    ctx.stroke();
    // draw end caps to ensure no gaps
    ctx.beginPath();
    ctx.arc(stroke[0].x, stroke[0].y, Math.max(1, highlightSize), 0, Math.PI * 2);
    ctx.fill();
    const last = stroke[stroke.length - 1];
    ctx.beginPath();
    ctx.arc(last.x, last.y, Math.max(1, highlightSize), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    try { layerRef.current?.batchDraw(); } catch {}
  }

  // pointer handlers for freehand painting (stage coordinates -> image pixel coords)
  function getPointerImagePos(e: any) {
    const stage = stageRef.current;
    if (!stage) return null;
    const pointer = stage.getPointerPosition();
    if (!pointer) return null;
    // convert through transform
    const transform = stage.getAbsoluteTransform().copy().invert();
    const pos = transform.point({ x: pointer.x, y: pointer.y });
    // clamp to image bounds if available
    if (!imgRef.current) return { x: pos.x, y: pos.y };
    return { x: Math.max(0, Math.min(imgRef.current.naturalWidth - 1, pos.x)), y: Math.max(0, Math.min(imgRef.current.naturalHeight - 1, pos.y)) };
  }

  function handlePointerDown(e: any) {
    if (!highlightEnabled) return;
    if (!imgRef.current) return;
    ensureMaskCanvas();
    drawingRef.current = true;
    const pos = getPointerImagePos(e);
    if (!pos) return;
    lastPointRef.current = pos;
    highlightPathsRef.current.push([pos]);
    // paint initial dot immediately
    paintStrokeToMask([pos]);
  }

  function handlePointerMove(e: any) {
    if (!highlightEnabled) return;
    if (!drawingRef.current) return;
    const pos = getPointerImagePos(e);
    if (!pos) return;
    const curStroke = highlightPathsRef.current[highlightPathsRef.current.length - 1];
    if (!curStroke) return;
    curStroke.push(pos);
    // paint incremental segment to mask to avoid heavy re-painting full stroke each move
    paintStrokeToMask(curStroke.slice(Math.max(0, curStroke.length - 8)));
    lastPointRef.current = pos;
  }

  function handlePointerUp(e: any) {
    if (!highlightEnabled) return;
    if (!drawingRef.current) return;
    drawingRef.current = false;
    // paint entire stroke to ensure continuity
    const stroke = highlightPathsRef.current[highlightPathsRef.current.length - 1];
    if (stroke) paintStrokeToMask(stroke);
    lastPointRef.current = null;
  }

  // keep selProbe state synced when user selects a probe
  useEffect(() => {
    if (!activeProbeId) {
      setSelProbeBand(null);
      return;
    }
    const p = probes.find((x) => x.id === activeProbeId);
    setSelProbeBand(p?.bandPx ?? null);
  }, [activeProbeId, probes]);

  // keyboard handler: press Delete (or Backspace) to remove selected probe
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Delete" || e.key === "Backspace") {
        if (activeProbeId) {
          // removeProbe is defined later in the file
          try { (removeProbe as any)(activeProbeId); } catch {}
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeProbeId, probes]);

  // Hidden canvas for pixel sampling
  const hiddenCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    // update stage size to window and reserved left/right panels
    const update = () => {
      const minCenter = 0;
      const totalDividers = 16; // two 8px dividers
      const available = window.innerWidth - leftWidthRef.current - rightWidthRef.current - totalDividers;
      const w = Math.max(minCenter, Math.min(Math.max(0, available), 1400));
      const h = Math.min(window.innerHeight - 120, 900);
      setStageSize({ width: w, height: h > 300 ? h : 600 });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [leftWidth, rightWidth]);

  useEffect(() => {
    // create hidden canvas
    const c = document.createElement("canvas");
    hiddenCanvasRef.current = c;
  }, []);

  useEffect(() => {
    // apply theme class and persist preference
    try {
      if (darkMode) document.documentElement.classList.add("dark");
      else document.documentElement.classList.remove("dark");
      localStorage.setItem("theme", darkMode ? "dark" : "light");
    } catch {}
  }, [darkMode]);

  // Helpers for calibration existence
  const calibrated = () =>
    x1.pixel && x2.pixel && y1.pixel && y2.pixel && x1.value !== null && x2.value !== null && y1.value !== null && y2.value !== null;

  // Load image from file
  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      // revoke previous object URL if present so new images load correctly
      if (imageObjectURLRef.current) {
        try { URL.revokeObjectURL(imageObjectURLRef.current); } catch {}
        imageObjectURLRef.current = null;
      }
    } catch {}
    const url = URL.createObjectURL(f);
    imageObjectURLRef.current = url;
    // clear any cached img ref so the Konva image hook picks up the new object URL
    imgRef.current = null;
    setImageSrc(url);
  }

  // Place calibration points: simple mode - pick which point to set via UI buttons
  const [placing, setPlacing] = useState<"x1" | "x2" | "y1" | "y2" | null>(null);

  function onStageClick(e: any) {
    // if highlighter is active, ignore clicks (we handle drawing via pointer events)
    if (highlightEnabled) return;
    if (!imgRef.current) return;
    const stage = stageRef.current;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    // adjust for stage transform (scale, position)
    const transform = stage.getAbsoluteTransform().copy().invert();
    const pos = transform.point({ x: pointer.x, y: pointer.y });

    const pixel = { x: pos.x, y: pos.y };
    if (placing === "x1") {
      setX1({ pixel, value: x1.value });
      // also set y1 exactly to same pixel as x1 (user requested)
      setY1({ pixel, value: y1.value });
      setPlacing(null);
    } else if (placing === "x2") {
      // x2 must be to the right of x1; snap vertically to same Y as x1.pixel
      if (x1.pixel) {
        const y = x1.pixel.y;
        const px = pixel.x > x1.pixel.x + 1 ? pixel.x : x1.pixel.x + 10;
        setX2({ pixel: { x: px, y }, value: x2.value });
      } else {
        setX2({ pixel, value: x2.value });
      }
      setPlacing(null);
    } else if (placing === "y1") {
      setY1({ pixel, value: y1.value });
      setPlacing(null);
    } else if (placing === "y2") {
      // y2 must snap vertically to y1 (x locked)
      if (y1.pixel) {
        const x = y1.pixel.x;
        const py = pixel.y < y1.pixel.y - 1 ? pixel.y : y1.pixel.y - 10;
        setY2({ pixel: { x, y: py }, value: y2.value });
      } else {
        setY2({ pixel, value: y2.value });
      }
      setPlacing(null);
    } else if (manualMode && activeProbeId && activeLabel) {
      // manual picking: lock x to probe pixel and take y from click
      const probe = probes.find((p) => p.id === activeProbeId);
      if (!probe) return;
      const lockedPixel = { x: probe.pixelX, y: pixel.y };
      const yDataPicked = pixelToData(lockedPixel, { x1: x1.pixel, x2: x2.pixel, y1: y1.pixel, y2: y2.pixel }, { x1: x1.value, x2: x2.value, y1: y1.value, y2: y2.value }).y;
      // set manual override and remove corresponding automatic dot for this label index (so manual hides auto)
      const idx = labels.indexOf(activeLabel as string);
      const updated = probes.map((p) => {
        if (p.id !== activeProbeId) return p;
        const newManual = p.manual.filter((m) => m.label !== activeLabel);
        newManual.push({ label: activeLabel as string, yData: yDataPicked });
        let newAuto = p.automaticY ? p.automaticY.slice() : null;
        if (newAuto && idx >= 0 && idx < newAuto.length) {
          newAuto[idx] = undefined as unknown as number;
        }
        return { ...p, manual: newManual, automaticY: newAuto };
      });
      setProbes(updated);
    }
  }

  // Add a probe by typed x or by clicking the "Add probe" button which will create at center
  function addProbeAtData(xData: number | null) {
    if (!imgRef.current || !calibrated()) {
      alert("Please load image and calibrate axes first.");
      return;
    }
    const stage = stageRef.current;
    const c = hiddenCanvasRef.current!;
    const dims = { width: imgRef.current!.naturalWidth, height: imgRef.current!.naturalHeight };
    // map data x to pixel x
    const px = dataToPixel({ x: xData ?? (x1.value! + (x2.value! - x1.value!) / 2), y: 0 }, { x1: x1.pixel!, x2: x2.pixel!, y1: y1.pixel!, y2: y2.pixel! }, { x1: x1.value!, x2: x2.value!, y1: y1.value!, y2: y2.value! }).x;
    const id = uid("probe_");
    const p: Probe = { id, xData: xData ?? (x1.value! + (x2.value! - x1.value!) / 2), pixelX: px, automaticY: null, manual: [] };
    setProbes((s) => [...s, p]);
    // run detection for the new probe
    setTimeout(() => runDetectionForProbe(p), 50);
  }

  // Run detection for a probe: simple brightness-based detection across a vertical band
  function runDetectionForProbe(probe: Probe) {
    if (!imgRef.current || !calibrated()) return;
    const imgEl = imgRef.current;
    const canvas = hiddenCanvasRef.current!;
    canvas.width = imgEl.naturalWidth;
    canvas.height = imgEl.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
    const px = Math.round(probe.pixelX);
    const w = canvas.width;
    const h = canvas.height;
    // per-probe or global band (px)
    const band = Math.max(0, Math.round(probe.bandPx ?? bandPx));
    // determine vertical sampling range between calibrated y1 and y2
    const startY = Math.max(0, Math.floor(Math.min(y1.pixel!.y, y2.pixel!.y)));
    const endY = Math.min(h - 1, Math.ceil(Math.max(y1.pixel!.y, y2.pixel!.y)));
    const segH = Math.max(0, endY - startY + 1);
    if (segH <= 0) return;
    // sample across horizontal ±band and average to create a vertical brightness profile only within [startY,endY]
    const profile: number[] = new Array(segH).fill(0);
    for (let dy = -band; dy <= band; dy++) {
      const sx = px + dy;
      if (sx < 0 || sx >= w) continue;
      const data = ctx.getImageData(sx, startY, 1, segH).data;
      for (let y = 0; y < segH; y++) {
        const r = data[y * 4], g = data[y * 4 + 1], b = data[y * 4 + 2];
        profile[y] += 0.299 * r + 0.587 * g + 0.114 * b;
      }
    }
    // normalize
    const n = band * 2 + 1;
    for (let y = 0; y < segH; y++) profile[y] /= n;

    // compute derivative and find peaks where brightness changes strongly (edges)
    const diff: number[] = new Array(Math.max(0, profile.length - 1));
    for (let y = 0; y < diff.length; y++) diff[y] = Math.abs(profile[y + 1] - profile[y]);

    // build mask availability map for each row (seg-space 0..segH-1). If highlight disabled, all rows are valid.
    let validRow: boolean[] = new Array(segH).fill(true);
    if (highlightEnabled && maskCanvasRef.current) {
      validRow = new Array(segH).fill(false);
      try {
        const mctx = maskCanvasRef.current.getContext("2d");
        if (mctx) {
          // sample across horizontal band to mark rows that have any alpha > 0
          for (let dx = -band; dx <= band; dx++) {
            const sx = px + dx;
            if (sx < 0 || sx >= w) continue;
            const mdata = mctx.getImageData(sx, startY, 1, segH).data;
            for (let y = 0; y < segH; y++) {
              if (mdata[y * 4 + 3] > 0) validRow[y] = true;
            }
          }
        } else {
          // fallback to all valid if mask ctx missing
          validRow = new Array(segH).fill(true);
        }
      } catch (err) {
        // getImageData may throw if sizes mismatch; fallback to all valid
        validRow = new Array(segH).fill(true);
      }
      // if no rows marked valid, fallback to full region
      if (!validRow.some(Boolean)) validRow = new Array(segH).fill(true);
    }

    // simple peak picking with robust fallback to ensure we return up to labels.length hits
    const maxDiff = diff.length ? Math.max(...diff) : 0;
    // per-probe or global sensitivity
    const localSensitivity = probe.sensitivity ?? sensitivity;
    const threshold = maxDiff * (0.15 + 0.7 * (1 - localSensitivity)); // invert sens to make slider intuitive

    // 1) find local maxima above threshold (respect mask when enabled)
    const peaks: number[] = [];
    for (let y = 1; y < diff.length - 1; y++) {
      if (diff[y] > diff[y - 1] && diff[y] > diff[y + 1] && diff[y] >= threshold) {
        if (validRow[y]) peaks.push(y);
      }
    }

    // 2) if not enough, include other local maxima regardless of threshold (respect mask)
    if (peaks.length < labels.length) {
      for (let y = 1; y < diff.length - 1; y++) {
        if (diff[y] > diff[y - 1] && diff[y] > diff[y + 1]) {
          if (validRow[y] && !peaks.includes(y)) peaks.push(y);
        }
      }
    }

    // 3) if still not enough, add strongest diff entries (respect mask)
    if (peaks.length < labels.length) {
      const idxs = diff.map((v, i) => i).sort((a, b) => diff[b] - diff[a]);
      for (const idx of idxs) {
        if (peaks.length >= labels.length) break;
        if (idx <= 0 || idx >= diff.length - 1) continue;
        if (!validRow[idx]) continue;
        if (peaks.some((p) => Math.abs(p - idx) <= 2)) continue;
        peaks.push(idx);
      }
    }

    // refine peaks: choose center of stroke by scanning around peak for min brightness (dark stroke)
    const candidates: number[] = peaks.map((py) => {
      let best = py;
      const r = 6;
      let minB = Infinity;
      for (let yy = Math.max(0, py - r); yy <= Math.min(profile.length - 1, py + r); yy++) {
        if (profile[yy] < minB) {
          minB = profile[yy];
          best = yy;
        }
      }
      return best;
    });

    // if still not enough candidates and highlight is on, try adding any valid rows sorted by diff strength
    if (candidates.length < labels.length) {
      const extra = diff
        .map((v, i) => ({ i, v }))
        .filter((it) => it.i > 0 && it.i < diff.length - 1 && validRow[it.i] && !candidates.includes(it.i))
        .sort((a, b) => b.v - a.v)
        .map((it) => it.i);
      for (const idx of extra) {
        if (candidates.length >= labels.length) break;
        candidates.push(idx);
      }
    }

    // Now we have candidate indices (in seg-space). Enforce minimum vertical separation and ensure exactly labels.length picks.
    const MIN_SEP = MIN_VERTICAL_SEPARATION;

    // helper: try to pick N indices from candidates while enforcing MIN_SEP
    function pickWithSeparation(cands: number[], N: number, validRowArr: boolean[]) {
      // prefer stronger diffs: sort candidates by diff desc, keep unique
      const uniq = Array.from(new Set(cands));
      const byStrength = uniq.sort((a, b) => (diff[b] || 0) - (diff[a] || 0));
      const selected: number[] = [];
      for (const c of byStrength) {
        // must be valid row
        if (!validRowArr[c]) continue;
        // ensure separation from already selected
        if (selected.some((s) => Math.abs(s - c) < MIN_SEP)) continue;
        selected.push(c);
        if (selected.length >= N) break;
      }
      // if not enough, try to greedily fill by scanning seg from top to bottom picking nearest valid rows not too close
      if (selected.length < N) {
        for (let i = 0; i < segH && selected.length < N; i++) {
          const candidate = i;
          if (!validRowArr[candidate]) continue;
          if (selected.some((s) => Math.abs(s - candidate) < MIN_SEP)) continue;
          selected.push(candidate);
        }
      }
      // if still short, relax separation slightly by allowing equal to MIN_SEP-1 (very rare) — or finally fall back to evenly spaced positions across full seg
      if (selected.length < N) {
        // evenly spaced targets across segH
        const targets: number[] = [];
        for (let k = 0; k < N; k++) {
          targets.push(Math.round(((k + 0.5) * segH) / N));
        }
        for (const t of targets) {
          // find nearest valid row to t
          let best = -1;
          let bestDist = Infinity;
          for (let y = 0; y < segH; y++) {
            if (!validRowArr[y]) continue;
            const d = Math.abs(y - t);
            if (d < bestDist && !selected.some((s) => Math.abs(s - y) < MIN_SEP)) {
              best = y;
              bestDist = d;
            }
          }
          if (best >= 0) selected.push(best);
          if (selected.length >= N) break;
        }
      }
      // final pad/truncate
      const final = Array.from(new Set(selected)).slice(0, N).sort((a, b) => a - b);
      // if still fewer (shouldn't), fill with nearest valid rows ignoring separation
      if (final.length < N) {
        for (let y = 0; y < segH && final.length < N; y++) {
          if (!validRowArr[y]) continue;
          if (!final.includes(y)) final.push(y);
        }
        final.sort((a, b) => a - b);
      }
      return final.slice(0, N);
    }

    const finalSegIndices = pickWithSeparation(candidates, labels.length, validRow);

    // if highlight was enabled and we couldn't pick enough within mask (edge case), relax to full region
    if (highlightEnabled && finalSegIndices.length < labels.length) {
      const allRows = new Array(segH).fill(true);
      const fallbackSeg = pickWithSeparation(Array.from(Array(segH).keys()), labels.length, allRows);
      // use fallback if it provides N entries
      if (fallbackSeg.length === labels.length) {
        finalSegIndices.splice(0, finalSegIndices.length, ...fallbackSeg);
      }
    }

    // map to pixel coordinates within original image, then to data coordinates
    const ysData = finalSegIndices.map((segY) => {
      const py = startY + segY;
      return pixelToData({ x: px, y: py }, { x1: x1.pixel!, x2: x2.pixel!, y1: y1.pixel!, y2: y2.pixel! }, { x1: x1.value!, x2: x2.value!, y1: y1.value!, y2: y2.value! }).y;
    });

    // store
    setDetectionResults((s) => ({ ...s, [probe.id]: ysData }));
    // update probe automaticY
    setProbes((ps) => ps.map((p) => (p.id === probe.id ? { ...p, automaticY: ysData } : p)));
  }

  // schedule detection for a probe with RAF debouncing (cancels prior scheduled run)
  // accepts optional probeObj to avoid stale-closure lookups when called immediately after state updates
  function scheduleRunDetectionForProbe(probeId: string, probeObj?: Probe) {
    if (rafRef.current[probeId]) {
      cancelAnimationFrame(rafRef.current[probeId] as number);
      rafRef.current[probeId] = null;
    }
    rafRef.current[probeId] = requestAnimationFrame(() => {
      try {
        if (probeObj) {
          // prefer supplied probe object (avoid stale closure issues)
          runDetectionForProbe(probeObj);
        } else {
          const p = probes.find((pp) => pp.id === probeId);
          if (p) runDetectionForProbe(p);
        }
      } finally {
        rafRef.current[probeId] = null;
      }
    });
  }

  // clear everything (full reset)
  function clearAll() {
    // revoke any created object URL so subsequent loads render correctly
    try {
      if (imageObjectURLRef.current) {
        try { URL.revokeObjectURL(imageObjectURLRef.current); } catch {}
        imageObjectURLRef.current = null;
      }
    } catch {}
    imgRef.current = null;
    setImageSrc(null);
    setProbes([]);
    setDetectionResults({});
    setX1({ pixel: null, value: 0 });
    setX2({ pixel: null, value: 30 });
    setY1({ pixel: null, value: 0 });
    setY2({ pixel: null, value: 50 });
    setLabels(["5", "10", "20"]);
    setLabelsText("5,10,20");
    setActiveProbeId(null);
    setManualMode(false);
    setLockImage(false);
  }

  // remove all probes (keeps other state)
  function clearProbes() {
    setProbes([]);
    setDetectionResults({});
    setActiveProbeId(null);
  }

  // remove a single probe by id
  function removeProbe(id: string) {
    setProbes((ps) => ps.filter((p) => p.id !== id));
    setDetectionResults((s) => {
      const copy = { ...s };
      delete copy[id];
      return copy;
    });
    if (activeProbeId === id) setActiveProbeId(null);
  }

  // run detection for all probes
  function runAllDetections() {
    // clear manual overrides so Detect All fully replaces points (per your request)
    setProbes((ps) => {
      const cleared = ps.map((p) => ({ ...p, manual: [] }));
      cleared.forEach((p) => runDetectionForProbe(p));
      return cleared;
    });
  }

  // when calibration or image changes, re-run detection
  useEffect(() => {
    if (calibrated() && probes.length > 0) runAllDetections();
  }, [x1, x2, y1, y2, sensitivity, bandPx, imageSrc]);

  // Dragging probes horizontally
  function onDragProbe(e: any, id: string) {
    const node = e.target;
    const px = node.x();
    setProbes((ps) => ps.map((p) => (p.id === id ? { ...p, pixelX: px } : p)));
  }
  function onDragEndProbe(id: string) {
    const p = probes.find((x) => x.id === id);
    if (p) runDetectionForProbe(p);
  }

  // Export CSV
  function downloadCSV() {
    const rows: (string | number)[][] = [];
    const header = ["Time/sec (X)", ...labels.map(String)];
    rows.push(header);
    // each probe is a row
    for (const p of sortedProbes) {
      const row: (string | number)[] = [];
      row.push(p.xData);
      for (const label of header.slice(1)) {
        // check manual override
        const m = p.manual.find((mm) => mm.label === label);
        if (m) {
          row.push(m.yData);
        } else if (p.automaticY) {
          // match by index: labels list is typed-order; detection results are top->bottom
          const idx = labels.indexOf(label);
          if (idx >= 0 && idx < p.automaticY.length && p.automaticY[idx] !== undefined) row.push(Number(p.automaticY[idx].toFixed(3)));
          else row.push("");
        } else row.push("");
      }
      rows.push(row);
    }
    const csv = exportCSV(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    saveAs(blob, "graph-data.csv");
  }

  // Insert manual data lines from left textarea into probes state
  function applyManualTextarea() {
    if (!calibrated()) {
      alert("Please calibrate axes first.");
      return;
    }
    const lines = manualTextarea.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    setProbes((ps) => {
      const updated = [...ps];
      const sortedLabels = labels.slice();
      for (const line of lines) {
        const parts = line.split(",").map(s => s.trim());
        if (parts.length === 0) continue;
        const t = Number(parts[0]);
        if (isNaN(t)) continue;
        // find existing probe at same time (within epsilon)
        const EXIST_EPS = 1e-6;
        let existing = updated.find(p => Math.abs(p.xData - t) < EXIST_EPS);
        const px = dataToPixel({ x: t, y: 0 }, { x1: x1.pixel!, x2: x2.pixel!, y1: y1.pixel!, y2: y2.pixel! }, { x1: x1.value!, x2: x2.value!, y1: y1.value!, y2: y2.value! }).x;
        if (existing) {
          // update existing manual entries
          for (let i = 1; i < parts.length; i++) {
            const vstr = parts[i];
            if (vstr === "" || vstr === "-" || vstr === "—") continue;
            const val = Number(vstr);
            if (isNaN(val)) continue;
            const lab = sortedLabels[i-1];
            existing.manual = existing.manual.filter(m => m.label !== lab);
            existing.manual.push({ label: lab, yData: val });
            if (existing.automaticY && (i-1) >= 0 && (i-1) < existing.automaticY.length) existing.automaticY[i-1] = undefined as unknown as number;
          }
          existing.pixelX = px;
        } else {
          const manualArr: { label: string; yData: number }[] = [];
          for (let i = 1; i < parts.length; i++) {
            const vstr = parts[i];
            if (vstr === "" || vstr === "-" || vstr === "—") continue;
            const val = Number(vstr);
            if (isNaN(val)) continue;
            const lab = sortedLabels[i-1];
            manualArr.push({ label: lab, yData: val });
          }
          const newProbe: Probe = { id: uid("probe_"), xData: t, pixelX: px, automaticY: null, manual: manualArr, sensitivity: null, bandPx: null };
          updated.push(newProbe);
        }
      }
      return updated;
    });
    setManualTextarea("");
  }

  // convert minutes to seconds (visual-only toggle: multiplies displayed times in tables)
  function convertMinutesToSeconds() {
    // toggle visual multiplier between 1x and 60x
    setTimeMultiplier((t) => (t === 1 ? 60 : 1));
  }

  // convert minutes to seconds (multiplies times by 60, keeps pixelX)
  // function convertMinutesToSeconds() {
  //   setX1((s) => ({ ...s, value: s.value !== null && s.value !== undefined ? s.value * 60 : s.value }));
  //   setX2((s) => ({ ...s, value: s.value !== null && s.value !== undefined ? s.value * 60 : s.value }));
  //   setGenStart((g) => g * 60);
  //   setGenEnd((g) => g * 60);
  //   setProbes((ps) => ps.map((p) => ({ ...p, xData: p.xData * 60 })));
  // }

  // Render helpers
  function renderCalibrationMarkers() {
    const items: any[] = [];
    const c = [x1, x2, y1, y2];
    const keys = ["x1", "x2", "y1", "y2"];
    c.forEach((pt, i) => {
      if (!pt.pixel) return;
      items.push(
        <Circle key={keys[i]} x={pt.pixel.x} y={pt.pixel.y} radius={6} fill={i < 2 ? "red" : "blue"} stroke="white" strokeWidth={2} />
      );
    });
    // draw lines between x1-x2 and y1-y2
    if (x1.pixel && x2.pixel) {
      items.push(
        <Line key="xline" points={[x1.pixel.x, x1.pixel.y, x2.pixel.x, x2.pixel.y]} stroke="red" dash={[6, 6]} strokeWidth={2} />
      );
    }
    if (y1.pixel && y2.pixel) {
      items.push(
        <Line key="yline" points={[y1.pixel.x, y1.pixel.y, y2.pixel.x, y2.pixel.y]} stroke="blue" dash={[6, 6]} strokeWidth={2} />
      );
    }
    return items;
  }

  // Convert pixel x back to data x for showing probe x
  function pixelXToData(px: number) {
    const p = pixelToData({ x: px, y: 0 }, { x1: x1.pixel!, x2: x2.pixel!, y1: y1.pixel!, y2: y2.pixel! }, { x1: x1.value!, x2: x2.value!, y1: y1.value!, y2: y2.value! });
    return p.x;
  }

  return (
    <div className="app" style={{ display: "flex" }}>
      {/* LEFT: Data table + manual-entry textarea */}
      <div className="left-data" style={{ width: leftWidth, minWidth: 220, maxWidth: 700, overflow: "auto" }}>
        <div className="panel" style={{ padding: 8 }}>
          <h3>Data Table</h3>
          <div className="table-preview">
            <table style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Time (s)</th>
                  {labels.map((l) => <th key={l}>{l}</th>)}
                </tr>
              </thead>
              <tbody>
                {sortedProbes.map((p) => (
                  <tr key={p.id}>
                    <td>{(p.xData * timeMultiplier).toFixed(3)}</td>
                    {labels.map((lab, idx) => {
                      const m = p.manual.find((mm) => mm.label === lab);
                      if (m) return <td key={lab}>{m.yData.toFixed(3)}</td>;
                      if (p.automaticY && idx < p.automaticY.length && p.automaticY[idx] !== undefined) return <td key={lab}>{p.automaticY[idx].toFixed(3)}</td>;
                      return <td key={lab}> </td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 8 }}>
            <label>Insert manual data (one line per probe):</label>
            <div style={{ marginTop: 6 }}>
              <button onClick={() => convertMinutesToSeconds()}>Convert minutes → seconds</button>
            </div>
            <textarea
              value={manualTextarea}
              onChange={(e) => setManualTextarea(e.target.value)}
              placeholder={`one line per probe, format: time,val1,val2,...\nExample: 0,0,0,0`}
              rows={5}
              style={{ width: "100%", boxSizing: "border-box", marginTop: 8 }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  applyManualTextarea();
                }
              }}
            />
            <div style={{ marginTop: 6 }}>
              <button onClick={() => applyManualTextarea()}>Add</button>
            </div>
            <small>Values correspond to labels shown above (top → bottom).</small>
          </div>
        </div>
      </div>

      {/* divider between left-data and main content */}
      <div
        className="divider left-divider"
        onMouseDown={(e) => {
          // start resizing left panel
          leftResizingRef.current = true;
          leftStartXRef.current = e.clientX;
          leftStartWidthRef.current = leftWidthRef.current;
            const onMove = (ev: MouseEvent) => {
            if (!leftResizingRef.current) return;
            const dx = (leftStartXRef.current === null ? 0 : ev.clientX - leftStartXRef.current);
            const minCenter = 0;
            const totalDividers = 16;
            const maxLeft = Math.max(0, window.innerWidth - minCenter - rightWidthRef.current - totalDividers);
            const newW = Math.max(0, Math.min(maxLeft, (leftStartWidthRef.current || 320) + dx));
            leftWidthRef.current = newW;
            setLeftWidth(newW);
            // update stage size proactively
            const available = window.innerWidth - leftWidthRef.current - rightWidthRef.current - totalDividers;
            setStageSize((s) => ({ ...s, width: Math.max(minCenter, Math.min(Math.max(0, available), 1400)) }));
          };
          const onUp = () => {
            leftResizingRef.current = false;
            leftStartXRef.current = null;
            leftStartWidthRef.current = null;
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        }}
        style={{ width: 8, cursor: "col-resize", background: "transparent" }}
      />

      {/* CENTER: toolbar + stage (previously 'left') */}
      <div className="left" style={{ flex: 1 }}>
        <div className="toolbar">
          <div>
            <label>Load Image:</label>
            <input type="file" accept="image/*" onChange={onFile} />
            <label style={{ marginLeft: 8 }}>
              <input type="checkbox" checked={lockImage} onChange={(e) => setLockImage(e.target.checked)} /> Lock image
            </label>
            <button onClick={() => clearAll()} style={{ marginLeft: 8 }}>
              Clear
            </button>
            <button onClick={() => clearProbes()} style={{ marginLeft: 8 }}>
              Remove all probes
            </button>
            <button onClick={() => setDarkMode((d) => !d)} style={{ marginLeft: 8 }}>
              {darkMode ? "Light" : "Dark"}
            </button>

            {/* Highlighter controls (prominent block) */}
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, marginLeft: 12, padding: "6px 8px", borderRadius: 6, border: "1px solid #e6eef8", background: "#f8fbff" }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
                <input
                  type="checkbox"
                  checked={highlightEnabled}
                  onChange={(e) => {
                    const v = e.target.checked;
                    setHighlightEnabled(v);
                    if (v) {
                      ensureMaskCanvas();
                      setTimeout(() => updateMaskCount(), 50);
                    }
                  }}
                />
                Highlighter
              </label>

              <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                Pen:
                <input
                  type="range"
                  min={1}
                  max={50}
                  value={highlightSize}
                  onChange={(e) => setHighlightSize(Number(e.target.value))}
                  style={{ verticalAlign: "middle" }}
                />
              </label>

              <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                Mode:
                <select value={highlightMode} onChange={(e) => setHighlightMode(e.target.value as "pen"|"eraser")}>
                  <option value="pen">Pen</option>
                  <option value="eraser">Eraser</option>
                </select>
              </label>

              <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                Probe dot:
                <input
                  type="range"
                  min={2}
                  max={24}
                  value={probeDotSize}
                  onChange={(e) => setProbeDotSize(Number(e.target.value))}
                  style={{ verticalAlign: "middle", width: 120 }}
                />
              </label>

              <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <input type="checkbox" checked={showProbeText} onChange={(e) => setShowProbeText(e.target.checked)} />
                Show labels
              </label>

              <button onClick={() => { clearHighlight(); updateMaskCount(); }} style={{ padding: "6px 8px", background: "#ff6b6b" }}>
                Clear Highlight
              </button>

              <div style={{ fontSize: 12, color: "#333", marginLeft: 6 }}>
                Mask (sampled): {maskCount}
              </div>
            </div>
          </div>
          <div className="cal-buttons">
            <div>
              <button onClick={() => setPlacing("x1")}>Place x1</button>
              <button onClick={() => setPlacing("x2")}>Place x2 (snap horiz)</button>
            </div>
            <div>
              <button onClick={() => setPlacing("y1")}>Place y1</button>
              <button onClick={() => setPlacing("y2")}>Place y2 (snap vert)</button>
            </div>
            <div>
              <button onClick={() => setPlacing(null)}>Stop placing</button>
            </div>
          </div>
          <div className="cal-inputs">
            <div>
              <label>x1 val:</label>
              <input type="number" value={x1.value ?? 0} onChange={(e) => setX1({ ...x1, value: Number(e.target.value) })} />
              <label>x2 val:</label>
              <input type="number" value={x2.value ?? 0} onChange={(e) => setX2({ ...x2, value: Number(e.target.value) })} />
            </div>
            <div>
              <label>y1 val:</label>
              <input type="number" value={y1.value ?? 0} onChange={(e) => setY1({ ...y1, value: Number(e.target.value) })} />
              <label>y2 val:</label>
              <input type="number" value={y2.value ?? 0} onChange={(e) => setY2({ ...y2, value: Number(e.target.value) })} />
            </div>
          </div>
          <div className="detection-controls">
            <label>Sensitivity</label>
            <select value={sensitivityTarget} onChange={(e) => {
              const t = e.target.value;
              setSensitivityTarget(t);
              // sync local value to the new target immediately
              if (t === "global") setSensitivityLocal(sensitivity);
              else {
                const p = probes.find(pp => pp.id === t);
                setSensitivityLocal(p?.sensitivity ?? sensitivity);
              }
            }}>
              <option value="global">Global</option>
              {probes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} ({(p.xData * timeMultiplier).toFixed(3)}s)
                </option>
              ))}
            </select>

            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={sensitivityLocal}
              onChange={(e) => {
                const v = Number(e.target.value);
                setSensitivityLocal(v);
                if (sensitivityTarget === "global") {
                  setSensitivity(v);
                  // re-run all detections but debounce slightly
                  if (rafRef.current["global"]) cancelAnimationFrame(rafRef.current["global"] as number);
                  rafRef.current["global"] = requestAnimationFrame(() => {
                    runAllDetections();
                    rafRef.current["global"] = null;
                  });
                } else {
                  // update probe sensitivity and schedule its detection via RAF (smooth while sliding)
                  const id = sensitivityTarget;
                  setProbes((ps) => {
                    const updated = ps.map((p) => (p.id === id ? { ...p, sensitivity: v } : p));
                    const probeObj = updated.find((pp) => pp.id === id) || undefined;
                    if (probeObj) scheduleRunDetectionForProbe(id, probeObj);
                    return updated;
                  });
                }
              }}
            />

            <label style={{ marginLeft: 8 }}>Band px</label>
            <select value={bandTarget} onChange={(e) => {
              const t = e.target.value;
              setBandTarget(t);
              if (t === "global") setBandLocal(bandPx);
              else {
                const p = probes.find(pp => pp.id === t);
                setBandLocal(p?.bandPx ?? bandPx);
              }
            }}>
              <option value="global">Global</option>
              {probes.map((p) => (
                <option key={p.id} value={p.id}>{p.id} ({(p.xData * timeMultiplier).toFixed(3)}s)</option>
              ))}
            </select>
            <input
              type="number"
              min={0}
              max={200}
              value={bandLocal}
              onChange={(e) => {
                const v = Number(e.target.value);
                setBandLocal(v);
                if (bandTarget === "global") {
                  setBandPx(v);
                  // also propagate to all existing probes immediately
                  setProbes((ps) => {
                    const updated = ps.map((p) => ({ ...p, bandPx: v }));
                    // schedule detection for all updated probes (debounced per-probe)
                    updated.forEach((p) => scheduleRunDetectionForProbe(p.id, p));
                    return updated;
                  });
                } else {
                  const id = bandTarget;
                  setProbes(ps => {
                    const updated = ps.map(p => p.id === id ? { ...p, bandPx: v } : p);
                    const probeObj = updated.find(pp => pp.id === id) || undefined;
                    if (probeObj) scheduleRunDetectionForProbe(id, probeObj);
                    return updated;
                  });
                }
              }}
              style={{ width: 70 }}
            />

            <button onClick={() => runAllDetections()}>Detect All</button>
          </div>
        </div>

        <div
          className="stage-wrap"
          onWheel={(e) => {
            e.preventDefault();
            // If a probe is selected, use wheel to cycle the activeLabel instead of zooming.
            if (activeProbeId) {
              if (!labels || labels.length === 0) return;
              const dir = e.deltaY > 0 ? 1 : -1; // down -> next, up -> previous
              const currentIndex = labels.indexOf(activeLabel ?? (labels[0] ?? ""));
              if (currentIndex === -1) {
                setActiveLabel(labels[0]);
              } else {
                let ni = currentIndex + dir;
                if (ni < 0) ni = 0;
                if (ni >= labels.length) ni = labels.length - 1;
                if (ni !== currentIndex) setActiveLabel(labels[ni]);
              }
              return;
            }
            // otherwise perform zoom as before
            const old = scale;
            const dir2 = e.deltaY > 0 ? -1 : 1;
            const factor = 1 + dir2 * 0.08;
            const newScale = Math.max(0.2, Math.min(5, old * factor));
            setScale(newScale);
          }}
        >
            <Stage
            width={stageSize.width}
            height={stageSize.height}
            scaleX={scale}
            scaleY={scale}
            x={stagePos.x}
            y={stagePos.y}
            draggable={!lockImage}
            onDragEnd={(e) => setStagePos({ x: e.target.x(), y: e.target.y() })}
            ref={stageRef}
            onClick={onStageClick}
            onMouseDown={handlePointerDown}
            onMouseMove={handlePointerMove}
            onMouseUp={handlePointerUp}
            onTouchStart={handlePointerDown}
            onTouchMove={handlePointerMove}
            onTouchEnd={handlePointerUp}
          >
            <Layer ref={layerRef}>
              {/* image */}
              {img && (
                <KImage
                  image={img}
                  x={0}
                  y={0}
                  ref={(node: any) => {
                    if (node && node.image()) {
                      imgRef.current = node.image() as HTMLImageElement;
                    }
                  }}
                />
              )}

              {/* visible highlighter overlay (renders the off-screen mask canvas) */}
              {maskCanvasRef.current && highlightEnabled && (
                <KImage
                  image={maskCanvasRef.current}
                  x={0}
                  y={0}
                  listening={false}
                  opacity={0.55}
                />
              )}

              {/* calibration markers */}
              {renderCalibrationMarkers()}

              {/* probes: vertical lines */}
              {probes.map((p, i) => (
                <React.Fragment key={p.id}>
                  {(() => {
                    // compute top and bottom Y where the vertical probe line should stop.
                    // bottom aligns with the x-axis (data y=0); top aligns with y2 (or image top fallback).
                    const yBottom = calibrated()
                      ? dataToPixel(
                          { x: x1.value ?? x2.value ?? 0, y: 0 },
                          { x1: x1.pixel!, x2: x2.pixel!, y1: y1.pixel!, y2: y2.pixel! },
                          { x1: x1.value!, x2: x2.value!, y1: y1.value!, y2: y2.value! }
                        ).y
                      : imgRef.current
                      ? imgRef.current.naturalHeight
                      : stageSize.height;
                    const yTop = calibrated()
                      ? (y2.pixel ? y2.pixel.y : Math.min(y1.pixel!.y, y2.pixel!.y))
                      : 0;
                    return (
                      <>
                        <Line
                          points={[p.pixelX, yTop, p.pixelX, yBottom]}
                          stroke={p.id === activeProbeId ? "green" : "black"}
                          strokeWidth={p.id === activeProbeId ? 3 : 2}
                          dash={[4, 4]}
                          draggable
                          dragBoundFunc={(pos) => ({ x: pos.x, y: yTop })}
                          onDragMove={(e) => onDragProbe(e, p.id)}
                          onDragEnd={() => onDragEndProbe(p.id)}
                        />
                        {/* top (delete) dot - clicking deletes probe */}
                        <Circle
                          x={p.pixelX}
                          y={yTop}
                          radius={probeDotSize}
                          fill="#222"
                          onClick={(e: any) => {
                            e.cancelBubble = true;
                            removeProbe(p.id);
                          }}
                        />
                        {/* bottom selection dot on x-axis - toggles active probe (select/deselect) */}
                        <Circle
                          x={p.pixelX}
                          y={yBottom}
                          radius={probeDotSize}
                          fill={p.id === activeProbeId ? "green" : "purple"}
                          onClick={(e: any) => {
                            e.cancelBubble = true;
                            setActiveProbeId(p.id === activeProbeId ? null : p.id);
                          }}
                        />
                        {showProbeText && (
                          <Text
                            x={p.pixelX + probeDotSize + 4}
                            y={Math.max(4, yTop - Math.max(8, Math.round(probeDotSize * 0.6)) - 4)}
                            text={`${(p.xData * timeMultiplier).toFixed(2)} s`}
                            fontSize={Math.max(10, Math.round(probeDotSize * 0.9))}
                            fill="black"
                          />
                        )}
                      </>
                    );
                  })()}
                  {/* automatic points */}
                  {p.automaticY &&
                    p.automaticY.map((yval, idx) => {
                      if (yval === undefined || yval === null) return null;
                      const label = labels[idx];
                      const hasManual = Boolean(p.manual.find((m) => m.label === label));
                      // skip automatic if replaced by manual
                      if (hasManual) return null;
                      const px = p.pixelX;
                      const py = dataToPixel({ x: p.xData, y: yval }, { x1: x1.pixel!, x2: x2.pixel!, y1: y1.pixel!, y2: y2.pixel! }, { x1: x1.value!, x2: x2.value!, y1: y1.value!, y2: y2.value! }).y;
                      const isActiveLabel = p.id === activeProbeId && idx === labels.indexOf(activeLabel ?? "");
                      const color = isActiveLabel ? "red" : "orange";
                      return (
                        <React.Fragment key={p.id + "_auto_" + idx}>
                          <Circle x={px} y={py} radius={probeDotSize} fill={color} />
                          {showProbeText && (
                            <Text
                              x={px + probeDotSize + 4}
                              y={py - Math.max(8, Math.round(probeDotSize * 0.6))}
                              text={`${label}: ${yval.toFixed(2)}`}
                              fontSize={Math.max(10, Math.round(probeDotSize * 0.9))}
                              fill="black"
                            />
                          )}
                        </React.Fragment>
                      );
                    })}

                  {/* manual points */}
                  {p.manual.map((m) => {
                    const px = p.pixelX;
                    const py = dataToPixel({ x: p.xData, y: m.yData }, { x1: x1.pixel!, x2: x2.pixel!, y1: y1.pixel!, y2: y2.pixel! }, { x1: x1.value!, x2: x2.value!, y1: y1.value!, y2: y2.value! }).y;
                    const isActive = p.id === activeProbeId && m.label === activeLabel;
                    return (
                      <React.Fragment key={p.id + "_man_" + m.label}>
                        <Circle x={px} y={py} radius={probeDotSize} fill="blue" />
                        {isActive && (
                          // red ring to indicate this manual point is the active label on the active probe
                          <Circle x={px} y={py} radius={Math.max(1, probeDotSize - 1)} stroke="red" strokeWidth={2} fill="transparent" />
                        )}
                        {showProbeText && (
                          <Text
                            x={px + probeDotSize + 4}
                            y={py - Math.max(8, Math.round(probeDotSize * 0.6))}
                            text={`${m.label}: ${m.yData.toFixed(2)}`}
                            fontSize={Math.max(10, Math.round(probeDotSize * 0.9))}
                            fill="black"
                          />
                        )}
                      </React.Fragment>
                    );
                  })}
                </React.Fragment>
              ))}
            </Layer>
          </Stage>
        </div>
      </div>

      <div
        className="divider"
        onMouseDown={(e) => {
          // start resizing
          resizingRef.current = true;
          startXRef.current = e.clientX;
          startWidthRef.current = rightWidthRef.current;
          // attach move/up handlers
            const onMove = (ev: MouseEvent) => {
            if (!resizingRef.current) return;
            const dx = (startXRef.current === null ? 0 : ev.clientX - startXRef.current);
            const minCenter = 0;
            const totalDividers = 16;
            const maxRight = Math.max(0, window.innerWidth - minCenter - leftWidthRef.current - totalDividers);
            const newW = Math.max(0, Math.min(maxRight, (startWidthRef.current || 320) - dx));
            rightWidthRef.current = newW;
            setRightWidth(newW);
            // update stage size proactively
            const available = window.innerWidth - leftWidthRef.current - rightWidthRef.current - totalDividers;
            setStageSize((s) => ({ ...s, width: Math.max(minCenter, Math.min(Math.max(0, available), 1400)) }));
          };
          const onUp = () => {
            resizingRef.current = false;
            startXRef.current = null;
            startWidthRef.current = null;
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        }}
        style={{ width: 8, cursor: "col-resize", background: "transparent" }}
      />

      <div className="right" style={{ width: rightWidth }}>
        <div className="panel">
          <h3>Labels (top → bottom: least → greatest)</h3>
          <div>
            <textarea
              value={labelsText}
              onChange={(e) => setLabelsText(e.target.value)}
              onBlur={() => {
                const parsed = labelsText.split(",").map((s) => s.trim()).filter(Boolean);
                setLabels(parsed);
                if (parsed.length > 0 && (activeLabel === null || !parsed.includes(activeLabel))) {
                  setActiveLabel(parsed[0]);
                }
              }}
              rows={2}
              style={{ width: "100%" }}
            />
            <div style={{ marginTop: 6 }}>
              <button onClick={() => {
                const parsed = labelsText.split(",").map((s) => s.trim()).filter(Boolean);
                setLabels(parsed);
                if (parsed.length > 0 && (activeLabel === null || !parsed.includes(activeLabel))) {
                  setActiveLabel(parsed[0]);
                }
              }}>Apply labels</button>
            </div>
            <small>Comma-separated numeric labels, e.g. 5,10,20 (edit, then blur or press Apply)</small>
          </div>

          <h3>Probes</h3>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <button onClick={() => addProbeAtData(null)}>Add probe (center)</button>
              <select
                value={activeProbeId ?? ""}
                onChange={(e) => {
                  const id = e.target.value || null;
                  setActiveProbeId(id);
                }}
                style={{ minWidth: 160 }}
              >
                <option value="">-- select probe --</option>
                {sortedProbes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id} ({(p.xData * timeMultiplier).toFixed(3)}s)
                  </option>
                ))}
              </select>
              <button onClick={() => setProbesCollapsed(pc => !pc)}>{probesCollapsed ? "Expand" : "Collapse"}</button>
            </div>
            <div style={{ marginTop: 8 }}>
              <label>Set probe at X (sec):</label>
              <input
                type="number"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const v = Number((e.target as HTMLInputElement).value);
                    addProbeAtData(v);
                  }
                }}
                placeholder="type x then Enter"
              />
            </div>
            {!probesCollapsed && (
              <div style={{ marginTop: 8 }}>
                {sortedProbes.map((p) => (
                  <div
                    key={p.id}
                    className={"probe-row" + (p.id === activeProbeId ? " active" : "")}
                    onClick={() => setActiveProbeId(p.id)}
                  >
                    <strong>{p.id}</strong>
                    <div>Time: {(p.xData * timeMultiplier).toFixed(3)}</div>
                    <div>Auto: {p.automaticY ? p.automaticY.map((v) => v.toFixed(2)).join(", ") : "—"}</div>
                    <div>Manual: {p.manual.map((m) => `${m.label}:${m.yData.toFixed(2)}`).join(", ") || "—"}</div>
                    <button onClick={(ev) => { ev.stopPropagation(); setProbes(ps => ps.filter(q => q.id !== p.id)); }}>Remove</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <h3>Probe Detection Settings</h3>
          <div style={{ marginBottom: 10 }}>
            <label>Selected probe:</label>
            <select
              value={activeProbeId ?? ""}
              onChange={(e) => setActiveProbeId(e.target.value || null)}
            >
              <option value="">--select--</option>
              {probes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} ({(p.xData * timeMultiplier).toFixed(3)}s)
                </option>
              ))}
            </select>

            <div style={{ marginTop: 8 }}>
              <label>Probe Sensitivity</label>
              <div>
                <small>Use the Sensitivity slider above and choose a probe from the dropdown to change a probe's sensitivity.</small>
              </div>
            </div>
            <div style={{ marginTop: 6 }}>
              <label>Probe Band px</label>
              <input
                type="number"
                min={0}
                max={200}
                value={selProbeBand ?? bandPx}
                onChange={(e) => setSelProbeBand(Number(e.target.value))}
              />
            </div>
            <div style={{ marginTop: 6 }}>
              <button
                onClick={() => {
                  if (!activeProbeId) return;
                  setProbes((ps) => {
                    const updated = ps.map((p) => (p.id === activeProbeId ? { ...p, bandPx: selProbeBand ?? null } : p));
                    const p = updated.find((q) => q.id === activeProbeId);
                    if (p) setTimeout(() => runDetectionForProbe(p), 50);
                    return updated;
                  });
                }}
              >
                Apply to probe
              </button>
              <button
                style={{ marginLeft: 8 }}
                onClick={() => {
                  const s = (activeProbeId ? probes.find(p => p.id === activeProbeId)?.sensitivity : null) ?? sensitivity;
                  const b = selProbeBand ?? bandPx;
                  setProbes((ps) => ps.map((p) => ({ ...p, sensitivity: s, bandPx: b })));
                }}
              >
                Copy settings to all
              </button>
            </div>
          </div>

          <h3>Generate probes at interval</h3>
          <div style={{ marginBottom: 10 }}>
            <div>
              <label>Start (s):</label>
              <input type="number" value={genStart} onChange={(e) => setGenStart(Number(e.target.value))} />
              <label style={{ marginLeft: 8 }}>End (s):</label>
              <input type="number" value={genEnd} onChange={(e) => setGenEnd(Number(e.target.value))} />
            </div>
            <div style={{ marginTop: 6 }}>
              <label>Interval (s):</label>
              <input type="number" step={0.1} value={genInterval} onChange={(e) => setGenInterval(Number(e.target.value))} />
              <label style={{ marginLeft: 8 }}>
                <input type="checkbox" checked={genAutoDetect} onChange={(e) => setGenAutoDetect(e.target.checked)} /> Auto-detect after generate
              </label>
            </div>
            <div style={{ marginTop: 6 }}>
              <button
                onClick={() => {
                  if (!calibrated()) {
                    alert("Please calibrate axes first.");
                    return;
                  }
                  const start = genStart;
                  const end = genEnd;
                  const iv = genInterval;
                  if (!(iv > 0)) return;
                  const times: number[] = [];
                  for (let t = start; t <= end + 1e-9; t = Math.round((t + iv) * 100000) / 100000) {
                    times.push(Number(t.toFixed(6)));
                  }
                  const newProbes: Probe[] = times.map((t) => {
                    const px = dataToPixel({ x: t, y: 0 }, { x1: x1.pixel!, x2: x2.pixel!, y1: y1.pixel!, y2: y2.pixel! }, { x1: x1.value!, x2: x2.value!, y1: y1.value!, y2: y2.value! }).x;
                    return { id: uid("probe_"), xData: t, pixelX: px, automaticY: null, manual: [], sensitivity: null, bandPx: null };
                  });
                  // merge skipping near-duplicates (within 1e-6 s)
                  setProbes((ps) => {
                    const existingTimes = new Set(ps.map((p) => p.xData));
                    const merged = [...ps];
                    for (const np of newProbes) {
                      if (![...existingTimes].some((et) => Math.abs(et - np.xData) < 1e-6)) {
                        merged.push(np);
                      }
                    }
                    return merged;
                  });
                  if (genAutoDetect) {
                    // run detection on newly added probes after short delay
                    setTimeout(() => {
                      newProbes.forEach((p) => runDetectionForProbe(p));
                    }, 100);
                  }
                }}
              >
                Generate probes
              </button>
            </div>
          </div>

          <h3>Manual Picking</h3>
          <div>
            <label>
              <input type="checkbox" checked={manualMode} onChange={(e) => setManualMode(e.target.checked)} /> Manual mode (lock X and pick Y)
            </label>
            <div>
              <label>Active probe:</label>
              <select value={activeProbeId ?? ""} onChange={(e) => setActiveProbeId(e.target.value || null)}>
                <option value="">--select--</option>
                {probes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id} ({(p.xData * timeMultiplier).toFixed(3)}s)
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label>Active label:</label>
              <select value={activeLabel ?? ""} onChange={(e) => setActiveLabel(e.target.value || null)}>
                {labels.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <small>Click on the curve to set the y-value for selected probe/label.</small>
            </div>
          </div>

          <h3>Table Preview</h3>
          <div className="table-preview">
            <table>
              <thead>
                <tr>
                  <th>Time (s)</th>
                  {labels.map((l) => <th key={l}>{l}</th>)}
                </tr>
              </thead>
              <tbody>
                {sortedProbes.map((p) => (
                  <tr key={p.id}>
                    <td>{(p.xData * timeMultiplier).toFixed(3)}</td>
                    {labels.map((lab, idx) => {
                      const m = p.manual.find((mm) => mm.label === lab);
                      if (m) return <td key={lab}>{m.yData.toFixed(3)}</td>;
                      if (p.automaticY && p.automaticY[idx] !== undefined) return <td key={lab}>{p.automaticY[idx].toFixed(3)}</td>;
                      return <td key={lab}> </td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 12 }}>
            <button onClick={() => downloadCSV()}>Export CSV</button>
          </div>

          <div style={{ marginTop: 12 }}>
            <strong>Notes:</strong>
            <ul>
              <li>Place x1/x2 on the image (x2 snaps horizontally to x1's row).</li>
              <li>Place y1/y2 on the image (y2 snaps vertically to y1's column).</li>
              <li>Enter the numeric values for calibration (e.g., 0 and 30 sec).</li>
              <li>Add probes and use Detect All or manual picking for overlapped curves.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
