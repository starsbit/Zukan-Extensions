(async () => {
  const moduleUrl = chrome.runtime.getURL('x.js');
  const { createXContentController } = await import(moduleUrl);
  createXContentController().attach();
})();
