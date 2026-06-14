chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'log') {
    console.log(`[Content] ${msg.type}: ${msg.msg}`);
  }
});
