// MSE 延迟控制器
// 思路：自行拉取 HLS fmp4 分片，连续喂进 SourceBuffer（保留分片原生时间线，
// 不改 timestampOffset）。延迟通过把 currentTime 定位在 bufferedEnd - delay 实现，
// 用 playbackRate 微调维持，drift 过大才硬 seek。调整延迟不重建缓冲。
class MSEDelayController {
  constructor() { this._init(); }

  _init() {
    this.timers = [];
    this.objectUrl = null;
    this.ms = null;
    this.sb = null;
    this.video = null;
    this.appendQueue = [];   // 待 append 的 ArrayBuffer
    this.fetchedSeq = -1;    // 已下载的最大分片序号
    this.mapFetched = false; // EXT-X-MAP init 段是否已下载
    this.baseUrl = '';
    this.query = '';
    this.delay = 0;
    this.started = false;    // 是否已定位并开始播放
    this._accumulating = false; // 延迟不足目标，正暂停积累缓冲
    this.stopped = false;
    this.onStatus = null;    // (state, text) 状态上报回调
  }

  _report(state, text, progress) { if (this.onStatus) { try { this.onStatus(state, text, progress); } catch (e) {} } }

  isRunning() { return !!this.ms && !this.stopped; }

  async start(video, url, delay) {
    const savedOnStatus = this.onStatus;
    this.stop();
    this._init();
    this.onStatus = savedOnStatus;
    this.stopped = false;
    this.video = video;
    this.delay = Math.max(MSEDelayController.MIN_DELAY, delay);
    this.baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
    this.query = url.includes('?') ? url.substring(url.indexOf('?')) : '';
    console.log(`[ChangeStream] MSE延迟启动: 请求=${delay}s 实际=${this.delay}s`);
    this._report('buffering', `缓冲中 0.0s / ${this.delay}s`);

    this.ms = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.ms);
    video.src = this.objectUrl;

    await new Promise(r => {
      if (this.ms.readyState === 'open') r();
      else this.ms.addEventListener('sourceopen', r, { once: true });
    });
    if (this.stopped) return;

    await this.poll();                                  // 首次拉取
    this.timers.push(setInterval(() => this.poll(), 2000));
    this.timers.push(setInterval(() => this.tick(), 400));
  }

  // 仅调整目标延迟，不重建缓冲
  setDelay(delay) {
    const d = Math.max(MSEDelayController.MIN_DELAY, delay);
    if (d === this.delay) return;
    this.delay = d;
    this.started = false;   // 让 tick 重新定位 currentTime
    console.log(`[ChangeStream] 调整延迟 → ${d}s（无需重建）`);
  }

  stop() {
    this.stopped = true;
    for (const t of (this.timers || [])) clearInterval(t);
    this.timers = [];
    if (this.sb) { try { this.sb.onupdateend = null; this.sb.onerror = null; } catch (e) {} }
    if (this.ms && this.ms.readyState === 'open') { try { this.ms.endOfStream(); } catch (e) {} }
    if (this.objectUrl) { try { URL.revokeObjectURL(this.objectUrl); } catch (e) {} }
    this.objectUrl = null; this.sb = null; this.ms = null;
  }

  // 拉取 m3u8，下载 init 段 + 新分片，入队
  async poll() {
    if (this.stopped) return;
    try {
      const resp = await fetch(this.baseUrl + 'index.m3u8' + this.query);
      if (!resp.ok) return;
      const { mapUrl, segments } = this.parseM3U8(await resp.text());

      // init 段（fmp4 的 EXT-X-MAP），只下载一次，必须最先 append
      if (mapUrl && !this.mapFetched) {
        this.mapFetched = true;
        try {
          const r = await fetch(mapUrl);
          if (r.ok) {
            const buf = await r.arrayBuffer();
            this._ensureSourceBuffer(buf);
            this.appendQueue.push(buf);
          }
        } catch (e) { console.error('[ChangeStream] init段下载失败:', e); this.mapFetched = false; }
      }

      for (const seg of segments) {
        if (this.stopped) return;
        if (seg.seq <= this.fetchedSeq) continue;
        try {
          const r = await fetch(seg.url);
          if (!r.ok) continue;
          const buf = await r.arrayBuffer();
          this._ensureSourceBuffer(buf);   // 无 EXT-X-MAP 时从首个分片建 SB
          this.appendQueue.push(buf);
          this.fetchedSeq = seg.seq;
        } catch (e) { console.error('[ChangeStream] 分片下载失败:', e); }
      }
      this.pump();
    } catch (e) { console.error('[ChangeStream] m3u8获取失败:', e); }
  }

  parseM3U8(text) {
    const segs = [];
    let mapUrl = null, dur = 0, seq = 0;
    for (const raw of text.split('\n')) {
      const t = raw.trim();
      if (t.startsWith('#EXT-X-MAP:')) {
        const m = t.match(/URI="([^"]+)"/);
        if (m) mapUrl = this._abs(m[1]);
      } else if (t.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        seq = parseInt(t.split(':')[1]) || 0;
      } else if (t.startsWith('#EXTINF:')) {
        dur = parseFloat(t.split(':')[1]) || 0;
      } else if (t && !t.startsWith('#')) {
        segs.push({ url: this._abs(t), duration: dur, seq: seq + segs.length });
      }
    }
    return { mapUrl, segments: segs };
  }

  _abs(path) {
    return (path.startsWith('http') ? path : this.baseUrl + path) + this.query;
  }

  // 首次拿到数据时按编码创建 SourceBuffer（只创建一次）
  _ensureSourceBuffer(buf) {
    if (this.sb || !this.ms || this.ms.readyState !== 'open') return;
    const mime = `video/mp4; codecs="${this.detectCodec(buf)}"`;
    if (!MediaSource.isTypeSupported(mime)) {
      console.error(`[ChangeStream] 不支持的编码: ${mime}`);
      this._report('error', `不支持的编码: ${mime}`);
      return;
    }
    this.sb = this.ms.addSourceBuffer(mime);
    this.sb.onupdateend = () => this.pump();
    this.sb.onerror = (e) => { console.error('[ChangeStream] sourceBuffer错误:', e); this._report('error', '解码失败（编码不匹配）'); };
    console.log(`[ChangeStream] SourceBuffer创建: ${mime}`);
  }

  // 单一驱动：空闲则 append 下一个分片
  pump() {
    if (this.stopped || !this.sb || !this.ms || this.ms.readyState !== 'open') return;
    if (this.sb.updating || !this.appendQueue.length) return;
    const buf = this.appendQueue.shift();
    try { this.sb.appendBuffer(buf); }
    catch (e) { console.error('[ChangeStream] append失败:', e); }
  }

  // 每 400ms：定位延迟 + 维持 + 清理旧缓冲
  tick() {
    if (this.stopped || !this.sb || !this.video) return;
    const v = this.video;
    if (!v.buffered.length) return;

    const bStart = v.buffered.start(0);
    const bEnd = v.buffered.end(v.buffered.length - 1);
    const have = bEnd - bStart;

    // 起播门槛：攒够 min(delay, START_MIN) 秒即可开始，不必等满整个 delay。
    // 之后靠 playbackRate 慢放让实际延迟逐步爬升到目标，避免切画质后干等 30s。
    const startThreshold = Math.min(this.delay, MSEDelayController.START_MIN);
    if (!this.started && have < startThreshold + 0.3) {
      console.log(`[ChangeStream] 缓冲中: ${have.toFixed(1)}s / ${startThreshold.toFixed(1)}s`);
      this._report('buffering', `缓冲中 ${have.toFixed(1)}s / ${this.delay}s`);
      return;
    }

    const target = bEnd - this.delay;
    const LIVE_MARGIN = 2;   // 实时播放时距 live edge 的安全余量，避免播放头贴边卡顿

    // 首次定位：缓冲已够目标延迟则直接定位；否则先播实时画面(0延迟)，后台继续积累
    if (!this.started) {
      this.started = true;
      v.playbackRate = 1;
      if (have >= this.delay) {
        try { v.currentTime = bEnd - this.delay; } catch (e) {}
        this._accumulating = false;
        console.log(`[ChangeStream] 起播，缓冲已够，直接延迟 ${this.delay}s`);
        this._report('playing', `延迟 ${this.delay}s 播放中`);
      } else {
        try { v.currentTime = bEnd - Math.min(LIVE_MARGIN, have); } catch (e) {}
        this._accumulating = true;
        console.log(`[ChangeStream] 起播，播实时画面，积累延迟 ${have.toFixed(1)}s → ${this.delay}s`);
        this._report('buffering', `积累延迟 ${have.toFixed(1)}s / ${this.delay}s（暂播实时画面）`, { have, target: this.delay });
      }
      this._play();
      return;
    }

    // 积累中：播放实时画面，不裁剪旧缓冲，等缓冲跨度攒够目标延迟再回退定位
    if (this._accumulating) {
      this._play();
      if (have >= this.delay + 0.3) {
        try { v.currentTime = bEnd - this.delay; } catch (e) {}
        this._accumulating = false;
        v.playbackRate = 1;
        console.log(`[ChangeStream] 缓冲已攒够，回退到延迟 ${this.delay}s 位置`);
        this._report('playing', `延迟 ${this.delay}s 播放中`);
      } else {
        // 紧跟 live edge，避免播放头落在 bEnd 之外卡顿
        if (bEnd - v.currentTime > LIVE_MARGIN + 2) {
          try { v.currentTime = bEnd - LIVE_MARGIN; } catch (e) {}
        }
        v.playbackRate = 1;
        console.log(`[ChangeStream] 积累延迟: ${have.toFixed(1)}s / ${this.delay}s（实时播放中）`);
        this._report('buffering', `积累延迟 ${have.toFixed(1)}s / ${this.delay}s（暂播实时画面）`, { have, target: this.delay });
      }
      this._lastTime = v.currentTime;
      return;
    }

    this._play();

    // 播放中卡顿检测：readyState 不足或 currentTime 不前进 → 上报缓冲
    if (v.readyState < 3) {
      this._report('buffering', '缓冲中…');
    } else if (this._lastTime !== undefined && v.currentTime === this._lastTime && !v.paused) {
      this._report('buffering', '缓冲中…');
    } else {
      this._report('playing', `延迟 ${this.delay}s 播放中`);
    }
    this._lastTime = v.currentTime;

    // 维持延迟：actualDelay 偏离目标时用小幅变速修正（不再用于大幅爬升）
    const err = v.currentTime - target;
    if (err > 0.5) {
      v.playbackRate = 0.95;   // 延迟偏小：温和放慢
    } else if (err < -0.5) {
      v.playbackRate = 1.05;   // 延迟偏大：温和追回
    } else {
      v.playbackRate = 1;
    }

    // 清理 currentTime 之前 20s 以外的旧缓冲，限制内存
    if (!this.sb.updating && !this.appendQueue.length && v.currentTime - bStart > 30) {
      try { this.sb.remove(0, v.currentTime - 20); } catch (e) {}
    }
  }

  _play() {
    const v = this.video;
    if (!v.paused) return;
    v.play().catch(() => {
      v.muted = true;
      v.play().then(() => setTimeout(() => { v.muted = false; }, 300)).catch(() => {});
    });
  }

  detectCodec(buf) {
    const view = new Uint8Array(buf);
    // 编码信息都在 moov（init 段开头），扫前 64KB 足够，避免扫描大分片拖慢
    const n = Math.min(view.length, 65536);
    let str = '';
    for (let i = 0; i < n; i++) str += String.fromCharCode(view[i]);
    // 音频：B站 fmp4 普遍是 AAC-LC（object type 0x40）。流里含音轨时
    // mimetype 必须同时声明音频 codec，否则 append 报 CHUNK_DEMUXER_ERROR。
    const hasAudio = str.includes('mp4a');
    const audio = hasAudio ? ', mp4a.40.2' : '';
    let video;
    if (str.includes('hev1') || str.includes('hvc1')) video = 'hev1.1.6.L93.B0';
    else if (str.includes('av01')) video = 'av01.0.08M.08';
    else video = 'avc1.42E01E';
    return video + audio;
  }
}

MSEDelayController.MIN_DELAY = 0;   // 最小延迟 0s（0 时 content.js 直接播放，绕过 MSE）
MSEDelayController.START_MIN = 4;   // 起播所需最小缓冲秒数，之后延迟慢放爬升到目标
