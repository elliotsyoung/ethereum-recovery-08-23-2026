if (typeof process.send !== 'function') {
  process.exit(2);
}

let closing = false;

function close() {
  if (closing) return;
  closing = true;
  if (process.connected) process.disconnect();
  process.exit(0);
}

process.on('message', (message) => {
  if (message?.type === 'release') close();
});
process.on('disconnect', close);
process.on('SIGINT', close);
process.on('SIGTERM', close);
process.send({ type: 'locked' });
