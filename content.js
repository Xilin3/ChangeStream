let replaced = false;
let newVideo = null;
let flvPlayer = null;
let delaySeconds = 0;
let delayTimer = null;
let currentRoomId = null;
let currentQuality = 'bluray';
let currentCodec = null;
let currentHlsUrl = null;
let showOriginal = false;
let originalVideoEl = null;     // 缓存的原始 video 元素
let replacementHost = null;     // 没有 video 时挂载新画面的播放器容器
let tearingDown = false;   // 换流拆卸期间为 true，屏蔽 stale onerror
let miniWindowPlayer = null;    // 原直播间小窗口的 flv.js 播放器
let miniWindowVideo = null;     // 原直播间小窗口的 video 元素

// 把播放状态写入 storage，popup 通过 storage.onChanged 实时显示。
// state: 'buffering' | 'playing' | 'error' | 'idle'
function reportStatus(state, text, progress) {
  try { chrome.storage.local.set({ playbackStatus: { state, text, progress: progress || null, ts: Date.now() } }); } catch (e) {}
}

function getPlayInfoUrl(roomId) {
  // qn=30000 请求最高画质（4K/杜比），确保 API 返回所有可用清晰度
  return `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${roomId}&no_playurl=0&mask=1&qn=30000&platform=web&protocol=0,1&format=0,1,2&codec=0,1,2&dolby=5&panorama=1`;
}

function getQualityKey(codec) {
  const baseUrl = (codec?.base_url || '').toLowerCase();
  const codecName = (codec?.codec_name || '').toLowerCase();
  if (baseUrl.includes('prohdr') || baseUrl.includes('hdr')) return 'prohdr';
  if (baseUrl.includes('proav1') || baseUrl.includes('miniav1') || codecName.includes('av1')) return 'proav1';
  if (baseUrl.includes('prohevc') || baseUrl.includes('minihevc') || codecName.includes('hevc') || codecName.includes('h265')) return 'prohevc';
  return 'bluray';
}

function getQnName(qn) {
  const map = { 30000: '杜比', 20000: '4K', 15000: '2K', 10000: '原画', 400: '蓝光', 250: '超清', 150: '高清', 80: '流畅' };
  return map[qn] || '';
}

function getQualityName(codec, key = getQualityKey(codec)) {
  const qnName = getQnName(codec?.current_qn);
  if (key === 'prohevc') return qnName ? `HEVC${qnName}` : 'HEVC原画';
  if (key === 'prohdr') return qnName ? `HDR${qnName}` : 'HDR原画';
  if (key === 'proav1') return qnName ? `AV1${qnName}` : 'AV1原画';
  return qnName || '蓝光';
}

function collectStreamCandidates(streams) {
  const candidates = [];
  for (const stream of (streams || [])) {
    for (const format of (stream.format || [])) {
      for (const codec of (format.codec || [])) {
        if (!codec.url_info?.length) continue;
        const key = getQualityKey(codec);
        const info = codec.url_info[0];
        candidates.push({
          proto: stream.protocol_name,
          format: format.format_name,
          codec: codec.codec_name,
          base_url: codec.base_url,
          current_qn: codec.current_qn,
          key,
          qualityName: getQualityName(codec, key),
          url: info.host + codec.base_url + info.extra,
        });
      }
    }
  }
  return candidates;
}

function streamRank(candidate) {
  if (candidate.proto === 'http_hls' && candidate.format === 'fmp4') return 0;
  if (candidate.proto === 'http_stream' && candidate.format === 'flv') return 1;
  return 99;
}

function pickStreamCandidate(candidates, quality) {
  const target = quality || 'bluray';
  return candidates
    .filter(c => c.key === target && streamRank(c) < 99)
    .sort((a, b) => {
      // 1) 优先 proto/format（HLS fmp4 > FLV）
      const rankDiff = streamRank(a) - streamRank(b);
      if (rankDiff !== 0) return rankDiff;
      // 2) 同协议下优先高 qn（4K > 原画 > 蓝光）
      return (b.current_qn || 0) - (a.current_qn || 0);
    })[0] || null;
}

async function fetchStreamUrl(roomId, quality = 'bluray') {
  try {
    const resp = await fetch(getPlayInfoUrl(roomId), { credentials: 'include' });
    const data = await resp.json();
    if (data.code !== 0) return { error: `code=${data.code}, msg=${data.message}` };

    const streams = data.data?.playurl_info?.playurl?.stream;
    if (!streams?.length) return { error: '无stream数据' };

    const candidates = collectStreamCandidates(streams);
    const allStreams = candidates.map(c => ({ proto: c.proto, format: c.format, codec: c.codec, base_url: c.base_url, qn: c.current_qn, key: c.key }));
    const picked = pickStreamCandidate(candidates, quality);

    if (!picked) return { error: `未找到${quality}画质`, allStreams };
    return { url: picked.url, qualityName: picked.qualityName, codec: picked.codec, isHls: picked.proto === 'http_hls', allStreams };
  } catch (e) {
    return { error: e.message };
  }
}

async function getAvailableQualities(roomId) {
  try {
    const resp = await fetch(getPlayInfoUrl(roomId), { credentials: 'include' });
    const data = await resp.json();
    if (data.code !== 0) return [];

    const streams = data.data?.playurl_info?.playurl?.stream;
    if (!streams?.length) return [];

    const map = new Map();
    const candidates = collectStreamCandidates(streams)
      .filter(c => streamRank(c) < 99)
      .sort((a, b) => {
        const rankDiff = streamRank(a) - streamRank(b);
        if (rankDiff !== 0) return rankDiff;
        return (b.current_qn || 0) - (a.current_qn || 0);
      });
    for (const c of candidates) {
      if (!map.has(c.key)) map.set(c.key, { key: c.key, name: c.qualityName });
    }

    const order = ['bluray', 'prohevc', 'prohdr', 'proav1'];
    return order.filter(key => map.has(key)).map(key => map.get(key));
  } catch (e) {
    return [];
  }
}

const PLAYER_CONTAINER_SELECTORS = [
  '#player-ctnr',
  '#live-player',
  '#live-player-ctnr',
  '#bilibili-live-player',
  '#live-player-app',
  '.player-ctnr',
  '.live-player-ctnr',
  '.bilibili-live-player',
  '.bpx-player-container',
  '.bpx-player-video-wrap',
  '.web-player',
  '.live-non-revenue-player',
  '.live-player-bg',
  '.player',
  '[class*="player-ctnr"]',
  '[class*="live-player"]',
];
const PLAYER_CONTAINER_SELECTOR = PLAYER_CONTAINER_SELECTORS.join(',');
const WEAK_PLAYER_SELECTOR = '[class*="player"]';

// 在 iframe 内部的文档中创建新 video 并替换原始 video
// 不隐藏 iframe 本身，这样弹幕/控制栏等 UI 保留在原位
function findPlayerIframe(host) {
  var iframe = host.querySelector('iframe[src*="blanc"]') || host.querySelector('iframe[src*="lite"]');
  if (!iframe) {
    var iframes = Array.from(host.querySelectorAll('iframe')).filter(function(f) {
      var r = f.getBoundingClientRect(); return r.width > 10 && r.height > 10;
    });
    iframe = iframes[0];
  }
  return iframe || null;
}

function createVideoInIframe(iframe) {
  var doc;
  try { doc = iframe.contentDocument || iframe.contentWindow.document; } catch (e) { return null; }
  if (!doc) return null;
  var video = doc.createElement('video');
  video.id = 'changestream-video';
  video.autoplay = true;
  video.muted = true;
  video.controls = false;
  video.removeAttribute('controls');
  return video;
}

function replaceVideoInsideIframe(iframe, newVideo) {
  var doc;
  try { doc = iframe.contentDocument || iframe.contentWindow.document; } catch (e) { return false; }
  if (!doc || !doc.body) return false;
  var origVideo = doc.querySelector('video');
  if (!origVideo || origVideo.id === 'changestream-video') return false;
  var parent = origVideo.parentElement;
  if (!parent) return false;
  var origStyle = getComputedStyle(origVideo);
  newVideo.style.cssText =
    'position:absolute;' +
    'top:0;' +
    'left:0;' +
    'width:100%;' +
    'height:100%;' +
    'z-index:1;' +
    'background:#000;' +
    'object-fit:contain;' +
    'transform:translateZ(0);';
  // 确保父容器能作为绝对定位的参考
  var _csParent2 = origVideo.parentElement;
  if (_csParent2 && getComputedStyle(_csParent2).position === 'static') _csParent2.style.position = 'relative';
  _csParent2.insertBefore(newVideo, origVideo);
  origVideo.style.display = 'none';
  origVideo._csReplacedBy = newVideo;
  newVideo._csReplacedOriginal = origVideo;
  newVideo._csInsideIframe = iframe;
  return true;
}

function restoreVideoInsideIframe(newVideo) {
  if (!newVideo || !newVideo._csReplacedOriginal) return;
  var orig = newVideo._csReplacedOriginal;
  orig.style.display = '';
  orig._csReplacedBy = null;
  newVideo._csReplacedOriginal = null;
  newVideo._csInsideIframe = null;
}

// 直接在原始 video 的位置插入替换视频（保持相同 z-index，不会被弹幕/礼物层覆盖）
function replaceVideoInPlace(originalVideo, newVideo) {
  if (!originalVideo || !newVideo) return false;
  var parent = originalVideo.parentElement;
  if (!parent) return false;
  var origStyle = getComputedStyle(originalVideo);
  // 使用百分比尺寸跟随父容器，全屏/窗口变化时自动适应
  newVideo.style.cssText =
    'position:absolute;' +
    'top:0;' +
    'left:0;' +
    'width:100%;' +
    'height:100%;' +
    'z-index:1;' +
    'background:#000;' +
    'object-fit:contain;' +
    'transform:translateZ(0);';
  // 确保父容器能作为绝对定位的参考
  var _csParent = originalVideo.parentElement;
  if (_csParent && getComputedStyle(_csParent).position === 'static') _csParent.style.position = 'relative';
  parent.insertBefore(newVideo, originalVideo);
  originalVideo._csReplacedBy = newVideo;
  newVideo._csReplacedOriginal = originalVideo;
  return true;
}
function restoreVideoFromPlace(originalVideo) {
  if (!originalVideo || !originalVideo._csReplacedBy) return;
  var nv = originalVideo._csReplacedBy;
  nv._csReplacedOriginal = null;
  originalVideo._csReplacedBy = null;
}

function getVisibleRect(el) {
  if (!el || !(el instanceof HTMLElement)) return null;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null;
  const rect = el.getBoundingClientRect();
  const viewWidth = window.innerWidth || document.documentElement.clientWidth || 1920;
  const viewHeight = window.innerHeight || document.documentElement.clientHeight || 1080;
  const width = Math.max(0, Math.min(rect.right, viewWidth) - Math.max(rect.left, 0));
  const height = Math.max(0, Math.min(rect.bottom, viewHeight) - Math.max(rect.top, 0));
  if (width < 80 || height < 45) return null;
  return { rect, width, height, area: width * height };
}

function scorePlayerLikeElement(el) {
  const visible = getVisibleRect(el);
  if (!visible) return -1;
  let score = visible.area;
  if (el.matches?.('#player-ctnr, #live-player, #live-player-ctnr, #bilibili-live-player, #live-player-app')) score += 1e9;
  else if (el.matches?.('.player-ctnr, .live-player-ctnr, .bilibili-live-player, .bpx-player-container, .bpx-player-video-wrap, .web-player')) score += 5e8;
  else if (el.matches?.('[class*="player-ctnr"], [class*="live-player"]')) score += 2e8;
  return score;
}

function rememberReplacementHost(host) {
  if (!host || !(host instanceof HTMLElement)) return;
  replacementHost = host;
}

function findOriginalVideo() {
  const videos = Array.from(document.querySelectorAll('video'))
    .filter(v => v !== newVideo && v.id !== 'changestream-video' && !v.closest('#changestream-original'));

  let best = null;
  let bestScore = -1;
  for (const video of videos) {
    const visible = getVisibleRect(video);
    if (!visible) continue;
    let score = visible.area;
    if (video.closest('#player-ctnr, #live-player, #live-player-ctnr, #bilibili-live-player, #live-player-app')) score += 1e9;
    else if (video.closest('.player-ctnr, .live-player-ctnr, .bilibili-live-player, .bpx-player-container, .bpx-player-video-wrap, .web-player')) score += 5e8;
    else if (video.closest('[class*="player-ctnr"], [class*="live-player"]')) score += 2e8;
    else if (video.closest(WEAK_PLAYER_SELECTOR)) score += 1e6;
    if (score > bestScore) { best = video; bestScore = score; }
  }
  return best;
}

function findPlayerContainer() {
  const set = new Set();
  document.querySelectorAll(PLAYER_CONTAINER_SELECTOR).forEach(el => set.add(el));
  document.querySelectorAll(WEAK_PLAYER_SELECTOR).forEach(el => set.add(el));

  let best = null;
  let bestScore = -1;
  for (const el of set) {
    if (el === newVideo || !(el instanceof HTMLElement) || el.closest('#changestream-original')) continue;
    const score = scorePlayerLikeElement(el);
    if (score > bestScore) { best = el; bestScore = score; }
  }
  return best;
}

function ensureReplacementHost() {
  const video = originalVideoEl || findOriginalVideo();
  if (video?.parentElement) {
    originalVideoEl = video;
    const playerHost = video.closest(PLAYER_CONTAINER_SELECTOR) || video.parentElement;
    rememberReplacementHost(playerHost);
    return { host: playerHost, originalVideo: video, hasIframe: false };
  }

  const container = findPlayerContainer();
  if (!container) return null;

  rememberReplacementHost(container);
  return { host: container, originalVideo: null, hasIframe: !!container.querySelector('iframe') };
}

function waitForReplacementHost(timeout = 5000) {
  const found = ensureReplacementHost();
  if (found) return Promise.resolve(found);

  return new Promise(resolve => {
    const start = Date.now();
    const timer = setInterval(() => {
      const mount = ensureReplacementHost();
      if (mount || Date.now() - start >= timeout) {
        clearInterval(timer);
        resolve(mount);
      }
    }, 200);
  });
}

function hideOriginalWindow() {
  // 清理迷你窗口的独立播放器
  if (miniWindowPlayer) {
    try { miniWindowPlayer.pause(); miniWindowPlayer.unload(); miniWindowPlayer.detachMediaElement(); miniWindowPlayer.destroy(); } catch (e) {}
    miniWindowPlayer = null;
  }
  if (miniWindowVideo) {
    try { miniWindowVideo.pause(); miniWindowVideo.removeAttribute('src'); miniWindowVideo.load(); } catch (e) {}
    miniWindowVideo = null;
  }
  const wrapper = document.getElementById('changestream-original');
  if (wrapper) wrapper.remove();
  showOriginal = false;
}

async function createOriginalWindow() {
  if (document.getElementById('changestream-original')) return;

  // 从当前页面 URL 提取原房间 ID
  const m = location.href.match(/live\.bilibili\.com\/(\d+)/);
  if (!m) return;

  // 获取播放器容器位置，用于定位迷你窗口
  const host = replacementHost || findPlayerContainer();
  if (!host) return;
  const rect = host.getBoundingClientRect();

  const wrapper = document.createElement('div');
  wrapper.id = 'changestream-original';
  wrapper.style.cssText = `position:fixed;top:${rect.top}px;left:${rect.right + 10}px;width:480px;height:300px;background:#000;border:2px solid #00a1d6;border-radius:8px;overflow:hidden;z-index:999999;box-shadow:0 4px 12px rgba(0,0,0,0.5);resize:both;min-width:320px;min-height:200px;`;

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:#00a1d6;color:white;font-size:12px;cursor:move;user-select:none;';
  header.innerHTML = '<span>原直播间</span><button id="changestream-original-close" style="background:none;border:none;color:white;cursor:pointer;font-size:14px;">✕</button>';

  const vc = document.createElement('div');
  vc.style.cssText = 'width:100%;height:calc(100% - 24px);position:relative;';
  wrapper.appendChild(header);
  wrapper.appendChild(vc);
  document.body.appendChild(wrapper);

  // 拖拽
  let drag = false, ox, oy;
  header.addEventListener('mousedown', e => { if (e.target.id === 'changestream-original-close') return; drag = true; ox = e.clientX - wrapper.offsetLeft; oy = e.clientY - wrapper.offsetTop; });
  document.addEventListener('mousemove', e => { if (!drag) return; wrapper.style.left = (e.clientX - ox) + 'px'; wrapper.style.top = (e.clientY - oy) + 'px'; });
  document.addEventListener('mouseup', () => drag = false);
  document.getElementById('changestream-original-close').addEventListener('click', () => hideOriginalWindow());

  // 独立拉取原房间直播流（不依赖原始 video 元素，避免触发 B 站 DOM 监听）
  const result = await fetchStreamUrl(m[1], 'bluray');
  if (!result || result.error) {
    vc.style.cssText = 'width:100%;height:calc(100% - 24px);display:flex;align-items:center;justify-content:center;color:#999;font-size:14px;';
    vc.textContent = '无法获取原直播间流';
    return;
  }

  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = true;
  video.controls = false;
  video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;';
  vc.appendChild(video);

  if (result.isHls) {
    video.src = result.url;
    video.play().catch(() => {});
  } else if (window.flvjs?.isSupported()) {
    miniWindowPlayer = flvjs.createPlayer({ type: 'flv', url: result.url, isLive: true }, { enableWorker: true, enableStashBuffer: true, lazyLoad: false, deferLoadAfterSourceOpen: false, autoCleanupSourceBuffer: true });
    miniWindowPlayer.attachMediaElement(video);
    miniWindowPlayer.load();
    miniWindowPlayer.play();
  }
  miniWindowVideo = video;
}

function getLiveEdge() {
  if (!newVideo) return 0;
  try {
    if (newVideo.seekable && newVideo.seekable.length > 0) {
      return newVideo.seekable.end(newVideo.seekable.length - 1);
    }
    if (newVideo.buffered && newVideo.buffered.length > 0) {
      return newVideo.buffered.end(newVideo.buffered.length - 1);
    }
  } catch (e) {}
  return 0;
}

function forcePlay() {
  if (!newVideo || !newVideo.paused) return;
  newVideo.play().catch(() => {
    newVideo.muted = true;
    newVideo.play().then(() => setTimeout(() => { newVideo.muted = false; }, 300)).catch(() => {});
  });
}

function startDelayControl() {
  if (delayTimer) { clearInterval(delayTimer); delayTimer = null; }
  if (!newVideo) return;

  if (delaySeconds <= 0) {
    // 关闭 MSE，恢复直接播放。只有当 MSE 之前接管过 src（objectUrl）时才需要
    // 重设回 HLS 地址；否则 src 已是 HLS 直链，重设会触发 loadeddata 重载循环（闪烁）。
    const mseWasActive = !!window._mseDelay;
    if (window._mseDelay) { window._mseDelay.stop(); window._mseDelay = null; }
    if (mseWasActive && currentHlsUrl) { newVideo.src = currentHlsUrl; }
    newVideo.playbackRate = 1;
    forcePlay();
    reportStatus('playing', '播放中（0s 延迟）');
    return;
  }

  if (!currentHlsUrl) {
    console.log('[ChangeStream] 没有HLS URL，无法使用MSE延迟');
    reportStatus('error', '该画质无 HLS 流，无法延迟');
    return;
  }

  // 控制器已在运行：只调整目标延迟，不重建缓冲
  if (window._mseDelay && window._mseDelay.isRunning()) {
    window._mseDelay.setDelay(delaySeconds);
    return;
  }

  // 首次启动 MSE 延迟控制
  console.log('[ChangeStream] MSE启动, currentHlsUrl:', currentHlsUrl);
  if (window._mseDelay) window._mseDelay.stop();
  window._mseDelay = new MSEDelayController();
  window._mseDelay.onStatus = reportStatus;
  window._mseDelay.start(newVideo, currentHlsUrl, delaySeconds);
}

function setDelay(seconds) {
  delaySeconds = seconds;
  console.log(`[ChangeStream] setDelay(${seconds}) called, current video state: paused=${newVideo?.paused} seeking=${newVideo?.seeking} currentTime=${newVideo?.currentTime} seekable=${newVideo?.seekable?.length}`);
  startDelayControl();
}

function cleanupPlayer() {
  if (delayTimer) { clearInterval(delayTimer); delayTimer = null; }
  if (window._mseDelay) { window._mseDelay.stop(); window._mseDelay = null; }
  if (flvPlayer) { try { flvPlayer.pause(); flvPlayer.unload(); flvPlayer.detachMediaElement(); flvPlayer.destroy(); } catch (e) {} flvPlayer = null; }
  if (newVideo) {
    // 恢复 iframe 内部替换 / 原始 video 替换，然后再销毁 newVideo
    if (newVideo._csInsideIframe) restoreVideoInsideIframe(newVideo);
    if (newVideo._csReplacedOriginal) restoreVideoFromPlace(newVideo._csReplacedOriginal);
    try { newVideo.pause(); newVideo.removeAttribute('src'); newVideo.load(); newVideo.remove(); } catch (e) {}
    newVideo = null;
  }
  hideOriginalWindow();
  originalVideoEl = null;
  replacementHost = null;
}

async function startStream(roomId, quality) {
  const result = await fetchStreamUrl(roomId, quality);
  if (!result || result.error) return { success: false, error: result?.error || '获取流地址失败', allStreams: result?.allStreams };

  if (flvPlayer) { try { flvPlayer.pause(); flvPlayer.unload(); flvPlayer.detachMediaElement(); flvPlayer.destroy(); } catch (e) {} flvPlayer = null; }

  // 停掉正在运行的 MSE 控制器，否则其轮询会继续向已分离的 SourceBuffer 灌数据
  if (window._mseDelay) { window._mseDelay.stop(); window._mseDelay = null; }

  // 彻底清除旧 src（MSE 的 objectUrl 或上个 HLS 流），再设置新源。
  // 拆卸期间会触发一条 stale 的 onerror，用标记屏蔽，避免覆盖新流状态。
  tearingDown = true;
  newVideo.removeAttribute('src');
  newVideo.load();
  await new Promise(r => setTimeout(r, 100));
  tearingDown = false;

  if (result.isHls) {
    currentHlsUrl = result.url;
    console.log('[ChangeStream] HLS URL:', currentHlsUrl);
    newVideo.src = result.url;
    newVideo.play().catch(() => {});
  } else {
    if (!window.flvjs?.isSupported()) return { success: false, error: 'flvjs不可用', allStreams: result.allStreams };
    flvPlayer = flvjs.createPlayer({ type: 'flv', url: result.url, isLive: true }, { enableWorker: true, enableStashBuffer: true, lazyLoad: false, deferLoadAfterSourceOpen: false, autoCleanupSourceBuffer: true });
    flvPlayer.on(flvjs.Events.ERROR, (t, d) => console.error('[ChangeStream] flvjs错误:', t, d));
    flvPlayer.attachMediaElement(newVideo);
    flvPlayer.load();
    flvPlayer.play();
  }

  newVideo.onerror = () => {
    if (tearingDown) return;   // 换流拆卸触发的假错误，忽略
    const err = newVideo.error;
    const msg = err ? `视频错误 code=${err.code} msg=${err.message}` : '视频加载失败';
    console.error('[ChangeStream]', msg);
    window._csLastError = msg;
    reportStatus('error', msg);
  };
  // 视频实际恢复播放时同步状态（含浏览器/MSE 自动重试成功后）。
  // MSE 控制器运行时（含积累延迟期），状态由其 tick() 独占上报，原生事件让位，
  // 否则积累期实时画面在播放会触发 onplaying，把"缓冲中"覆盖成"播放中"。
  newVideo.onplaying = () => {
    window._csLastError = null;
    if (window._mseDelay && window._mseDelay.isRunning()) return;
    if (delaySeconds > 0) reportStatus('playing', `延迟 ${delaySeconds}s 播放中`);
    else reportStatus('playing', '播放中（0s 延迟）');
  };
  newVideo.onwaiting = () => {
    if (tearingDown) return;
    if (window._mseDelay && window._mseDelay.isRunning()) return;
    reportStatus('buffering', '缓冲中…');
  };
  newVideo.onloadeddata = () => {
    newVideo.muted = false;
    window._csLastError = null;
    const wait = setInterval(() => { if (newVideo.seekable?.length > 0 || newVideo.buffered?.length > 0) { clearInterval(wait); startDelayControl(); } }, 200);
    setTimeout(() => { clearInterval(wait); startDelayControl(); }, 5000);
  };
  newVideo.oncanplay = () => newVideo.play().catch(() => {});

  // 等待确认视频能否正常加载
  const loaded = await Promise.race([
    new Promise(r => newVideo.addEventListener('loadeddata', () => r(true), { once: true })),
    new Promise(r => newVideo.addEventListener('error', () => r(false), { once: true })),
    new Promise(r => setTimeout(() => r(null), 5000)),
  ]);

  if (loaded === false) {
    return { success: false, error: window._csLastError || '视频加载失败，可能不支持此编码', allStreams: result.allStreams };
  }

  currentCodec = result.codec;
  return { success: true, qualityName: result.qualityName, codec: result.codec, allStreams: result.allStreams };
}

async function replaceStream(targetRoomId, quality = 'bluray', showOrig = false) {
  const mount = await waitForReplacementHost();
  if (!mount) return { success: false, error: '未找到播放器容器' };

  const { host, originalVideo } = mount;
  console.log('[ChangeStream] 播放器容器:', host.id || '(no id)', (host.className || '').slice(0, 60), Math.round(host.getBoundingClientRect().width) + 'x' + Math.round(host.getBoundingClientRect().height), '原视频:', !!originalVideo, 'hasIframe:', mount.hasIframe);
  // 三步策略，从最优到兜底：
  // 1) 有 iframe 播放器 → 进入 iframe 内部替换 video，保留 iframe（弹幕/控制栏在其中）
  // 2) 有原始 <video> → 在 DOM 里直接替换它的位置，保持相同 z-index
  // 3) 都没有 → 追加到容器，用 absolute 定位（兜底）
  if (mount.hasIframe) {
    var playerIframe = findPlayerIframe(host);
    if (!playerIframe) return { success: false, error: '未找到播放器iframe' };
    var iframeVideo = createVideoInIframe(playerIframe);
    if (!iframeVideo) return { success: false, error: '无法访问iframe内部文档' };
    if (!replaceVideoInsideIframe(playerIframe, iframeVideo)) return { success: false, error: 'iframe内未找到视频元素' };
    // 旧 newVideo（顶层文档的）如果存在则丢弃
    if (newVideo && newVideo !== iframeVideo) {
      try { newVideo.pause(); newVideo.remove(); } catch (e) {}
    }
    newVideo = iframeVideo;
    if (originalVideo) originalVideo.style.display = 'none';
  } else if (originalVideo) {
    if (!newVideo) {
      newVideo = document.createElement('video');
      newVideo.id = 'changestream-video';
      newVideo.autoplay = true; newVideo.muted = true; newVideo.controls = false;
      newVideo.removeAttribute('controls');
    }
    replaceVideoInPlace(originalVideo, newVideo);
    originalVideo.style.display = 'none';
  } else {
    if (!newVideo) {
      newVideo = document.createElement('video');
      newVideo.id = 'changestream-video';
      newVideo.autoplay = true; newVideo.muted = true; newVideo.controls = false;
      newVideo.removeAttribute('controls');
    }
    if (newVideo.parentElement !== host) host.appendChild(newVideo);
    // 使用百分比尺寸跟随父容器，全屏时自动适应
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    newVideo.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:1;background:#000;object-fit:contain;transform:translateZ(0);';
  }

  // 应用存储的音量设置
  chrome.storage.local.get(['volume'], (data) => {
    if (data.volume !== undefined) newVideo.volume = data.volume / 100;
  });

  showOriginal = showOrig;
  if (showOriginal) {
    // 独立拉流显示原直播间，不依赖原始 video 元素，避免触发 B 站 DOM 监听
    setTimeout(() => createOriginalWindow(), 500);
  } else {
    hideOriginalWindow();
  }

  const fallback = { 'proav1': 'prohevc', 'prohdr': 'prohevc', 'prohevc': 'bluray' };
  let q = quality;
  let result;
  while (q) {
    result = await startStream(targetRoomId, q);
    if (result.success) break;
    const next = fallback[q];
    if (!next) break;
    console.log(`[ChangeStream] ${q}失败(${result.error})，降级到${next}`);
    q = next;
  }
  if (result.success) {
    replaced = true; currentRoomId = targetRoomId; currentQuality = q;
    result._debug = {
      hostId: host.id || '(none)',
      hostCls: (host.className || '').slice(0, 60),
      hostSize: Math.round(host.getBoundingClientRect().width) + 'x' + Math.round(host.getBoundingClientRect().height),
      hasVideo: !!originalVideo,
      iframeReplaced: !!mount.hasIframe,
    };
    return result;
  }
  cleanupPlayer();
  if (originalVideo) originalVideo.style.display = '';
  return { success: false, error: result.error };
}

function restoreStream() {
  cleanupPlayer();
  const v = findOriginalVideo(); if (v) v.style.display = '';
  replaced = false; currentRoomId = null; currentCodec = null; currentHlsUrl = null; delaySeconds = 0; showOriginal = false;
  reportStatus('idle', '');
  return { success: true };
}

async function changeQuality(quality) {
  if (!replaced || !currentRoomId) return { success: false, error: '未在替换状态' };
  const fallback = { 'proav1': 'prohevc', 'prohevc': 'bluray' };
  let q = quality;
  while (q) {
    currentQuality = q;
    const result = await startStream(currentRoomId, q);
    if (result.success) return result;
    const next = fallback[q];
    if (!next) return result;  // 最低画质也失败，返回错误
    console.log(`[ChangeStream] ${q}失败(${result.error})，降级到${next}`);
    q = next;
  }
}

function dumpDebugInfo() {
  var r = {};
  r.url = location.href;
  r.vp = (window.innerWidth || 0) + 'x' + (window.innerHeight || 0);
  r.videoCount = document.querySelectorAll('video').length;
  var pctnr = document.querySelector('#player-ctnr');
  if (pctnr) { var b = pctnr.getBoundingClientRect(); r.pctnr = { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y) }; }
  var lp = document.querySelector('#live-player');
  if (lp) { var b = lp.getBoundingClientRect(); r.livePlayer = { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y) }; }
  var lnrp = document.querySelector('.live-non-revenue-player');
  if (lnrp) { var b = lnrp.getBoundingClientRect(); r.lnrp = { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y) }; }
  var cs = document.querySelector('#changestream-video');
  if (cs) { var b = cs.getBoundingClientRect(); var csStyle = getComputedStyle(cs); r.csVideo = { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y), zIndex: csStyle.zIndex, position: csStyle.position, css: cs.style.cssText.slice(0, 300) }; }
  r.iframes = Array.from(document.querySelectorAll('iframe')).map(function(f) { var b = f.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y), src: (f.src || '').slice(0, 120) }; });
  r.videos = Array.from(document.querySelectorAll('video')).map(function(v) { var b = v.getBoundingClientRect(); return { id: v.id || '', w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y) }; });
  console.log('[ChangeStream] Debug:', JSON.stringify(r));
  return r;
}

// 出错后重试：保持房间/画质/延迟不变，重新拉流重建播放器
async function refreshStream() {
  if (!replaced || !currentRoomId) return { success: false, error: '未在替换状态' };
  console.log('[ChangeStream] 手动刷新重试');
  reportStatus('buffering', '重新加载中…');
  const result = await startStream(currentRoomId, currentQuality);
  if (!result.success) reportStatus('error', result.error || '刷新失败');
  return result;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'replace') replaceStream(msg.roomId, msg.quality, msg.showOriginal).then(r => sendResponse(r));
  else if (msg.action === 'restore') sendResponse(restoreStream());
  else if (msg.action === 'setDelay') { setDelay(msg.delay); sendResponse({ success: true }); }
  else if (msg.action === 'changeQuality') changeQuality(msg.quality).then(r => sendResponse(r));
  else if (msg.action === 'refresh') refreshStream().then(r => sendResponse(r));
  else if (msg.action === 'getAvailableQualities') getAvailableQualities(msg.roomId).then(r => sendResponse({ qualities: r }));
  else if (msg.action === 'dumpDebug') { sendResponse(dumpDebugInfo()); }
  else if (msg.action === 'setShowOriginal') {
    if (msg.show) {
      createOriginalWindow().then(() => { showOriginal = true; sendResponse({ success: true, showOriginal }); }).catch(() => sendResponse({ success: false }));
      return true; // 保持消息通道以等待异步结果
    }
    else { hideOriginalWindow(); sendResponse({ success: true, showOriginal }); }
  }
  else if (msg.action === 'setVolume') {
    if (newVideo) newVideo.volume = msg.volume;
    sendResponse({ success: true });
  }
  return true;
});

chrome.storage.local.get(['targetRoomId', 'isActive', 'delay', 'quality', 'showOriginal', 'volume'], (data) => {
  if (data.delay) delaySeconds = data.delay;
  if (data.quality) currentQuality = data.quality;
  if (data.showOriginal) showOriginal = data.showOriginal;
  if (data.volume !== undefined && newVideo) newVideo.volume = data.volume;
  if (data.isActive && data.targetRoomId) setTimeout(() => replaceStream(data.targetRoomId, currentQuality, showOriginal), 2000);
});
