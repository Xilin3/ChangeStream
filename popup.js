const roomIdInput = document.getElementById('roomId');
const replaceBtn = document.getElementById('replaceBtn');
const restoreBtn = document.getElementById('restoreBtn');
const clearBtn = document.getElementById('clearBtn');
const debugBtn = document.getElementById('debugBtn');
const refreshQualitiesBtn = document.getElementById('refreshQualities');
const logBox = document.getElementById('logBox');
const controlGroup = document.getElementById('controlGroup');
const qualitySelect = document.getElementById('qualitySelect');
const delaySlider = document.getElementById('delaySlider');
const delayValue = document.getElementById('delayValue');
const showOriginalCheckbox = document.getElementById('showOriginal');
const statusBar = document.getElementById('statusBar');
const accumBox = document.getElementById('accumBox');
const accumText = document.getElementById('accumText');
const accumFill = document.getElementById('accumFill');
const refreshStreamBtn = document.getElementById('refreshStreamBtn');

const STATUS_LABEL = { idle: '未开始', buffering: '缓冲中', playing: '播放中', error: '出错' };
function renderStatus(status) {
  if (!statusBar) return;
  const state = status?.state || 'idle';
  const text = status?.text || STATUS_LABEL[state] || '';
  statusBar.className = `status-bar status-${state}`;
  statusBar.textContent = text;
  // 积累延迟进度栏：有 progress 数据时显示进度条，否则隐藏
  const p = status?.progress;
  if (accumBox) {
    if (p && p.target > 0 && p.have < p.target) {
      const pct = Math.min(100, Math.max(0, (p.have / p.target) * 100));
      accumFill.style.width = pct.toFixed(1) + '%';
      accumText.textContent = `${p.have.toFixed(1)}s / ${p.target}s`;
      accumBox.style.display = 'block';
    } else {
      accumBox.style.display = 'none';
    }
  }
  // 出错时高亮刷新按钮
  if (refreshStreamBtn) refreshStreamBtn.style.background = state === 'error' ? '#f25d8e' : '#ff9800';
}

function log(msg, type = '') {
  const line = document.createElement('div');
  if (type) line.className = type;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}

function extractRoomId(input) {
  input = input.trim();
  const urlMatch = input.match(/live\.bilibili\.com\/(\d+)/);
  if (urlMatch) return urlMatch[1];
  if (/^\d+$/.test(input)) return input;
  return null;
}

function updateDelayDisplay(value) {
  delayValue.textContent = `${value}秒`;
}

function updateQualitySelect(qualities) {
  qualitySelect.innerHTML = '';
  qualities.forEach(q => {
    const opt = document.createElement('option');
    opt.value = q.key;
    opt.textContent = q.name;
    qualitySelect.appendChild(opt);
  });
}

async function fetchAndUpdateQualities(roomId) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  chrome.tabs.sendMessage(tab.id, { action: 'getAvailableQualities', roomId }, (response) => {
    if (response?.qualities?.length > 0) {
      updateQualitySelect(response.qualities);
      chrome.storage.local.set({ availableQualities: response.qualities });
      log(`可用画质: ${response.qualities.map(q => q.name).join(', ')}`, 'info');
    }
  });
}

chrome.storage.local.get(['targetRoomId', 'isActive', 'delay', 'quality', 'showOriginal', 'availableQualities', 'playbackStatus'], (data) => {
  if (data.targetRoomId) roomIdInput.value = data.targetRoomId;
  if (data.isActive) { log('上次替换仍处于激活状态', 'info'); controlGroup.style.display = 'block'; }
  if (data.delay !== undefined) { delaySlider.value = data.delay; updateDelayDisplay(data.delay); }
  if (data.showOriginal) showOriginalCheckbox.checked = data.showOriginal;
  if (data.availableQualities?.length > 0) {
    updateQualitySelect(data.availableQualities);
    if (data.quality) qualitySelect.value = data.quality;
  }
  renderStatus(data.playbackStatus);
});

// 实时同步播放状态（content.js 写入 storage）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.playbackStatus) renderStatus(changes.playbackStatus.newValue);
});

refreshStreamBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  log('刷新画面…', 'info');
  chrome.tabs.sendMessage(tab.id, { action: 'refresh' }, (response) => {
    if (chrome.runtime.lastError) { log(`通信失败: ${chrome.runtime.lastError.message}`, 'error'); return; }
    if (response?.success) log('刷新成功', 'success');
    else log(`刷新失败: ${response?.error || '未知错误'}`, 'error');
  });
});

let fetchTimer = null;
roomIdInput.addEventListener('input', () => {
  if (fetchTimer) clearTimeout(fetchTimer);
  fetchTimer = setTimeout(() => {
    const roomId = extractRoomId(roomIdInput.value);
    if (roomId) fetchAndUpdateQualities(roomId);
  }, 500);
});

replaceBtn.addEventListener('click', async () => {
  const roomId = extractRoomId(roomIdInput.value);
  if (!roomId) { log('请输入有效的直播间ID或URL', 'error'); return; }
  log(`目标直播间ID: ${roomId}`);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes('live.bilibili.com')) { log('请在B站直播间页面使用此插件', 'error'); return; }

  await fetchAndUpdateQualities(roomId);

  const quality = qualitySelect.value;
  const showOriginal = showOriginalCheckbox.checked;
  chrome.storage.local.set({ targetRoomId: roomId, isActive: true, quality, showOriginal });

  chrome.tabs.sendMessage(tab.id, { action: 'replace', roomId, quality, showOriginal }, (response) => {
    if (chrome.runtime.lastError) { log(`通信失败: ${chrome.runtime.lastError.message}`, 'error'); return; }
    if (response?.success) {
      log('替换成功!', 'success');
      if (response.qualityName) log(`画质: ${response.qualityName}`);
      if (response.allStreams) response.allStreams.forEach(s => log(`  ${s.proto}/${s.format}/${s.codec}: ${s.base_url.substring(0, 80)}`));
      controlGroup.style.display = 'block';
    } else {
      log(`替换失败: ${response?.error || '未知错误'}`, 'error');
    }
  });
});

restoreBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  chrome.storage.local.set({ isActive: false, delay: 0 });
  chrome.tabs.sendMessage(tab.id, { action: 'restore' }, (response) => {
    if (response?.success) { log('已恢复原始画面', 'success'); controlGroup.style.display = 'none'; delaySlider.value = 0; updateDelayDisplay(0); }
  });
});

clearBtn.addEventListener('click', async () => {
  chrome.storage.local.remove(['targetRoomId', 'isActive', 'delay', 'quality', 'showOriginal', 'availableQualities']);
  roomIdInput.value = ''; logBox.innerHTML = ''; controlGroup.style.display = 'none';
  delaySlider.value = 0; updateDelayDisplay(0); qualitySelect.innerHTML = '<option value="bluray">蓝光</option>';
  showOriginalCheckbox.checked = false;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.sendMessage(tab.id, { action: 'restore' }).catch(() => {});
  log('已清除所有设置', 'info');
});

debugBtn.addEventListener('click', async () => {
  const roomId = extractRoomId(roomIdInput.value) || '6';
  log(`=== 调试API === roomId: ${roomId}`);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { action: 'getAvailableQualities', roomId }, (response) => {
    if (response?.qualities?.length > 0) {
      log(`可用画质: ${response.qualities.map(q => q.name).join(', ')}`, 'info');
    } else {
      log('无可用画质', 'error');
    }
  });
});

refreshQualitiesBtn.addEventListener('click', async () => {
  const roomId = extractRoomId(roomIdInput.value);
  if (!roomId) { log('请输入有效的直播间ID', 'error'); return; }
  await fetchAndUpdateQualities(roomId);
});

showOriginalCheckbox.addEventListener('change', async () => {
  const show = showOriginalCheckbox.checked;
  chrome.storage.local.set({ showOriginal: show });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { action: 'setShowOriginal', show }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response?.success) log(show ? '已显示原直播间小窗口' : '已隐藏原直播间小窗口', 'info');
  });
});

let delayTimer = null;
delaySlider.addEventListener('input', () => {
  const value = parseInt(delaySlider.value);
  updateDelayDisplay(value);
  chrome.storage.local.set({ delay: value });

  // 防抖：拖动时合并消息，停止 200ms 后下发（控制器内部只调延迟、不重建缓冲）
  if (delayTimer) clearTimeout(delayTimer);
  delayTimer = setTimeout(() => {
    log(`设置延迟: ${value}秒`);
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'setDelay', delay: value }, (response) => {
          if (response?.success) log(`延迟设置成功: ${value}秒`, 'success');
          else log(`延迟设置失败`, 'error');
        });
      }
    });
  }, 200);
});

qualitySelect.addEventListener('change', () => {
  const quality = qualitySelect.value;
  chrome.storage.local.set({ quality });
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      log(`切换画质: ${qualitySelect.options[qualitySelect.selectedIndex].text}`);
      chrome.tabs.sendMessage(tabs[0].id, { action: 'changeQuality', quality }, (response) => {
        if (response?.success) {
          log('画质切换成功', 'success');
          if (response.qualityName) log(`画质: ${response.qualityName}`);
          if (response.allStreams) response.allStreams.forEach(s => log(`  ${s.proto}/${s.format}/${s.codec}: ${s.base_url.substring(0, 80)}`));
        }
        else log(`画质切换失败: ${response?.error}`, 'error');
      });
    }
  });
});
