import { connectCorrection } from './audio.js';

let session = null;
let queue = Promise.resolve();
function serial(job) {
  const result = queue.then(job);
  queue = result.catch(() => {});
  return result;
}
function state() {
  if (!session) return { session: null };
  const { id, tabId, url, title, phase, muted } = session;
  return { session: { id, tabId, url, title, phase, muted } };
}
async function release(fade = false) {
  const previous = session;
  if (!previous) return;
  session = null;
  for (const track of previous.stream?.getTracks() ?? []) track.onended = null;
  if (previous.context) previous.context.onstatechange = null;
  try {
    if (fade) await previous.graph?.fadeOut();
  } finally {
    try { previous.graph?.disconnect(); }
    finally {
      for (const track of previous.stream?.getTracks() ?? []) track.stop();
      if (previous.context && previous.context.state !== 'closed') await previous.context.close();
    }
  }
}
function ended(id, error) {
  void serial(async () => {
    if (session?.id !== id) return;
    const { tabId } = session;
    try { await release(); }
    catch (failure) { console.error('Audio cleanup failed', failure); }
    // Do not hold this queue while the worker queries our state in response.
    void chrome.runtime.sendMessage({
      target: 'background', command: 'ended', id, tabId, error
    }).catch(failure => console.warn('Could not report audio termination', failure));
  });
}
async function start(message) {
  if (!Number.isInteger(message.tabId) || message.tabId < 0 ||
      typeof message.id !== 'string' || typeof message.streamId !== 'string' ||
      typeof message.url !== 'string' || typeof message.title !== 'string' || typeof message.muted !== 'boolean') {
    throw new Error('无效的音频请求。');
  }
  await release();
  const current = { id: message.id, tabId: message.tabId, url: message.url,
    title: message.title, muted: message.muted, phase: 'starting', stream: null, context: null, graph: null };
  session = current;
  try {
    current.stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId } },
      video: false
    });
    if (!current.stream.getAudioTracks().length) throw new Error('当前标签页没有可采集的音轨。');
    current.context = new AudioContext({ latencyHint: 'interactive' });
    current.context.destination.channelCount = 2;
    const source = current.context.createMediaStreamSource(current.stream);
    current.graph = connectCorrection(current.context, source, current.context.destination, { muted: current.muted });
    for (const track of current.stream.getTracks()) {
      track.onended = () => ended(current.id, '音频采集已结束，已恢复原声。');
    }
    current.context.onstatechange = () => {
      if (current.phase === 'active' && current.context.state !== 'running') {
        ended(current.id, '音频处理已中断，已恢复原声。');
      }
    };
    await current.context.resume();
    if (current.context.state !== 'running' || current.stream.getAudioTracks().some(t => t.readyState !== 'live')) {
      throw new Error('音频处理未能启动，请重新播放视频后再试。');
    }
    current.phase = 'active';
    return state();
  } catch (error) {
    await release();
    throw error;
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.target !== 'audio') return false;
  if (!['state', 'start', 'stop', 'mute'].includes(message.command)) return false;
  void serial(async () => {
    if (message.command === 'state') return state();
    if (message.command === 'start') return start(message);
    if (message.command === 'mute') {
      if (typeof message.muted !== 'boolean') throw new Error('无效的静音状态。');
      if (session) {
        session.muted = message.muted;
        session.graph?.setMuted(message.muted);
      }
      return state();
    }
    await release(true);
    return state();
  }).then(value => respond({ ok: true, state: value }), error => {
    console.error('Audio processing failed', error);
    respond({ ok: false, error: error?.message || '音频处理失败。' });
  });
  return true;
});
