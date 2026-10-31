// 歩行解析ロジック（gait_analysis.py の移植）。DOMに依存しない純粋関数。
export const VISIBILITY_THRESHOLD = 0.5;
export const SKELETON_CONNECTIONS = [
  [11, 13], [13, 15], [12, 14], [14, 16], [11, 12],
  [11, 23], [12, 24], [23, 24], [23, 25], [25, 27],
  [27, 29], [29, 31], [24, 26], [26, 28], [28, 30], [30, 32],
];
export const IDS = {
  left: { shoulder: 11, hip: 23, knee: 25, ankle: 27, foot_index: 31 },
  right: { shoulder: 12, hip: 24, knee: 26, ankle: 28, foot_index: 32 },
};
const SIDES = ["left", "right"];
const XY_JOINTS = ["shoulder", "hip", "knee", "ankle"];

const round = (v, d) => { const f = 10 ** d; return Math.round(v * f) / f; };
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export function angleDegrees(a, b, c) {
  if (!a || !b || !c) return null;
  const ba = [a[0] - b[0], a[1] - b[1]];
  const bc = [c[0] - b[0], c[1] - b[1]];
  const nba = Math.hypot(...ba), nbc = Math.hypot(...bc);
  if (nba < 1e-9 || nbc < 1e-9) return null;
  const cos = (ba[0] * bc[0] + ba[1] * bc[1]) / (nba * nbc);
  const included = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  return round(180 - included, 2); // 伸展位≈0度
}

function vis(lm) { return lm.visibility ?? 1.0; }

export function getPoint(landmarks, id, w, h) {
  const lm = landmarks[id];
  const v = vis(lm);
  if (v != null && v < VISIBILITY_THRESHOLD) return [null, null];
  return [[lm.x * w, lm.y * h], Number(v || 0)];
}

function hipCenter(landmarks, w, h) {
  const pts = [23, 24].map((id) => getPoint(landmarks, id, w, h)[0]).filter(Boolean);
  if (!pts.length) return null;
  return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
}

export function chooseLeadingPose(poses, w, h, direction) {
  if (!poses || !poses.length) return null;
  let best = null, bestVal = -Infinity;
  poses.forEach((pose, i) => {
    const c = hipCenter(pose, w, h);
    if (c && c[0] * direction > bestVal) { bestVal = c[0] * direction; best = i; }
  });
  return best === null ? null : poses[best];
}

// 出力列（Pythonの行dictのキー順に合わせる）
export function exportColumns() {
  const cols = ["frame", "time_seconds", "timestamp_ms", "image_width_px", "image_height_px"];
  for (const s of SIDES) {
    for (const j of XY_JOINTS) for (const a of ["x_norm", "y_norm", "x_px", "y_px", "visibility"]) cols.push(`${s}_${j}_${a}`);
    cols.push(`${s}_hip_flexion_deg`, `${s}_knee_flexion_deg`);
    for (const a of ["x_norm", "y_norm", "x_px", "y_px"]) cols.push(`${s}_foot_index_${a}`);
  }
  return cols;
}

export function buildRow(frameIndex, fps, timestampMs, w, h, pose) {
  const row = { frame: frameIndex, time_seconds: round(frameIndex / fps, 4), timestamp_ms: timestampMs, image_width_px: w, image_height_px: h };
  for (const s of SIDES) {
    const id = IDS[s];
    if (pose) {
      for (const j of [...XY_JOINTS, "foot_index"]) {
        const lm = pose[id[j]];
        row[`${s}_${j}_x_norm`] = round(lm.x, 6);
        row[`${s}_${j}_y_norm`] = round(lm.y, 6);
        row[`${s}_${j}_x_px`] = round(lm.x * w, 2);
        row[`${s}_${j}_y_px`] = round(lm.y * h, 2);
        row[`${s}_${j}_visibility`] = lm.visibility != null ? round(lm.visibility, 4) : null;
      }
      const [sh, shv] = getPoint(pose, id.shoulder, w, h);
      const [hp, hpv] = getPoint(pose, id.hip, w, h);
      const [kn, knv] = getPoint(pose, id.knee, w, h);
      const [an, anv] = getPoint(pose, id.ankle, w, h);
      const [ft, ftv] = getPoint(pose, id.foot_index, w, h);
      row[`${s}_hip_flexion_deg`] = angleDegrees(sh, hp, kn);
      row[`${s}_knee_flexion_deg`] = angleDegrees(hp, kn, an);
      // 可視性0.5未満は空欄（Python版と同じ上書き）
      row[`${s}_shoulder_visibility`] = shv;
      row[`${s}_hip_visibility`] = hpv;
      row[`${s}_knee_visibility`] = knv;
      row[`${s}_ankle_visibility`] = anv;
      row[`_${s}_foot_index_x`] = ft ? ft[0] : null;
      row[`_${s}_foot_index_visibility`] = ftv;
      row[`_${s}_hip_x`] = hp ? hp[0] : null;
    } else {
      row[`${s}_hip_flexion_deg`] = null;
      row[`${s}_knee_flexion_deg`] = null;
      row[`_${s}_foot_index_x`] = null;
      row[`_${s}_foot_index_visibility`] = null;
      row[`_${s}_hip_x`] = null;
    }
  }
  return row;
}

// pandas: interpolate(method="linear", limit_direction="both")
export function interpolateBoth(values) {
  const v = values.map((x) => (isNum(x) ? x : NaN));
  const valid = [];
  v.forEach((x, i) => { if (!Number.isNaN(x)) valid.push(i); });
  if (!valid.length) return v;
  const out = v.slice();
  for (let i = 0; i < valid[0]; i++) out[i] = v[valid[0]];
  const last = valid[valid.length - 1];
  for (let i = last + 1; i < v.length; i++) out[i] = v[last];
  for (let k = 0; k < valid.length - 1; k++) {
    const a = valid[k], b = valid[k + 1];
    for (let i = a + 1; i < b; i++) out[i] = v[a] + ((v[b] - v[a]) * (i - a)) / (b - a);
  }
  return out;
}

const pyRound = (x) => { // Pythonのround（偶数丸め）
  const f = Math.floor(x), d = x - f;
  if (Math.abs(d - 0.5) < 1e-12) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
};

export function contactFrames(values, fps, width, direction) {
  const n = values.length;
  const filled = interpolateBoth(values);
  if (n < 3 || !filled.every((x) => Number.isFinite(x))) return [];
  const win = Math.max(3, pyRound(fps * 0.12) | 1);
  const half = Math.floor(win / 2);
  const smooth = filled.map((_, i) => {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + (win - 1 - half)); j++) { s += filled[j]; c++; }
    return s / c;
  });
  const sign = direction >= 0 ? 1 : -1;
  const fwd = smooth.map((x) => x * sign);
  const minGap = Math.max(3, Math.trunc(fps * 0.5));
  const radius = Math.max(minGap, Math.trunc(fps * 0.45));
  const prominence = width * 0.02;
  const excl = Math.max(1, Math.floor(minGap / 3));
  const cand = [];
  for (let i = 1; i < n - 1; i++) {
    if (fwd[i] < fwd[i - 1] || fwd[i] < fwd[i + 1]) continue;
    const L = Math.max(0, i - radius), R = Math.min(n, i + radius + 1);
    let localMin = Infinity, any = false;
    for (let j = L; j < R; j++) if (Math.abs(j - i) >= excl) { any = true; if (fwd[j] < localMin) localMin = fwd[j]; }
    if (!any) continue;
    if (fwd[i] - localMin >= prominence) cand.push([i, fwd[i] - localMin]);
  }
  cand.sort((a, b) => b[1] - a[1]);
  const sel = [];
  for (const [f] of cand) if (sel.every((k) => Math.abs(f - k) >= minGap)) sel.push(f);
  return sel.sort((a, b) => a - b);
}

function interp(x, xp, fp) {
  if (x <= xp[0]) return fp[0];
  if (x >= xp[xp.length - 1]) return fp[fp.length - 1];
  let k = 0;
  while (xp[k + 1] < x) k++;
  const t = (x - xp[k]) / (xp[k + 1] - xp[k]);
  return fp[k] + t * (fp[k + 1] - fp[k]);
}

export function normalizedCycles(rows, side, fps, width) {
  const hipX = rows.map((r) => r[`_${side}_hip_x`]).filter(isNum);
  const direction = hipX.length > 1 ? hipX[hipX.length - 1] - hipX[0] : 1.0;
  const events = contactFrames(rows.map((r) => r[`_${side}_foot_index_x`]), fps, width, direction);
  const cycles = [];
  for (let k = 0; k < events.length - 1; k++) if (events[k + 1] - events[k] >= fps * 0.5) cycles.push([events[k], events[k + 1]]);
  if (!cycles.length) {
    throw new Error(`${side === "left" ? "左" : "右"}側の足の接地を2回以上検出できず、1歩行周期を作れませんでした。全身と足先が見える横向きの動画を使い、動画の前後に歩行中の区間を含めてください。`);
  }
  const phase = Array.from({ length: 101 }, (_, i) => i);
  const cycleData = phase.map((p) => ({ gait_cycle_percent: p }));
  for (const s of SIDES) for (const joint of ["knee", "hip"]) {
    const series = rows.map((r) => r[`${s}_${joint}_flexion_deg`]);
    const mats = cycles.map(([a, b]) => {
      const seg = interpolateBoth(series.slice(a, b + 1));
      if (seg.length < 2 || seg.every(Number.isNaN)) return phase.map(() => NaN);
      const xp = seg.map((_, o) => (100 * o) / (seg.length - 1));
      return phase.map((p) => interp(p, xp, seg));
    });
    phase.forEach((p) => {
      const vals = mats.map((m) => m[p]).filter((x) => !Number.isNaN(x));
      cycleData[p][`${s}_${joint}_mean_deg`] = vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : null;
    });
  }
  const r3 = (x) => round(x, 3);
  const eventsTable = cycles.map(([a, b], i) => ({
    side, cycle: i + 1, start_contact_frame: a, start_time_seconds: r3(a / fps),
    next_contact_frame: b, next_contact_time_seconds: r3(b / fps), cycle_duration_seconds: r3((b - a) / fps),
  }));
  return { cycleData, events: eventsTable };
}

export function chooseCycleSide(rows) {
  const score = (s) => rows.reduce((t, r) => t + (isNum(r[`_${s}_foot_index_visibility`]) ? r[`_${s}_foot_index_visibility`] : 0), 0) / rows.length;
  return score("right") > score("left") ? "right" : "left";
}

export function notesTable(cycleSide, nCycles) {
  return [
    ["内容", "MediaPipe Pose Landmarker による動画各フレームの2D推定値"],
    ["角度の定義", "膝・股関節とも、伸展位を約0度とする屈曲方向の角度（度）。股関節は肩-股-膝の2D角度から算出。"],
    ["欠損値", "ランドマークが見えない、または可視性が0.5未満の場合は空欄"],
    ["歩行周期", `${cycleSide}足の足先位置の前方極値から接地を推定し、連続する接地間を0〜100%に正規化。検出周期数: ${nCycles}。接地タイミングは推定値です。`],
    ["座標", "関節点ごとに画像内の正規化X/Y（0〜1）とピクセルX/Yを記録。画像左上が(0,0)、右下方向へ値が増加します。visibilityは推定可視性です。"],
    ["注意", "横からの単眼動画による推定であり、臨床測定・診断には使用できません。撮影角度、隠れ、衣服、左右の重なり等で誤差が生じます。"],
  ];
}
