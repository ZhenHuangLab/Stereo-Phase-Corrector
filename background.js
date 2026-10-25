const AUDIO_URL = chrome.runtime.getURL('offscreen.html');
let queue = Promise.resolve();
let notice = null;
let badgeTab = null;
function serial(job) {
  const result = queue.then(job);
  queue = result.catch(() => {});
  return result;
}
function requireAPIs() {
  if (!chrome.tabCapture?.getMediaStreamId || !chrome.offscreen?.createDocument || !chrome.runtime.getContexts) {
    throw new Error('浏览器未提供标签页音频处理接口。需要支持这些接口的 Chromium 116 或更新版本。');
  }
}
async function hasAudioDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [AUDIO_URL]
  });
  return contexts.length > 0;
}
async function audio(command, payload = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'audio', command, ...payload });
  if (!response?.ok) throw new Error(response?.error || '音频处理页面没有响应。');
  return response.state;
}
async function readState() {
  return await hasAudioDocument() ? audio('state') : { session: null };
}
async function badge(tabId, text) {
  if (!Number.isInteger(tabId)) return;
  // The captured tab can close between the state read and these UI updates.
  await Promise.allSettled([
    chrome.action.setBadgeText({ tabId, text }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#356cd5' }),
    chrome.action.setTitle({ tabId, title: text ? '反相修正 · 已启用' : '反相修正' })
  ]);
}
async function syncBadge(state) {
  const next = state.session?.tabId ?? null;
  if (badgeTab !== null && badgeTab !== next) await badge(badgeTab, '');
  if (next !== null) await badge(next, 'R−');
  badgeTab = next;
}
function publish(state) {
  const value = { ...state, notice };
  // A popup normally does not exist while audio is playing.
  void chrome.runtime.sendMessage({ target: 'popup', command: 'state', state: value }).catch(() => {});
  return value;
}
async function stopCurrent(message = null, isError = false) {
  const state = await readState();
  const tabId = state.session?.tabId ?? badgeTab;
  try {
    if (await hasAudioDocument()) {
      try { await audio('stop'); }
      finally { await chrome.offscreen.closeDocument(); }
    }
  } finally {
    if (tabId !== null) await badge(tabId, '');
    badgeTab = null;
  }
  notice = message ? { tabId, message, isError } : null;
  return { session: null };
}
async function start(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('找不到当前标签页。');
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:\/\//.test(tab.url || '')) throw new Error('请在正在播放视频的网页上启用修正。');
  const previous = await readState();
  if (previous.session?.tabId === tabId && previous.session.url === tab.url) return previous;
  await stopCurrent();
  notice = null;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['USER_MEDIA'],
      justification: '在本机翻转用户选择的标签页右声道极性，并保留双声道播放。'
    });
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    const state = await audio('start', {
      id: crypto.randomUUID(), tabId, url: tab.url, title: tab.title || '当前标签页',
      muted: Boolean(tab.mutedInfo?.muted), streamId
    });
    // A page may navigate or close while getUserMedia is still starting.
    const latest = await chrome.tabs.get(tabId);
    if (latest.url !== tab.url || latest.status === 'loading') {
      throw new Error('页面已经切换，请在视频加载后重新启用。');
    }
    const current = await audio('mute', { muted: Boolean(latest.mutedInfo?.muted) });
    await syncBadge(current);
    return current;
  } catch (error) {
    try { await stopCurrent(); }
    catch (cleanupError) {
      console.error('Audio recovery failed', cleanupError);
      throw new Error('启动失败，恢复音频时也遇到错误。请刷新该视频页面后再试。');
    }
    throw new Error('未能开启修正：' + (error?.message || String(error)));
  }
}
async function refresh() {
  const state = await readState();
  await syncBadge(state);
  return publish(state);
}
async function report(error, tabId) {
  console.error('Stereo phase correction failed', error);
  notice = { tabId, message: error?.message || '音频处理失败，请刷新视频后再试。', isError: true };
  try { return await refresh(); }
  catch (failure) {
    console.error('Could not read audio state', failure);
    return publish({ session: null });
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.target !== 'background') return false;
  if (!['state', 'start', 'stop', 'ended'].includes(message.command)) return false;
  void serial(async () => {
    requireAPIs();
    if (message.command === 'ended') {
      if (typeof message.id !== 'string' || !Number.isInteger(message.tabId)) throw new Error('无效的音频状态。');
      const state = await readState();
      if (state.session && state.session.id !== message.id) return publish(state);
      await stopCurrent();
      notice = { tabId: message.tabId, message: message.error || '音频采集已结束，已恢复原声。', isError: Boolean(message.error) };
      await badge(message.tabId, '');
      return refresh();
    }
    if (message.command === 'start') return publish(await start(message.tabId));
    if (message.command === 'stop') return publish(await stopCurrent());
    return refresh();
  }).then(state => respond({ ok: true, state }), async error => {
    const state = await report(error, message.tabId);
    respond({ ok: false, error: notice.message, state });
  });
  return true;
});
function onNavigation(tabId, change) {
  if (change.status !== 'loading' && typeof change.url !== 'string' && !change.mutedInfo) return;
  void serial(async () => {
    requireAPIs();
    const state = await readState();
    if (state.session?.tabId !== tabId) return;
    if (change.status === 'loading' || (change.url && change.url !== state.session.url)) {
      await stopCurrent('页面已切换，已恢复原声。');
      await refresh();
    } else if (change.mutedInfo) {
      publish(await audio('mute', { muted: Boolean(change.mutedInfo.muted) }));
    }
  }).catch(error => { void report(error, tabId); });
}
chrome.tabs.onUpdated.addListener(onNavigation);
chrome.tabs.onRemoved.addListener(tabId => {
  void serial(async () => {
    requireAPIs();
    const state = await readState();
    if (state.session?.tabId === tabId) {
      await stopCurrent();
      await refresh();
    }
  }).catch(error => { void report(error, tabId); });
});
chrome.tabCapture?.onStatusChanged.addListener(info => {
  if (!['stopped', 'error'].includes(info.status)) return;
  void serial(async () => {
    const state = await readState();
    // A delayed stop event from a previous stream must not stop its replacement.
    if (!state.session || state.session.tabId !== info.tabId) await badge(info.tabId, '');
  }).catch(error => { void report(error, info.tabId); });
});
// This also runs when Chrome resumes a suspended worker. The document, not this
// worker's globals, owns the active capture and its original page identity.
void serial(async () => {
  requireAPIs();
  const state = await readState();
  if (state.session) {
    let tab;
    try { tab = await chrome.tabs.get(state.session.tabId); }
    catch { await stopCurrent(); return refresh(); }
    if (tab.url !== state.session.url || tab.status === 'loading') await stopCurrent();
    else await audio('mute', { muted: Boolean(tab.mutedInfo?.muted) });
  }
  await refresh();
}).catch(error => { console.error('Could not recover extension state', error); });
