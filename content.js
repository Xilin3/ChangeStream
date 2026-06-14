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
let originalPlaceholder = null; // 原始 video 移入小窗口后留在原位的占位节点
let tearingDown = false;   // 换流拆卸期间为 true，屏蔽 stale onerror

// 把播放状态写入 storage，popup 通过 storage.onChanged 实时显示。
// state: 'buffering' | 'playing' | 'error' | 'idle'
function reportStatus(state, text, progress) {
  try { chrome.storage.local.set({ playbackStatus: { state, text, progress: progress || null, ts: Date.now() } }); } catch (e) {}
}

async function fetchStreamUrl(roomId, quality = 'bluray') {
  try {
    const url = `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${roomId}&no_playurl=0&mask=1&qn=10000&platform=web&protocol=0,1&format=0,1,2&codec=0,1,2&dolby=5&panorama=1`;
    const resp = await fetch(url, { credentials: 'include' });
    const data = await resp.json();
    if (data.code !== 0) return { error: `code=${data.code}, msg=${data.message}` };

    const streams = data.data?.playurl_info?.playurl?.stream;
    if (!streams?.length) return { error: '无stream数据' };

    // 收集所有流信息用于调试
    const allStreams = [];
    for (const s of streams) {
      for (const f of (s.format || [])) {
        for (const c of (f.codec || [])) {
          if (c.url_info?.length > 0) {
            allStreams.push({ proto: s.protocol_name, format: f.format_name, codec: c.codec_name, base_url: c.base_url });
          }
        }
      }
    }

    const suffixMap = { 'bluray': 'bluray', 'prohevc': 'prohevc', 'prohdr': 'prohdr', 'proav1': 'proav1' };
    const target = suffixMap[quality] || 'bluray';

    // 优先HLS fmp4流
    for (const stream of streams) {
      if (stream.protocol_name !== 'http_hls') continue;
      for (const format of (stream.format || [])) {
        if (format.format_name !== 'fmp4') continue;
        for (const codec of (format.codec || [])) {
          if (codec.url_info?.length > 0 && codec.base_url.includes(target)) {
            return { url: codec.url_info[0].host + codec.base_url + codec.url_info[0].extra, qualityName: getQualityName(codec.base_url), codec: codec.codec_name, isHls: true, allStreams };
          }
        }
      }
    }

    // 其次FLV流
    for (const stream of streams) {
      if (stream.protocol_name !== 'http_stream') continue;
      for (const format of (stream.format || [])) {
        if (format.format_name !== 'flv') continue;
        for (const codec of (format.codec || [])) {
          if (codec.url_info?.length > 0 && codec.base_url.includes(target)) {
            return { url: codec.url_info[0].host + codec.base_url + codec.url_info[0].extra, qualityName: getQualityName(codec.base_url), codec: codec.codec_name, isHls: false, allStreams };
          }
        }
      }
    }

    return { error: `未找到${quality}画质` };
  } catch (e) {
    return { error: e.message };
  }
}

function getQualityName(baseUrl) {
  if (baseUrl.includes('prohevc')) return 'HEVC原画';
  if (baseUrl.includes('prohdr')) return 'HDR原画';
  if (baseUrl.includes('proav1')) return 'AV1原画';
  return '蓝光';
}

async function getAvailableQualities(roomId) {
  try {
    const url = `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${roomId}&no_playurl=0&mask=1&qn=10000&platform=web&protocol=0,1&format=0,1,2&codec=0,1,2&dolby=5&panorama=1`;
    const resp = await fetch(url, { credentials: 'include' });
    const data = await resp.json();
    if (data.code !== 0) return [];

    const streams = data.data?.playurl_info?.playurl?.stream;
    if (!streams?.length) return [];

    const map = new Map();
    for (const stream of streams) {
      for (const format of (stream.format || [])) {
        for (const codec of (format.codec || [])) {
          if (codec.url_info?.length > 0) {
            const base = codec.base_url;
            let key = 'bluray', name = '蓝光';
            if (base.includes('prohevc')) { key = 'prohevc'; name = 'HEVC原画'; }
            else if (base.includes('prohdr')) { key = 'prohdr'; name = 'HDR原画'; }
            else if (base.includes('proav1')) { key = 'proav1'; name = 'AV1原画'; }
            if (!map.has(key)) map.set(key, { key, name });
          }
        }
      }
    }
    return Array.from(map.values());
  } catch (e) {
    return [];
  }
}

function findOriginalVideo() {
  return document.querySelector('#live-player video') ||
         document.querySelector('.player-ctnr video') ||
         document.querySelector('[class*="player"] video') ||
         document.querySelector('video');
}

function hideOriginalWindow() {
  const wrapper = document.getElementById('changestream-original');
  // 先把原始 video 移回原位（占位节点处），再删小窗口，避免连同 video 一起销毁
  if (originalVideoEl && originalPlaceholder && originalPlaceholder.parentNode) {
    originalPlaceholder.parentNode.insertBefore(originalVideoEl, originalPlaceholder);
    originalPlaceholder.remove();
    originalPlaceholder = null;
    originalVideoEl.style.display = 'none';   // 替换状态下原画面保持隐藏
  }
  if (wrapper) wrapper.remove();
  showOriginal = false;
}

function createOriginalWindow() {
  if (document.getElementById('changestream-original')) return;
  // 复用已缓存的原始 video；首次则查找并缓存，避免 findOriginalVideo 误匹配到 newVideo
  const originalVideo = originalVideoEl || findOriginalVideo();
  if (!originalVideo || originalVideo === newVideo) return;
  originalVideoEl = originalVideo;

  // 在原位插入占位节点，记住 video 原本的父节点和位置，隐藏时据此还原
  if (!originalPlaceholder && originalVideo.parentNode) {
    originalPlaceholder = document.createComment('changestream-original-placeholder');
    originalVideo.parentNode.insertBefore(originalPlaceholder, originalVideo);
  }

  const rect = originalVideo.parentElement.getBoundingClientRect();
  const wrapper = document.createElement('div');
  wrapper.id = 'changestream-original';
  wrapper.style.cssText = `position:fixed;top:${rect.top}px;left:${rect.right+10}px;width:480px;height:300px;background:#000;border:2px solid #00a1d6;border-radius:8px;overflow:hidden;z-index:999999;box-shadow:0 4px 12px rgba(0,0,0,0.5);resize:both;min-width:320px;min-height:200px;`;

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:#00a1d6;color:white;font-size:12px;cursor:move;user-select:none;';
  header.innerHTML = '<span>原直播间</span><button id="changestream-original-close" style="background:none;border:none;color:white;cursor:pointer;font-size:14px;">✕</button>';

  const vc = document.createElement('div');
  vc.style.cssText = 'width:100%;height:calc(100% - 24px);position:relative;';
  originalVideo.style.display = '';
  originalVideo.style.width = '100%';
  originalVideo.style.height = '100%';
  originalVideo.style.objectFit = 'contain';
  vc.appendChild(originalVideo);
  wrapper.appendChild(header);
  wrapper.appendChild(vc);
  document.body.appendChild(wrapper);

  let drag = false, ox, oy;
  header.addEventListener('mousedown', e => { if (e.target.id === 'changestream-original-close') return; drag = true; ox = e.clientX - wrapper.offsetLeft; oy = e.clientY - wrapper.offsetTop; });
  document.addEventListener('mousemove', e => { if (!drag) return; wrapper.style.left = (e.clientX - ox) + 'px'; wrapper.style.top = (e.clientY - oy) + 'px'; });
  document.addEventListener('mouseup', () => drag = false);
  document.getElementById('changestream-original-close').addEventListener('click', () => hideOriginalWindow());
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
  if (newVideo) { try { newVideo.pause(); newVideo.removeAttribute('src'); newVideo.load(); newVideo.remove(); } catch (e) {} newVideo = null; }
  // 先把原始 video 移回原位再删小窗口，避免连同原始 video 一起销毁
  hideOriginalWindow();
  originalVideoEl = null;
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
    flvPlayer = flvjs.createPlayer({ type: 'flv', url: result.url, isLive: true }, { enableWorker: false, enableStashBuffer: false, lazyLoad: false, deferLoadAfterSourceOpen: false, autoCleanupSourceBuffer: true });
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
  if (replaced) return { success: true };
  const originalVideo = findOriginalVideo();
  if (!originalVideo) return { success: false, error: '未找到视频元素' };

  originalVideo.style.display = 'none';
  newVideo = document.createElement('video');
  newVideo.id = 'changestream-video';
  // 目标流只作为画面层，隐藏浏览器原生控制栏，保留当前直播间自己的弹幕/控制层。
  newVideo.autoplay = true; newVideo.muted = true; newVideo.controls = false;
  newVideo.removeAttribute('controls');
  originalVideo.parentElement.insertBefore(newVideo, originalVideo.nextSibling);

  showOriginal = showOrig;
  if (showOriginal) setTimeout(() => createOriginalWindow(), 500);

  const fallback = { 'proav1': 'prohevc', 'prohevc': 'bluray' };
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
  if (result.success) { replaced = true; currentRoomId = targetRoomId; currentQuality = q; return result; }
  cleanupPlayer(); originalVideo.style.display = '';
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
  else if (msg.action === 'setShowOriginal') {
    if (msg.show) { createOriginalWindow(); showOriginal = true; }
    else { hideOriginalWindow(); }
    sendResponse({ success: true, showOriginal });
  }
  return true;
});

chrome.storage.local.get(['targetRoomId', 'isActive', 'delay', 'quality', 'showOriginal'], (data) => {
  if (data.delay) delaySeconds = data.delay;
  if (data.quality) currentQuality = data.quality;
  if (data.showOriginal) showOriginal = data.showOriginal;
  if (data.isActive && data.targetRoomId) setTimeout(() => replaceStream(data.targetRoomId, currentQuality, showOriginal), 2000);
});
