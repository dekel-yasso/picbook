// Stylized flight-map transitions for the trip clip: dark landmass
// silhouettes (Natural Earth, bundled), a self-drawing great-circle arc with
// a glowing head, and camera choreography from origin to destination.

export interface GeoPoint {
  lat: number;
  lon: number;
}

interface Land {
  polys: Float64Array[]; // projected mercator [x,y,x,y…] per polygon
  boxes: [number, number, number, number][];
}

let landPromise: Promise<Land | null> | null = null;

export function loadLand(): Promise<Land | null> {
  if (!landPromise) {
    landPromise = fetch('/geo/land.json')
      .then((r) => {
        if (!r.ok) throw new Error('geo fetch failed');
        return r.json() as Promise<{ polys: number[][] }>;
      })
      .then((data) => {
        const polys: Float64Array[] = [];
        const boxes: Land['boxes'] = [];
        for (const flat of data.polys) {
          const proj = new Float64Array(flat.length);
          let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
          for (let i = 0; i < flat.length; i += 2) {
            const [x, y] = mercator(flat[i + 1], flat[i]);
            proj[i] = x;
            proj[i + 1] = y;
            if (x < minx) minx = x;
            if (x > maxx) maxx = x;
            if (y < miny) miny = y;
            if (y > maxy) maxy = y;
          }
          polys.push(proj);
          boxes.push([minx, miny, maxx, maxy]);
        }
        return { polys, boxes };
      })
      .catch(() => null); // maps degrade to a plain dark card offline
  }
  return landPromise;
}

/** Web Mercator to unit square: x 0..1 west→east, y 0..1 north→south. */
export function mercator(lat: number, lon: number): [number, number] {
  const clamped = Math.max(-85, Math.min(85, lat));
  const x = lon / 360 + 0.5;
  const y = 0.5 - Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)) / (2 * Math.PI);
  return [x, y];
}

export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(s));
}

/** Great-circle samples between two points (spherical interpolation). */
function greatCircle(a: GeoPoint, b: GeoPoint, steps: number): [number, number][] {
  const rad = Math.PI / 180;
  const toVec = (p: GeoPoint) => {
    const lat = p.lat * rad;
    const lon = p.lon * rad;
    return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  };
  const va = toVec(a);
  const vb = toVec(b);
  const dot = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  const omega = Math.acos(dot) || 1e-6;
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const s1 = Math.sin((1 - f) * omega) / Math.sin(omega);
    const s2 = Math.sin(f * omega) / Math.sin(omega);
    const x = s1 * va[0] + s2 * vb[0];
    const y = s1 * va[1] + s2 * vb[1];
    const z = s1 * va[2] + s2 * vb[2];
    const lat = Math.atan2(z, Math.hypot(x, y)) / rad;
    let lon = Math.atan2(y, x) / rad;
    // keep longitudes continuous across the antimeridian
    if (out.length) {
      const prev = out[out.length - 1][1];
      while (lon - prev > 180) lon -= 360;
      while (lon - prev < -180) lon += 360;
    }
    out.push([lat, lon]);
  }
  return out;
}

interface Camera {
  cx: number;
  cy: number;
  span: number; // vertical mercator span visible
}

const smooth = (x: number) => x * x * (3 - 2 * x);
const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const lerpCam = (a: Camera, b: Camera, f: number): Camera => ({
  cx: lerp(a.cx, b.cx, f),
  cy: lerp(a.cy, b.cy, f),
  span: Math.exp(lerp(Math.log(a.span), Math.log(b.span), f)), // zoom in log space
});

/** Inverse Web Mercator y → latitude (for graticule placement). */
function invMercatorY(y: number): number {
  return ((2 * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - Math.PI / 2) * 180) / Math.PI;
}

const clampNum = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface MapSeg {
  from: GeoPoint | null;
  to: GeoPoint;
  fromName?: string;
  toName?: string;
}

/** Draw one frame of a map transition at progress p (0..1). */
export function drawMapFrame(
  ctx: OffscreenCanvasRenderingContext2D,
  size: number,
  land: Land | null,
  seg: MapSeg,
  p: number,
) {
  // Background
  const bg = ctx.createLinearGradient(0, 0, 0, size);
  bg.addColorStop(0, '#070a10');
  bg.addColorStop(1, '#0e141d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);

  const [tox, toy] = mercator(seg.to.lat, seg.to.lon);

  let cam: Camera;
  let arc: [number, number][] | null = null;
  if (!seg.from) {
    // Opening: wide view easing into the starting city.
    const wide: Camera = { cx: tox, cy: toy, span: 0.55 };
    const toCam: Camera = { cx: tox, cy: toy, span: 0.05 };
    cam = lerpCam(wide, toCam, smooth(Math.min(1, p * 1.15)));
  } else {
    // Distance-adaptive altitude: short hops fly low (real coastline detail),
    // long hauls pull back to continents.
    const dist = distanceKm(seg.from, seg.to);
    const closeSpan = clampNum(0.006 + (dist / 9000) * 0.045, 0.007, 0.05);
    const [fx, fy] = mercator(seg.from.lat, seg.from.lon);
    const fromCam: Camera = { cx: fx, cy: fy, span: closeSpan };
    const toCam: Camera = { cx: tox, cy: toy, span: closeSpan };
    const midCam: Camera = {
      cx: (fx + tox) / 2,
      cy: (fy + toy) / 2,
      span: Math.min(1, Math.max(closeSpan * 1.9, 1.9 * Math.max(Math.abs(tox - fx), Math.abs(toy - fy)))),
    };
    cam =
      p < 0.45
        ? lerpCam(fromCam, midCam, smooth(p / 0.45))
        : lerpCam(midCam, toCam, smooth((p - 0.45) / 0.55));
    arc = greatCircle(seg.from, seg.to, 72);
  }

  const px = (mx: number) => ((mx - cam.cx) / cam.span) * size + size / 2;
  const py = (my: number) => ((my - cam.cy) / cam.span) * size + size / 2;
  const viewMinX = cam.cx - cam.span;
  const viewMaxX = cam.cx + cam.span;
  const viewMinY = cam.cy - cam.span;
  const viewMaxY = cam.cy + cam.span;

  // Landmasses (with world-wrap copies for antimeridian crossings) —
  // clearly lighter than the water so coastlines read on small screens.
  if (land) {
    ctx.fillStyle = '#41526a';
    ctx.strokeStyle = 'rgba(200,220,255,0.35)';
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';
    for (const shift of [-1, 0, 1]) {
      for (let k = 0; k < land.polys.length; k++) {
        const [minx, miny, maxx, maxy] = land.boxes[k];
        if (minx + shift > viewMaxX || maxx + shift < viewMinX || miny > viewMaxY || maxy < viewMinY) continue;
        const poly = land.polys[k];
        ctx.beginPath();
        ctx.moveTo(px(poly[0] + shift), py(poly[1]));
        for (let i = 2; i < poly.length; i += 2) ctx.lineTo(px(poly[i] + shift), py(poly[i + 1]));
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  // Graticule: faint lat/lon grid — gives the camera visible motion even over
  // featureless inland areas, and the classic flight-map texture.
  {
    const lonSpanDeg = cam.span * 360;
    const steps = [0.25, 0.5, 1, 2, 5, 10, 20, 40];
    const step = steps.find((s) => lonSpanDeg / s <= 9) ?? 40;
    ctx.strokeStyle = 'rgba(170,195,230,0.07)';
    ctx.lineWidth = 1;
    const lonMin = (viewMinX - 0.5) * 360;
    const lonMax = (viewMaxX - 0.5) * 360;
    for (let lon = Math.ceil(lonMin / step) * step; lon <= lonMax; lon += step) {
      const x = px(lon / 360 + 0.5);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size);
      ctx.stroke();
    }
    const latMax = invMercatorY(viewMinY);
    const latMin = invMercatorY(viewMaxY);
    for (let lat = Math.ceil(latMin / step) * step; lat <= latMax; lat += step) {
      const y = py(mercator(lat, 0)[1]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size, y);
      ctx.stroke();
    }
  }

  // Edge vignette keeps the focus center-frame.
  {
    const v = ctx.createRadialGradient(size / 2, size / 2, size * 0.45, size / 2, size / 2, size * 0.75);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.38)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, size, size);
  }

  // Route arc drawing itself, with a glowing head
  if (arc) {
    const drawnUpTo = Math.max(0, Math.min(1, (p - 0.12) / 0.68));
    const count = Math.floor(drawnUpTo * (arc.length - 1));
    if (count > 0) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,205,110,0.9)';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.shadowColor = 'rgba(255,190,80,0.8)';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      for (let i = 0; i <= count; i++) {
        const [la, lo] = arc[i];
        const [mx, my] = mercator(la, lo);
        if (i === 0) ctx.moveTo(px(mx), py(my));
        else ctx.lineTo(px(mx), py(my));
      }
      ctx.stroke();
      // head dot
      const [hla, hlo] = arc[count];
      const [hx, hy] = mercator(hla, hlo);
      ctx.fillStyle = '#ffd98a';
      ctx.beginPath();
      ctx.arc(px(hx), py(hy), 6, 0, 7);
      ctx.fill();
      ctx.restore();
    }
  }

  // City dots + labels
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.font = '600 42px system-ui, sans-serif';
  if (seg.from) {
    const alpha = Math.max(0, 1 - p * 2.2);
    if (alpha > 0.01) {
      const [fx, fy] = mercator(seg.from.lat, seg.from.lon);
      drawCity(ctx, px(fx), py(fy), seg.fromName, alpha, false);
    }
  }
  const toAlpha = seg.from ? Math.max(0, Math.min(1, (p - 0.55) * 3)) : Math.max(0, Math.min(1, (p - 0.35) * 2.5));
  if (toAlpha > 0.01) {
    drawCity(ctx, px(tox), py(toy), seg.toName, toAlpha, p > 0.8);
  }
}

function drawCity(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  name: string | undefined,
  alpha: number,
  pulse: boolean,
) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = '#f3f5f8';
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, 7);
  ctx.fill();
  if (pulse) {
    ctx.strokeStyle = 'rgba(243,245,248,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, 7);
    ctx.stroke();
  }
  if (name) {
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 8;
    ctx.fillText(name, x, y - 18);
  }
  ctx.restore();
}
