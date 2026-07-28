async function executeCapabilities({ adapter, json }) {
  const manifest = adapter.ProbeCapabilities();
  return { manifest, json };
}

module.exports = { executeCapabilities };
