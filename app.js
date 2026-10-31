import { PoseLandmarker } from "./vision_bundle.mjs";
import { Muxer, ArrayBufferTarget } from "./mp4-muxer.mjs";
import * as G from "./gait.js";

const APP_VERSION = "1.2.0";
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------- IndexedDB ----------
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open("gait-app", 1);
  r.onupgradeneeded = () => {
    const db = r.result;
    db.createObjectStore("videos", { keyPath: "id" });
    db.createObjectStore("results", { keyPath: "id" });
    db.createObjectStore("kv");
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function tx(store, mode, fn) {
  const db = await dbp;
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error("保存に失敗しました（容量不足の可能性）"));
  });
}
const dbPut = (s, v, k) => tx(s, "readwrite", (o) => o.put(v, k));
const dbGet = (s, k) => tx(s, "readonly", (o) => o.get(k));
const dbDel = (s, k) => tx(s, "readwrite", (o) => o.delete(k));
const dbAll = (s) => tx(s, "readonly", (o) => o.getAll());

// ---------- 共通UI ----------
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = (n) => String(n).padStart(2, "0");
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
const fmtDate = (t) => new Date(t).toLocaleString("ja-JP");
const fmtSize = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : (b / 1e3).toFixed(0) + " KB");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}

async function saveFiles(files) {
  // iPhone/iPadでは共有シートから「ファイルに保存」「ビデオを保存」が選べる
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  for (const f of files) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(f); a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
}

// ---------- タブ ----------
$$(".tab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
function showTab(name) {
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
  if (name !== "record" && !recorder) stopCamera();
  if (name === "library") renderVideos();
  if (name === "results") renderResults();
  if (name === "settings") renderSettings();
}

// ---------- 撮影 ----------
let stream = null, recorder = null, chunks = [], recStart = 0, recTick = null;
async function startCamera() {
  stopCamera();
  const h = Number($("#resSel").value), w = h === 1080 ? 1920 : 1280;
  const fps = Number($("#fpsSel").value);
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: $("#facingSel").value, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: fps } },
    });
  } catch (e) {
    $("#camMsg").textContent = "カメラを使えません: " + e.message; return;
  }
  $("#preview").srcObject = stream;
  $("#preview").onloadedmetadata = () => fitPreview();
  $("#camMsg").classList.add("hidden");
  $("#recBtn").disabled = false;
  $("#camBtn").textContent = "カメラ再起動";
  const s = stream.getVideoTracks()[0].getSettings();
  toast(`カメラ: ${s.width}×${s.height} / ${Math.round(s.frameRate || fps)} fps`);
}
function fitPreview() {
  const v = $("#preview"), w = v.videoWidth, h = v.videoHeight;
  if (!w || !h) return;
  $(".camwrap").style.aspectRatio = `${w} / ${h}`;
  $("#orientWarn").classList.toggle("hidden", w >= h);
}
$("#preview").addEventListener("resize", fitPreview);
window.addEventListener("orientationchange", () => setTimeout(() => stream && !recorder && startCamera(), 600));
function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null; $("#preview").srcObject = null;
  $("#camMsg").classList.remove("hidden"); $("#camMsg").textContent = "「カメラ起動」を押してください";
  $("#recBtn").disabled = true; $("#camBtn").textContent = "カメラ起動";
}
$("#camBtn").onclick = startCamera;
["#resSel", "#fpsSel", "#facingSel"].forEach((s) => $(s).addEventListener("change", () => stream && !recorder && startCamera()));

function pickMime() {
  const list = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
  return list.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
}
$("#recBtn").onclick = () => {
  if (recorder) { recorder.stop(); return; }
  if (!stream) return;
  const mimeType = pickMime();
  chunks = [];
  recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12_000_000 });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = async () => {
    clearInterval(recTick); $("#recTimer").classList.add("hidden");
    $("#recBtn").textContent = "録画開始"; keepAwake(false);
    const type = recorder.mimeType || mimeType || "video/mp4";
    const s = stream ? stream.getVideoTracks()[0].getSettings() : {};
    recorder = null;
    const blob = new Blob(chunks, { type }); chunks = [];
    const ext = type.includes("webm") ? "webm" : "mp4";
    await addVideo(blob, `walk_${stamp(new Date(recStart))}.${ext}`, s.frameRate ? Math.round(s.frameRate) : null);
    toast("端末内に保存しました（「動画」タブ）");
  };
  recorder.start(1000);
  recStart = Date.now(); keepAwake(true);
  $("#recBtn").textContent = "録画停止";
  $("#recTimer").classList.remove("hidden");
  recTick = setInterval(() => {
    const s = Math.floor((Date.now() - recStart) / 1000);
    $("#recTimer").textContent = `● ${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  }, 250);
};

// ---------- 動画ライブラリ ----------
function loadVideoEl(blob, attach = false) {
  return new Promise((res, rej) => {
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto";
    v.setAttribute("playsinline", "");
    if (attach) { Object.assign(v.style, { position: "fixed", left: "0", top: "0", width: "2px", height: "2px", opacity: "0.01", pointerEvents: "none" }); document.body.appendChild(v); }
    v.onloadedmetadata = async () => {
      if (!Number.isFinite(v.duration)) { // MediaRecorder動画の長さ取得対策
        await new Promise((r) => { v.ontimeupdate = () => { v.ontimeupdate = null; r(); }; v.currentTime = 1e9; });
      }
      res(v);
    };
    v.onerror = () => rej(new Error("動画を開けません。MP4/MOV形式をお試しください。"));
    v.src = URL.createObjectURL(blob);
  });
}
function seekTo(v, t) {
  return new Promise((res) => {
    const done = () => { v.removeEventListener("seeked", done); res(); };
    v.addEventListener("seeked", done);
    v.currentTime = t;
  });
}
function disposeVideo(v) { URL.revokeObjectURL(v.src); v.removeAttribute("src"); v.load(); v.remove(); }

async function makeThumb(blob) {
  try {
    const v = await loadVideoEl(blob, true);
    await seekTo(v, Math.min(0.2, v.duration / 2));
    const c = document.createElement("canvas"); c.width = 320; c.height = Math.round(320 * v.videoHeight / v.videoWidth) || 180;
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
    const meta = { thumb: c.toDataURL("image/jpeg", 0.7), duration: v.duration, width: v.videoWidth, height: v.videoHeight };
    disposeVideo(v); return meta;
  } catch { return {}; }
}

async function addVideo(blob, name, fps) {
  const meta = await makeThumb(blob);
  await dbPut("videos", { id: uid(), name, created: Date.now(), type: blob.type, size: blob.size, blob, fps, ...meta });
  renderVideos();
}
$("#importVideo").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  toast("読み込み中…");
  await addVideo(f, f.name, null);
  toast("端末内に保存しました");
};

async function renderVideos() {
  const list = (await dbAll("videos")).sort((a, b) => b.created - a.created);
  const ul = $("#videoList");
  if (!list.length) { ul.innerHTML = `<li class="empty">動画がありません。「撮影」タブで録画するか、読み込んでください。</li>`; return; }
  ul.innerHTML = list.map((v) => `
    <li data-id="${v.id}">
      ${v.thumb ? `<img class="thumb" src="${v.thumb}">` : `<div class="thumb"></div>`}
      <div class="meta"><b>${esc(v.name)}</b>
        <span>${fmtDate(v.created)} ・ ${v.duration ? v.duration.toFixed(1) + " 秒" : ""} ・ ${v.width ? v.width + "×" + v.height : ""} ・ ${fmtSize(v.size)}${v.fps ? " ・ " + v.fps + " fps" : ""}</span></div>
      <div class="acts">
        <button class="btn small" data-act="analyze">解析</button>
        <button class="btn small sub" data-act="export">保存/共有</button>
        <button class="btn small sub" data-act="delete">削除</button>
      </div>
    </li>`).join("");
}
$("#videoList").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const id = b.closest("li").dataset.id;
  const rec = await dbGet("videos", id);
  if (b.dataset.act === "analyze") openAnalyze(rec);
  if (b.dataset.act === "export") saveFiles([new File([rec.blob], rec.name, { type: rec.type })]);
  if (b.dataset.act === "delete" && confirm(`「${rec.name}」を削除しますか？`)) { await dbDel("videos", id); renderVideos(); }
});

// ---------- モデル ----------
let modelBytes = null;
async function getModel() {
  if (modelBytes) return modelBytes;
  const saved = await dbGet("kv", "model");
  if (saved) return (modelBytes = new Uint8Array(saved.buffer));
  // アプリと同じ場所にモデルを置いた場合は自動で取り込む（heavy優先）
  // 2分割したもの（.part1/.part2）にも対応
  for (const name of ["pose_landmarker_heavy.task", "pose_landmarker_full.task", "models/pose_landmarker_heavy.task"]) {
    try {
      let buf = null;
      const r = await fetch(name, { cache: "no-store" });
      if (r.ok) buf = await r.arrayBuffer();
      else {
        const [a, b] = await Promise.all([1, 2].map((i) => fetch(`${name}.part${i}`, { cache: "no-store" })));
        if (!a.ok || !b.ok) continue;
        const [x, y] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
        const u = new Uint8Array(x.byteLength + y.byteLength); u.set(new Uint8Array(x), 0); u.set(new Uint8Array(y), x.byteLength);
        buf = u.buffer;
      }
      if (buf && buf.byteLength > 1e6) { await dbPut("kv", { name: name.split("/").pop(), buffer: buf, size: buf.byteLength }, "model"); return (modelBytes = new Uint8Array(buf)); }
    } catch {}
  }
  return null;
}
$("#importModel").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  const buf = await f.arrayBuffer();
  if (buf.byteLength < 1e6) { toast("モデルファイルではないようです"); return; }
  await dbPut("kv", { name: f.name, buffer: buf, size: buf.byteLength }, "model");
  modelBytes = new Uint8Array(buf);
  toast("モデルを端末内に保存しました"); renderSettings(); updBadge();
};
$("#splitModel").onclick = async () => {
  const m = await dbGet("kv", "model");
  if (!m) { toast("先にモデルを取り込んでください"); return; }
  const half = Math.ceil(m.buffer.byteLength / 2);
  // 取り込んだファイル名が変わっていても、自動読み込みで探す名前にそろえる
  const base = /full/i.test(m.name) ? "pose_landmarker_full.task" : "pose_landmarker_heavy.task";
  const files = [1, 2].map((i) => new File([m.buffer.slice((i - 1) * half, i * half)], `${base}.part${i}`, { type: "application/octet-stream" }));
  await saveFiles(files);
};
async function renderSettings() {
  const m = await dbGet("kv", "model");
  $("#modelStatus").innerHTML = m ? `保存済み: <b>${esc(m.name)}</b>（${fmtSize(m.size)}）` : `<span class="warn">未設定です。解析前にモデルを取り込んでください。</span>`;
  if (navigator.storage?.estimate) {
    const e = await navigator.storage.estimate();
    const p = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    $("#storageInfo").textContent = `使用 ${fmtSize(e.usage || 0)} / 上限目安 ${fmtSize(e.quota || 0)}${p ? "（消去されにくい保存）" : ""}`;
  }
  $("#verInfo").textContent = `バージョン ${APP_VERSION}`;
}
async function createLandmarker() {
  const bytes = await getModel();
  if (!bytes) throw new Error("姿勢推定モデルが未設定です。「設定」タブで pose_landmarker_heavy.task を取り込んでください。");
  const fileset = {
    wasmLoaderPath: new URL("vision_wasm_internal.js", location.href).href,
    wasmBinaryPath: new URL("vision_wasm_internal.wasm", location.href).href,
  };
  const opts = (delegate) => ({
    baseOptions: { modelAssetBuffer: bytes, delegate },
    runningMode: "VIDEO", numPoses: 2,
    minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  try { return await PoseLandmarker.createFromOptions(fileset, opts("GPU")); }
  catch { return await PoseLandmarker.createFromOptions(fileset, opts("CPU")); }
}

// ---------- 解析ダイアログ ----------
let anaRec = null, anaDir = 1, cancelFlag = false, running = false;
$$(".seg button").forEach((b) => b.addEventListener("click", () => {
  anaDir = Number(b.dataset.dir);
  $$(".seg button").forEach((x) => x.classList.toggle("active", x === b));
}));
async function openAnalyze(rec) {
  anaRec = rec;
  $("#anaName").textContent = rec.name;
  const pv = $("#anaPreview"); if (pv.src) URL.revokeObjectURL(pv.src);
  pv.src = URL.createObjectURL(rec.blob);
  $("#anaProgress").classList.add("hidden");
  $("#anaStart").disabled = false; $("#anaCancel").textContent = "閉じる";
  $("#anaFps").value = rec.fps || 30;
  $("#analyzeDlg").classList.remove("hidden");
  if (!rec.fps) estimateFps(rec.blob).then((f) => { if (f && !running) $("#anaFps").value = f; });
}
async function estimateFps(blob) {
  try {
    const v = await loadVideoEl(blob, true);
    if (!v.requestVideoFrameCallback) { disposeVideo(v); return null; }
    const times = [];
    await new Promise((res) => {
      const to = setTimeout(res, 2500);
      const cb = (_, m) => { if (!times.length || m.mediaTime !== times[times.length - 1]) times.push(m.mediaTime); if (times.length > 20) { clearTimeout(to); res(); } else v.requestVideoFrameCallback(cb); };
      v.requestVideoFrameCallback(cb); v.play().catch(res);
    });
    disposeVideo(v);
    const d = times.slice(1).map((t, i) => t - times[i]).filter((x) => x > 0).sort((a, b) => a - b);
    if (d.length < 5) return null;
    const f = 1 / d[Math.floor(d.length / 2)];
    const common = [24, 25, 30, 50, 60, 120, 240].find((c) => Math.abs(f - c) / c < 0.04);
    return common || Math.round(f * 100) / 100;
  } catch { return null; }
}
function closeAnalyze() {
  if (running) { cancelFlag = true; return; }
  const pv = $("#anaPreview"); pv.pause(); URL.revokeObjectURL(pv.src); pv.removeAttribute("src"); pv.load();
  $("#analyzeDlg").classList.add("hidden");
}
$("#anaCancel").onclick = closeAnalyze;
$("#anaStart").onclick = async () => {
  const fps = Number($("#anaFps").value);
  if (!(fps > 0)) { toast("フレームレートを入力してください"); return; }
  $("#anaPreview").pause();
  running = true; cancelFlag = false;
  $("#anaStart").disabled = true; $("#anaCancel").textContent = "中止";
  $("#anaProgress").classList.remove("hidden");
  keepAwake(true);
  try {
    const result = await analyze(anaRec, anaDir, fps, $("#anaStick").checked, (i, n, msg) => {
      $("#anaBar").value = n ? i / n : 0;
      $("#anaText").textContent = msg || `${i} / ${n} フレーム`;
    });
    await dbPut("results", result);
    running = false; closeAnalyze();
    showTab("results"); openResult(result.id);
    toast("解析が完了しました");
  } catch (e) {
    running = false;
    $("#anaText").textContent = e.message === "cancel" ? "中止しました" : "エラー: " + e.message;
    $("#anaStart").disabled = false; $("#anaCancel").textContent = "閉じる";
  } finally { keepAwake(false); }
};

// ---------- 解析本体 ----------
function drawOverlay(ctx, pose, W, H, frameIndex, fps, direction) {
  const xy = {};
  if (pose) pose.forEach((lm, i) => { const v = lm.visibility ?? 1; if (v >= G.VISIBILITY_THRESHOLD) xy[i] = [Math.trunc(lm.x * W), Math.trunc(lm.y * H)]; });
  ctx.lineCap = "round"; ctx.lineWidth = 3; ctx.strokeStyle = "rgb(80,230,70)";
  for (const [a, b] of G.SKELETON_CONNECTIONS) if (xy[a] && xy[b]) { ctx.beginPath(); ctx.moveTo(...xy[a]); ctx.lineTo(...xy[b]); ctx.stroke(); }
  ctx.fillStyle = "rgb(255,80,30)";
  for (const p of Object.values(xy)) { ctx.beginPath(); ctx.arc(p[0], p[1], 4, 0, Math.PI * 2); ctx.fill(); }
  const label = `Frame: ${frameIndex}   Time: ${(frameIndex / fps).toFixed(2)} s   Lead: ${direction > 0 ? "RIGHT" : "LEFT"}`;
  ctx.fillStyle = "#000"; ctx.fillRect(12, 12, 598, 46);
  ctx.fillStyle = "#fff"; ctx.font = "bold 26px -apple-system, Helvetica, sans-serif"; ctx.textBaseline = "middle";
  ctx.fillText(label, 24, 36);
}

async function setupEncoder(W, H, fps) {
  if (!("VideoEncoder" in window)) return null;
  const ew = W - (W % 2), eh = H - (H % 2);
  let cfg = null;
  for (const codec of ["avc1.640033", "avc1.640028", "avc1.4d0033", "avc1.42003e"]) {
    const c = { codec, width: ew, height: eh, bitrate: Math.min(16e6, ew * eh * fps * 0.12), framerate: fps, avc: { format: "avc" } };
    try { if ((await VideoEncoder.isConfigSupported(c)).supported) { cfg = c; break; } } catch {}
  }
  if (!cfg) return null;
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: "avc", width: ew, height: eh, frameRate: fps }, fastStart: "in-memory", firstTimestampBehavior: "offset" });
  let err = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (err = e) });
  enc.configure(cfg);
  let canvas = null;
  if (ew !== W || eh !== H) { canvas = document.createElement("canvas"); canvas.width = ew; canvas.height = eh; }
  return {
    async add(src, i) {
      if (err) throw err;
      let s = src;
      if (canvas) { canvas.getContext("2d").drawImage(src, 0, 0); s = canvas; }
      const frame = new VideoFrame(s, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      enc.encode(frame, { keyFrame: i % Math.max(1, Math.round(fps * 2)) === 0 });
      frame.close();
      while (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
    },
    async finish() {
      await enc.flush(); enc.close(); muxer.finalize();
      return new Blob([target.buffer], { type: "video/mp4" });
    },
    abort() { try { enc.close(); } catch {} },
  };
}

async function analyze(rec, direction, fps, makeStick, progress) {
  progress(0, 0, "モデルを準備中…");
  const landmarker = await createLandmarker();
  const v = await loadVideoEl(rec.blob, true);
  try { await v.play(); v.pause(); } catch {}
  const W = v.videoWidth, H = v.videoHeight, duration = v.duration;
  const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: false });
  const enc = makeStick ? await setupEncoder(W, H, fps) : null;
  const total = Math.max(1, Math.floor(duration * fps + 1e-6));
  const rows = [];
  const t0 = performance.now();
  try {
    for (let i = 0; i < total; i++) {
      if (cancelFlag) throw new Error("cancel");
      await seekTo(v, Math.min((i + 0.5) / fps, Math.max(0, duration - 0.001)));
      ctx.drawImage(v, 0, 0, W, H);
      const ts = Math.round((i * 1000) / fps);
      const res = landmarker.detectForVideo(canvas, ts);
      const pose = G.chooseLeadingPose(res.landmarks || [], W, H, direction);
      rows.push(G.buildRow(i, fps, ts, W, H, pose));
      if (enc) { drawOverlay(ctx, pose, W, H, i, fps, direction); await enc.add(canvas, i); }
      if (i % 3 === 0) {
        const el = (performance.now() - t0) / 1000, rem = (el / (i + 1)) * (total - i - 1);
        progress(i + 1, total, `${i + 1} / ${total} フレーム ・ 残り約 ${Math.ceil(rem)} 秒`);
      }
    }
  } catch (e) { enc && enc.abort(); throw e; }
  finally { landmarker.close(); disposeVideo(v); }
  progress(total, total, "ファイルを作成中…");
  const stick = enc ? await enc.finish() : null;

  const cycleSide = G.chooseCycleSide(rows);
  let cycleData = null, events = [], warning = "";
  try { ({ cycleData, events } = G.normalizedCycles(rows, cycleSide, fps, W)); }
  catch (e) { warning = e.message; }
  if (makeStick && !enc) warning += (warning ? "\n" : "") + "この端末ではスティックピクチャー動画を作成できませんでした（iOS / iPadOS 16.4以降が必要）。";

  const base = rec.name.replace(/\.[^.]+$/, "") + "_gait_angles";
  const cols = G.exportColumns();
  const csv = new Blob(["﻿" + toCSV(cols, rows)], { type: "text/csv" });
  const xlsx = buildXlsx(cols, rows, cycleData, events, cycleSide);
  const png = await canvasBlob(drawGraph(rows, cycleData, events.length, fps));
  const detected = rows.filter((r) => r.left_knee_flexion_deg != null || r.right_knee_flexion_deg != null).length;
  return {
    id: uid(), videoId: rec.id, videoName: rec.name, base, created: Date.now(), direction, fps,
    frames: rows.length, width: W, height: H, detected, cycleSide, nCycles: events.length, events, warning,
    csv, xlsx, png, stick,
  };
}

const cell = (v) => (v == null || (typeof v === "number" && !Number.isFinite(v)) ? "" : String(v));
function toCSV(cols, rows) {
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}
function aoa(cols, objs) { return [cols, ...objs.map((o) => cols.map((c) => (o[c] == null || Number.isNaN(o[c]) ? null : o[c])))]; }
function buildXlsx(cols, rows, cycleData, events, cycleSide) {
  const X = window.XLSX, wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(aoa(cols, rows)), "フレーム別角度");
  const ccols = ["gait_cycle_percent", "left_knee_mean_deg", "left_hip_mean_deg", "right_knee_mean_deg", "right_hip_mean_deg"];
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(cycleData ? aoa(ccols, cycleData) : [ccols, ["歩行周期を検出できませんでした"]]), "正規化グラフ用");
  const ecols = ["side", "cycle", "start_contact_frame", "start_time_seconds", "next_contact_frame", "next_contact_time_seconds", "cycle_duration_seconds"];
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(aoa(ecols, events)), "推定接地");
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([["項目", "説明"], ...G.notesTable(cycleSide, events.length)]), "説明");
  const out = X.write(wb, { type: "array", bookType: "xlsx" });
  return new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
const canvasBlob = (c) => new Promise((r) => c.toBlob(r, "image/png"));

// グラフ（matplotlib版と同じ構成：上=膝、下=股関節）
function drawGraph(rows, cycleData, nCycles, fps) {
  const Wc = 1920, Hc = 1280, c = document.createElement("canvas"); c.width = Wc; c.height = Hc;
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, Wc, Hc);
  const font = (s, b = "") => `${b} ${s}px "Hiragino Sans", -apple-system, sans-serif`;
  const cyc = !!cycleData;
  let xs, xmax, xlabel;
  if (cyc) { xs = cycleData.map((r) => r.gait_cycle_percent); xmax = 100; xlabel = "歩行周期（同じ足の接地から次の接地 = 0〜100%）"; }
  else { xs = rows.map((r) => r.time_seconds); xmax = Math.max(1e-6, xs[xs.length - 1]); xlabel = "時間（秒）"; }
  g.fillStyle = "#000"; g.textAlign = "center"; g.textBaseline = "middle";
  g.font = font(34, "bold");
  g.fillText(cyc ? "歩行周期に対する2D角度推定 — 臨床測定ではありません" : "フレーム別2D角度推定（歩行周期は検出できませんでした）— 臨床測定ではありません", Wc / 2, 40);
  const panels = [
    { joint: "knee", title: cyc ? "歩行周期に対する膝の推定屈曲角度" : "膝の推定屈曲角度", name: "膝" },
    { joint: "hip", title: cyc ? "歩行周期に対する股関節の推定屈曲角度" : "股関節の推定屈曲角度", name: "股関節" },
  ];
  const L = 150, R = Wc - 60, top0 = 120, ph = 470, gap = 130;
  panels.forEach((p, k) => {
    const T = top0 + k * (ph + gap), B = T + ph;
    const series = ["left", "right"].map((s) => cyc ? cycleData.map((r) => r[`${s}_${p.joint}_mean_deg`]) : rows.map((r) => r[`${s}_${p.joint}_flexion_deg`]));
    const all = series.flat().filter((v) => v != null && Number.isFinite(v));
    let lo = all.length ? Math.min(...all) : 0, hi = all.length ? Math.max(...all) : 10;
    const padv = Math.max(2, (hi - lo) * 0.08); lo -= padv; hi += padv;
    const step = niceStep((hi - lo) / 6);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const X = (x) => L + ((R - L) * x) / xmax, Y = (y) => B - ((B - T) * (y - lo)) / (hi - lo);
    g.font = font(28); g.fillStyle = "#000"; g.textAlign = "center"; g.fillText(p.title, (L + R) / 2, T - 28);
    g.strokeStyle = "rgba(0,0,0,0.12)"; g.lineWidth = 1.5; g.font = font(22); g.fillStyle = "#333";
    for (let y = lo; y <= hi + 1e-9; y += step) { g.beginPath(); g.moveTo(L, Y(y)); g.lineTo(R, Y(y)); g.stroke(); g.textAlign = "right"; g.fillText(String(Math.round(y * 100) / 100), L - 12, Y(y)); }
    const xstep = cyc ? 10 : niceStep(xmax / 10);
    for (let x = 0; x <= xmax + 1e-9; x += xstep) { g.beginPath(); g.moveTo(X(x), T); g.lineTo(X(x), B); g.stroke(); if (k === 1 || !cyc) { g.textAlign = "center"; g.fillText(String(Math.round(x * 100) / 100), X(x), B + 24); } }
    g.strokeStyle = "#000"; g.lineWidth = 2; g.strokeRect(L, T, R - L, B - T);
    g.save(); g.translate(48, (T + B) / 2); g.rotate(-Math.PI / 2); g.textAlign = "center"; g.font = font(24); g.fillStyle = "#000"; g.fillText("角度（度）", 0, 0); g.restore();
    const colors = ["#1f77b4", "#ff7f0e"], names = ["左", "右"];
    series.forEach((ys, si) => {
      g.strokeStyle = colors[si]; g.lineWidth = 3; g.beginPath(); let pen = false;
      ys.forEach((y, i) => { if (y == null || !Number.isFinite(y)) { pen = false; return; } if (!pen) { g.moveTo(X(xs[i]), Y(y)); pen = true; } else g.lineTo(X(xs[i]), Y(y)); });
      g.stroke();
    });
    // 凡例
    const lw = 420, lx = R - lw - 16, ly = T + 16;
    g.fillStyle = "rgba(255,255,255,0.85)"; g.fillRect(lx, ly, lw, 86); g.strokeStyle = "#ccc"; g.lineWidth = 1; g.strokeRect(lx, ly, lw, 86);
    names.forEach((n, si) => {
      g.strokeStyle = colors[si]; g.lineWidth = 3; g.beginPath(); g.moveTo(lx + 16, ly + 24 + si * 38); g.lineTo(lx + 66, ly + 24 + si * 38); g.stroke();
      g.fillStyle = "#000"; g.textAlign = "left"; g.font = font(22);
      g.fillText(cyc ? `${n}${p.name}（${nCycles}周期平均）` : `${n}${p.name}`, lx + 78, ly + 24 + si * 38);
    });
  });
  g.textAlign = "center"; g.font = font(26); g.fillStyle = "#000";
  g.fillText(xlabel, (L + R) / 2, top0 + 2 * ph + gap + 70);
  return c;
}
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw || 1)), n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

// ---------- 結果 ----------
async function renderResults() {
  const list = (await dbAll("results")).sort((a, b) => b.created - a.created);
  const ul = $("#resultList");
  if (!list.length) { ul.innerHTML = `<li class="empty">解析結果はまだありません。</li>`; return; }
  ul.innerHTML = list.map((r) => `
    <li data-id="${r.id}">
      <div class="meta"><b>${esc(r.base)}</b>
        <span>${fmtDate(r.created)} ・ ${r.frames}フレーム ・ ${r.nCycles}周期${r.warning ? " ・ ⚠" : ""}</span></div>
      <div class="acts">
        <button class="btn small" data-act="open">表示</button>
        <button class="btn small sub" data-act="delete">削除</button>
      </div>
    </li>`).join("");
}
$("#resultList").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const id = b.closest("li").dataset.id;
  if (b.dataset.act === "open") openResult(id);
  if (b.dataset.act === "delete" && confirm("この解析結果を削除しますか？")) {
    await dbDel("results", id); $("#resultView").classList.add("hidden"); renderResults();
  }
});
let viewUrls = [];
async function openResult(id) {
  const r = await dbGet("results", id);
  viewUrls.forEach(URL.revokeObjectURL); viewUrls = [];
  const u = (b) => { const x = URL.createObjectURL(b); viewUrls.push(x); return x; };
  const files = resultFiles(r);
  const sideJ = r.cycleSide === "left" ? "左" : "右";
  $("#resultView").innerHTML = `
    <h2 style="margin-top:0">${esc(r.base)}</h2>
    ${r.warning ? `<p class="warn">${esc(r.warning).replace(/\n/g, "<br>")}</p>` : ""}
    <table class="sum">
      <tr><td>動画</td><td>${esc(r.videoName)}（${r.width}×${r.height}）</td></tr>
      <tr><td>フレーム数 / fps</td><td>${r.frames} / ${r.fps}</td></tr>
      <tr><td>人物検出フレーム</td><td>${r.detected}（${Math.round((100 * r.detected) / r.frames)}%）</td></tr>
      <tr><td>追跡対象</td><td>画面上の進行方向（${r.direction > 0 ? "右" : "左"}）に先行する人物</td></tr>
      <tr><td>周期</td><td>${sideJ}側の足・${r.nCycles}周期（接地検出は推定）</td></tr>
    </table>
    <img src="${u(r.png)}" alt="グラフ">
    ${r.stick ? `<h2>スティックピクチャー動画</h2><video src="${u(r.stick)}" controls playsinline></video>` : ""}
    <div class="row">
      <button class="btn" data-f="all">すべて保存/共有</button>
      ${files.map((f, i) => `<button class="btn sub small" data-f="${i}">${f.label}</button>`).join("")}
    </div>
    <p class="hint">「ファイルに保存」でファイルAppへ、動画は「ビデオを保存」で写真Appへ保存できます。</p>`;
  $("#resultView").classList.remove("hidden");
  $("#resultView").querySelectorAll("button[data-f]").forEach((b) => b.onclick = () => {
    const sel = b.dataset.f === "all" ? files : [files[Number(b.dataset.f)]];
    saveFiles(sel.map((f) => f.file));
  });
  $("#resultView").scrollIntoView({ behavior: "smooth" });
}
function resultFiles(r) {
  const f = [
    { label: "CSV", file: new File([r.csv], `${r.base}.csv`, { type: "text/csv" }) },
    { label: "Excel", file: new File([r.xlsx], `${r.base}.xlsx`, { type: r.xlsx.type }) },
    { label: "グラフ", file: new File([r.png], `${r.base}_graph.png`, { type: "image/png" }) },
  ];
  if (r.stick) f.push({ label: "スティック動画", file: new File([r.stick], `${r.base}_stick_figure.mp4`, { type: "video/mp4" }) });
  return f;
}

// ---------- 起動 ----------
function updBadge() { $("#netBadge").textContent = !modelBytes ? "モデル未設定" : navigator.onLine ? "オフライン対応" : "オフラインで動作中"; }
(async () => {
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("sw.js"); } catch {}
  }
  try { await navigator.storage?.persist?.(); } catch {}
  const m = await getModel();
  window.addEventListener("online", updBadge); window.addEventListener("offline", updBadge); updBadge();
  if (!m) toast("最初に「設定」タブで姿勢推定モデルを取り込んでください", 5000);
})();
