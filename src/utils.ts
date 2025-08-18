type Point = { x: number; y: number };
type CalPixels = { x1: Point | null; x2: Point | null; y1: Point | null; y2: Point | null };
type CalValues = { x1: number | null; x2: number | null; y1: number | null; y2: number | null };

/**
 * Compute intersection point of two lines (p1->p2) and (p3->p4).
 * Returns null if lines are parallel.
 */
function lineIntersection(p1: Point, p2: Point, p3: Point, p4: Point): Point | null {
  const a1 = p2.y - p1.y;
  const b1 = p1.x - p2.x;
  const c1 = a1 * p1.x + b1 * p1.y;

  const a2 = p4.y - p3.y;
  const b2 = p3.x - p4.x;
  const c2 = a2 * p3.x + b2 * p3.y;

  const det = a1 * b2 - a2 * b1;
  if (Math.abs(det) < 1e-9) return null;
  return { x: (b2 * c1 - b1 * c2) / det, y: (a1 * c2 - a2 * c1) / det };
}

/**
 * Dot product
 */
function dot(a: Point, b: Point) {
  return a.x * b.x + a.y * b.y;
}

/**
 * Subtract
 */
function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

/**
 * Length
 */
function len(a: Point) {
  return Math.hypot(a.x, a.y);
}

/**
 * Normalize
 */
function norm(a: Point): Point {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
}

/**
 * Multiply scalar
 */
function mul(a: Point, s: number): Point {
  return { x: a.x * s, y: a.y * s };
}

/**
 * Add
 */
function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

/**
 * Convert a pixel coordinate to data coordinate using four calibration points.
 * Expects calib pixels and values to be non-null (App uses ! when calling).
 */
export function pixelToData(
  p: Point,
  pixels: CalPixels,
  vals: CalValues
): { x: number; y: number } {
  if (!pixels.x1 || !pixels.x2 || !pixels.y1 || !pixels.y2) return { x: 0, y: 0 };
  if (vals.x1 === null || vals.x2 === null || vals.y1 === null || vals.y2 === null) return { x: 0, y: 0 };

  const O = lineIntersection(pixels.x1, pixels.x2, pixels.y1, pixels.y2) || pixels.x1;

  // unit directions
  const ux_dir = norm(sub(pixels.x2, pixels.x1));
  const uy_dir = norm(sub(pixels.y2, pixels.y1));

  // projections of x1,x2,y1,y2 relative to O along unit directions
  const alpha1 = dot(sub(pixels.x1, O), ux_dir);
  const alpha2 = dot(sub(pixels.x2, O), ux_dir);
  const beta1 = dot(sub(pixels.y1, O), uy_dir);
  const beta2 = dot(sub(pixels.y2, O), uy_dir);

  // projection of point p
  const projX = dot(sub(p, O), ux_dir);
  const projY = dot(sub(p, O), uy_dir);

  // map projX into data x using alpha1/alpha2 <-> vals.x1/vals.x2
  let xData = vals.x1 + ((projX - alpha1) / (alpha2 - alpha1)) * (vals.x2 - vals.x1);
  let yData = vals.y1 + ((projY - beta1) / (beta2 - beta1)) * (vals.y2 - vals.y1);

  if (!isFinite(xData)) xData = 0;
  if (!isFinite(yData)) yData = 0;

  return { x: xData, y: yData };
}

/**
 * Convert a data coordinate to pixel coordinate using calibration.
 */
export function dataToPixel(
  data: { x: number; y: number },
  pixels: CalPixels,
  vals: CalValues
): Point {
  if (!pixels.x1 || !pixels.x2 || !pixels.y1 || !pixels.y2) return { x: 0, y: 0 };
  if (vals.x1 === null || vals.x2 === null || vals.y1 === null || vals.y2 === null) return { x: 0, y: 0 };

  const O = lineIntersection(pixels.x1, pixels.x2, pixels.y1, pixels.y2) || pixels.x1;

  const ux_dir = norm(sub(pixels.x2, pixels.x1));
  const uy_dir = norm(sub(pixels.y2, pixels.y1));

  const alpha1 = dot(sub(pixels.x1, O), ux_dir);
  const alpha2 = dot(sub(pixels.x2, O), ux_dir);
  const beta1 = dot(sub(pixels.y1, O), uy_dir);
  const beta2 = dot(sub(pixels.y2, O), uy_dir);

  const alpha = alpha1 + ((data.x - vals.x1) / (vals.x2 - vals.x1)) * (alpha2 - alpha1);
  const beta = beta1 + ((data.y - vals.y1) / (vals.y2 - vals.y1)) * (beta2 - beta1);

  const px = add(add(O, mul(ux_dir, alpha)), mul(uy_dir, beta));
  return px;
}

/**
 * Export CSV from a rows array (array of cells).
 */
export function exportCSV(rows: (string | number)[][]): string {
  return rows
    .map((r) =>
      r
        .map((cell) => {
          if (cell === null || cell === undefined) return "";
          const s = String(cell);
          if (s.includes(",") || s.includes('"') || s.includes("\n")) {
            return '"' + s.replace(/"/g, '""') + '"';
          }
          return s;
        })
        .join(",")
    )
    .join("\n");
}
