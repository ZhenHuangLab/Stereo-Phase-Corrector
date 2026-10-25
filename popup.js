const toggle = document.querySelector('#enabled');
const status = document.querySelector('#status');
const errorText = document.querySelector('#error');
const title = document.querySelector('#tab-title');
const main = document.querySelector('main');
let tab = null;
let current = { session: null, notice: null };
let busy = true;
let failure = '';
let pendingEnabled = null;
function render(working = '') {
  const session = current.session;
  const other = session && session.tabId !== tab?.id;
  const supported = /^https?:\/\//.test(tab?.url || '');
  toggle.checked = pendingEnabled ?? Boolean(session);
  toggle.disabled = busy || (!session && !supported);
  main.setAttribute('aria-busy', String(busy));
  title.textContent = other ? '正在处理：' + session.title : (tab?.title || '当前标签页');
  title.title = title.textContent;
  status.textContent = working || (session
    ? (other ? '另一标签页已启用；关闭后可切换到本页。' : (session.muted ? '已启用 · 标签页已静音' : '已启用 · 双声道输出'))
    : (supported ? '未启用 · 原始声音' : '请在正在播放视频的网页上打开。'));
  const notice = current.notice;
  const message = failure || (notice?.isError && notice.tabId === tab?.id ? notice.message : '');
  errorText.textContent = message;
  errorText.hidden = !message;
}
async function request(command, payload = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'background', command, ...payload });
  if (!response?.ok) throw new Error(response?.error || '扩展没有响应，请重新打开面板。');
  return response.state;
}
toggle.addEventListener('change', async () => {
  const enable = toggle.checked;
  pendingEnabled = enable;
  busy = true;
  failure = '';
  render(enable ? '正在开启…' : '正在恢复原声…');
  try { current = await request(enable ? 'start' : 'stop', { tabId: tab?.id }); }
  catch (error) {
    failure = error.message;
    try { current = await request('state'); }
    catch { current = { session: null }; }
  } finally { busy = false; pendingEnabled = null; render(); }
});
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id || message?.target !== 'popup' || message.command !== 'state') return false;
  current = message.state;
  if (!busy) render();
  return false;
});
try {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  current = await request('state');
} catch (error) { failure = error.message; }
busy = false;
render();
