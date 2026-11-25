const { app } = require('electron');

// Install before Companion creates its first native window.
app.windowActivity = [];
app.on('browser-window-created', (_event, window) => {
  app.windowActivity.push('created');
  if (window.isVisible() || window.isFocused() || window.isFocusable()) app.windowActivity.push('exposed');
  for (const event of ['show', 'focus']) window.on(event, () => app.windowActivity.push(event));
});
require('../../app/main');
